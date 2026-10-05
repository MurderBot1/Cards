// cardauth — client for the C++ LoginServer's newline-delimited TCP protocol
// (LOGIN / REGISTER, see loginserver/README.md). The LoginServer owns the
// accounts; this just speaks its protocol so the frontend only ever has to
// speak JSON over HTTP.
#pragma once

#include <optional>
#include <string>

namespace cardauth {

struct Config {
    std::string host = "127.0.0.1";
    int port = 7777;
    int timeout_ms = 5000;
};

struct Reply {
    bool ok = false;
    // On success: whatever followed "OK". On failure: the server's reason, or
    // "Login server unavailable: ..." when the connection itself failed.
    std::string message;
    bool unavailable = false;  // true: couldn't talk to the server at all (not a rejected credential)
};

// Sends "<command> <username> <password>\n" (command: "LOGIN" | "REGISTER") and parses the
// one-line "OK ..." / "FAIL ..." reply. Never throws.
Reply send_command(const Config& config, const std::string& command, const std::string& username,
                   const std::string& password);

// The protocol is whitespace-delimited, so a space in either field would
// silently truncate instead of erroring — reject it before it reaches the
// socket. Returns an error message, or nullopt if the pair is acceptable.
// `username` is trimmed in place.
std::optional<std::string> validate_credentials(std::string& username, const std::string& password);

}  // namespace cardauth
