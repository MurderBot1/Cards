// cardview — a native window around the system web view (WebKitGTK on Linux, WKWebView on macOS,
// WebView2 on Windows), replacing pywebview. The UI is the existing HTML/JS frontend served by cardhttp; this
// only owns the window.
#pragma once

#include <functional>
#include <memory>
#include <string>

namespace cardview {

struct Options {
    std::string title = "Card Master";
    int width = 1200;
    int height = 800;
    bool debug = false;  // developer tools / inspector
};

class View {
public:
    // Throws std::runtime_error if the window or web view can't be created (e.g. no display).
    explicit View(const Options& options = {});
    ~View();
    View(const View&) = delete;
    View& operator=(const View&) = delete;

    void set_title(const std::string& title);
    void navigate(const std::string& url);

    // Exposes a JS function `window.<name>(...)` that calls `handler` with the arguments as a JSON array
    // text (e.g. "[1,\"a\"]") and resolves the JS promise with the JSON text it returns. The handler runs on
    // the UI thread.
    void bind(const std::string& name, std::function<std::string(const std::string& args_json)> handler);

    void eval(const std::string& js);

    // Runs `fn` on the UI thread. Safe to call from any thread.
    void dispatch(std::function<void()> fn);

    // Blocks, running the UI, until the window is closed or terminate() is called.
    void run();

    // Closes the window and makes run() return. Safe to call from any thread.
    void terminate();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace cardview
