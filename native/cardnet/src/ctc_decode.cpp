#include "cardnet/ctc_decode.hpp"

#include <cmath>
#include <fstream>
#include <stdexcept>

namespace cardnet {

CtcResult ctc_greedy_decode(const float* logits, std::int64_t T, std::int64_t C,
                            const std::vector<std::string>& dictionary) {
    if (static_cast<std::int64_t>(dictionary.size()) != C - 1) {
        throw std::invalid_argument(
            "cardnet: ctc_greedy_decode dictionary has " + std::to_string(dictionary.size()) +
            " entries, expected C-1=" + std::to_string(C - 1));
    }

    std::string text;
    double confidence_sum = 0.0;
    std::int64_t kept = 0;
    std::int64_t prev_class = -1; // no timestep has produced a class yet

    for (std::int64_t t = 0; t < T; ++t) {
        const float* row = logits + t * C;
        std::int64_t best_class = 0;
        float best_val = row[0];
        for (std::int64_t c = 1; c < C; ++c) {
            if (row[c] > best_val) {
                best_val = row[c];
                best_class = c;
            }
        }
        double sum_exp = 0.0;
        for (std::int64_t c = 0; c < C; ++c) sum_exp += std::exp(static_cast<double>(row[c] - best_val));
        double prob = 1.0 / sum_exp; // exp(best_val - best_val) == 1, so this is softmax(best_class)

        if (best_class != 0 && best_class != prev_class) {
            text += dictionary[best_class - 1];
            confidence_sum += prob;
            ++kept;
        }
        prev_class = best_class;
    }

    float confidence = kept > 0 ? static_cast<float>(confidence_sum / kept) : 0.f;
    return CtcResult{std::move(text), confidence};
}

std::vector<std::string> load_dictionary(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cardnet: could not open dictionary '" + path + "'");

    std::vector<std::string> dict;
    std::string line;
    while (std::getline(f, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        dict.push_back(line);
    }
    // A trailing blank line from the file's final '\n' is a byte artifact
    // of the file, not a dictionary entry.
    if (!dict.empty() && dict.back().empty()) dict.pop_back();
    return dict;
}

} // namespace cardnet
