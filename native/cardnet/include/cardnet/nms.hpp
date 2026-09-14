#pragma once
// Greedy non-maximum suppression, matching ultralytics' default YOLOv8
// detect-head postprocessing closely enough for Binder's single-card-per-
// frame use case: sort by score, greedily keep the highest-scoring box,
// suppress lower-scoring boxes that overlap it past `iou_threshold`.

#include <cstdint>
#include <vector>

namespace cardnet {

struct Box {
    float x0, y0, x1, y1;
};

float iou(const Box& a, const Box& b);

// Returns indices into boxes/scores/class_ids to keep, sorted by
// descending score. Suppression only applies within the same class_id
// unless class_agnostic is true (ultralytics defaults to class-aware
// NMS for its detect head).
std::vector<std::int32_t> nms(const std::vector<Box>& boxes, const std::vector<float>& scores,
                               const std::vector<std::int32_t>& class_ids, float iou_threshold,
                               bool class_agnostic = false);

} // namespace cardnet
