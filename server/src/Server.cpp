#include "Server.h"
#include "ClientHandler.h"
#include "UserStore.h"
#include "Logger.h"

#include <thread>

Server::Server(uint16_t port, UserStore& store) : port_(port), store_(store) {}

Server::~Server() {
    stop();
}

bool Server::start() {
    listenSocket_ = socket(AF_INET, SOCK_STREAM, 0);
    if (listenSocket_ == kInvalidSocket) {
        Logger::instance().error("Failed to create socket: " + platformLastSocketError());
        return false;
    }

    platformSetReuseAddr(listenSocket_);

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port_);

    if (bind(listenSocket_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        Logger::instance().error("Failed to bind port " + std::to_string(port_) + ": " + platformLastSocketError());
        platformCloseSocket(listenSocket_);
        listenSocket_ = kInvalidSocket;
        return false;
    }

    constexpr int kBacklog = 32;
    if (listen(listenSocket_, kBacklog) != 0) {
        Logger::instance().error("Failed to listen: " + platformLastSocketError());
        platformCloseSocket(listenSocket_);
        listenSocket_ = kInvalidSocket;
        return false;
    }

    Logger::instance().info("Listening on port " + std::to_string(port_));
    return true;
}

void Server::run() {
    if (listenSocket_ == kInvalidSocket) {
        Logger::instance().error("run() called before a successful start()");
        return;
    }

    running_ = true;
    while (running_) {
        sockaddr_in clientAddr{};
        socklen_t clientLen = sizeof(clientAddr);
        socket_t clientSocket = accept(listenSocket_, reinterpret_cast<sockaddr*>(&clientAddr), &clientLen);

        if (clientSocket == kInvalidSocket) {
            if (!running_) break; // stop() closed the socket out from under accept()
            Logger::instance().warn("accept() failed: " + platformLastSocketError());
            continue;
        }

        char ipStr[INET_ADDRSTRLEN] = {0};
        inet_ntop(AF_INET, &clientAddr.sin_addr, ipStr, sizeof(ipStr));
        std::string clientAddress = std::string(ipStr) + ":" + std::to_string(ntohs(clientAddr.sin_port));

        // one thread per connection — simple and plenty for a login
        // server, which only needs a socket open long enough to
        // exchange a handful of short request/response lines.
        std::thread([clientSocket, clientAddress, this]() {
            ClientHandler handler(clientSocket, clientAddress, store_);
            handler.run();
        }).detach();
    }
}

void Server::stop() {
    if (!running_.exchange(false)) {
        return; // already stopped (or never started)
    }
    if (listenSocket_ != kInvalidSocket) {
        platformCloseSocket(listenSocket_);
        listenSocket_ = kInvalidSocket;
    }
    Logger::instance().info("Server stopped");
}