#include <fstream>
#include <map>

#include "carddownload/download.hpp"
#include "cardtest.hpp"

namespace fs = std::filesystem;

namespace {

std::string slurp(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    return std::string(std::istreambuf_iterator<char>(f), {});
}

class FakeTransport : public cardfetch::Transport {
public:
    std::map<std::string, std::string> pages;  // url -> body; anything else is a 404
    std::vector<std::string> requested;
    bool fail_mid_transfer = false;

    cardfetch::Response get(const std::string&, int) override { return {500, ""}; }
    long get_to_file(const std::string& url, int, const fs::path& dest) override {
        requested.push_back(url);
        auto it = pages.find(url);
        if (it == pages.end()) return 404;
        std::ofstream(dest, std::ios::binary) << it->second;
        if (on_download_size) on_download_size(it->second.size());
        if (fail_mid_transfer) throw cardfetch::Error("connection reset");
        return 200;
    }
};

}  // namespace

int main() {
    cardtest::TempDir tmp;
    const fs::path data = tmp.path() / "data";
    carddownload::Options opt;
    opt.base_url = "http://x/Assets/";
    opt.files = {"a.bin", "b.bin"};

    FakeTransport t;
    t.pages["http://x/Assets/a.bin"] = "AAA";
    t.pages["http://x/Assets/b.bin"] = "BBB";

    // fetches everything that's missing, into a directory that doesn't exist yet
    CHECK_EQ(carddownload::missing_files(data, opt).size(), size_t(2));
    auto r = carddownload::download_missing(t, data, opt);
    CHECK(r.ok);
    CHECK_EQ(r.downloaded.size(), size_t(2));
    CHECK_EQ(slurp(data / "a.bin"), std::string("AAA"));
    CHECK_EQ(slurp(data / "b.bin"), std::string("BBB"));
    CHECK(!fs::exists(data / "a.bin.part"));

    // the per-file callback reports each download, in order
    {
        FakeTransport t2;
        t2.pages = t.pages;
        std::vector<std::string> seen;
        auto o2 = opt;
        o2.on_file = [&](const std::string& n, size_t i, size_t total) {
            seen.push_back(n + " " + std::to_string(i) + "/" + std::to_string(total));
        };
        std::vector<unsigned long long> sizes;
        o2.on_size = [&](unsigned long long bytes) { sizes.push_back(bytes); };
        CHECK(carddownload::download_missing(t2, tmp.path() / "other", o2).ok);
        CHECK_EQ(sizes.size(), size_t(2));
        CHECK_EQ(sizes[0], 3ull);
        CHECK(!t2.on_download_size);  // cleared once the transfers are over
        CHECK_EQ(seen.size(), size_t(2));
        CHECK_EQ(seen[0], std::string("a.bin 1/2"));
        CHECK_EQ(seen[1], std::string("b.bin 2/2"));
    }

    // a second run (and an existing user-built file) is left alone
    t.requested.clear();
    std::ofstream(data / "a.bin", std::ios::binary) << "mine";
    fs::remove(data / "b.bin");
    r = carddownload::download_missing(t, data, opt);
    CHECK(r.ok);
    CHECK_EQ(t.requested.size(), size_t(1));
    CHECK_EQ(slurp(data / "a.bin"), std::string("mine"));
    CHECK(carddownload::download_missing(t, data, opt).downloaded.empty());

    // an HTTP error leaves nothing behind and is reported
    fs::remove(data / "b.bin");
    t.pages.erase("http://x/Assets/b.bin");
    r = carddownload::download_missing(t, data, opt);
    CHECK(!r.ok);
    CHECK(r.error.find("b.bin") != std::string::npos && r.error.find("404") != std::string::npos);
    CHECK(!fs::exists(data / "b.bin") && !fs::exists(data / "b.bin.part"));

    // a transfer that dies halfway never leaves a file that looks complete
    t.pages["http://x/Assets/b.bin"] = "BBB";
    t.fail_mid_transfer = true;
    r = carddownload::download_missing(t, data, opt);
    CHECK(!r.ok);
    CHECK(!fs::exists(data / "b.bin") && !fs::exists(data / "b.bin.part"));
    t.fail_mid_transfer = false;
    CHECK(carddownload::download_missing(t, data, opt).ok);  // and the next launch retries
    CHECK_EQ(slurp(data / "b.bin"), std::string("BBB"));

    return cardtest::finish("carddownload");
}
