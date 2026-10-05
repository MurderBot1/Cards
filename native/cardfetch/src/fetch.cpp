#include "cardfetch/fetch.hpp"

#include <zlib.h>

#include <fstream>
#include <sstream>

namespace fs = std::filesystem;
using nlohmann::json;

namespace cardfetch {

namespace {

std::string slurp(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    if (!f) throw Error("could not read " + p.u8string());
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

// Write via a temp file so an interrupted run can't leave a half-written cache entry that looks complete.
void write_atomically(const fs::path& dest, const std::string& data) {
    fs::create_directories(dest.parent_path());
    fs::path tmp = dest;
    tmp += ".part";
    {
        std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
        f.write(data.data(), static_cast<std::streamsize>(data.size()));
        if (!f) throw Error("could not write " + tmp.u8string());
    }
    fs::rename(tmp, dest);
}

[[noreturn]] void http_error(const std::string& url, long status) {
    throw Error("HTTP " + std::to_string(status) + " for " + url);
}

}  // namespace

Fetcher::Fetcher(Transport& transport, fs::path cache_dir, bool refresh_cache)
    : transport_(transport), cache_dir_(std::move(cache_dir)), refresh_(refresh_cache) {}

json Fetcher::get_json(const std::string& url, const std::string& cache_key, int timeout_seconds) {
    fs::path cache_path = cache_dir_ / (cache_key + ".json");
    std::error_code ec;
    if (!refresh_ && fs::exists(cache_path, ec)) {
        json cached = json::parse(slurp(cache_path), nullptr, /*allow_exceptions=*/false);
        if (!cached.is_discarded()) return cached;  // an unreadable cache entry is just re-downloaded
    }
    Response r = transport_.get(url, timeout_seconds);
    if (!is_success(r.status)) http_error(url, r.status);
    json parsed = json::parse(r.body, nullptr, /*allow_exceptions=*/false);
    if (parsed.is_discarded()) throw Error("response from " + url + " is not valid JSON");
    write_atomically(cache_path, r.body);
    return parsed;
}

std::string Fetcher::get_bytes(const std::string& url, int timeout_seconds) {
    Response r = transport_.get(url, timeout_seconds);
    if (!is_success(r.status)) http_error(url, r.status);
    return std::move(r.body);
}

std::size_t for_each_gzip_line(const fs::path& file, const std::function<void(const std::string&)>& on_line) {
    std::ifstream in(file, std::ios::binary);
    if (!in) throw Error("could not read " + file.u8string());

    z_stream zs{};
    if (inflateInit2(&zs, 16 + MAX_WBITS) != Z_OK) throw Error("could not initialise zlib");
    struct Guard {
        z_stream* z;
        ~Guard() { inflateEnd(z); }
    } guard{&zs};

    constexpr std::size_t kChunk = 1 << 16;
    std::string in_buf(kChunk, '\0');
    std::string out_buf(kChunk, '\0');
    std::string line;
    std::size_t count = 0;
    auto flush_line = [&] {
        // trim "\r" and surrounding whitespace the way Python's line.strip() did
        std::size_t b = line.find_first_not_of(" \t\r\n"), e = line.find_last_not_of(" \t\r\n");
        if (b != std::string::npos) on_line(line.substr(b, e - b + 1)), ++count;
        line.clear();
    };

    int rc = Z_OK;
    while (rc != Z_STREAM_END) {
        in.read(in_buf.data(), static_cast<std::streamsize>(in_buf.size()));
        std::streamsize got = in.gcount();
        if (got <= 0) throw Error("truncated gzip data in " + file.u8string());
        zs.next_in = reinterpret_cast<Bytef*>(in_buf.data());
        zs.avail_in = static_cast<uInt>(got);
        while (zs.avail_in > 0 && rc != Z_STREAM_END) {
            zs.next_out = reinterpret_cast<Bytef*>(out_buf.data());
            zs.avail_out = static_cast<uInt>(out_buf.size());
            rc = inflate(&zs, Z_NO_FLUSH);
            if (rc != Z_OK && rc != Z_STREAM_END) throw Error("corrupt gzip data in " + file.u8string());
            std::size_t produced = out_buf.size() - zs.avail_out;
            for (std::size_t i = 0; i < produced; ++i) {
                char c = out_buf[i];
                if (c == '\n') flush_line();
                else line += c;
            }
        }
    }
    flush_line();  // a final line with no trailing newline
    return count;
}

std::size_t Fetcher::for_each_jsonl_gz(const std::string& url, const std::string& cache_key,
                                       const std::function<void(const json&)>& on_item, int timeout_seconds) {
    fs::path cache_path = cache_dir_ / (cache_key + ".jsonl.gz");
    std::error_code ec;
    if (refresh_ || !fs::exists(cache_path, ec)) {
        fs::create_directories(cache_dir_);
        fs::path part = cache_path;
        part += ".part";
        long status = transport_.get_to_file(url, timeout_seconds, part);
        if (!is_success(status)) {
            fs::remove(part, ec);
            http_error(url, status);
        }
        fs::rename(part, cache_path);
    }
    return for_each_gzip_line(cache_path, [&](const std::string& line) {
        json item = json::parse(line, nullptr, /*allow_exceptions=*/false);
        if (item.is_discarded()) throw Error("a line of " + cache_path.u8string() + " is not valid JSON");
        on_item(item);
    });
}

}  // namespace cardfetch
