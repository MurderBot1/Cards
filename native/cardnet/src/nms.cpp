#include "cardnet/nms.hpp"

#include <algorithm>
#include <numeric>

namespace cardnet {

float iou(const Box& a, const Box& b) {
    float ix0 = std::max(a.x0, b.x0);
    float iy0 = std::max(a.y0, b.y0);
    float ix1 = std::min(a.x1, b.x1);
    float iy1 = std::min(a.y1, b.y1);
    float iw = std::max(0.f, ix1 - ix0);
    float ih = std::max(0.f, iy1 - iy0);
    float inter = iw * ih;
    if (inter <= 0.f) return 0.f;
    float area_a = std::max(0.f, a.x1 - a.x0) * std::max(0.f, a.y1 - a.y0);
    float area_b = std::max(0.f, b.x1 - b.x0) * std::max(0.f, b.y1 - b.y0);
    float uni = area_a + area_b - inter;
    return uni <= 0.f ? 0.f : inter / uni;
}

std::vector<std::int32_t> nms(const std::vector<Box>& boxes, const std::vector<float>& scores,
                               const std::vector<std::int32_t>& class_ids, float iou_threshold,
                               bool class_agnostic) {
    std::size_t n = boxes.size();
    std::vector<std::int32_t> order(n);
    std::iota(order.begin(), order.end(), 0);
    std::sort(order.begin(), order.end(),
              [&](std::int32_t a, std::int32_t b) { return scores[a] > scores[b]; });

    std::vector<bool> suppressed(n, false);
    std::vector<std::int32_t> keep;
    keep.reserve(n);

    for (std::int32_t i : order) {
        if (suppressed[i]) continue;
        keep.push_back(i);
        for (std::int32_t j : order) {
            if (j == i || suppressed[j]) continue;
            if (!class_agnostic && class_ids[i] != class_ids[j]) continue;
            if (iou(boxes[i], boxes[j]) > iou_threshold) suppressed[j] = true;
        }
    }
    return keep;
}

} // namespace cardnet
