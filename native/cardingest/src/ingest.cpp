#include "cardingest/ingest.hpp"

#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <mutex>
#include <thread>

namespace cardingest {

using nlohmann::json;
using cardcatalog::CardInput;

namespace {

// The field if it's a string, otherwise `fallback` (missing, null, or some other type).
std::string str(const json& j, const char* key, const std::string& fallback = "") {
    if (!j.is_object()) return fallback;
    auto it = j.find(key);
    return it != j.end() && it->is_string() ? it->get<std::string>() : fallback;
}

std::string upper_ascii(std::string s) {
    for (char& c : s)
        if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 32);
    return s;
}

// Python's str.capitalize() for ASCII: first character upper-case, the rest lower-case.
std::string capitalize_ascii(std::string s) {
    for (std::size_t i = 0; i < s.size(); ++i) {
        char& c = s[i];
        if (i == 0 && c >= 'a' && c <= 'z') c = static_cast<char>(c - 32);
        else if (i > 0 && c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
    }
    return s;
}

const json* find_object(const json& j, const char* key) {
    if (!j.is_object()) return nullptr;
    auto it = j.find(key);
    return it != j.end() && it->is_object() ? &*it : nullptr;
}

// Collects rows and writes them in batches.
class Batcher {
public:
    explicit Batcher(cardcatalog::Writer& w) : writer_(w) {}
    void add(CardInput row) {
        rows_.push_back(std::move(row));
        ++total_;
        if (rows_.size() >= kCardBatchSize) flush();
    }
    void flush() {
        writer_.upsert_cards(rows_);
        rows_.clear();
    }
    std::size_t total() const { return total_; }

private:
    cardcatalog::Writer& writer_;
    std::vector<CardInput> rows_;
    std::size_t total_ = 0;
};

}  // namespace

// ============================================================================
// MTG — Scryfall bulk data
// ============================================================================
Stats ingest_mtg(cardfetch::Fetcher& fetcher, cardcatalog::Writer& writer, const Log& log, const Sources& sources) {
    log("[mtg] fetching bulk-data index from Scryfall...");
    json index = fetcher.get_json(sources.scryfall_bulk_index, "scryfall_bulk_index");
    // "all_cards" includes every printing Scryfall knows about (including extra languages/promos that
    // "default_cards" leaves out) — a bigger download, but a more complete catalog for scan matching.
    const json* entry = nullptr;
    if (index.is_object() && index.contains("data") && index["data"].is_array())
        for (const auto& e : index["data"])
            if (str(e, "type") == "all_cards") {
                entry = &e;
                break;
            }
    if (!entry) throw std::runtime_error("[mtg] Scryfall's bulk-data index has no \"all_cards\" entry");
    std::string uri = str(*entry, "jsonl_download_uri");
    if (uri.empty())
        // Scryfall serves bulk data only as gzipped JSONL since July 2026; fail loudly instead of trying a retired format.
        throw std::runtime_error(
            "[mtg] bulk-data entry has no jsonl_download_uri — Scryfall's API response shape may have changed again; "
            "check https://scryfall.com/docs/api/bulk-data");
    // 'size' isn't guaranteed to be present, so don't let it crash a cosmetic log line.
    std::string size_note = "size unknown";
    if (entry->contains("size") && (*entry)["size"].is_number()) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%.0fMB", (*entry)["size"].get<double>() / 1e6);
        size_note = buf;
    }
    log("[mtg] downloading " + size_note + " card dump (gzipped JSONL)...");

    Stats stats;
    Batcher batch(writer);
    std::size_t seen = 0;
    fetcher.for_each_jsonl_gz(
        uri, "scryfall_all_cards",
        [&](const json& c) {
            if (++seen % 50000 == 0) log("[mtg] " + std::to_string(seen) + " printings read...");
            std::string layout = str(c, "layout");
            if (layout == "art_series" || layout == "token" || layout == "double_faced_token") {
                ++stats.skipped;
                return;
            }
            std::string id = str(c, "id"), name = str(c, "name");
            if (id.empty() || name.empty()) {
                ++stats.skipped;
                return;
            }
            std::string image_url;
            if (const json* uris = find_object(c, "image_uris")) {
                image_url = str(*uris, "normal");
            } else if (c.contains("card_faces") && c["card_faces"].is_array() && !c["card_faces"].empty()) {
                if (const json* uris = find_object(c["card_faces"][0], "image_uris")) image_url = str(*uris, "normal");
            }
            batch.add({"mtg-" + id, "mtg", name, upper_ascii(str(c, "set")), str(c, "set_name"), str(c, "collector_number"),
                       capitalize_ascii(str(c, "rarity")), "", image_url});
        },
        120);
    batch.flush();
    stats.cards = batch.total();
    log("[mtg] done: " + std::to_string(stats.cards) + " printings (" + std::to_string(stats.skipped) + " skipped).");
    return stats;
}

// ============================================================================
// Pokémon — PokemonTCG/pokemon-tcg-data (raw JSON, per set)
// ============================================================================
Stats ingest_pokemon(cardfetch::Fetcher& fetcher, cardcatalog::Writer& writer, const Log& log, int max_workers,
                     const Sources& sources) {
    log("[pokemon] fetching set list...");
    json sets = fetcher.get_json(sources.pokemon_sets, "pokemon_sets");
    if (!sets.is_array()) throw std::runtime_error("[pokemon] the set list is not a JSON array");

    std::vector<json> set_list;
    for (const auto& s : sets)
        if (!str(s, "id").empty()) set_list.push_back(s);
    if (max_workers < 1) max_workers = 1;
    log("[pokemon] " + std::to_string(set_list.size()) + " sets to ingest (" + std::to_string(max_workers) + " workers)...");

    // Worker threads do the network GET (or cache read) for one set's card list each — no database access; writes
    // happen back on this thread as results arrive.
    struct Result {
        std::size_t set_index;
        json cards;
        std::string error;
    };
    std::mutex mu;
    std::condition_variable cv;
    std::deque<Result> done;
    std::atomic<std::size_t> next{0};
    auto worker = [&] {
        for (;;) {
            std::size_t i = next.fetch_add(1);
            if (i >= set_list.size()) return;
            std::string id = str(set_list[i], "id");
            std::string url = sources.pokemon_set;
            url.replace(url.find("{id}"), 4, id);
            Result r{i, json(), ""};
            try {
                r.cards = fetcher.get_json(url, "pokemon_set_" + id);
            } catch (const std::exception& e) {
                r.error = e.what();
            }
            {
                std::lock_guard<std::mutex> lock(mu);
                done.push_back(std::move(r));
            }
            cv.notify_one();
        }
    };
    std::vector<std::thread> pool;
    int n_threads = std::min<int>(max_workers, static_cast<int>(set_list.size()));
    for (int i = 0; i < n_threads; ++i) pool.emplace_back(worker);

    Stats stats;
    Batcher batch(writer);
    for (std::size_t received = 0; received < set_list.size(); ++received) {
        Result r;
        {
            std::unique_lock<std::mutex> lock(mu);
            cv.wait(lock, [&] { return !done.empty(); });
            r = std::move(done.front());
            done.pop_front();
        }
        const json& s = set_list[r.set_index];
        std::string set_id = str(s, "id");
        if (!r.error.empty() || !r.cards.is_array()) {
            ++stats.skipped;
            log("[pokemon] skipped set " + set_id + (r.error.empty() ? ": not a card list" : ": " + r.error));
            continue;
        }
        std::string set_code = upper_ascii(str(s, "ptcgoCode", set_id));
        if (set_code.empty()) set_code = upper_ascii(set_id);
        for (const auto& c : r.cards) {
            std::string id = str(c, "id");
            if (id.empty()) {
                ++stats.skipped;
                continue;
            }
            std::string image_url;
            if (const json* images = find_object(c, "images")) {
                image_url = str(*images, "large");
                if (image_url.empty()) image_url = str(*images, "small");
            }
            batch.add({"pkm-" + id, "pokemon", str(c, "name"), set_code, str(s, "name"), str(c, "number"), str(c, "rarity"), "",
                       image_url});
        }
        batch.flush();  // one transaction per set
    }
    for (auto& t : pool) t.join();
    stats.cards = batch.total();
    log("[pokemon] done: " + std::to_string(stats.cards) + " cards.");
    return stats;
}

// ============================================================================
// Yu-Gi-Oh! — YGOPRODeck bulk export
// ============================================================================
Stats ingest_yugioh(cardfetch::Fetcher& fetcher, cardcatalog::Writer& writer, const Log& log, const Sources& sources) {
    log("[yugioh] downloading cardinfo.php bulk export...");
    json response = fetcher.get_json(sources.ygoprodeck, "ygoprodeck_cardinfo", 120);
    if (!response.is_object() || !response.contains("data") || !response["data"].is_array())
        throw std::runtime_error("[yugioh] the response has no \"data\" list");
    const json& cards = response["data"];

    Stats stats;
    Batcher batch(writer);
    for (const auto& c : cards) {
        // the passcode is a number in the API, but be liberal about it
        std::string passcode;
        if (c.contains("id")) {
            if (c["id"].is_number_integer()) passcode = std::to_string(c["id"].get<long long>());
            else if (c["id"].is_string()) passcode = c["id"].get<std::string>();
        }
        std::string name = str(c, "name");
        if (passcode.empty() || name.empty()) {
            ++stats.skipped;
            continue;
        }
        std::string image_url;
        if (c.contains("card_images") && c["card_images"].is_array() && !c["card_images"].empty())
            image_url = str(c["card_images"][0], "image_url");

        // one row per printing; a card with no listed sets still gets one
        json one_empty = json::array({json::object()});
        const json& card_sets = c.contains("card_sets") && c["card_sets"].is_array() && !c["card_sets"].empty() ? c["card_sets"] : one_empty;
        for (const auto& cs : card_sets) {
            std::string set_code = str(cs, "set_code");
            std::string uid = set_code.empty() ? "ygo-" + passcode : "ygo-" + passcode + "-" + set_code;
            batch.add({uid, "yugioh", name, set_code, str(cs, "set_name"), "", str(cs, "set_rarity"), passcode, image_url});
        }
    }
    batch.flush();
    stats.cards = batch.total();
    log("[yugioh] done: " + std::to_string(cards.size()) + " cards, " + std::to_string(stats.cards) + " printings.");
    return stats;
}

}  // namespace cardingest
