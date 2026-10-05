#include "cardonnx/onnx_models.hpp"

#include <fstream>

#include <nlohmann/json.hpp>

#include "cardnet/dino_embedder.hpp"
#include "cardnet/ocr_pipeline.hpp"
#include "cardnet/yolo_detector.hpp"

namespace fs = std::filesystem;

namespace cardonnx {

namespace {

class CardnetDetector : public cardscan::Detector {
public:
    explicit CardnetDetector(const std::string& path) : det_(path) {}
    std::vector<cardscan::Detection> detect(const cardscan::Image& frame) override {
        std::vector<cardscan::Detection> out;
        for (const auto& d : det_.detect(frame.data(), frame.height, frame.width))
            out.push_back({d.box.x0, d.box.y0, d.box.x1, d.box.y1, d.class_id, d.score});
        return out;
    }

private:
    cardnet::YoloDetector det_;
};

class CardnetOcr : public cardscan::Ocr {
public:
    CardnetOcr(const std::string& det, const std::string& rec, const std::string& dict) : ocr_(det, rec, dict) {}
    std::vector<std::string> recognize(const cardscan::Image& image) override {
        std::vector<std::string> out;
        for (const auto& line : ocr_.recognize(image.data(), image.height, image.width)) out.push_back(line.text);
        return out;
    }

private:
    cardnet::OcrPipeline ocr_;
};

class CardnetEmbedder : public cardscan::Embedder {
public:
    explicit CardnetEmbedder(const std::string& path) : emb_(path) {}
    std::vector<float> embed(const cardscan::Image& art) override { return emb_.embed(art.data(), art.height, art.width); }

private:
    cardnet::DinoEmbedder emb_;
};

bool present(const fs::path& p) {
    std::error_code ec;
    return fs::exists(p, ec);
}

}  // namespace

std::unique_ptr<cardscan::Detector> make_detector(const fs::path& onnx_path) { return std::make_unique<CardnetDetector>(onnx_path.string()); }

std::unique_ptr<cardscan::Ocr> make_ocr(const fs::path& det_onnx, const fs::path& rec_onnx, const fs::path& dict) {
    return std::make_unique<CardnetOcr>(det_onnx.string(), rec_onnx.string(), dict.string());
}

std::unique_ptr<cardscan::Embedder> make_embedder(const fs::path& onnx_path) { return std::make_unique<CardnetEmbedder>(onnx_path.string()); }

std::map<int, std::string> load_class_names(const fs::path& json_path) {
    std::map<int, std::string> out;
    if (!present(json_path)) return out;
    std::ifstream f(json_path, std::ios::binary);
    nlohmann::json j = nlohmann::json::parse(f, nullptr, /*allow_exceptions=*/false);
    if (j.is_discarded() || !j.is_object()) throw std::runtime_error("class names file is not a JSON object: " + json_path.string());
    for (auto it = j.begin(); it != j.end(); ++it) {
        if (!it.value().is_string()) throw std::runtime_error("class names must map ids to strings: " + json_path.string());
        out[std::stoi(it.key())] = it.value().get<std::string>();
    }
    return out;
}

std::optional<cardscan::LoadedDetector> OnnxModelSource::load_detector() {
    fs::path model = data_dir() / cardscan::kDetectorModelFile;
    if (!present(model)) return std::nullopt;  // no trained detector: the pipeline falls back to contour detection
    cardscan::LoadedDetector loaded;
    loaded.detector = make_detector(model);
    loaded.class_names = load_class_names(data_dir() / cardscan::kDetectorNamesFile);
    return loaded;
}

std::unique_ptr<cardscan::Ocr> OnnxModelSource::load_ocr() {
    fs::path det = data_dir() / cardscan::kOcrDetModelFile, rec = data_dir() / cardscan::kOcrRecModelFile,
             dict = data_dir() / cardscan::kOcrDictFile;
    if (!(present(det) && present(rec) && present(dict))) return nullptr;  // needs all three exported files
    return make_ocr(det, rec, dict);
}

std::unique_ptr<cardscan::Embedder> OnnxModelSource::load_embedder() {
    fs::path model = data_dir() / cardscan::kEmbedderModelFile;
    if (!present(model)) return nullptr;
    return make_embedder(model);
}

}  // namespace cardonnx
