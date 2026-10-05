#include "cardscan/image.hpp"

#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include <algorithm>

namespace cardscan {

namespace {

// Zero-copy cv::Mat view over an Image's pixels.
cv::Mat view(const Image& im) {
    return cv::Mat(im.height, im.width, CV_8UC3, const_cast<std::uint8_t*>(im.bgr.data()));
}

Image from_mat(const cv::Mat& m) {
    cv::Mat c = m.isContinuous() ? m : m.clone();
    Image out;
    out.width = c.cols;
    out.height = c.rows;
    out.bgr.assign(c.data, c.data + c.total() * c.elemSize());
    return out;
}

constexpr int kBlurResizeWidth = 600;

Quad order_corners(const std::array<cv::Point2f, 4>& pts) {
    // tl has the smallest x+y, br the largest; tr has the smallest y-x, bl the largest.
    // (first index wins ties, like numpy's argmin/argmax)
    int tl = 0, br = 0, tr = 0, bl = 0;
    for (int i = 1; i < 4; ++i) {
        float s = pts[i].x + pts[i].y, d = pts[i].y - pts[i].x;
        if (s < pts[tl].x + pts[tl].y) tl = i;
        if (s > pts[br].x + pts[br].y) br = i;
        if (d < pts[tr].y - pts[tr].x) tr = i;
        if (d > pts[bl].y - pts[bl].x) bl = i;
    }
    auto pt = [&](int i) { return PointF{pts[i].x, pts[i].y}; };
    return {pt(tl), pt(tr), pt(br), pt(bl)};
}

}  // namespace

std::optional<Image> decode_image(const std::string& bytes) {
    if (bytes.empty()) return std::nullopt;
    cv::Mat raw(1, static_cast<int>(bytes.size()), CV_8UC1, const_cast<char*>(bytes.data()));
    cv::Mat img;
    try {
        img = cv::imdecode(raw, cv::IMREAD_COLOR);
    } catch (const cv::Exception&) {
        return std::nullopt;
    }
    if (img.empty()) return std::nullopt;
    return from_mat(img);
}

double blur_score(const Image& image) {
    if (image.empty()) return 0.0;
    cv::Mat bgr = view(image);
    if (bgr.cols > kBlurResizeWidth) {
        double scale = static_cast<double>(kBlurResizeWidth) / bgr.cols;
        cv::Mat resized;
        cv::resize(bgr, resized, cv::Size(kBlurResizeWidth, static_cast<int>(bgr.rows * scale)), 0, 0, cv::INTER_AREA);
        bgr = resized;
    }
    cv::Mat gray, lap;
    cv::cvtColor(bgr, gray, cv::COLOR_BGR2GRAY);
    cv::Laplacian(gray, lap, CV_64F);
    cv::Scalar mean, stddev;
    cv::meanStdDev(lap, mean, stddev);
    return stddev[0] * stddev[0];  // population variance
}

std::optional<Quad> find_card_quad(const Image& frame) {
    if (frame.empty()) return std::nullopt;
    cv::Mat gray;
    cv::cvtColor(view(frame), gray, cv::COLOR_BGR2GRAY);
    cv::GaussianBlur(gray, gray, cv::Size(5, 5), 0);
    cv::Mat edges;
    cv::Canny(gray, edges, 50, 150);
    cv::dilate(edges, edges, cv::Mat::ones(3, 3, CV_8U), cv::Point(-1, -1), 1);
    std::vector<std::vector<cv::Point>> contours;
    cv::findContours(edges, contours, cv::RETR_EXTERNAL, cv::CHAIN_APPROX_SIMPLE);

    const double frame_area = static_cast<double>(frame.height) * frame.width;
    std::vector<cv::Point> best;
    double best_area = 0;
    for (const auto& c : contours) {
        double peri = cv::arcLength(c, true);
        std::vector<cv::Point> approx;
        cv::approxPolyDP(c, approx, 0.02 * peri, true);
        double area = cv::contourArea(approx);
        if (approx.size() == 4 && area > 0.15 * frame_area && area > best_area) {
            best = approx;
            best_area = area;
        }
    }
    if (best.empty()) return std::nullopt;
    std::array<cv::Point2f, 4> pts;
    for (int i = 0; i < 4; ++i) pts[i] = cv::Point2f(static_cast<float>(best[i].x), static_cast<float>(best[i].y));
    return order_corners(pts);
}

Image warp_perspective(const Image& frame) {
    cv::Mat src = view(frame);
    cv::Mat out;
    auto quad = find_card_quad(frame);
    if (!quad) {
        cv::resize(src, out, cv::Size(kWarpWidth, kWarpHeight));
        return from_mat(out);
    }
    cv::Point2f from[4], to[4] = {{0, 0},
                                  {static_cast<float>(kWarpWidth), 0},
                                  {static_cast<float>(kWarpWidth), static_cast<float>(kWarpHeight)},
                                  {0, static_cast<float>(kWarpHeight)}};
    for (int i = 0; i < 4; ++i) from[i] = cv::Point2f((*quad)[i].x, (*quad)[i].y);
    cv::Mat matrix = cv::getPerspectiveTransform(from, to);
    cv::warpPerspective(src, out, matrix, cv::Size(kWarpWidth, kWarpHeight));
    return from_mat(out);
}

Image crop(const Image& image, const Roi& roi) {
    int x0 = std::clamp(roi.x0, 0, image.width), x1 = std::clamp(roi.x1, 0, image.width);
    int y0 = std::clamp(roi.y0, 0, image.height), y1 = std::clamp(roi.y1, 0, image.height);
    Image out;
    if (x1 <= x0 || y1 <= y0) return out;
    out.width = x1 - x0;
    out.height = y1 - y0;
    out.bgr.resize(static_cast<size_t>(out.width) * out.height * 3);
    for (int y = 0; y < out.height; ++y) {
        const std::uint8_t* src = image.bgr.data() + (static_cast<size_t>(y0 + y) * image.width + x0) * 3;
        std::copy(src, src + static_cast<size_t>(out.width) * 3, out.bgr.data() + static_cast<size_t>(y) * out.width * 3);
    }
    return out;
}

}  // namespace cardscan
