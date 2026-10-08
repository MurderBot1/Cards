// SHA-256, so a downloaded installer can be checked against the digest GitHub publishes for the release asset before
// anything runs it.
#pragma once

#include <filesystem>
#include <string>

namespace binder {

// Lower-case hex digest of `data`.
std::string sha256_hex(const std::string& data);

// Lower-case hex digest of a file's contents (streamed); empty if the file can't be read.
std::string sha256_file_hex(const std::filesystem::path& file);

}  // namespace binder
