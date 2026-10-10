#include "cardstore/store.hpp"

#include <algorithm>
#include <chrono>
#include <fstream>
#include <optional>
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
constexpr const char* kValidKindsRepr = "('collection', 'deck', 'tradelist', 'wishlist')";

bool valid_condition(const std::string& c) {
    return c == "Near Mint" || c == "Lightly Played" || c == "Moderately Played" || c == "Heavily Played" ||
           c == "Damaged";
}
bool valid_game(const json& g) {
    return g.is_string() && (g == "mtg" || g == "pokemon" || g == "yugioh");
}

// What a list is: a collection (the default, and how lists from before kinds existed read), a deck, a tradelist or a
// wishlist. Only the other three are written down; a list with no `kind` is a collection.
bool valid_kind(const json& k) {
    return k.is_string() && (k == "collection" || k == "deck" || k == "tradelist" || k == "wishlist");
}
bool is_special_kind(const json& k) { return valid_kind(k) && k != "collection"; }

// How much a list may hold, by kind. -1 means no limit. "Different cards" are rows (a card in another condition,
// set, finish or language is its own row). The page and the Worker keep the same numbers (app/js/listKinds.js,
// cloudflare/src/sync.js).
struct ListLimits {
    int max_lists;      // how many lists of this kind a person may have
    int max_cards;      // different cards in one list
    int max_per_card;   // copies of one card
};
ListLimits limits_for(const json& kind) {
    if (kind == "deck") return {100, 150, 100};
    if (kind == "tradelist" || kind == "wishlist") return {-1, 10000, -1};
    return {25, 10000, 1000};  // collections (and anything with no kind)
}
std::string kind_word(const json& kind) { return valid_kind(kind) ? kind.get<std::string>() : "collection"; }
bool is_deck(const json& list) { return list.contains("kind") && list["kind"] == "deck"; }
// A whole number of copies from 0 (as a JSON number), or -1 when it is not one.
long long whole_copies(const json& v) {
    if (v.is_number_integer()) return v.get<long long>() >= 0 ? v.get<long long>() : -1;
    if (v.is_number_float()) {
        double d = v.get<double>();
        return d >= 0 && d == static_cast<double>(static_cast<long long>(d)) ? static_cast<long long>(d) : -1;
    }
    return -1;
}
// Writes how many copies of a card the person has: only when there is something to say, and never more than needed.
void write_owned(json& card, long long owned) {
    const double needed = card.value("quantity", 0.0);
    const long long kept = std::min<long long>(owned, static_cast<long long>(needed));
    if (kept > 0) card["owned"] = kept;
    else card.erase("owned");
}
std::string with_commas(long long n) {
    std::string digits = std::to_string(n), out;
    for (size_t i = 0; i < digits.size(); ++i) {
        if (i > 0 && (digits.size() - i) % 3 == 0) out += ',';
        out += digits[i];
    }
    return out;
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

long long system_now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch())
        .count();
}

// `updated` of a stored collection/card; 1 for data written before stamps existed (older than any real edit).
long long stamp_of(const json& v) {
    auto it = v.find("updated");
    return it != v.end() && it->is_number() ? it->get<long long>() : 1;
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

Store::Store(fs::path db_path, std::function<std::string()> make_id, std::function<long long()> now_ms)
    : db_path_(std::move(db_path)),
      make_id_(make_id ? std::move(make_id) : random_id),
      now_ms_(now_ms ? std::move(now_ms) : system_now_ms) {}

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
    json kind = field(body, "kind");
    if (!kind.is_null() && !valid_kind(kind)) return error(400, std::string("kind must be one of ") + kValidKindsRepr);

    std::lock_guard<std::mutex> lock(mu_);
    json db = load_locked();
    const json made_kind = valid_kind(kind) ? kind : json("collection");
    const ListLimits limits = limits_for(made_kind);
    if (limits.max_lists >= 0) {
        int have = 0;
        for (auto& c : db["collections"]) {
            json k = c.contains("kind") ? c["kind"] : json("collection");
            if (!valid_kind(k)) k = "collection";
            if (k == made_kind) ++have;
        }
        if (have >= limits.max_lists)
            return error(400, "You can have at most " + std::to_string(limits.max_lists) + " " + kind_word(made_kind) + "s");
    }
    json collection = {{"id", make_id_()}, {"name", name}, {"cards", json::array()}, {"updated", now_ms_()}};
    if (is_special_kind(kind)) collection["kind"] = kind;
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
    if (!db.contains("deleted") || !db["deleted"].is_object()) db["deleted"] = json::object();
    db["deleted"][id] = now_ms_();
    save_locked(db);
    return {200, json{{"deleted", true}}};
}

namespace {

// A card's optional string fields (set code, language, collector number) as the stacking rule compares them.
std::string opt_text(const json& v, const char* key) {
    auto it = v.find(key);
    return it != v.end() && it->is_string() ? it->get<std::string>() : "";
}
bool is_foil(const json& v) {
    auto it = v.find("foil");
    return it != v.end() && it->is_boolean() && it->get<bool>();
}

}  // namespace

// Adds one card (or `quantity` copies) to `collection`, stacking onto a matching row. Returns an error to send back,
// or nothing when it was added. Doesn't load or save: add_card and add_cards do that around it.
static std::optional<Result> add_one(json& collection, const json& body, long long now,
                                     const std::function<std::string()>& make_id, bool check_limits = true) {
    json name = field(body, "name");
    json game = field(body, "game");
    if (!truthy(name)) return error(400, "card name is required");
    if (!valid_game(game)) return error(400, std::string("game must be one of ") + kValidGamesRepr);

    json condition_v = field(body, "condition");
    std::string condition = truthy(condition_v) && condition_v.is_string() ? condition_v.get<std::string>()
                                                                          : (truthy(condition_v) ? "" : kDefaultCondition);
    if (!valid_condition(condition)) return error(400, std::string("condition must be one of ") + kValidConditionsRepr);

    // How many copies this adds: `quantity` (a whole number of at least 1) when given, else one.
    long long copies = 1;
    json quantity_v = field(body, "quantity");
    if (!quantity_v.is_null()) {
        if (!quantity_v.is_number_integer() || quantity_v.get<long long>() < 1 || quantity_v.get<long long>() > 100000)
            return error(400, "quantity must be a whole number of at least 1");
        copies = quantity_v.get<long long>();
    }

    // Cards only auto-stack (quantity++) when name/set/game AND condition all
    // match: a Near Mint copy and a Heavily Played copy of the same print are
    // separate rows. Finish (foil), language and collector number must match too. (A request with no "set" never
    // stacks: stored cards always carry one, "" by default, and null != "" — same as before.)
    json set_v = field(body, "set");
    const bool foil = is_foil(body);
    const std::string language = opt_text(body, "language");
    const std::string number = opt_text(body, "number");
    json* existing = nullptr;
    for (auto& c : collection["cards"]) {
        if (c.value("name", json()) == name && c.value("set", json()) == set_v && c.value("game", json()) == game &&
            c.value("condition", json(kDefaultCondition)) == condition && is_foil(c) == foil &&
            opt_text(c, "language") == language && opt_text(c, "number") == number) {
            existing = &c;
            break;
        }
    }
    const json list_kind = collection.contains("kind") ? collection["kind"] : json("collection");
    const ListLimits limits = limits_for(list_kind);
    if (check_limits) {
        if (existing) {
            const double total = (*existing)["quantity"].is_number() ? (*existing)["quantity"].get<double>() + copies : copies;
            if (limits.max_per_card >= 0 && total > limits.max_per_card)
                return error(400, "A " + kind_word(list_kind) + " can hold at most " + with_commas(limits.max_per_card) +
                                      " copies of one card");
        } else {
            if (limits.max_per_card >= 0 && copies > limits.max_per_card)
                return error(400, "A " + kind_word(list_kind) + " can hold at most " + with_commas(limits.max_per_card) +
                                      " copies of one card");
            if (static_cast<long long>(collection["cards"].size()) >= limits.max_cards)
                return error(400, "A " + kind_word(list_kind) + " can hold at most " + with_commas(limits.max_cards) +
                                      " different cards");
        }
    }
    // `owned` (a deck's "I have these", e.g. from a re-imported export): kept for decks, quietly left out elsewhere
    const long long owned_in = is_deck(collection) ? whole_copies(field(body, "owned")) : -1;
    if (existing) {
        json& q = (*existing)["quantity"];
        q = q.is_number_integer() ? json(q.get<long long>() + copies) : json(q.get<double>() + static_cast<double>(copies));
        if (owned_in > 0) write_owned(*existing, (*existing).value("owned", 0LL) + owned_in);
        (*existing)["updated"] = now;
    } else {
        auto str_or_empty = [&](const char* key) { return body.contains(key) ? body[key] : json(""); };
        json fresh = {{"id", make_id()},
                      {"name", name},
                      {"game", game},
                      {"set", str_or_empty("set")},
                      {"rarity", str_or_empty("rarity")},
                      {"image", str_or_empty("image")},
                      {"condition", condition},
                      {"quantity", copies},
                      {"updated", now}};
        // The catalog id the card was picked from (a search or scan result's "id"): lets prices be looked up exactly.
        json catalog_id = body.contains("uid") ? body["uid"] : field(body, "id");
        if (catalog_id.is_string() && !catalog_id.get<std::string>().empty()) fresh["uid"] = catalog_id;
        // Finish, language and collector number are only kept when there is something to say.
        if (foil) fresh["foil"] = true;
        if (!language.empty()) fresh["language"] = language;
        if (!number.empty()) fresh["number"] = number;
        if (owned_in > 0) write_owned(fresh, owned_in);
        collection["cards"].push_back(fresh);
    }
    collection["updated"] = now;
    return std::nullopt;
}

Result Store::add_card(const std::string& collection_id, const json& body) {
    // (validated before the collection is looked up, as ever: a bad request is a 400 even for a missing collection)
    json probe = json::object({{"cards", json::array()}});
    if (auto bad = add_one(probe, body, 0, [] { return std::string("probe"); }, false)) return *bad;

    std::lock_guard<std::mutex> lock(mu_);
    json db = load_locked();
    json* collection = find_collection(db, collection_id);
    if (!collection) return error(404, "not found");
    if (auto bad = add_one(*collection, body, now_ms_(), make_id_)) return *bad;
    save_locked(db);
    return {201, *collection};
}

Result Store::add_cards(const std::string& collection_id, const json& body) {
    if (!body.is_object() || !body.contains("cards") || !body["cards"].is_array()) return error(400, "cards must be an array");
    const json& cards = body["cards"];
    if (cards.empty() || cards.size() > 20000) return error(400, "send between 1 and 20000 cards");

    std::lock_guard<std::mutex> lock(mu_);
    json db = load_locked();
    json* collection = find_collection(db, collection_id);
    if (!collection) return error(404, "not found");
    const long long now = now_ms_();
    // all or nothing: one bad row and nothing is added (the page checks its rows first, so this is a backstop)
    json work = *collection;
    size_t row = 0;
    for (const auto& card : cards) {
        ++row;
        if (!card.is_object()) return error(400, "card " + std::to_string(row) + " is not an object");
        if (auto bad = add_one(work, card, now, make_id_)) {
            json message = bad->body;
            message["error"] = "card " + std::to_string(row) + ": " + message["error"].get<std::string>();
            return {bad->status, message};
        }
    }
    *collection = work;
    save_locked(db);
    return {201, *collection};
}

Result Store::update_card(const std::string& collection_id, const std::string& card_id, const json& body) {
    json quantity = field(body, "quantity");
    json condition = field(body, "condition");
    json uid = field(body, "uid");
    json owned = field(body, "owned");
    if (quantity.is_null() && condition.is_null() && uid.is_null() && owned.is_null())
        return error(400, "quantity and/or condition is required");
    if (!uid.is_null() && !uid.is_string()) return error(400, "uid must be a string");
    if (!owned.is_null() && whole_copies(owned) < 0) return error(400, "owned must be a whole number of at least 0");
    if (!quantity.is_null() && !quantity.is_number()) return error(400, "quantity must be a number");
    if (!condition.is_null() && !(condition.is_string() && valid_condition(condition.get<std::string>())))
        return error(400, std::string("condition must be one of ") + kValidConditionsRepr);

    std::lock_guard<std::mutex> lock(mu_);
    json db = load_locked();
    json* collection = find_collection(db, collection_id);
    if (!collection) return error(404, "not found");

    if (!owned.is_null() && !is_deck(*collection)) return error(400, "only a deck keeps track of the cards you have");
    if (!quantity.is_null() && quantity.get<double>() > 0) {
        const json list_kind = collection->contains("kind") ? (*collection)["kind"] : json("collection");
        const ListLimits limits = limits_for(list_kind);
        if (limits.max_per_card >= 0 && quantity.get<double>() > limits.max_per_card)
            return error(400, "A " + kind_word(list_kind) + " can hold at most " + with_commas(limits.max_per_card) +
                                  " copies of one card");
    }

    const long long now = now_ms_();
    if (!quantity.is_null() && quantity.get<double>() <= 0) {
        json kept = json::array();
        bool removed = false;
        for (auto& c : (*collection)["cards"]) {
            if (c.value("id", "") != card_id)
                kept.push_back(c);
            else
                removed = true;
        }
        (*collection)["cards"] = kept;
        if (removed) {
            if (!collection->contains("tomb") || !(*collection)["tomb"].is_object()) (*collection)["tomb"] = json::object();
            (*collection)["tomb"][card_id] = now;
            (*collection)["updated"] = now;
        }
    } else {
        for (auto& c : (*collection)["cards"]) {
            if (c.value("id", "") != card_id) continue;
            if (!quantity.is_null()) c["quantity"] = quantity;
            if (!condition.is_null()) c["condition"] = condition;
            if (!uid.is_null()) c["uid"] = uid;
            // (what is had never exceeds what is needed, so lowering the quantity lowers it too)
            if (!owned.is_null()) write_owned(c, whole_copies(owned));
            else if (!quantity.is_null() && c.contains("owned")) write_owned(c, c["owned"].get<long long>());
            c["updated"] = now;
            (*collection)["updated"] = now;
        }
    }
    save_locked(db);
    return {200, *collection};
}

Result Store::move_card(const std::string& collection_id, const std::string& card_id, const json& body) {
    json to = field(body, "to");
    if (!to.is_string() || to.get<std::string>().empty()) return error(400, "to must be the id of another list");
    const std::string target_id = to.get<std::string>();
    if (target_id == collection_id) return error(400, "choose a different list to move it to");

    std::lock_guard<std::mutex> lock(mu_);
    json db = load_locked();
    json* source = find_collection(db, collection_id);
    if (!source) return error(404, "not found");
    json* target = find_collection(db, target_id);
    if (!target) return error(404, "the list to move it to was not found");
    json* card = nullptr;
    for (auto& c : (*source)["cards"])
        if (c.value("id", "") == card_id) card = &c;
    if (!card) return error(404, "not found");

    const double have = (*card).value("quantity", 0.0);
    long long copies = static_cast<long long>(have);
    json quantity_v = field(body, "quantity");
    if (!quantity_v.is_null()) {
        if (!quantity_v.is_number_integer() || quantity_v.get<long long>() < 1 || quantity_v.get<long long>() > copies)
            return error(400, "quantity must be a whole number from 1 to " + std::to_string(copies));
        copies = quantity_v.get<long long>();
    }

    // into the other list first (under its limits); the source is only changed once that has worked
    json card_body = {{"name", (*card)["name"]}, {"game", (*card)["game"]}, {"set", card->value("set", json(""))},
                      {"rarity", card->value("rarity", json(""))}, {"image", card->value("image", json(""))},
                      {"condition", card->value("condition", json(kDefaultCondition))}, {"quantity", copies}};
    if (card->contains("uid")) card_body["uid"] = (*card)["uid"];
    if (is_foil(*card)) card_body["foil"] = true;
    if (!opt_text(*card, "language").empty()) card_body["language"] = (*card)["language"];
    if (!opt_text(*card, "number").empty()) card_body["number"] = (*card)["number"];
    const long long now = now_ms_();
    json target_work = *target;
    if (auto bad = add_one(target_work, card_body, now, make_id_)) return *bad;

    if (static_cast<double>(copies) >= have) {
        json kept = json::array();
        for (auto& c : (*source)["cards"])
            if (c.value("id", "") != card_id) kept.push_back(c);
        (*source)["cards"] = kept;
        if (!source->contains("tomb") || !(*source)["tomb"].is_object()) (*source)["tomb"] = json::object();
        (*source)["tomb"][card_id] = now;
    } else {
        json& q = (*card)["quantity"];
        q = q.is_number_integer() ? json(q.get<long long>() - copies) : json(have - static_cast<double>(copies));
        if (card->contains("owned")) write_owned(*card, (*card)["owned"].get<long long>());  // (never more than needed)
        (*card)["updated"] = now;
    }
    (*source)["updated"] = now;
    *target = target_work;
    save_locked(db);
    return {200, json{{"source", *source}, {"target", *target}}};
}

Result Store::set_owned(const std::string& collection_id, const json& body) {
    json owned = field(body, "owned");
    if (!owned.is_object()) return error(400, "owned must be an object of card id to copies");
    for (auto it = owned.begin(); it != owned.end(); ++it)
        if (whole_copies(it.value()) < 0) return error(400, "owned must be a whole number of at least 0");

    std::lock_guard<std::mutex> lock(mu_);
    json db = load_locked();
    json* collection = find_collection(db, collection_id);
    if (!collection) return error(404, "not found");
    if (!is_deck(*collection)) return error(400, "only a deck keeps track of the cards you have");
    const long long now = now_ms_();
    bool changed = false;
    for (auto& c : (*collection)["cards"]) {
        auto it = owned.find(c.value("id", ""));
        if (it == owned.end()) continue;
        const long long before = c.contains("owned") && c["owned"].is_number_integer() ? c["owned"].get<long long>() : 0;
        write_owned(c, whole_copies(it.value()));
        const long long after = c.contains("owned") ? c["owned"].get<long long>() : 0;
        if (before != after) {
            c["updated"] = now;
            changed = true;
        }
    }
    if (changed) {
        (*collection)["updated"] = now;
        save_locked(db);
    }
    return {200, *collection};
}

Result Store::sync_state() {
    std::lock_guard<std::mutex> lock(mu_);
    json db = load_locked();
    json docs = json::array();
    for (auto& c : db["collections"]) {
        json doc = {{"id", c.value("id", "")},
                    {"name", c.value("name", "")},
                    {"updated", stamp_of(c)},
                    {"cards", json::array()},
                    {"tomb", c.contains("tomb") && c["tomb"].is_object() ? c["tomb"] : json::object()}};
        if (c.contains("kind") && is_special_kind(c["kind"])) doc["kind"] = c["kind"];
        long long newest = stamp_of(c);
        for (auto card : c["cards"]) {
            card["updated"] = stamp_of(card);
            newest = std::max(newest, stamp_of(card));
            doc["cards"].push_back(card);
        }
        doc["updated"] = newest;  // never older than its newest card
        docs.push_back(doc);
    }
    json deleted = json::array();
    if (db.contains("deleted") && db["deleted"].is_object())
        for (auto it = db["deleted"].begin(); it != db["deleted"].end(); ++it)
            if (it.value().is_number()) deleted.push_back({{"id", it.key()}, {"at", it.value()}});
    return {200, json{{"collections", docs}, {"deleted", deleted}}};
}

Result Store::sync_apply(const json& body) {
    if (!body.is_object()) return error(400, "sync body must be a JSON object");
    json incoming = body.contains("collections") ? body["collections"] : json::array();
    json expect = body.contains("expect") && body["expect"].is_object() ? body["expect"] : json::object();
    if (!incoming.is_array()) return error(400, "collections must be an array");

    std::lock_guard<std::mutex> lock(mu_);
    json db = load_locked();
    json applied = json::array(), skipped = json::array();
    if (!db.contains("deleted") || !db["deleted"].is_object()) db["deleted"] = json::object();

    for (auto& doc : incoming) {
        if (!doc.is_object() || !doc.contains("id") || !doc["id"].is_string()) continue;
        const std::string id = doc["id"];

        // What this device had for it when the sync started, versus now.
        json* local = find_collection(db, id);
        long long local_stamp = 0;
        if (local) {
            local_stamp = stamp_of(*local);
            for (auto& card : (*local)["cards"]) local_stamp = std::max(local_stamp, stamp_of(card));
        }
        auto e = expect.find(id);
        const bool expected_present = e != expect.end() && e->is_number();
        if (local ? !(expected_present && e->get<long long>() == local_stamp) : expected_present) {
            skipped.push_back(id);
            continue;
        }

        if (doc.contains("deleted")) {
            if (!doc["deleted"].is_number()) continue;
            if (local) {
                json kept = json::array();
                for (auto& c : db["collections"])
                    if (c.value("id", "") != id) kept.push_back(c);
                db["collections"] = kept;
            }
            db["deleted"][id] = doc["deleted"];
            applied.push_back(id);
            continue;
        }
        if (!doc.contains("cards") || !doc["cards"].is_array() || !doc.contains("name") || !doc["name"].is_string())
            continue;

        json merged = {{"id", id}, {"name", doc["name"]}, {"cards", doc["cards"]}, {"updated", stamp_of(doc)}};
        if (doc.contains("tomb") && doc["tomb"].is_object()) merged["tomb"] = doc["tomb"];
        if (doc.contains("kind") && is_special_kind(doc["kind"])) merged["kind"] = doc["kind"];
        if (local) {
            *local = merged;
        } else {
            db["collections"].push_back(merged);
        }
        db["deleted"].erase(id);
        applied.push_back(id);
    }
    save_locked(db);
    return {200, json{{"applied", applied}, {"skipped", skipped}}};
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
