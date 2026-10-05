// cardcatalog — the SQLite card catalog (data/cards.sqlite3): schema, the
// write side used by the catalog builder, and the read side used by the
// scanner and /api/search. Replaces the sqlite3 code in build_scanner_models.py
// and scanner.py.
//
// The catalog stores each card's *source* image URL (Scryfall / PokemonTCG /
// YGOPRODeck); the frontend loads art straight from there, nothing is hosted
// locally.
#pragma once

#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

struct sqlite3;

namespace cardcatalog {

class Error : public std::runtime_error {
    using std::runtime_error::runtime_error;
};

inline bool is_game(const std::string& g) { return g == "mtg" || g == "pokemon" || g == "yugioh"; }

// A full catalog row.
struct Card {
    std::string uid, game, name, name_lower, set_code, set_name, collector_number, rarity, passcode, image_url,
        image_path;
    std::optional<std::int64_t> vector_idx;  // row in the cardvec index, once embedded
};

// What the builder supplies per card; name_lower is derived.
struct CardInput {
    std::string uid, game, name, set_code, set_name, collector_number, rarity, passcode, image_url;
};

struct Printing {
    std::string uid;
    std::int64_t vector_idx;
};

bool exists(const std::filesystem::path& db_path);

// ---------------------------------------------------------------------------
// Read side. A Reader owns one read-only connection, so an accidental write
// fails instead of mutating the catalog. SQLite connections must not cross
// threads: open one Reader per request/scan, don't cache it.
// ---------------------------------------------------------------------------
class Reader {
public:
    explicit Reader(const std::filesystem::path& db_path);  // throws Error if it can't be opened
    ~Reader();
    Reader(const Reader&) = delete;
    Reader& operator=(const Reader&) = delete;

    // First card of `game` matching every non-empty field; nullopt if none, or if no field is given.
    std::optional<Card> lookup(const std::string& game, const std::string& set_code = "",
                               const std::string& collector_number = "", const std::string& passcode = "");
    std::optional<Card> by_uid(const std::string& uid);
    std::optional<Card> by_vector_idx(std::int64_t vector_idx, const std::string& game);
    // Every printing of a name that has been embedded.
    std::vector<Printing> printings(const std::string& game, const std::string& name);
    // (name, smallest uid) for each distinct name of `game`, ordered by name.
    std::vector<std::pair<std::string, std::string>> unique_names(const std::string& game);
    // Prefix matches first, then substring, across `game` (or all games if it isn't one).
    // `query` is matched case-insensitively against the stored lowercase name.
    std::vector<Card> search(const std::string& game, const std::string& query, int limit = 30);
    std::int64_t count();

    sqlite3* native_handle() { return db_; }  // for diagnostics and tests

private:
    sqlite3* db_ = nullptr;
};

// ---------------------------------------------------------------------------
// Write side (the catalog builder). WAL + synchronous=NORMAL during ingest is the
// standard bulk-load setting — safe against process crashes, and the file is
// regenerable. Call finalize() when done writing.
// ---------------------------------------------------------------------------
class Writer {
public:
    explicit Writer(const std::filesystem::path& db_path);  // creates the file, schema and indexes
    ~Writer();
    Writer(const Writer&) = delete;
    Writer& operator=(const Writer&) = delete;

    // Upserts many cards in one transaction. Duplicate uids within the batch collapse to
    // the last one. On conflict the descriptive fields update but image_path/vector_idx are kept.
    void upsert_cards(const std::vector<CardInput>& batch);

    // (vector_idx, uid) pairs, in one transaction.
    void set_vector_indexes(const std::vector<std::pair<std::int64_t, std::string>>& pairs);
    void set_image_path(const std::string& uid, const std::string& image_path);
    void set_image_paths(const std::vector<std::pair<std::string, std::string>>& uid_and_path);  // one transaction

    // Rows with a source image URL but no local image yet: (uid, game, image_url). Optionally one game only.
    struct ImageToFetch {
        std::string uid, game, image_url;
    };
    std::vector<ImageToFetch> cards_needing_images(const std::string& game = "");

    // Rows with an image but no vector yet: (uid, image_path). Optionally one game only.
    std::vector<std::pair<std::string, std::string>> cards_needing_vectors(const std::string& game = "");

    // Folds the write-ahead log back into the file and leaves WAL mode, so the finished catalog is a
    // single self-contained file. It gets *shipped* (installer, device), and a stray -wal can truncate
    // it or make a read-only open fail outright.
    void finalize();

    std::int64_t count();

    sqlite3* native_handle() { return db_; }

private:
    void exec(const char* sql);
    sqlite3* db_ = nullptr;
};

}  // namespace cardcatalog
