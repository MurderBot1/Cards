#pragma once
//
// Server.h
// -----------------------------------------------------------------
// A bare TCP server: listens on a port, accepts connections, and
// hands each one off to a ClientHandler running on its own detached
// thread. Uses raw POSIX sockets rather than a networking library so
// the project has no dependencies beyond the C++ standard library
// and premake5 for the build.
// -----------------------------------------------------------------
#include <atomic>
#include <cstdint>
#include <string>

#include "PlatformSocket.h"

class UserStore;

class Server {
public:
    Server(uint16_t port, UserStore& store);
    ~Server();

    // Creates and binds the listening socket. Returns false on failure
    // (address already in use, permission denied for the port, etc.).
    bool start();

    // Blocks, accepting connections and dispatching them to
    // ClientHandler threads, until stop() is called (typically from a
    // signal handler on another thread).
    void run();

    // Unblocks run() and closes the listening socket. Safe to call
    // from a signal handler.
    void stop();

private:
    uint16_t port_;
    UserStore& store_;
    socket_t listenSocket_ = kInvalidSocket;
    std::atomic<bool> running_{false};
};