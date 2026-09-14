#include "cardnet/ocr_pipeline.hpp"

#include "cardnet/ctc_decode.hpp"
#include "cardnet/db_postprocess.hpp"
#include "cardnet/geometry.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace cardnet {

namespace {

// Resizes+normalizes for the *detection* model: scale so the longer side
// is at most det_limit_side, then round each dimension independently to
// the nearest multiple of 32 (PaddleOCR's DetResizeForTest) — tracking
// ratio_h/ratio_w separately, since the two independent roundings can
// introduce slightly different x/y scale factors. Normalization uses
// ImageNet mean/std, matching PaddleOCR's det NormalizeImage config.
struct DetPrep {
    std::vector<float> chw;
    std::int32_t resized_h, resized_w;
    float ratio_h, ratio_w;
};

std::int32_t round_to_32(std::int32_t v) {
    std::int32_t r = static_cast<std::int32_t>(std::lround(v / 32.0)) * 32;
    return std::max(32, r);
}

DetPrep prep_for_detection(const std::uint8_t* src, std::int32_t h, std::int32_t w, std::int32_t limit_side) {
    float ratio = static_cast<float>(limit_side) / static_cast<float>(std::max(h, w));
    ratio = std::min(ratio, 1.0f); // never upscale beyond the model's intended input range
    std::int32_t target_h = std::max(1, static_cast<std::int32_t>(std::lround(h * ratio)));
    std::int32_t target_w = std::max(1, static_cast<std::int32_t>(std::lround(w * ratio)));
    std::int32_t resized_h = round_to_32(target_h);
    std::int32_t resized_w = round_to_32(target_w);
    float ratio_h = static_cast<float>(resized_h) / h;
    float ratio_w = static_cast<float>(resized_w) / w;

    static constexpr float kMean[3] = {0.485f, 0.456f, 0.406f};
    static constexpr float kStd[3] = {0.229f, 0.224f, 0.225f};

    std::vector<float> chw(static_cast<std::size_t>(3) * resized_h * resized_w);
    float scale_y = static_cast<float>(h) / resized_h;
    float scale_x = static_cast<float>(w) / resized_w;
    for (std::int32_t dy = 0; dy < resized_h; ++dy) {
        float sy = std::clamp((dy + 0.5f) * scale_y - 0.5f, 0.f, float(h - 1));
        std::int32_t y0 = static_cast<std::int32_t>(sy), y1 = std::min(y0 + 1, h - 1);
        float fy = sy - y0;
        for (std::int32_t dx = 0; dx < resized_w; ++dx) {
            float sx = std::clamp((dx + 0.5f) * scale_x - 0.5f, 0.f, float(w - 1));
            std::int32_t x0 = static_cast<std::int32_t>(sx), x1 = std::min(x0 + 1, w - 1);
            float fx = sx - x0;
            for (int c = 0; c < 3; ++c) {
                int sc = 2 - c; // BGR -> RGB
                float v00 = src[(static_cast<std::size_t>(y0) * w + x0) * 3 + sc];
                float v01 = src[(static_cast<std::size_t>(y0) * w + x1) * 3 + sc];
                float v10 = src[(static_cast<std::size_t>(y1) * w + x0) * 3 + sc];
                float v11 = src[(static_cast<std::size_t>(y1) * w + x1) * 3 + sc];
                float top = v00 + (v01 - v00) * fx, bot = v10 + (v11 - v10) * fx;
                float val = (top + (bot - top) * fy) / 255.f;
                val = (val - kMean[c]) / kStd[c];
                chw[static_cast<std::size_t>(c) * resized_h * resized_w + dy * resized_w + dx] = val;
            }
        }
    }
    return {std::move(chw), resized_h, resized_w, ratio_h, ratio_w};
}

// Converts a full uint8 BGR image to an interleaved HWC float RGB buffer
// once, so every detected line can be warped out of it directly.
std::vector<float> to_hwc_rgb_float(const std::uint8_t* src, std::int32_t h, std::int32_t w) {
    std::vector<float> out(static_cast<std::size_t>(h) * w * 3);
    for (std::int32_t y = 0; y < h; ++y) {
        for (std::int32_t x = 0; x < w; ++x) {
            for (int c = 0; c < 3; ++c) {
                out[(static_cast<std::size_t>(y) * w + x) * 3 + c] =
                    static_cast<float>(src[(static_cast<std::size_t>(y) * w + x) * 3 + (2 - c)]);
            }
        }
    }
    return out;
}

float dist(const Point2f& a, const Point2f& b) {
    float dx = a.x - b.x, dy = a.y - b.y;
    return std::sqrt(dx * dx + dy * dy);
}

} // namespace

OcrPipeline::OcrPipeline(const std::string& det_onnx_path, const std::string& rec_onnx_path,
                         const std::string& dict_path, std::int32_t det_limit_side, std::int32_t rec_input_height)
    : det_session_(det_onnx_path),
      rec_session_(rec_onnx_path),
      dictionary_(load_dictionary(dict_path)),
      det_limit_side_(det_limit_side),
      rec_input_height_(rec_input_height) {}

std::vector<OcrLine> OcrPipeline::recognize(const std::uint8_t* image_bgr, std::int32_t h, std::int32_t w) {
    if (h <= 0 || w <= 0) return {};

    DetPrep prep = prep_for_detection(image_bgr, h, w, det_limit_side_);
    auto det_outputs = det_session_.run(prep.chw.data(), {1, 3, prep.resized_h, prep.resized_w});
    if (det_outputs.empty()) throw std::runtime_error("cardnet: OCR detector ONNX model produced no output");

    const auto& prob = det_outputs[0];
    // Expect (1, 1, H, W) or (1, H, W) — either way, the last two dims are
    // the probability map, already at (prep.resized_h, prep.resized_w).
    if (prob.shape.size() < 2) throw std::runtime_error("cardnet: unexpected OCR detector output rank");
    std::int32_t map_h = static_cast<std::int32_t>(prob.shape[prob.shape.size() - 2]);
    std::int32_t map_w = static_cast<std::int32_t>(prob.shape[prob.shape.size() - 1]);

    auto boxes = db_postprocess(prob.data.data(), map_h, map_w);
    if (boxes.empty()) return {};

    std::vector<float> page_rgb = to_hwc_rgb_float(image_bgr, h, w);

    struct Line {
        OcrLine ocr;
        float avg_y, avg_x;
    };
    std::vector<Line> lines;
    lines.reserve(boxes.size());

    for (auto& box : boxes) {
        // Map the quad from the detector's resized coordinate space back
        // to the original image's own pixel space.
        std::array<Point2f, 4> quad = box.quad;
        for (auto& p : quad) {
            p.x = p.x / map_w * prep.resized_w / prep.ratio_w;
            p.y = p.y / map_h * prep.resized_h / prep.ratio_h;
            p.x = std::clamp(p.x, 0.f, float(w - 1));
            p.y = std::clamp(p.y, 0.f, float(h - 1));
        }

        float edge_w = std::max(dist(quad[0], quad[1]), dist(quad[2], quad[3]));
        float edge_h = std::max(dist(quad[0], quad[3]), dist(quad[1], quad[2]));
        if (edge_w < 1.f || edge_h < 1.f) continue;

        // PaddleOCR rotates near-vertical text lines 90 degrees before
        // recognition; approximate that by feeding warp_quad a
        // cyclically-shifted corner order so the long side becomes the
        // crop's width.
        bool vertical = edge_h / edge_w >= 1.5f;
        std::array<Point2f, 4> warp_corners = vertical
            ? std::array<Point2f, 4>{quad[3], quad[0], quad[1], quad[2]}
            : quad;
        float crop_w = vertical ? edge_h : edge_w;
        float crop_h = vertical ? edge_w : edge_h;

        std::int32_t dst_h = rec_input_height_;
        std::int32_t dst_w = std::max(1, static_cast<std::int32_t>(std::lround(dst_h * (crop_w / crop_h))));

        std::vector<float> crop_rgb = warp_quad(page_rgb.data(), h, w, 3, warp_corners, dst_w, dst_h);

        // PaddleOCR's rec NormalizeImage: (x/255 - 0.5) / 0.5, i.e. maps
        // [0,255] -> [-1,1] — deliberately *not* ImageNet stats, unlike
        // the detector above.
        std::vector<float> chw(static_cast<std::size_t>(3) * dst_h * dst_w);
        for (std::int32_t y = 0; y < dst_h; ++y) {
            for (std::int32_t x = 0; x < dst_w; ++x) {
                for (int c = 0; c < 3; ++c) {
                    float v = crop_rgb[(static_cast<std::size_t>(y) * dst_w + x) * 3 + c] / 255.f;
                    v = (v - 0.5f) / 0.5f;
                    chw[static_cast<std::size_t>(c) * dst_h * dst_w + y * dst_w + x] = v;
                }
            }
        }

        auto rec_outputs = rec_session_.run(chw.data(), {1, 3, dst_h, dst_w});
        if (rec_outputs.empty()) continue;
        const auto& logits = rec_outputs[0];
        if (logits.shape.size() != 3 || logits.shape[0] != 1) continue; // expect (1, T, num_classes)
        std::int64_t T = logits.shape[1], num_classes = logits.shape[2];

        CtcResult decoded = ctc_greedy_decode(logits.data.data(), T, num_classes, dictionary_);
        if (decoded.text.empty()) continue;

        float avg_y = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4.f;
        float avg_x = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4.f;
        lines.push_back({OcrLine{std::move(decoded.text), decoded.confidence}, avg_y, avg_x});
    }

    std::sort(lines.begin(), lines.end(), [](const Line& a, const Line& b) {
        if (std::fabs(a.avg_y - b.avg_y) > 1e-3f) return a.avg_y < b.avg_y;
        return a.avg_x < b.avg_x;
    });

    std::vector<OcrLine> results;
    results.reserve(lines.size());
    for (auto& l : lines) results.push_back(std::move(l.ocr));
    return results;
}

} // namespace cardnet
