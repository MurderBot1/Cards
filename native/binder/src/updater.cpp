#include "updater.hpp"

#include <algorithm>
#include <cctype>
#include <cstring>
#include <system_error>
#include <thread>
#include <vector>

#include "open_url.hpp"
#include "sha256.hpp"

#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif

#if defined(_WIN32)
#include <windows.h>
#elif defined(__ANDROID__) || (defined(__APPLE__) && TARGET_OS_IPHONE)
// no desktop installer
#else
#include <fcntl.h>
#include <limits.h>
#include <sys/wait.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif
#endif

namespace fs = std::filesystem;

namespace binder {

namespace {
constexpr const char* kDownloadPrefix = "https://github.com/MurderBot1/Cards/releases/download/";

bool is_digit(char c) { return c >= '0' && c <= '9'; }

// "v1.2.3" -> true
bool is_version_tag(const std::string& s) {
    if (s.size() < 6 || s[0] != 'v') return false;
    int dots = 0;
    bool digit_before = false;
    for (size_t i = 1; i < s.size(); ++i) {
        if (is_digit(s[i])) digit_before = true;
        else if (s[i] == '.' && digit_before && dots < 2 && i + 1 < s.size()) {
            ++dots;
            digit_before = false;
        } else return false;
    }
    return dots == 2 && digit_before;
}

bool split_update_url(const std::string& url, std::string& tag, std::string& name) {
    if (!is_release_url(url) || url.rfind(kDownloadPrefix, 0) != 0) return false;
    std::string rest = url.substr(std::strlen(kDownloadPrefix));
    auto slash = rest.find('/');
    if (slash == std::string::npos) return false;
    tag = rest.substr(0, slash);
    name = rest.substr(slash + 1);
    if (!is_version_tag(tag)) return false;
    return std::any_of(std::begin(kUpdateFileNames), std::end(kUpdateFileNames), [&](const char* n) { return name == n; });
}
}  // namespace

bool is_update_url(const std::string& url) {
    std::string tag, name;
    return split_update_url(url, tag, name);
}

bool is_sha256_hex(const std::string& hex) {
    return hex.size() == 64 && std::all_of(hex.begin(), hex.end(), [](unsigned char c) { return std::isxdigit(c) != 0; });
}

struct Updater::State {
    Hooks hooks;
    fs::path dir;
    mutable std::mutex mu;
    Status status;
    fs::path part_file, final_file;
};

Updater::Updater(fs::path dir, Hooks hooks) : state_(std::make_shared<State>()) {
    state_->hooks = std::move(hooks);
    if (!state_->hooks.launch) state_->hooks.launch = default_launch;
    state_->dir = std::move(dir);
}

bool Updater::start_download(const std::string& url, const std::string& sha256, std::string& error) {
    std::string tag, name;
    if (!split_update_url(url, tag, name)) {
        error = "that isn't one of this project's installers";
        return false;
    }
    if (!is_sha256_hex(sha256)) {
        error = "the release doesn't publish a checksum for it";
        return false;
    }
    if (!state_->hooks.make_transport) {
        error = "this build can't download updates";
        return false;
    }
    auto state = state_;
    {
        std::lock_guard<std::mutex> l(state->mu);
        if (state->status.state == "downloading" || state->status.state == "installing") {
            error = "an update is already in progress";
            return false;
        }
        std::error_code ec;
        fs::remove_all(state->dir, ec);
        fs::create_directories(state->dir, ec);
        if (ec) {
            error = "couldn't create the update folder: " + ec.message();
            return false;
        }
        state->final_file = state->dir / name;
        state->part_file = state->final_file;
        state->part_file += ".part";
        state->status = Status{};
        state->status.state = "downloading";
        state->status.version = tag;
    }

    std::string expected = sha256;
    std::transform(expected.begin(), expected.end(), expected.begin(), [](unsigned char c) { return std::tolower(c); });
    std::thread([state, url, expected] {
        auto fail = [&](const std::string& message) {
            std::error_code ec;
            fs::remove(state->part_file, ec);
            std::lock_guard<std::mutex> l(state->mu);
            state->status.state = "error";
            state->status.error = message;
        };
        try {
            auto transport = state->hooks.make_transport();
            transport->on_download_size = [state](unsigned long long total) {
                std::lock_guard<std::mutex> l(state->mu);
                state->status.total = total;
            };
            long http = transport->get_to_file(url, 60, state->part_file);
            if (!cardfetch::is_success(http)) return fail("the download failed (HTTP " + std::to_string(http) + ")");
            if (sha256_file_hex(state->part_file) != expected) return fail("the download didn't match its checksum, so it wasn't installed");
            std::error_code ec;
            fs::rename(state->part_file, state->final_file, ec);
            if (ec) return fail("couldn't save the download: " + ec.message());
            std::lock_guard<std::mutex> l(state->mu);
            state->status.state = "ready";
            state->status.bytes = state->status.total = fs::file_size(state->final_file, ec);
        } catch (const std::exception& e) {
            fail(std::string("the download failed (") + e.what() + ")");
        }
    }).detach();
    return true;
}

Updater::Status Updater::status() const {
    std::lock_guard<std::mutex> l(state_->mu);
    Status s = state_->status;
    if (s.state == "downloading") {
        std::error_code ec;
        auto size = fs::file_size(state_->part_file, ec);
        if (!ec) s.bytes = size;
    }
    return s;
}

bool Updater::install(std::string& error) {
    fs::path file;
    {
        std::lock_guard<std::mutex> l(state_->mu);
        if (state_->status.state != "ready") {
            error = "there's no downloaded update to install";
            return false;
        }
        file = state_->final_file;
        state_->status.state = "installing";
    }
    bool ok = state_->hooks.launch(file, error);
    {
        std::lock_guard<std::mutex> l(state_->mu);
        if (!ok) {
            state_->status.state = "error";
            state_->status.error = error;
        }
    }
    if (ok && state_->hooks.quit) state_->hooks.quit();
    return ok;
}

// ---- the platform installers -------------------------------------------------------------------------------------

#if defined(_WIN32)

bool default_launch(const fs::path& file, std::string& error) {
    // The setup is a per-user NSIS installer: /S installs silently over the old copy (it closes the running app and
    // starts the new one when it's done).
    std::wstring command = L"\"" + file.wstring() + L"\" /S";
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
                        nullptr, nullptr, &startup, &process)) {
        error = "couldn't start the installer (error " + std::to_string(GetLastError()) + ")";
        return false;
    }
    CloseHandle(process.hProcess);
    CloseHandle(process.hThread);
    return true;
}

#elif defined(__ANDROID__) || (defined(__APPLE__) && TARGET_OS_IPHONE)

bool default_launch(const fs::path&, std::string& error) {
    error = "this platform installs updates itself";
    return false;
}

#else

namespace {

std::string current_executable() {
    char buffer[PATH_MAX] = {0};
#if defined(__APPLE__)
    uint32_t size = sizeof(buffer);
    if (_NSGetExecutablePath(buffer, &size) != 0) return "";
    char resolved[PATH_MAX];
    return realpath(buffer, resolved) ? std::string(resolved) : std::string(buffer);
#else
    ssize_t n = readlink("/proc/self/exe", buffer, sizeof(buffer) - 1);
    return n > 0 ? std::string(buffer, static_cast<size_t>(n)) : std::string();
#endif
}

// Runs `/bin/sh -c script sh args...` in its own session, so it carries on after this process quits.
bool spawn_script(const char* script, const std::vector<std::string>& args, std::string& error) {
    std::vector<const char*> argv = {"sh", "-c", script, "binder-update"};
    for (const auto& a : args) argv.push_back(a.c_str());
    argv.push_back(nullptr);
    pid_t pid = fork();
    if (pid < 0) {
        error = "couldn't start the installer";
        return false;
    }
    if (pid == 0) {
        setsid();
        int null = open("/dev/null", O_RDWR);
        if (null >= 0) {
            dup2(null, 0);
            dup2(null, 1);
            dup2(null, 2);
        }
        execv("/bin/sh", const_cast<char* const*>(argv.data()));
        _exit(127);
    }
    std::thread([pid] {
        int status = 0;
        waitpid(pid, &status, 0);
    }).detach();
    return true;
}

}  // namespace

bool default_launch(const fs::path& file, std::string& error) {
#if defined(__APPLE__)
    // Binder.app/Contents/MacOS/binder -> the .app being replaced. Run from anywhere else (a build tree), there's
    // nothing to replace, so the disk image is just opened for the user.
    std::string exe = current_executable();
    auto marker = exe.rfind(".app/Contents/MacOS/");
    if (marker == std::string::npos) {
        if (spawn_script("open \"$1\"", {file.string()}, error)) return true;
        return false;
    }
    std::string app = exe.substr(0, marker + 4);
    // Wait for this process to go, swap the bundle for the one on the disk image, and open it. Nothing the download
    // fetched carries a quarantine flag, but clear it anyway.
    static const char* script =
        "sleep 1; mnt=$(mktemp -d /tmp/binder-update.XXXXXX) || exit 1; "
        "if hdiutil attach -nobrowse -readonly -quiet -mountpoint \"$mnt\" \"$1\" && [ -d \"$mnt/Binder.app\" ] "
        "&& rm -rf \"$2.new\" && cp -R \"$mnt/Binder.app\" \"$2.new\" && rm -rf \"$2\" && mv \"$2.new\" \"$2\"; then "
        "hdiutil detach -quiet \"$mnt\"; xattr -dr com.apple.quarantine \"$2\" 2>/dev/null; open \"$2\"; "
        "else hdiutil detach -quiet \"$mnt\" 2>/dev/null; open \"$1\"; fi";
    return spawn_script(script, {file.string(), app}, error);
#else
    // A .deb: let polkit ask for the password and apt install it (pulling in anything missing), then start it again.
    // Without those, open the package in the desktop's software installer.
    static const char* script =
        "sleep 1; if command -v pkexec >/dev/null 2>&1 && pkexec apt-get install -y \"$1\"; then "
        "nohup /usr/bin/binder >/dev/null 2>&1 & else xdg-open \"$1\"; fi";
    return spawn_script(script, {file.string()}, error);
#endif
}

#endif

}  // namespace binder
