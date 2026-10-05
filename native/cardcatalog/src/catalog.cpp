#include "cardcatalog/catalog.hpp"

#include <sqlite3.h>

#include <unordered_map>

#include "cardtext/text.hpp"

namespace fs = std::filesystem;

namespace cardcatalog {

namespace {

// How long a connection waits for a lock held by another before giving up. Without it SQLite reports "busy" at once,
// which concurrent readers can hit on Windows, where file locking is stricter.
constexpr int kBusyTimeoutMs = 5000;

[[noreturn]] void fail(sqlite3* db, const std::string& what) {
    throw Error(what + ": " + (db ? sqlite3_errmsg(db) : "no database"));
}

// A prepared statement with positional text/int bindings.
class Stmt {
public:
    Stmt(sqlite3* db, const std::string& sql) : db_(db) {
        if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt_, nullptr) != SQLITE_OK) fail(db, "prepare failed");
    }
    ~Stmt() { sqlite3_finalize(stmt_); }
    Stmt(const Stmt&) = delete;
    Stmt& operator=(const Stmt&) = delete;

    void bind(int i, const std::string& v) { check(sqlite3_bind_text(stmt_, i, v.data(), static_cast<int>(v.size()), SQLITE_TRANSIENT)); }
    void bind(int i, std::int64_t v) { check(sqlite3_bind_int64(stmt_, i, v)); }
    void bind_null(int i) { check(sqlite3_bind_null(stmt_, i)); }

    bool step() {
        int rc = sqlite3_step(stmt_);
        if (rc == SQLITE_ROW) return true;
        if (rc == SQLITE_DONE) return false;
        fail(db_, "step failed");
    }
    void reset() { sqlite3_reset(stmt_); sqlite3_clear_bindings(stmt_); }

    std::string text(int col) const {
        const unsigned char* t = sqlite3_column_text(stmt_, col);
        return t ? reinterpret_cast<const char*>(t) : "";
    }
    std::optional<std::int64_t> integer(int col) const {
        if (sqlite3_column_type(stmt_, col) == SQLITE_NULL) return std::nullopt;
        return sqlite3_column_int64(stmt_, col);
    }

private:
    void check(int rc) { if (rc != SQLITE_OK) fail(db_, "bind failed"); }
    sqlite3* db_;
    sqlite3_stmt* stmt_ = nullptr;
};

constexpr const char* kColumns =
    "uid, game, name, name_lower, set_code, set_name, collector_number, rarity, passcode, image_url, image_path, vector_idx";

Card read_card(const Stmt& s) {
    Card c;
    c.uid = s.text(0);
    c.game = s.text(1);
    c.name = s.text(2);
    c.name_lower = s.text(3);
    c.set_code = s.text(4);
    c.set_name = s.text(5);
    c.collector_number = s.text(6);
    c.rarity = s.text(7);
    c.passcode = s.text(8);
    c.image_url = s.text(9);
    c.image_path = s.text(10);
    c.vector_idx = s.integer(11);
    return c;
}

std::optional<Card> first_card(Stmt& s) {
    if (!s.step()) return std::nullopt;
    return read_card(s);
}

}  // namespace

bool exists(const fs::path& db_path) {
    std::error_code ec;
    return fs::exists(db_path, ec);
}

// ============================================================================
// Reader
// ============================================================================
Reader::Reader(const fs::path& db_path) {
    // SQLITE_OPEN_READONLY: an accidental write raises instead of mutating a catalog this side only reads.
    if (sqlite3_open_v2(db_path.u8string().c_str(), &db_, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nullptr) != SQLITE_OK) {
        std::string msg = db_ ? sqlite3_errmsg(db_) : "out of memory";
        sqlite3_close(db_);
        db_ = nullptr;
        throw Error("could not open catalog " + db_path.string() + ": " + msg);
    }
    sqlite3_busy_timeout(db_, kBusyTimeoutMs);
}

Reader::~Reader() { sqlite3_close(db_); }

std::optional<Card> Reader::lookup(const std::string& game, const std::string& set_code, const std::string& collector_number,
                                   const std::string& passcode) {
    std::string where;
    std::vector<const std::string*> params;
    auto add = [&](const char* col, const std::string& v) {
        if (v.empty()) return;
        where += std::string(" AND ") + col + " = ?";
        params.push_back(&v);
    };
    add("set_code", set_code);
    add("collector_number", collector_number);
    add("passcode", passcode);
    if (params.empty()) return std::nullopt;

    Stmt s(db_, std::string("SELECT ") + kColumns + " FROM cards WHERE game = ?" + where + " LIMIT 1");
    s.bind(1, game);
    for (size_t i = 0; i < params.size(); ++i) s.bind(static_cast<int>(i) + 2, *params[i]);
    return first_card(s);
}

std::optional<Card> Reader::by_uid(const std::string& uid) {
    Stmt s(db_, std::string("SELECT ") + kColumns + " FROM cards WHERE uid = ?");
    s.bind(1, uid);
    return first_card(s);
}

std::optional<Card> Reader::by_vector_idx(std::int64_t vector_idx, const std::string& game) {
    Stmt s(db_, std::string("SELECT ") + kColumns + " FROM cards WHERE vector_idx = ? AND game = ?");
    s.bind(1, vector_idx);
    s.bind(2, game);
    return first_card(s);
}

std::vector<Printing> Reader::printings(const std::string& game, const std::string& name) {
    Stmt s(db_, "SELECT uid, vector_idx FROM cards WHERE game = ? AND name = ? AND vector_idx IS NOT NULL");
    s.bind(1, game);
    s.bind(2, name);
    std::vector<Printing> out;
    while (s.step()) out.push_back({s.text(0), *s.integer(1)});
    return out;
}

std::vector<std::pair<std::string, std::string>> Reader::unique_names(const std::string& game) {
    Stmt s(db_, "SELECT name, MIN(uid) FROM cards WHERE game = ? AND name IS NOT NULL GROUP BY name ORDER BY name");
    s.bind(1, game);
    std::vector<std::pair<std::string, std::string>> out;
    while (s.step()) out.emplace_back(s.text(0), s.text(1));
    return out;
}

std::vector<Card> Reader::search(const std::string& game, const std::string& query, int limit) {
    std::vector<std::string> games = is_game(game) ? std::vector<std::string>{game} : std::vector<std::string>{"mtg", "pokemon", "yugioh"};
    std::string placeholders;
    for (size_t i = 0; i < games.size(); ++i) placeholders += i ? ",?" : "?";

    // name_lower is a stored column, not lower(name): SQLite's own lower() is ASCII-only, so it would stop
    // matching every name whose uppercase form isn't ASCII ("Übermut", "Éclair", Cyrillic, Greek).
    std::string q = cardtext::lower_utf8(cardtext::strip_utf8(query));
    std::string sql = std::string("SELECT ") + kColumns + " FROM cards WHERE game IN (" + placeholders + ")";
    if (!q.empty()) sql += " AND name_lower LIKE ? ORDER BY (name_lower LIKE ?) DESC, name";
    sql += " LIMIT ?";

    Stmt s(db_, sql);
    int i = 1;
    for (const auto& g : games) s.bind(i++, g);
    if (!q.empty()) {
        s.bind(i++, "%" + q + "%");
        s.bind(i++, q + "%");
    }
    s.bind(i, static_cast<std::int64_t>(limit));
    std::vector<Card> out;
    while (s.step()) out.push_back(read_card(s));
    return out;
}

std::int64_t Reader::count() {
    Stmt s(db_, "SELECT COUNT(*) FROM cards");
    s.step();
    return *s.integer(0);
}

// ============================================================================
// Writer
// ============================================================================
Writer::Writer(const fs::path& db_path) {
    if (db_path.has_parent_path()) fs::create_directories(db_path.parent_path());
    if (sqlite3_open_v2(db_path.u8string().c_str(), &db_, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nullptr) != SQLITE_OK) {
        std::string msg = db_ ? sqlite3_errmsg(db_) : "out of memory";
        sqlite3_close(db_);
        db_ = nullptr;
        throw Error("could not create catalog " + db_path.string() + ": " + msg);
    }
    sqlite3_busy_timeout(db_, kBusyTimeoutMs);
    exec("PRAGMA journal_mode=WAL");
    exec("PRAGMA synchronous=NORMAL");
    exec(R"(
        CREATE TABLE IF NOT EXISTS cards (
            uid TEXT PRIMARY KEY,
            game TEXT,
            name TEXT,
            name_lower TEXT,          -- Unicode-lowercased at ingest; SQLite's lower() is ASCII-only
            set_code TEXT,
            set_name TEXT,
            collector_number TEXT,
            rarity TEXT,
            passcode TEXT,
            image_url TEXT,           -- source URL, used to download the local copy
            image_path TEXT,          -- relative path under data/card-images once downloaded
            vector_idx INTEGER        -- row index into the cardvec index, once embedded
        ))");
    // One per WHERE clause the reader actually issues.
    exec("CREATE INDEX IF NOT EXISTS idx_cards_game_set_num ON cards(game, set_code, collector_number)");
    exec("CREATE INDEX IF NOT EXISTS idx_cards_game_passcode ON cards(game, passcode)");
    exec("CREATE INDEX IF NOT EXISTS idx_cards_game_name ON cards(game, name)");
    exec("CREATE INDEX IF NOT EXISTS idx_cards_vector_idx ON cards(game, vector_idx)");
    exec("CREATE INDEX IF NOT EXISTS idx_cards_game_collector_number ON cards(game, collector_number)");
}

Writer::~Writer() { sqlite3_close(db_); }

void Writer::exec(const char* sql) {
    char* err = nullptr;
    if (sqlite3_exec(db_, sql, nullptr, nullptr, &err) != SQLITE_OK) {
        std::string msg = err ? err : "unknown error";
        sqlite3_free(err);
        throw Error(std::string("sqlite: ") + msg + " (" + sql + ")");
    }
}

namespace {
// BEGIN ... COMMIT, rolled back if the body throws.
template <class F>
void in_transaction(sqlite3* db, F body) {
    char* err = nullptr;
    if (sqlite3_exec(db, "BEGIN", nullptr, nullptr, &err) != SQLITE_OK) {
        sqlite3_free(err);
        fail(db, "BEGIN failed");
    }
    try {
        body();
    } catch (...) {
        sqlite3_exec(db, "ROLLBACK", nullptr, nullptr, nullptr);
        throw;
    }
    if (sqlite3_exec(db, "COMMIT", nullptr, nullptr, nullptr) != SQLITE_OK) fail(db, "COMMIT failed");
}
}  // namespace

void Writer::upsert_cards(const std::vector<CardInput>& batch) {
    if (batch.empty()) return;
    // Dedupe by uid, keeping the last occurrence (at the first occurrence's position).
    std::vector<const CardInput*> rows;
    std::unordered_map<std::string, size_t> position;
    for (const auto& c : batch) {
        auto it = position.find(c.uid);
        if (it == position.end()) {
            position[c.uid] = rows.size();
            rows.push_back(&c);
        } else {
            rows[it->second] = &c;
        }
    }

    in_transaction(db_, [&] {
        Stmt s(db_, R"(
            INSERT INTO cards (uid, game, name, name_lower, set_code, set_name,
                               collector_number, rarity, passcode, image_url, image_path, vector_idx)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
            ON CONFLICT (uid) DO UPDATE SET
                name=excluded.name, name_lower=excluded.name_lower,
                set_code=excluded.set_code, set_name=excluded.set_name,
                collector_number=excluded.collector_number, rarity=excluded.rarity,
                passcode=excluded.passcode, image_url=excluded.image_url)");
        for (const CardInput* c : rows) {
            s.bind(1, c->uid);
            s.bind(2, c->game);
            s.bind(3, c->name);
            s.bind(4, cardtext::lower_utf8(c->name));
            s.bind(5, c->set_code);
            s.bind(6, c->set_name);
            s.bind(7, c->collector_number);
            s.bind(8, c->rarity);
            s.bind(9, c->passcode);
            s.bind(10, c->image_url);
            s.step();
            s.reset();
        }
    });
}

void Writer::set_vector_indexes(const std::vector<std::pair<std::int64_t, std::string>>& pairs) {
    if (pairs.empty()) return;
    in_transaction(db_, [&] {
        Stmt s(db_, "UPDATE cards SET vector_idx = ? WHERE uid = ?");
        for (const auto& p : pairs) {
            s.bind(1, p.first);
            s.bind(2, p.second);
            s.step();
            s.reset();
        }
    });
}

void Writer::set_image_path(const std::string& uid, const std::string& image_path) {
    Stmt s(db_, "UPDATE cards SET image_path = ? WHERE uid = ?");
    s.bind(1, image_path);
    s.bind(2, uid);
    s.step();
}

void Writer::set_image_paths(const std::vector<std::pair<std::string, std::string>>& uid_and_path) {
    if (uid_and_path.empty()) return;
    in_transaction(db_, [&] {
        Stmt s(db_, "UPDATE cards SET image_path = ? WHERE uid = ?");
        for (const auto& p : uid_and_path) {
            s.bind(1, p.second);
            s.bind(2, p.first);
            s.step();
            s.reset();
        }
    });
}

std::vector<Writer::ImageToFetch> Writer::cards_needing_images(const std::string& game) {
    std::string sql = "SELECT uid, game, image_url FROM cards WHERE image_path IS NULL AND image_url != ''";
    if (!game.empty()) sql += " AND game = ?";
    Stmt s(db_, sql);
    if (!game.empty()) s.bind(1, game);
    std::vector<ImageToFetch> out;
    while (s.step()) out.push_back({s.text(0), s.text(1), s.text(2)});
    return out;
}

std::int64_t Writer::count() {
    Stmt s(db_, "SELECT COUNT(*) FROM cards");
    s.step();
    return *s.integer(0);
}

std::vector<std::pair<std::string, std::string>> Writer::cards_needing_vectors(const std::string& game) {
    std::string sql = "SELECT uid, image_path FROM cards WHERE image_path IS NOT NULL AND vector_idx IS NULL";
    if (!game.empty()) sql += " AND game = ?";
    Stmt s(db_, sql);
    if (!game.empty()) s.bind(1, game);
    std::vector<std::pair<std::string, std::string>> out;
    while (s.step()) out.emplace_back(s.text(0), s.text(1));
    return out;
}

void Writer::finalize() {
    exec("PRAGMA wal_checkpoint(TRUNCATE)");
    exec("PRAGMA journal_mode=DELETE");
}

}  // namespace cardcatalog
