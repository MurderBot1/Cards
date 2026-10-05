// Expected values below were produced by CPython's difflib / re / str.lower, so these tests
// pin the C++ port to the behavior the Python scanner had.
#include <string>
#include <vector>

#include "cardtext/text.hpp"
#include "cardtest.hpp"

using namespace cardtext;

int main() {
    // ---- normalize_title: Unicode-aware, punctuation -> single spaces
    CHECK_EQ(normalize_title("  Sol  Ring, the/BEST! "), std::string("sol ring the best"));
    CHECK_EQ(normalize_title("Übermut"), std::string("übermut"));
    CHECK_EQ(normalize_title("稲妻の剣!"), std::string("稲妻の剣"));  // non-Latin names survive
    CHECK_EQ(normalize_title("Lightning-Bolt (Alpha)"), std::string("lightning bolt alpha"));
    CHECK_EQ(normalize_title("Привет, МИР!"), std::string("привет мир"));
    CHECK_EQ(normalize_title("Ｆｕｌｌ ＡＢＣ"), std::string("ｆｕｌｌ ａｂｃ"));
    CHECK_EQ(normalize_title("a_b-c"), std::string("a_b c"));  // underscore is a word character
    CHECK_EQ(normalize_title("Ωμέγα ΣΊΣΥΦΟΣ"), std::string("ωμέγα σίσυφος"));  // final sigma -> ς
    CHECK_EQ(normalize_title("İstanbul"), std::string("i stanbul"));  // İ lowercases to i + combining dot (a mark)
    CHECK_EQ(normalize_title("..."), std::string(""));
    CHECK_EQ(normalize_title(""), std::string(""));

    // ---- lower_utf8 / strip_utf8
    CHECK_EQ(lower_utf8("ÜBERMUT Éclair ΩΜΕΓΑ"), std::string("übermut éclair ωμεγα"));
    CHECK_EQ(lower_utf8("ΑΣ ΑΣΑ"), std::string("ας ασα"));  // Σ only becomes ς at the end of a word
    CHECK_EQ(strip_utf8("\t 稲妻 \n"), std::string("稲妻"));
    CHECK_EQ(strip_utf8("\xC2\xA0x\xE3\x80\x80"), std::string("x"));  // NBSP and ideographic space
    CHECK_EQ(strip_utf8("   "), std::string(""));

    // ---- invalid UTF-8 never crashes; it decodes to U+FFFD
    CHECK_EQ(decode_utf8("a\xFF""b").size(), static_cast<size_t>(3));
    CHECK_EQ(encode_utf8(decode_utf8("héllo 稲 \xF0\x9F\x98\x80")), std::string("héllo 稲 \xF0\x9F\x98\x80"));

    // ---- sequence_ratio == difflib.SequenceMatcher(None, a, b).ratio()
    struct R {
        const char *a, *b;
        double expected;
    };
    const R ratios[] = {
        {"lightning bolt", "lightning bolt", 1.0},
        {"l1ghtning b0lt", "lightning bolt", 0.8571428571428571},
        {"lightnin bolt", "lightning bolt", 0.9629629629629629},
        {"completely unrelated gibberish", "lightning bolt", 0.13636363636363635},
        {"abcd", "bcde", 0.75},
        {"", "", 1.0},
        {"a", "", 0.0},
        {"übermut", "ubermut", 0.8571428571428571},
        {"稲妻の剣", "稲妻の剣", 1.0},
        {"稲妻", "稲妻の剣", 0.6666666666666666},
        {"dark magician", "dark magican", 0.96},
        {"sol ring", "soul ring", 0.9411764705882353},
    };
    for (const auto& r : ratios) CHECK_EQ(sequence_ratio(r.a, r.b), r.expected);
    {
        // 300 characters of "abab...": every character is "popular", so difflib's autojunk
        // indexes nothing and the ratio is 0.0 — a quirk the port reproduces on purpose.
        std::string a, b;
        for (int i = 0; i < 150; ++i) a += "ab", b += "ba";
        CHECK_EQ(sequence_ratio(a, b), 0.0);
    }

    // ---- get_close_matches: ordering, cutoff, n, tie-breaking
    const std::vector<std::string> names = {"lightning bolt", "black lotus",     "übermut",
                                            "稲妻の剣",       "lightning helix", "lightning strike",
                                            "bolt",           "dark magician",   "dark magician girl"};
    auto close = [&](const std::string& w, size_t n = 5, double cutoff = 0.55) { return get_close_matches(w, names, n, cutoff); };
    using V = std::vector<std::string>;
    CHECK(close("lightnin bolt") == (V{"lightning bolt", "lightning helix", "lightning strike"}));
    CHECK(close("l1ghtning b0lt") == (V{"lightning bolt", "lightning helix", "lightning strike"}));
    CHECK(close("black lotus") == (V{"black lotus"}));
    CHECK(close("completely unrelated gibberish").empty());
    CHECK(close("dark magic") == (V{"dark magician", "dark magician girl"}));
    CHECK(close("").empty());
    CHECK(close("lightning", 2) == (V{"lightning bolt", "lightning helix"}));  // n truncates, best first
    // equal scores break ties by string, largest first (heapq.nlargest on (score, string))
    CHECK(get_close_matches("abc", {"abd", "abe", "abf", "abx"}, 3, 0.1) == (V{"abx", "abf", "abe"}));
    CHECK(get_close_matches("ab", {"ac", "ad", "ae"}, 2, 0.1) == (V{"ae", "ad"}));

    // ---- exact-identifier patterns
    {
        auto m = parse_mtg_primary("m10 146/249 R");
        CHECK(m.has_value());
        if (m) {
            CHECK_EQ(m->set_code, std::string("M10"));  // OCR text is upper-cased first
            CHECK_EQ(m->collector_number, std::string("146"));
        }
        auto dot = parse_mtg_primary("LEA \xC2\xB7 232/302");  // "·" separator
        CHECK(dot && dot->set_code == "LEA" && dot->collector_number == "232");
        CHECK(!parse_mtg_primary("no identifier here").has_value());
        CHECK(!parse_mtg_primary("AB 12/13").has_value());  // set codes are 3-5 characters

        auto pk = parse_pokemon_modern("sv3 025/197");
        CHECK(pk && pk->set_code == "SV3" && pk->collector_number == "025");
        CHECK(!parse_pokemon_modern("025/197").has_value());  // modern needs a set code
        auto vintage = parse_pokemon_vintage("4/102");
        CHECK(vintage && *vintage == "4");
        CHECK(!parse_pokemon_vintage("nothing").has_value());

        auto pass = parse_yugioh_passcode("46986414");
        CHECK(pass && *pass == "46986414");
        CHECK(parse_yugioh_passcode("x 12345678 y").value_or("") == "12345678");
        CHECK(!parse_yugioh_passcode("1234567").has_value());  // 7 digits is not a passcode
        auto code = parse_yugioh_set_code("lob-en005");
        CHECK(code && *code == "LOB-EN005");
        CHECK(!parse_yugioh_set_code("LOB005").has_value());
    }

    return cardtest::finish("cardtext");
}
