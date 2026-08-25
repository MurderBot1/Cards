#include "ClientHandler.h"
#include "UserStore.h"
#include "Logger.h"

#include <cctype>
#include <utility>

namespace {

// Splits `s` on the first run of whitespace into (head, remainder).
// remainder has any leading whitespace stripped. Either half may be
// empty if there's nothing to split.
std::pair<std::string, std::string> splitFirst(const std::string& s) {
    size_t i = 0;
    while (i < s.size() && !isspace(static_cast<unsigned char>(s[i]))) ++i;
    std::string head = s.substr(0, i);
    while (i < s.size() && isspace(static_cast<unsigned char>(s[i]))) ++i;
    return {head, s.substr(i)};
}

constexpr size_t kMaxLineLength = 1024; // guards against a client sending endless bytes with no '\n'

} // namespace

ClientHandler::ClientHandler(socket_t clientSocket, std::string clientAddress, UserStore& store)
    : socket_(clientSocket), clientAddress_(std::move(clientAddress)), store_(store) {}

bool ClientHandler::readLine(std::string& outLine) {
    for (;;) {
        size_t nl = recvBuffer_.find('\n');
        if (nl != std::string::npos) {
            outLine = recvBuffer_.substr(0, nl);
            if (!outLine.empty() && outLine.back() == '\r') outLine.pop_back();
            recvBuffer_.erase(0, nl + 1);
            return true;
        }

        if (recvBuffer_.size() > kMaxLineLength) {
            return false; // misbehaving client — drop the connection
        }

        char chunk[512];
        long n = platformRecv(socket_, chunk, sizeof(chunk));
        if (n <= 0) {
            return false; // connection closed or error
        }
        recvBuffer_.append(chunk, static_cast<size_t>(n));
    }
}

void ClientHandler::sendLine(const std::string& line) {
    std::string withNewline = line + "\n";
    size_t total = 0;
    while (total < withNewline.size()) {
        long n = platformSend(socket_, withNewline.data() + total, withNewline.size() - total);
        if (n <= 0) return; // client gone — nothing more we can do
        total += static_cast<size_t>(n);
    }
}

void ClientHandler::handleLogin(const std::string& args) {
    auto [username, rest] = splitFirst(args);
    auto [password, extra] = splitFirst(rest);

    if (username.empty() || password.empty()) {
        sendLine("FAIL Usage: LOGIN <username> <password>");
        return;
    }

    if (store_.verify(username, password)) {
        Logger::instance().info("Login OK for '" + username + "' from " + clientAddress_);
        sendLine("OK Welcome " + username);
    } else {
        Logger::instance().warn("Login FAILED for '" + username + "' from " + clientAddress_);
        sendLine("FAIL Invalid credentials");
    }
}

void ClientHandler::handleRegister(const std::string& args) {
    auto [username, rest] = splitFirst(args);
    auto [password, extra] = splitFirst(rest);

    if (username.empty() || password.empty()) {
        sendLine("FAIL Invalid username or password");
        return;
    }

    if (store_.addUser(username, password)) {
        Logger::instance().info("Registered new user '" + username + "' from " + clientAddress_);
        sendLine("OK Registered " + username);
    } else {
        sendLine("FAIL Username taken");
    }
}

void ClientHandler::run() {
    Logger::instance().info("Client connected: " + clientAddress_);
    sendLine("OK Connected to LoginServer");

    std::string line;
    while (readLine(line)) {
        if (line.empty()) continue;

        auto [command, args] = splitFirst(line);
        for (auto& c : command) c = static_cast<char>(toupper(static_cast<unsigned char>(c)));

        if (command == "LOGIN") {
            handleLogin(args);
        } else if (command == "REGISTER") {
            handleRegister(args);
        } else if (command == "QUIT") {
            sendLine("OK Bye");
            break;
        } else {
            sendLine("FAIL Unknown command");
        }
    }

    Logger::instance().info("Client disconnected: " + clientAddress_);
    platformCloseSocket(socket_);
}