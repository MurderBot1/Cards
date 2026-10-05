#include "cardpaths/cardpaths.hpp"

#include <cstdlib>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#elif defined(__APPLE__)
#include <limits.h>
#include <mach-o/dyld.h>
#endif

namespace fs = std::filesystem;

namespace cardpaths {

namespace {

constexpr const char* kAppName = "Binder";
constexpr const char* kAppAuthor = "BinderCardTracker";

std::string host_os() {
#if defined(__ANDROID__)
    return "android";
#elif defined(_WIN32)
    return "windows";
#elif defined(__APPLE__)
    return "macos";
#else
    return "linux";
#endif
}

fs::path default_user_data_dir(const Environment& env) {
    if (env.os == "windows") {
        // Matches platformdirs' roaming layout: %APPDATA%\<author>\<app>.
        std::string appdata = env.getenv("APPDATA");
        fs::path base = appdata.empty() ? env.home / "AppData" / "Roaming" : fs::u8path(appdata);
        return base / kAppAuthor / kAppName;
    }
    if (env.os == "macos") return env.home / "Library" / "Application Support" / kAppName;
    // linux (and the fallback): XDG data home
    std::string xdg = env.getenv("XDG_DATA_HOME");
    fs::path base = xdg.empty() ? env.home / ".local" / "share" : fs::u8path(xdg);
    return base / kAppName;
}

bool has_index(const fs::path& dir) {
    std::error_code ec;
    return fs::exists(dir / "index.html", ec);
}

void add_unique(std::vector<fs::path>& v, const fs::path& p) {
    for (const auto& e : v)
        if (e == p) return;
    v.push_back(p);
}

// Ancestors of `start` (inclusive) that contain app/index.html — a dev build
// run from inside a checkout.
void add_repo_candidates(std::vector<fs::path>& v, fs::path start) {
    for (int depth = 0; depth < 8 && !start.empty(); ++depth) {
        add_unique(v, start / "app");
        auto parent = start.parent_path();
        if (parent == start) break;
        start = parent;
    }
}

}  // namespace

namespace {

#if defined(_WIN32)
// Environment variables as UTF-8 (std::getenv returns the ANSI code page, which mangles non-ASCII user names).
std::string utf8_from_wide(const std::wstring& w) {
    if (w.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
    std::string out(static_cast<size_t>(n), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), out.data(), n, nullptr, nullptr);
    return out;
}
std::wstring wide_from_utf8(const std::string& s) {
    if (s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring out(static_cast<size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), n);
    return out;
}
std::string get_env(const std::string& name) {
    std::wstring wname = wide_from_utf8(name);
    DWORD len = GetEnvironmentVariableW(wname.c_str(), nullptr, 0);
    if (len == 0) return {};
    std::wstring value(len, L'\0');
    DWORD got = GetEnvironmentVariableW(wname.c_str(), value.data(), len);
    value.resize(got);
    return utf8_from_wide(value);
}
#else
std::string get_env(const std::string& name) {
    const char* v = std::getenv(name.c_str());
    return v ? v : "";
}
#endif

fs::path current_executable() {
    std::error_code ec;
#if defined(_WIN32)
    std::wstring buf(32768, L'\0');
    DWORD n = GetModuleFileNameW(nullptr, buf.data(), static_cast<DWORD>(buf.size()));
    buf.resize(n);
    return fs::path(buf);
#elif defined(__APPLE__)
    char buf[PATH_MAX * 2];
    uint32_t size = sizeof(buf);
    if (_NSGetExecutablePath(buf, &size) != 0) return {};
    return fs::weakly_canonical(fs::path(buf), ec);
#elif defined(__linux__)
    return fs::read_symlink("/proc/self/exe", ec);
#else
    return {};  // Android: the Kotlin side passes the directories in through Options
#endif
}

}  // namespace

Environment system_environment() {
    Environment env;
    env.os = host_os();
    env.getenv = get_env;
    std::string home = get_env("HOME");
    if (home.empty()) home = get_env("USERPROFILE");
    env.home = fs::u8path(home);
    std::error_code ec;
    env.cwd = fs::current_path(ec);
    env.exe_path = current_executable();
    return env;
}

Paths resolve(const Environment& env, const Options& options) {
    Paths p;

    if (options.user_data_dir) {
        p.user_data_dir = *options.user_data_dir;
    } else if (auto e = env.getenv("BINDER_USER_DATA_DIR"); !e.empty()) {
        p.user_data_dir = fs::u8path(e);
    } else {
        p.user_data_dir = default_user_data_dir(env);
    }
    p.log_dir = p.user_data_dir / "logs";
    p.data_dir = p.user_data_dir / "data";
    p.db_path = p.user_data_dir / "db.json";
    p.startup_log = p.log_dir / "startup.log";

    // Frontend: explicit choices first, then the usual install layouts, then
    // a source checkout.
    auto& c = p.frontend_candidates;
    if (options.frontend_dir) add_unique(c, *options.frontend_dir);
    if (auto e = env.getenv("BINDER_FRONTEND_DIR"); !e.empty()) add_unique(c, fs::u8path(e));
    fs::path exe_dir = env.exe_path.parent_path();
    if (!exe_dir.empty()) {
        add_unique(c, exe_dir / "frontend");                               // Windows / Linux zip layout
        add_unique(c, exe_dir.parent_path() / "Resources" / "frontend");   // macOS .app bundle
        add_unique(c, exe_dir.parent_path() / "share" / "binder" / "frontend");  // prefix install
        add_repo_candidates(c, exe_dir);
    }
    if (!env.cwd.empty()) add_repo_candidates(c, env.cwd);

    for (const auto& cand : c) {
        if (has_index(cand)) {
            p.frontend_dir = cand;
            p.frontend_found = true;
            break;
        }
    }
    if (!p.frontend_found && !c.empty()) p.frontend_dir = c.front();

    // A catalog shipped alongside an installed frontend/ directory.
    if (p.frontend_found && p.frontend_dir.filename() == "frontend") {
        auto bundled = p.frontend_dir.parent_path() / "data";
        std::error_code ec;
        if (fs::is_directory(bundled, ec)) p.bundled_data_dir = bundled;
    }
    return p;
}

void ensure_dirs(const Paths& paths) {
    fs::create_directories(paths.user_data_dir);
    fs::create_directories(paths.log_dir);
}

bool ensure_bundled_catalog(const Paths& paths) {
    if (!paths.bundled_data_dir) return false;
    std::error_code ec;
    if (fs::is_directory(paths.data_dir, ec) && fs::directory_iterator(paths.data_dir, ec) != fs::directory_iterator())
        return false;
    fs::create_directories(paths.data_dir);
    fs::copy(*paths.bundled_data_dir, paths.data_dir, fs::copy_options::recursive | fs::copy_options::overwrite_existing);
    return true;
}

}  // namespace cardpaths
