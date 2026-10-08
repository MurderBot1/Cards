#include "api.hpp"

#include "open_url.hpp"

#include <nlohmann/json.hpp>

namespace binder {

using cardhttp::Request;
using cardhttp::Response;
using nlohmann::json;

namespace {

template <class R>
Response respond(const R& r) {
    return Response::json(r.status, r.body.dump());
}

Response error(int status, const std::string& message) { return Response::json(status, json{{"error", message}}.dump()); }

// Request body as a JSON object, or a 400 explaining why not.
bool parse_object(const Request& req, json& out, Response& failure) {
    out = json::parse(req.body, nullptr, /*allow_exceptions=*/false);
    if (out.is_discarded() || !out.is_object()) {
        failure = error(400, "request body must be a JSON object");
        return false;
    }
    return true;
}

std::string form_value(const Request& req, const char* key) {
    auto it = req.form.find(key);
    return it == req.form.end() ? "" : it->second;
}

bool valid_game(const std::string& g) { return g == "mtg" || g == "pokemon" || g == "yugioh"; }

}  // namespace

double min_blur_score_for(const std::string& q) {
    if (q == "low") return 15;
    if (q == "high") return 90;
    return 40;
}

void register_routes(cardhttp::Server& server, ApiContext& ctx) {
    auto& store = ctx.store;
    auto& engine = ctx.engine;

    // ---- auth: bridge to the LoginServer ---------------------------------
    auto auth_route = [&ctx](const char* command, int ok_status, int rejected_status) {
        return [&ctx, command, ok_status, rejected_status](const Request& req) {
            json body;
            Response failure;
            if (!parse_object(req, body, failure)) return failure;
            std::string username = body.value("username", json("")).is_string() ? body.value("username", "") : "";
            std::string password = body.value("password", json("")).is_string() ? body.value("password", "") : "";
            if (auto problem = cardauth::validate_credentials(username, password)) return error(400, *problem);

            auto reply = cardauth::send_command(ctx.auth, command, username, password);
            if (!reply.ok) return error(reply.unavailable ? 502 : rejected_status, reply.message);
            return Response::json(ok_status, json{{"username", username}}.dump());
        };
    };
    server.route("POST", "/api/auth/register", auth_route("REGISTER", 201, 409));
    server.route("POST", "/api/auth/login", auth_route("LOGIN", 200, 401));

    // ---- first-run setup progress (the frontend polls this to show its "setting up" screen) ----------
    server.route("GET", "/api/setup", [&ctx](const Request&) {
        SetupStatus::Snapshot s = ctx.setup ? ctx.setup->snapshot() : SetupStatus::Snapshot{};
        return Response::json(200, json{{"active", s.active}, {"task", s.task}, {"detail", s.detail},
                                        {"bytes", s.bytes}, {"total", s.total}, {"error", s.error}}.dump());
    });

    // ---- collections -------------------------------------------------------
    server.route("GET", "/api/collections", [&](const Request&) { return respond(store.list_collections()); });
    server.route("POST", "/api/collections", [&](const Request& req) {
        json body;
        Response failure;
        if (!parse_object(req, body, failure)) return failure;
        return respond(store.create_collection(body));
    });
    server.route("GET", "/api/collections/<id>", [&](const Request& req) { return respond(store.get_collection(req.params.at("id"))); });
    server.route("DELETE", "/api/collections/<id>", [&](const Request& req) { return respond(store.delete_collection(req.params.at("id"))); });

    // ---- cards within a collection -----------------------------------------
    server.route("POST", "/api/collections/<id>/cards", [&](const Request& req) {
        json body;
        Response failure;
        if (!parse_object(req, body, failure)) return failure;
        return respond(store.add_card(req.params.at("id"), body));
    });
    server.route("PATCH", "/api/collections/<id>/cards/<card_id>", [&](const Request& req) {
        json body;
        Response failure;
        if (!parse_object(req, body, failure)) return failure;
        return respond(store.update_card(req.params.at("id"), req.params.at("card_id"), body));
    });

    // ---- sync: the frontend's sync.js exports this device's collections, sends them to the account service, and
    // writes back what that returned (see cardstore::Store::sync_state / sync_apply) -------------------------------
    server.route("GET", "/api/sync/state", [&](const Request&) { return respond(store.sync_state()); });
    server.route("POST", "/api/sync/apply", [&](const Request& req) {
        json body;
        Response failure;
        if (!parse_object(req, body, failure)) return failure;
        return respond(store.sync_apply(body));
    });

    // ---- the update banner's "Update" button: open this project's release download in the system browser ----------
    server.route("POST", "/api/open-url", [&ctx](const Request& req) {
        json body;
        Response failure;
        if (!parse_object(req, body, failure)) return failure;
        std::string url = body.contains("url") && body["url"].is_string() ? body["url"].get<std::string>() : "";
        if (!is_release_url(url)) return error(400, "only this project's release downloads can be opened");
        bool opened = ctx.open_url ? ctx.open_url(url) : open_release_url(url);
        return opened ? Response::json(200, json{{"opened", true}}.dump()) : error(501, "couldn't open the browser");
    });

    // ---- in-app updates (desktop): download the installer (checked against the release's SHA-256), then run it.
    // GET /api/update/status -> { state, bytes, total, error, version }; POST /api/update/download { url, sha256 };
    // POST /api/update/install (the app then quits and the installer starts the new version). ---------------------
    server.route("GET", "/api/update/status", [&ctx](const Request&) {
        if (!ctx.updater) return error(501, "this build can't install updates itself");
        auto s = ctx.updater->status();
        return Response::json(200, json{{"state", s.state}, {"bytes", s.bytes}, {"total", s.total}, {"error", s.error},
                                        {"version", s.version}}.dump());
    });
    server.route("POST", "/api/update/download", [&ctx](const Request& req) {
        if (!ctx.updater) return error(501, "this build can't install updates itself");
        json body;
        Response failure;
        if (!parse_object(req, body, failure)) return failure;
        std::string url = body.contains("url") && body["url"].is_string() ? body["url"].get<std::string>() : "";
        std::string sha = body.contains("sha256") && body["sha256"].is_string() ? body["sha256"].get<std::string>() : "";
        std::string problem;
        if (!ctx.updater->start_download(url, sha, problem)) return error(400, problem);
        return Response::json(202, json{{"started", true}}.dump());
    });
    server.route("POST", "/api/update/install", [&ctx](const Request&) {
        if (!ctx.updater) return error(501, "this build can't install updates itself");
        std::string problem;
        if (!ctx.updater->install(problem)) return error(409, problem);
        return Response::json(200, json{{"installing", true}}.dump());
    });

    // ---- settings ----------------------------------------------------------
    server.route("GET", "/api/settings", [&](const Request&) { return respond(store.get_settings()); });
    server.route("PUT", "/api/settings", [&](const Request& req) {
        json body;
        Response failure;
        if (!parse_object(req, body, failure)) return failure;
        return respond(store.update_settings(body));
    });

    // ---- recognition -------------------------------------------------------
    server.route("GET", "/api/search", [&](const Request& req) {
        auto get = [&](const char* k) {
            auto it = req.query.find(k);
            return it == req.query.end() ? std::string() : it->second;
        };
        std::string q = get("q");
        auto b = q.find_first_not_of(" \t\r\n"), e = q.find_last_not_of(" \t\r\n");
        q = b == std::string::npos ? "" : q.substr(b, e - b + 1);
        return Response::json(200, engine.search(get("game"), q).dump());
    });

    // Detection only: cheap enough for the scan modal's live-preview loop.
    server.route("POST", "/api/detect", [&](const Request& req) {
        auto f = req.files.find("image");
        if (f == req.files.end()) return error(400, "image is required");
        return respond(engine.detect(f->second.data));
    });

    server.route("POST", "/api/scan", [&](const Request& req) {
        auto f = req.files.find("image");
        if (f == req.files.end()) return error(400, "image is required");
        std::string game = form_value(req, "game");  // the game selected in the UI; only a hint
        double min_blur = min_blur_score_for(store.min_image_quality());
        return respond(engine.scan(f->second.data, valid_game(game) ? game : "", min_blur));
    });

    // ---- frontend ----------------------------------------------------------
    server.serve_file("/", ctx.frontend_dir / "index.html");
    server.serve_directory("/css", ctx.frontend_dir / "css");
    server.serve_directory("/js", ctx.frontend_dir / "js");
}

}  // namespace binder
