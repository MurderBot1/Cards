#include "save_file.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <system_error>

namespace fs = std::filesystem;

namespace binder {

bool is_safe_export_name(const std::string& name) {
    if (name.empty() || name.size() > 120 || name[0] == '.') return false;
    for (unsigned char c : name) {
        if (c < 0x20 || c == 0x7f) return false;
        if (std::string("/\\:*?\"<>|").find(static_cast<char>(c)) != std::string::npos) return false;
    }
    if (name.size() < 5) return false;
    std::string ext = name.substr(name.size() - 4);
    std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c) { return std::tolower(c); });
    return ext == ".csv" && name.size() > 4;
}

SaveResult save_export(const fs::path& dir, const std::string& name, const std::string& content) {
    SaveResult result;
    if (!is_safe_export_name(name)) {
        result.error = "that isn't a name this can save";
        return result;
    }
    std::error_code ec;
    fs::create_directories(dir, ec);
    if (ec) {
        result.error = "couldn't create " + dir.string() + ": " + ec.message();
        return result;
    }
    const fs::path stem = fs::u8path(name.substr(0, name.size() - 4));
    fs::path target = dir / fs::u8path(name);
    for (int n = 2; fs::exists(target, ec) && n < 1000; ++n) target = dir / fs::u8path(stem.u8string() + " (" + std::to_string(n) + ").csv");
    if (fs::exists(target, ec)) {
        result.error = "too many files with that name";
        return result;
    }
    std::ofstream out(target, std::ios::binary | std::ios::trunc);
    out.write(content.data(), static_cast<std::streamsize>(content.size()));
    out.close();
    if (!out) {
        result.error = "couldn't write " + target.string();
        return result;
    }
    result.ok = true;
    result.path = target;
    return result;
}

}  // namespace binder
