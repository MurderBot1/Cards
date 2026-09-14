#pragma once
// DINOv2 (vits14) art-crop embedding via an ONNX export of the model —
// see native/cardnet/export/export_dino.py for how that export is made.

#include "cardnet/ort_session.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace cardnet {

// Preprocessing matches scanner.py's old _preprocess_for_dino: resize the
// image's shorter side to DINO_INPUT_SIZE, center-crop to a square, then
// normalize with ImageNet mean/std. The one deliberate difference is the
// resize filter — bilinear here vs. PIL's bicubic there — which is fine
// as long as both the catalog build (build_scanner_models.py) and live
// scanning (scanner.py) go through *this* same code, so the two stay
// comparable to each other; only their absolute values vs. the old
// torch/PIL pipeline differ, and the vector catalog already needs
// rebuilding after this switch regardless (see native/cardvec's index
// format change).
constexpr std::int32_t kDinoInputSize = 224;

class DinoEmbedder {
public:
    explicit DinoEmbedder(const std::string& onnx_path);

    // `image_bgr` is an interleaved HWC uint8 BGR image (OpenCV/cv2
    // convention), height `h`, width `w`. Returns the model's raw
    // embedding (384-dim for vits14) — *not* L2-normalized; callers pass
    // it through cardvec::normalize_L2 themselves, same as the torch.hub
    // path this replaces.
    std::vector<float> embed(const std::uint8_t* image_bgr, std::int32_t h, std::int32_t w);

    std::int32_t embedding_dim() const { return embedding_dim_; }

private:
    OrtSession session_;
    std::int32_t embedding_dim_ = 0;
};

} // namespace cardnet
