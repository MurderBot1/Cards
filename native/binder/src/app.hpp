// The assembled backend: store + recognition engine + HTTP server + API routes + logging, built from a set
// of resolved paths. Shared by the desktop executable and the Android JNI library; neither owns a window or
// a UI loop here — that's the caller's business.
#pragma once

#include <functional>
#include <memory>
#include <string>

#include "cardauth/auth.hpp"
#include "cardfetch/fetch.hpp"
#include "cardpaths/cardpaths.hpp"
#include "cardscan/engine.hpp"

namespace binder {

struct AppOptions {
    cardpaths::Paths paths;
    std::function<void(const std::string&)> log;  // status messages (also appended to startup.log); optional
    cardauth::Config auth;                         // where the LoginServer is
    // Fetch the catalog and vector index from the release when they're missing, in the background. Off by default so
    // tests never touch the network. Needs a transport: `make_transport` if set (Android passes one backed by the
    // JVM), else libcurl when the build has it; with neither this does nothing.
    bool download_missing_data = false;
    std::function<std::unique_ptr<cardfetch::Transport>()> make_transport;
};

class App {
public:
    // Creates the user-data directories, copies a bundled catalog on first run, opens/creates db.json and builds
    // the engine and routes. Throws if the data directory is unusable.
    explicit App(AppOptions options);
    ~App();
    App(const App&) = delete;
    App& operator=(const App&) = delete;

    // Bind before serving, so a window can be pointed at the port first. false / -1 if it couldn't be bound.
    bool bind(const std::string& host, int port);
    int bind_any_port(const std::string& host);

    // Blocks serving requests until stop().
    bool serve();
    void stop();
    bool is_running() const;

    // Loads the detector / OCR / embedder / vector index in the background, rather than on whichever scan
    // request happens to need them first. With AppOptions::download_missing_data it first downloads whatever
    // catalog files are missing (the first launch of a build that doesn't bundle them), then loads.
    void warm_up_in_background();

    // For a caller that started with download_missing_data off because it wants the user's say first (Android asks
    // before using mobile data): shows `message` on the setup screen when there are files to download, and
    // download_when_ready() later turns downloading on and runs the warm-up again, which now fetches them.
    void announce_pending_download(const std::string& message);
    void download_when_ready();

    // Called (from a request thread) after an update's installer has been started, when the app should close so it
    // can replace the running copy. Without one the update is installed but the app keeps running.
    void set_quit_handler(std::function<void()> quit);

    cardscan::Engine& engine();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace binder
