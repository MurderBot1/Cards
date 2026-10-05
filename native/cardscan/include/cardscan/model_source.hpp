// File-based model loading: everything the scanner reads lives in one data directory (see cardpaths).
#pragma once

#include <filesystem>
#include <memory>

#include "cardscan/backends.hpp"

namespace cardscan {

// File names inside the data directory.
inline constexpr const char* kCatalogFile = "cards.sqlite3";
inline constexpr const char* kVectorIndexFile = "card-vectors.cvi";
inline constexpr const char* kDetectorModelFile = "yolo_card_detector.onnx";
inline constexpr const char* kDetectorNamesFile = "yolo_card_detector.names.json";
inline constexpr const char* kEmbedderModelFile = "dinov2_vits14.onnx";
inline constexpr const char* kOcrDetModelFile = "ocr_det.onnx";
inline constexpr const char* kOcrRecModelFile = "ocr_rec.onnx";
inline constexpr const char* kOcrDictFile = "ocr_dict.txt";

// The cardvec exact inner-product index stored at `path`; nullptr if the file doesn't exist.
std::unique_ptr<VectorIndex> load_cardvec_index(const std::filesystem::path& path);

// Loads the vector index from the data directory. The ONNX-backed models (detector, OCR, embedder) are
// supplied by a subclass in builds that include ONNX Runtime (see cardscan_onnx); here they're unavailable,
// and the pipeline degrades gracefully.
class DataDirModelSource : public ModelSource {
public:
    explicit DataDirModelSource(std::filesystem::path data_dir) : data_dir_(std::move(data_dir)) {}
    std::unique_ptr<VectorIndex> load_index() override { return load_cardvec_index(data_dir_ / kVectorIndexFile); }

protected:
    const std::filesystem::path& data_dir() const { return data_dir_; }

private:
    std::filesystem::path data_dir_;
};

}  // namespace cardscan
