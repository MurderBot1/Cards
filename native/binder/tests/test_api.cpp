// End-to-end API tests: the real routes + real store, over real HTTP, with a
// recording fake recognition engine.
#include <fstream>
#include <thread>

#include <httplib.h>

#include "api.hpp"
#include "open_url.hpp"
#include "sha256.hpp"
#include "updater.hpp"
#include "cardtest.hpp"

namespace fs = std::filesystem;
using nlohmann::json;

namespace {

class FakeEngine : public cardscan::Engine {
public:
    std::string last_search_game, last_search_query, last_scan_game, last_image;
    double last_min_blur = -1;
    int detect_calls = 0;

    int last_search_limit = -1, last_search_offset = -1;

    json search(const std::string& game, const std::string& query, int limit, int offset) override {
        last_search_game = game;
        last_search_query = query;
        last_search_limit = limit;
        last_search_offset = offset;
        return json::array({{{"name", "Lightning Bolt"}, {"game", game}}});
    }
    cardscan::Result detect(const std::string& image) override {
        ++detect_calls;
        last_image = image;
        return {200, {{"bbox", {1, 2, 3, 4}}}};
    }
    cardscan::Result scan(const std::string& image, const std::string& game, double min_blur) override {
        last_image = image;
        last_scan_game = game;
        last_min_blur = min_blur;
        if (image == "blurry") return {400, {{"error", "Image is too blurry"}}};
        return {200, {{"name", "Lightning Bolt"}, {"set", "M10"}}};
    }
};

// Serves one fixed body for any URL, as a file.
class FakeTransport : public cardfetch::Transport {
public:
    explicit FakeTransport(std::string body, long status = 200) : body_(std::move(body)), status_(status) {}
    cardfetch::Response get(const std::string&, int) override { return {status_, body_}; }
    long get_to_file(const std::string&, int, const fs::path& dest) override {
        if (on_download_size) on_download_size(body_.size());
        std::ofstream(dest, std::ios::binary) << body_;
        return status_;
    }

private:
    std::string body_;
    long status_;
};

json parse(const httplib::Result& r) { return r ? json::parse(r->body, nullptr, false) : json(); }

}  // namespace

int main() {
    cardtest::TempDir tmp;
    cardstore::Store store(tmp.path() / "db.json");
    store.ensure_exists();
    FakeEngine engine;
    binder::SetupStatus setup;
    binder::ApiContext ctx{store, engine, {}, fs::path(BINDER_REPO_APP_DIR), &setup};
    ctx.auth.port = 1;  // nothing listens here -> "login server unavailable"
    ctx.auth.timeout_ms = 500;

    cardhttp::Server server;
    binder::register_routes(server, ctx);
    int port = server.bind_any_port("127.0.0.1");
    CHECK(port > 0);
    if (port <= 0) return cardtest::finish("binder_api");
    std::thread t([&] { server.listen_after_bind(); });
    for (int i = 0; i < 200 && !server.is_running(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    httplib::Client cli("127.0.0.1", port);
    const char* kJson = "application/json";

    // ---- the frontend is served from the repo's real app/ directory
    auto page = cli.Get("/");
    CHECK(page && page->status == 200 && page->body.find("<html") != std::string::npos);
    CHECK(cli.Get("/css/styles.css") && cli.Get("/css/styles.css")->status == 200);
    CHECK(cli.Get("/js/app.js") && cli.Get("/js/app.js")->status == 200);
    CHECK(cli.Get("/js/nope.js")->status == 404);

    // ---- first-run setup status: idle, a task with progress, a failure, done
    auto idle = parse(cli.Get("/api/setup"));
    CHECK_EQ(idle["active"], json(false));
    fs::path partial = tmp.path() / "big.part";
    std::ofstream(partial, std::ios::binary) << "12345";
    setup.set_task("Downloading assets", "cards.sqlite3 (1 of 2)", partial);
    auto busy = parse(cli.Get("/api/setup"));
    CHECK_EQ(busy["active"], json(true));
    CHECK_EQ(busy["task"], json("Downloading assets"));
    CHECK_EQ(busy["detail"], json("cards.sqlite3 (1 of 2)"));
    CHECK_EQ(busy["bytes"], json(5));
    CHECK_EQ(busy["total"], json(0));
    setup.set_total(20);
    CHECK_EQ(parse(cli.Get("/api/setup"))["total"], json(20));
    setup.fail("could not download cards.sqlite3");
    auto failed = parse(cli.Get("/api/setup"));
    CHECK_EQ(failed["active"], json(false));
    CHECK_EQ(failed["error"], json("could not download cards.sqlite3"));
    setup.set_task("Downloading assets");
    setup.clear();
    CHECK_EQ(parse(cli.Get("/api/setup"))["active"], json(false));
    CHECK_EQ(parse(cli.Get("/api/setup"))["error"], json(""));

    // ---- collections lifecycle
    CHECK_EQ(parse(cli.Get("/api/collections")), json::array());
    CHECK_EQ(cli.Post("/api/collections", "not json", kJson)->status, 400);
    CHECK_EQ(cli.Post("/api/collections", "[1]", kJson)->status, 400);
    CHECK_EQ(cli.Post("/api/collections", "{\"name\":\"  \"}", kJson)->status, 400);
    auto created = cli.Post("/api/collections", "{\"name\":\"Main Binder\"}", kJson);
    CHECK_EQ(created->status, 201);
    std::string cid = parse(created)["id"].get<std::string>();
    CHECK(!cid.empty());
    CHECK_EQ(cli.Get("/api/collections/" + cid)->status, 200);
    CHECK_EQ(cli.Get("/api/collections/missing")->status, 404);
    CHECK_EQ(cli.Delete("/api/collections/missing")->status, 404);

    // ---- cards: add, stack, bad input, patch, remove
    const std::string card = "{\"name\":\"Lightning Bolt\",\"game\":\"mtg\",\"set\":\"M10\"}";
    CHECK_EQ(cli.Post("/api/collections/" + cid + "/cards", "{\"game\":\"mtg\"}", kJson)->status, 400);
    CHECK_EQ(cli.Post("/api/collections/" + cid + "/cards", "{\"name\":\"x\",\"game\":\"go\"}", kJson)->status, 400);
    CHECK_EQ(cli.Post("/api/collections/missing/cards", card, kJson)->status, 404);
    CHECK_EQ(cli.Post("/api/collections/" + cid + "/cards", card, kJson)->status, 201);
    auto stacked = parse(cli.Post("/api/collections/" + cid + "/cards", card, kJson));
    CHECK_EQ(stacked["cards"].size(), static_cast<size_t>(1));
    CHECK_EQ(stacked["cards"][0]["quantity"], json(2));
    std::string card_id = stacked["cards"][0]["id"].get<std::string>();

    auto patched = cli.Patch("/api/collections/" + cid + "/cards/" + card_id, "{\"quantity\":7,\"condition\":\"Damaged\"}", kJson);
    CHECK_EQ(patched->status, 200);
    CHECK_EQ(parse(patched)["cards"][0]["quantity"], json(7));
    CHECK_EQ(cli.Patch("/api/collections/" + cid + "/cards/" + card_id, "{}", kJson)->status, 400);
    auto removed = parse(cli.Patch("/api/collections/" + cid + "/cards/" + card_id, "{\"quantity\":0}", kJson));
    CHECK_EQ(removed["cards"].size(), static_cast<size_t>(0));

    // ---- sync routes: export this device's state, and apply a merged result back
    auto sync_before = parse(cli.Get("/api/sync/state"));
    CHECK_EQ(sync_before["collections"].size(), static_cast<size_t>(1));
    CHECK_EQ(sync_before["collections"][0]["id"], json(cid));
    CHECK(sync_before["collections"][0]["updated"].is_number());
    CHECK_EQ(cli.Post("/api/sync/apply", "[1]", kJson)->status, 400);
    json remote = {{"id", "remote1"}, {"name", "From another device"}, {"updated", 99}, {"cards", json::array()}};
    auto applied = parse(cli.Post("/api/sync/apply", json{{"collections", json::array({remote})}, {"expect", json::object()}}.dump(), kJson));
    CHECK_EQ(applied["applied"], json::array({"remote1"}));
    CHECK_EQ(cli.Get("/api/collections/remote1")->status, 200);

    // ---- open-url: only this project's release downloads, and nothing is launched in the test
    std::vector<std::string> opened;
    ctx.open_url = [&](const std::string& url) {
        opened.push_back(url);
        return true;
    };
    const std::string asset = "https://github.com/MurderBot1/Cards/releases/download/v1.0.5/Binder-linux.zip";
    CHECK_EQ(cli.Post("/api/open-url", json{{"url", asset}}.dump(), kJson)->status, 200);
    CHECK_EQ(opened.size(), static_cast<size_t>(1));
    CHECK_EQ(opened[0], asset);
    for (const char* bad : {"https://evil.example/releases/", "http://github.com/MurderBot1/Cards/releases/x",
                            "https://github.com/MurderBot1/Cards/releases/x y", "https://github.com/MurderBot1/Cards/releases/`id`",
                            "https://github.com/MurderBot1/Cards/releases/x\" ; ls", "https://github.com/MurderBot1/Cards/issues/1",
                            "https://github.com/MurderBot1/Cards-evil/releases/", "file:///etc/passwd", ""}) {
        CHECK_EQ(cli.Post("/api/open-url", json{{"url", bad}}.dump(), kJson)->status, 400);
    }
    CHECK(binder::is_release_url(asset));
    CHECK(!binder::is_release_url(std::string("https://github.com/MurderBot1/Cards/releases/a\0b", 48)));  // an embedded NUL
    CHECK(!binder::is_release_url("https://github.com/MurderBot1/Cards/releases/a'b"));
    CHECK_EQ(cli.Post("/api/open-url", "{}", kJson)->status, 400);
    CHECK_EQ(cli.Post("/api/open-url", json{{"url", 5}}.dump(), kJson)->status, 400);
    CHECK_EQ(opened.size(), static_cast<size_t>(1));  // none of the bad ones got through

    // ---- SHA-256 and in-app updates
    CHECK_EQ(binder::sha256_hex(""), std::string("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));
    CHECK_EQ(binder::sha256_hex("abc"), std::string("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    CHECK_EQ(binder::sha256_hex(std::string(1000, 'a')),
             std::string("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"));
    {
        std::ofstream(tmp.path() / "hashme.bin", std::ios::binary) << "abc";
        CHECK_EQ(binder::sha256_file_hex(tmp.path() / "hashme.bin"), binder::sha256_hex("abc"));
        CHECK_EQ(binder::sha256_file_hex(tmp.path() / "missing.bin"), std::string());
    }
    const std::string release = "https://github.com/MurderBot1/Cards/releases/download/v1.0.8/";
    for (const char* name : {"Binder-windows-setup.exe", "Binder-macos-arm64.dmg", "Binder-linux-amd64.deb"})
        CHECK(binder::is_update_url(release + name));
    for (const char* bad : {"Binder-windows.zip", "Binder-android-debug.apk", "../x", "Binder-linux-amd64.deb?x=1"})
        CHECK(!binder::is_update_url(release + bad));
    CHECK(!binder::is_update_url("https://github.com/MurderBot1/Cards/releases/download/latest/Binder-linux-amd64.deb"));
    CHECK(!binder::is_update_url("https://github.com/MurderBot1/Cards/releases/download/v1.0/Binder-linux-amd64.deb"));
    CHECK(!binder::is_update_url("https://github.com/MurderBot1/Cards/releases/tag/v1.0.8"));
    CHECK(!binder::is_update_url("https://evil.example/releases/download/v1.0.8/Binder-linux-amd64.deb"));
    CHECK(binder::is_sha256_hex(binder::sha256_hex("x")));
    CHECK(!binder::is_sha256_hex("abc"));

    const std::string installer = "pretend installer bytes";
    const std::string installer_url = release + "Binder-linux-amd64.deb";
    CHECK_EQ(cli.Get("/api/update/status")->status, 501);  // no updater in this context yet
    CHECK_EQ(cli.Post("/api/update/install", "{}", kJson)->status, 501);
    int launched = 0, quit_calls = 0;
    fs::path launched_file;
    binder::Updater::Hooks update_hooks;
    update_hooks.make_transport = [&] { return std::make_unique<FakeTransport>(installer); };
    update_hooks.launch = [&](const fs::path& file, std::string&) {
        ++launched;
        launched_file = file;
        return true;
    };
    update_hooks.quit = [&] { ++quit_calls; };
    binder::Updater updater(tmp.path() / "update", update_hooks);
    ctx.updater = &updater;
    auto wait_for_update = [&](const char* state) {
        json st;
        for (int i = 0; i < 200; ++i) {
            st = parse(cli.Get("/api/update/status"));
            if (st["state"] == json(state)) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(25));
        }
        return st;
    };
    CHECK_EQ(parse(cli.Get("/api/update/status"))["state"], json("idle"));
    CHECK_EQ(cli.Post("/api/update/install", "{}", kJson)->status, 409);  // nothing downloaded yet
    CHECK_EQ(cli.Post("/api/update/download", json{{"url", "https://evil.example/x.exe"}, {"sha256", binder::sha256_hex(installer)}}.dump(), kJson)->status, 400);
    CHECK_EQ(cli.Post("/api/update/download", json{{"url", installer_url}}.dump(), kJson)->status, 400);  // no checksum
    CHECK_EQ(cli.Post("/api/update/download", json{{"url", installer_url}, {"sha256", "nothex"}}.dump(), kJson)->status, 400);
    // a download that doesn't match its checksum is thrown away, never installed
    CHECK_EQ(cli.Post("/api/update/download", json{{"url", installer_url}, {"sha256", binder::sha256_hex("other")}}.dump(), kJson)->status, 202);
    auto bad_update = wait_for_update("error");
    CHECK_EQ(bad_update["state"], json("error"));
    CHECK(bad_update["error"].get<std::string>().find("checksum") != std::string::npos);
    CHECK_EQ(cli.Post("/api/update/install", "{}", kJson)->status, 409);
    CHECK(!fs::exists(tmp.path() / "update" / "Binder-linux-amd64.deb"));
    // a good one downloads, then installs once: the installer is started and the app asked to quit
    CHECK_EQ(cli.Post("/api/update/download", json{{"url", installer_url}, {"sha256", binder::sha256_hex(installer)}}.dump(), kJson)->status, 202);
    auto good_update = wait_for_update("ready");
    CHECK_EQ(good_update["state"], json("ready"));
    CHECK_EQ(good_update["version"], json("v1.0.8"));
    CHECK_EQ(good_update["bytes"], json(installer.size()));
    CHECK_EQ(good_update["total"], json(installer.size()));
    CHECK_EQ(launched, 0);
    CHECK_EQ(cli.Post("/api/update/install", "{}", kJson)->status, 200);
    CHECK_EQ(launched, 1);
    CHECK_EQ(quit_calls, 1);
    CHECK_EQ(launched_file.filename().string(), std::string("Binder-linux-amd64.deb"));
    CHECK_EQ(cli.Post("/api/update/install", "{}", kJson)->status, 409);  // already handed over
    CHECK_EQ(launched, 1);
    ctx.updater = nullptr;

    // ---- settings
    CHECK_EQ(parse(cli.Get("/api/settings"))["theme"], json("dark"));
    auto settings = parse(cli.Put("/api/settings", "{\"theme\":\"light\",\"minImageQuality\":\"high\"}", kJson));
    CHECK_EQ(settings["theme"], json("light"));
    CHECK_EQ(settings["fontSize"], json("medium"));
    CHECK_EQ(cli.Put("/api/settings", "[]", kJson)->status, 400);

    // ---- search goes through the engine (query trimmed, game passed through)
    auto found = parse(cli.Get("/api/search?game=mtg&q=%20bolt%20"));
    CHECK_EQ(found[0]["name"], json("Lightning Bolt"));
    CHECK_EQ(engine.last_search_game, std::string("mtg"));
    CHECK_EQ(engine.last_search_query, std::string("bolt"));
    CHECK_EQ(engine.last_search_limit, 30);  // paging: the defaults...
    CHECK_EQ(engine.last_search_offset, 0);
    cli.Get("/api/search?game=mtg&q=bolt&limit=40&offset=80");
    CHECK_EQ(engine.last_search_limit, 40);
    CHECK_EQ(engine.last_search_offset, 80);
    cli.Get("/api/search?game=mtg&q=bolt&limit=5000&offset=-3");  // ...are clamped, and junk falls back to them
    CHECK_EQ(engine.last_search_limit, 100);
    CHECK_EQ(engine.last_search_offset, 0);
    cli.Get("/api/search?game=mtg&q=bolt&limit=abc&offset=");
    CHECK_EQ(engine.last_search_limit, 30);
    CHECK_EQ(engine.last_search_offset, 0);
    cli.Get("/api/search?game=mtg&q=bolt&limit=0");
    CHECK_EQ(engine.last_search_limit, 1);

    // ---- detect / scan: multipart upload plumbing
    httplib::MultipartFormDataItems no_image = {{"game", "mtg", "", ""}};
    CHECK_EQ(cli.Post("/api/detect", no_image)->status, 400);
    CHECK_EQ(cli.Post("/api/scan", no_image)->status, 400);

    httplib::MultipartFormDataItems frame = {{"image", "JPEGBYTES", "f.jpg", "image/jpeg"}};
    auto det = cli.Post("/api/detect", frame);
    CHECK_EQ(det->status, 200);
    CHECK_EQ(engine.last_image, std::string("JPEGBYTES"));
    CHECK_EQ(parse(det)["bbox"].size(), static_cast<size_t>(4));

    httplib::MultipartFormDataItems scan = {{"image", "JPEGBYTES", "f.jpg", "image/jpeg"}, {"game", "pokemon", "", ""}};
    auto scanned = cli.Post("/api/scan", scan);
    CHECK_EQ(scanned->status, 200);
    CHECK_EQ(parse(scanned)["name"], json("Lightning Bolt"));
    CHECK_EQ(engine.last_scan_game, std::string("pokemon"));
    CHECK_EQ(engine.last_min_blur, 90.0);  // minImageQuality was just set to "high"

    httplib::MultipartFormDataItems bad_game = {{"image", "x", "f.jpg", "image/jpeg"}, {"game", "digimon", "", ""}};
    cli.Post("/api/scan", bad_game);
    CHECK_EQ(engine.last_scan_game, std::string(""));  // unknown game isn't passed as a hint

    cli.Put("/api/settings", "{\"minImageQuality\":\"low\"}", kJson);
    cli.Post("/api/scan", scan);
    CHECK_EQ(engine.last_min_blur, 15.0);

    httplib::MultipartFormDataItems blurry = {{"image", "blurry", "f.jpg", "image/jpeg"}};
    CHECK_EQ(cli.Post("/api/scan", blurry)->status, 400);  // engine's status flows through unchanged
    CHECK_EQ(binder::min_blur_score_for("medium"), 40.0);
    CHECK_EQ(binder::min_blur_score_for("nonsense"), 40.0);

    // ---- auth: validation before the socket, "unavailable" -> 502
    CHECK_EQ(cli.Post("/api/auth/login", "{\"username\":\"\",\"password\":\"x\"}", kJson)->status, 400);
    CHECK_EQ(cli.Post("/api/auth/register", "{\"username\":\"a b\",\"password\":\"x\"}", kJson)->status, 400);
    CHECK_EQ(cli.Post("/api/auth/login", "{\"username\":123,\"password\":\"x\"}", kJson)->status, 400);
    auto down = cli.Post("/api/auth/login", "{\"username\":\"alice\",\"password\":\"pw\"}", kJson);
    CHECK_EQ(down->status, 502);
    CHECK(parse(down)["error"].get<std::string>().rfind("Login server unavailable", 0) == 0);

    // ---- delete
    auto del = cli.Delete("/api/collections/" + cid);
    CHECK_EQ(del->status, 200);
    CHECK_EQ(parse(del)["deleted"], json(true));

    server.stop();
    t.join();
    return cardtest::finish("binder_api");
}
