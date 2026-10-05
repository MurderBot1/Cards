#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include <cmath>

#include "cardscan/image.hpp"
#include "cardtest.hpp"

using namespace cardscan;

static std::string encode(const cv::Mat& m, const char* ext) {
    std::vector<uchar> buf;
    cv::imencode(ext, m, buf);
    return std::string(buf.begin(), buf.end());
}

static Image to_image(const cv::Mat& m) {
    Image im;
    im.width = m.cols;
    im.height = m.rows;
    im.bgr.assign(m.data, m.data + m.total() * m.elemSize());
    return im;
}

// A dark frame with a bright, slightly rotated "card" whose corners are known.
static cv::Mat card_frame(std::array<cv::Point, 4>& corners) {
    cv::Mat frame(600, 800, CV_8UC3, cv::Scalar(30, 30, 30));
    corners = {cv::Point(180, 90), cv::Point(560, 70), cv::Point(590, 520), cv::Point(210, 545)};
    std::vector<cv::Point> poly(corners.begin(), corners.end());
    cv::fillConvexPoly(frame, poly, cv::Scalar(230, 235, 240));
    return frame;
}

int main() {
    // ---- decode_image
    {
        cv::Mat m(40, 60, CV_8UC3, cv::Scalar(10, 20, 30));
        for (const char* ext : {".png", ".jpg"}) {
            auto img = decode_image(encode(m, ext));
            CHECK(img.has_value());
            if (img) {
                CHECK_EQ(img->width, 60);
                CHECK_EQ(img->height, 40);
                CHECK_EQ(img->bgr.size(), static_cast<size_t>(60 * 40 * 3));
            }
        }
        auto png = decode_image(encode(m, ".png"));
        CHECK(png && png->bgr[0] == 10 && png->bgr[1] == 20 && png->bgr[2] == 30);  // BGR order, lossless
        CHECK(!decode_image("").has_value());
        CHECK(!decode_image("definitely not an image").has_value());
        CHECK(!decode_image(std::string(1000, '\x7f')).has_value());
    }

    // ---- blur_score: sharp > blurred, roughly resolution-independent, flat == 0
    {
        cv::Mat sharp(480, 640, CV_8UC3);
        for (int y = 0; y < sharp.rows; ++y)
            for (int x = 0; x < sharp.cols; ++x)
                sharp.at<cv::Vec3b>(y, x) = (((x / 8) + (y / 8)) % 2) ? cv::Vec3b(240, 240, 240) : cv::Vec3b(15, 15, 15);
        cv::Mat blurred;
        cv::GaussianBlur(sharp, blurred, cv::Size(0, 0), 6);
        double s = blur_score(to_image(sharp)), b = blur_score(to_image(blurred));
        CHECK(s > 10 * b);
        CHECK(s > 90);  // clears the strictest "high" quality threshold
        CHECK(b < 15);  // fails even the "low" one
        CHECK_EQ(blur_score(to_image(cv::Mat(300, 300, CV_8UC3, cv::Scalar(100, 100, 100)))), 0.0);

        // the same scene at 4x the pixel count scores about the same (scores are taken at width 600)
        cv::Mat big;
        cv::resize(sharp, big, cv::Size(), 4, 4, cv::INTER_NEAREST);
        double sb = blur_score(to_image(big));
        CHECK(sb > 0.2 * s && sb < 5 * s);
        CHECK_EQ(blur_score(Image{}), 0.0);
    }

    // ---- find_card_quad: corners come back ordered tl/tr/br/bl, close to where they were drawn
    {
        std::array<cv::Point, 4> c;
        cv::Mat frame = card_frame(c);
        auto quad = find_card_quad(to_image(frame));
        CHECK(quad.has_value());
        if (quad) {
            for (int i = 0; i < 4; ++i) {
                double d = std::hypot((*quad)[i].x - c[i].x, (*quad)[i].y - c[i].y);
                CHECK(d < 8.0);  // the dilation fattens the outline by a pixel or two
            }
        }
        // a frame with nothing card-like in it -> no quad
        CHECK(!find_card_quad(to_image(cv::Mat(300, 400, CV_8UC3, cv::Scalar(90, 90, 90)))).has_value());
        // a small rectangle (< 15% of the frame) is not a card
        cv::Mat small(600, 800, CV_8UC3, cv::Scalar(30, 30, 30));
        cv::rectangle(small, cv::Point(100, 100), cv::Point(200, 220), cv::Scalar(230, 230, 230), cv::FILLED);
        CHECK(!find_card_quad(to_image(small)).has_value());
        CHECK(!find_card_quad(Image{}).has_value());
    }

    // ---- warp_perspective: card quad -> 750x1050 with the card filling the frame
    {
        std::array<cv::Point, 4> c;
        cv::Mat frame = card_frame(c);
        Image warped = warp_perspective(to_image(frame));
        CHECK_EQ(warped.width, kWarpWidth);
        CHECK_EQ(warped.height, kWarpHeight);
        auto px = [&](int x, int y) { return warped.bgr[(static_cast<size_t>(y) * warped.width + x) * 3]; };
        CHECK(px(375, 525) > 200);  // centre: card colour
        CHECK(px(100, 100) > 200);  // interior near the corners is card, not the dark background
        CHECK(px(650, 950) > 200);

        // no quad -> the whole frame, resized
        Image plain = warp_perspective(to_image(cv::Mat(300, 400, CV_8UC3, cv::Scalar(90, 90, 90))));
        CHECK_EQ(plain.width, kWarpWidth);
        CHECK_EQ(plain.height, kWarpHeight);
    }

    // ---- crop: sub-rectangle, clamped like numpy slicing
    {
        cv::Mat m(100, 200, CV_8UC3);
        for (int y = 0; y < 100; ++y)
            for (int x = 0; x < 200; ++x) m.at<cv::Vec3b>(y, x) = cv::Vec3b(x, y, 7);
        Image im = to_image(m);
        Image c = crop(im, {10, 20, 50, 70});
        CHECK_EQ(c.width, 40);
        CHECK_EQ(c.height, 50);
        CHECK(c.bgr[0] == 10 && c.bgr[1] == 20 && c.bgr[2] == 7);  // top-left pixel
        size_t last = (static_cast<size_t>(c.height) * c.width - 1) * 3;
        CHECK(c.bgr[last] == 49 && c.bgr[last + 1] == 69);  // bottom-right pixel
        Image clamped = crop(im, {150, 50, 999, 999});
        CHECK_EQ(clamped.width, 50);
        CHECK_EQ(clamped.height, 50);
        CHECK(crop(im, {50, 50, 50, 80}).empty());   // zero width
        CHECK(crop(im, {300, 0, 400, 50}).empty());  // entirely outside
    }

    return cardtest::finish("cardscan image");
}
