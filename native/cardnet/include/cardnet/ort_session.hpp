#pragma once
// Thin wrapper around an ONNX Runtime inference session. This is the one
// piece of cardnet that talks to a third-party library rather than being
// from-scratch — see native/cardnet/README.md for why: reimplementing
// conv2d/attention/GEMM kernels for three different model architectures
// (YOLOv8, DINOv2, PaddleOCR's detector+recognizer) from scratch would be
// reinventing a big chunk of what ONNX Runtime already does well, and
// ONNX Runtime Mobile has first-class Android support (NNAPI/XNNPACK),
// unlike PyTorch, ultralytics, or PaddlePaddle.
//
// This header itself does not include any ONNX Runtime headers (pImpl),
// so the rest of cardnet's headers stay dependency-free for callers that
// only need e.g. the pure geometry/postprocessing pieces.

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace cardnet {

class OrtSession {
public:
    struct Tensor {
        std::vector<float> data;
        std::vector<std::int64_t> shape;
    };

    // `num_threads` <= 0 lets ONNX Runtime pick its own default. Throws
    // std::runtime_error (wrapping Ort::Exception) if the model fails to
    // load — e.g. a missing/corrupt .onnx file.
    explicit OrtSession(const std::string& model_path, int num_threads = 0);
    ~OrtSession();
    OrtSession(OrtSession&&) noexcept;
    OrtSession& operator=(OrtSession&&) noexcept;
    OrtSession(const OrtSession&) = delete;
    OrtSession& operator=(const OrtSession&) = delete;

    // Runs the model with a single float32 input tensor (row-major,
    // `input_shape` describing its dimensions, e.g. {1,3,224,224}).
    // Requires every model output to be float32 — true for all three of
    // Binder's exported models (see native/cardnet/export/); throws
    // std::runtime_error otherwise rather than silently reinterpreting
    // bytes. Returns one Tensor per model output, in the model's own
    // output order.
    std::vector<Tensor> run(const float* input_data, const std::vector<std::int64_t>& input_shape);

    std::size_t num_outputs() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace cardnet
