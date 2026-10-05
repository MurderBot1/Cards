// cardtext — text helpers for matching OCR output against the catalog — the C++ port of
// the pure-string parts of scanner.py: Unicode-aware title normalization, a
// faithful port of difflib's SequenceMatcher / get_close_matches (so fuzzy
// scores and tie-breaking match what the Python build produced), and the
// per-game "set code + collector number" patterns.
#pragma once

#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace cardtext {

// ---- UTF-8 ------------------------------------------------------------------
std::vector<char32_t> decode_utf8(const std::string& s);  // invalid bytes become U+FFFD
std::string encode_utf8(const std::vector<char32_t>& cps);

// Python's str.lower() for the scripts card names use (Latin incl. Latin-1/Extended-A/
// Extended Additional, Greek, Cyrillic, fullwidth Latin); every other code point is
// left as is. NOT a full Unicode case map.
std::string lower_utf8(const std::string& s);

// Python's str.strip() (Unicode whitespace at both ends).
std::string strip_utf8(const std::string& s);

// Whether `cp` matches Python's `\w` — letters/digits/underscore in any script card names
// use. Combining marks and punctuation are not word characters.
bool is_word_char(char32_t cp);

// Lowercase, replace every run of non-word characters with a single space, trim. Applied to
// both sides of every fuzzy comparison so punctuation OCR dropped (or invented) doesn't
// count against a match. Unicode-aware on purpose: the catalog includes every language a
// card was printed in, and an ASCII-only class would erase Japanese/Cyrillic names and
// strip accents off French/German ones.
std::string normalize_title(const std::string& text);

// ---- difflib ------------------------------------------------------------------
// difflib.SequenceMatcher(None, a, b).ratio(), over code points (autojunk included).
double sequence_ratio(const std::string& a, const std::string& b);

// difflib.get_close_matches(word, possibilities, n, cutoff): the best matches, best first.
// Ties on score break the way Python's heapq.nlargest on (score, string) does.
std::vector<std::string> get_close_matches(const std::string& word, const std::vector<std::string>& possibilities,
                                           size_t n = 3, double cutoff = 0.6);

// ---- exact-identifier patterns (applied to OCR text) ---------------------------------
struct SetAndNumber {
    std::string set_code;
    std::string collector_number;  // the part before any "/total"
};
std::optional<SetAndNumber> parse_mtg_primary(const std::string& ocr_text);       // "M10 · 146/249"
std::optional<SetAndNumber> parse_pokemon_modern(const std::string& ocr_text);    // "SV3 025/197"
std::optional<std::string> parse_pokemon_vintage(const std::string& ocr_text);    // "4/102" -> "4"
std::optional<std::string> parse_yugioh_passcode(const std::string& ocr_text);    // 8 digits
std::optional<std::string> parse_yugioh_set_code(const std::string& ocr_text);    // "LOB-EN005"

}  // namespace cardtext
