#include "cardnet/dino_embedder.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace cardnet {

namespace {
constexpr float kImagenetMean[3] = {0.485f, 0.456f, 0.406f};
constexpr float kImagenetStd[3] = {0.229f, 0.224f, 0.225f};

// Bilinear-resamples an interleaved HWC uint8 BGR image into an
// interleaved HWC float RGB image (still in [0,255] — normalization
// happens separately), using half-pixel-center sampling (the same
// convention as PIL/torchvision resizes).
std::vector<float> resize_bilinear_bgr_to_rgb(const std::uint8_t* src, std::int32_t src_h, std::int32_t src_w,
                                               std::int32_t dst_h, std::int32_t dst_w) {
    std::vector<float> out(static_cast<std::size_t>(dst_h) * dst_w * 3);
    float scale_y = static_cast<float>(src_h) / dst_h;
    float scale_x = static_cast<float>(src_w) / dst_w;

    for (std::int32_t dy = 0; dy < dst_h; ++dy) {
        float sy = std::clamp((dy + 0.5f) * scale_y - 0.5f, 0.f, float(src_h - 1));
        std::int32_t y0 = static_cast<std::int32_t>(sy);
        std::int32_t y1 = std::min(y0 + 1, src_h - 1);
        float fy = sy - y0;
        for (std::int32_t dx = 0; dx < dst_w; ++dx) {
            float sx = std::clamp((dx + 0.5f) * scale_x - 0.5f, 0.f, float(src_w - 1));
            std::int32_t x0 = static_cast<std::int32_t>(sx);
            std::int32_t x1 = std::min(x0 + 1, src_w - 1);
            float fx = sx - x0;

            float* dst_px = &out[(static_cast<std::size_t>(dy) * dst_w + dx) * 3];
            for (int c = 0; c < 3; ++c) {
                int sc = 2 - c; // BGR source channel -> RGB destination channel c
                float v00 = src[(static_cast<std::size_t>(y0) * src_w + x0) * 3 + sc];
                float v01 = src[(static_cast<std::size_t>(y0) * src_w + x1) * 3 + sc];
                float v10 = src[(static_cast<std::size_t>(y1) * src_w + x0) * 3 + sc];
                float v11 = src[(static_cast<std::size_t>(y1) * src_w + x1) * 3 + sc];
                float top = v00 + (v01 - v00) * fx;
                float bot = v10 + (v11 - v10) * fx;
                dst_px[c] = top + (bot - top) * fy;
            }
        }
    }
    return out;
}

} // namespace

DinoEmbedder::DinoEmbedder(const std::string& onnx_path) : session_(onnx_path) {}

std::vector<float> DinoEmbedder::embed(const std::uint8_t* image_bgr, std::int32_t h, std::int32_t w) {
    if (h <= 0 || w <= 0) throw std::invalid_argument("cardnet: DinoEmbedder::embed got an empty image");

    float scale = static_cast<float>(kDinoInputSize) / static_cast<float>(std::min(h, w));
    std::int32_t resized_h = std::max(kDinoInputSize, static_cast<std::int32_t>(std::lround(h * scale)));
    std::int32_t resized_w = std::max(kDinoInputSize, static_cast<std::int32_t>(std::lround(w * scale)));

    std::vector<float> resized = resize_bilinear_bgr_to_rgb(image_bgr, h, w, resized_h, resized_w);

    std::int32_t top = (resized_h - kDinoInputSize) / 2;
    std::int32_t left = (resized_w - kDinoInputSize) / 2;

    std::vector<float> chw(static_cast<std::size_t>(3) * kDinoInputSize * kDinoInputSize);
    for (std::int32_t y = 0; y < kDinoInputSize; ++y) {
        for (std::int32_t x = 0; x < kDinoInputSize; ++x) {
            const float* px = &resized[(static_cast<std::size_t>(top + y) * resized_w + (left + x)) * 3];
            for (int c = 0; c < 3; ++c) {
                float v = (px[c] / 255.f - kImagenetMean[c]) / kImagenetStd[c];
                chw[static_cast<std::size_t>(c) * kDinoInputSize * kDinoInputSize + y * kDinoInputSize + x] = v;
            }
        }
    }

    auto outputs = session_.run(chw.data(), {1, 3, kDinoInputSize, kDinoInputSize});
    if (outputs.empty()) throw std::runtime_error("cardnet: DINOv2 ONNX model produced no output");
    embedding_dim_ = static_cast<std::int32_t>(outputs[0].data.size());
    return std::move(outputs[0].data);
}

} // namespace cardnet
