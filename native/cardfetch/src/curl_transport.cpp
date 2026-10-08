#include <curl/curl.h>

#include <fstream>
#include <memory>
#include <mutex>

#include "cardfetch/curl_transport.hpp"

namespace fs = std::filesystem;

namespace cardfetch {

namespace {

void global_init() {
    static std::once_flag once;
    std::call_once(once, [] { curl_global_init(CURL_GLOBAL_DEFAULT); });
}

struct Easy {
    CURL* h;
    curl_slist* headers = nullptr;
    Easy() : h(curl_easy_init()) {
        if (!h) throw Error("could not initialise libcurl");
    }
    ~Easy() {
        curl_slist_free_all(headers);
        curl_easy_cleanup(h);
    }
    Easy(const Easy&) = delete;
    Easy& operator=(const Easy&) = delete;
};

size_t write_to_string(char* data, size_t size, size_t n, void* user) {
    static_cast<std::string*>(user)->append(data, size * n);
    return size * n;
}
size_t write_to_stream(char* data, size_t size, size_t n, void* user) {
    auto* out = static_cast<std::ofstream*>(user);
    out->write(data, static_cast<std::streamsize>(size * n));
    return *out ? size * n : 0;
}

// Passes the expected body size on to Transport::on_download_size once libcurl knows it (and again if it changes).
struct SizeReport {
    const std::function<void(unsigned long long)>* callback;
    curl_off_t last = 0;
};
int report_size(void* user, curl_off_t dltotal, curl_off_t, curl_off_t, curl_off_t) {
    auto* r = static_cast<SizeReport*>(user);
    if (dltotal > 0 && dltotal != r->last) {
        r->last = dltotal;
        if (*r->callback) (*r->callback)(static_cast<unsigned long long>(dltotal));
    }
    return 0;
}

// Shared by both entry points: the URL, redirects, the stall/connect timeouts and the default headers.
void configure(Easy& e, const std::string& url, int timeout_seconds, const std::string& user_agent) {
    curl_easy_setopt(e.h, CURLOPT_URL, url.c_str());
    curl_easy_setopt(e.h, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(e.h, CURLOPT_MAXREDIRS, 10L);
    curl_easy_setopt(e.h, CURLOPT_CONNECTTIMEOUT, static_cast<long>(timeout_seconds));
    // not CURLOPT_TIMEOUT: that bounds the *whole* transfer, which would cut off the multi-hundred-MB bulk files.
    // Abort instead when fewer than 1 byte/s arrives for `timeout_seconds`.
    curl_easy_setopt(e.h, CURLOPT_LOW_SPEED_LIMIT, 1L);
    curl_easy_setopt(e.h, CURLOPT_LOW_SPEED_TIME, static_cast<long>(timeout_seconds));
    curl_easy_setopt(e.h, CURLOPT_NOSIGNAL, 1L);  // required for multithreaded use with timeouts
    curl_easy_setopt(e.h, CURLOPT_ACCEPT_ENCODING, "");  // transparently handle Content-Encoding: gzip/deflate
    curl_easy_setopt(e.h, CURLOPT_USERAGENT, user_agent.c_str());
    e.headers = curl_slist_append(e.headers, (std::string("Accept: ") + kAccept).c_str());
    curl_easy_setopt(e.h, CURLOPT_HTTPHEADER, e.headers);
}

}  // namespace

CurlTransport::CurlTransport(std::string user_agent) : user_agent_(std::move(user_agent)) { global_init(); }

Response CurlTransport::get(const std::string& url, int timeout_seconds) {
    Easy e;
    configure(e, url, timeout_seconds, user_agent_);
    Response r;
    curl_easy_setopt(e.h, CURLOPT_WRITEFUNCTION, write_to_string);
    curl_easy_setopt(e.h, CURLOPT_WRITEDATA, &r.body);
    CURLcode rc = curl_easy_perform(e.h);
    if (rc != CURLE_OK) throw Error("request to " + url + " failed: " + curl_easy_strerror(rc));
    curl_easy_getinfo(e.h, CURLINFO_RESPONSE_CODE, &r.status);
    return r;
}

long CurlTransport::get_to_file(const std::string& url, int timeout_seconds, const fs::path& dest) {
    Easy e;
    configure(e, url, timeout_seconds, user_agent_);
    if (dest.has_parent_path()) fs::create_directories(dest.parent_path());
    std::ofstream out(dest, std::ios::binary | std::ios::trunc);
    if (!out) throw Error("could not write " + dest.u8string());
    curl_easy_setopt(e.h, CURLOPT_WRITEFUNCTION, write_to_stream);
    curl_easy_setopt(e.h, CURLOPT_WRITEDATA, &out);
    SizeReport size_report{&on_download_size};
    curl_easy_setopt(e.h, CURLOPT_NOPROGRESS, 0L);
    curl_easy_setopt(e.h, CURLOPT_XFERINFOFUNCTION, report_size);
    curl_easy_setopt(e.h, CURLOPT_XFERINFODATA, &size_report);
    CURLcode rc = curl_easy_perform(e.h);
    out.close();
    std::error_code ec;
    if (rc != CURLE_OK) {
        fs::remove(dest, ec);
        throw Error("request to " + url + " failed: " + curl_easy_strerror(rc));
    }
    long status = 0;
    curl_easy_getinfo(e.h, CURLINFO_RESPONSE_CODE, &status);
    if (!is_success(status)) fs::remove(dest, ec);
    return status;
}

}  // namespace cardfetch
