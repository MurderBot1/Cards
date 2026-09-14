// Plain C++ sanity test for the core library — no Python, no pybind11, no
// test framework. Deliberately dependency-free so it can be pushed to an
// Android device/emulator and run standalone to smoke-test a cross build.
#include "cardvec/flat_index.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <stdexcept>
#include <utility>
#include <vector>

namespace {

int g_failures = 0;

void check(bool cond, const char* msg) {
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        ++g_failures;
    }
}

float brute_force_ip(const float* a, const float* b, int64_t dim) {
    float s = 0.f;
    for (int64_t i = 0; i < dim; ++i) s += a[i] * b[i];
    return s;
}

} // namespace

int main() {
    constexpr int64_t dim = 384;
    constexpr int64_t n = 5000;
    constexpr int64_t k = 8;

    std::mt19937 rng(42);
    std::uniform_real_distribution<float> dist(-1.f, 1.f);

    std::vector<float> db(n * dim);
    for (auto& v : db) v = dist(rng);

    cardvec::normalize_L2(db.data(), n, dim);
    for (int64_t i = 0; i < n; ++i) {
        float norm_sq = brute_force_ip(&db[i * dim], &db[i * dim], dim);
        check(std::fabs(norm_sq - 1.0f) < 1e-3f, "normalize_L2 produces unit-norm rows");
    }

    cardvec::FlatIndexIP index(dim);
    index.add(db.data(), n);
    check(index.ntotal() == n, "ntotal reflects added rows");
    check(index.dim() == dim, "dim matches constructor argument");

    // Query with an exact copy of row 1234: it must be its own top match
    // with score ~1.0 (cosine self-similarity), and the naive scan must
    // agree with the index's top-k on every score/label.
    constexpr int64_t query_row = 1234;
    std::vector<float> query(db.begin() + query_row * dim, db.begin() + (query_row + 1) * dim);

    std::vector<float> scores(k);
    std::vector<int64_t> labels(k);
    index.search(query.data(), 1, k, scores.data(), labels.data());

    check(labels[0] == query_row, "self-query's top match is itself");
    check(std::fabs(scores[0] - 1.0f) < 1e-3f, "self-query's top score is ~1.0");

    std::vector<float> reconstructed(dim);
    index.reconstruct(query_row, reconstructed.data());
    check(std::equal(reconstructed.begin(), reconstructed.end(), query.begin()),
          "reconstruct returns the exact row that was added");
    bool threw = false;
    try {
        index.reconstruct(n, reconstructed.data());
    } catch (const std::out_of_range&) {
        threw = true;
    }
    check(threw, "reconstruct rejects an out-of-range label");

    std::vector<std::pair<float, int64_t>> brute;
    brute.reserve(n);
    for (int64_t i = 0; i < n; ++i) brute.emplace_back(brute_force_ip(query.data(), &db[i * dim], dim), i);
    std::partial_sort(brute.begin(), brute.begin() + k, brute.end(),
                       [](auto& a, auto& b) { return a.first > b.first; });
    for (int64_t i = 0; i < k; ++i) {
        check(labels[i] == brute[i].second, "search top-k label matches brute-force scan");
        check(std::fabs(scores[i] - brute[i].first) < 1e-2f, "search top-k score matches brute-force scan");
    }

    // Round-trip through save/load.
    const char* path = "cardvec_selftest.idx";
    index.save(path);
    cardvec::FlatIndexIP loaded = cardvec::FlatIndexIP::load(path);
    check(loaded.ntotal() == index.ntotal(), "loaded index has the same ntotal");
    check(loaded.dim() == index.dim(), "loaded index has the same dim");
    std::vector<float> scores2(k);
    std::vector<int64_t> labels2(k);
    loaded.search(query.data(), 1, k, scores2.data(), labels2.data());
    for (int64_t i = 0; i < k; ++i) {
        check(labels2[i] == labels[i], "loaded index search matches original");
        check(scores2[i] == scores[i], "loaded index scores match original exactly");
    }
    std::remove(path);

    // Empty index: search must not crash, and must pad with -1/-inf.
    cardvec::FlatIndexIP empty(dim);
    std::vector<float> escores(k);
    std::vector<int64_t> elabels(k);
    empty.search(query.data(), 1, k, escores.data(), elabels.data());
    for (int64_t i = 0; i < k; ++i) {
        check(elabels[i] == -1, "empty index pads labels with -1");
        check(std::isinf(escores[i]) && escores[i] < 0, "empty index pads scores with -inf");
    }

    if (g_failures == 0) {
        std::printf("OK: all cardvec self-tests passed (n=%lld, dim=%lld, k=%lld)\n",
                    static_cast<long long>(n), static_cast<long long>(dim), static_cast<long long>(k));
        return 0;
    }
    std::fprintf(stderr, "%d cardvec self-test(s) failed\n", g_failures);
    return 1;
}
