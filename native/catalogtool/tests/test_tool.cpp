// The whole catalog builder, end to end, against fixtures: ingest all three games, download images, embed them,
// build the index, clean up, finalize — with a fake network and a fake embedder.
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <zlib.h>

#include <fstream>
#include <map>
#include <set>
#include <mutex>

#include "cardscan/model_source.hpp"
#include "cardtest.hpp"
#include "cardvec/flat_index.hpp"
#include "tool.hpp"

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

std::string png(int b, int g, int r) {
    std::vector<uchar> buf;
    cv::imencode(".png", cv::Mat(90, 64, CV_8UC3, cv::Scalar(b, g, r)), buf);
    return std::string(buf.begin(), buf.end());
}

class FakeNet : public cardfetch::Transport {
public:
    std::map<std::string, std::pair<long, std::string>> pages;
    std::mutex mu;
    int requests = 0;
    cardfetch::Response get(const std::string& url, int) override {
        std::lock_guard<std::mutex> l(mu);
        ++requests;
        auto it = pages.find(url);
        if (it == pages.end()) return {404, ""};
        return {it->second.first, it->second.second};
    }
    long get_to_file(const std::string& url, int t, const fs::path& dest) override {
        auto r = get(url, t);
        if (cardfetch::is_success(r.status)) {
            fs::create_directories(dest.parent_path());
            std::ofstream(dest, std::ios::binary) << r.body;
        }
        return r.status;
    }
};

class FakeEmbedder : public cardscan::Embedder {
public:
    std::vector<float> embed(const cardscan::Image& im) override {
        double b = 0, g = 0, r = 0;
        size_t px = static_cast<size_t>(im.width) * im.height;
        for (size_t i = 0; i < px; ++i) b += im.bgr[i * 3], g += im.bgr[i * 3 + 1], r += im.bgr[i * 3 + 2];
        return {static_cast<float>(b / px), static_cast<float>(g / px), static_cast<float>(r / px), 40.f};
    }
};

void serve_fixtures(FakeNet& net) {
    const cardingest::Sources s;
    net.pages[s.scryfall_bulk_index] = {200, json{{"data", json::array({{{"type", "all_cards"}, {"jsonl_download_uri", "http://x/all.gz"}}})}}.dump()};
    std::string jsonl;
    jsonl += json{{"id", "m1"}, {"name", "Lightning Bolt"}, {"set", "m10"}, {"set_name", "M10"}, {"collector_number", "146"}, {"rarity", "common"},
                  {"layout", "normal"}, {"image_uris", {{"normal", "http://img/m1"}}}}.dump() + "\n";
    jsonl += json{{"id", "m2"}, {"name", "Black Lotus"}, {"set", "lea"}, {"set_name", "Alpha"}, {"collector_number", "232"}, {"rarity", "rare"},
                  {"layout", "normal"}, {"image_uris", {{"normal", "http://img/m2"}}}}.dump() + "\n";
    jsonl += json{{"id", "tok"}, {"name", "Goblin"}, {"layout", "token"}}.dump() + "\n";
    net.pages["http://x/all.gz"] = {200, gzip(jsonl)};

    net.pages[s.pokemon_sets] = {200, json::array({{{"id", "base1"}, {"name", "Base"}, {"ptcgoCode", "BS"}}}).dump()};
    std::string set_url = s.pokemon_set;
    set_url.replace(set_url.find("{id}"), 4, "base1");
    net.pages[set_url] = {200, json::array({{{"id", "base1-4"}, {"name", "Charizard"}, {"number", "4"}, {"rarity", "Rare"},
                                             {"images", {{"large", "http://img/p1"}}}}}).dump()};

    net.pages[s.ygoprodeck] = {200, json{{"data", json::array({{{"id", 46986414}, {"name", "Dark Magician"},
                                                                 {"card_images", json::array({{{"image_url", "http://img/y1"}}})},
                                                                 {"card_sets", json::array({{{"set_code", "LOB-EN005"}, {"set_name", "LOB"}, {"set_rarity", "Ultra"}}})}}})}}.dump()};

    net.pages["http://img/m1"] = {200, png(20, 20, 220)};
    net.pages["http://img/m2"] = {200, png(20, 220, 20)};
    net.pages["http://img/p1"] = {200, png(220, 20, 20)};
    net.pages["http://img/y1"] = {200, png(20, 220, 220)};
}

}  // namespace

int main() {
    std::vector<std::string> log_lines;
    auto log = [&](const std::string& m) { log_lines.push_back(m); };
    auto has_log = [&](const std::string& needle) {
        for (auto& l : log_lines)
            if (l.find(needle) != std::string::npos) return true;
        return false;
    };
    catalogtool::EmbedderFactory with_model = [](const fs::path&) -> std::unique_ptr<cardscan::Embedder> { return std::make_unique<FakeEmbedder>(); };
    catalogtool::EmbedderFactory no_model = [](const fs::path&) -> std::unique_ptr<cardscan::Embedder> { return nullptr; };

    // ===================== a full run =====================
    {
        cardtest::TempDir tmp;
        FakeNet net;
        serve_fixtures(net);
        catalogtool::Options o;
        o.data_dir = tmp.path() / "data";
        o.request_pause_seconds = 0;
        o.image_workers = 3;
        CHECK_EQ(catalogtool::run(o, net, with_model, log), 0);

        const fs::path db = o.data_dir / cardscan::kCatalogFile, index = o.data_dir / cardscan::kVectorIndexFile;
        CHECK(fs::exists(db) && fs::exists(index));
        {
            cardcatalog::Reader r(db);
            CHECK_EQ(r.count(), static_cast<std::int64_t>(4));  // 2 MTG (the token is left out) + Pokémon + Yu-Gi-Oh!
            std::set<std::int64_t> idx;
            for (const char* uid : {"mtg-m1", "mtg-m2", "pkm-base1-4", "ygo-46986414-LOB-EN005"}) {
                auto c = r.by_uid(uid);
                CHECK(c.has_value() && c->vector_idx.has_value());
                if (c && c->vector_idx) idx.insert(*c->vector_idx);
            }
            CHECK_EQ(idx.size(), static_cast<size_t>(4));
            CHECK_EQ(r.search("mtg", "lotus").size(), static_cast<size_t>(1));
            CHECK_EQ(r.by_uid("mtg-m1")->set_code, std::string("M10"));
        }
        CHECK_EQ(cardvec::FlatIndexIP::load(index.string()).ntotal(), static_cast<std::int64_t>(4));
        CHECK(!fs::exists(o.data_dir / "card-images"));  // the scratch images are gone
        CHECK(fs::exists(o.data_dir / "cache" / "ygoprodeck_cardinfo.json"));  // the bulk data is cached for the next run

        // finalized: a single self-contained file, no write-ahead-log leftovers
        for (auto& e : fs::directory_iterator(o.data_dir))
            CHECK(e.path().filename().string().find("-wal") == std::string::npos && e.path().filename().string().find("-shm") == std::string::npos);
        CHECK(has_log("All done. 4 cards"));

        // re-running changes nothing and downloads nothing
        int requests = net.requests;
        log_lines.clear();
        CHECK_EQ(catalogtool::run(o, net, with_model, log), 0);
        CHECK_EQ(net.requests, requests);
        CHECK(has_log("nothing to do"));
        CHECK_EQ(cardcatalog::Reader(db).count(), static_cast<std::int64_t>(4));
        CHECK_EQ(cardvec::FlatIndexIP::load(index.string()).ntotal(), static_cast<std::int64_t>(4));
    }

    // ===================== --only one game =====================
    {
        cardtest::TempDir tmp;
        FakeNet net;
        serve_fixtures(net);
        catalogtool::Options o;
        o.data_dir = tmp.path();
        o.only = "pokemon";
        o.request_pause_seconds = 0;
        CHECK_EQ(catalogtool::run(o, net, with_model, log), 0);
        cardcatalog::Reader r(o.data_dir / cardscan::kCatalogFile);
        CHECK_EQ(r.count(), static_cast<std::int64_t>(1));
        CHECK(r.by_uid("pkm-base1-4").has_value() && !r.by_uid("mtg-m1").has_value());
    }

    // ===================== no embedding model: images are kept, the rest still builds =====================
    {
        cardtest::TempDir tmp;
        FakeNet net;
        serve_fixtures(net);
        catalogtool::Options o;
        o.data_dir = tmp.path();
        o.request_pause_seconds = 0;
        log_lines.clear();
        CHECK_EQ(catalogtool::run(o, net, no_model, log), 0);
        CHECK(has_log("no embedding model available"));
        CHECK(fs::exists(o.data_dir / "card-images" / "mtg" / "mtg-m1.jpg"));  // still needed once the model exists
        CHECK(!fs::exists(o.data_dir / cardscan::kVectorIndexFile));
        CHECK_EQ(cardcatalog::Reader(o.data_dir / cardscan::kCatalogFile).count(), static_cast<std::int64_t>(4));

        // ...and a later run with the model picks up where it left off, without downloading anything
        int requests = net.requests;
        CHECK_EQ(catalogtool::run(o, net, with_model, log), 0);
        CHECK_EQ(net.requests, requests);
        CHECK_EQ(cardvec::FlatIndexIP::load((o.data_dir / cardscan::kVectorIndexFile).string()).ntotal(), static_cast<std::int64_t>(4));
        CHECK(!fs::exists(o.data_dir / "card-images"));
    }

    // ===================== --keep-images / --skip-* =====================
    {
        cardtest::TempDir tmp;
        FakeNet net;
        serve_fixtures(net);
        catalogtool::Options o;
        o.data_dir = tmp.path();
        o.keep_images = true;
        o.request_pause_seconds = 0;
        CHECK_EQ(catalogtool::run(o, net, with_model, log), 0);
        CHECK(fs::exists(o.data_dir / "card-images" / "yugioh" / "ygo-46986414-LOB-EN005.jpg"));

        // skipping ingest + images + vectors does nothing but finalize
        catalogtool::Options skip;
        skip.data_dir = tmp.path() / "skip";
        skip.skip_ingest = skip.skip_images = skip.skip_vectors = true;
        FakeNet empty;
        CHECK_EQ(catalogtool::run(skip, empty, with_model, log), 0);
        CHECK_EQ(empty.requests, 0);
        CHECK_EQ(cardcatalog::Reader(skip.data_dir / cardscan::kCatalogFile).count(), static_cast<std::int64_t>(0));
    }

    // ===================== failures are reported, not thrown =====================
    {
        cardtest::TempDir tmp;
        FakeNet down;  // every URL 404s
        catalogtool::Options o;
        o.data_dir = tmp.path();
        log_lines.clear();
        CHECK_EQ(catalogtool::run(o, down, with_model, log), 1);
        CHECK(has_log("error:") && has_log("404"));

        catalogtool::Options bad;
        bad.data_dir = tmp.path();
        bad.only = "digimon";
        CHECK_EQ(catalogtool::run(bad, down, with_model, log), 1);
    }

    return cardtest::finish("catalogtool");
}
