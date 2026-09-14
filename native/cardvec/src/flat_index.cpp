#include "cardvec/flat_index.hpp"
#include "dot.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <thread>
#include <vector>

namespace cardvec {

namespace {

constexpr char kMagic[4] = {'C', 'V', 'I', '1'};
constexpr std::int64_t kMaxSearchThreads = 8;
// Below this many database rows, the thread-spawn overhead costs more
// than it saves on a single art-crop query.
constexpr std::int64_t kMinRowsPerThread = 20000;

struct FileGuard {
    std::FILE* f;
    ~FileGuard() { if (f) std::fclose(f); }
};

// Fixed-capacity top-k accumulator, kept sorted descending by score.
// k is always small (Binder searches FAISS_TOP_K=8), so linear
// insertion beats a heap in practice.
class TopK {
public:
    explicit TopK(std::int64_t k) : k_(k), scores_(k, -std::numeric_limits<float>::infinity()), labels_(k, -1) {}

    void offer(float score, std::int64_t label) {
        if (score <= scores_[k_ - 1]) return;
        std::int64_t pos = k_ - 1;
        while (pos > 0 && scores_[pos - 1] < score) {
            scores_[pos] = scores_[pos - 1];
            labels_[pos] = labels_[pos - 1];
            --pos;
        }
        scores_[pos] = score;
        labels_[pos] = label;
    }

    const std::vector<float>& scores() const { return scores_; }
    const std::vector<std::int64_t>& labels() const { return labels_; }

private:
    std::int64_t k_;
    std::vector<float> scores_;
    std::vector<std::int64_t> labels_;
};

} // namespace

FlatIndexIP::FlatIndexIP(std::int64_t dim) : dim_(dim) {
    if (dim <= 0) throw std::invalid_argument("cardvec: dim must be positive");
}

void FlatIndexIP::add(const float* xb, std::int64_t n) {
    if (n <= 0) return;
    data_.insert(data_.end(), xb, xb + n * dim_);
    ntotal_ += n;
}

void FlatIndexIP::search(const float* xq, std::int64_t nq, std::int64_t k,
                          float* out_scores, std::int64_t* out_labels) const {
    if (k <= 0) throw std::invalid_argument("cardvec: k must be positive");

    for (std::int64_t qi = 0; qi < nq; ++qi) {
        const float* q = xq + qi * dim_;
        float* scores_row = out_scores + qi * k;
        std::int64_t* labels_row = out_labels + qi * k;

        if (ntotal_ == 0) {
            std::fill(scores_row, scores_row + k, -std::numeric_limits<float>::infinity());
            std::fill(labels_row, labels_row + k, std::int64_t(-1));
            continue;
        }

        std::int64_t nthreads = std::min<std::int64_t>(
            {kMaxSearchThreads, ntotal_ / kMinRowsPerThread + 1,
             static_cast<std::int64_t>(std::max(1u, std::thread::hardware_concurrency()))});

        std::vector<TopK> partials(nthreads, TopK(k));
        auto worker = [&](std::int64_t tid) {
            std::int64_t begin = ntotal_ * tid / nthreads;
            std::int64_t end = ntotal_ * (tid + 1) / nthreads;
            TopK& local = partials[tid];
            for (std::int64_t row = begin; row < end; ++row) {
                float score = detail::dot(q, data_.data() + row * dim_, dim_);
                local.offer(score, row);
            }
        };

        if (nthreads == 1) {
            worker(0);
        } else {
            std::vector<std::thread> pool;
            pool.reserve(nthreads);
            for (std::int64_t t = 0; t < nthreads; ++t) pool.emplace_back(worker, t);
            for (auto& th : pool) th.join();
        }

        TopK merged(k);
        for (const auto& p : partials) {
            for (std::int64_t i = 0; i < k; ++i) merged.offer(p.scores()[i], p.labels()[i]);
        }
        std::copy(merged.scores().begin(), merged.scores().end(), scores_row);
        std::copy(merged.labels().begin(), merged.labels().end(), labels_row);
    }
}

void FlatIndexIP::reconstruct(std::int64_t label, float* out) const {
    if (label < 0 || label >= ntotal_) {
        throw std::out_of_range("cardvec: reconstruct label " + std::to_string(label) +
                                 " out of range [0, " + std::to_string(ntotal_) + ")");
    }
    std::copy(data_.data() + label * dim_, data_.data() + (label + 1) * dim_, out);
}

void FlatIndexIP::save(const std::string& path) const {
    FileGuard fg{std::fopen(path.c_str(), "wb")};
    if (!fg.f) throw std::runtime_error("cardvec: could not open '" + path + "' for writing");

    if (std::fwrite(kMagic, 1, 4, fg.f) != 4) throw std::runtime_error("cardvec: write failed");
    std::int64_t dim = dim_, ntotal = ntotal_;
    if (std::fwrite(&dim, sizeof(dim), 1, fg.f) != 1 ||
        std::fwrite(&ntotal, sizeof(ntotal), 1, fg.f) != 1) {
        throw std::runtime_error("cardvec: write failed");
    }
    if (ntotal > 0) {
        std::size_t count = static_cast<std::size_t>(ntotal) * static_cast<std::size_t>(dim_);
        if (std::fwrite(data_.data(), sizeof(float), count, fg.f) != count) {
            throw std::runtime_error("cardvec: write failed");
        }
    }
}

FlatIndexIP FlatIndexIP::load(const std::string& path) {
    FileGuard fg{std::fopen(path.c_str(), "rb")};
    if (!fg.f) throw std::runtime_error("cardvec: could not open '" + path + "' for reading");

    char magic[4];
    if (std::fread(magic, 1, 4, fg.f) != 4 || std::memcmp(magic, kMagic, 4) != 0) {
        throw std::runtime_error("cardvec: '" + path + "' is not a cardvec index file "
                                  "(it may still be in the old faiss-cpu format — rebuild it "
                                  "with build_scanner_models.py)");
    }
    std::int64_t dim = 0, ntotal = 0;
    if (std::fread(&dim, sizeof(dim), 1, fg.f) != 1 ||
        std::fread(&ntotal, sizeof(ntotal), 1, fg.f) != 1 ||
        dim <= 0 || ntotal < 0) {
        throw std::runtime_error("cardvec: '" + path + "' has a corrupt header");
    }

    FlatIndexIP index(dim);
    if (ntotal > 0) {
        std::size_t count = static_cast<std::size_t>(ntotal) * static_cast<std::size_t>(dim);
        index.data_.resize(count);
        if (std::fread(index.data_.data(), sizeof(float), count, fg.f) != count) {
            throw std::runtime_error("cardvec: '" + path + "' is truncated");
        }
    }
    index.ntotal_ = ntotal;
    return index;
}

void normalize_L2(float* x, std::int64_t n, std::int64_t dim) {
    for (std::int64_t i = 0; i < n; ++i) {
        float* row = x + i * dim;
        float norm_sq = detail::dot(row, row, dim);
        if (norm_sq <= 1e-20f) continue; // leave (near-)zero rows untouched, like faiss
        float inv_norm = 1.0f / std::sqrt(norm_sq);
        for (std::int64_t j = 0; j < dim; ++j) row[j] *= inv_norm;
    }
}

} // namespace cardvec
