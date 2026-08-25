#pragma once
//
// UserStore.h
// -----------------------------------------------------------------
// Owns the account database: username -> (salt, salted password
// hash). Persisted as a simple pipe-delimited text file so the
// project has zero external database dependency. Thread-safe, since
// the server handles each client on its own thread and multiple
// clients may log in / register concurrently.
// -----------------------------------------------------------------
#include <mutex>
#include <string>
#include <unordered_map>

class UserStore {
public:
    // Loads accounts from `path` if it exists. Remembers `path` so
    // later save() calls (from addUser) write back to the same file.
    // Returns false only on an unexpected read error; a missing file
    // is not an error (treated as "no accounts yet").
    bool load(const std::string& path);

    // Verifies a plaintext password against the stored salted hash
    // for `username`. Returns false for unknown users too, without
    // distinguishing why (avoids leaking which usernames exist).
    bool verify(const std::string& username, const std::string& password) const;

    // Adds a new account with a freshly generated random salt.
    // Returns false if the username already exists. Persists to disk
    // immediately if a path was set via load().
    bool addUser(const std::string& username, const std::string& password);

    bool exists(const std::string& username) const;
    size_t count() const;

private:
    struct Account {
        std::string saltHex;
        std::string hashHex; // SHA256(saltHex + password)
    };

    static std::string generateSaltHex();
    static std::string computeHash(const std::string& saltHex, const std::string& password);

    bool save() const;

    mutable std::mutex mutex_;
    std::unordered_map<std::string, Account> accounts_;
    std::string path_;
};