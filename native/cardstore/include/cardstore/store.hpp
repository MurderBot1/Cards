// cardstore — the collections + settings "database": a single JSON file
// (db.json), plus the validation and stacking rules around it. Pure logic with
// no HTTP in it; every operation returns the status code and JSON body the
// API layer sends back.
#pragma once

#include <filesystem>
#include <functional>
#include <mutex>
#include <string>

#include <nlohmann/json.hpp>

namespace cardstore {

struct Result {
    int status = 200;
    nlohmann::json body;
};

extern const char* const kDefaultCondition;  // "Near Mint"

class Store {
public:
    // `make_id` produces collection/card ids (default: 8 random hex chars). `now_ms` is the clock behind the
    // `updated` stamps (default: system time in milliseconds since the epoch).
    explicit Store(std::filesystem::path db_path, std::function<std::string()> make_id = {},
                   std::function<long long()> now_ms = {});

    // Writes an empty db (no collections, default settings) if none exists yet.
    void ensure_exists();

    Result list_collections();
    Result create_collection(const nlohmann::json& body);
    Result get_collection(const std::string& collection_id);
    Result delete_collection(const std::string& collection_id);

    Result add_card(const std::string& collection_id, const nlohmann::json& body);
    Result update_card(const std::string& collection_id, const std::string& card_id, const nlohmann::json& body);

    // ---- sync (see cloudflare/src/sync.js for the other half) ---------------------------------------------------
    // Every collection and card carries `updated` (ms) and removals are remembered (a collection's `tomb` map of
    // card id -> ms, and the db's `deleted` map of collection id -> ms), so two devices' edits can be merged later.
    //
    // sync_state: { collections: [{id, name, updated, cards: [...], tomb: {}}], deleted: [{id, at}] }. Anything
    // written before stamps existed reads as updated = 1.
    Result sync_state();
    // sync_apply: body { collections: [doc | {id, deleted: ms}], expect: {id: updated-or-null} } where each doc is the
    // merged result of a sync and `expect` is the `updated` this device had when it sent the request. A collection
    // changed locally since then is left alone ("skipped"; the next sync merges it), the rest are replaced.
    // Result body: { applied: [ids], skipped: [ids] }.
    Result sync_apply(const nlohmann::json& body);

    Result get_settings();
    Result update_settings(const nlohmann::json& body);

    // settings["minImageQuality"] ("low" | "medium" | "high"), "medium" if unset.
    std::string min_image_quality();

private:
    nlohmann::json load_locked();
    void save_locked(const nlohmann::json& db);

    std::filesystem::path db_path_;
    std::function<std::string()> make_id_;
    std::function<long long()> now_ms_;
    std::mutex mu_;  // the whole file is read-modify-written per request
};

}  // namespace cardstore
