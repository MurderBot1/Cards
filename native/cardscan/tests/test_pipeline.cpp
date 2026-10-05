// The recognition pipeline end to end, with fake detector / OCR / embedder / vector-index backends
// keyed by the size of the crop they're handed (every region of interest has a distinct size), so each
// routing and fallback path can be exercised deterministically without any ML models.
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <map>
#include <set>

#include "cardcatalog/catalog.hpp"
#include "cardscan/model_source.hpp"
#include "cardvec/flat_index.hpp"
#include "cardscan/pipeline_engine.hpp"
#include "cardtest.hpp"

namespace fs = std::filesystem;
using namespace cardscan;
using nlohmann::json;

namespace {

// ---- region sizes (width, height) of the 750x1050 warped card's crops ----------------------
using Size = std::pair<int, int>;
const Size kMtgPrimary{350, 130}, kPokemonModern{300, 90}, kPokemonVintage{230, 90}, kYugiohPasscode{200, 60},
    kYugiohSetCode{250, 60};
const Size kMtgTitle{650, 90}, kPokemonTitle{550, 90}, kYugiohTitle{620, 70};
const Size kMtgArt{600, 460}, kPokemonArt{590, 420}, kYugiohArt{510, 370};

constexpr int kDim = 8;
std::vector<float> unit(int i) {
    std::vector<float> v(kDim, 0.f);
    v[i] = 1.f;
    return v;
}

// Shared, mutable script for the fakes.
struct State {
    std::map<Size, std::string> ocr;          // crop size -> recognized text
    std::map<Size, std::vector<float>> embed;  // crop size -> embedding
    bool has_detector = false;
    std::vector<Detection> detections;
    std::map<int, std::string> class_names;
    std::vector<std::vector<float>> index_rows;  // empty -> no vector index
    bool throw_on_ocr_load = false;
    int ocr_loads = 0, index_loads = 0, detector_loads = 0, embedder_loads = 0;
    std::vector<std::string> log;
};

class FakeDetector : public Detector {
public:
    explicit FakeDetector(State& s) : s_(s) {}
    std::vector<Detection> detect(const Image&) override { return s_.detections; }
    State& s_;
};
class FakeOcr : public Ocr {
public:
    explicit FakeOcr(State& s) : s_(s) {}
    std::vector<std::string> recognize(const Image& im) override {
        auto it = s_.ocr.find({im.width, im.height});
        return it == s_.ocr.end() ? std::vector<std::string>{} : std::vector<std::string>{it->second};
    }
    State& s_;
};
class FakeEmbedder : public Embedder {
public:
    explicit FakeEmbedder(State& s) : s_(s) {}
    std::vector<float> embed(const Image& im) override {
        auto it = s_.embed.find({im.width, im.height});
        return it == s_.embed.end() ? std::vector<float>(kDim, 0.f) : it->second;
    }
    State& s_;
};
class FakeIndex : public VectorIndex {
public:
    explicit FakeIndex(State& s) : s_(s) {}
    std::int64_t ntotal() const override { return static_cast<std::int64_t>(s_.index_rows.size()); }
    void search(const float* q, std::int64_t k, float* scores, std::int64_t* labels) const override {
        // Only rows with positive similarity count as hits (the one-hot test vectors make that "the same
        // direction"); everything else is reported as missing, label -1.
        std::vector<std::pair<float, std::int64_t>> all;
        for (size_t i = 0; i < s_.index_rows.size(); ++i) {
            float dot = 0;
            for (int d = 0; d < kDim; ++d) dot += q[d] * s_.index_rows[i][d];
            if (dot > 0) all.emplace_back(dot, static_cast<std::int64_t>(i));
        }
        std::stable_sort(all.begin(), all.end(), [](auto& a, auto& b) { return a.first > b.first; });
        for (std::int64_t i = 0; i < k; ++i) {
            scores[i] = i < static_cast<std::int64_t>(all.size()) ? all[i].first : -1e30f;
            labels[i] = i < static_cast<std::int64_t>(all.size()) ? all[i].second : -1;
        }
    }
    std::vector<float> reconstruct(std::int64_t label) const override { return s_.index_rows.at(label); }
    State& s_;
};
class FakeModels : public ModelSource {
public:
    explicit FakeModels(State& s) : s_(s) {}
    std::optional<LoadedDetector> load_detector() override {
        ++s_.detector_loads;
        if (!s_.has_detector) return std::nullopt;
        return LoadedDetector{std::make_unique<FakeDetector>(s_), s_.class_names};
    }
    std::unique_ptr<Ocr> load_ocr() override {
        ++s_.ocr_loads;
        if (s_.throw_on_ocr_load) throw std::runtime_error("ocr model is corrupt");
        return std::make_unique<FakeOcr>(s_);
    }
    std::unique_ptr<Embedder> load_embedder() override {
        ++s_.embedder_loads;
        return std::make_unique<FakeEmbedder>(s_);
    }
    std::unique_ptr<VectorIndex> load_index() override {
        ++s_.index_loads;
        if (s_.index_rows.empty()) return nullptr;
        return std::make_unique<FakeIndex>(s_);
    }
    State& s_;
};

// ---- fixture catalog: same cards as the catalog tests, vector_idx = position -------------
const std::vector<cardcatalog::CardInput> kCards = {
    {"mtg-1", "mtg", "Lightning Bolt", "LEA", "Alpha", "161", "common", "", "http://example/1.jpg"},
    {"mtg-2", "mtg", "Lightning Bolt", "M10", "Magic 2010", "146", "common", "", "http://example/2.jpg"},
    {"mtg-3", "mtg", "Black Lotus", "LEA", "Alpha", "232", "rare", "", "http://example/3.jpg"},
    {"ygo-1", "yugioh", "Dark Magician", "LOB", "Legend of Blue Eyes", "005", "ultra", "46986414", "http://example/4.jpg"},
    {"pkm-1", "pokemon", "Charizard", "BS", "Base Set", "4", "rare", "", "http://example/5.jpg"},
    {"mtg-4", "mtg", "Übermut", "GER", "German Printing", "12", "uncommon", "", "http://example/6.jpg"},
    {"mtg-5", "mtg", "稲妻の剣", "JPN", "Japanese Printing", "77", "rare", "", "http://example/7.jpg"},
};

void build_catalog(const fs::path& path) {
    cardcatalog::Writer w(path);
    w.upsert_cards(kCards);
    std::vector<std::pair<std::int64_t, std::string>> pairs;
    for (size_t i = 0; i < kCards.size(); ++i) pairs.emplace_back(static_cast<std::int64_t>(i), kCards[i].uid);
    w.set_vector_indexes(pairs);
    w.finalize();
}

void with_full_index(State& s) {
    s.index_rows.clear();
    for (size_t i = 0; i < kCards.size(); ++i) s.index_rows.push_back(unit(static_cast<int>(i)));
}

// A flat gray frame: no card quad, so the pipeline plain-resizes it to 750x1050.
Image flat_frame(int w = 750, int h = 1050) {
    Image im;
    im.width = w;
    im.height = h;
    im.bgr.assign(static_cast<size_t>(w) * h * 3, 100);
    return im;
}

std::string uid_of(const std::optional<json>& card) { return card ? card->value("id", "") : "<none>"; }

}  // namespace

int main() {
    cardtest::TempDir tmp;
    const fs::path catalog = tmp.path() / "cards.sqlite3";
    build_catalog(catalog);

    auto make = [&](State& s, const fs::path& db = fs::path()) {
        return PipelineEngine(db.empty() ? catalog : db, std::make_unique<FakeModels>(s), [&s](const std::string& m) { s.log.push_back(m); });
    };

    // ===== exact identifier OCR path =====
    {
        State s;
        s.ocr[kMtgPrimary] = "m10 146/249 R";
        auto e = make(s);
        auto id = e.identify(flat_frame());
        CHECK_EQ(uid_of(id.card), std::string("mtg-2"));
        CHECK(id.card && (*id.card)["set"] == "M10" && (*id.card)["game"] == "mtg" && (*id.card)["image"] == "http://example/2.jpg");
        // bbox info rides along even with no detector (bbox null), and with the frame size
        CHECK(id.bbox_info.has_value());
        CHECK(id.card && (*id.card)["bbox"].is_null() && (*id.card)["image_width"] == 750 && (*id.card)["image_height"] == 1050);
    }
    // art verification overrides a misread printing: OCR says LEA 161 (mtg-1) but the art matches mtg-2
    {
        State s;
        s.ocr[kMtgPrimary] = "LEA 161/302";
        with_full_index(s);
        s.embed[kMtgArt] = unit(1);  // closest to row 1 == mtg-2
        auto e = make(s);
        CHECK_EQ(uid_of(e.identify(flat_frame()).card), std::string("mtg-2"));
        s.embed[kMtgArt] = unit(0);  // and when the art agrees with the OCR, it stays
        auto e2 = make(s);
        CHECK_EQ(uid_of(e2.identify(flat_frame()).card), std::string("mtg-1"));
    }
    // verification only considers printings of the resolved name (art that resembles Black Lotus can't move a Bolt)
    {
        State s;
        s.ocr[kMtgPrimary] = "LEA 161/302";
        with_full_index(s);
        s.embed[kMtgArt] = unit(2);  // Black Lotus's row
        auto e = make(s);
        std::string got = uid_of(e.identify(flat_frame()).card);
        CHECK(got == "mtg-1" || got == "mtg-2");
    }

    // ===== game routing =====
    {
        // detector classifies the card as pokemon: only the pokemon identifier is tried, bbox comes back as ints
        State s;
        s.has_detector = true;
        s.detections = {{10.9f, 20.2f, 300.5f, 400.7f, 1, 0.4f}, {50.f, 60.f, 500.f, 600.f, 1, 0.9f}};  // best score wins
        s.class_names = {{0, "mtg"}, {1, "pokemon"}, {2, "yugioh"}};
        s.ocr[kMtgPrimary] = "M10 146/249";  // would match an MTG card if mtg were tried
        s.ocr[kPokemonModern] = "BS 4/102";
        auto e = make(s);
        auto id = e.identify(flat_frame(), "mtg");  // hint is overridden by the detector
        CHECK_EQ(uid_of(id.card), std::string("pkm-1"));
        CHECK(id.card && (*id.card)["bbox"] == json({{"x0", 50}, {"y0", 60}, {"x1", 500}, {"y1", 600}}));
    }
    {
        // a detector class that isn't a known game is ignored (all games are tried)
        State s;
        s.has_detector = true;
        s.detections = {{0, 0, 100, 100, 7, 0.9f}};
        s.class_names = {{7, "digimon"}};
        s.ocr[kPokemonModern] = "BS 4/102";
        auto e = make(s);
        CHECK_EQ(uid_of(e.identify(flat_frame()).card), std::string("pkm-1"));
    }
    {
        // no detector: the hint narrows the games; an invalid hint means all of them
        State s;
        s.ocr[kMtgPrimary] = "M10 146/249";
        s.ocr[kPokemonModern] = "BS 4/102";
        auto hinted = make(s);
        CHECK_EQ(uid_of(hinted.identify(flat_frame(), "pokemon").card), std::string("pkm-1"));
        auto all = make(s);
        CHECK_EQ(uid_of(all.identify(flat_frame(), "nonsense").card), std::string("mtg-2"));  // mtg is tried first
    }
    // pokemon: modern miss -> vintage number alone
    {
        State s;
        s.ocr[kPokemonVintage] = "4/102";
        auto e = make(s);
        CHECK_EQ(uid_of(e.identify(flat_frame(), "pokemon").card), std::string("pkm-1"));
    }
    // yugioh: passcode (+ a set code that isn't in the catalog falls back to passcode alone)
    {
        State s;
        s.ocr[kYugiohPasscode] = "46986414";
        s.ocr[kYugiohSetCode] = "LOB-EN005";
        auto e = make(s);
        CHECK_EQ(uid_of(e.identify(flat_frame(), "yugioh").card), std::string("ygo-1"));
    }
    {
        State s;
        s.ocr[kYugiohPasscode] = "12345678";  // not in the catalog
        auto e = make(s);
        CHECK(!e.identify(flat_frame(), "yugioh").card.has_value());
    }

    // ===== fuzzy title fallback =====
    {
        State s;
        s.ocr[kMtgTitle] = "L1ghtning B0lt";  // ratio 0.857 -> 85.7, over the 80 threshold
        auto e = make(s);
        CHECK_EQ(uid_of(e.identify(flat_frame(), "mtg").card), std::string("mtg-1"));  // smallest uid represents the name
        // ...and with the art index the actual printing is chosen
        with_full_index(s);
        s.embed[kMtgArt] = unit(1);
        auto e2 = make(s);
        CHECK_EQ(uid_of(e2.identify(flat_frame(), "mtg").card), std::string("mtg-2"));
    }
    {
        // non-Latin and accented titles resolve too
        State s;
        s.ocr[kMtgTitle] = "UBERMUT!";  // "ubermut" vs "übermut": 0.857, accepted
        auto e = make(s);
        CHECK_EQ(uid_of(e.identify(flat_frame(), "mtg").card), std::string("mtg-4"));
        State j;
        j.ocr[kMtgTitle] = "稲妻の剣";
        auto ej = make(j);
        CHECK_EQ(uid_of(ej.identify(flat_frame(), "mtg").card), std::string("mtg-5"));
    }

    // ===== art-vector fallback (title too weak to accept, but names are candidates) =====
    {
        // "Lightning" vs "lightning bolt" = 0.78 -> a candidate but under the 80 threshold
        State s;
        s.ocr[kMtgTitle] = "Lightning";
        with_full_index(s);
        s.embed[kMtgArt] = unit(1);  // top vector hit is mtg-2, NOT the name's representative uid (mtg-1)
        auto e = make(s);
        CHECK_EQ(uid_of(e.identify(flat_frame(), "mtg").card), std::string("mtg-2"));  // the uid-filter regression

        // a top hit outside the candidate names is rejected
        s.embed[kMtgArt] = unit(2);  // Black Lotus
        auto rejected = make(s);
        CHECK(!rejected.identify(flat_frame(), "mtg").card.has_value());
    }
    {
        // with no candidate names at all (no title text), the top vector hit is taken
        State s;
        with_full_index(s);
        s.embed[kMtgArt] = unit(2);
        auto e = make(s);
        CHECK_EQ(uid_of(e.identify(flat_frame(), "mtg").card), std::string("mtg-3"));
    }

    // ===== nothing identifiable / degraded environments =====
    {
        State s;  // OCR says nothing, no index
        auto e = make(s);
        auto id = e.identify(flat_frame());
        CHECK(!id.card.has_value());
        CHECK(id.bbox_info.has_value());  // detection ran, so the caller can still show where it looked
        CHECK((*id.bbox_info)["image_width"] == 750);
    }
    {
        State s;
        s.ocr[kMtgPrimary] = "M10 146/249";
        auto missing = make(s, tmp.path() / "no-such-catalog.sqlite3");
        CHECK(!missing.is_ready());
        auto id = missing.identify(flat_frame());
        CHECK(!id.card.has_value() && !id.bbox_info.has_value());  // bailed before detection
        CHECK_EQ(missing.search("mtg", "bolt"), json::array());
        CHECK_EQ(s.ocr_loads, 0);  // and never touched the models
    }

    // ===== lazy loading: once, not per request; failures are logged and skipped =====
    {
        State s;
        s.ocr[kMtgPrimary] = "M10 146/249";
        with_full_index(s);
        auto e = make(s);
        for (int i = 0; i < 5; ++i) e.identify(flat_frame());
        CHECK_EQ(s.ocr_loads, 1);
        CHECK_EQ(s.index_loads, 1);
        CHECK_EQ(s.detector_loads, 1);
        CHECK_EQ(s.embedder_loads, 1);
    }
    {
        State s;
        s.throw_on_ocr_load = true;
        auto e = make(s);
        auto id = e.identify(flat_frame());  // no OCR text at all, but no crash either
        CHECK(!id.card.has_value());
        CHECK_EQ(s.log.size(), static_cast<size_t>(1));
        CHECK(!s.log.empty() && s.log[0].find("ocr model is corrupt") != std::string::npos);
        e.identify(flat_frame());
        CHECK_EQ(s.ocr_loads, 1);  // not retried on every request
    }
    {
        State s;
        auto e = make(s);
        e.warm_up();
        CHECK(s.ocr_loads == 1 && s.index_loads == 1 && s.detector_loads == 1 && s.embedder_loads == 1);
        auto missing = make(s, tmp.path() / "nope.sqlite3");
        State s2;
        auto m2 = make(s2, tmp.path() / "nope.sqlite3");
        m2.warm_up();
        CHECK_EQ(s2.ocr_loads, 0);  // warm-up is a no-op without a catalog
    }

    // ===== search: API-shaped rows =====
    {
        State s;
        auto e = make(s);
        json r = e.search("mtg", "lightning");
        CHECK_EQ(r.size(), static_cast<size_t>(2));
        CHECK(r[0] == json({{"id", "mtg-1"}, {"name", "Lightning Bolt"}, {"set", "LEA"}, {"rarity", "common"}, {"game", "mtg"}, {"image", "http://example/1.jpg"}}));
        CHECK_EQ(e.search("mtg", "übermut").size(), static_cast<size_t>(1));
        CHECK_EQ(e.search("", "").size(), kCards.size());
    }

    // ===== detect() =====
    {
        // contour fallback: a bright card on a dark frame -> quad + bbox, no game
        cv::Mat frame(600, 800, CV_8UC3, cv::Scalar(30, 30, 30));
        std::vector<cv::Point> poly = {{180, 90}, {560, 70}, {590, 520}, {210, 545}};
        cv::fillConvexPoly(frame, poly, cv::Scalar(230, 235, 240));
        std::vector<uchar> png;
        cv::imencode(".png", frame, png);
        State s;
        auto e = make(s);
        auto r = e.detect(std::string(png.begin(), png.end()));
        CHECK_EQ(r.status, 200);
        CHECK_EQ(r.body["image_width"], json(800));
        CHECK_EQ(r.body["image_height"], json(600));
        CHECK(r.body["game"].is_null());
        CHECK(r.body["quad"].is_array() && r.body["quad"].size() == 4);
        CHECK(r.body["bbox"].is_object());
        if (r.body["bbox"].is_object()) {
            CHECK(std::abs(r.body["bbox"]["x0"].get<int>() - 180) < 8 && std::abs(r.body["bbox"]["x1"].get<int>() - 590) < 8);
            CHECK(std::abs(r.body["bbox"]["y0"].get<int>() - 70) < 8 && std::abs(r.body["bbox"]["y1"].get<int>() - 545) < 8);
        }
        // the quad is ordered tl, tr, br, bl
        CHECK(r.body["quad"][0]["x"].get<double>() < r.body["quad"][1]["x"].get<double>());
        CHECK(r.body["quad"][0]["y"].get<double>() < r.body["quad"][3]["y"].get<double>());

        // with a detector: bbox from the detection, game from its class, no quad
        State d;
        d.has_detector = true;
        d.detections = {{12.f, 34.f, 456.f, 567.f, 2, 0.8f}};
        d.class_names = {{2, "yugioh"}};
        auto ed = make(d);
        auto rd = ed.detect(std::string(png.begin(), png.end()));
        CHECK_EQ(rd.status, 200);
        CHECK(rd.body["bbox"] == json({{"x0", 12}, {"y0", 34}, {"x1", 456}, {"y1", 567}}));
        CHECK_EQ(rd.body["game"], json("yugioh"));
        CHECK(rd.body["quad"].is_null());

        // a frame with nothing in it: bbox and quad both null
        cv::Mat blank(300, 400, CV_8UC3, cv::Scalar(90, 90, 90));
        std::vector<uchar> blank_png;
        cv::imencode(".png", blank, blank_png);
        auto rb = make(s).detect(std::string(blank_png.begin(), blank_png.end()));
        CHECK_EQ(rb.status, 200);
        CHECK(rb.body["bbox"].is_null() && rb.body["quad"].is_null());

        CHECK_EQ(e.detect("not an image").status, 400);
        CHECK_EQ(e.detect("not an image").body["error"], json("Could not read that image"));
    }

    // ===== scan(): decode -> blur gate -> catalog present -> identify =====
    {
        cv::Mat noisy(1050, 750, CV_8UC3);
        cv::theRNG().state = 12345;
        cv::randu(noisy, cv::Scalar::all(0), cv::Scalar::all(255));  // very sharp
        std::vector<uchar> sharp_png, flat_png;
        cv::imencode(".png", noisy, sharp_png);
        cv::imencode(".png", cv::Mat(1050, 750, CV_8UC3, cv::Scalar(100, 100, 100)), flat_png);
        std::string sharp(sharp_png.begin(), sharp_png.end()), flat(flat_png.begin(), flat_png.end());

        State s;
        s.ocr[kMtgPrimary] = "M10 146/249";
        auto e = make(s);
        auto bad = e.scan("garbage", "", 40);
        CHECK(bad.status == 400 && bad.body["error"] == "Could not read that image");

        auto blurry = e.scan(flat, "", 40);
        CHECK_EQ(blurry.status, 400);
        CHECK(blurry.body["error"].get<std::string>().find("too blurry") != std::string::npos);

        auto ok = e.scan(sharp, "", 40);
        CHECK_EQ(ok.status, 200);
        CHECK_EQ(ok.body["id"], json("mtg-2"));
        CHECK(ok.body.contains("bbox") && ok.body.contains("image_width"));

        // a threshold the frame can't clear is rejected even though it would otherwise match
        CHECK_EQ(e.scan(sharp, "", 1e12).status, 400);

        State nothing;
        auto nf = make(nothing).scan(sharp, "mtg", 40);
        CHECK_EQ(nf.status, 404);
        CHECK(nf.body["error"].get<std::string>().find("confidently identify") != std::string::npos);
        CHECK(nf.body.contains("bbox") && nf.body["image_width"] == 750 && nf.body["image_height"] == 1050);  // bbox info on a miss

        State nc;
        auto no_catalog = make(nc, tmp.path() / "none.sqlite3").scan(sharp, "", 40);
        CHECK_EQ(no_catalog.status, 503);
        CHECK(no_catalog.body["error"].get<std::string>().find("catalog") != std::string::npos);
    }

    // ===== the real cardvec index file adapter =====
    {
        cardvec::FlatIndexIP built(kDim);
        for (int i = 0; i < 4; ++i) built.add(unit(i).data(), 1);
        fs::path idx = tmp.path() / "card-vectors.cvi";
        CHECK(load_cardvec_index(idx) == nullptr);  // no file, no index
        built.save(idx.string());
        auto loaded = load_cardvec_index(idx);
        CHECK(loaded != nullptr);
        if (loaded) {
            CHECK_EQ(loaded->ntotal(), static_cast<std::int64_t>(4));
            float q[kDim] = {0, 0, 1, 0, 0, 0, 0, 0};
            float scores[3];
            std::int64_t labels[3];
            loaded->search(q, 3, scores, labels);
            CHECK_EQ(labels[0], static_cast<std::int64_t>(2));
            CHECK_EQ(scores[0], 1.0f);
            CHECK(loaded->reconstruct(3) == unit(3));
        }
        DataDirModelSource src(tmp.path());
        CHECK(src.load_index() != nullptr);
        CHECK(src.load_ocr() == nullptr && src.load_embedder() == nullptr && !src.load_detector().has_value());
    }

    return cardtest::finish("cardscan pipeline");
}
