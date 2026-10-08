// End-to-end API tests: the real routes + real store, over real HTTP, with a
// recording fake recognition engine.
#include <fstream>
#include <thread>

#include <httplib.h>

#include "api.hpp"
#include "cardtest.hpp"

namespace fs = std::filesystem;
using nlohmann::json;

namespace {

class FakeEngine : public cardscan::Engine {
public:
    std::string last_search_game, last_search_query, last_scan_game, last_image;
    double last_min_blur = -1;
    int detect_calls = 0;

    json search(const std::string& game, const std::string& query) override {
        last_search_game = game;
        last_search_query = query;
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
