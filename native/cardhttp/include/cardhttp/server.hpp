// cardhttp — the HTTP server (replaces Flask): pattern routes with path
// parameters, multipart uploads, static files, an access-log hook. A thin,
// JSON-agnostic wrapper over cpp-httplib that doesn't leak it, so the library
// underneath can change without touching callers.
#pragma once

#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <string>

namespace cardhttp {

struct UploadedFile {
    std::string filename;
    std::string content_type;
    std::string data;
};

struct Request {
    std::string method;
    std::string path;
    std::string query_string;  // without the leading '?'
    std::string remote_addr;
    std::string body;
    std::map<std::string, std::string> query;   // ?a=b
    std::map<std::string, std::string> params;  // <name> segments of the matched route pattern
    std::map<std::string, std::string> form;    // non-file fields of a multipart/form-data body
    std::map<std::string, UploadedFile> files;  // file parts, by field name
};

struct Response {
    int status = 200;
    std::string body;
    std::string content_type = "application/json";

    static Response json(int status, std::string body) { return {status, std::move(body), "application/json"}; }
};

using Handler = std::function<Response(const Request&)>;

struct AccessLogEntry {
    std::string method, path, query_string, remote_addr;
    int status = 0;
    double duration_ms = 0;
};

class Server {
public:
    Server();
    ~Server();
    Server(const Server&) = delete;
    Server& operator=(const Server&) = delete;

    // method: GET | POST | PUT | PATCH | DELETE. pattern: "/api/collections/<id>/cards/<card_id>" —
    // each <name> matches one path segment and lands in Request::params.
    // Routes are matched in registration order.
    void route(const std::string& method, const std::string& pattern, Handler handler);

    // GET <url_prefix>/<file> -> <dir>/<file>. Paths that escape `dir` 404.
    void serve_directory(const std::string& url_prefix, const std::filesystem::path& dir);
    // GET <url_path> -> one file.
    void serve_file(const std::string& url_path, const std::filesystem::path& file);

    // Called after every response (any thread).
    void on_access(std::function<void(const AccessLogEntry&)> callback);

    // Blocks until stop(). Returns false if the port couldn't be bound.
    bool listen(const std::string& host, int port);
    // Two-step variant: bind port 0 -> returns the chosen port (or -1), then
    // listen_after_bind() blocks until stop().
    int bind_any_port(const std::string& host);
    bool listen_after_bind();

    void stop();
    bool is_running() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace cardhttp
