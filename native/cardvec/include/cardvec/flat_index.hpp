#pragma once
// cardvec::FlatIndexIP — exact brute-force nearest-neighbor search over
// inner-product similarity (cosine similarity, once rows are L2-normalized).
//
// This is a from-scratch reimplementation of the *one* FAISS feature Binder
// actually uses (faiss.IndexFlatIP + normalize_L2 + read_index/write_index),
// written to cross-compile with the Android NDK's own clang: no BLAS, no
// OpenMP, no SWIG, just the C++ standard library plus optional AVX2/NEON
// dot-product kernels selected at compile time.
//
// It is deliberately *not* a general FAISS replacement — no IVF, no PQ, no
// HNSW, no GPU path. Binder's card-art catalogs are small enough (tens of
// thousands of 384-dim vectors) that brute force is both simpler and, with
// SIMD + a few worker threads, comfortably fast enough for a single art-crop
// query per scan.

#include <cstdint>
#include <string>
#include <vector>

namespace cardvec {

class FlatIndexIP {
public:
    explicit FlatIndexIP(std::int64_t dim);

    // Appends n rows of dim() floats each (row-major) to the index.
    void add(const float* xb, std::int64_t n);

    // Searches nq query rows of dim() floats each (row-major). Writes
    // nq*k scores (descending inner product) and nq*k labels into
    // caller-owned, caller-sized output buffers. When ntotal() < k, the
    // trailing slots for that query are padded with label -1 and score
    // -infinity, matching faiss's IndexFlat behavior — callers that
    // already skip negative labels (as Binder's scanner.py does) need no
    // changes.
    void search(const float* xq, std::int64_t nq, std::int64_t k,
                float* out_scores, std::int64_t* out_labels) const;

    // Copies the dim()-length row stored at `label` (as returned by
    // add()/search()) into the caller-owned `out` buffer. Throws
    // std::out_of_range if label is outside [0, ntotal()) — matching
    // faiss's IndexFlat::reconstruct, which scanner.py's
    // _best_printing_by_art relies on to re-fetch a specific printing's
    // stored vector by row index rather than via search().
    void reconstruct(std::int64_t label, float* out) const;

    std::int64_t dim() const noexcept { return dim_; }
    std::int64_t ntotal() const noexcept { return ntotal_; }

    // Binary format (little-endian, native float layout):
    //   char[4]   magic   "CVI1"
    //   int64     dim
    //   int64     ntotal
    //   float[ntotal * dim]  row-major vector data
    // This is a clean, purpose-built format — it does not read or write
    // FAISS's own index files. A catalog built with faiss-cpu must be
    // rebuilt (see build_scanner_models.py) after switching to cardvec.
    void save(const std::string& path) const;
    static FlatIndexIP load(const std::string& path);

private:
    std::int64_t dim_;
    std::int64_t ntotal_ = 0;
    std::vector<float> data_; // ntotal_ * dim_ floats, row-major
};

// L2-normalizes each of the n rows of dim floats in place (so that inner
// product against another normalized row equals cosine similarity). Rows
// with a (near-)zero norm are left untouched, matching faiss's
// normalize_L2 behavior.
void normalize_L2(float* x, std::int64_t n, std::int64_t dim);

} // namespace cardvec
