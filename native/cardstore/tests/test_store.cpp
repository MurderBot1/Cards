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

    return cardtest::finish("cardstore");
}
