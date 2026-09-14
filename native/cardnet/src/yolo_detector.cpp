#include "cardnet/yolo_detector.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace cardnet {

namespace {

struct Letterbox {
    std::vector<float> chw; // 3*size*size, RGB, normalized to [0,1]
    float scale;
    std::int32_t pad_x, pad_y;
};

// Ultralytics' own preprocessing: resize preserving aspect ratio so the
// image fits within size x size, pad the rest with mid-gray (114/255),
// convert BGR->RGB, scale to [0,1], and lay out as CHW.
Letterbox letterbox_resize(const std::uint8_t* src, std::int32_t src_h, std::int32_t src_w, std::int32_t size) {
    float scale = std::min(static_cast<float>(size) / src_w, static_cast<float>(size) / src_h);
    std::int32_t new_w = std::max(1, static_cast<std::int32_t>(std::lround(src_w * scale)));
    std::int32_t new_h = std::max(1, static_cast<std::int32_t>(std::lround(src_h * scale)));
    std::int32_t pad_x = (size - new_w) / 2;
    std::int32_t pad_y = (size - new_h) / 2;

    std::vector<float> chw(static_cast<std::size_t>(3) * size * size, 114.f / 255.f);
    float scale_y = static_cast<float>(src_h) / new_h;
    float scale_x = static_cast<float>(src_w) / new_w;

    for (std::int32_t dy = 0; dy < new_h; ++dy) {
        float sy = std::clamp((dy + 0.5f) * scale_y - 0.5f, 0.f, float(src_h - 1));
        std::int32_t y0 = static_cast<std::int32_t>(sy);
        std::int32_t y1 = std::min(y0 + 1, src_h - 1);
        float fy = sy - y0;
        for (std::int32_t dx = 0; dx < new_w; ++dx) {
            float sx = std::clamp((dx + 0.5f) * scale_x - 0.5f, 0.f, float(src_w - 1));
            std::int32_t x0 = static_cast<std::int32_t>(sx);
            std::int32_t x1 = std::min(x0 + 1, src_w - 1);
            float fx = sx - x0;

            std::int32_t out_y = pad_y + dy, out_x = pad_x + dx;
            for (int c = 0; c < 3; ++c) {
                int sc = 2 - c; // BGR source -> RGB destination
                float v00 = src[(static_cast<std::size_t>(y0) * src_w + x0) * 3 + sc];
                float v01 = src[(static_cast<std::size_t>(y0) * src_w + x1) * 3 + sc];
                float v10 = src[(static_cast<std::size_t>(y1) * src_w + x0) * 3 + sc];
                float v11 = src[(static_cast<std::size_t>(y1) * src_w + x1) * 3 + sc];
                float top = v00 + (v01 - v00) * fx;
                float bot = v10 + (v11 - v10) * fx;
                float val = (top + (bot - top) * fy) / 255.f;
                chw[static_cast<std::size_t>(c) * size * size + out_y * size + out_x] = val;
            }
        }
    }
    return {std::move(chw), scale, pad_x, pad_y};
}

} // namespace

YoloDetector::YoloDetector(const std::string& onnx_path, std::int32_t input_size)
    : session_(onnx_path), input_size_(input_size) {}

std::vector<Detection> YoloDetector::detect(const std::uint8_t* image_bgr, std::int32_t h, std::int32_t w,
                                             float conf_threshold, float iou_threshold) {
    Letterbox lb = letterbox_resize(image_bgr, h, w, input_size_);
    auto outputs = session_.run(lb.chw.data(), {1, 3, input_size_, input_size_});
    if (outputs.empty()) throw std::runtime_error("cardnet: YOLO ONNX model produced no output");

    const auto& out = outputs[0];
    // ultralytics' `model.export(format="onnx")` (NMS left out of the
    // graph) produces (1, 4 + num_classes, num_anchors): box params come
    // first (cx, cy, w, h, in the letterboxed input_size x input_size
    // space), then one already-sigmoid-activated score row per class —
    // channel-major, *not* the (1, num_anchors, 4+num_classes) layout
    // you'd get from a naive "one row per detection" mental model.
    if (out.shape.size() != 3 || out.shape[0] != 1) {
        throw std::runtime_error("cardnet: unexpected YOLO output rank/batch (expected (1, C, N))");
    }
    std::int64_t C = out.shape[1], N = out.shape[2];
    std::int64_t num_classes = C - 4;
    if (num_classes <= 0) throw std::runtime_error("cardnet: YOLO output has no class score rows");

    std::vector<Box> boxes;
    std::vector<float> scores;
    std::vector<std::int32_t> class_ids;
    boxes.reserve(N);
    scores.reserve(N);
    class_ids.reserve(N);

    const float* data = out.data.data();
    for (std::int64_t a = 0; a < N; ++a) {
        float cx = data[0 * N + a], cy = data[1 * N + a], bw = data[2 * N + a], bh = data[3 * N + a];
        float best_score = -1.f;
        std::int32_t best_class = 0;
        for (std::int64_t c = 0; c < num_classes; ++c) {
            float s = data[(4 + c) * N + a];
            if (s > best_score) { best_score = s; best_class = static_cast<std::int32_t>(c); }
        }
        if (best_score < conf_threshold) continue;
        boxes.push_back({cx - bw / 2.f, cy - bh / 2.f, cx + bw / 2.f, cy + bh / 2.f});
        scores.push_back(best_score);
        class_ids.push_back(best_class);
    }

    auto keep = nms(boxes, scores, class_ids, iou_threshold);

    std::vector<Detection> results;
    results.reserve(keep.size());
    for (std::int32_t i : keep) {
        float x0 = std::clamp((boxes[i].x0 - lb.pad_x) / lb.scale, 0.f, float(w - 1));
        float y0 = std::clamp((boxes[i].y0 - lb.pad_y) / lb.scale, 0.f, float(h - 1));
        float x1 = std::clamp((boxes[i].x1 - lb.pad_x) / lb.scale, 0.f, float(w - 1));
        float y1 = std::clamp((boxes[i].y1 - lb.pad_y) / lb.scale, 0.f, float(h - 1));
        results.push_back({Box{x0, y0, x1, y1}, class_ids[i], scores[i]});
    }
    return results;
}

} // namespace cardnet
