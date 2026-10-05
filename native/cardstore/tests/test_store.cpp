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

    return cardtest::finish("cardstore");
}
