// Python bindings for cardvec — deliberately shaped as a drop-in for the
// tiny slice of the faiss API Binder's backend uses:
//   faiss.IndexFlatIP(dim) / index.add / index.search / index.ntotal
//   faiss.normalize_L2 / faiss.read_index / faiss.write_index
// so app/backend/scanner.py and build_scanner_models.py only need their
// `import faiss` swapped for `import cardvec as faiss`.
#include <pybind11/pybind11.h>
#include <pybind11/numpy.h>

#include <cstdint>
#include <stdexcept>
#include <string>
#include <utility>

#include "cardvec/flat_index.hpp"

namespace py = pybind11;

namespace {

// faiss's own SWIG typemaps require float32, C-contiguous arrays too —
// matching that here (no forcecast/copy) keeps normalize_L2's in-place
// mutation honest and gives add()/search() zero-copy access to numpy's
// buffer.
py::array_t<float, py::array::c_style> require_f32_2d(const py::array& arr, const char* what) {
    if (arr.ndim() != 2) {
        throw std::invalid_argument(std::string(what) + " must be a 2-D array, got ndim=" +
                                     std::to_string(arr.ndim()));
    }
    if (!py::isinstance<py::array_t<float, py::array::c_style>>(arr)) {
        throw std::invalid_argument(std::string(what) +
                                     " must be a C-contiguous float32 array (use .astype(np.float32))");
    }
    return py::cast<py::array_t<float, py::array::c_style>>(arr);
}

class PyFlatIndexIP {
public:
    explicit PyFlatIndexIP(std::int64_t dim) : impl_(dim) {}
    explicit PyFlatIndexIP(cardvec::FlatIndexIP impl) : impl_(std::move(impl)) {}

    void add(const py::array& xb_in) {
        auto xb = require_f32_2d(xb_in, "xb");
        if (xb.shape(1) != impl_.dim()) {
            throw std::invalid_argument("xb has " + std::to_string(xb.shape(1)) +
                                         " columns, expected dim=" + std::to_string(impl_.dim()));
        }
        impl_.add(xb.data(), xb.shape(0));
    }

    py::tuple search(const py::array& xq_in, std::int64_t k) const {
        auto xq = require_f32_2d(xq_in, "xq");
        if (xq.shape(1) != impl_.dim()) {
            throw std::invalid_argument("xq has " + std::to_string(xq.shape(1)) +
                                         " columns, expected dim=" + std::to_string(impl_.dim()));
        }
        std::int64_t nq = xq.shape(0);
        py::array_t<float> scores({nq, k});
        py::array_t<std::int64_t> labels({nq, k});
        impl_.search(xq.data(), nq, k, scores.mutable_data(), labels.mutable_data());
        return py::make_tuple(std::move(scores), std::move(labels));
    }

    py::array_t<float> reconstruct(std::int64_t label) const {
        py::array_t<float> out(impl_.dim());
        impl_.reconstruct(label, out.mutable_data());
        return out;
    }

    std::int64_t ntotal() const { return impl_.ntotal(); }
    std::int64_t d() const { return impl_.dim(); }

    void write(const std::string& path) const { impl_.save(path); }
    static PyFlatIndexIP read(const std::string& path) { return PyFlatIndexIP(cardvec::FlatIndexIP::load(path)); }

private:
    cardvec::FlatIndexIP impl_;
};

void py_normalize_L2(const py::array& x_in) {
    auto x = require_f32_2d(x_in, "x");
    cardvec::normalize_L2(x.mutable_data(), x.shape(0), x.shape(1));
}

} // namespace

PYBIND11_MODULE(cardvec, m) {
    m.doc() =
        "Minimal brute-force inner-product/cosine vector index: a from-scratch, "
        "cross-compilable replacement for the small subset of FAISS Binder uses "
        "(IndexFlatIP + normalize_L2 + read_index/write_index), so the app can be "
        "built for Android without FAISS's BLAS/SWIG toolchain.";

    py::class_<PyFlatIndexIP>(m, "IndexFlatIP")
        .def(py::init<std::int64_t>(), py::arg("dim"))
        .def("add", &PyFlatIndexIP::add, py::arg("xb"))
        .def("search", &PyFlatIndexIP::search, py::arg("xq"), py::arg("k"))
        .def("reconstruct", &PyFlatIndexIP::reconstruct, py::arg("label"))
        .def_property_readonly("ntotal", &PyFlatIndexIP::ntotal)
        .def_property_readonly("d", &PyFlatIndexIP::d);

    m.def("normalize_L2", &py_normalize_L2, py::arg("x"));
    m.def(
        "write_index",
        [](const PyFlatIndexIP& index, const std::string& path) { index.write(path); },
        py::arg("index"), py::arg("path"));
    m.def("read_index", &PyFlatIndexIP::read, py::arg("path"));
}
