// Dependency-free tests for the parts of cardnet that don't touch ONNX
// Runtime at all: NMS, CTC greedy decode, and the DBNet geometry/
// postprocessing pipeline. All exercised against synthetic data, since
// no trained model weights are needed to check these algorithms are
// implemented correctly.
#include "cardnet/ctc_decode.hpp"
#include "cardnet/db_postprocess.hpp"
#include "cardnet/geometry.hpp"
#include "cardnet/nms.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
int g_failures = 0;
void check(bool cond, const char* msg) {
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        ++g_failures;
    }
}
} // namespace

static void test_nms() {
    using cardnet::Box;
    // Two overlapping boxes of class 0, one isolated box of class 1.
    std::vector<Box> boxes = {
        {0, 0, 10, 10},   // 0: class 0, high score, kept
        {1, 1, 11, 11},   // 1: class 0, overlaps box 0 heavily, suppressed
        {100, 100, 110, 110}, // 2: class 1, isolated, kept
    };
    std::vector<float> scores = {0.9f, 0.8f, 0.95f};
    std::vector<std::int32_t> classes = {0, 0, 1};

    auto keep = cardnet::nms(boxes, scores, classes, 0.5f);
    check(keep.size() == 2, "nms keeps 2 of 3 boxes");
    check(std::find(keep.begin(), keep.end(), 0) != keep.end(), "nms keeps the higher-scoring overlapping box");
    check(std::find(keep.begin(), keep.end(), 1) == keep.end(), "nms suppresses the lower-scoring overlapping box");
    check(std::find(keep.begin(), keep.end(), 2) != keep.end(), "nms keeps the isolated box");
    check(keep[0] == 2, "nms returns boxes sorted by descending score");

    float self_iou = cardnet::iou(boxes[0], boxes[0]);
    check(std::fabs(self_iou - 1.0f) < 1e-6f, "iou of a box with itself is 1.0");
    float no_overlap = cardnet::iou(boxes[0], boxes[2]);
    check(no_overlap == 0.0f, "iou of non-overlapping boxes is 0.0");
}

static void test_ctc_decode() {
    // 3 classes: 0=blank, 1='a', 2='b'. Dictionary maps class-1 -> dict[0].
    std::vector<std::string> dict = {"a", "b"};

    // Sequence: a, a, blank, a, b, b -> collapse adjacent dup raw preds:
    // [a,a,blank,a,b,b] -> dedupe adjacent -> [a,blank,a,b] -> drop blank -> "aab"
    auto logit_row = [](int cls) {
        std::vector<float> row(3, -5.f);
        row[cls] = 5.f;
        return row;
    };
    std::vector<int> seq = {1, 1, 0, 1, 2, 2};
    std::vector<float> logits;
    for (int c : seq) {
        auto row = logit_row(c);
        logits.insert(logits.end(), row.begin(), row.end());
    }

    auto result = cardnet::ctc_greedy_decode(logits.data(), seq.size(), 3, dict);
    check(result.text == "aab", "ctc greedy decode collapses repeats and drops blanks");
    check(result.confidence > 0.9f, "ctc confidence is high for confident (peaky) logits");

    // A dictionary of the wrong size must be rejected loudly, not silently
    // misread character classes.
    bool threw = false;
    try {
        cardnet::ctc_greedy_decode(logits.data(), seq.size(), 3, std::vector<std::string>{"a"});
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    check(threw, "ctc_greedy_decode rejects a mismatched dictionary size");
}

static void test_geometry() {
    using cardnet::Point2f;
    // A simple axis-aligned square plus an interior point that must not
    // appear in the hull.
    std::vector<Point2f> pts = {{0, 0}, {10, 0}, {10, 10}, {0, 10}, {5, 5}};
    auto hull = cardnet::convex_hull(pts);
    check(hull.size() == 4, "convex_hull of a square (+ interior point) has 4 vertices");

    auto rect = cardnet::min_area_rect(hull);
    check(std::fabs(rect.width * rect.height - 100.f) < 1e-2f, "min_area_rect recovers the square's area");
    float min_dim = std::min(rect.width, rect.height);
    float max_dim = std::max(rect.width, rect.height);
    check(std::fabs(min_dim - 10.f) < 1e-2f && std::fabs(max_dim - 10.f) < 1e-2f,
          "min_area_rect recovers the square's side length");

    // order_quad_corners: scrambled input must come back tl/tr/br/bl.
    std::array<Point2f, 4> scrambled = {{{10, 10}, {0, 0}, {0, 10}, {10, 0}}}; // br, tl, bl, tr
    auto ordered = cardnet::order_quad_corners(scrambled);
    check(ordered[0].x == 0 && ordered[0].y == 0, "order_quad_corners: tl");
    check(ordered[1].x == 10 && ordered[1].y == 0, "order_quad_corners: tr");
    check(ordered[2].x == 10 && ordered[2].y == 10, "order_quad_corners: br");
    check(ordered[3].x == 0 && ordered[3].y == 10, "order_quad_corners: bl");

    // warp_quad: a 1-channel 4x4 checkerboard-ish gradient, warped from its
    // own full extent to a same-size output, should be close to identity.
    std::int32_t src_h = 8, src_w = 8, ch = 1;
    std::vector<float> src(src_h * src_w);
    for (int y = 0; y < src_h; ++y)
        for (int x = 0; x < src_w; ++x) src[y * src_w + x] = float(x + y);
    std::array<Point2f, 4> full_quad = {
        Point2f{0, 0}, Point2f{float(src_w - 1), 0}, Point2f{float(src_w - 1), float(src_h - 1)},
        Point2f{0, float(src_h - 1)}};
    auto warped = cardnet::warp_quad(src.data(), src_h, src_w, ch, full_quad, src_w, src_h);
    float max_err = 0.f;
    for (std::size_t i = 0; i < src.size(); ++i) max_err = std::max(max_err, std::fabs(warped[i] - src[i]));
    check(max_err < 1e-2f, "warp_quad over the full image extent is close to the identity");
}

static void test_db_postprocess() {
    // A 40x100 probability map with one confident 10x60 rectangular blob.
    std::int32_t H = 40, W = 100;
    std::vector<float> prob(H * W, 0.05f);
    for (int y = 15; y < 25; ++y)
        for (int x = 20; x < 80; ++x) prob[y * W + x] = 0.95f;

    auto boxes = cardnet::db_postprocess(prob.data(), H, W, /*thresh=*/0.3f, /*box_thresh=*/0.5f,
                                         /*unclip_ratio=*/1.5f, /*min_side=*/3.f);
    check(boxes.size() == 1, "db_postprocess finds exactly one box for one blob");
    if (boxes.size() == 1) {
        const auto& q = boxes[0].quad;
        // Unclipping expands the box outward, so it should be a bit larger
        // than the drawn 60x10 rectangle, but still roughly centered on it
        // and not wildly larger.
        float min_x = std::min({q[0].x, q[1].x, q[2].x, q[3].x});
        float max_x = std::max({q[0].x, q[1].x, q[2].x, q[3].x});
        float width = max_x - min_x;
        check(width > 60.f && width < 90.f, "db_postprocess box width is a plausible unclip of the 60px blob");
        check(boxes[0].score > 0.9f, "db_postprocess score reflects the blob's high probability");
    }
}

int main() {
    test_nms();
    test_ctc_decode();
    test_geometry();
    test_db_postprocess();

    if (g_failures == 0) {
        std::printf("OK: all cardnet pure-C++ tests passed\n");
        return 0;
    }
    std::fprintf(stderr, "%d cardnet pure-C++ test(s) failed\n", g_failures);
    return 1;
}
