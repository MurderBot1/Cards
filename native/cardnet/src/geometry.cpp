#include "cardnet/geometry.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>

namespace cardnet {

namespace {
constexpr float kPi = 3.14159265358979323846f;

float cross(const Point2f& o, const Point2f& a, const Point2f& b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

// Solves the 8x8 linear system for the projective homography that maps
// `dst_pts` -> `src_pts` (i.e. h such that src = H*dst, so callers can
// look up a source pixel directly for each destination pixel without a
// separate matrix inversion step). Gaussian elimination with partial
// pivoting; the system is always well-conditioned here since the 4
// destination points are the corners of an axis-aligned rectangle.
std::array<float, 8> solve_homography(const std::array<Point2f, 4>& dst_pts,
                                       const std::array<Point2f, 4>& src_pts) {
    double a[8][9] = {};
    for (int i = 0; i < 4; ++i) {
        double x = dst_pts[i].x, y = dst_pts[i].y;
        double X = src_pts[i].x, Y = src_pts[i].y;
        double* r0 = a[2 * i];
        r0[0] = x; r0[1] = y; r0[2] = 1; r0[3] = 0; r0[4] = 0; r0[5] = 0;
        r0[6] = -x * X; r0[7] = -y * X; r0[8] = X;
        double* r1 = a[2 * i + 1];
        r1[0] = 0; r1[1] = 0; r1[2] = 0; r1[3] = x; r1[4] = y; r1[5] = 1;
        r1[6] = -x * Y; r1[7] = -y * Y; r1[8] = Y;
    }

    for (int col = 0; col < 8; ++col) {
        int pivot = col;
        for (int row = col + 1; row < 8; ++row) {
            if (std::fabs(a[row][col]) > std::fabs(a[pivot][col])) pivot = row;
        }
        std::swap(a[col], a[pivot]);
        double d = a[col][col];
        if (std::fabs(d) < 1e-12) d = 1e-12;
        for (int k = col; k < 9; ++k) a[col][k] /= d;
        for (int row = 0; row < 8; ++row) {
            if (row == col) continue;
            double f = a[row][col];
            if (f == 0.0) continue;
            for (int k = col; k < 9; ++k) a[row][k] -= f * a[col][k];
        }
    }

    std::array<float, 8> h;
    for (int i = 0; i < 8; ++i) h[i] = static_cast<float>(a[i][8]);
    return h;
}

} // namespace

std::array<Point2f, 4> RotatedRect::points() const {
    float angle_rad = angle_deg * kPi / 180.f;
    float c = std::cos(angle_rad), s = std::sin(angle_rad);
    float hw = width / 2.f, hh = height / 2.f;
    std::array<Point2f, 4> local = {{{-hw, -hh}, {hw, -hh}, {hw, hh}, {-hw, hh}}};
    std::array<Point2f, 4> out{};
    for (int i = 0; i < 4; ++i) {
        out[i].x = center.x + local[i].x * c - local[i].y * s;
        out[i].y = center.y + local[i].x * s + local[i].y * c;
    }
    return out;
}

std::vector<Point2f> convex_hull(const std::vector<Point2f>& pts_in) {
    std::vector<Point2f> pts = pts_in;
    std::sort(pts.begin(), pts.end(), [](const Point2f& a, const Point2f& b) {
        return a.x < b.x || (a.x == b.x && a.y < b.y);
    });
    pts.erase(std::unique(pts.begin(), pts.end(),
                          [](const Point2f& a, const Point2f& b) { return a.x == b.x && a.y == b.y; }),
              pts.end());

    int n = static_cast<int>(pts.size());
    if (n < 3) return pts;

    std::vector<Point2f> hull(2 * n);
    int k = 0;
    for (int i = 0; i < n; ++i) {
        while (k >= 2 && cross(hull[k - 2], hull[k - 1], pts[i]) <= 0) --k;
        hull[k++] = pts[i];
    }
    for (int i = n - 2, lower = k + 1; i >= 0; --i) {
        while (k >= lower && cross(hull[k - 2], hull[k - 1], pts[i]) <= 0) --k;
        hull[k++] = pts[i];
    }
    hull.resize(k - 1); // last point duplicates the first
    return hull;
}

RotatedRect min_area_rect(const std::vector<Point2f>& hull) {
    if (hull.empty()) return RotatedRect{{0.f, 0.f}, 0.f, 0.f, 0.f};
    if (hull.size() == 1) return RotatedRect{hull[0], 0.f, 0.f, 0.f};
    if (hull.size() == 2) {
        float dx = hull[1].x - hull[0].x, dy = hull[1].y - hull[0].y;
        float len = std::sqrt(dx * dx + dy * dy);
        float angle = std::atan2(dy, dx) * 180.f / kPi;
        Point2f center{(hull[0].x + hull[1].x) / 2.f, (hull[0].y + hull[1].y) / 2.f};
        return RotatedRect{center, len, 0.f, angle};
    }

    std::size_t n = hull.size();
    float best_area = std::numeric_limits<float>::max();
    RotatedRect best{};
    for (std::size_t i = 0; i < n; ++i) {
        const Point2f& p0 = hull[i];
        const Point2f& p1 = hull[(i + 1) % n];
        float edge_angle = std::atan2(p1.y - p0.y, p1.x - p0.x);
        float c = std::cos(-edge_angle), s = std::sin(-edge_angle);

        float minx = std::numeric_limits<float>::max(), maxx = -minx;
        float miny = std::numeric_limits<float>::max(), maxy = -miny;
        for (const auto& p : hull) {
            float rx = p.x * c - p.y * s;
            float ry = p.x * s + p.y * c;
            minx = std::min(minx, rx); maxx = std::max(maxx, rx);
            miny = std::min(miny, ry); maxy = std::max(maxy, ry);
        }
        float w = maxx - minx, h = maxy - miny;
        float area = w * h;
        if (area < best_area) {
            best_area = area;
            float ccx = (minx + maxx) / 2.f, ccy = (miny + maxy) / 2.f;
            float cc = std::cos(edge_angle), ss = std::sin(edge_angle);
            best.center = {ccx * cc - ccy * ss, ccx * ss + ccy * cc};
            best.width = w;
            best.height = h;
            best.angle_deg = edge_angle * 180.f / kPi;
        }
    }
    return best;
}

std::array<Point2f, 4> order_quad_corners(const std::array<Point2f, 4>& pts) {
    int tl = 0, br = 0, tr = 0, bl = 0;
    float min_sum = std::numeric_limits<float>::max(), max_sum = -min_sum;
    float min_diff = std::numeric_limits<float>::max(), max_diff = -min_diff;
    for (int i = 0; i < 4; ++i) {
        float sum = pts[i].x + pts[i].y;
        float diff = pts[i].y - pts[i].x;
        if (sum < min_sum) { min_sum = sum; tl = i; }
        if (sum > max_sum) { max_sum = sum; br = i; }
        if (diff < min_diff) { min_diff = diff; tr = i; }
        if (diff > max_diff) { max_diff = diff; bl = i; }
    }
    return {pts[tl], pts[tr], pts[br], pts[bl]};
}

std::vector<float> warp_quad(const float* src, std::int32_t src_h, std::int32_t src_w,
                              std::int32_t channels, const std::array<Point2f, 4>& src_quad,
                              std::int32_t dst_w, std::int32_t dst_h) {
    std::array<Point2f, 4> dst_pts = {
        Point2f{0.f, 0.f}, Point2f{float(dst_w - 1), 0.f},
        Point2f{float(dst_w - 1), float(dst_h - 1)}, Point2f{0.f, float(dst_h - 1)}};
    std::array<float, 8> h = solve_homography(dst_pts, src_quad);

    std::vector<float> out(static_cast<std::size_t>(dst_h) * dst_w * channels);
    for (std::int32_t dy = 0; dy < dst_h; ++dy) {
        for (std::int32_t dx = 0; dx < dst_w; ++dx) {
            float denom = h[6] * dx + h[7] * dy + 1.f;
            if (std::fabs(denom) < 1e-12f) denom = 1e-12f;
            float sx = (h[0] * dx + h[1] * dy + h[2]) / denom;
            float sy = (h[3] * dx + h[4] * dy + h[5]) / denom;

            sx = std::clamp(sx, 0.f, float(src_w - 1));
            sy = std::clamp(sy, 0.f, float(src_h - 1));
            std::int32_t x0 = static_cast<std::int32_t>(sx);
            std::int32_t y0 = static_cast<std::int32_t>(sy);
            std::int32_t x1 = std::min(x0 + 1, src_w - 1);
            std::int32_t y1 = std::min(y0 + 1, src_h - 1);
            float fx = sx - x0, fy = sy - y0;

            float* dst_px = &out[(static_cast<std::size_t>(dy) * dst_w + dx) * channels];
            for (std::int32_t ch = 0; ch < channels; ++ch) {
                float v00 = src[(static_cast<std::size_t>(y0) * src_w + x0) * channels + ch];
                float v01 = src[(static_cast<std::size_t>(y0) * src_w + x1) * channels + ch];
                float v10 = src[(static_cast<std::size_t>(y1) * src_w + x0) * channels + ch];
                float v11 = src[(static_cast<std::size_t>(y1) * src_w + x1) * channels + ch];
                float top = v00 + (v01 - v00) * fx;
                float bot = v10 + (v11 - v10) * fx;
                dst_px[ch] = top + (bot - top) * fy;
            }
        }
    }
    return out;
}

} // namespace cardnet
