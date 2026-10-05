// Binder — Card Tracker. Wires the modules together: cardpaths decides where
// things live, cardstore holds collections/settings, cardscan recognises
// cards, cardhttp serves the API + frontend.
#include <cstdio>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <thread>

#include "app.hpp"
#include "cardlog/cardlog.hpp"
#include "cardpaths/cardpaths.hpp"
#ifdef BINDER_HAVE_VIEW
#include "cardview/view.hpp"
#endif

namespace {

struct Args {
    bool headless = false;
    bool help = false;
    int port = 5000;
    bool port_given = false;  // in window mode, no --port means "any free port"
    cardpaths::Options paths;
};

bool parse_args(int argc, char** argv, Args& a, std::string& error) {
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        auto value = [&](std::string& out) {
            if (i + 1 >= argc) {
                error = arg + " needs a value";
                return false;
            }
            out = argv[++i];
            return true;
        };
        std::string v;
        if (arg == "--headless") a.headless = true;
        else if (arg == "--help" || arg == "-h") a.help = true;
        else if (arg == "--port") {
            if (!value(v)) return false;
            a.port = std::atoi(v.c_str());
            a.port_given = true;
            if (a.port < 1 || a.port > 65535) {
                error = "--port must be 1-65535";
                return false;
            }
        } else if (arg == "--frontend-dir") {
            if (!value(v)) return false;
            a.paths.frontend_dir = v;
        } else if (arg == "--data-dir") {
            if (!value(v)) return false;
            a.paths.user_data_dir = v;
        } else {
            error = "unknown argument: " + arg;
            return false;
        }
    }
    return true;
}

const char* kUsage =
    "Binder — Card Tracker\n"
    "  --headless          serve on 0.0.0.0 (reachable from your LAN) instead of localhost only\n"
    "  --port N            port to listen on (default: 5000 with --headless, otherwise any free port)\n"
    "  --frontend-dir DIR  frontend files (default: found next to the executable or in the repo)\n"
    "  --data-dir DIR      db.json / logs / catalog location (default: per-user app-data directory)\n";

}  // namespace

int main(int argc, char** argv) {
    Args args;
    std::string error;
    if (!parse_args(argc, argv, args, error)) {
        std::cerr << error << "\n" << kUsage;
        return 2;
    }
    if (args.help) {
        std::cout << kUsage;
        return 0;
    }

    auto paths = cardpaths::resolve(cardpaths::system_environment(), args.paths);
    cardpaths::ensure_dirs(paths);

    // A packaged build has no console, so everything worth knowing at startup also goes to startup.log.
    auto print = [](const std::string& message) { std::cout << message << std::endl; };
    auto status = [&](const std::string& message) {
        print(message);
        cardlog::append_line(paths.startup_log, cardlog::timestamp() + " " + message);
    };

    if (!paths.frontend_found) {
        std::string msg = "FATAL: no index.html found. Looked in:";
        for (const auto& c : paths.frontend_candidates) msg += "\n  - " + c.string();
        status(msg);
        return 1;
    }
    cardpaths::ensure_bundled_catalog(paths);

    binder::App app({paths, print, {}});  // the app writes its own messages to startup.log
    app.warm_up_in_background();

    // Window mode (the default) serves on localhost only, on a free port unless one was asked for; --headless
    // serves the whole LAN on a fixed port instead.
    const std::string host = args.headless ? "0.0.0.0" : "127.0.0.1";
    int port = args.port;
    bool bound;
    if (args.headless || args.port_given) {
        bound = app.bind(host, port);
    } else {
        port = app.bind_any_port(host);
        bound = port > 0;
    }
    if (!bound) {
        status("FATAL: could not listen on " + host + ":" + std::to_string(port) + " (port in use?)");
        return 1;
    }
    const std::string url = "http://127.0.0.1:" + std::to_string(port);

    if (args.headless) {
        status("Binder running headless on http://0.0.0.0:" + std::to_string(port) +
               " — other devices on this network can connect using this machine's LAN IP. "
               "This exposes the API to your whole LAN; only do this on networks you trust.");
        app.serve();
        return 0;
    }

#ifdef BINDER_HAVE_VIEW
    std::thread serving([&app] { app.serve(); });
    while (!app.is_running()) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    try {
        cardview::View view({"Card Master", 1200, 800, false});
        view.navigate(url);
        status("Binder running on " + url);
        view.run();  // until the window is closed
        app.stop();
        serving.join();
        return 0;
    } catch (const std::exception& e) {
        // No display / no web view available: keep serving so a browser can still be used.
        status(std::string("Could not open a window (") + e.what() + "). Serving on " + url + " instead.");
        serving.join();
        return 0;
    }
#else
    status("Binder running on " + url + " (built without a window; open it in a browser)");
    app.serve();
    return 0;
#endif
}
