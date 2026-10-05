// cardonnx — cardscan's detector / OCR / embedder backed by ONNX Runtime (via cardnet).
#pragma once

#include <filesystem>
#include <map>
#include <memory>
#include <string>

#include "cardscan/model_source.hpp"

namespace cardonnx {

// Each factory throws std::runtime_error if the model file can't be loaded (missing/corrupt .onnx).
std::unique_ptr<cardscan::Detector> make_detector(const std::filesystem::path& onnx_path);
std::unique_ptr<cardscan::Ocr> make_ocr(const std::filesystem::path& det_onnx, const std::filesystem::path& rec_onnx,
                                        const std::filesystem::path& dict);
std::unique_ptr<cardscan::Embedder> make_embedder(const std::filesystem::path& onnx_path);

// The detector's class id -> game map: a JSON object {"0": "mtg", "1": "pokemon", ...} (the sidecar the
// export script writes next to the model). A missing file is an empty map; malformed JSON throws.
std::map<int, std::string> load_class_names(const std::filesystem::path& json_path);

// Loads everything from the data directory (names in cardscan/model_source.hpp). A model whose files aren't
// there yet is simply unavailable (nullopt / nullptr) and the pipeline skips that stage; a file that is there
// but can't be loaded throws, which the pipeline logs and treats the same way.
class OnnxModelSource : public cardscan::DataDirModelSource {
public:
    using DataDirModelSource::DataDirModelSource;
    std::optional<cardscan::LoadedDetector> load_detector() override;
    std::unique_ptr<cardscan::Ocr> load_ocr() override;
    std::unique_ptr<cardscan::Embedder> load_embedder() override;
};

}  // namespace cardonnx
