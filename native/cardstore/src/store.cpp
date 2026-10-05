#include "cardstore/store.hpp"

#include <fstream>
#include <random>
#include <sstream>
#include <stdexcept>

namespace fs = std::filesystem;
using nlohmann::json;

namespace cardstore {

const char* const kDefaultCondition = "Near Mint";

namespace {

// Same message text the Python backend produced, since the frontend shows it.
constexpr const char* kValidConditionsRepr =
    "('Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged')";
constexpr const char* kValidGamesRepr = "('mtg', 'pokemon', 'yugioh')";

bool valid_condition(const std::string& c) {
    return c == "Near Mint" || c == "Lightly Played" || c == "Moderately Played" || c == "Heavily Played" ||
           c == "Damaged";
}
bool valid_game(const json& g) {
    return g.is_string() && (g == "mtg" || g == "pokemon" || g == "yugioh");
}

json default_settings() {
    return {{"theme", "dark"}, {"fontSize", "medium"}, {"requestRate", "medium"}, {"minImageQuality", "medium"}};
}
json empty_db() { return {{"collections", json::array()}, {"settings", default_settings()}}; }

Result error(int status, const std::string& message) { return {status, json{{"error", message}}}; }

// Python truthiness of a request field: missing/null/""/0/[]/{} are all "not provided".
bool truthy(const json& v) {
    if (v.is_null()) return false;
    if (v.is_boolean()) return v.get<bool>();
    if (v.is_number()) return v.get<double>() != 0;
    if (v.is_string()) return !v.get<std::string>().empty();
    return !v.empty();
}

json field(const json& body, const char* key) {
    auto it = body.find(key);
    return it == body.end() ? json() : *it;
}

json* find_collection(json& db, const std::string& id) {
    for (auto& c : db["collections"])
        if (c.value("id", "") == id) return &c;
    return nullptr;
}

std::string random_id() {
    static std::mutex m;
    static std::mt19937_64 gen{std::random_device{}()};
    std::lock_guard<std::mutex> lock(m);
    static const char* hex = "0123456789abcdef";
    std::string id;
    for (int i = 0; i < 8; ++i) id += hex[gen() & 0xF];
    return id;
}

}  // namespace

Store::Store(fs::path db_path, std::function<std::string()> make_id)
    : db_path_(std::move(db_path)), make_id_(make_id ? std::move(make_id) : random_id) {}

json Store::load_locked() {
    if (!fs::exists(db_path_)) return empty_db();
    std::ifstream f(db_path_, std::ios::binary);
    json db = json::parse(f, nullptr, /*allow_exceptions=*/false);
    if (db.is_discarded() || !db.is_object())
        throw std::runtime_error("db.json is not valid JSON: " + db_path_.string());
    if (!db.contains("collections") || !db["collections"].is_array()) db["collections"] = json::array();
    if (!db.contains("settings") || !db["settings"].is_object()) db["settings"] = default_settings();
    return db;
}

void Store::save_locked(const json& db) {
    if (db_path_.has_parent_path()) fs::create_directories(db_path_.parent_path());
    // Write-then-rename so a crash mid-write can't leave a truncated db.json.
    fs::path tmp = db_path_;
    tmp += ".tmp";
    {
        std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
        f << db.dump(2);
        if (!f) throw std::runtime_error("could not write " + tmp.string());
    }
    fs::rename(tmp, db_path_);
}

void Store::ensure_exists() {
    std::lock_guard<std::mutex> lock(mu_);
    if (!fs::exists(db_path_)) save_locked(empty_db());
}

Result Store::list_collections() {
    std::lock_guard<std::mutex> lock(mu_);
    return {200, load_locked()["collections"]};
}

Result Store::create_collection(const json& body) {
    json name_v = field(body, "name");
    std::string name = name_v.is_string() ? name_v.get<std::string>() : "";
    auto b = name.find_first_not_of(" \t\r\n"), e = name.find_last_not_of(" \t\r\n");
    name = b == std::string::npos ? "" : name.substr(b, e - b + 1);
    if (name.empty()) return error(400, "name is required");

    std::lock_guard<std::mutex> lock(mu_);
    json db = load_locked();
    json collection = {{"id", make_id_()}, {"name", name}, {"cards", json::array()}};
    db["collections"].push_back(collection);
    save_locked(db);
    return {201, collection};
}

Result Store::get_collection(const std::string& id) {
    std::lock_guard<std::mutex> lock(mu_);
    json db = load_locked();
    json* c = find_collection(db, id);
    if (!c) return error(404, "not found");
    return {200, *c};
}

Result Store::delete_collection(const std::string& id) {
    std::lock_guard<std::mutex> lock(mu_);
    json db = load_locked();
    json kept = json::array();
    for (auto& c : db["collections"])
        if (c.value("id", "") != id) kept.push_back(c);
    if (kept.size() == db["collections"].size()) return error(404, "not found");
    db["collections"] = kept;
    save_locked(db);
    return {200, json{{"deleted", true}}};
}

Result Store::add_card(const std::string& collection_id, const json& body) {
    json name = field(body, "name");
    json game = field(body, "game");
    if (!truthy(name)) return error(400, "card name is required");
    if (!valid_game(game)) return error(400, std::string("game must be one of ") + kValidGamesRepr);

    std::lock_guard<std::mutex> lock(mu_);
    json db = load_locked();
    json* collection = find_collection(db, collection_id);
    if (!collection) return error(404, "not found");

    json condition_v = field(body, "condition");
    std::string condition = truthy(condition_v) && condition_v.is_string() ? condition_v.get<std::string>()
                                                                          : (truthy(condition_v) ? "" : kDefaultCondition);
    if (!valid_condition(condition)) return error(400, std::string("condition must be one of ") + kValidConditionsRepr);

    // Cards only auto-stack (quantity++) when name/set/game AND condition all
    // match: a Near Mint copy and a Heavily Played copy of the same print are
    // separate rows. (A request with no "set" never stacks — stored cards
    // always carry one, "" by default, and null != "" — same as before.)
    json set_v = field(body, "set");
    json* existing = nullptr;
    for (auto& c : (*collection)["cards"]) {
        if (c.value("name", json()) == name && c.value("set", json()) == set_v && c.value("game", json()) == game &&
            c.value("condition", json(kDefaultCondition)) == condition) {
            existing = &c;
            break;
        }
    }
    if (existing) {
        json& q = (*existing)["quantity"];
        q = q.is_number_integer() ? json(q.get<long long>() + 1) : json(q.get<double>() + 1);
    } else {
        auto str_or_empty = [&](const char* key) { return body.contains(key) ? body[key] : json(""); };
        (*collection)["cards"].push_back({{"id", make_id_()},
                                          {"name", name},
                                          {"game", game},
                                          {"set", str_or_empty("set")},
                                          {"rarity", str_or_empty("rarity")},
                                          {"image", str_or_empty("image")},
                                          {"condition", condition},
                                          {"quantity", 1}});
    }
    save_locked(db);
    return {201, *collection};
}

Result Store::update_card(const std::string& collection_id, const std::string& card_id, const json& body) {
    json quantity = field(body, "quantity");
    json condition = field(body, "condition");
    if (quantity.is_null() && condition.is_null()) return error(400, "quantity and/or condition is required");
    if (!quantity.is_null() && !quantity.is_number()) return error(400, "quantity must be a number");
    if (!condition.is_null() && !(condition.is_string() && valid_condition(condition.get<std::string>())))
        return error(400, std::string("condition must be one of ") + kValidConditionsRepr);

    std::lock_guard<std::mutex> lock(mu_);
    json db = load_locked();
    json* collection = find_collection(db, collection_id);
    if (!collection) return error(404, "not found");

    if (!quantity.is_null() && quantity.get<double>() <= 0) {
        json kept = json::array();
        for (auto& c : (*collection)["cards"])
            if (c.value("id", "") != card_id) kept.push_back(c);
        (*collection)["cards"] = kept;
    } else {
        for (auto& c : (*collection)["cards"]) {
            if (c.value("id", "") != card_id) continue;
            if (!quantity.is_null()) c["quantity"] = quantity;
            if (!condition.is_null()) c["condition"] = condition;
        }
    }
    save_locked(db);
    return {200, *collection};
}

Result Store::get_settings() {
    std::lock_guard<std::mutex> lock(mu_);
    return {200, load_locked()["settings"]};
}

Result Store::update_settings(const json& body) {
    if (!body.is_object()) return error(400, "settings must be a JSON object");
    std::lock_guard<std::mutex> lock(mu_);
    json db = load_locked();
    for (auto it = body.begin(); it != body.end(); ++it) db["settings"][it.key()] = it.value();
    save_locked(db);
    return {200, db["settings"]};
}

std::string Store::min_image_quality() {
    std::lock_guard<std::mutex> lock(mu_);
    json settings = load_locked()["settings"];
    return settings.value("minImageQuality", "medium");
}

}  // namespace cardstore
