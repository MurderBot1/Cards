#include <atomic>
#include <fstream>
#include <thread>
#include <vector>

#include <httplib.h>

#include "cardhttp/server.hpp"
#include "cardtest.hpp"

namespace fs = std::filesystem;
using cardhttp::Request;
using cardhttp::Response;

static void write(const fs::path& p, const std::string& s) {
    fs::create_directories(p.parent_path());
    std::ofstream(p, std::ios::binary) << s;
}

int main() {
    cardtest::TempDir tmp;
    write(tmp.path() / "site" / "index.html", "<h1>home</h1>");
    write(tmp.path() / "site" / "css" / "a.css", "body{}");
    write(tmp.path() / "site" / "js" / "a.js", "var a;");
    write(tmp.path() / "secret.txt", "top secret");

    cardhttp::Server server;
    std::vector<cardhttp::AccessLogEntry> log;
    std::mutex log_mu;
    server.on_access([&](const cardhttp::AccessLogEntry& e) {
        std::lock_guard<std::mutex> l(log_mu);
        log.push_back(e);
    });

    server.route("GET", "/api/hello", [](const Request& r) {
        auto it = r.query.find("name");
        return Response::json(200, "{\"hello\":\"" + (it == r.query.end() ? std::string("world") : it->second) + "\"}");
    });
    server.route("GET", "/api/collections/<id>/cards/<card_id>", [](const Request& r) {
        return Response::json(200, "{\"id\":\"" + r.params.at("id") + "\",\"card\":\"" + r.params.at("card_id") + "\"}");
    });
    server.route("POST", "/api/echo", [](const Request& r) { return Response::json(201, r.body); });
    server.route("PATCH", "/api/patch/<x>", [](const Request& r) { return Response::json(200, r.method + ":" + r.params.at("x")); });
    server.route("PUT", "/api/put", [](const Request& r) { return Response::json(200, r.method); });
    server.route("DELETE", "/api/del/<x>", [](const Request& r) { return Response::json(200, r.method + ":" + r.params.at("x")); });
    server.route("POST", "/api/upload", [](const Request& r) {
        auto f = r.files.find("image");
        if (f == r.files.end()) return Response::json(400, "{\"error\":\"image is required\"}");
        auto g = r.form.find("game");
        return Response::json(200, f->second.filename + "|" + f->second.content_type + "|" +
                                       std::to_string(f->second.data.size()) + "|" + (g == r.form.end() ? "" : g->second));
    });
    server.route("GET", "/api/boom", [](const Request&) -> Response { throw std::runtime_error("kaboom \"quoted\""); });
    server.serve_file("/", tmp.path() / "site" / "index.html");
    server.serve_directory("/css", tmp.path() / "site" / "css");
    server.serve_directory("/js", tmp.path() / "site" / "js");

    int port = server.bind_any_port("127.0.0.1");
    CHECK(port > 0);
    if (port <= 0) return cardtest::finish("cardhttp");
    std::thread t([&] { server.listen_after_bind(); });
    for (int i = 0; i < 200 && !server.is_running(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    CHECK(server.is_running());

    httplib::Client cli("127.0.0.1", port);

    // ---- JSON routes, query strings, path params
    auto r = cli.Get("/api/hello");
    CHECK(r);
    if (r) {
        CHECK_EQ(r->status, 200);
        CHECK_EQ(r->body, std::string("{\"hello\":\"world\"}"));
        CHECK(r->get_header_value("Content-Type").find("application/json") != std::string::npos);
    }
    r = cli.Get("/api/hello?name=Ada");
    CHECK(r && r->body == "{\"hello\":\"Ada\"}");
    r = cli.Get("/api/collections/abc123/cards/def456");
    CHECK(r && r->body == "{\"id\":\"abc123\",\"card\":\"def456\"}");
    r = cli.Get("/api/collections/abc123/cards/");  // missing segment -> no route
    CHECK(r && r->status == 404);

    // ---- every method + request body
    r = cli.Post("/api/echo", "{\"a\":1}", "application/json");
    CHECK(r && r->status == 201 && r->body == "{\"a\":1}");
    r = cli.Patch("/api/patch/q7", "{}", "application/json");
    CHECK(r && r->body == "PATCH:q7");
    r = cli.Put("/api/put", "{}", "application/json");
    CHECK(r && r->body == "PUT");
    r = cli.Delete("/api/del/z9");
    CHECK(r && r->body == "DELETE:z9");

    // ---- multipart upload (binary-safe) + form fields
    std::string blob("\x89PNG\0\1\2\xff", 8);
    httplib::MultipartFormDataItems items = {
        {"image", blob, "card.png", "image/png"},
        {"game", "mtg", "", ""},
    };
    r = cli.Post("/api/upload", items);
    CHECK(r && r->status == 200);
    if (r) CHECK_EQ(r->body, std::string("card.png|image/png|8|mtg"));
    httplib::MultipartFormDataItems no_file = {{"game", "mtg", "", ""}};
    r = cli.Post("/api/upload", no_file);
    CHECK(r && r->status == 400);

    // ---- handler exceptions become a JSON 500 instead of killing the server
    r = cli.Get("/api/boom");
    CHECK(r && r->status == 500);
    if (r) {
        CHECK(r->body.find("kaboom \\\"quoted\\\"") != std::string::npos);
        CHECK(r->get_header_value("Content-Type").find("application/json") != std::string::npos);
    }
    r = cli.Get("/api/hello");  // still alive
    CHECK(r && r->status == 200);

    // ---- static files: index, css, js, MIME types, 404s, traversal
    r = cli.Get("/");
    CHECK(r && r->status == 200 && r->body == "<h1>home</h1>");
    if (r) CHECK(r->get_header_value("Content-Type").find("text/html") != std::string::npos);
    r = cli.Get("/css/a.css");
    CHECK(r && r->status == 200 && r->body == "body{}");
    if (r) CHECK(r->get_header_value("Content-Type").find("text/css") != std::string::npos);
    r = cli.Get("/js/a.js");
    CHECK(r && r->status == 200);
    if (r) CHECK(r->get_header_value("Content-Type").find("javascript") != std::string::npos);
    r = cli.Get("/js/missing.js");
    CHECK(r && r->status == 404);
    // path traversal: raw and percent-encoded, must never reach ../secret.txt
    for (const char* evil : {"/css/../../secret.txt", "/css/%2e%2e/%2e%2e/secret.txt", "/css/..%2f..%2fsecret.txt"}) {
        httplib::Headers h;
        auto e = cli.Get(evil);
        CHECK(e);
        if (e) {
            CHECK(e->status != 200);
            CHECK(e->body.find("top secret") == std::string::npos);
        }
    }

    // ---- access log: method, path, query, status, caller, duration
    {
        std::lock_guard<std::mutex> l(log_mu);
        bool saw_query = false, saw_404 = false, saw_500 = false;
        for (auto& e : log) {
            if (e.path == "/api/hello" && e.query_string == "name=Ada" && e.status == 200 && e.method == "GET") {
                saw_query = true;
                CHECK(e.duration_ms >= 0);
                CHECK_EQ(e.remote_addr, std::string("127.0.0.1"));
            }
            if (e.path == "/js/missing.js" && e.status == 404) saw_404 = true;
            if (e.path == "/api/boom" && e.status == 500) saw_500 = true;
        }
        CHECK(saw_query);
        CHECK(saw_404);
        CHECK(saw_500);
    }

    // ---- stop() ends listen()
    server.stop();
    t.join();
    CHECK(!server.is_running());

    // ---- binding a port that's taken fails cleanly
    cardhttp::Server a, b;
    int p = a.bind_any_port("127.0.0.1");
    CHECK(p > 0);
    std::thread ta([&] { a.listen_after_bind(); });
    for (int i = 0; i < 200 && !a.is_running(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    CHECK(!b.listen("127.0.0.1", p));
    CHECK(!b.bind("127.0.0.1", p));  // the two-step form reports it too
    a.stop();
    ta.join();

    // bind() to a specific port, then serve on it
    int free_port;
    {
        cardhttp::Server probe;
        free_port = probe.bind_any_port("127.0.0.1");
    }  // released again
    cardhttp::Server c;
    c.route("GET", "/x", [](const Request&) { return Response::json(200, "{\"x\":1}"); });
    CHECK(free_port > 0);
    CHECK(c.bind("127.0.0.1", free_port));
    std::thread tc([&] { c.listen_after_bind(); });
    for (int i = 0; i < 200 && !c.is_running(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    httplib::Client cc("127.0.0.1", free_port);
    auto rc = cc.Get("/x");
    CHECK(rc && rc->status == 200 && rc->body == "{\"x\":1}");
    c.stop();
    tc.join();

    return cardtest::finish("cardhttp");
}
