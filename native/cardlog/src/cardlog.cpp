#include "cardlog/cardlog.hpp"

#include <ctime>
#include <fstream>

namespace fs = std::filesystem;

namespace cardlog {

std::string timestamp() {
    std::time_t now = std::time(nullptr);
    std::tm tm_buf{};
#ifdef _WIN32
    localtime_s(&tm_buf, &now);
#else
    localtime_r(&now, &tm_buf);
#endif
    char out[32];
    std::strftime(out, sizeof(out), "%Y-%m-%d %H:%M:%S", &tm_buf);
    return out;
}

void append_line(const fs::path& path, const std::string& line) noexcept {
    try {
        if (path.has_parent_path()) fs::create_directories(path.parent_path());
        std::ofstream f(path, std::ios::app | std::ios::binary);
        f << line << '\n';
    } catch (...) {
    }
}

RotatingLog::RotatingLog(fs::path path, std::uintmax_t max_bytes, int backups)
    : path_(std::move(path)), max_bytes_(max_bytes), backups_(backups) {}

void RotatingLog::write(const std::string& line) noexcept {
    try {
        std::lock_guard<std::mutex> lock(mu_);
        std::string full = timestamp() + " " + line + "\n";
        if (path_.has_parent_path()) fs::create_directories(path_.parent_path());
        std::error_code ec;
        auto size = fs::exists(path_, ec) ? fs::file_size(path_, ec) : 0;
        if (!ec && size > 0 && size + full.size() > max_bytes_) rotate_locked();
        std::ofstream f(path_, std::ios::app | std::ios::binary);
        f << full;
    } catch (...) {
    }
}

void RotatingLog::rotate_locked() {
    auto numbered = [&](int n) { return fs::path(path_.string() + "." + std::to_string(n)); };
    std::error_code ec;
    if (backups_ <= 0) {
        fs::remove(path_, ec);
        return;
    }
    fs::remove(numbered(backups_), ec);
    for (int n = backups_ - 1; n >= 1; --n) {
        if (fs::exists(numbered(n), ec)) fs::rename(numbered(n), numbered(n + 1), ec);
    }
    fs::rename(path_, numbered(1), ec);
}

}  // namespace cardlog
