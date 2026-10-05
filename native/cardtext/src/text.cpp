#include "cardtext/text.hpp"

#include <algorithm>
#include <cstdint>
#include <regex>
#include <unordered_map>

namespace cardtext {

// ============================================================================
// UTF-8
// ============================================================================
std::vector<char32_t> decode_utf8(const std::string& s) {
    std::vector<char32_t> out;
    size_t i = 0, n = s.size();
    while (i < n) {
        unsigned char c = static_cast<unsigned char>(s[i]);
        int len = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : (c >> 3) == 0x1E ? 4 : 0;
        if (len == 0 || i + len > n) {
            out.push_back(0xFFFD);
            ++i;
            continue;
        }
        char32_t cp = len == 1 ? c : (c & (0xFF >> (len + 1)));
        bool ok = true;
        for (int k = 1; k < len; ++k) {
            unsigned char cc = static_cast<unsigned char>(s[i + k]);
            if ((cc & 0xC0) != 0x80) {
                ok = false;
                break;
            }
            cp = (cp << 6) | (cc & 0x3F);
        }
        if (!ok) {
            out.push_back(0xFFFD);
            ++i;
            continue;
        }
        out.push_back(cp);
        i += len;
    }
    return out;
}

std::string encode_utf8(const std::vector<char32_t>& cps) {
    std::string out;
    for (char32_t cp : cps) {
        if (cp < 0x80) {
            out += static_cast<char>(cp);
        } else if (cp < 0x800) {
            out += static_cast<char>(0xC0 | (cp >> 6));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            out += static_cast<char>(0xE0 | (cp >> 12));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else {
            out += static_cast<char>(0xF0 | (cp >> 18));
            out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        }
    }
    return out;
}

// ============================================================================
// Case folding / character classes (tables generated from Unicode data, see unicode_tables.inc)
// ============================================================================
namespace {

struct Range {
    char32_t lo, hi;
};
struct CaseRange {
    char32_t lo, hi;
    int32_t delta;
    uint8_t stride;  // 1: every code point in [lo, hi]; 2: every other one, starting at lo
};

#include "unicode_tables.inc"

template <size_t N>
bool in_ranges(const Range (&table)[N], char32_t cp) {
    size_t lo = 0, hi = N;
    while (lo < hi) {
        size_t mid = (lo + hi) / 2;
        if (cp < table[mid].lo) hi = mid;
        else if (cp > table[mid].hi) lo = mid + 1;
        else return true;
    }
    return false;
}

bool is_cased(char32_t cp) {
    if (cp < 0x80) return (cp >= 'a' && cp <= 'z') || (cp >= 'A' && cp <= 'Z');
    return in_ranges(kCasedRanges, cp);
}

bool is_case_ignorable(char32_t cp) {
    if (cp < 0x80) return cp == '\'' || cp == '.' || cp == ':' || cp == '^' || cp == '`';
    return in_ranges(kCaseIgnorableRanges, cp);
}

// Python's str.lower() over a code point sequence: single-code-point mappings from the table,
// U+0130 -> "i" + U+0307, and the context-sensitive Final_Sigma rule.
std::vector<char32_t> lower_cps(const std::vector<char32_t>& in) {
    std::vector<char32_t> out;
    out.reserve(in.size());
    for (size_t i = 0; i < in.size(); ++i) {
        char32_t cp = in[i];
        if (cp < 0x80) {
            out.push_back(cp >= 'A' && cp <= 'Z' ? cp + 32 : cp);
        } else if (cp == 0x130) {
            out.push_back('i');
            out.push_back(0x307);
        } else if (cp == 0x3A3) {
            long j = static_cast<long>(i) - 1;
            while (j >= 0 && is_case_ignorable(in[j])) --j;
            bool final_sigma = j >= 0 && is_cased(in[j]);
            if (final_sigma) {
                size_t k = i + 1;
                while (k < in.size() && is_case_ignorable(in[k])) ++k;
                final_sigma = !(k < in.size() && is_cased(in[k]));
            }
            out.push_back(final_sigma ? 0x3C2 : 0x3C3);
        } else {
            char32_t r = cp;
            size_t lo = 0, hi = sizeof(kLowerRanges) / sizeof(kLowerRanges[0]);
            while (lo < hi) {
                size_t mid = (lo + hi) / 2;
                const CaseRange& cr = kLowerRanges[mid];
                if (cp < cr.lo) hi = mid;
                else if (cp > cr.hi) lo = mid + 1;
                else {
                    if ((cp - cr.lo) % cr.stride == 0) r = static_cast<char32_t>(static_cast<int32_t>(cp) + cr.delta);
                    break;
                }
            }
            out.push_back(r);
        }
    }
    return out;
}

bool is_space_cp(char32_t cp) {
    return cp == ' ' || (cp >= 0x09 && cp <= 0x0D) || (cp >= 0x1C && cp <= 0x1F) || cp == 0x85 || cp == 0xA0 ||
           cp == 0x1680 || (cp >= 0x2000 && cp <= 0x200A) || cp == 0x2028 || cp == 0x2029 || cp == 0x202F ||
           cp == 0x205F || cp == 0x3000;
}

}  // namespace

bool is_word_char(char32_t cp) {
    if (cp < 0x80) return (cp >= '0' && cp <= '9') || (cp >= 'A' && cp <= 'Z') || (cp >= 'a' && cp <= 'z') || cp == '_';
    return in_ranges(kWordRanges, cp);
}

std::string lower_utf8(const std::string& s) { return encode_utf8(lower_cps(decode_utf8(s))); }

std::string strip_utf8(const std::string& s) {
    auto cps = decode_utf8(s);
    size_t b = 0, e = cps.size();
    while (b < e && is_space_cp(cps[b])) ++b;
    while (e > b && is_space_cp(cps[e - 1])) --e;
    return encode_utf8(std::vector<char32_t>(cps.begin() + b, cps.begin() + e));
}

std::string normalize_title(const std::string& text) {
    std::vector<char32_t> lowered = lower_cps(decode_utf8(text));
    std::vector<char32_t> out;
    bool pending_space = false;
    for (char32_t cp : lowered) {
        if (is_word_char(cp)) {
            if (pending_space && !out.empty()) out.push_back(' ');
            pending_space = false;
            out.push_back(cp);
        } else {
            pending_space = true;
        }
    }
    return encode_utf8(out);
}

// ============================================================================
// difflib.SequenceMatcher (no junk function), ported from CPython's Lib/difflib.py
// ============================================================================
namespace {

using Seq = std::vector<char32_t>;

class Matcher {
public:
    // set_seq2: b is indexed once so many `a`s can be compared against it cheaply.
    explicit Matcher(const Seq& b) : b_(b) {
        for (size_t i = 0; i < b_.size(); ++i) b2j_[b_[i]].push_back(i);
        // autojunk: for sequences of 200+ items, drop elements that make up more than 1% of them
        size_t n = b_.size();
        if (n >= 200) {
            size_t ntest = n / 100 + 1;
            for (auto it = b2j_.begin(); it != b2j_.end();) {
                if (it->second.size() > ntest) it = b2j_.erase(it);
                else ++it;
            }
        }
    }

    double ratio(const Seq& a) const { return calc(matching_size(a), a.size() + b_.size()); }

    double real_quick_ratio(size_t la) const { return calc(std::min(la, b_.size()), la + b_.size()); }

    double quick_ratio(const Seq& a) const {
        std::unordered_map<char32_t, long> avail;
        for (char32_t c : b_) ++avail[c];
        std::unordered_map<char32_t, long> used;
        size_t matches = 0;
        for (char32_t c : a) {
            long numb = used.count(c) ? used[c] : avail.count(c) ? avail[c] : 0;
            used[c] = numb - 1;
            if (numb > 0) ++matches;
        }
        return calc(matches, a.size() + b_.size());
    }

private:
    static double calc(size_t matches, size_t length) {
        return length ? 2.0 * static_cast<double>(matches) / static_cast<double>(length) : 1.0;
    }

    struct Match {
        size_t i, j, k;
    };

    Match find_longest_match(const Seq& a, size_t alo, size_t ahi, size_t blo, size_t bhi) const {
        size_t besti = alo, bestj = blo, bestsize = 0;
        std::unordered_map<size_t, size_t> j2len;
        for (size_t i = alo; i < ahi; ++i) {
            std::unordered_map<size_t, size_t> newj2len;
            auto it = b2j_.find(a[i]);
            if (it != b2j_.end()) {
                for (size_t j : it->second) {
                    if (j < blo) continue;
                    if (j >= bhi) break;
                    size_t prev = 0;
                    if (j > 0) {
                        auto p = j2len.find(j - 1);
                        if (p != j2len.end()) prev = p->second;
                    }
                    size_t k = newj2len[j] = prev + 1;
                    if (k > bestsize) {
                        besti = i + 1 - k;
                        bestj = j + 1 - k;
                        bestsize = k;
                    }
                }
            }
            j2len.swap(newj2len);
        }
        // Extend the match over equal neighbours that autojunk kept out of the index
        // (no explicit junk function here, so no junk-only extension is needed).
        while (besti > alo && bestj > blo && a[besti - 1] == b_[bestj - 1]) {
            --besti;
            --bestj;
            ++bestsize;
        }
        while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] == b_[bestj + bestsize]) ++bestsize;
        return {besti, bestj, bestsize};
    }

    size_t matching_size(const Seq& a) const {
        struct Range {
            size_t alo, ahi, blo, bhi;
        };
        std::vector<Range> queue{{0, a.size(), 0, b_.size()}};
        size_t total = 0;
        while (!queue.empty()) {
            Range r = queue.back();
            queue.pop_back();
            Match m = find_longest_match(a, r.alo, r.ahi, r.blo, r.bhi);
            if (m.k == 0) continue;
            total += m.k;
            if (r.alo < m.i && r.blo < m.j) queue.push_back({r.alo, m.i, r.blo, m.j});
            if (m.i + m.k < r.ahi && m.j + m.k < r.bhi) queue.push_back({m.i + m.k, r.ahi, m.j + m.k, r.bhi});
        }
        return total;
    }

    Seq b_;
    std::unordered_map<char32_t, std::vector<size_t>> b2j_;
};

}  // namespace

double sequence_ratio(const std::string& a, const std::string& b) {
    return Matcher(decode_utf8(b)).ratio(decode_utf8(a));
}

std::vector<std::string> get_close_matches(const std::string& word, const std::vector<std::string>& possibilities,
                                           size_t n, double cutoff) {
    Matcher matcher(decode_utf8(word));  // `word` is seq2, each candidate is seq1
    std::vector<std::pair<double, const std::string*>> scored;
    for (const auto& x : possibilities) {
        Seq a = decode_utf8(x);
        if (matcher.real_quick_ratio(a.size()) >= cutoff && matcher.quick_ratio(a) >= cutoff) {
            double r = matcher.ratio(a);
            if (r >= cutoff) scored.emplace_back(r, &x);
        }
    }
    // heapq.nlargest(n, [(score, x), ...]): by score, then by string, both descending
    std::sort(scored.begin(), scored.end(), [](const auto& l, const auto& r) {
        if (l.first != r.first) return l.first > r.first;
        return *l.second > *r.second;
    });
    std::vector<std::string> out;
    for (size_t i = 0; i < scored.size() && i < n; ++i) out.push_back(*scored[i].second);
    return out;
}

// ============================================================================
// Exact-identifier patterns
// ============================================================================
namespace {

std::string upper_ascii(std::string s) {
    for (char& c : s)
        if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 32);
    return s;
}

// Collector numbers come as "146/249"; the catalog stores just the first part.
std::string before_slash(const std::string& s) { return s.substr(0, s.find('/')); }

}  // namespace

std::optional<SetAndNumber> parse_mtg_primary(const std::string& ocr_text) {
    // ([A-Z0-9]{3,5})\s*·?\s*(\d{1,4}/\d{1,4})   ("·" is U+00B7)
    static const std::regex re("([A-Z0-9]{3,5})\\s*(?:\\xC2\\xB7)?\\s*(\\d{1,4}/\\d{1,4})");
    std::smatch m;
    std::string text = upper_ascii(ocr_text);
    if (!std::regex_search(text, m, re)) return std::nullopt;
    return SetAndNumber{m[1], before_slash(m[2])};
}

std::optional<SetAndNumber> parse_pokemon_modern(const std::string& ocr_text) {
    static const std::regex re("([A-Z0-9]{2,5})\\s+(\\d{1,3}/\\d{1,3})");
    std::smatch m;
    std::string text = upper_ascii(ocr_text);
    if (!std::regex_search(text, m, re)) return std::nullopt;
    return SetAndNumber{m[1], before_slash(m[2])};
}

std::optional<std::string> parse_pokemon_vintage(const std::string& ocr_text) {
    static const std::regex re("(\\d{1,3}/\\d{1,3})");
    std::smatch m;
    if (!std::regex_search(ocr_text, m, re)) return std::nullopt;
    return before_slash(m[1]);
}

std::optional<std::string> parse_yugioh_passcode(const std::string& ocr_text) {
    static const std::regex re("\\d{8}");
    std::smatch m;
    if (!std::regex_search(ocr_text, m, re)) return std::nullopt;
    return m[0].str();
}

std::optional<std::string> parse_yugioh_set_code(const std::string& ocr_text) {
    static const std::regex re("([A-Z0-9]{3,4}-[A-Z]{0,2}\\d{3})");
    std::smatch m;
    std::string text = upper_ascii(ocr_text);
    if (!std::regex_search(text, m, re)) return std::nullopt;
    return m[1].str();
}

}  // namespace cardtext
