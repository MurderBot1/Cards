// Binder — Card Tracker. Wires the modules together: cardpaths decides where
// things live, cardstore holds collections/settings, cardscan recognises
// cards, cardhttp serves the API + frontend.
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <thread>

#include "api.hpp"
#include "cardhttp/server.hpp"
#include "cardlog/cardlog.hpp"
#include "cardpaths/cardpaths.hpp"
#ifdef BINDER_HAVE_ONNX
#include "cardonnx/onnx_models.hpp"
#endif
#include "cardscan/model_source.hpp"
#include "cardscan/pipeline_engine.hpp"
#include "cardstore/store.hpp"

namespace {

struct Args {
    bool headless = false;
    bool help = false;
    int port = 5000;
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
    "  --port N            port to listen on (default 5000)\n"
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
    auto status = [&](const std::string& message) {
        std::cout << message << std::endl;
        cardlog::append_line(paths.startup_log, cardlog::timestamp() + " " + message);
    };

    if (!paths.frontend_found) {
        std::string msg = "FATAL: no index.html found. Looked in:";
        for (const auto& c : paths.frontend_candidates) msg += "\n  - " + c.string();
        status(msg);
        return 1;
    }
    cardpaths::ensure_bundled_catalog(paths);

    cardstore::Store store(paths.db_path);
    store.ensure_exists();

    // Recognition reads the catalog and models from the data directory. Models that aren't there yet (or aren't
    // compiled into this build) just skip their pipeline stage. Load them now, in the background, rather than on
    // whichever scan request happens to need them first.
#ifdef BINDER_HAVE_ONNX
    using Models = cardonnx::OnnxModelSource;
#else
    using Models = cardscan::DataDirModelSource;  // built without ONNX Runtime: detector/OCR/embedder unavailable
#endif
    cardscan::PipelineEngine engine(paths.data_dir / cardscan::kCatalogFile, std::make_unique<Models>(paths.data_dir),
                                    [&](const std::string& m) { status("[scanner] " + m); });
    std::thread([&engine] { engine.warm_up(); }).detach();

    cardhttp::Server server;
    cardlog::RotatingLog api_log(paths.log_dir / "api.log");
    server.on_access([&api_log](const cardhttp::AccessLogEntry& e) {
        if (e.path.rfind("/api/", 0) != 0) return;  // only API traffic, not the static frontend
        char duration[32];
        std::snprintf(duration, sizeof(duration), "%.1f", e.duration_ms);
        api_log.write(e.method + " " + e.path + (e.query_string.empty() ? "" : "?" + e.query_string) + " -> " +
                      std::to_string(e.status) + " (" + duration + "ms) from " + e.remote_addr);
    });

    binder::ApiContext ctx{store, engine, {}, paths.frontend_dir};
    binder::register_routes(server, ctx);

    const std::string host = args.headless ? "0.0.0.0" : "127.0.0.1";
    if (args.headless)
        status("Binder running headless on http://0.0.0.0:" + std::to_string(args.port) +
               " — other devices on this network can connect using this machine's LAN IP. "
               "This exposes the API to your whole LAN; only do this on networks you trust.");
    else
        status("Binder running on http://127.0.0.1:" + std::to_string(args.port));

    if (!server.listen(host, args.port)) {
        status("FATAL: could not listen on " + host + ":" + std::to_string(args.port) + " (port in use?)");
        return 1;
    }
    return 0;
}
