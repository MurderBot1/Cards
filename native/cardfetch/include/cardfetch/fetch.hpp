// cardfetch — what the catalog builder needs from the network: plain GETs behind a Transport interface (so the
// ingest logic is testable without one), an on-disk cache for the big bulk downloads (so an interrupted run
// resumes instead of re-downloading), and a streaming reader for the gzipped JSONL Scryfall serves its bulk data
// as — one JSON object per line, no wrapping array — which is multiple GB uncompressed, so never held in memory.
#pragma once

#include <cstdint>
#include <filesystem>
#include <functional>
#include <stdexcept>
#include <string>

#include <nlohmann/json.hpp>

namespace cardfetch {

class Error : public std::runtime_error {
    using std::runtime_error::runtime_error;
};

struct Response {
    long status = 0;
    std::string body;
};

// One HTTP GET (following redirects). Thread-safe: callers fetch from several threads at once.
// `timeout_seconds` bounds connecting and stalls (no data for that long), not the total transfer time, since the
// bulk files are large.
class Transport {
public:
    virtual ~Transport() = default;
    virtual Response get(const std::string& url, int timeout_seconds) = 0;
    // Streams the body into `dest` (created or truncated) and returns the HTTP status. On a failure status the
    // file is removed. Throws Error on a transport-level failure (DNS, connection, timeout).
    virtual long get_to_file(const std::string& url, int timeout_seconds, const std::filesystem::path& dest) = 0;

    // Optional: a transport that learns the body's size (Content-Length) while get_to_file runs calls this with it
    // as soon as the response headers are in, so a caller can show "x of y". Never called when the size is unknown.
    // Set by the caller before get_to_file; called on the thread running it.
    std::function<void(unsigned long long)> on_download_size;
};

// HTTP status 2xx.
inline bool is_success(long status) { return status >= 200 && status < 300; }

class Fetcher {
public:
    // `cache_dir` holds <key>.json / <key>.jsonl.gz for the bulk data. `refresh_cache` ignores what's there and
    // downloads again.
    Fetcher(Transport& transport, std::filesystem::path cache_dir, bool refresh_cache = false);

    // GETs a JSON URL, cached as <cache_dir>/<cache_key>.json. Throws Error on a non-2xx status or invalid JSON.
    nlohmann::json get_json(const std::string& url, const std::string& cache_key, int timeout_seconds = 30);

    // GETs a gzipped JSONL URL, cached (raw, still compressed) as <cache_dir>/<cache_key>.jsonl.gz, and calls
    // `on_item` for every line, streaming. Blank lines are skipped. Returns the number of objects. Throws Error on a
    // non-2xx status, a corrupt archive or a line that isn't JSON.
    std::size_t for_each_jsonl_gz(const std::string& url, const std::string& cache_key,
                                  const std::function<void(const nlohmann::json&)>& on_item, int timeout_seconds = 120);

    // GETs raw bytes (images); not cached. Throws Error on a non-2xx status.
    std::string get_bytes(const std::string& url, int timeout_seconds = 30);

    Transport& transport() { return transport_; }

private:
    Transport& transport_;
    std::filesystem::path cache_dir_;
    bool refresh_;
};

// Reads a gzip file line by line (streaming), calling `on_line` for each non-empty line with the trailing newline
// removed. Returns the line count. Throws Error if the file can't be read or isn't valid gzip.
std::size_t for_each_gzip_line(const std::filesystem::path& file, const std::function<void(const std::string&)>& on_line);

// The default headers the APIs get: Scryfall rejects requests without a descriptive User-Agent and an Accept header
// (400 Bad Request), and it's good practice with the others.
inline constexpr const char* kUserAgent = "BinderCardTracker/1.0 (personal card-collection app)";
inline constexpr const char* kAccept = "application/json";

}  // namespace cardfetch
