#pragma once
// Combined text detection (DBNet) + recognition (CTC) pipeline — an
// ONNX/C++ replacement for PaddleOCR's `PaddleOCR(...).predict(image)`,
// covering exactly what scanner.py's _ocr_text() uses (rec_texts) and
// nothing else (no doc-orientation classifier, no doc-unwarping — those
// were already disabled in scanner.py's PaddleOCR config, since its ROI
// crops come from an already perspective-corrected card image).

#include "cardnet/ort_session.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace cardnet {

struct OcrLine {
    std::string text;
    float confidence;
};

class OcrPipeline {
public:
    // `dict_path` is a PaddleOCR-format character dictionary file (see
    // cardnet::load_dictionary / native/cardnet/assets/en_dict.txt).
    OcrPipeline(const std::string& det_onnx_path, const std::string& rec_onnx_path, const std::string& dict_path,
                std::int32_t det_limit_side = 736, std::int32_t rec_input_height = 48);

    // `image_bgr` is an interleaved HWC uint8 BGR image (OpenCV/cv2
    // convention). Returns one OcrLine per detected text line, sorted
    // top-to-bottom (then left-to-right) — a simplified version of
    // PaddleOCR's own box sort, adequate for Binder's short 1-2-line ROI
    // crops. Returns an empty vector (not an error) when no text line
    // clears the detector's confidence threshold.
    std::vector<OcrLine> recognize(const std::uint8_t* image_bgr, std::int32_t h, std::int32_t w);

private:
    OrtSession det_session_;
    OrtSession rec_session_;
    std::vector<std::string> dictionary_;
    std::int32_t det_limit_side_;
    std::int32_t rec_input_height_;
};

} // namespace cardnet
