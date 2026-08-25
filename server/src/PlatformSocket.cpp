#include "PlatformSocket.h"

#include <cstring>

#ifdef _WIN32

bool platformSocketInit() {
    WSADATA wsaData;
    return WSAStartup(MAKEWORD(2, 2), &wsaData) == 0;
}

void platformSocketCleanup() {
    WSACleanup();
}

void platformCloseSocket(socket_t s) {
    closesocket(s);
}

long platformRecv(socket_t s, char* buffer, size_t len) {
    return recv(s, buffer, static_cast<int>(len), 0);
}

long platformSend(socket_t s, const char* buffer, size_t len) {
    return send(s, buffer, static_cast<int>(len), 0);
}

std::string platformLastSocketError() {
    int code = WSAGetLastError();
    char buf[256] = {0};
    FormatMessageA(
        FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr, code, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
        buf, sizeof(buf), nullptr);
    std::string msg(buf);
    while (!msg.empty() && (msg.back() == '\n' || msg.back() == '\r')) {
        msg.pop_back();
    }
    return msg + " (WSA error " + std::to_string(code) + ")";
}

void platformSetReuseAddr(socket_t s) {
    const char opt = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
}

#else // POSIX

bool platformSocketInit() {
    return true; // nothing to initialize
}

void platformSocketCleanup() {
    // nothing to tear down
}

void platformCloseSocket(socket_t s) {
    close(s);
}

long platformRecv(socket_t s, char* buffer, size_t len) {
    return static_cast<long>(recv(s, buffer, len, 0));
}

long platformSend(socket_t s, const char* buffer, size_t len) {
    return static_cast<long>(send(s, buffer, len, 0));
}

std::string platformLastSocketError() {
    return std::strerror(errno);
}

void platformSetReuseAddr(socket_t s) {
    int opt = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
}

#endif