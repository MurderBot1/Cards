// cardonnx against a real ONNX Runtime. No trained models are needed: the embedder test uses a tiny
// hand-assembled ONNX graph (input (1,3,224,224) -> ReduceMean over H,W -> (1,3)) — the right shape for
// cardnet's DinoEmbedder, whose output is then just the per-channel mean of the normalized image, a value we
// can compute by hand. That model also drives an end-to-end run through the data directory, the
// OnnxModelSource, the cardvec index and the PipelineEngine's art-matching path.
#include <cmath>
#include <fstream>

#include "cardcatalog/catalog.hpp"
#include "cardonnx/onnx_models.hpp"
#include "cardscan/pipeline_engine.hpp"
#include "cardtest.hpp"
#include "cardvec/flat_index.hpp"

namespace fs = std::filesystem;
using namespace cardscan;

namespace pb {  // just enough protobuf wire format to write a tiny ONNX ModelProto

std::string varint(std::uint64_t v) {
    std::string s;
    while (v >= 0x80) {
        s += static_cast<char>((v & 0x7F) | 0x80);
        v >>= 7;
    }
    return s + static_cast<char>(v);
}
std::string tag(int field, int wire_type) { return varint((static_cast<std::uint64_t>(field) << 3) | wire_type); }
std::string vint(int field, std::uint64_t v) { return tag(field, 0) + varint(v); }
std::string bytes(int field, const std::string& b) { return tag(field, 2) + varint(b.size()) + b; }

// ValueInfoProto for a float tensor of the given shape.
std::string value_info(const std::string& name, const std::vector<int>& dims) {
    std::string shape;
    for (int d : dims) shape += bytes(1, vint(1, static_cast<std::uint64_t>(d)));  // Dimension{dim_value}
    std::string tensor = vint(1, 1 /*FLOAT*/) + bytes(2, shape);
    return bytes(1, name) + bytes(2, bytes(1, tensor));
}

// y = ReduceMean(x, axes=[2,3], keepdims=0), opset 13 (where `axes` is still an attribute).
std::string reduce_mean_model() {
    std::string axes = bytes(1, "axes") + vint(20, 7 /*INTS*/) + vint(8, 2) + vint(8, 3);
    std::string keepdims = bytes(1, "keepdims") + vint(20, 2 /*INT*/) + vint(3, 0);
    std::string node = bytes(1, "x") + bytes(2, "y") + bytes(3, "mean") + bytes(4, "ReduceMean") + bytes(5, axes) + bytes(5, keepdims);
    std::string graph = bytes(1, node) + bytes(2, "tiny") + bytes(11, value_info("x", {1, 3, 224, 224})) + bytes(12, value_info("y", {1, 3}));
    return vint(1, 8 /*ir_version*/) + bytes(8, vint(2, 13) /*opset 13*/) + bytes(7, graph);
}

}  // namespace pb

static void write_file(const fs::path& p, const std::string& content) {
    fs::create_directories(p.parent_path());
    std::ofstream(p, std::ios::binary) << content;
}

static Image solid(int w, int h, std::uint8_t b, std::uint8_t g, std::uint8_t r) {
    Image im;
    im.width = w;
    im.height = h;
    im.bgr.resize(static_cast<size_t>(w) * h * 3);
    for (size_t i = 0; i < im.bgr.size(); i += 3) im.bgr[i] = b, im.bgr[i + 1] = g, im.bgr[i + 2] = r;
    return im;
}

static std::vector<float> channel_means(std::uint8_t b, std::uint8_t g, std::uint8_t r) {
    constexpr float mean[3] = {0.485f, 0.456f, 0.406f}, std_[3] = {0.229f, 0.224f, 0.225f};
    return {(r / 255.f - mean[0]) / std_[0], (g / 255.f - mean[1]) / std_[1], (b / 255.f - mean[2]) / std_[2]};
}

static bool throws_runtime_error(const std::function<void()>& f, const std::string& needle) {
    try {
        f();
    } catch (const std::exception& e) {
        return std::string(e.what()).find(needle) != std::string::npos;
    }
    return false;
}

int main() {
    cardtest::TempDir tmp;

    // ---- an empty data directory: nothing is available, nothing throws
    {
        cardonnx::OnnxModelSource src(tmp.path() / "empty");
        CHECK(!src.load_detector().has_value());
        CHECK(src.load_ocr() == nullptr);
        CHECK(src.load_embedder() == nullptr);
        CHECK(src.load_index() == nullptr);
    }

    // ---- detector class names sidecar
    {
        CHECK(cardonnx::load_class_names(tmp.path() / "missing.json").empty());
        write_file(tmp.path() / "names.json", R"({"0": "mtg", "1": "pokemon", "2": "yugioh"})");
        auto names = cardonnx::load_class_names(tmp.path() / "names.json");
        CHECK_EQ(names.size(), static_cast<size_t>(3));
        CHECK(names[0] == "mtg" && names[1] == "pokemon" && names[2] == "yugioh");
        write_file(tmp.path() / "bad1.json", "{not json");
        write_file(tmp.path() / "bad2.json", "[1, 2]");
        write_file(tmp.path() / "bad3.json", R"({"0": 5})");
        for (const char* f : {"bad1.json", "bad2.json", "bad3.json"})
            CHECK(throws_runtime_error([&] { cardonnx::load_class_names(tmp.path() / f); }, "class names"));
    }

    // ---- files that exist but aren't models: the load throws (the pipeline logs it and skips the stage)
    {
        fs::path dir = tmp.path() / "garbage";
        write_file(dir / kDetectorModelFile, "this is not an onnx model");
        write_file(dir / kEmbedderModelFile, "neither is this");
        write_file(dir / kOcrDetModelFile, "x");  // OCR needs all three files, so one alone just means "not available"
        cardonnx::OnnxModelSource src(dir);
        CHECK(throws_runtime_error([&] { src.load_detector(); }, "failed to load ONNX model"));
        CHECK(throws_runtime_error([&] { src.load_embedder(); }, "failed to load ONNX model"));
        CHECK(src.load_ocr() == nullptr);
        write_file(dir / kOcrRecModelFile, "x");
        write_file(dir / kOcrDictFile, "a\nb\n");
        CHECK(throws_runtime_error([&] { src.load_ocr(); }, "failed to load ONNX model"));
    }

    // ---- a real model through ONNX Runtime: the embedder returns per-channel means of the normalized image
    fs::path data = tmp.path() / "data";
    write_file(data / kEmbedderModelFile, pb::reduce_mean_model());
    {
        auto embedder = cardonnx::make_embedder(data / kEmbedderModelFile);
        auto v = embedder->embed(solid(300, 300, 10, 20, 30));  // BGR; any size, resized to 224 internally
        auto want = channel_means(10, 20, 30);
        CHECK_EQ(v.size(), static_cast<size_t>(3));
        for (size_t i = 0; i < 3 && i < v.size(); ++i) CHECK(std::fabs(v[i] - want[i]) < 1e-3f);
        // non-square art crops (like the real ones) work too
        auto w = embedder->embed(solid(600, 460, 10, 20, 30));
        CHECK(w.size() == 3 && std::fabs(w[0] - want[0]) < 1e-3f);
    }

    // ---- end to end: data directory -> OnnxModelSource -> PipelineEngine, matching by art alone
    {
        // two printings of the same card whose art differs in colour; the "index" holds each one's embedding
        fs::path catalog = data / kCatalogFile;
        {
            cardcatalog::Writer w(catalog);
            w.upsert_cards({{"mtg-1", "mtg", "Lightning Bolt", "LEA", "Alpha", "161", "common", "", "http://example/red.jpg"},
                            {"mtg-2", "mtg", "Lightning Bolt", "M10", "Magic 2010", "146", "common", "", "http://example/blue.jpg"}});
            w.set_vector_indexes({{0, "mtg-1"}, {1, "mtg-2"}});
            w.finalize();
        }
        auto embedder = cardonnx::make_embedder(data / kEmbedderModelFile);
        cardvec::FlatIndexIP index(3);
        for (auto bgr : {std::array<std::uint8_t, 3>{30, 30, 220}, std::array<std::uint8_t, 3>{220, 30, 30}}) {  // red art, blue art
            auto v = embedder->embed(solid(224, 224, bgr[0], bgr[1], bgr[2]));
            cardvec::normalize_L2(v.data(), 1, 3);
            index.add(v.data(), 1);
        }
        index.save((data / kVectorIndexFile).string());

        std::vector<std::string> log;
        PipelineEngine engine(catalog, std::make_unique<cardonnx::OnnxModelSource>(data), [&](const std::string& m) { log.push_back(m); });
        engine.warm_up();

        // A frame is a flat colour, so its art crop is too; no OCR model, so the name is unknown and the match is
        // purely art-based (top vector hit, then printing verification).
        auto red = engine.identify(solid(750, 1050, 30, 30, 220), "mtg");
        CHECK(red.card.has_value() && (*red.card)["id"] == "mtg-1");
        auto blue = engine.identify(solid(750, 1050, 220, 30, 30), "mtg");
        CHECK(blue.card.has_value() && (*blue.card)["id"] == "mtg-2");
        CHECK(red.card && (*red.card)["image"] == "http://example/red.jpg");
        CHECK(log.empty());
        for (auto& line : log) std::fprintf(stderr, "log: %s\n", line.c_str());
    }

    return cardtest::finish("cardonnx");
}
