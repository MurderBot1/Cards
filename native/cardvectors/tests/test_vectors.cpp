#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include <cmath>
#include <fstream>
#include <map>
#include <set>
#include <mutex>

#include "cardscan/image.hpp"
#include "cardtest.hpp"
#include "cardvec/flat_index.hpp"
#include "cardvectors/vectors.hpp"

namespace fs = std::filesystem;
using cardcatalog::CardInput;

namespace {

std::string encode(const cv::Mat& m, const char* ext) {
    std::vector<uchar> buf;
    cv::imencode(ext, m, buf);
    return std::string(buf.begin(), buf.end());
}

// A solid-colour image; the colour is what the fake embedder "sees".
std::string solid_png(int b, int g, int r, int w = 64, int h = 90) { return encode(cv::Mat(h, w, CV_8UC3, cv::Scalar(b, g, r)), ".png"); }

class FakeTransport : public cardfetch::Transport {
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
    long get_to_file(const std::string&, int, const fs::path&) override { return 500; }
};

// dim-4 "embedding": the image's mean colour channels plus a constant, so each card's vector is determined by its
// image colour. Optionally throws on the n-th call, to simulate a crash.
class FakeEmbedder : public cardscan::Embedder {
public:
    int calls = 0;
    int throw_on_call = -1;
    int dim = 4;
    std::vector<float> embed(const cardscan::Image& im) override {
        if (++calls == throw_on_call) throw std::runtime_error("simulated crash");
        double b = 0, g = 0, r = 0;
        size_t px = static_cast<size_t>(im.width) * im.height;
        for (size_t i = 0; i < px; ++i) b += im.bgr[i * 3], g += im.bgr[i * 3 + 1], r += im.bgr[i * 3 + 2];
        std::vector<float> v = {static_cast<float>(b / px), static_cast<float>(g / px), static_cast<float>(r / px), 50.f};
        v.resize(static_cast<size_t>(dim), 1.f);
        return v;
    }
};

std::vector<std::string> logs;
cardvectors::Log log_fn = [](const std::string& m) { logs.push_back(m); };

float norm(const std::vector<float>& v) {
    double s = 0;
    for (float x : v) s += static_cast<double>(x) * x;
    return static_cast<float>(std::sqrt(s));
}

}  // namespace

int main() {
    cardtest::TempDir tmp;
    const fs::path db = tmp.path() / "cards.sqlite3";
    const fs::path images = tmp.path() / "images";
    const fs::path index_path = tmp.path() / "card-vectors.cvi";

    // ---- safe_filename
    CHECK_EQ(cardvectors::safe_filename("mtg-abc"), std::string("mtg-abc"));
    CHECK_EQ(cardvectors::safe_filename("pkm-sv1-?"), std::string("pkm-sv1-_"));
    CHECK_EQ(cardvectors::safe_filename("a<b>c:d\"e/f\\g|h?i*j"), std::string("a_b_c_d_e_f_g_h_i_j"));

    cardcatalog::Writer writer(db);
    FakeTransport net;
    cardfetch::Fetcher fetcher(net, tmp.path() / "cache");

    // red / green / blue / yellow card art
    writer.upsert_cards({
        {"mtg-red", "mtg", "Red Card", "AAA", "A", "1", "common", "", "http://img/red.png"},
        {"mtg-green", "mtg", "Green Card", "AAA", "A", "2", "common", "", "http://img/green.png"},
        {"pkm-blue?", "pokemon", "Blue Card", "BBB", "B", "3", "rare", "", "http://img/blue.png"},  // '?' in the uid
        {"ygo-yellow", "yugioh", "Yellow Card", "CCC", "C", "", "ultra", "1234", "http://img/yellow.png"},
        {"mtg-missing", "mtg", "Missing Image", "AAA", "A", "4", "common", "", "http://img/404.png"},  // 404
        {"mtg-garbage", "mtg", "Garbage Image", "AAA", "A", "5", "common", "", "http://img/garbage.png"},  // not an image
        {"mtg-noimage", "mtg", "No Image", "AAA", "A", "6", "common", "", ""},                          // nothing to download
    });
    net.pages["http://img/red.png"] = {200, solid_png(20, 20, 220)};
    net.pages["http://img/green.png"] = {200, solid_png(20, 220, 20)};
    net.pages["http://img/blue.png"] = {200, solid_png(220, 20, 20)};
    net.pages["http://img/yellow.png"] = {200, solid_png(20, 220, 220)};
    net.pages["http://img/garbage.png"] = {200, "this is not an image"};

    // ===================== images =====================
    {
        auto stats = cardvectors::download_images(writer, fetcher, images, "", 4, 0, log_fn);
        CHECK_EQ(stats.downloaded, static_cast<size_t>(4));
        CHECK_EQ(stats.failed, static_cast<size_t>(2));  // the 404 and the non-image
        CHECK_EQ(stats.reused, static_cast<size_t>(0));

        // files are re-encoded as JPEG, in per-game folders, with unsafe characters replaced
        CHECK(fs::exists(images / "mtg" / "mtg-red.jpg"));
        CHECK(fs::exists(images / "pokemon" / "pkm-blue_.jpg"));
        CHECK(fs::exists(images / "yugioh" / "ygo-yellow.jpg"));
        std::ifstream f(images / "mtg" / "mtg-red.jpg", std::ios::binary);
        char magic[3] = {0, 0, 0};
        f.read(magic, 3);
        CHECK(static_cast<unsigned char>(magic[0]) == 0xFF && static_cast<unsigned char>(magic[1]) == 0xD8);  // JPEG SOI
        cv::Mat decoded = cv::imread((images / "mtg" / "mtg-red.jpg").string());
        CHECK(!decoded.empty() && decoded.cols == 64 && decoded.rows == 90);
        CHECK(decoded.at<cv::Vec3b>(40, 30)[2] > 180);  // still red

        auto rows = cardcatalog::Reader(db);
        CHECK_EQ(rows.by_uid("mtg-red")->image_path, std::string("mtg/mtg-red.jpg"));
        CHECK_EQ(rows.by_uid("pkm-blue?")->image_path, std::string("pokemon/pkm-blue_.jpg"));
        CHECK(rows.by_uid("mtg-missing")->image_path.empty());   // failures leave no path, so a re-run retries them
        CHECK(rows.by_uid("mtg-noimage")->image_path.empty());

        // re-running: only the failures are tried again
        int before = net.requests;
        auto again = cardvectors::download_images(writer, fetcher, images, "", 4, 0, log_fn);
        CHECK_EQ(again.downloaded, static_cast<size_t>(0));
        CHECK_EQ(again.failed, static_cast<size_t>(2));
        CHECK_EQ(net.requests - before, 2);

        // an image already on disk (but not in the catalog) is reused, not downloaded
        writer.upsert_cards({{"mtg-ondisk", "mtg", "On Disk", "AAA", "A", "7", "common", "", "http://img/ondisk.png"}});
        fs::create_directories(images / "mtg");
        std::ofstream(images / "mtg" / "mtg-ondisk.jpg", std::ios::binary) << encode(cv::Mat(10, 10, CV_8UC3, cv::Scalar(1, 2, 3)), ".jpg");
        before = net.requests;
        auto reuse = cardvectors::download_images(writer, fetcher, images, "mtg", 4, 0, log_fn);
        CHECK_EQ(reuse.reused, static_cast<size_t>(1));
        CHECK_EQ(net.requests - before, 2);  // just the two failures again, nothing for the reused one
        CHECK_EQ(cardcatalog::Reader(db).by_uid("mtg-ondisk")->image_path, std::string("mtg/mtg-ondisk.jpg"));

        // --only restricts to one game
        writer.upsert_cards({{"pkm-late", "pokemon", "Late", "BBB", "B", "9", "rare", "", "http://img/late.png"}});
        net.pages["http://img/late.png"] = {200, solid_png(100, 100, 100)};
        auto only_mtg = cardvectors::download_images(writer, fetcher, images, "mtg", 2, 0, log_fn);
        CHECK(!fs::exists(images / "pokemon" / "pkm-late.jpg"));
        (void)only_mtg;
        cardvectors::download_images(writer, fetcher, images, "pokemon", 2, 0, log_fn);
        CHECK(fs::exists(images / "pokemon" / "pkm-late.jpg"));
    }

    // ===================== vectors =====================
    {
        FakeEmbedder embedder;
        auto stats = cardvectors::build_vectors(writer, embedder, images, index_path, "", 2, 2, log_fn);
        // red, green, blue, yellow, on-disk (a 10x10 image), late = 6 cards with images
        CHECK_EQ(stats.embedded, static_cast<size_t>(6));
        CHECK_EQ(stats.skipped, static_cast<size_t>(0));
        CHECK_EQ(stats.total_vectors, static_cast<std::int64_t>(6));
        CHECK(fs::exists(index_path));
        CHECK(!fs::exists(fs::path(index_path.string() + ".part")));

        auto index = cardvec::FlatIndexIP::load(index_path.string());
        CHECK_EQ(index.ntotal(), static_cast<std::int64_t>(6));
        CHECK_EQ(index.dim(), static_cast<std::int64_t>(4));

        // every card with an image got a distinct row, and that row holds *its* normalized vector
        cardcatalog::Reader r(db);
        std::set<std::int64_t> seen;
        for (const char* uid : {"mtg-red", "mtg-green", "pkm-blue?", "ygo-yellow", "mtg-ondisk", "pkm-late"}) {
            auto c = r.by_uid(uid);
            CHECK(c.has_value() && c->vector_idx.has_value());
            if (!c || !c->vector_idx) continue;
            CHECK(seen.insert(*c->vector_idx).second);
            std::vector<float> v(4);
            index.reconstruct(*c->vector_idx, v.data());
            CHECK(std::fabs(norm(v) - 1.f) < 1e-5f);  // L2-normalized, so inner product == cosine similarity
        }
        CHECK(!r.by_uid("mtg-missing")->vector_idx.has_value());  // no image, no vector
        CHECK(!r.by_uid("mtg-noimage")->vector_idx.has_value());

        // searching with a red card's vector finds the red card's row first
        FakeEmbedder probe;
        cardscan::Image red;
        red.width = 8, red.height = 8, red.bgr.assign(8 * 8 * 3, 0);
        for (size_t i = 0; i < red.bgr.size(); i += 3) red.bgr[i] = 20, red.bgr[i + 1] = 20, red.bgr[i + 2] = 220;
        auto q = probe.embed(red);
        cardvec::normalize_L2(q.data(), 1, 4);
        float scores[3];
        std::int64_t labels[3];
        index.search(q.data(), 1, 3, scores, labels);
        CHECK_EQ(labels[0], *r.by_uid("mtg-red")->vector_idx);

        // nothing left to do, and no more work for the model
        int calls_before = embedder.calls;
        auto idle = cardvectors::build_vectors(writer, embedder, images, index_path, "", 2, 2, log_fn);
        CHECK_EQ(idle.embedded, static_cast<size_t>(0));
        CHECK_EQ(idle.total_vectors, static_cast<std::int64_t>(6));
        CHECK_EQ(embedder.calls, calls_before);

        // new cards are appended after the existing ones
        writer.upsert_cards({{"mtg-new", "mtg", "New", "AAA", "A", "10", "common", "", "http://img/new.png"}});
        net.pages["http://img/new.png"] = {200, solid_png(200, 100, 50)};
        cardvectors::download_images(writer, fetcher, images, "", 2, 0, log_fn);
        auto more = cardvectors::build_vectors(writer, embedder, images, index_path, "", 2, 2, log_fn);
        CHECK_EQ(more.embedded, static_cast<size_t>(1));
        CHECK_EQ(more.total_vectors, static_cast<std::int64_t>(7));
        CHECK_EQ(cardcatalog::Reader(db).by_uid("mtg-new")->vector_idx.value_or(-1), static_cast<std::int64_t>(6));

        // a mismatched embedder (different output size) is refused rather than silently corrupting the index
        writer.upsert_cards({{"mtg-wide", "mtg", "Wide", "AAA", "A", "11", "common", "", "http://img/wide.png"}});
        net.pages["http://img/wide.png"] = {200, solid_png(1, 2, 3)};
        cardvectors::download_images(writer, fetcher, images, "", 2, 0, log_fn);
        FakeEmbedder wide;
        wide.dim = 8;
        bool threw = false;
        try {
            cardvectors::build_vectors(writer, wide, images, index_path, "", 2, 2, log_fn);
        } catch (const std::runtime_error& e) {
            threw = std::string(e.what()).find("dimension") != std::string::npos;
        }
        CHECK(threw);
        CHECK_EQ(cardvec::FlatIndexIP::load(index_path.string()).ntotal(), static_cast<std::int64_t>(7));  // untouched
        CHECK(!cardcatalog::Reader(db).by_uid("mtg-wide")->vector_idx.has_value());
    }

    // ===================== crash safety =====================
    {
        cardtest::TempDir t2;
        const fs::path db2 = t2.path() / "cards.sqlite3", images2 = t2.path() / "images", index2 = t2.path() / "idx.cvi";
        cardcatalog::Writer w2(db2);
        FakeTransport net2;
        cardfetch::Fetcher f2(net2, t2.path() / "cache");
        for (int i = 0; i < 25; ++i) {
            std::string uid = "mtg-" + std::to_string(i);
            w2.upsert_cards({{uid, "mtg", "Card " + std::to_string(i), "AAA", "A", std::to_string(i), "common", "", "http://img/" + uid}});
            net2.pages["http://img/" + uid] = {200, solid_png(i * 9, 255 - i * 9, 40)};
        }
        cardvectors::download_images(w2, f2, images2, "", 4, 0, log_fn);

        // dies while embedding the 15th card (batch size 1 => checkpoints after batches 10 and, if it got that far, 20)
        FakeEmbedder crashing;
        crashing.throw_on_call = 15;
        bool crashed = false;
        try {
            cardvectors::build_vectors(w2, crashing, images2, index2, "", 1, 1, log_fn);
        } catch (const std::runtime_error&) {
            crashed = true;
        }
        CHECK(crashed);
        // the one checkpoint that happened is complete and consistent: the index has 10 vectors and exactly 10 rows point into it
        CHECK_EQ(cardvec::FlatIndexIP::load(index2.string()).ntotal(), static_cast<std::int64_t>(10));
        {
            cardcatalog::Reader r2(db2);
            int recorded = 0;
            for (int i = 0; i < 25; ++i) {
                auto c = r2.by_uid("mtg-" + std::to_string(i));
                if (c->vector_idx) {
                    ++recorded;
                    CHECK(*c->vector_idx < 10);  // never a row pointing past the end of the saved index
                }
            }
            CHECK_EQ(recorded, 10);
        }
        // resuming finishes the job, and every card's row holds that card's own vector
        FakeEmbedder resumed;
        auto done = cardvectors::build_vectors(w2, resumed, images2, index2, "", 1, 1, log_fn);
        CHECK_EQ(done.embedded, static_cast<size_t>(15));
        CHECK_EQ(done.total_vectors, static_cast<std::int64_t>(25));
        auto idx = cardvec::FlatIndexIP::load(index2.string());
        cardcatalog::Reader r3(db2);
        for (int i = 0; i < 25; ++i) {
            auto c = r3.by_uid("mtg-" + std::to_string(i));
            CHECK(c->vector_idx.has_value());
            if (!c->vector_idx) continue;
            std::vector<float> stored(4), expected = FakeEmbedder().embed([&] {
                cv::Mat m = cv::imread((images2 / "mtg" / ("mtg-" + std::to_string(i) + ".jpg")).string());
                cardscan::Image im;
                im.width = m.cols, im.height = m.rows, im.bgr.assign(m.data, m.data + m.total() * 3);
                return im;
            }());
            cardvec::normalize_L2(expected.data(), 1, 4);
            idx.reconstruct(*c->vector_idx, stored.data());
            for (int k = 0; k < 4; ++k) CHECK(std::fabs(stored[k] - expected[k]) < 1e-4f);
        }
    }

    // ===================== unreadable images are skipped =====================
    {
        cardtest::TempDir t3;
        cardcatalog::Writer w3(t3.path() / "c.sqlite3");
        w3.upsert_cards({{"mtg-a", "mtg", "A", "X", "S", "1", "c", "", "u"}, {"mtg-b", "mtg", "B", "X", "S", "2", "c", "", "u"}});
        w3.set_image_paths({{"mtg-a", "mtg/mtg-a.jpg"}, {"mtg-b", "mtg/mtg-b.jpg"}});
        fs::create_directories(t3.path() / "images" / "mtg");
        std::ofstream(t3.path() / "images" / "mtg" / "mtg-a.jpg", std::ios::binary) << encode(cv::Mat(20, 20, CV_8UC3, cv::Scalar(5, 6, 7)), ".jpg");
        std::ofstream(t3.path() / "images" / "mtg" / "mtg-b.jpg", std::ios::binary) << "corrupt";
        FakeEmbedder e;
        auto stats = cardvectors::build_vectors(w3, e, t3.path() / "images", t3.path() / "i.cvi", "", 8, 1, log_fn);
        CHECK_EQ(stats.embedded, static_cast<size_t>(1));
        CHECK_EQ(stats.skipped, static_cast<size_t>(1));
        CHECK(cardcatalog::Reader(t3.path() / "c.sqlite3").by_uid("mtg-a")->vector_idx.has_value());
        CHECK(!cardcatalog::Reader(t3.path() / "c.sqlite3").by_uid("mtg-b")->vector_idx.has_value());
    }

    // ===================== cleanup =====================
    CHECK(fs::exists(images / "mtg"));
    CHECK(cardvectors::cleanup_images(images, "mtg", log_fn));
    CHECK(!fs::exists(images / "mtg") && fs::exists(images / "pokemon"));  // just that game's folder
    CHECK(cardvectors::cleanup_images(images, "", log_fn));
    CHECK(!fs::exists(images));
    CHECK(!cardvectors::cleanup_images(images, "", log_fn));  // nothing left to remove

    return cardtest::finish("cardvectors");
}
