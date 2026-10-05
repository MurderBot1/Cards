#include "cardhttp/server.hpp"

#include <chrono>
#include <fstream>
#include <regex>
#include <sstream>
#include <vector>

#include <httplib.h>

namespace fs = std::filesystem;

namespace cardhttp {

namespace {

thread_local std::chrono::steady_clock::time_point t_request_start;

std::string regex_escape(const std::string& s) {
    static const std::regex special(R"([.^$|()\[\]{}*+?\\])");
    return std::regex_replace(s, special, R"(\$&)");
}

// "/a/<x>/b" -> regex "^/a/([^/]+)/b$" plus ["x"].
std::string compile_pattern(const std::string& pattern, std::vector<std::string>& names) {
    std::string out = "^";
    size_t i = 0;
    while (i < pattern.size()) {
        if (pattern[i] == '<') {
            size_t close = pattern.find('>', i);
            if (close == std::string::npos) break;
            names.push_back(pattern.substr(i + 1, close - i - 1));
            out += "([^/]+)";
            i = close + 1;
        } else {
            size_t next = pattern.find('<', i);
            if (next == std::string::npos) next = pattern.size();
            out += regex_escape(pattern.substr(i, next - i));
            i = next;
        }
    }
    return out + "$";
}

std::string mime_for(const fs::path& p) {
    static const std::map<std::string, std::string> types = {
        {".html", "text/html; charset=utf-8"}, {".htm", "text/html; charset=utf-8"},
        {".css", "text/css; charset=utf-8"},   {".js", "text/javascript; charset=utf-8"},
        {".mjs", "text/javascript; charset=utf-8"}, {".json", "application/json"},
        {".txt", "text/plain; charset=utf-8"}, {".svg", "image/svg+xml"},
        {".png", "image/png"},                 {".jpg", "image/jpeg"},
        {".jpeg", "image/jpeg"},               {".gif", "image/gif"},
        {".webp", "image/webp"},               {".ico", "image/x-icon"},
        {".woff", "font/woff"},                {".woff2", "font/woff2"},
        {".wasm", "application/wasm"},
    };
    auto it = types.find(p.extension().string());
    return it == types.end() ? "application/octet-stream" : it->second;
}

bool read_file(const fs::path& p, std::string& out) {
    std::ifstream f(p, std::ios::binary);
    if (!f) return false;
    std::ostringstream ss;
    ss << f.rdbuf();
    out = ss.str();
    return true;
}

std::string json_escape(const std::string& s) {
    std::string out;
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out;
}

Request convert(const httplib::Request& h, const std::vector<std::string>& names) {
    Request r;
    r.method = h.method;
    r.path = h.path;
    r.remote_addr = h.remote_addr;
    r.body = h.body;
    auto q = h.target.find('?');
    if (q != std::string::npos) r.query_string = h.target.substr(q + 1);
    for (const auto& p : h.params) r.query.emplace(p.first, p.second);
    for (size_t i = 0; i < names.size() && i + 1 < h.matches.size(); ++i) r.params[names[i]] = h.matches[i + 1];
    // httplib reports every multipart part in `files`; the text fields are the ones with no filename.
    for (const auto& f : h.files) {
        if (f.second.filename.empty())
            r.form.emplace(f.first, f.second.content);
        else
            r.files.emplace(f.first, UploadedFile{f.second.filename, f.second.content_type, f.second.content});
    }
    return r;
}

}  // namespace

struct Server::Impl {
    httplib::Server svr;
    std::function<void(const AccessLogEntry&)> access_cb;
};

Server::Server() : impl_(new Impl) {
    auto& svr = impl_->svr;

    // httplib's default also sets SO_REUSEPORT on Linux/macOS, which lets a second Binder
    // silently share the first one's port instead of failing to bind. SO_REUSEADDR alone
    // just allows restarting right away (and is deliberately omitted on Windows, where it
    // would allow port hijacking).
    svr.set_socket_options([](socket_t sock) {
#ifndef _WIN32
        int yes = 1;
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const void*>(&yes), sizeof(yes));
#else
        (void)sock;
#endif
    });

    svr.set_pre_routing_handler([](const httplib::Request&, httplib::Response&) {
        t_request_start = std::chrono::steady_clock::now();
        return httplib::Server::HandlerResponse::Unhandled;
    });

    svr.set_exception_handler([](const httplib::Request&, httplib::Response& res, std::exception_ptr ep) {
        std::string what = "internal error";
        try {
            if (ep) std::rethrow_exception(ep);
        } catch (const std::exception& e) {
            what = e.what();
        } catch (...) {
        }
        res.status = 500;
        res.set_content("{\"error\":\"" + json_escape(what) + "\"}", "application/json");
    });

    Impl* impl = impl_.get();
    svr.set_logger([impl](const httplib::Request& req, const httplib::Response& res) {
        if (!impl->access_cb) return;
        AccessLogEntry e;
        e.method = req.method;
        e.path = req.path;
        auto q = req.target.find('?');
        if (q != std::string::npos) e.query_string = req.target.substr(q + 1);
        e.remote_addr = req.remote_addr;
        e.status = res.status;
        e.duration_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t_request_start).count();
        impl->access_cb(e);
    });
}

Server::~Server() { stop(); }

void Server::route(const std::string& method, const std::string& pattern, Handler handler) {
    std::vector<std::string> names;
    std::string re = compile_pattern(pattern, names);
    auto wrapped = [handler = std::move(handler), names](const httplib::Request& hreq, httplib::Response& hres) {
        Response r = handler(convert(hreq, names));
        hres.status = r.status;
        hres.set_content(r.body, r.content_type);
    };
    auto& svr = impl_->svr;
    if (method == "GET") svr.Get(re, wrapped);
    else if (method == "POST") svr.Post(re, wrapped);
    else if (method == "PUT") svr.Put(re, wrapped);
    else if (method == "PATCH") svr.Patch(re, wrapped);
    else if (method == "DELETE") svr.Delete(re, wrapped);
    else throw std::invalid_argument("cardhttp: unsupported method " + method);
}

void Server::serve_file(const std::string& url_path, const fs::path& file) {
    impl_->svr.Get("^" + regex_escape(url_path) + "$", [file](const httplib::Request&, httplib::Response& res) {
        std::string data;
        if (!read_file(file, data)) {
            res.status = 404;
            return;
        }
        res.set_content(data, mime_for(file));
    });
}

void Server::serve_directory(const std::string& url_prefix, const fs::path& dir) {
    std::error_code ec;
    fs::path root = fs::weakly_canonical(dir, ec);
    if (ec) root = dir;
    impl_->svr.Get("^" + regex_escape(url_prefix) + "/(.+)$", [root](const httplib::Request& req, httplib::Response& res) {
        std::string rel = req.matches[1];
        std::error_code e;
        fs::path target = fs::weakly_canonical(root / fs::path(rel), e);
        // Reject anything that resolves outside the served directory (../, absolute paths, symlink escapes).
        fs::path within = e ? fs::path() : target.lexically_relative(root);
        if (e || within.empty() || *within.begin() == "..") {
            res.status = 404;
            return;
        }
        std::string data;
        if (!fs::is_regular_file(target, e) || !read_file(target, data)) {
            res.status = 404;
            return;
        }
        res.set_content(data, mime_for(target));
    });
}

void Server::on_access(std::function<void(const AccessLogEntry&)> callback) { impl_->access_cb = std::move(callback); }

bool Server::listen(const std::string& host, int port) { return impl_->svr.listen(host, port); }
int Server::bind_any_port(const std::string& host) { return impl_->svr.bind_to_any_port(host); }
bool Server::listen_after_bind() { return impl_->svr.listen_after_bind(); }
void Server::stop() {
    if (impl_) impl_->svr.stop();
}
bool Server::is_running() const { return impl_->svr.is_running(); }

}  // namespace cardhttp
