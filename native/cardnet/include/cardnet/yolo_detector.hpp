#pragma once
// YOLOv8-family card detector, via an ONNX export (see
// native/cardnet/export/export_yolo.py) of scanner.py's trained
// yolo_card_detector.pt.

#include "cardnet/nms.hpp"
#include "cardnet/ort_session.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace cardnet {

struct Detection {
    Box box; // x0,y0,x1,y1 in the *original* image's own pixel space
    std::int32_t class_id;
    float score;
};

class YoloDetector {
public:
    explicit YoloDetector(const std::string& onnx_path, std::int32_t input_size = 640);

    // `image_bgr` is an interleaved HWC uint8 BGR image (OpenCV/cv2
    // convention), height `h`, width `w`. Detections are returned sorted
    // by descending score (scanner.py's detect_and_classify just wants
    // the highest-confidence one, same as `max(results.boxes, key=...)`
    // did against ultralytics' own output).
    std::vector<Detection> detect(const std::uint8_t* image_bgr, std::int32_t h, std::int32_t w,
                                   float conf_threshold = 0.25f, float iou_threshold = 0.45f);

private:
    OrtSession session_;
    std::int32_t input_size_;
};

} // namespace cardnet
