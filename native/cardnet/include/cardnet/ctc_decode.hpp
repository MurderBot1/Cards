#pragma once
// Greedy CTC decoding for PaddleOCR-style text recognition heads: argmax
// each timestep, collapse adjacent-duplicate raw predictions, then drop
// the blank class (index 0) — the standard CTC decode rule (see
// PaddleOCR's CTCLabelDecode.decode(), which this matches exactly).

#include <cstdint>
#include <string>
#include <vector>

namespace cardnet {

struct CtcResult {
    std::string text;
    float confidence; // mean softmax probability of the kept characters
};

// `logits` is a row-major (T, C) array of *pre-softmax* scores (softmax
// is computed internally, per timestep, so it's applied consistently
// regardless of whether the exported ONNX graph already includes a
// trailing Softmax node). Class 0 is the CTC blank; classes 1..C-1 map
// to dictionary[0..C-2]. Throws std::invalid_argument if
// dictionary.size() != C - 1.
CtcResult ctc_greedy_decode(const float* logits, std::int64_t T, std::int64_t C,
                            const std::vector<std::string>& dictionary);

// Loads a PaddleOCR-format character dictionary: one UTF-8 character (or
// multi-byte token) per line, blank/CTC-index-0 implicit (not listed).
// Trims a single trailing '\r' per line (CRLF-safe) and drops a trailing
// empty line, but otherwise preserves lines byte-for-byte — including a
// literal leading/trailing space line, which PaddleOCR's own English
// dictionary relies on for the space character.
std::vector<std::string> load_dictionary(const std::string& path);

} // namespace cardnet
