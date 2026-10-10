#include <fstream>

#include "cardstore/store.hpp"
#include "cardtest.hpp"

namespace fs = std::filesystem;
using nlohmann::json;

int main() {
    cardtest::TempDir tmp;
    const fs::path db = tmp.path() / "sub" / "db.json";

    int next_id = 0;
    cardstore::Store store(db, [&] { return "id" + std::to_string(++next_id); });

    // ---- fresh db: nothing on disk until ensure_exists / first write
    CHECK(!fs::exists(db));
    CHECK_EQ(store.list_collections().body, json::array());
    CHECK_EQ(store.get_settings().body["theme"], json("dark"));
    CHECK_EQ(store.min_image_quality(), std::string("medium"));
    store.ensure_exists();
    CHECK(fs::exists(db));

    // ---- collections
    CHECK_EQ(store.create_collection({{"name", "   "}}).status, 400);
    CHECK_EQ(store.create_collection(json::object()).status, 400);
    CHECK_EQ(store.create_collection({{"name", 42}}).status, 400);
    auto created = store.create_collection({{"name", "  Binder A "}});
    CHECK_EQ(created.status, 201);
    CHECK_EQ(created.body["name"], json("Binder A"));  // trimmed
    CHECK_EQ(created.body["id"], json("id1"));
    CHECK_EQ(created.body["cards"], json::array());
    CHECK_EQ(store.get_collection("id1").status, 200);
    CHECK_EQ(store.get_collection("nope").status, 404);

    // ---- kinds of list: collection (default, not written down), deck, tradelist, wishlist
    CHECK(!created.body.contains("kind"));
    auto bad_kind = store.create_collection({{"name", "X"}, {"kind", "binder"}});
    CHECK_EQ(bad_kind.status, 400);
    CHECK_EQ(bad_kind.body["error"], json("kind must be one of ('collection', 'deck', 'tradelist', 'wishlist')"));
    CHECK_EQ(store.create_collection({{"name", "X"}, {"kind", 5}}).status, 400);
    CHECK_EQ(store.list_collections().body.size(), static_cast<size_t>(1));  // the refused ones were not made
    auto plain = store.create_collection({{"name", "Plain"}, {"kind", "collection"}});
    CHECK(!plain.body.contains("kind"));
    std::vector<std::string> kind_ids = {plain.body["id"].get<std::string>()};
    for (const char* k : {"deck", "tradelist", "wishlist"}) {
        auto made = store.create_collection({{"name", std::string("My ") + k}, {"kind", k}});
        CHECK_EQ(made.status, 201);
        CHECK_EQ(made.body["kind"], json(k));
        CHECK_EQ(store.get_collection(made.body["id"].get<std::string>()).body["kind"], json(k));
        kind_ids.push_back(made.body["id"].get<std::string>());
    }
    {
        // kinds travel through sync (a collection stays one, the others keep their kind)
        auto state = store.sync_state().body;
        int kinds_seen = 0;
        for (auto& c : state["collections"]) {
            if (c["id"] == "id1" || c["id"] == plain.body["id"]) CHECK(!c.contains("kind"));
            else kinds_seen += c.contains("kind") ? 1 : 0;
        }
        CHECK_EQ(kinds_seen, 3);
        json doc = {{"id", kind_ids[1]}, {"name", "My deck"}, {"kind", "deck"}, {"updated", 9999999999999LL}, {"cards", json::array()}};
        auto applied = store.sync_apply({{"collections", json::array({doc})}, {"expect", {{kind_ids[1], store.get_collection(kind_ids[1]).body["updated"]}}}});
        CHECK_EQ(applied.body["applied"].size(), static_cast<size_t>(1));
        CHECK_EQ(store.get_collection(kind_ids[1]).body["kind"], json("deck"));
        json remote = {{"id", "from-phone"}, {"name", "Wants"}, {"kind", "wishlist"}, {"updated", 9999999999999LL}, {"cards", json::array()}};
        store.sync_apply({{"collections", json::array({remote})}, {"expect", json::object()}});
        CHECK_EQ(store.get_collection("from-phone").body["kind"], json("wishlist"));
        kind_ids.push_back("from-phone");
    }
    for (auto& id : kind_ids) store.delete_collection(id);
    CHECK_EQ(store.list_collections().body.size(), static_cast<size_t>(1));

    // ---- a deck's game and format
    {
        auto deck = store.create_collection({{"name", "Burn"}, {"kind", "deck"}, {"game", "mtg"}, {"format", "modern"}});
        CHECK_EQ(deck.status, 201);
        const std::string deck_id = deck.body["id"].get<std::string>();
        CHECK_EQ(deck.body["game"], json("mtg"));
        CHECK_EQ(deck.body["format"], json("modern"));
        CHECK_EQ(store.get_collection(deck_id).body["format"], json("modern"));
        auto pokemon = store.create_collection({{"name", "Charizard"}, {"kind", "deck"}, {"game", "pokemon"}, {"format", "expanded"}});
        CHECK_EQ(pokemon.status, 201);
        auto yugioh = store.create_collection({{"name", "Blue-Eyes"}, {"kind", "deck"}, {"game", "yugioh"}, {"format", "speed"}});
        CHECK_EQ(yugioh.status, 201);
        auto none = store.create_collection({{"name", "Old style"}, {"kind", "deck"}});  // no game or format is still fine
        CHECK_EQ(none.status, 201);
        CHECK(!none.body.contains("game") && !none.body.contains("format"));
        // refused: a format of another game, an unknown game or format, one without the other, anything on a non-deck
        CHECK_EQ(store.create_collection({{"name", "X"}, {"kind", "deck"}, {"game", "pokemon"}, {"format", "modern"}}).status, 400);
        CHECK_EQ(store.create_collection({{"name", "X"}, {"kind", "deck"}, {"game", "digimon"}, {"format", "modern"}}).status, 400);
        CHECK_EQ(store.create_collection({{"name", "X"}, {"kind", "deck"}, {"game", "mtg"}}).status, 400);
        CHECK_EQ(store.create_collection({{"name", "X"}, {"kind", "deck"}, {"format", "modern"}}).status, 400);
        auto on_binder = store.create_collection({{"name", "X"}, {"game", "mtg"}, {"format", "modern"}});
        CHECK_EQ(on_binder.status, 400);
        CHECK_EQ(on_binder.body["error"], json("only a deck has a game and a format"));
        CHECK_EQ(store.list_collections().body.size(), static_cast<size_t>(5));  // id1 and the four decks; refused ones left no trace

        // changing them
        auto changed = store.update_collection(deck_id, {{"game", "mtg"}, {"format", "commander"}});
        CHECK_EQ(changed.status, 200);
        CHECK_EQ(changed.body["format"], json("commander"));
        CHECK_EQ(store.get_collection(deck_id).body["format"], json("commander"));
        auto old_id = none.body["id"].get<std::string>();
        CHECK_EQ(store.update_collection(old_id, {{"game", "yugioh"}, {"format", "advanced"}}).status, 200);  // an older deck can be given one
        CHECK_EQ(store.get_collection(old_id).body["game"], json("yugioh"));
        CHECK_EQ(store.update_collection(deck_id, {{"game", "mtg"}}).status, 400);
        CHECK_EQ(store.update_collection(deck_id, {{"game", "pokemon"}, {"format", "commander"}}).status, 400);
        CHECK_EQ(store.update_collection(deck_id, json::object()).status, 400);
        CHECK_EQ(store.update_collection("nope", {{"game", "mtg"}, {"format", "modern"}}).status, 404);
        CHECK_EQ(store.update_collection("id1", {{"game", "mtg"}, {"format", "modern"}}).status, 400);  // not a deck
        CHECK_EQ(store.get_collection(deck_id).body["format"], json("commander"));  // refused changes left it alone

        // they travel through sync
        bool seen = false;
        const json state_now = store.sync_state().body;
        for (auto& c : state_now["collections"])
            if (c["id"] == deck_id) { CHECK_EQ(c["game"], json("mtg")); CHECK_EQ(c["format"], json("commander")); seen = true; }
        CHECK(seen);
        json doc = {{"id", deck_id}, {"name", "Burn"}, {"kind", "deck"}, {"game", "mtg"}, {"format", "pauper"}, {"updated", 9999999999999LL}, {"cards", json::array()}};
        auto applied = store.sync_apply({{"collections", json::array({doc})}, {"expect", {{deck_id, store.get_collection(deck_id).body["updated"]}}}});
        CHECK_EQ(applied.body["applied"].size(), static_cast<size_t>(1));
        CHECK_EQ(store.get_collection(deck_id).body["format"], json("pauper"));
        json bad_doc = {{"id", "from-phone2"}, {"name", "Odd"}, {"kind", "deck"}, {"game", "pokemon"}, {"format", "modern"}, {"updated", 9999999999999LL}, {"cards", json::array()}};
        store.sync_apply({{"collections", json::array({bad_doc})}, {"expect", json::object()}});
        CHECK(!store.get_collection("from-phone2").body.contains("game"));  // a mismatched pair is not kept
        for (auto& made : {deck.body, pokemon.body, yugioh.body, none.body}) store.delete_collection(made["id"].get<std::string>());
        store.delete_collection("from-phone2");
        CHECK_EQ(store.list_collections().body.size(), static_cast<size_t>(1));
    }

    // ---- adding cards: validation
    const std::string cid = "id1";
    CHECK_EQ(store.add_card(cid, {{"game", "mtg"}}).status, 400);                      // no name
    CHECK_EQ(store.add_card(cid, {{"name", ""}, {"game", "mtg"}}).status, 400);        // empty name
    auto bad_game = store.add_card(cid, {{"name", "Bolt"}, {"game", "digimon"}});
    CHECK_EQ(bad_game.status, 400);
    CHECK_EQ(bad_game.body["error"], json("game must be one of ('mtg', 'pokemon', 'yugioh')"));
    auto bad_cond = store.add_card(cid, {{"name", "Bolt"}, {"game", "mtg"}, {"condition", "Mint"}});
    CHECK_EQ(bad_cond.status, 400);
    CHECK(bad_cond.body["error"].get<std::string>().find("Near Mint") != std::string::npos);
    CHECK_EQ(store.add_card("nope", {{"name", "Bolt"}, {"game", "mtg"}}).status, 404);

    // ---- adding cards: defaults, stacking
    json bolt = {{"name", "Lightning Bolt"}, {"game", "mtg"}, {"set", "M10"}, {"rarity", "common"}, {"image", "http://x/y.png"}};
    auto first = store.add_card(cid, bolt);
    CHECK_EQ(first.status, 201);
    CHECK_EQ(first.body["cards"].size(), static_cast<size_t>(1));
    auto card = first.body["cards"][0];
    CHECK_EQ(card["condition"], json("Near Mint"));  // default
    CHECK_EQ(card["quantity"], json(1));
    CHECK_EQ(card["rarity"], json("common"));
    CHECK_EQ(card["image"], json("http://x/y.png"));

    auto second = store.add_card(cid, bolt);  // identical -> stacks
    CHECK_EQ(second.body["cards"].size(), static_cast<size_t>(1));
    CHECK_EQ(second.body["cards"][0]["quantity"], json(2));

    json played = bolt;
    played["condition"] = "Heavily Played";  // same print, different condition -> new row
    CHECK_EQ(store.add_card(cid, played).body["cards"].size(), static_cast<size_t>(2));

    json other_set = bolt;
    other_set["set"] = "2XM";  // different set -> new row
    CHECK_EQ(store.add_card(cid, other_set).body["cards"].size(), static_cast<size_t>(3));

    // a card with no "set" is stored with "" and (as before) never stacks
    json no_set = {{"name", "Pikachu"}, {"game", "pokemon"}};
    CHECK_EQ(store.add_card(cid, no_set).body["cards"].size(), static_cast<size_t>(4));
    auto again = store.add_card(cid, no_set);
    CHECK_EQ(again.body["cards"].size(), static_cast<size_t>(5));
    CHECK_EQ(again.body["cards"][4]["set"], json(""));

    // ---- finish, language, collector number and quantity
    {
        auto c = store.create_collection({{"name", "Extras"}}).body["id"].get<std::string>();
        json foil_bolt = {{"name", "Bolt"}, {"game", "mtg"}, {"set", "M10"}, {"foil", true}, {"language", "Japanese"}, {"number", "146"}, {"quantity", 3}};
        auto r = store.add_card(c, foil_bolt);
        auto k = r.body["cards"][0];
        CHECK_EQ(k["quantity"], json(3));
        CHECK_EQ(k["foil"], json(true));
        CHECK_EQ(k["language"], json("Japanese"));
        CHECK_EQ(k["number"], json("146"));
        CHECK_EQ(store.add_card(c, foil_bolt).body["cards"][0]["quantity"], json(6));  // identical: stacks, adding the copies
        json plain = foil_bolt;
        plain.erase("foil");
        CHECK_EQ(store.add_card(c, plain).body["cards"].size(), static_cast<size_t>(2));    // not foil: its own row
        CHECK(!store.get_collection(c).body["cards"][1].contains("foil"));                   // (nothing stored for "no")
        json other_number = foil_bolt;
        other_number["number"] = "147";
        CHECK_EQ(store.add_card(c, other_number).body["cards"].size(), static_cast<size_t>(3));
        json english = foil_bolt;
        english.erase("language");
        CHECK_EQ(store.add_card(c, english).body["cards"].size(), static_cast<size_t>(4));
        CHECK_EQ(store.add_card(c, {{"name", "X"}, {"game", "mtg"}, {"set", "A"}, {"quantity", 0}}).status, 400);
        CHECK_EQ(store.add_card(c, {{"name", "X"}, {"game", "mtg"}, {"set", "A"}, {"quantity", 1.5}}).status, 400);
        store.delete_collection(c);
    }

    // ---- bulk add
    {
        auto c = store.create_collection({{"name", "Bulk"}}).body["id"].get<std::string>();
        CHECK_EQ(store.add_cards(c, json::array()).status, 400);
        CHECK_EQ(store.add_cards(c, {{"cards", json::array()}}).status, 400);
        CHECK_EQ(store.add_cards("nope", {{"cards", json::array({{{"name", "A"}, {"game", "mtg"}}})}}).status, 404);
        json cards = json::array({{{"name", "A"}, {"game", "mtg"}, {"set", "S"}, {"quantity", 2}},
                                  {{"name", "B"}, {"game", "pokemon"}, {"set", "S"}},
                                  {{"name", "A"}, {"game", "mtg"}, {"set", "S"}}});  // stacks onto the first
        auto r = store.add_cards(c, {{"cards", cards}});
        CHECK_EQ(r.status, 201);
        CHECK_EQ(r.body["cards"].size(), static_cast<size_t>(2));
        CHECK_EQ(r.body["cards"][0]["quantity"], json(3));
        // one bad row and nothing at all is added
        json mixed = json::array({{{"name", "C"}, {"game", "mtg"}, {"set", "S"}}, {{"name", "D"}, {"game", "digimon"}}});
        auto bad = store.add_cards(c, {{"cards", mixed}});
        CHECK_EQ(bad.status, 400);
        CHECK(bad.body["error"].get<std::string>().rfind("card 2: game must be one of", 0) == 0);
        CHECK_EQ(store.get_collection(c).body["cards"].size(), static_cast<size_t>(2));
        CHECK_EQ(store.add_cards(c, {{"cards", json::array({5})}}).status, 400);
        store.delete_collection(c);
    }

    // ---- updating cards
    const std::string bolt_id = second.body["cards"][0]["id"].get<std::string>();
    CHECK_EQ(store.update_card(cid, bolt_id, json::object()).status, 400);
    CHECK_EQ(store.update_card(cid, bolt_id, {{"condition", "Pristine"}}).status, 400);
    CHECK_EQ(store.update_card(cid, bolt_id, {{"quantity", "lots"}}).status, 400);
    CHECK_EQ(store.update_card("nope", bolt_id, {{"quantity", 3}}).status, 404);

    auto upd = store.update_card(cid, bolt_id, {{"quantity", 5}, {"condition", "Damaged"}});
    CHECK_EQ(upd.status, 200);
    CHECK_EQ(upd.body["cards"][0]["quantity"], json(5));
    CHECK_EQ(upd.body["cards"][0]["condition"], json("Damaged"));

    auto only_cond = store.update_card(cid, bolt_id, {{"condition", "Lightly Played"}, {"quantity", nullptr}});
    CHECK_EQ(only_cond.body["cards"][0]["quantity"], json(5));  // null quantity == not provided
    CHECK_EQ(only_cond.body["cards"][0]["condition"], json("Lightly Played"));

    auto removed = store.update_card(cid, bolt_id, {{"quantity", 0}});  // <= 0 deletes the row
    CHECK_EQ(removed.status, 200);
    CHECK_EQ(removed.body["cards"].size(), static_cast<size_t>(4));
    for (auto& c : removed.body["cards"]) CHECK(c["id"] != json(bolt_id));

    // ---- persistence: a fresh Store over the same file sees everything
    {
        cardstore::Store reopened(db);
        auto list = reopened.list_collections();
        CHECK_EQ(list.body.size(), static_cast<size_t>(1));
        CHECK_EQ(list.body[0]["cards"].size(), static_cast<size_t>(4));
    }

    // ---- settings merge instead of replace
    auto s = store.update_settings({{"theme", "light"}, {"minImageQuality", "high"}, {"custom", 1}});
    CHECK_EQ(s.body["theme"], json("light"));
    CHECK_EQ(s.body["fontSize"], json("medium"));  // untouched default survives
    CHECK_EQ(s.body["custom"], json(1));
    CHECK_EQ(store.min_image_quality(), std::string("high"));
    CHECK_EQ(store.update_settings(json::array()).status, 400);

    // ---- delete
    CHECK_EQ(store.delete_collection("nope").status, 404);
    auto del = store.delete_collection(cid);
    CHECK_EQ(del.status, 200);
    CHECK_EQ(del.body["deleted"], json(true));
    CHECK_EQ(store.list_collections().body, json::array());

    // ---- no leftover temp file; corrupt file is reported, not silently reset
    CHECK(!fs::exists(fs::path(db.string() + ".tmp")));
    std::ofstream(db) << "{not json";
    bool threw = false;
    try {
        store.list_collections();
    } catch (const std::exception&) {
        threw = true;
    }
    CHECK(threw);

    // ---- default ids are 8 hex chars
    cardtest::TempDir tmp2;
    cardstore::Store rnd(tmp2.path() / "db.json");
    auto c = rnd.create_collection({{"name", "x"}});
    auto id = c.body["id"].get<std::string>();
    CHECK_EQ(id.size(), static_cast<size_t>(8));
    CHECK(id.find_first_not_of("0123456789abcdef") == std::string::npos);

    // ---- sync: stamps, tombstones, state export and apply
    {
        cardtest::TempDir t3;
        long long clock = 1000;
        int n = 0;
        cardstore::Store st(t3.path() / "db.json", [&] { return "s" + std::to_string(++n); }, [&] { return clock += 10; });

        auto col = st.create_collection({{"name", "Sync me"}});  // s1, updated 1010
        CHECK_EQ(col.body["updated"], json(1010));
        json bolt = {{"id", "mtg-abc"}, {"name", "Bolt"}, {"game", "mtg"}, {"set", "M10"}};
        auto added = st.add_card("s1", bolt);  // card s2, stamped 1020
        CHECK_EQ(added.body["cards"][0]["uid"], json("mtg-abc"));  // the catalog id is kept as uid
        CHECK_EQ(added.body["cards"][0]["updated"], json(1020));
        CHECK_EQ(added.body["updated"], json(1020));
        st.add_card("s1", bolt);  // stacks: same card, newer stamp
        CHECK_EQ(st.get_collection("s1").body["cards"][0]["updated"], json(1030));
        CHECK_EQ(st.update_card("s1", "s2", json::object()).status, 400);
        CHECK_EQ(st.update_card("s1", "s2", {{"uid", 5}}).status, 400);
        CHECK_EQ(st.update_card("s1", "s2", {{"uid", "mtg-def"}}).status, 200);  // uid alone is a valid update (backfill)
        CHECK_EQ(st.get_collection("s1").body["cards"][0]["uid"], json("mtg-def"));

        auto state = st.sync_state().body;
        CHECK_EQ(state["collections"].size(), static_cast<size_t>(1));
        CHECK_EQ(state["collections"][0]["updated"], json(1040));
        CHECK_EQ(state["collections"][0]["tomb"], json::object());
        CHECK_EQ(state["deleted"], json::array());

        // removing a card leaves a tombstone and bumps the collection
        st.update_card("s1", "s2", {{"quantity", 0}});
        auto after_remove = st.sync_state().body["collections"][0];
        CHECK_EQ(after_remove["cards"].size(), static_cast<size_t>(0));
        CHECK_EQ(after_remove["tomb"]["s2"], json(1050));
        CHECK_EQ(after_remove["updated"], json(1050));

        // apply: a merged doc replaces the collection when nothing changed since the request...
        json merged = {{"id", "s1"}, {"name", "Sync me"}, {"updated", 2000},
                       {"cards", json::array({{{"id", "s9"}, {"name", "Other"}, {"game", "mtg"}, {"quantity", 2}, {"updated", 2000}}})},
                       {"tomb", {{"s2", 1050}}}};
        auto ok = st.sync_apply({{"collections", json::array({merged})}, {"expect", {{"s1", 1050}}}});
        CHECK_EQ(ok.status, 200);
        CHECK_EQ(ok.body["applied"], json::array({"s1"}));
        CHECK_EQ(st.get_collection("s1").body["cards"][0]["id"], json("s9"));
        CHECK_EQ(st.get_collection("s1").body["updated"], json(2000));

        // ...but is skipped if the collection was edited after the sync started
        st.update_card("s1", "s9", {{"quantity", 5}});  // 1060
        auto stale = st.sync_apply({{"collections", json::array({merged})}, {"expect", {{"s1", 2000}}}});
        CHECK_EQ(stale.body["skipped"], json::array({"s1"}));
        CHECK_EQ(st.get_collection("s1").body["cards"][0]["quantity"], json(5));

        // a new collection from another device is added; one we didn't expect to exist is skipped
        json other = {{"id", "x1"}, {"name", "From phone"}, {"updated", 3000}, {"cards", json::array()}};
        auto added_remote = st.sync_apply({{"collections", json::array({other})}, {"expect", json::object()}});
        CHECK_EQ(added_remote.body["applied"], json::array({"x1"}));
        CHECK_EQ(st.list_collections().body.size(), static_cast<size_t>(2));
        auto unexpected = st.sync_apply({{"collections", json::array({other})}, {"expect", {{"x1", 3000}, {"zz", 1}}}});
        CHECK_EQ(unexpected.body["applied"], json::array({"x1"}));
        CHECK_EQ(st.sync_apply({{"collections", json::array({{{"id", "zz"}, {"name", "n"}, {"cards", json::array()}}})},
                                {"expect", {{"zz", 1}}}}).body["skipped"], json::array({"zz"}));  // it vanished meanwhile

        // deleting records a tombstone; a remote deletion removes the collection and records it too
        st.delete_collection("s1");
        auto after_delete = st.sync_state().body;
        CHECK_EQ(after_delete["deleted"].size(), static_cast<size_t>(1));
        CHECK_EQ(after_delete["deleted"][0]["id"], json("s1"));
        auto gone = st.sync_apply({{"collections", json::array({{{"id", "x1"}, {"deleted", 4000}}})}, {"expect", {{"x1", 3000}}}});
        CHECK_EQ(gone.body["applied"], json::array({"x1"}));
        CHECK_EQ(st.list_collections().body.size(), static_cast<size_t>(0));
        CHECK_EQ(st.sync_state().body["deleted"].size(), static_cast<size_t>(2));
        // a collection that comes back (edited after it was deleted elsewhere) clears its tombstone
        auto back = st.sync_apply({{"collections", json::array({{{"id", "x1"}, {"name", "Back"}, {"updated", 5000}, {"cards", json::array()}}})},
                                   {"expect", json::object()}});
        CHECK_EQ(back.body["applied"], json::array({"x1"}));
        CHECK_EQ(st.sync_state().body["deleted"].size(), static_cast<size_t>(1));
        CHECK_EQ(st.sync_apply(json::array()).status, 400);

        // data written before stamps existed reads as updated = 1
        std::ofstream(t3.path() / "old.json") << R"({"collections":[{"id":"o1","name":"Old","cards":[{"id":"c1","name":"X","game":"mtg","quantity":1}]}],"settings":{}})";
        cardstore::Store old(t3.path() / "old.json");
        auto old_state = old.sync_state().body["collections"][0];
        CHECK_EQ(old_state["updated"], json(1));
        CHECK_EQ(old_state["cards"][0]["updated"], json(1));
    }

    // ---- limits: 25 collections (10,000 cards, 1,000 each), 100 decks (150 cards, 100 each),
    //      the tradelist and the wishlist (10,000 cards, no limit on copies, one list of each)
    {
        cardtest::TempDir t4;
        int n = 0;
        cardstore::Store st(t4.path() / "db.json", [&] { return "L" + std::to_string(++n); });
        auto make = [&](const char* kind) { return st.create_collection({{"name", "list"}, {"kind", kind}}); };
        std::string first_collection;
        for (int i = 0; i < 25; ++i) {
            auto r = make("collection");
            CHECK_EQ(r.status, 201);
            if (i == 0) first_collection = r.body["id"].get<std::string>();
        }
        auto over_collections = make("collection");
        CHECK_EQ(over_collections.status, 400);
        CHECK_EQ(over_collections.body["error"], json("You can have at most 25 collections"));
        CHECK_EQ(st.list_collections().body.size(), static_cast<size_t>(25));
        std::string a_deck;
        for (int i = 0; i < 100; ++i) {
            auto r = make("deck");  // decks are counted apart from collections
            CHECK_EQ(r.status, 201);
            if (i == 0) a_deck = r.body["id"].get<std::string>();
        }
        CHECK_EQ(make("deck").body["error"], json("You can have at most 100 decks"));
        // one wishlist and one tradelist, not several
        auto w = make("wishlist");
        auto t = make("tradelist");
        CHECK_EQ(w.status, 201);
        CHECK_EQ(t.status, 201);
        std::string a_wishlist = w.body["id"].get<std::string>();
        std::string a_tradelist = t.body["id"].get<std::string>();
        CHECK_EQ(make("wishlist").body["error"], json("You can only have one wishlist"));
        CHECK_EQ(make("tradelist").body["error"], json("You can only have one tradelist"));
        CHECK_EQ(st.list_collections().body.size(), static_cast<size_t>(25 + 100 + 2));
        CHECK_EQ(st.delete_collection(a_wishlist).status, 200);
        auto new_wishlist = make("wishlist");  // deleting it frees the place
        CHECK_EQ(new_wishlist.status, 201);
        a_wishlist = new_wishlist.body["id"].get<std::string>();
        // deleting one frees a place
        CHECK_EQ(st.delete_collection(a_deck).status, 200);
        auto replacement = make("deck");
        CHECK_EQ(replacement.status, 201);

        auto card = [](const std::string& name) { return json{{"name", name}, {"game", "mtg"}, {"set", "M10"}}; };
        auto with_qty = [&](const std::string& name, long long q) { auto c = card(name); c["quantity"] = q; return c; };
        // copies of one card
        CHECK_EQ(st.add_card(first_collection, with_qty("Bolt", 1000)).status, 201);
        auto too_many = st.add_card(first_collection, card("Bolt"));  // 1001st copy stacks onto the row
        CHECK_EQ(too_many.status, 400);
        CHECK_EQ(too_many.body["error"], json("A collection can hold at most 1,000 copies of one card"));
        CHECK_EQ(st.add_card(first_collection, with_qty("Sol Ring", 1001)).status, 400);
        auto bolt_id = st.get_collection(first_collection).body["cards"][0]["id"].get<std::string>();
        CHECK_EQ(st.update_card(first_collection, bolt_id, {{"quantity", 1001}}).status, 400);
        CHECK_EQ(st.update_card(first_collection, bolt_id, {{"quantity", 999}}).status, 200);
        CHECK_EQ(st.get_collection(first_collection).body["cards"].size(), static_cast<size_t>(1));  // refused ones left no trace
        CHECK_EQ(st.get_collection(first_collection).body["cards"][0]["quantity"], json(999));

        // decks: 150 different cards, 100 copies of each
        auto deck = replacement.body["id"].get<std::string>();
        for (int i = 0; i < 150; ++i) CHECK_EQ(st.add_card(deck, card("Card " + std::to_string(i))).status, 201);
        auto deck_full = st.add_card(deck, card("One More"));
        CHECK_EQ(deck_full.status, 400);
        CHECK_EQ(deck_full.body["error"], json("A deck can hold at most 150 different cards"));
        CHECK_EQ(st.add_card(deck, card("Card 7")).status, 201);  // another copy of a card already there is fine
        CHECK_EQ(st.add_card(deck, with_qty("Card 7", 98)).status, 201);  // 1 + 1 + 98 = 100
        auto deck_copies = st.add_card(deck, card("Card 7"));
        CHECK_EQ(deck_copies.status, 400);
        CHECK_EQ(deck_copies.body["error"], json("A deck can hold at most 100 copies of one card"));
        CHECK_EQ(st.get_collection(deck).body["cards"].size(), static_cast<size_t>(150));

        // bulk add is all or nothing under the same limits (the row number is named)
        auto bulk = st.add_cards(deck, {{"cards", json::array({card("Card 1"), card("Brand New")})}});
        CHECK_EQ(bulk.status, 400);
        CHECK(bulk.body["error"].get<std::string>().rfind("card 2: A deck can hold at most 150", 0) == 0);
        CHECK_EQ(st.get_collection(deck).body["cards"][1]["quantity"], json(1));  // card 1 was not added to

        // wishlists and tradelists: no limit on copies; 10,000 different cards
        CHECK_EQ(st.add_card(a_wishlist, with_qty("Bulk", 50000)).status, 201);
        CHECK_EQ(st.add_card(a_wishlist, with_qty("Bulk", 50000)).status, 201);
        json many = json::array();
        for (int i = 0; i < 9999; ++i) many.push_back(card("W" + std::to_string(i)));
        CHECK_EQ(st.add_cards(a_tradelist, {{"cards", many}}).status, 201);  // 9,999 rows
        CHECK_EQ(st.add_card(a_tradelist, card("The 10000th")).status, 201);
        auto trade_full = st.add_card(a_tradelist, card("The 10001st"));
        CHECK_EQ(trade_full.status, 400);
        CHECK_EQ(trade_full.body["error"], json("A tradelist can hold at most 10,000 different cards"));

        // a list that already holds more than it may (saved before limits) can still be lowered and read
        std::ofstream(t4.path() / "big.json") << R"({"collections":[{"id":"b1","name":"Big","cards":[{"id":"c1","name":"X","game":"mtg","set":"","quantity":5000,"condition":"Near Mint"}]}],"settings":{}})";
        cardstore::Store big(t4.path() / "big.json");
        CHECK_EQ(big.add_card("b1", json{{"name", "X"}, {"game", "mtg"}, {"set", ""}}).status, 400);
        CHECK_EQ(big.update_card("b1", "c1", {{"quantity", 4000}}).status, 400);
        CHECK_EQ(big.update_card("b1", "c1", {{"quantity", 0}}).status, 200);  // removing is always allowed
    }

    // ---- decks: which cards the person has (`owned`)
    {
        cardtest::TempDir t5;
        long long clock = 5000;
        int n = 0;
        cardstore::Store st(t5.path() / "db.json", [&] { return "D" + std::to_string(++n); }, [&] { return clock += 10; });
        auto deck = st.create_collection({{"name", "Burn"}, {"kind", "deck"}}).body["id"].get<std::string>();
        auto plain = st.create_collection({{"name", "Binder"}}).body["id"].get<std::string>();
        auto want = st.create_collection({{"name", "Wants"}, {"kind", "wishlist"}}).body["id"].get<std::string>();
        auto card = [](const std::string& name, long long qty) { return json{{"name", name}, {"game", "mtg"}, {"set", "M10"}, {"quantity", qty}}; };
        auto bolt = st.add_card(deck, card("Bolt", 4)).body["cards"][0]["id"].get<std::string>();
        auto ring = st.add_card(deck, card("Sol Ring", 1)).body["cards"][1]["id"].get<std::string>();
        auto row = [&](const std::string& list, const std::string& id) {
            auto got = st.get_collection(list);
            for (auto& c : got.body["cards"]) if (c["id"] == id) return c;
            return json();
        };
        CHECK(!row(deck, bolt).contains("owned"));  // nothing had until said

        // one card
        CHECK_EQ(st.update_card(deck, bolt, {{"owned", 3}}).status, 200);
        CHECK_EQ(row(deck, bolt)["owned"], json(3));
        CHECK_EQ(st.update_card(deck, bolt, {{"owned", 99}}).status, 200);
        CHECK_EQ(row(deck, bolt)["owned"], json(4));  // never more than needed
        CHECK_EQ(st.update_card(deck, bolt, {{"quantity", 2}}).status, 200);
        CHECK_EQ(row(deck, bolt)["owned"], json(2));  // lowering what is needed lowers what is had
        CHECK_EQ(st.update_card(deck, bolt, {{"owned", 0}}).status, 200);
        CHECK(!row(deck, bolt).contains("owned"));    // zero is not written down
        CHECK_EQ(st.update_card(deck, bolt, {{"owned", -1}}).body["error"], json("owned must be a whole number of at least 0"));
        CHECK_EQ(st.update_card(deck, bolt, {{"owned", 1.5}}).status, 400);
        CHECK_EQ(st.update_card(deck, bolt, {{"owned", "two"}}).status, 400);
        CHECK_EQ(st.update_card(deck, bolt, {{"owned", 2}, {"quantity", 6}}).status, 200);
        CHECK_EQ(row(deck, bolt)["owned"], json(2));
        CHECK_EQ(row(deck, bolt)["quantity"], json(6));

        // only decks
        auto in_binder = st.add_card(plain, card("Bolt", 2)).body["cards"][0]["id"].get<std::string>();
        auto refused = st.update_card(plain, in_binder, {{"owned", 1}});
        CHECK_EQ(refused.status, 400);
        CHECK_EQ(refused.body["error"], json("only a deck keeps track of the cards you have"));
        CHECK_EQ(st.update_card(want, "x", {{"owned", 1}}).status, 400);

        // many at once: unknown ids are ignored, values are kept to what is needed, one stamp for what changed
        const long long before = st.get_collection(deck).body["updated"].get<long long>();
        auto many = st.set_owned(deck, {{"owned", {{bolt, 9}, {ring, 1}, {"nope", 5}}}});
        CHECK_EQ(many.status, 200);
        CHECK_EQ(row(deck, bolt)["owned"], json(6));
        CHECK_EQ(row(deck, ring)["owned"], json(1));
        CHECK(many.body["updated"].get<long long>() > before);
        const long long after = st.get_collection(deck).body["updated"].get<long long>();
        st.set_owned(deck, {{"owned", {{bolt, 6}}}});  // no change: nothing is stamped
        CHECK_EQ(st.get_collection(deck).body["updated"].get<long long>(), after);
        CHECK_EQ(st.set_owned(deck, {{"owned", {{bolt, 0}, {ring, 0}}}}).status, 200);
        CHECK(!row(deck, bolt).contains("owned"));
        CHECK_EQ(st.set_owned(deck, json::object()).status, 400);
        CHECK_EQ(st.set_owned(deck, {{"owned", json::array()}}).status, 400);
        CHECK_EQ(st.set_owned(deck, {{"owned", {{bolt, -2}}}}).status, 400);
        CHECK_EQ(st.set_owned(plain, {{"owned", {{in_binder, 1}}}}).status, 400);
        CHECK_EQ(st.set_owned("zzz", {{"owned", json::object()}}).status, 404);

        // an import into a deck can say what is had; elsewhere it is left out; stacking adds up (never over what is needed)
        auto imported = st.add_cards(deck, {{"cards", json::array({json{{"name", "Shock"}, {"game", "mtg"}, {"set", "M10"}, {"quantity", 3}, {"owned", 2}},
                                                                    json{{"name", "Shock"}, {"game", "mtg"}, {"set", "M10"}, {"quantity", 3}, {"owned", 9}}})}});
        CHECK_EQ(imported.status, 201);
        auto shock = imported.body["cards"].back();
        CHECK_EQ(shock["quantity"], json(6));
        CHECK_EQ(shock["owned"], json(6));
        auto into_binder = st.add_cards(plain, {{"cards", json::array({json{{"name", "Shock"}, {"game", "mtg"}, {"set", "M10"}, {"owned", 2}}})}});
        CHECK(!into_binder.body["cards"].back().contains("owned"));

        // it travels through sync with the card
        auto doc = st.sync_state().body["collections"][0];
        CHECK(doc["kind"] == "deck");
        bool seen = false;
        for (auto& c : doc["cards"]) if (c["name"] == "Shock") seen = c["owned"] == json(6);
        CHECK(seen);
    }

    // ---- moving copies of a card to another list
    {
        cardtest::TempDir t6;
        long long clock = 9000;
        int n = 0;
        cardstore::Store st(t6.path() / "db.json", [&] { return "M" + std::to_string(++n); }, [&] { return clock += 10; });
        auto make = [&](const char* name, const char* kind) { return st.create_collection({{"name", name}, {"kind", kind}}).body["id"].get<std::string>(); };
        auto a = make("A", "collection");
        auto b = make("B", "collection");
        auto deck = make("Deck", "deck");
        auto list = [&](const std::string& id) { return st.get_collection(id).body; };
        auto bolt_body = json{{"name", "Bolt"}, {"game", "mtg"}, {"set", "M11"}, {"rarity", "Common"}, {"image", "http://x/b.jpg"}, {"id", "mtg-bolt"},
                              {"condition", "Lightly Played"}, {"foil", true}, {"language", "Japanese"}, {"number", "146"}, {"quantity", 5}};
        auto bolt = st.add_card(a, bolt_body).body["cards"][0]["id"].get<std::string>();
        auto url = [&](const std::string& to, json extra = json::object()) { json body = {{"to", to}}; body.update(extra); return body; };

        // some of the copies: the rest stay, the moved ones arrive with everything the card has
        auto some = st.move_card(a, bolt, url(b, {{"quantity", 2}}));
        CHECK_EQ(some.status, 200);
        CHECK_EQ(some.body["source"]["cards"][0]["quantity"], json(3));
        CHECK_EQ(some.body["target"]["cards"][0]["quantity"], json(2));
        auto moved = some.body["target"]["cards"][0];
        CHECK_EQ(moved["name"], json("Bolt"));
        CHECK_EQ(moved["set"], json("M11"));
        CHECK_EQ(moved["condition"], json("Lightly Played"));
        CHECK_EQ(moved["foil"], json(true));
        CHECK_EQ(moved["language"], json("Japanese"));
        CHECK_EQ(moved["number"], json("146"));
        CHECK_EQ(moved["uid"], json("mtg-bolt"));
        CHECK_EQ(moved["image"], json("http://x/b.jpg"));
        CHECK(moved["id"] != json(bolt));  // a row of its own in the other list
        CHECK_EQ(list(b)["cards"][0]["quantity"], json(2));
        CHECK(list(a)["updated"].get<long long>() > 9000 && list(b)["updated"].get<long long>() > 9000);

        // moving more onto the same card stacks
        CHECK_EQ(st.move_card(a, bolt, url(b, {{"quantity", 1}})).status, 200);
        CHECK_EQ(list(b)["cards"].size(), static_cast<size_t>(1));
        CHECK_EQ(list(b)["cards"][0]["quantity"], json(3));

        // all of them (the default): the row goes, with a tombstone so other devices drop it too
        auto rest = st.move_card(a, bolt, url(b));
        CHECK_EQ(rest.status, 200);
        CHECK_EQ(rest.body["source"]["cards"].size(), static_cast<size_t>(0));
        CHECK(rest.body["source"]["tomb"].contains(bolt));
        CHECK_EQ(list(b)["cards"][0]["quantity"], json(5));

        // refusals change nothing
        auto id_in_b = list(b)["cards"][0]["id"].get<std::string>();
        CHECK_EQ(st.move_card(b, id_in_b, json::object()).body["error"], json("to must be the id of another list"));
        CHECK_EQ(st.move_card(b, id_in_b, {{"to", 7}}).status, 400);
        CHECK_EQ(st.move_card(b, id_in_b, url(b)).body["error"], json("choose a different list to move it to"));
        CHECK_EQ(st.move_card(b, id_in_b, url("nope")).status, 404);
        CHECK_EQ(st.move_card("nope", id_in_b, url(a)).status, 404);
        CHECK_EQ(st.move_card(b, "nope", url(a)).status, 404);
        for (json bad : {json(0), json(6), json(-1), json(1.5), json("2")}) {
            auto r = st.move_card(b, id_in_b, url(a, {{"quantity", bad}}));
            CHECK_EQ(r.status, 400);
            CHECK_EQ(r.body["error"], json("quantity must be a whole number from 1 to 5"));
        }
        CHECK_EQ(list(b)["cards"][0]["quantity"], json(5));
        CHECK_EQ(list(a)["cards"].size(), static_cast<size_t>(0));

        // the other list's limits hold, and then nothing leaves the source
        auto deck_card = [&](const std::string& name, long long q) { return json{{"name", name}, {"game", "mtg"}, {"set", "M10"}, {"quantity", q}}; };
        auto big = st.add_card(a, deck_card("Big", 101)).body["cards"][0]["id"].get<std::string>();
        auto over = st.move_card(a, big, url(deck));
        CHECK_EQ(over.status, 400);
        CHECK_EQ(over.body["error"], json("A deck can hold at most 100 copies of one card"));
        CHECK_EQ(list(a)["cards"][0]["quantity"], json(101));
        CHECK_EQ(list(deck)["cards"].size(), static_cast<size_t>(0));
        CHECK_EQ(st.move_card(a, big, url(deck, {{"quantity", 100}})).status, 200);
        CHECK_EQ(list(a)["cards"][0]["quantity"], json(1));
        CHECK_EQ(list(deck)["cards"][0]["quantity"], json(100));
        CHECK(!list(deck)["cards"][0].contains("owned"));  // nothing is had until said

        // out of a deck: what is had is kept to what is still needed
        CHECK_EQ(st.update_card(deck, list(deck)["cards"][0]["id"].get<std::string>(), {{"owned", 90}}).status, 200);
        CHECK_EQ(st.move_card(deck, list(deck)["cards"][0]["id"].get<std::string>(), url(b, {{"quantity", 30}})).status, 200);
        CHECK_EQ(list(deck)["cards"][0]["quantity"], json(70));
        CHECK_EQ(list(deck)["cards"][0]["owned"], json(70));
    }

    return cardtest::finish("cardstore");
}
