// cardlog — tiny file logging: a size-rotating log (the API access log) and
// a best-effort append (the startup log, which must never itself crash
// startup — a packaged build has no console to show errors on).
#pragma once

#include <cstdint>
#include <filesystem>
#include <mutex>
#include <string>

namespace cardlog {

// "YYYY-MM-DD HH:MM:SS" in local time.
std::string timestamp();

// Appends one line to `path`, creating parent directories. Swallows every
// error.
void append_line(const std::filesystem::path& path, const std::string& line) noexcept;

// Appends timestamped lines to `path`; once the file would exceed
// `max_bytes`, shifts path -> path.1 -> ... -> path.<backups> (oldest
// dropped). Thread-safe.
class RotatingLog {
public:
    RotatingLog(std::filesystem::path path, std::uintmax_t max_bytes = 5 * 1024 * 1024, int backups = 3);
    void write(const std::string& line) noexcept;

private:
    void rotate_locked();

    std::filesystem::path path_;
    std::uintmax_t max_bytes_;
    int backups_;
    std::mutex mu_;
};

}  // namespace cardlog
