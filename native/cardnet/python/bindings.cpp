// Python bindings for cardnet: YOLOv8 card detection, DINOv2 art-crop
// embedding, and PaddleOCR-style text recognition, all via ONNX Runtime.
// Shaped to be a close, easy-to-swap-in replacement for the ultralytics /
// torch.hub / paddleocr calls scanner.py and build_scanner_models.py
// used before.
#include <pybind11/numpy.h>
#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

#include <stdexcept>
#include <string>

#include "cardnet/dino_embedder.hpp"
#include "cardnet/ocr_pipeline.hpp"
#include "cardnet/yolo_detector.hpp"

namespace py = pybind11;

namespace {

// Every pipeline here takes the same kind of image: an interleaved HWC
// uint8 BGR array (h, w, 3) — exactly what cv2.imread/a decoded video
// frame already is, so callers pass their numpy arrays straight through.
py::array_t<std::uint8_t, py::array::c_style> require_hwc_bgr(const py::array& arr) {
    if (arr.ndim() != 3 || arr.shape(2) != 3) {
        throw std::invalid_argument("image must be an (H, W, 3) array");
    }
    if (!py::isinstance<py::array_t<std::uint8_t, py::array::c_style>>(arr)) {
        throw std::invalid_argument("image must be a C-contiguous uint8 array");
    }
    return py::cast<py::array_t<std::uint8_t, py::array::c_style>>(arr);
}

} // namespace

PYBIND11_MODULE(cardnet, m) {
    m.doc() =
        "ONNX Runtime-backed replacements for Binder's ultralytics/torch.hub/paddleocr "
        "scanning pipeline stages, so the app can be built for Android without those "
        "frameworks' (nonexistent) NDK build paths. See native/cardnet/README.md.";

    py::class_<cardnet::Detection>(m, "Detection")
        .def_property_readonly("x0", [](const cardnet::Detection& d) { return d.box.x0; })
        .def_property_readonly("y0", [](const cardnet::Detection& d) { return d.box.y0; })
        .def_property_readonly("x1", [](const cardnet::Detection& d) { return d.box.x1; })
        .def_property_readonly("y1", [](const cardnet::Detection& d) { return d.box.y1; })
        .def_readonly("class_id", &cardnet::Detection::class_id)
        .def_readonly("score", &cardnet::Detection::score);

    py::class_<cardnet::YoloDetector>(m, "YoloDetector")
        .def(py::init<const std::string&, std::int32_t>(), py::arg("onnx_path"), py::arg("input_size") = 640)
        .def(
            "detect",
            [](cardnet::YoloDetector& self, const py::array& image, float conf_threshold, float iou_threshold) {
                auto img = require_hwc_bgr(image);
                return self.detect(img.data(), static_cast<std::int32_t>(img.shape(0)),
                                    static_cast<std::int32_t>(img.shape(1)), conf_threshold, iou_threshold);
            },
            py::arg("image_bgr"), py::arg("conf_threshold") = 0.25f, py::arg("iou_threshold") = 0.45f);

    py::class_<cardnet::DinoEmbedder>(m, "DinoEmbedder")
        .def(py::init<const std::string&>(), py::arg("onnx_path"))
        .def(
            "embed",
            [](cardnet::DinoEmbedder& self, const py::array& image) {
                auto img = require_hwc_bgr(image);
                std::vector<float> vec = self.embed(img.data(), static_cast<std::int32_t>(img.shape(0)),
                                                     static_cast<std::int32_t>(img.shape(1)));
                py::array_t<float> out(vec.size());
                std::copy(vec.begin(), vec.end(), out.mutable_data());
                return out;
            },
            py::arg("image_bgr"));

    py::class_<cardnet::OcrLine>(m, "OcrLine")
        .def_readonly("text", &cardnet::OcrLine::text)
        .def_readonly("confidence", &cardnet::OcrLine::confidence);

    py::class_<cardnet::OcrPipeline>(m, "OcrPipeline")
        .def(py::init<const std::string&, const std::string&, const std::string&, std::int32_t, std::int32_t>(),
             py::arg("det_onnx_path"), py::arg("rec_onnx_path"), py::arg("dict_path"),
             py::arg("det_limit_side") = 736, py::arg("rec_input_height") = 48)
        .def(
            "recognize",
            [](cardnet::OcrPipeline& self, const py::array& image) {
                auto img = require_hwc_bgr(image);
                return self.recognize(img.data(), static_cast<std::int32_t>(img.shape(0)),
                                      static_cast<std::int32_t>(img.shape(1)));
            },
            py::arg("image_bgr"));
}
