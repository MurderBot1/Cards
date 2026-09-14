#pragma once
// Small 2-D geometry helpers shared by db_postprocess.cpp and
// ocr_pipeline.cpp: convex hull, minimum-area rotated rectangle, and a
// perspective warp+sample — the pieces OpenCV would normally supply
// (cv2.minAreaRect, cv2.warpPerspective), reimplemented directly since
// pulling in all of OpenCV for three functions isn't worth it here.

#include <array>
#include <cstdint>
#include <vector>

namespace cardnet {

struct Point2f {
    float x, y;
};

// A rotated rectangle, described the same way cv2.minAreaRect does:
// center, (width, height), and rotation angle in degrees.
struct RotatedRect {
    Point2f center;
    float width, height;
    float angle_deg;

    // The 4 corners in a fixed winding order (not guaranteed tl/tr/br/bl —
    // callers that need a specific reading order should reorder, e.g. via
    // order_quad_corners below).
    std::array<Point2f, 4> points() const;
};

// Andrew's monotone chain convex hull. Returns hull points in
// counter-clockwise order. Input order doesn't matter; duplicate points
// are fine.
std::vector<Point2f> convex_hull(const std::vector<Point2f>& pts);

// Minimum-area bounding rectangle of a (already convex) point set, via
// rotating calipers over its edges. `hull` must have >= 1 point;
// degenerate (1-2 point) input returns a zero-area rect at/along those
// points rather than throwing, since callers filter tiny regions out
// downstream anyway.
RotatedRect min_area_rect(const std::vector<Point2f>& hull);

// Reorders 4 arbitrary corners into (top-left, top-right, bottom-right,
// bottom-left) reading order, the convention scanner.py's warp_perspective
// and PaddleOCR's rec crop both expect.
std::array<Point2f, 4> order_quad_corners(const std::array<Point2f, 4>& pts);

// Warps the quadrilateral `src_quad` (tl,tr,br,bl, in `src`'s pixel space)
// of an interleaved (HWC) float image `src` (src_h x src_w x channels,
// row-major) into a dst_w x dst_h x channels axis-aligned output, via a
// perspective homography solved from the 4 point correspondences and
// bilinear sampling — cardnet's equivalent of PaddleOCR's
// get_rotate_crop_image (built on cv2.warpPerspective). Used to crop a
// detected (possibly rotated) text line out of the page image before
// feeding it to the recognition model. Output pixels that map outside
// `src`'s bounds are clamped to the nearest edge pixel.
std::vector<float> warp_quad(const float* src, std::int32_t src_h, std::int32_t src_w,
                              std::int32_t channels, const std::array<Point2f, 4>& src_quad,
                              std::int32_t dst_w, std::int32_t dst_h);

} // namespace cardnet
