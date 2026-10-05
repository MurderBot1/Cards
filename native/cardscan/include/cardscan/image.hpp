// Image operations the recognizer needs (decode, focus measure, card quad
// detection, perspective warp, crop), on a plain BGR pixel buffer so the rest
// of cardscan and the ML backends never touch OpenCV types.
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace cardscan {

// Interleaved HWC, 8-bit, BGR.
struct Image {
    int width = 0;
    int height = 0;
    std::vector<std::uint8_t> bgr;

    bool empty() const { return width <= 0 || height <= 0 || bgr.empty(); }
    const std::uint8_t* data() const { return bgr.data(); }
};

struct PointF {
    float x = 0, y = 0;
};
using Quad = std::array<PointF, 4>;  // top-left, top-right, bottom-right, bottom-left

struct Roi {
    int x0, y0, x1, y1;
};

// Cards are warped to this size before OCR/embedding; the ROIs in pipeline_engine.cpp are in this space.
constexpr int kWarpWidth = 750;
constexpr int kWarpHeight = 1050;

// Decodes JPEG/PNG/etc.; nullopt if the bytes aren't a readable image.
std::optional<Image> decode_image(const std::string& bytes);

// Focus measure for a full frame — variance of the Laplacian, higher is sharper. Resized to a fixed
// width first so the score is roughly comparable across camera resolutions.
double blur_score(const Image& image);

// Corners of the largest card-like quadrilateral (edge detection + contour approximation covering at
// least 15% of the frame), ordered tl/tr/br/bl; nullopt if nothing convincing was found.
std::optional<Quad> find_card_quad(const Image& frame);

// Warps the detected card quad to kWarpWidth x kWarpHeight; if no clean quad is found, plain-resizes the
// whole frame (still reasonable, since the scan UI already frames the card fairly tightly).
Image warp_perspective(const Image& frame);

// The sub-rectangle [x0,x1) x [y0,y1), clamped to the image (like numpy slicing).
Image crop(const Image& image, const Roi& roi);

}  // namespace cardscan
