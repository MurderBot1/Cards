#include <zlib.h>

#include <atomic>
#include <chrono>
#include <fstream>
#include <map>
#include <mutex>
#include <thread>

#include "cardfetch/curl_transport.hpp"
#include "cardfetch/fetch.hpp"
#include "cardhttp/server.hpp"
#include "cardtest.hpp"

namespace fs = std::filesystem;
using nlohmann::json;

namespace {

std::string gzip(const std::string& data) {
    z_stream zs{};
    deflateInit2(&zs, Z_DEFAULT_COMPRESSION, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY);
    std::string out(deflateBound(&zs, static_cast<uLong>(data.size())) + 64, '\0');
    zs.next_in = reinterpret_cast<Bytef*>(const_cast<char*>(data.data()));
    zs.avail_in = static_cast<uInt>(data.size());
    zs.next_out = reinterpret_cast<Bytef*>(out.data());
    zs.avail_out = static_cast<uInt>(out.size());
    deflate(&zs, Z_FINISH);
    out.resize(out.size() - zs.avail_out);
    deflateEnd(&zs);
    return out;
}

void write_file(const fs::path& p, const std::string& s) {
    fs::create_directories(p.parent_path());
    std::ofstream(p, std::ios::binary) << s;
}

std::string slurp(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    return std::string(std::istreambuf_iterator<char>(f), {});
}

// Serves canned bodies by URL and counts how often each is asked for.
class FakeTransport : public cardfetch::Transport {
public:
    std::map<std::string, std::pair<long, std::string>> pages;
    std::map<std::string, int> hits;
    std::mutex mu;

    cardfetch::Response get(const std::string& url, int) override {
        std::lock_guard<std::mutex> l(mu);
        ++hits[url];
        auto it = pages.find(url);
        if (it == pages.end()) return {404, ""};
        return {it->second.first, it->second.second};
    }
    long get_to_file(const std::string& url, int timeout, const fs::path& dest) override {
        auto r = get(url, timeout);
        if (cardfetch::is_success(r.status)) write_file(dest, r.body);
        return r.status;
    }
};

bool throws_error(const std::function<void()>& f, const std::string& needle = "") {
    try {
        f();
    } catch (const cardfetch::Error& e) {
        return needle.empty() || std::string(e.what()).find(needle) != std::string::npos;
    }
    return false;
}

}  // namespace

int main() {
    cardtest::TempDir tmp;
    const fs::path cache = tmp.path() / "cache";

    // ===================== Fetcher over a fake transport =====================
    {
        FakeTransport net;
        net.pages["http://x/data.json"] = {200, R"({"data":[1,2,3]})"};
        net.pages["http://x/bad.json"] = {200, "{nope"};
        net.pages["http://x/missing"] = {404, "not found"};
        cardfetch::Fetcher f(net, cache);

        // get_json: fetched once, then served from the cache
        CHECK_EQ(f.get_json("http://x/data.json", "data")["data"].size(), static_cast<size_t>(3));
        CHECK(fs::exists(cache / "data.json"));
        CHECK_EQ(f.get_json("http://x/data.json", "data")["data"][1], json(2));
        CHECK_EQ(net.hits["http://x/data.json"], 1);

        // --refresh-cache ignores it
        cardfetch::Fetcher refreshing(net, cache, /*refresh_cache=*/true);
        refreshing.get_json("http://x/data.json", "data");
        CHECK_EQ(net.hits["http://x/data.json"], 2);

        // a corrupt cache entry is re-downloaded rather than trusted
        write_file(cache / "data.json", "{truncated");
        CHECK_EQ(f.get_json("http://x/data.json", "data")["data"].size(), static_cast<size_t>(3));
        CHECK_EQ(net.hits["http://x/data.json"], 3);
        CHECK_EQ(json::parse(slurp(cache / "data.json"))["data"].size(), static_cast<size_t>(3));  // and repaired

        // failures
        CHECK(throws_error([&] { f.get_json("http://x/missing", "missing"); }, "HTTP 404"));
        CHECK(!fs::exists(cache / "missing.json"));  // a failed fetch caches nothing
        CHECK(throws_error([&] { f.get_json("http://x/bad.json", "bad"); }, "not valid JSON"));
        CHECK(!fs::exists(cache / "bad.json"));

        // get_bytes: not cached, binary-safe, errors on non-2xx
        net.pages["http://x/img"] = {200, std::string("\xff\xd8\0\1\2", 5)};
        CHECK_EQ(f.get_bytes("http://x/img").size(), static_cast<size_t>(5));
        CHECK(throws_error([&] { f.get_bytes("http://x/missing"); }, "HTTP 404"));
    }

    // ===================== streaming gzipped JSONL =====================
    {
        FakeTransport net;
        std::string jsonl = "{\"id\":1,\"name\":\"Lightning Bolt\"}\n\n   \n{\"id\":2,\"name\":\"稲妻の剣\"}\r\n{\"id\":3}";  // blank lines, CRLF, no final newline
        net.pages["http://x/bulk.gz"] = {200, gzip(jsonl)};
        cardfetch::Fetcher f(net, cache);

        std::vector<json> items;
        size_t n = f.for_each_jsonl_gz("http://x/bulk.gz", "bulk", [&](const json& j) { items.push_back(j); });
        CHECK_EQ(n, static_cast<size_t>(3));
        CHECK(items.size() == 3 && items[0]["id"] == 1 && items[1]["name"] == "稲妻の剣" && items[2]["id"] == 3);
        CHECK(fs::exists(cache / "bulk.jsonl.gz"));
        CHECK(!fs::exists(cache / "bulk.jsonl.gz.part"));

        // second run reads the cached archive without touching the network
        size_t again = f.for_each_jsonl_gz("http://x/bulk.gz", "bulk", [](const json&) {});
        CHECK_EQ(again, static_cast<size_t>(3));
        CHECK_EQ(net.hits["http://x/bulk.gz"], 1);

        // chunk boundaries: 100k lines (several MB inflated) and a single line much longer than the 64 KiB read chunk
        std::string big;
        for (int i = 0; i < 100000; ++i) big += "{\"i\":" + std::to_string(i) + ",\"pad\":\"xxxxxxxxxxxxxxxx\"}\n";
        big += "{\"long\":\"" + std::string(300000, 'y') + "\"}\n";
        net.pages["http://x/big.gz"] = {200, gzip(big)};
        size_t count = 0;
        long long sum = 0;
        size_t long_len = 0;
        f.for_each_jsonl_gz("http://x/big.gz", "big", [&](const json& j) {
            ++count;
            if (j.contains("i")) sum += j["i"].get<long long>();
            if (j.contains("long")) long_len = j["long"].get<std::string>().size();
        });
        CHECK_EQ(count, static_cast<size_t>(100001));
        CHECK_EQ(sum, 4999950000LL);
        CHECK_EQ(long_len, static_cast<size_t>(300000));

        // failures: HTTP error (and no cache entry left behind), a line that isn't JSON, corrupt and truncated archives
        net.pages["http://x/err.gz"] = {500, "boom"};
        CHECK(throws_error([&] { f.for_each_jsonl_gz("http://x/err.gz", "err", [](const json&) {}); }, "HTTP 500"));
        CHECK(!fs::exists(cache / "err.jsonl.gz") && !fs::exists(cache / "err.jsonl.gz.part"));
        net.pages["http://x/notjson.gz"] = {200, gzip("{\"ok\":1}\nthis is not json\n")};
        CHECK(throws_error([&] { f.for_each_jsonl_gz("http://x/notjson.gz", "notjson", [](const json&) {}); }, "not valid JSON"));
        net.pages["http://x/corrupt.gz"] = {200, "this is not gzip data at all"};
        CHECK(throws_error([&] { f.for_each_jsonl_gz("http://x/corrupt.gz", "corrupt", [](const json&) {}); }, "corrupt gzip"));
        std::string whole = gzip(jsonl);
        net.pages["http://x/trunc.gz"] = {200, whole.substr(0, whole.size() / 2)};
        CHECK(throws_error([&] { f.for_each_jsonl_gz("http://x/trunc.gz", "trunc", [](const json&) {}); }, "truncated"));

        // an exception from the callback propagates
        bool caught = false;
        try {
            f.for_each_jsonl_gz("http://x/bulk.gz", "bulk", [](const json&) { throw std::runtime_error("stop"); });
        } catch (const std::runtime_error&) {
            caught = true;
        }
        CHECK(caught);
    }

    // ===================== CurlTransport against a real local server =====================
    {
        cardhttp::Server server;
        std::atomic<int> slow_calls{0};
        server.route("GET", "/json", [](const cardhttp::Request& r) {
            auto ua = r.headers.find("user-agent");
            auto accept = r.headers.find("accept");
            return cardhttp::Response::json(200, json{{"ua", ua == r.headers.end() ? "" : ua->second},
                                                      {"accept", accept == r.headers.end() ? "" : accept->second}}.dump());
        });
        server.route("GET", "/gone", [](const cardhttp::Request&) { return cardhttp::Response::json(404, "{}"); });
        server.route("GET", "/redirect", [](const cardhttp::Request&) {
            cardhttp::Response r = cardhttp::Response::json(302, "");
            r.headers["Location"] = "/json";
            return r;
        });
        std::string big(5 * 1024 * 1024, 'z');
        for (size_t i = 0; i < big.size(); i += 1000) big[i] = static_cast<char>('a' + (i / 1000) % 26);
        server.route("GET", "/big", [&](const cardhttp::Request&) { return cardhttp::Response{200, big, "application/octet-stream", {}}; });
        server.route("GET", "/slow", [&](const cardhttp::Request&) {
            ++slow_calls;
            std::this_thread::sleep_for(std::chrono::seconds(4));
            return cardhttp::Response::json(200, "{}");
        });
        int port = server.bind_any_port("127.0.0.1");
        CHECK(port > 0);
        std::thread serving([&] { server.listen_after_bind(); });
        for (int i = 0; i < 200 && !server.is_running(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(10));
        const std::string base = "http://127.0.0.1:" + std::to_string(port);

        cardfetch::CurlTransport curl;

        // the headers the APIs require, and a normal body
        auto r = curl.get(base + "/json", 5);
        CHECK_EQ(r.status, 200L);
        json body = json::parse(r.body, nullptr, false);
        CHECK_EQ(body["ua"], json(cardfetch::kUserAgent));
        CHECK_EQ(body["accept"], json(cardfetch::kAccept));

        // an HTTP error status is returned, not thrown (the Fetcher decides what it means)
        CHECK_EQ(curl.get(base + "/gone", 5).status, 404L);
        // redirects are followed
        auto redirected = curl.get(base + "/redirect", 5);
        CHECK_EQ(redirected.status, 200L);
        CHECK(redirected.body.find("user-agent") == std::string::npos && redirected.body.find("ua") != std::string::npos);

        // a large body arrives intact, in memory and streamed to a file
        auto whole = curl.get(base + "/big", 10);
        CHECK(whole.status == 200 && whole.body == big);
        fs::path dest = tmp.path() / "dl" / "big.bin";
        CHECK_EQ(curl.get_to_file(base + "/big", 10, dest), 200L);
        CHECK(slurp(dest) == big);
        // a failure status leaves no file behind
        fs::path missing = tmp.path() / "dl" / "gone.bin";
        CHECK_EQ(curl.get_to_file(base + "/gone", 5, missing), 404L);
        CHECK(!fs::exists(missing));

        // a server that stalls is abandoned after the timeout instead of hanging the whole build
        auto t0 = std::chrono::steady_clock::now();
        CHECK(throws_error([&] { curl.get(base + "/slow", 1); }));
        auto secs = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::steady_clock::now() - t0).count();
        CHECK(secs < 4);

        // end to end through a Fetcher: JSON cached, gz streamed
        cardfetch::Fetcher fetcher(curl, tmp.path() / "net-cache");
        CHECK_EQ(fetcher.get_json(base + "/json", "j")["ua"], json(cardfetch::kUserAgent));
        CHECK(throws_error([&] { fetcher.get_json(base + "/gone", "g"); }, "HTTP 404"));

        server.stop();
        serving.join();

        // nothing listening: a transport error, not a status
        CHECK(throws_error([&] { curl.get(base + "/json", 2); }, "failed"));
    }

    return cardtest::finish("cardfetch");
}
