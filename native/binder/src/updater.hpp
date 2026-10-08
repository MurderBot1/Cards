// In-app updates for the desktop builds: downloads the installer of a newer release into a scratch directory, checks it
// against the SHA-256 digest GitHub publishes for the asset, and then hands it to the platform's installer, which
// replaces the running copy and starts the new one. The frontend (js/updates.js) drives it through /api/update/*.
//
// Android installs updates from Kotlin (Updater.kt, same status shape) and iOS can't install anything itself, so
// neither builds an Updater.
#pragma once

#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <string>

#include "cardfetch/fetch.hpp"

namespace binder {

// Only this project's release installers may be downloaded and run: https://github.com/MurderBot1/Cards/releases/
// download/vX.Y.Z/<one of the installer file names>.
bool is_update_url(const std::string& url);

// The installer file names a desktop release carries (also what js/updates.js asks for).
inline constexpr const char* kUpdateFileNames[] = {"Binder-windows-setup.exe", "Binder-macos-arm64.dmg",
                                                   "Binder-linux-amd64.deb"};

// `hex` is a SHA-256 digest: exactly 64 hex digits (any case).
bool is_sha256_hex(const std::string& hex);

class Updater {
public:
    struct Hooks {
        std::function<std::unique_ptr<cardfetch::Transport>()> make_transport;
        // Starts the platform's installer for the downloaded file, which must carry on after this process quits.
        // Empty = the platform default (see default_launcher). Returns false with `error` set if it couldn't.
        std::function<bool(const std::filesystem::path& file, std::string& error)> launch;
        // Asked to close the app once the installer has been started.
        std::function<void()> quit;
    };

    struct Status {
        std::string state = "idle";  // idle | downloading | ready | installing | error
        unsigned long long bytes = 0;
        unsigned long long total = 0;  // 0 until the server has said how big the file is
        std::string error;
        std::string version;  // the release being fetched, e.g. "v1.0.8"
    };

    // `dir`: where installers are downloaded to (anything already in it is cleared at the start of a download).
    Updater(std::filesystem::path dir, Hooks hooks);

    // Begins downloading `url` in the background. false with `error` set when the URL isn't an allowed installer,
    // the digest isn't a SHA-256, or a download is already running.
    bool start_download(const std::string& url, const std::string& sha256, std::string& error);

    Status status() const;

    // Runs the installer for a finished (and verified) download, then asks the app to quit. false with `error` set
    // when nothing is ready or the installer couldn't be started.
    bool install(std::string& error);

private:
    struct State;
    std::shared_ptr<State> state_;
};

// Starts the installer the way this platform does it: Windows runs the setup silently; macOS mounts the disk image
// and swaps the app bundle; Linux installs the .deb through polkit/apt. Always fails on Android and iOS.
bool default_launch(const std::filesystem::path& file, std::string& error);

}  // namespace binder
