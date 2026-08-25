#pragma once
//
// PlatformSocket.h
// -----------------------------------------------------------------
// Thin cross-platform socket layer so Server.cpp / ClientHandler.cpp
// don't need to be littered with #ifdef _WIN32. Windows uses Winsock2
// (SOCKET handles, closesocket(), WSAStartup/WSACleanup); Linux/macOS
// use the standard BSD sockets API (int file descriptors, close()).
// Everything else in the project (sockaddr_in, htons, AF_INET,
// inet_ntop, socklen_t, ...) is already spelled the same way on both
// platforms once <winsock2.h>/<ws2tcpip.h> or the POSIX headers are
// included, so those are used directly elsewhere — only the handful
// of things that genuinely differ are wrapped here.
// -----------------------------------------------------------------
#include <cstddef>
#include <string>

#ifdef _WIN32
    #ifndef WIN32_LEAN_AND_MEAN
        #define WIN32_LEAN_AND_MEAN
    #endif
    #ifndef NOMINMAX
        #define NOMINMAX
    #endif
    #include <winsock2.h>
    #include <ws2tcpip.h>
    #pragma comment(lib, "ws2_32.lib")

    using socket_t = SOCKET;
    constexpr socket_t kInvalidSocket = INVALID_SOCKET;
#else
    #include <arpa/inet.h>
    #include <cerrno>
    #include <netinet/in.h>
    #include <sys/socket.h>
    #include <unistd.h>

    using socket_t = int;
    constexpr socket_t kInvalidSocket = -1;
#endif

// Must be called once before any socket use — starts up Winsock on
// Windows; no-op on POSIX. Returns false on failure.
bool platformSocketInit();

// Must be called once at shutdown — tears down Winsock on Windows;
// no-op on POSIX.
void platformSocketCleanup();

// Closes a socket handle, portably (closesocket() vs close()).
void platformCloseSocket(socket_t s);

// recv()/send() with a signature that's identical on both platforms.
// (Winsock's recv/send take an `int` length and buffer as `char*`;
// POSIX's take a `size_t` length and buffer as `void*`. `long` safely
// holds either return type.)
long platformRecv(socket_t s, char* buffer, size_t len);
long platformSend(socket_t s, const char* buffer, size_t len);

// Human-readable message for the most recent socket error on this
// thread — strerror(errno) on POSIX, a formatted WSAGetLastError() on
// Windows.
std::string platformLastSocketError();

// Enables SO_REUSEADDR on a (not-yet-bound) listening socket,
// portably — Winsock's setsockopt() wants a `const char*` optval
// instead of POSIX's `const void*`.
void platformSetReuseAddr(socket_t s); 