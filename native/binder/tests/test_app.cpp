// The assembled backend (binder::App) end to end: real paths, a real catalog, the real routes, over real
// HTTP — everything main() and the Android library share, short of a window.
#include <fstream>
#include <thread>

#include <httplib.h>

#include "app.hpp"
#include "cardcatalog/catalog.hpp"
#include "cardscan/model_source.hpp"
#include "cardtest.hpp"

namespace fs = std::filesystem;
using nlohmann::json;

static std::string slurp(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    return std::string(std::istreambuf_iterator<char>(f), {});
}

static cardpaths::Paths make_paths(const fs::path& user_data) {
    cardpaths::Environment env;
    env.os = "linux";
    env.home = user_data / "home";
    env.cwd = user_data;
    env.getenv = [](const std::string&) { return std::string(); };
    cardpaths::Options o;
    o.user_data_dir = user_data;
    o.frontend_dir = fs::path(BINDER_REPO_APP_DIR);
    return cardpaths::resolve(env, o);
}

int main() {
    cardtest::TempDir tmp;
    const fs::path user_data = tmp.path() / "userdata";

    // a catalog already in the data directory
    {
        cardcatalog::Writer w(user_data / "data" / cardscan::kCatalogFile);
        w.upsert_cards({{"mtg-1", "mtg", "Lightning Bolt", "LEA", "Alpha", "161", "common", "", "http://example/1.jpg"},
                        {"pkm-1", "pokemon", "Charizard", "BS", "Base Set", "4", "rare", "", "http://example/5.jpg"}});
        w.finalize();
    }

    std::vector<std::string> messages;
    {
        binder::AppOptions options;
        options.paths = make_paths(user_data);
        options.log = [&](const std::string& m) { messages.push_back(m); };
        options.auth.port = 1;  // nothing there
        options.auth.timeout_ms = 300;
        binder::App app(std::move(options));

        // constructing the app creates what the user would otherwise have to
        CHECK(fs::exists(user_data / "db.json"));
        CHECK(fs::is_directory(user_data / "logs"));

        int port = app.bind_any_port("127.0.0.1");
        CHECK(port > 0);
        std::thread serving([&] { app.serve(); });
        for (int i = 0; i < 200 && !app.is_running(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(10));
        CHECK(app.is_running());
        httplib::Client cli("127.0.0.1", port);

        // the frontend and the API are both served
        auto page = cli.Get("/");
        CHECK(page && page->status == 200 && page->body.find("<html") != std::string::npos);
        auto created = cli.Post("/api/collections", "{\"name\":\"Main\"}", "application/json");
        CHECK(created && created->status == 201);
        auto listed = cli.Get("/api/collections");
        CHECK(listed && json::parse(listed->body).size() == 1);

        // search goes through the real recognition engine over the catalog
        auto found = cli.Get("/api/search?game=mtg&q=bolt");
        CHECK(found && found->status == 200);
        if (found) {
            json rows = json::parse(found->body);
            CHECK_EQ(rows.size(), static_cast<size_t>(1));
            CHECK(rows.size() == 1 && rows[0]["name"] == "Lightning Bolt" && rows[0]["set"] == "LEA");
        }

        // scanning with no usable image reports it, instead of anything crashing
        httplib::MultipartFormDataItems junk = {{"image", "not an image", "x.jpg", "image/jpeg"}};
        auto scan = cli.Post("/api/scan", junk);
        CHECK(scan && scan->status == 400);
        CHECK(scan && json::parse(scan->body)["error"] == "Could not read that image");
        CHECK(cli.Post("/api/auth/login", "{\"username\":\"a\",\"password\":\"b\"}", "application/json")->status == 502);

        // warming up in the background is harmless (and safe to drop the app right after)
        app.warm_up_in_background();

        app.stop();
        serving.join();
        CHECK(!app.is_running());
    }

    // API traffic is logged (one line per request); static files are not
    std::string api_log = slurp(user_data / "logs" / "api.log");
    CHECK(api_log.find("POST /api/collections -> 201") != std::string::npos);
    CHECK(api_log.find("GET /api/search?game=mtg&q=bolt -> 200") != std::string::npos);
    CHECK(api_log.find("GET / ") == std::string::npos && api_log.find("styles.css") == std::string::npos);

    // collections persisted across the app's lifetime
    {
        binder::AppOptions options;
        options.paths = make_paths(user_data);
        binder::App again(std::move(options));
        int port = again.bind_any_port("127.0.0.1");
        std::thread serving([&] { again.serve(); });
        for (int i = 0; i < 200 && !again.is_running(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(10));
        httplib::Client cli("127.0.0.1", port);
        auto listed = cli.Get("/api/collections");
        CHECK(listed && json::parse(listed->body).size() == 1);
        again.stop();
        serving.join();
    }

    // a bound-but-never-served app releases its port when destroyed
    int leaked_port;
    {
        binder::AppOptions options;
        options.paths = make_paths(user_data);
        binder::App unused(std::move(options));
        leaked_port = unused.bind_any_port("127.0.0.1");
        CHECK(leaked_port > 0);
    }
    {
        binder::AppOptions options;
        options.paths = make_paths(user_data);
        binder::App next(std::move(options));
        CHECK(next.bind("127.0.0.1", leaked_port));
    }

    // an app whose catalog doesn't exist yet still starts: search is empty, scan says the catalog isn't built
    {
        fs::path fresh = tmp.path() / "fresh";
        binder::AppOptions options;
        options.paths = make_paths(fresh);
        binder::App empty(std::move(options));
        CHECK_EQ(empty.engine().search("mtg", "bolt"), json::array());
        auto r = empty.engine().scan("", "", 0);
        CHECK_EQ(r.status, 400);  // not an image at all
    }

    return cardtest::finish("binder app");
}
