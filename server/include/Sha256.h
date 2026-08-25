#pragma once
//
// Sha256.h
// -----------------------------------------------------------------
// Minimal, dependency-free SHA-256 implementation (FIPS 180-4).
// Used by UserStore to store salted password hashes instead of
// plaintext passwords. Not a substitute for a slow, purpose-built
// password KDF (e.g. bcrypt/argon2) in a real production system —
// but combined with a random per-user salt it's a large step above
// storing passwords in the clear, and keeps this project dependency
// free (no external crypto library required to build it).
// -----------------------------------------------------------------
#include <array>
#include <cstdint>
#include <string>

class Sha256 {
public:
    // Returns the lowercase hex digest of `data`.
    static std::string hashHex(const std::string& data);

private:
    static constexpr size_t kDigestSize = 32; // 256 bits

    void init();
    void update(const uint8_t* data, size_t len);
    std::array<uint8_t, kDigestSize> finalize();

    void processBlock(const uint8_t* block);

    uint32_t state_[8]{};
    uint8_t buffer_[64]{};
    size_t bufferLen_ = 0;
    uint64_t totalLen_ = 0;
};