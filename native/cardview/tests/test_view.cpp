// A real window: serves a page from cardhttp, opens it in the system web view and has the page report back
// through a JS binding. Needs a display — CI runs it under xvfb; without one it exits 77 (reported as skipped).
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <thread>

#include <nlohmann/json.hpp>

#include "cardhttp/server.hpp"
#include "cardtest.hpp"
#include "cardview/view.hpp"

using nlohmann::json;

static const char* kPage = R"(<!doctype html>
<html><head><title>Binder view test</title></head>
<body><p id="status">running</p>
<script>
(async () => {
  const r = {
    title: document.title,
    href: location.href,
    secure: window.isSecureContext,
    hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
  };
  // The app scans with the camera. Record what getUserMedia does here, for information: with no camera
  // (CI, containers) WebKit fails with a "no device" error before it ever asks for permission, so this can't
  // verify the permission policy in cardview.cpp — that needs a machine with a webcam.
  const attempt = async (constraints) => {
    try { (await navigator.mediaDevices.getUserMedia(constraints)).getTracks().forEach(t => t.stop()); return "ok"; }
    catch (e) { return e.name; }
  };
  if (r.hasGetUserMedia) {
    r.video = await attempt({ video: true });
    r.audio = await attempt({ audio: true });
  }
  await window.report(JSON.stringify(r));
})();
</script></body></html>)";

int main() {
    if (!std::getenv("DISPLAY") && !std::getenv("WAYLAND_DISPLAY")) {
        std::cout << "SKIP: no display (run under xvfb-run)\n";
        return 77;
    }

    cardhttp::Server server;
    server.route("GET", "/", [](const cardhttp::Request&) { return cardhttp::Response{200, kPage, "text/html; charset=utf-8"}; });
    int port = server.bind_any_port("127.0.0.1");
    CHECK(port > 0);
    if (port <= 0) return cardtest::finish("cardview");
    std::thread http([&] { server.listen_after_bind(); });
    for (int i = 0; i < 200 && !server.is_running(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(10));

    std::unique_ptr<cardview::View> view;
    try {
        view = std::make_unique<cardview::View>(cardview::Options{"Binder view test", 640, 480, false});
    } catch (const std::exception& e) {
        std::cout << "SKIP: could not open a window (" << e.what() << ")\n";
        server.stop();
        http.join();
        return 77;
    }

    std::string report;
    std::atomic<bool> reported{false};
    view->bind("report", [&](const std::string& args) {
        json a = json::parse(args, nullptr, false);
        if (a.is_array() && !a.empty() && a[0].is_string()) report = a[0].get<std::string>();
        reported = true;
        view->terminate();
        return std::string("null");
    });

    // Never hang the test run: close the window if the page never reports.
    std::atomic<bool> done{false};
    std::thread watchdog([&] {
        for (int i = 0; i < 300 && !done; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
        if (!done) view->terminate();
    });

    view->navigate("http://127.0.0.1:" + std::to_string(port) + "/");
    view->run();
    done = true;
    watchdog.join();
    server.stop();
    http.join();

    CHECK(reported.load());
    json r = json::parse(report, nullptr, false);
    CHECK(r.is_object());
    if (r.is_object()) {
        std::cout << "page reported: " << r.dump() << "\n";
        CHECK_EQ(r["title"], json("Binder view test"));
        CHECK_EQ(r["href"].get<std::string>().rfind("http://127.0.0.1:" + std::to_string(port), 0), static_cast<size_t>(0));
        CHECK_EQ(r["secure"], json(true));  // localhost counts as a secure context, which getUserMedia requires
        CHECK_EQ(r["hasGetUserMedia"], json(true));  // the camera API is available to the page
    }
    return cardtest::finish("cardview");
}
