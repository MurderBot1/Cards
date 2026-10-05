#include <atomic>
#include <functional>
#include <string>
#include <chrono>
#include <thread>

#include "cardauth/auth.hpp"
#include "cardtest.hpp"

#ifndef _WIN32
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

// A one-connection-at-a-time fake LoginServer: sends a greeting, reads one command line, replies.
class FakeServer {
public:
    explicit FakeServer(std::function<std::string(const std::string&)> responder, bool greet = true)
        : responder_(std::move(responder)), greet_(greet) {
        listen_fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
        int one = 1;
        setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = 0;
        ::bind(listen_fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
        socklen_t len = sizeof(addr);
        getsockname(listen_fd_, reinterpret_cast<sockaddr*>(&addr), &len);
        port_ = ntohs(addr.sin_port);
        ::listen(listen_fd_, 4);
        thread_ = std::thread([this] { loop(); });
    }
    ~FakeServer() {
        stop_ = true;
        ::shutdown(listen_fd_, SHUT_RDWR);
        ::close(listen_fd_);
        thread_.join();
    }
    int port() const { return port_; }
    std::string last_command() const { return last_; }

private:
    void loop() {
        while (!stop_) {
            int fd = ::accept(listen_fd_, nullptr, nullptr);
            if (fd < 0) return;
            if (greet_) ::send(fd, "OK Connected to LoginServer\n", 28, 0);
            std::string line;
            char c;
            while (::recv(fd, &c, 1, 0) == 1 && c != '\n') line += c;
            last_ = line;
            std::string reply = responder_(line);
            if (!reply.empty()) ::send(fd, reply.data(), reply.size(), 0);
            ::close(fd);
        }
    }
    std::function<std::string(const std::string&)> responder_;
    bool greet_;
    int listen_fd_ = -1;
    int port_ = 0;
    std::atomic<bool> stop_{false};
    std::string last_;
    std::thread thread_;
};
#endif

int main() {
    // ---- validate_credentials (pure)
    {
        std::string u = "  alice ";
        CHECK(!cardauth::validate_credentials(u, "pw").has_value());
        CHECK_EQ(u, std::string("alice"));  // trimmed
        std::string empty = "   ";
        CHECK_EQ(*cardauth::validate_credentials(empty, "pw"), std::string("Username and password are required"));
        std::string bob = "bob";
        CHECK_EQ(*cardauth::validate_credentials(bob, ""), std::string("Username and password are required"));
        std::string spaced = "a b";
        CHECK_EQ(*cardauth::validate_credentials(spaced, "pw"), std::string("Username and password can't contain spaces"));
        std::string ok = "alice";
        CHECK_EQ(*cardauth::validate_credentials(ok, "p w"), std::string("Username and password can't contain spaces"));
    }

#ifndef _WIN32
    // ---- protocol against a fake server
    {
        FakeServer srv([](const std::string& cmd) {
            if (cmd == "LOGIN alice secret") return std::string("OK Welcome back\n");
            if (cmd == "REGISTER alice secret") return std::string("FAIL Username already taken\n");
            return std::string("WAT\n");
        });
        cardauth::Config cfg;
        cfg.port = srv.port();

        auto good = cardauth::send_command(cfg, "LOGIN", "alice", "secret");
        CHECK(good.ok);
        CHECK(!good.unavailable);
        CHECK_EQ(good.message, std::string("Welcome back"));
        CHECK_EQ(srv.last_command(), std::string("LOGIN alice secret"));

        auto rejected = cardauth::send_command(cfg, "REGISTER", "alice", "secret");
        CHECK(!rejected.ok);
        CHECK(!rejected.unavailable);
        CHECK_EQ(rejected.message, std::string("Username already taken"));

        auto weird = cardauth::send_command(cfg, "LOGIN", "x", "y");
        CHECK(!weird.ok);
        CHECK(!weird.unavailable);
        CHECK_EQ(weird.message, std::string("Unexpected response from login server"));
    }
    // ---- server accepts then goes silent: times out instead of hanging
    {
        FakeServer silent([](const std::string&) { return std::string(); });
        cardauth::Config cfg;
        cfg.port = silent.port();
        cfg.timeout_ms = 300;
        auto t0 = std::chrono::steady_clock::now();
        auto r = cardauth::send_command(cfg, "LOGIN", "a", "b");
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
        CHECK(!r.ok);
        CHECK(r.unavailable);
        CHECK(ms < 3000);
    }
    // ---- nothing listening: "unavailable", not a credential failure
    {
        int port;
        {
            FakeServer tmp([](const std::string&) { return std::string(); });
            port = tmp.port();
        }  // closed again
        cardauth::Config cfg;
        cfg.port = port;
        auto r = cardauth::send_command(cfg, "LOGIN", "a", "b");
        CHECK(!r.ok);
        CHECK(r.unavailable);
        CHECK(r.message.rfind("Login server unavailable", 0) == 0);
    }
#endif

    return cardtest::finish("cardauth");
}
