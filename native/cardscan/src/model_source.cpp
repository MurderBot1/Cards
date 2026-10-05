#include "cardscan/model_source.hpp"

#include "cardvec/flat_index.hpp"

namespace cardscan {

namespace {

class CardvecIndex : public VectorIndex {
public:
    explicit CardvecIndex(cardvec::FlatIndexIP index) : index_(std::move(index)) {}
    std::int64_t ntotal() const override { return index_.ntotal(); }
    void search(const float* query, std::int64_t k, float* scores, std::int64_t* labels) const override {
        index_.search(query, 1, k, scores, labels);
    }
    std::vector<float> reconstruct(std::int64_t label) const override {
        std::vector<float> out(static_cast<size_t>(index_.dim()));
        index_.reconstruct(label, out.data());
        return out;
    }

private:
    cardvec::FlatIndexIP index_;
};

}  // namespace

std::unique_ptr<VectorIndex> load_cardvec_index(const std::filesystem::path& path) {
    std::error_code ec;
    if (!std::filesystem::exists(path, ec)) return nullptr;
    return std::make_unique<CardvecIndex>(cardvec::FlatIndexIP::load(path.u8string()));
}

}  // namespace cardscan
