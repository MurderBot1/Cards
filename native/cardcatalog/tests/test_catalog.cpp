// Port of app/backend/tests/test_catalog_sqlite.py's catalog assertions: the write
// side (schema, indexes, dedupe, upsert, vector backfill, WAL finalize) and the read side
// (lookups, Unicode-aware search, read-only connections, thread safety).
#include <sqlite3.h>

#include <algorithm>
#include <atomic>
#include <set>
#include <thread>

#include "cardcatalog/catalog.hpp"
#include "cardtest.hpp"

namespace fs = std::filesystem;
using cardcatalog::CardInput;

static const std::vector<CardInput> kCards = {
    {"mtg-1", "mtg", "Lightning Bolt", "LEA", "Alpha", "161", "common", "", "http://example/1.jpg"},
    {"mtg-2", "mtg", "Lightning Bolt", "M10", "Magic 2010", "146", "common", "", "http://example/2.jpg"},
    {"mtg-3", "mtg", "Black Lotus", "LEA", "Alpha", "232", "rare", "", "http://example/3.jpg"},
    {"ygo-1", "yugioh", "Dark Magician", "LOB", "Legend of Blue Eyes", "005", "ultra", "46986414", "http://example/4.jpg"},
    {"pkm-1", "pokemon", "Charizard", "BS", "Base Set", "4", "rare", "", "http://example/5.jpg"},
    // Scryfall's all_cards dump carries every language a card was printed in.
    {"mtg-4", "mtg", "Übermut", "GER", "German Printing", "12", "uncommon", "", "http://example/6.jpg"},
    {"mtg-5", "mtg", "稲妻の剣", "JPN", "Japanese Printing", "77", "rare", "", "http://example/7.jpg"},
};

static std::vector<std::string> uids(const std::vector<cardcatalog::Card>& cards) {
    std::vector<std::string> out;
    for (auto& c : cards) out.push_back(c.uid);
    return out;
}
using V = std::vector<std::string>;

static std::string pragma_text(sqlite3* db, const char* sql) {
    sqlite3_stmt* s = nullptr;
    sqlite3_prepare_v2(db, sql, -1, &s, nullptr);
    std::string out;
    if (sqlite3_step(s) == SQLITE_ROW) out = reinterpret_cast<const char*>(sqlite3_column_text(s, 0));
    sqlite3_finalize(s);
    return out;
}

int main() {
    cardtest::TempDir tmp;
    const fs::path path = tmp.path() / "data" / "cards.sqlite3";
    CHECK(!cardcatalog::exists(path));

    // ================= write side =================
    {
        cardcatalog::Writer w(path);
        CHECK(cardcatalog::exists(path));  // created, along with its parent directory

        std::set<std::string> indexes;
        {
            sqlite3_stmt* s = nullptr;
            sqlite3_prepare_v2(w.native_handle(), "PRAGMA index_list(cards)", -1, &s, nullptr);
            while (sqlite3_step(s) == SQLITE_ROW) indexes.insert(reinterpret_cast<const char*>(sqlite3_column_text(s, 1)));
            sqlite3_finalize(s);
        }
        for (const char* want : {"idx_cards_game_set_num", "idx_cards_game_passcode", "idx_cards_game_name",
                                 "idx_cards_vector_idx", "idx_cards_game_collector_number"})
            CHECK(indexes.count(want) == 1);
        CHECK_EQ(pragma_text(w.native_handle(), "PRAGMA journal_mode"), std::string("wal"));  // ingest runs in WAL mode

        // trailing duplicate exercises the in-batch dedupe (last wins)
        auto batch = kCards;
        auto dup = kCards[0];
        dup.rarity = "mythic";
        batch.push_back(dup);
        w.upsert_cards(batch);
        {
            cardcatalog::Reader r(path);
            CHECK_EQ(r.count(), static_cast<std::int64_t>(kCards.size()));
            CHECK_EQ(r.by_uid("mtg-1")->rarity, std::string("mythic"));  // last occurrence won
        }

        // ON CONFLICT (uid) DO UPDATE re-ingests cleanly
        auto updated = kCards[2];
        updated.rarity = "mythic";
        w.upsert_cards({updated});
        {
            cardcatalog::Reader r(path);
            CHECK_EQ(r.by_uid("mtg-3")->rarity, std::string("mythic"));
            CHECK_EQ(r.count(), static_cast<std::int64_t>(kCards.size()));
        }

        // backfill vector_idx
        std::vector<std::pair<std::int64_t, std::string>> pairs;
        for (size_t i = 0; i < kCards.size(); ++i) pairs.emplace_back(static_cast<std::int64_t>(i), kCards[i].uid);
        w.set_vector_indexes(pairs);
        {
            cardcatalog::Reader r(path);
            for (size_t i = 0; i < kCards.size(); ++i) CHECK_EQ(r.by_uid(kCards[i].uid)->vector_idx.value_or(-1), static_cast<std::int64_t>(i));
        }

        // re-ingesting a card keeps its image_path / vector_idx
        w.set_image_path("mtg-2", "card-images/mtg-2.jpg");
        w.upsert_cards({kCards[1]});
        {
            cardcatalog::Reader r(path);
            auto c = *r.by_uid("mtg-2");
            CHECK_EQ(c.image_path, std::string("card-images/mtg-2.jpg"));
            CHECK_EQ(c.vector_idx.value_or(-1), static_cast<std::int64_t>(1));
        }

        // cards_needing_vectors: has an image, no vector yet
        w.upsert_cards({{"new-1", "mtg", "Fresh Card", "NEW", "New", "1", "common", "", "http://example/new"}});
        w.set_image_path("new-1", "card-images/new-1.jpg");
        auto todo = w.cards_needing_vectors();
        CHECK_EQ(todo.size(), static_cast<size_t>(1));
        CHECK(todo[0].first == "new-1" && todo[0].second == "card-images/new-1.jpg");
        CHECK_EQ(w.cards_needing_vectors("pokemon").size(), static_cast<size_t>(0));
        CHECK_EQ(w.cards_needing_vectors("mtg").size(), static_cast<size_t>(1));
        w.set_vector_indexes({{99, "new-1"}});
        CHECK_EQ(w.cards_needing_vectors().size(), static_cast<size_t>(0));

        // name_lower is the Unicode-aware lowercase, not SQLite's ASCII-only lower()
        {
            cardcatalog::Reader r(path);
            CHECK_EQ(r.by_uid("mtg-4")->name_lower, std::string("übermut"));
        }

        // finalize: out of WAL mode, no -wal/-shm sidecars once closed, still complete
        w.finalize();
        CHECK_EQ(pragma_text(w.native_handle(), "PRAGMA journal_mode"), std::string("delete"));
    }
    {
        std::vector<std::string> leftovers;
        for (auto& e : fs::directory_iterator(path.parent_path()))
            if (e.path().filename().string().rfind("cards.sqlite3-", 0) == 0) leftovers.push_back(e.path().string());
        CHECK(leftovers.empty());
        cardcatalog::Reader r(path);
        CHECK_EQ(r.count(), static_cast<std::int64_t>(kCards.size() + 1));  // the finalized catalog is intact
    }

    // ================= read side =================
    // (rebuild the 7-card fixture with vector indexes 0..6 so the assertions match the Python test)
    fs::remove(path);
    {
        cardcatalog::Writer w(path);
        w.upsert_cards(kCards);
        std::vector<std::pair<std::int64_t, std::string>> pairs;
        for (size_t i = 0; i < kCards.size(); ++i) pairs.emplace_back(static_cast<std::int64_t>(i), kCards[i].uid);
        w.set_vector_indexes(pairs);
        w.finalize();
    }
    {
        cardcatalog::Reader r(path);

        auto card = r.lookup("mtg", "M10", "146");
        CHECK(card.has_value() && card->uid == "mtg-2" && card->set_name == "Magic 2010");
        CHECK(!r.lookup("mtg", "ZZZ", "1").has_value());           // miss
        CHECK(!r.lookup("mtg").has_value());                        // no fields -> nothing to match on
        CHECK_EQ(r.lookup("yugioh", "", "", "46986414")->uid, std::string("ygo-1"));
        CHECK_EQ(r.lookup("mtg", "", "232")->uid, std::string("mtg-3"));  // collector number alone
        CHECK(!r.lookup("pokemon", "LEA", "232").has_value());      // game is always part of the match

        // read-only connection: writes are rejected
        char* err = nullptr;
        int rc = sqlite3_exec(r.native_handle(), "UPDATE cards SET name='x' WHERE uid='mtg-1'", nullptr, nullptr, &err);
        CHECK(rc != SQLITE_OK);
        CHECK(err && std::string(err).find("readonly") != std::string::npos);
        sqlite3_free(err);

        CHECK_EQ(r.by_vector_idx(2, "mtg")->uid, std::string("mtg-3"));
        CHECK(!r.by_vector_idx(2, "pokemon").has_value());
        CHECK(!r.by_vector_idx(99, "mtg").has_value());

        auto printings = r.printings("mtg", "Lightning Bolt");
        std::sort(printings.begin(), printings.end(), [](auto& a, auto& b) { return a.uid < b.uid; });
        CHECK_EQ(printings.size(), static_cast<size_t>(2));
        CHECK(printings[0].uid == "mtg-1" && printings[0].vector_idx == 0);
        CHECK(printings[1].uid == "mtg-2" && printings[1].vector_idx == 1);

        // unique_names collapses printings to the smallest uid, ordered by name
        auto names = r.unique_names("mtg");
        CHECK_EQ(names.size(), static_cast<size_t>(4));
        std::set<std::pair<std::string, std::string>> got(names.begin(), names.end());
        std::set<std::pair<std::string, std::string>> want = {
            {"Black Lotus", "mtg-3"}, {"Lightning Bolt", "mtg-1"}, {"Übermut", "mtg-4"}, {"稲妻の剣", "mtg-5"}};
        CHECK(got == want);

        // search: prefix + substring, API-shaped rows, all games when none given
        CHECK(uids(r.search("mtg", "lightning")) == (V{"mtg-1", "mtg-2"}));
        CHECK(uids(r.search("mtg", "bolt")) == (V{"mtg-1", "mtg-2"}));  // mid-name
        CHECK_EQ(r.search("", "").size(), kCards.size());                // no query, no game: everything
        CHECK_EQ(r.search("not-a-game", "").size(), kCards.size());
        CHECK_EQ(r.search("mtg", "", 3).size(), static_cast<size_t>(3));  // limit
        // paging: pages follow one another without repeats or gaps, in the same order as one big read
        {
            auto everything = uids(r.search("", "", 100));
            V paged;
            for (int offset = 0; offset < 100; offset += 2) {
                auto page = uids(r.search("", "", 2, offset));
                if (page.empty()) break;
                paged.insert(paged.end(), page.begin(), page.end());
            }
            CHECK(paged == everything);
            CHECK_EQ(everything.size(), kCards.size());
            CHECK(r.search("", "", 2, 1000).empty());  // past the end
            CHECK(uids(r.search("mtg", "bolt", 1, 1)) == (V{"mtg-2"}));  // second page of a query (same name: uid breaks the tie)
        }
        auto bolt = r.search("mtg", "bolt");
        CHECK(bolt[0].set_code == "LEA" && bolt[0].image_url == "http://example/1.jpg");
        CHECK(uids(r.search("mtg", "  LIGHTNING  ")) == (V{"mtg-1", "mtg-2"}));  // trimmed, case-insensitive
        // SQLite's own lower() is ASCII-only; these only work because name_lower is stored
        CHECK(uids(r.search("mtg", "übermut")) == (V{"mtg-4"}));
        CHECK(uids(r.search("mtg", "ÜBERMUT")) == (V{"mtg-4"}));
        CHECK(uids(r.search("mtg", "稲妻")) == (V{"mtg-5"}));
        // prefix matches sort ahead of substring matches
        CHECK_EQ(r.search("mtg", "l").front().name, std::string("Lightning Bolt"));
        CHECK(uids(r.search("", "dark")) == (V{"ygo-1"}));  // across games

        // every column comes back (the Python test checked dict(row) had 12 keys)
        auto full = *r.by_uid("mtg-1");
        CHECK(!full.uid.empty() && !full.game.empty() && !full.name.empty() && !full.name_lower.empty() &&
              !full.set_code.empty() && !full.set_name.empty() && !full.collector_number.empty() && !full.rarity.empty() &&
              !full.image_url.empty());
        CHECK(full.vector_idx.has_value());
        CHECK(full.image_path.empty());  // NULL -> ""
    }

    // ---- 8 threads x 20 lookups, each with its own Reader: no cross-thread errors
    {
        std::atomic<int> errors{0};
        std::vector<std::thread> threads;
        for (int t = 0; t < 8; ++t)
            threads.emplace_back([&] {
                try {
                    for (int i = 0; i < 20; ++i) {
                        cardcatalog::Reader r(path);
                        auto c = r.lookup("mtg", "LEA", "232");
                        if (!c || c->uid != "mtg-3") ++errors;
                    }
                } catch (...) {
                    ++errors;
                }
            });
        for (auto& t : threads) t.join();
        CHECK_EQ(errors.load(), 0);
    }

    // ---- opening a missing catalog is an error, not a silent empty db
    bool threw = false;
    try {
        cardcatalog::Reader r(tmp.path() / "nope.sqlite3");
    } catch (const cardcatalog::Error&) {
        threw = true;
    }
    CHECK(threw);
    CHECK(!fs::exists(tmp.path() / "nope.sqlite3"));  // and it didn't create one

    return cardtest::finish("cardcatalog");
}
