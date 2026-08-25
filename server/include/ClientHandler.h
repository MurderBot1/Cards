#pragma once
//
// ClientHandler.h
// -----------------------------------------------------------------
// Runs on its own thread per connected client (spawned by Server).
// Speaks a tiny newline-delimited text protocol:
//
//   LOGIN <username> <password>      -> "OK Welcome <username>"
//                                       | "FAIL Invalid credentials"
//   REGISTER <username> <password>   -> "OK Registered <username>"
//                                       | "FAIL Username taken"
//                                       | "FAIL Invalid username or password"
//   QUIT                             -> connection closed
//
// Any other input gets "FAIL Unknown command". Usernames/passwords
// are plain whitespace-delimited tokens (no spaces in either), which
// keeps the protocol trivial to parse by hand without pulling in a
// JSON library — swap this out for a real serialization format if
// the protocol needs to grow beyond login/register.
// -----------------------------------------------------------------
#include <string>

#include "PlatformSocket.h"

class UserStore;

class ClientHandler {
public:
    ClientHandler(socket_t clientSocket, std::string clientAddress, UserStore& store);

    // Blocks, reading and responding to commands, until the client
    // disconnects, sends QUIT, or a socket error occurs. Closes the
    // socket before returning.
    void run();

private:
    bool readLine(std::string& outLine);
    void sendLine(const std::string& line);

    void handleLogin(const std::string& args);
    void handleRegister(const std::string& args);

    socket_t socket_;
    std::string clientAddress_;
    UserStore& store_;
    std::string recvBuffer_;
};