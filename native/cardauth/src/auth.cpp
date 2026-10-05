#include "cardauth/auth.hpp"

#include <cerrno>
#include <cstring>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
using socket_t = SOCKET;
static const socket_t kBadSocket = INVALID_SOCKET;
static void close_socket(socket_t s) { closesocket(s); }
static int last_error() { return WSAGetLastError(); }
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
using socket_t = int;
static const socket_t kBadSocket = -1;
static void close_socket(socket_t s) { ::close(s); }
static int last_error() { return errno; }
#endif

namespace cardauth {

namespace {

#ifdef _WIN32
struct WinsockInit {
    WinsockInit() {
        WSADATA d;
        WSAStartup(MAKEWORD(2, 2), &d);
    }
    ~WinsockInit() { WSACleanup(); }
};
#endif

std::string error_text(int code) {
#ifdef _WIN32
    return "error " + std::to_string(code);
#else
    return std::strerror(code);
#endif
}

void set_blocking(socket_t s, bool blocking) {
#ifdef _WIN32
    u_long mode = blocking ? 0 : 1;
    ioctlsocket(s, FIONBIO, &mode);
#else
    int flags = fcntl(s, F_GETFL, 0);
    fcntl(s, F_SETFL, blocking ? (flags & ~O_NONBLOCK) : (flags | O_NONBLOCK));
#endif
}

void set_io_timeout(socket_t s, int timeout_ms) {
#ifdef _WIN32
    DWORD t = static_cast<DWORD>(timeout_ms);
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&t), sizeof(t));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&t), sizeof(t));
#else
    timeval tv{timeout_ms / 1000, (timeout_ms % 1000) * 1000};
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
#endif
}

// Connects with a deadline (a plain connect() to an unroutable host can hang for minutes).
socket_t connect_with_timeout(const Config& cfg, std::string& err) {
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* res = nullptr;
    if (getaddrinfo(cfg.host.c_str(), std::to_string(cfg.port).c_str(), &hints, &res) != 0 || !res) {
        err = "could not resolve " + cfg.host;
        return kBadSocket;
    }
    socket_t result = kBadSocket;
    for (addrinfo* ai = res; ai && result == kBadSocket; ai = ai->ai_next) {
        socket_t s = ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (s == kBadSocket) continue;
        set_blocking(s, false);
        int rc = ::connect(s, ai->ai_addr, static_cast<int>(ai->ai_addrlen));
        bool connected = rc == 0;
        if (!connected) {
#ifdef _WIN32
            bool in_progress = last_error() == WSAEWOULDBLOCK;
#else
            bool in_progress = last_error() == EINPROGRESS;
#endif
            if (in_progress) {
#ifdef _WIN32
                WSAPOLLFD pfd{s, POLLWRNORM, 0};
                int pr = WSAPoll(&pfd, 1, cfg.timeout_ms);
#else
                pollfd pfd{s, POLLOUT, 0};
                int pr = ::poll(&pfd, 1, cfg.timeout_ms);
#endif
                if (pr > 0) {
                    int so_err = 0;
                    socklen_t len = sizeof(so_err);
                    getsockopt(s, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&so_err), &len);
                    connected = so_err == 0;
                    if (!connected) err = error_text(so_err);
                } else {
                    err = pr == 0 ? "timed out" : error_text(last_error());
                }
            } else {
                err = error_text(last_error());
            }
        }
        if (connected) {
            set_blocking(s, true);
            set_io_timeout(s, cfg.timeout_ms);
            result = s;
        } else {
            close_socket(s);
        }
    }
    freeaddrinfo(res);
    return result;
}

// Reads one '\n'-terminated line (without the terminator). False on EOF/timeout/error before a full line.
bool read_line(socket_t s, std::string& line) {
    line.clear();
    char c;
    for (;;) {
        int n = ::recv(s, &c, 1, 0);
        if (n <= 0) return !line.empty();  // tolerate a final unterminated line
        if (c == '\n') return true;
        if (c != '\r') line += c;
    }
}

bool send_all(socket_t s, const std::string& data) {
    size_t sent = 0;
    while (sent < data.size()) {
        int n = ::send(s, data.data() + sent, static_cast<int>(data.size() - sent), 0);
        if (n <= 0) return false;
        sent += static_cast<size_t>(n);
    }
    return true;
}

std::string trim_copy(const std::string& s) {
    auto b = s.find_first_not_of(" \t\r\n");
    if (b == std::string::npos) return "";
    return s.substr(b, s.find_last_not_of(" \t\r\n") - b + 1);
}

}  // namespace

Reply send_command(const Config& config, const std::string& command, const std::string& username,
                   const std::string& password) {
#ifdef _WIN32
    static WinsockInit winsock;
#endif
    Reply reply;
    std::string err;
    socket_t s = connect_with_timeout(config, err);
    if (s == kBadSocket) {
        reply.unavailable = true;
        reply.message = "Login server unavailable: " + err;
        return reply;
    }

    std::string greeting, response;
    bool ok = read_line(s, greeting) &&  // discard greeting: "OK Connected to LoginServer"
              send_all(s, command + " " + username + " " + password + "\n") && read_line(s, response);
    close_socket(s);
    if (!ok) {
        reply.unavailable = true;
        reply.message = "Login server unavailable: connection closed or timed out";
        return reply;
    }

    if (response.rfind("OK", 0) == 0) {
        reply.ok = true;
        reply.message = trim_copy(response.substr(2));
    } else if (response.rfind("FAIL", 0) == 0) {
        reply.message = trim_copy(response.substr(4));
    } else {
        reply.message = "Unexpected response from login server";
    }
    return reply;
}

std::optional<std::string> validate_credentials(std::string& username, const std::string& password) {
    username = trim_copy(username);
    if (username.empty() || password.empty()) return std::string("Username and password are required");
    if (username.find(' ') != std::string::npos || password.find(' ') != std::string::npos)
        return std::string("Username and password can't contain spaces");
    return std::nullopt;
}

}  // namespace cardauth
