#pragma once
// DBNet detection postprocessing — turns a probability map (the raw
// output of PaddleOCR's text-detection model) into text-line boxes.
// Matches PaddleOCR's DBPostProcess in its default configuration:
// box_type="quad", score_mode="fast".

#include "cardnet/geometry.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace cardnet {

struct TextBox {
    std::array<Point2f, 4> quad; // tl, tr, br, bl, in prob_map's coordinate space
    float score;
};

// `prob_map` is an H x W row-major array of per-pixel text probabilities
// in [0, 1]. Steps: binarize at `thresh`, find 8-connected foreground
// components, fit each a minimum-area rotated rectangle, drop rectangles
// whose shorter side is below `min_side` or whose mean probability under
// its axis-aligned bounding box is below `box_thresh`, then "unclip"
// (expand outward, since DB's training target shrinks text regions) by
// `distance = area * unclip_ratio / perimeter`. Stops after
// `max_candidates` boxes (rare in practice for Binder's small ROI crops).
std::vector<TextBox> db_postprocess(const float* prob_map, std::int32_t h, std::int32_t w,
                                     float thresh = 0.3f, float box_thresh = 0.6f,
                                     float unclip_ratio = 1.5f, float min_side = 3.f,
                                     std::size_t max_candidates = 1000);

} // namespace cardnet
