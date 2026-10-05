// Ingest against fixtures shaped like the real APIs' responses, through a fake transport — no network.
#include <zlib.h>

#include <fstream>
#include <map>
#include <mutex>

#include "cardingest/ingest.hpp"
#include "cardtest.hpp"

namespace fs = std::filesystem;
using nlohmann::json;

namespace {

std::string gzip(const std::string& data) {
    z_stream zs{};
    deflateInit2(&zs, Z_DEFAULT_COMPRESSION, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY);
    std::string out(deflateBound(&zs, static_cast<uLong>(data.size())) + 64, '\0');
    zs.next_in = reinterpret_cast<Bytef*>(const_cast<char*>(data.data()));
    zs.avail_in = static_cast<uInt>(data.size());
    zs.next_out = reinterpret_cast<Bytef*>(out.data());
    zs.avail_out = static_cast<uInt>(out.size());
    deflate(&zs, Z_FINISH);
    out.resize(out.size() - zs.avail_out);
    deflateEnd(&zs);
    return out;
}

class FakeTransport : public cardfetch::Transport {
public:
    std::map<std::string, std::pair<long, std::string>> pages;
    std::map<std::string, int> hits;
    std::mutex mu;

    cardfetch::Response get(const std::string& url, int) override {
        std::lock_guard<std::mutex> l(mu);
        ++hits[url];
        auto it = pages.find(url);
        if (it == pages.end()) return {404, ""};
        return {it->second.first, it->second.second};
    }
    long get_to_file(const std::string& url, int timeout, const fs::path& dest) override {
        auto r = get(url, timeout);
        if (cardfetch::is_success(r.status)) {
            fs::create_directories(dest.parent_path());
            std::ofstream(dest, std::ios::binary) << r.body;
        }
        return r.status;
    }
};

std::vector<std::string> logs;
cardingest::Log log_fn = [](const std::string& m) { logs.push_back(m); };

const cardingest::Sources kSources;  // the real URLs; the fake transport answers for them

std::optional<cardcatalog::Card> card(const fs::path& db, const std::string& uid) {
    cardcatalog::Reader r(db);
    return r.by_uid(uid);
}

}  // namespace

int main() {
    cardtest::TempDir tmp;
    const fs::path db = tmp.path() / "cards.sqlite3";
    FakeTransport net;
    cardfetch::Fetcher fetcher(net, tmp.path() / "cache");
    cardcatalog::Writer writer(db);

    // ============================ MTG ============================
    {
        json index = {{"data", json::array({{{"type", "default_cards"}, {"jsonl_download_uri", "http://x/default.gz"}},
                                            {{"type", "all_cards"}, {"jsonl_download_uri", "http://x/all.gz"}, {"size", 2300000000.0}}})}};
        net.pages[kSources.scryfall_bulk_index] = {200, index.dump()};

        std::string jsonl;
        auto line = [&](const json& j) { jsonl += j.dump() + "\n"; };
        line({{"id", "aaa"}, {"name", "Lightning Bolt"}, {"set", "m10"}, {"set_name", "Magic 2010"}, {"collector_number", "146"},
              {"rarity", "common"}, {"layout", "normal"}, {"image_uris", {{"normal", "http://img/bolt.jpg"}, {"small", "http://img/bolt-s.jpg"}}}});
        // double-faced: no top-level image_uris, the image is on the first face
        line({{"id", "bbb"}, {"name", "Delver of Secrets // Insectile Aberration"}, {"set", "isd"}, {"set_name", "Innistrad"},
              {"collector_number", "51"}, {"rarity", "COMMON"}, {"layout", "transform"},
              {"card_faces", json::array({{{"image_uris", {{"normal", "http://img/delver-front.jpg"}}}}, {{"image_uris", {{"normal", "http://img/delver-back.jpg"}}}}})}});
        // non-English printings are included
        line({{"id", "ccc"}, {"name", "Übermut"}, {"set", "ger"}, {"set_name", "German Printing"}, {"collector_number", "12"},
              {"rarity", "uncommon"}, {"layout", "normal"}, {"image_uris", {{"normal", "http://img/ubermut.jpg"}}}});
        line({{"id", "ddd"}, {"name", "稲妻の剣"}, {"set", "jpn"}, {"set_name", "Japanese Printing"}, {"collector_number", "77"},
              {"rarity", "rare"}, {"layout", "normal"}, {"image_uris", {{"normal", "http://img/jp.jpg"}}}});
        // left out: art cards, tokens, double-faced tokens
        line({{"id", "eee"}, {"name", "Lightning Bolt // Art"}, {"layout", "art_series"}, {"set", "aaa"}});
        line({{"id", "fff"}, {"name", "Goblin"}, {"layout", "token"}, {"set", "tm10"}});
        line({{"id", "ggg"}, {"name", "Spirit // Spirit"}, {"layout", "double_faced_token"}, {"set", "tm10"}});
        // malformed entries are skipped, not fatal: no id, no name
        line({{"name", "No Id"}, {"set", "zzz"}, {"layout", "normal"}});
        line({{"id", "hhh"}, {"set", "zzz"}, {"layout", "normal"}});
        // missing fields default to empty strings; a card with neither image form has no image
        line({{"id", "iii"}, {"name", "Bare Minimum"}, {"layout", "normal"}});
        net.pages["http://x/all.gz"] = {200, gzip(jsonl)};

        auto stats = cardingest::ingest_mtg(fetcher, writer, log_fn);
        CHECK_EQ(stats.cards, static_cast<size_t>(5));
        CHECK_EQ(stats.skipped, static_cast<size_t>(5));  // art_series, token, double_faced_token, no id, no name

        auto bolt = card(db, "mtg-aaa");
        CHECK(bolt.has_value());
        if (bolt) {
            CHECK_EQ(bolt->game, std::string("mtg"));
            CHECK_EQ(bolt->name, std::string("Lightning Bolt"));
            CHECK_EQ(bolt->set_code, std::string("M10"));  // upper-cased
            CHECK_EQ(bolt->set_name, std::string("Magic 2010"));
            CHECK_EQ(bolt->collector_number, std::string("146"));
            CHECK_EQ(bolt->rarity, std::string("Common"));  // capitalized
            CHECK_EQ(bolt->image_url, std::string("http://img/bolt.jpg"));  // the "normal" size
            CHECK_EQ(bolt->name_lower, std::string("lightning bolt"));
        }
        auto delver = card(db, "mtg-bbb");
        CHECK(delver && delver->image_url == "http://img/delver-front.jpg" && delver->rarity == "Common");
        CHECK(card(db, "mtg-ccc") && card(db, "mtg-ccc")->name_lower == "übermut");
        CHECK(card(db, "mtg-ddd") && card(db, "mtg-ddd")->name == "稲妻の剣");
        CHECK(!card(db, "mtg-eee") && !card(db, "mtg-fff") && !card(db, "mtg-ggg"));
        auto bare = card(db, "mtg-iii");
        CHECK(bare && bare->image_url.empty() && bare->set_code.empty() && bare->rarity.empty());

        // re-running is safe and doesn't download again (the bulk file is cached)
        auto again = cardingest::ingest_mtg(fetcher, writer, log_fn);
        CHECK_EQ(again.cards, static_cast<size_t>(5));
        CHECK_EQ(net.hits["http://x/all.gz"], 1);
        CHECK_EQ(cardcatalog::Reader(db).count(), static_cast<std::int64_t>(5));

        // shape problems fail loudly with a useful message
        FakeTransport bad_net;
        cardfetch::Fetcher bad_fetcher(bad_net, tmp.path() / "bad-cache");
        bad_net.pages[kSources.scryfall_bulk_index] = {200, json{{"data", json::array({{{"type", "default_cards"}}})}}.dump()};
        bool threw = false;
        try {
            cardingest::ingest_mtg(bad_fetcher, writer, log_fn);
        } catch (const std::runtime_error& e) {
            threw = std::string(e.what()).find("all_cards") != std::string::npos;
        }
        CHECK(threw);
        FakeTransport no_uri_net;
        cardfetch::Fetcher no_uri_fetcher(no_uri_net, tmp.path() / "no-uri-cache");
        no_uri_net.pages[kSources.scryfall_bulk_index] = {200, json{{"data", json::array({{{"type", "all_cards"}, {"download_uri", "http://old"}}})}}.dump()};
        threw = false;
        try {
            cardingest::ingest_mtg(no_uri_fetcher, writer, log_fn);
        } catch (const std::runtime_error& e) {
            threw = std::string(e.what()).find("jsonl_download_uri") != std::string::npos;
        }
        CHECK(threw);
    }

    // ============================ Pokémon ============================
    {
        json sets = json::array({{{"id", "base1"}, {"name", "Base"}, {"ptcgoCode", "bs"}},
                                 {{"id", "swsh1"}, {"name", "Sword & Shield"}},  // no ptcgoCode -> the set id
                                 {{"id", "broken"}, {"name", "Fails To Download"}, {"ptcgoCode", "BR"}},
                                 {{"id", "empty"}, {"name", "Empty Set"}, {"ptcgoCode", "EMP"}}});
        net.pages[kSources.pokemon_sets] = {200, sets.dump()};
        auto set_url = [&](const std::string& id) { std::string u = kSources.pokemon_set; u.replace(u.find("{id}"), 4, id); return u; };
        net.pages[set_url("base1")] = {200, json::array({{{"id", "base1-4"}, {"name", "Charizard"}, {"number", "4"}, {"rarity", "Rare Holo"},
                                                          {"images", {{"small", "http://img/c-s.png"}, {"large", "http://img/c-l.png"}}}},
                                                         {{"id", "base1-5"}, {"name", "Clefairy"}, {"number", "5"},
                                                          {"images", {{"small", "http://img/cl-s.png"}}}},  // large missing -> small; no rarity
                                                         {{"name", "No Id"}}}).dump()};
        net.pages[set_url("swsh1")] = {200, json::array({{{"id", "swsh1-1"}, {"name", "Celebi V"}, {"number", "1"}, {"rarity", "Rare Holo V"}}}).dump()};  // no images at all
        net.pages[set_url("empty")] = {200, "[]"};
        // "broken" has no page -> 404 -> skipped, the others still ingest

        auto stats = cardingest::ingest_pokemon(fetcher, writer, log_fn, 4);
        CHECK_EQ(stats.cards, static_cast<size_t>(3));
        CHECK_EQ(stats.skipped, static_cast<size_t>(2));  // the failed set + the card with no id
        auto charizard = card(db, "pkm-base1-4");
        CHECK(charizard.has_value());
        if (charizard) {
            CHECK_EQ(charizard->game, std::string("pokemon"));
            CHECK_EQ(charizard->set_code, std::string("BS"));  // the TCGO code, upper-cased
            CHECK_EQ(charizard->set_name, std::string("Base"));
            CHECK_EQ(charizard->collector_number, std::string("4"));
            CHECK_EQ(charizard->rarity, std::string("Rare Holo"));
            CHECK_EQ(charizard->image_url, std::string("http://img/c-l.png"));  // large preferred
        }
        auto clefairy = card(db, "pkm-base1-5");
        CHECK(clefairy && clefairy->image_url == "http://img/cl-s.png" && clefairy->rarity.empty());
        auto celebi = card(db, "pkm-swsh1-1");
        CHECK(celebi && celebi->set_code == "SWSH1" && celebi->image_url.empty());
        CHECK(!card(db, "pkm-broken-1"));
        bool logged_skip = false;
        for (auto& l : logs)
            if (l.find("skipped set broken") != std::string::npos) logged_skip = true;
        CHECK(logged_skip);

        // with one worker the result is the same
        FakeTransport& n = net;
        n.hits.clear();
        auto serial = cardingest::ingest_pokemon(fetcher, writer, log_fn, 1);
        CHECK_EQ(serial.cards, static_cast<size_t>(3));
    }

    // ============================ Yu-Gi-Oh! ============================
    {
        json data = {{"data", json::array({
            {{"id", 46986414}, {"name", "Dark Magician"}, {"card_images", json::array({{{"image_url", "http://img/dm.jpg"}}})},
             {"card_sets", json::array({{{"set_code", "LOB-EN005"}, {"set_name", "Legend of Blue Eyes"}, {"set_rarity", "Ultra Rare"}},
                                         {{"set_code", "SDY-006"}, {"set_name", "Starter Deck: Yugi"}, {"set_rarity", "Ultra Rare"}}})}},
            {{"id", 89631139}, {"name", "Blue-Eyes White Dragon"}, {"card_images", json::array({{{"image_url", "http://img/bewd.jpg"}}})}},  // no card_sets
            {{"id", 1}, {"name", "Imageless"}, {"card_sets", json::array({{{"set_code", "XYZ-001"}}})}},  // no images
            {{"name", "No Passcode"}},
        })}};
        net.pages[kSources.ygoprodeck] = {200, data.dump()};
        auto stats = cardingest::ingest_yugioh(fetcher, writer, log_fn);
        CHECK_EQ(stats.cards, static_cast<size_t>(4));  // 2 printings + 1 (no sets) + 1
        CHECK_EQ(stats.skipped, static_cast<size_t>(1));
        auto lob = card(db, "ygo-46986414-LOB-EN005");
        CHECK(lob.has_value());
        if (lob) {
            CHECK_EQ(lob->game, std::string("yugioh"));
            CHECK_EQ(lob->passcode, std::string("46986414"));
            CHECK_EQ(lob->set_code, std::string("LOB-EN005"));
            CHECK_EQ(lob->set_name, std::string("Legend of Blue Eyes"));
            CHECK_EQ(lob->rarity, std::string("Ultra Rare"));
            CHECK_EQ(lob->image_url, std::string("http://img/dm.jpg"));
            CHECK_EQ(lob->collector_number, std::string(""));
        }
        CHECK(card(db, "ygo-46986414-SDY-006").has_value());
        auto bewd = card(db, "ygo-89631139");  // no set code -> a uid without one
        CHECK(bewd && bewd->passcode == "89631139" && bewd->set_code.empty() && bewd->name == "Blue-Eyes White Dragon");
        CHECK(card(db, "ygo-1-XYZ-001") && card(db, "ygo-1-XYZ-001")->image_url.empty());

        // the catalog now answers the way the scanner needs
        cardcatalog::Reader r(db);
        auto by_passcode = r.lookup("yugioh", "", "", "46986414");
        CHECK(by_passcode.has_value());
        CHECK_EQ(r.search("yugioh", "dark").size(), static_cast<size_t>(2));  // both printings of Dark Magician
        CHECK_EQ(r.search("pokemon", "charizard").size(), static_cast<size_t>(1));
        CHECK_EQ(r.search("mtg", "übermut").size(), static_cast<size_t>(1));
    }

    // HTTP failures surface as errors
    {
        FakeTransport down;
        cardfetch::Fetcher f(down, tmp.path() / "down-cache");
        bool threw = false;
        try {
            cardingest::ingest_yugioh(f, writer, log_fn);
        } catch (const cardfetch::Error&) {
            threw = true;
        }
        CHECK(threw);
    }

    writer.finalize();
    return cardtest::finish("cardingest");
}
