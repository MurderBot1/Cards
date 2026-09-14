#include "cardnet/ort_session.hpp"

#include <onnxruntime_cxx_api.h>

#include <stdexcept>

#ifdef _WIN32
#include <windows.h>
#endif

namespace cardnet {

namespace {

// One shared Ort::Env for the whole process — required by ONNX Runtime,
// and cheap to share across every OrtSession instance. Meyer's singleton
// is thread-safe init in C++11+.
Ort::Env& shared_env() {
    static Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "cardnet");
    return env;
}

#ifdef _WIN32
std::wstring to_ort_path(const std::string& utf8) {
    if (utf8.empty()) return std::wstring();
    int len = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
    std::wstring wide(len, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), wide.data(), len);
    return wide;
}
#endif

} // namespace

struct OrtSession::Impl {
    Ort::Session session{nullptr};
    Ort::AllocatorWithDefaultOptions allocator;
    Ort::MemoryInfo memory_info = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);

    std::string input_name;
    std::vector<std::string> output_names;
    std::vector<const char*> input_names_c;
    std::vector<const char*> output_names_c;
};

OrtSession::OrtSession(const std::string& model_path, int num_threads) : impl_(new Impl()) {
    try {
        Ort::SessionOptions options;
        if (num_threads > 0) options.SetIntraOpNumThreads(num_threads);
        options.SetGraphOptimizationLevel(ORT_ENABLE_ALL);

#ifdef _WIN32
        std::wstring wpath = to_ort_path(model_path);
        impl_->session = Ort::Session(shared_env(), wpath.c_str(), options);
#else
        impl_->session = Ort::Session(shared_env(), model_path.c_str(), options);
#endif

        if (impl_->session.GetInputCount() != 1) {
            throw std::runtime_error("cardnet: OrtSession only supports single-input models, '" + model_path +
                                     "' has " + std::to_string(impl_->session.GetInputCount()));
        }
        auto in_name = impl_->session.GetInputNameAllocated(0, impl_->allocator);
        impl_->input_name = in_name.get();

        std::size_t n_out = impl_->session.GetOutputCount();
        impl_->output_names.reserve(n_out);
        for (std::size_t i = 0; i < n_out; ++i) {
            auto out_name = impl_->session.GetOutputNameAllocated(i, impl_->allocator);
            impl_->output_names.emplace_back(out_name.get());
        }

        impl_->input_names_c = {impl_->input_name.c_str()};
        impl_->output_names_c.reserve(n_out);
        for (auto& s : impl_->output_names) impl_->output_names_c.push_back(s.c_str());
    } catch (const Ort::Exception& e) {
        throw std::runtime_error("cardnet: failed to load ONNX model '" + model_path + "': " + e.what());
    }
}

OrtSession::~OrtSession() = default;
OrtSession::OrtSession(OrtSession&&) noexcept = default;
OrtSession& OrtSession::operator=(OrtSession&&) noexcept = default;

std::size_t OrtSession::num_outputs() const { return impl_->output_names.size(); }

std::vector<OrtSession::Tensor> OrtSession::run(const float* input_data,
                                                 const std::vector<std::int64_t>& input_shape) {
    try {
        std::int64_t count = 1;
        for (auto d : input_shape) count *= d;

        Ort::Value input_tensor = Ort::Value::CreateTensor<float>(
            impl_->memory_info, const_cast<float*>(input_data), static_cast<std::size_t>(count),
            input_shape.data(), input_shape.size());

        auto outputs = impl_->session.Run(Ort::RunOptions{nullptr}, impl_->input_names_c.data(), &input_tensor, 1,
                                          impl_->output_names_c.data(), impl_->output_names_c.size());

        std::vector<Tensor> results;
        results.reserve(outputs.size());
        for (auto& value : outputs) {
            auto info = value.GetTensorTypeAndShapeInfo();
            if (info.GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT) {
                throw std::runtime_error("cardnet: OrtSession only supports float32 outputs (got ONNX tensor "
                                         "element type " +
                                         std::to_string(static_cast<int>(info.GetElementType())) + ")");
            }
            Tensor t;
            t.shape = info.GetShape();
            std::size_t n = static_cast<std::size_t>(info.GetElementCount());
            const float* data = value.GetTensorData<float>();
            t.data.assign(data, data + n);
            results.push_back(std::move(t));
        }
        return results;
    } catch (const Ort::Exception& e) {
        throw std::runtime_error(std::string("cardnet: ONNX Runtime inference failed: ") + e.what());
    }
}

} // namespace cardnet
