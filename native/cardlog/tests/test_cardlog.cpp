#include <fstream>
#include <sstream>

#include "cardlog/cardlog.hpp"
#include "cardtest.hpp"

namespace fs = std::filesystem;

static std::string slurp(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

int main() {
    cardtest::TempDir tmp;

    // timestamp: "YYYY-MM-DD HH:MM:SS"
    auto ts = cardlog::timestamp();
    CHECK_EQ(ts.size(), static_cast<size_t>(19));
    CHECK(ts[4] == '-' && ts[10] == ' ' && ts[13] == ':');

    // append_line creates parent dirs and appends
    auto startup = tmp.path() / "nested" / "dir" / "startup.log";
    cardlog::append_line(startup, "one");
    cardlog::append_line(startup, "two");
    CHECK_EQ(slurp(startup), std::string("one\ntwo\n"));

    // append_line never throws, even when the target is unusable
    cardlog::append_line(tmp.path(), "a directory is not a file");

    // rotation: tiny max size so every few writes roll over
    auto api = tmp.path() / "api.log";
    cardlog::RotatingLog log(api, /*max_bytes=*/100, /*backups=*/2);
    for (int i = 0; i < 12; ++i) log.write("GET /api/collections -> 200 request-number-" + std::to_string(i));
    CHECK(fs::exists(api));
    CHECK(fs::exists(api.string() + ".1"));
    CHECK(fs::exists(api.string() + ".2"));
    CHECK(!fs::exists(api.string() + ".3"));  // oldest dropped, only 2 backups kept
    CHECK(fs::file_size(api) <= 100);
    CHECK(slurp(api).find("request-number-11") != std::string::npos);  // newest is in the live file

    return cardtest::finish("cardlog");
}
