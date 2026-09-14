#include "cardnet/db_postprocess.hpp"

#include <algorithm>
#include <utility>

namespace cardnet {

std::vector<TextBox> db_postprocess(const float* prob_map, std::int32_t H, std::int32_t W, float thresh,
                                     float box_thresh, float unclip_ratio, float min_side,
                                     std::size_t max_candidates) {
    std::vector<std::uint8_t> visited(static_cast<std::size_t>(H) * W, 0);
    std::vector<TextBox> results;
    auto idx = [&](std::int32_t y, std::int32_t x) { return static_cast<std::size_t>(y) * W + x; };

    for (std::int32_t y = 0; y < H && results.size() < max_candidates; ++y) {
        for (std::int32_t x = 0; x < W && results.size() < max_candidates; ++x) {
            if (visited[idx(y, x)] || prob_map[idx(y, x)] <= thresh) continue;

            // 8-connected flood fill collecting every foreground pixel in
            // this component (interior pixels don't affect the convex
            // hull below, just cost a little extra work at this crop size).
            std::vector<Point2f> pts;
            std::vector<std::pair<std::int32_t, std::int32_t>> stack{{y, x}};
            visited[idx(y, x)] = 1;
            std::int32_t minx = x, maxx = x, miny = y, maxy = y;
            while (!stack.empty()) {
                auto [cy, cx] = stack.back();
                stack.pop_back();
                pts.push_back({float(cx), float(cy)});
                minx = std::min(minx, cx); maxx = std::max(maxx, cx);
                miny = std::min(miny, cy); maxy = std::max(maxy, cy);
                for (std::int32_t dy = -1; dy <= 1; ++dy) {
                    for (std::int32_t dx = -1; dx <= 1; ++dx) {
                        if (dy == 0 && dx == 0) continue;
                        std::int32_t ny = cy + dy, nx = cx + dx;
                        if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
                        if (visited[idx(ny, nx)] || prob_map[idx(ny, nx)] <= thresh) continue;
                        visited[idx(ny, nx)] = 1;
                        stack.push_back({ny, nx});
                    }
                }
            }

            // box_score_fast: mean probability under the component's own
            // axis-aligned bounding box (PaddleOCR's default score_mode).
            double sum = 0.0;
            std::int64_t count = 0;
            for (std::int32_t yy = miny; yy <= maxy; ++yy) {
                for (std::int32_t xx = minx; xx <= maxx; ++xx) {
                    sum += prob_map[idx(yy, xx)];
                    ++count;
                }
            }
            float score = count > 0 ? static_cast<float>(sum / count) : 0.f;
            if (score < box_thresh) continue;

            std::vector<Point2f> hull = convex_hull(pts);
            RotatedRect rect = min_area_rect(hull);
            if (std::min(rect.width, rect.height) < min_side) continue;

            float area = rect.width * rect.height;
            float perimeter = 2.f * (rect.width + rect.height);
            float distance = perimeter > 0.f ? area * unclip_ratio / perimeter : 0.f;
            rect.width += 2.f * distance;
            rect.height += 2.f * distance;

            results.push_back({order_quad_corners(rect.points()), score});
        }
    }
    return results;
}

} // namespace cardnet
