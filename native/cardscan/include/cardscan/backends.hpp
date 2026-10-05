// The ML pieces the pipeline calls out to, behind small interfaces so the pipeline logic (routing,
// fallbacks, candidate filtering) is testable with fakes and doesn't depend on ONNX Runtime. The real
// implementations (cardnet's YOLO / DINOv2 / OCR, cardvec's index) are adapters over these.
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "cardscan/image.hpp"

namespace cardscan {

struct Detection {
    float x0, y0, x1, y1;  // in the frame's own pixel space
    int class_id;
    float score;
};

class Detector {
public:
    virtual ~Detector() = default;
    virtual std::vector<Detection> detect(const Image& frame) = 0;
};

class Ocr {
public:
    virtual ~Ocr() = default;
    virtual std::vector<std::string> recognize(const Image& image) = 0;  // text lines
};

class Embedder {
public:
    virtual ~Embedder() = default;
    virtual std::vector<float> embed(const Image& art_crop) = 0;
};

class VectorIndex {
public:
    virtual ~VectorIndex() = default;
    virtual std::int64_t ntotal() const = 0;
    // Top-k inner-product search for one query vector. Writes k scores (descending) and k labels;
    // missing results are label -1.
    virtual void search(const float* query, std::int64_t k, float* scores, std::int64_t* labels) const = 0;
    virtual std::vector<float> reconstruct(std::int64_t label) const = 0;
};

struct LoadedDetector {
    std::unique_ptr<Detector> detector;
    std::map<int, std::string> class_names;  // class id -> game ("mtg" | "pokemon" | "yugioh")
};

// Where the models come from. Each loader returns nullptr / nullopt when that model isn't available
// (its files haven't been exported yet), and the pipeline degrades gracefully; it may also throw, which
// the pipeline logs and treats the same way.
class ModelSource {
public:
    virtual ~ModelSource() = default;
    virtual std::optional<LoadedDetector> load_detector() { return std::nullopt; }
    virtual std::unique_ptr<Ocr> load_ocr() { return nullptr; }
    virtual std::unique_ptr<Embedder> load_embedder() { return nullptr; }
    virtual std::unique_ptr<VectorIndex> load_index() { return nullptr; }
};

}  // namespace cardscan
