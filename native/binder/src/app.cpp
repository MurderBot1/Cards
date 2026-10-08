#include "app.hpp"

#include <cstdio>
#include <filesystem>
#include <thread>

#include "api.hpp"
#include "cardhttp/server.hpp"
#include "cardlog/cardlog.hpp"
#include "cardscan/model_source.hpp"
#include "cardscan/pipeline_engine.hpp"
#include "cardstore/store.hpp"
#include "carddownload/download.hpp"
#ifdef BINDER_HAVE_CURL_TRANSPORT
#include "cardfetch/curl_transport.hpp"
#endif
#ifdef BINDER_HAVE_ONNX
#include "cardonnx/onnx_models.hpp"
#endif

namespace fs = std::filesystem;

namespace binder {

struct App::Impl {
    AppOptions options;
    cardstore::Store store;
    std::shared_ptr<cardscan::PipelineEngine> engine;  // shared: the background warm-up thread outlives a quick App
    std::shared_ptr<SetupStatus> setup = std::make_shared<SetupStatus>();  // shared with the download thread
    cardlog::RotatingLog api_log;
    cardhttp::Server server;
    ApiContext ctx;

    explicit Impl(AppOptions o)
        : options(std::move(o)),
          store(options.paths.db_path),
          engine(make_engine(options)),
          api_log(options.paths.log_dir / "api.log"),
          ctx{store, *engine, options.auth, options.paths.frontend_dir, setup.get()} {}

    static void say(const AppOptions& o, const std::string& message) {
        if (o.log) o.log(message);
        cardlog::append_line(o.paths.startup_log, cardlog::timestamp() + " " + message);
    }

    static std::shared_ptr<cardscan::PipelineEngine> make_engine(const AppOptions& o) {
        // Recognition reads the catalog and models from the data directory. Models that aren't there yet (or
        // aren't compiled into this build) just skip their pipeline stage.
#ifdef BINDER_HAVE_ONNX
        using Models = cardonnx::OnnxModelSource;
#else
        using Models = cardscan::DataDirModelSource;  // built without ONNX Runtime: detector/OCR/embedder unavailable
#endif
        return std::make_shared<cardscan::PipelineEngine>(o.paths.data_dir / cardscan::kCatalogFile,
                                                          std::make_unique<Models>(o.paths.data_dir),
                                                          [o](const std::string& m) { say(o, "[scanner] " + m); });
    }
};

App::App(AppOptions options) {
    cardpaths::ensure_dirs(options.paths);
    cardpaths::ensure_bundled_catalog(options.paths);
    impl_ = std::make_unique<Impl>(std::move(options));
    impl_->store.ensure_exists();

    impl_->server.on_access([this](const cardhttp::AccessLogEntry& e) {
        if (e.path.rfind("/api/", 0) != 0) return;  // only API traffic, not the static frontend
        char duration[32];
        std::snprintf(duration, sizeof(duration), "%.1f", e.duration_ms);
        impl_->api_log.write(e.method + " " + e.path + (e.query_string.empty() ? "" : "?" + e.query_string) + " -> " +
                             std::to_string(e.status) + " (" + duration + "ms) from " + e.remote_addr);
    });
    register_routes(impl_->server, impl_->ctx);
}

App::~App() = default;

bool App::bind(const std::string& host, int port) { return impl_->server.bind(host, port); }
int App::bind_any_port(const std::string& host) { return impl_->server.bind_any_port(host); }
bool App::serve() { return impl_->server.listen_after_bind(); }
void App::stop() { impl_->server.stop(); }
bool App::is_running() const { return impl_->server.is_running(); }

void App::warm_up_in_background() {
    auto engine = impl_->engine;
    auto make_transport = impl_->options.make_transport;
#ifdef BINDER_HAVE_CURL_TRANSPORT
    if (!make_transport) make_transport = [] { return std::make_unique<cardfetch::CurlTransport>(); };
#endif
    if (impl_->options.download_missing_data && make_transport) {
        // Detached like the warm-up: the window and API come up straight away, and scans answer "no catalog" until
        // the files land. Everything it uses is captured by value, so it may outlive the App.
        auto options = impl_->options;
        auto setup = impl_->setup;
        const auto data_dir = options.paths.data_dir;
        carddownload::Options download;
        const bool needed = !carddownload::missing_files(data_dir, download).empty();
        // Marked before the thread starts, so the very first /api/setup poll already sees it.
        if (needed) setup->set_task("Downloading assets");
        download.on_file = [setup, data_dir](const std::string& name, size_t number, size_t total) {
            fs::path part = data_dir / fs::u8path(name);
            part += ".part";
            setup->set_task("Downloading assets", name + " (" + std::to_string(number) + " of " + std::to_string(total) + ")", part);
        };
        download.on_size = [setup](unsigned long long bytes) { setup->set_total(bytes); };
        std::thread([engine, options, setup, data_dir, download, needed, make_transport] {
            if (needed) {
                carddownload::Result result;
                try {
                    auto transport = make_transport();
                    result = carddownload::download_missing(
                        *transport, data_dir, download, [&](const std::string& m) { Impl::say(options, "[catalog] " + m); });
                } catch (const std::exception& e) {  // no transport to download with
                    result.ok = false;
                    result.error = std::string("could not start the download (") + e.what() + ")";
                }
                if (!result.downloaded.empty()) engine->reload_data();
                if (result.ok) setup->clear();
                else setup->fail(result.error);
            }
            engine->warm_up();
        }).detach();
        return;
    }
    std::thread([engine] { engine->warm_up(); }).detach();
}

void App::announce_pending_download(const std::string& message) {
    if (!carddownload::missing_files(impl_->options.paths.data_dir).empty()) impl_->setup->set_task(message);
}

void App::download_when_ready() {
    impl_->options.download_missing_data = true;
    warm_up_in_background();
}

cardscan::Engine& App::engine() { return *impl_->engine; }

}  // namespace binder
