//
// main.cpp
// -----------------------------------------------------------------
// LoginServer entry point.
//
// Usage:
//   LoginServer [port] [accounts_file] [log_file]
//
// Defaults: port 7777, accounts file data/users.db, log file
// data/server.log (both relative to the working directory the
// server is launched from).
//
// Protocol (plain text, newline-delimited — see ClientHandler.h):
//   LOGIN <username> <password>
//   REGISTER <username> <password>
//   QUIT
//
// Try it with netcat once the server is running:
//   nc localhost 7777
//   REGISTER alice hunter2
//   LOGIN alice hunter2
// -----------------------------------------------------------------
#include "Server.h"
#include "UserStore.h"
#include "Logger.h"
#include "PlatformSocket.h"

#include <csignal>
#include <cstdlib>
#include <memory>

namespace {
std::unique_ptr<Server> g_server;

void handleSignal(int) {
    if (g_server) {
        g_server->stop();
    }
}
} // namespace

int main(int argc, char** argv) {
    uint16_t port = 7777;
    std::string accountsPath = "data/users.db";
    std::string logPath = "data/server.log";

    if (argc > 1) port = static_cast<uint16_t>(std::atoi(argv[1]));
    if (argc > 2) accountsPath = argv[2];
    if (argc > 3) logPath = argv[3];

    Logger::instance().openFile(logPath);
    Logger::instance().info("LoginServer starting up");

    if (!platformSocketInit()) {
        Logger::instance().error("Failed to initialize sockets (WSAStartup failed)");
        return 1;
    }

    UserStore store;
    if (!store.load(accountsPath)) {
        Logger::instance().error("Failed to load accounts from " + accountsPath);
        platformSocketCleanup();
        return 1;
    }
    Logger::instance().info("Loaded " + std::to_string(store.count()) + " account(s) from " + accountsPath);

    g_server = std::make_unique<Server>(port, store);
    if (!g_server->start()) {
        platformSocketCleanup();
        return 1;
    }

    std::signal(SIGINT, handleSignal);
    std::signal(SIGTERM, handleSignal);

    g_server->run();
    platformSocketCleanup();
    return 0;
}