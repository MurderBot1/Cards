#include "cardview/view.hpp"

#include <map>
#include <mutex>
#include <stdexcept>

#include "webview/webview.h"

#if defined(__linux__) && !defined(__ANDROID__)
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#endif

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

namespace cardview {

namespace {

void check(webview_error_t err, const char* what) {
    if (err != WEBVIEW_ERROR_OK) throw std::runtime_error(std::string("cardview: ") + what + " failed (webview error " + std::to_string(err) + ")");
}

#if defined(__linux__) && !defined(__ANDROID__)
// Scanning needs the camera through getUserMedia. WebKitGTK ships with media streams off and denies every
// permission request unless the host app answers it, so turn them on and allow *camera* requests (not the
// microphone, nor anything else). WebView2 and WKWebView prompt the user themselves, so only GTK needs this.
gboolean on_permission_request(WebKitWebView*, WebKitPermissionRequest* request, gpointer) {
    if (WEBKIT_IS_USER_MEDIA_PERMISSION_REQUEST(request)) {
        auto* media = WEBKIT_USER_MEDIA_PERMISSION_REQUEST(request);
        if (webkit_user_media_permission_is_for_video_device(media) && !webkit_user_media_permission_is_for_audio_device(media)) {
            webkit_permission_request_allow(request);
            return TRUE;
        }
    }
    webkit_permission_request_deny(request);
    return TRUE;
}

void enable_camera(webview_t w) {
    auto* wk = static_cast<WebKitWebView*>(webview_get_native_handle(w, WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER));
    if (!wk || !WEBKIT_IS_WEB_VIEW(wk)) return;
    WebKitSettings* settings = webkit_web_view_get_settings(wk);
    webkit_settings_set_enable_media_stream(settings, TRUE);
    g_signal_connect(wk, "permission-request", G_CALLBACK(on_permission_request), nullptr);
}
#endif

#ifdef _WIN32
// webview's Windows window only gets the system's stock application icon, which is what the title bar (and Alt+Tab's
// small icon) showed, while the taskbar read the icon baked into the .exe (native/binder/packaging/binder.rc, named
// IDI_ICON1). So give the window the .exe's icon itself, a small one for the title bar and a big one for Alt+Tab and
// the taskbar, each at the size this window's screen asks for (the .ico holds 16 to 256 px).
void use_exe_icon(webview_t w) {
    auto* hwnd = static_cast<HWND>(webview_get_window(w));
    if (!hwnd) return;
    UINT dpi = 96;
    using GetDpiForWindowFn = UINT(WINAPI*)(HWND);
    using GetMetricsForDpiFn = int(WINAPI*)(int, UINT);
    GetMetricsForDpiFn metrics_for_dpi = nullptr;
    if (HMODULE user32 = GetModuleHandleW(L"user32.dll")) {
        if (auto get_dpi = reinterpret_cast<GetDpiForWindowFn>(reinterpret_cast<void*>(GetProcAddress(user32, "GetDpiForWindow"))))
            dpi = get_dpi(hwnd);
        metrics_for_dpi = reinterpret_cast<GetMetricsForDpiFn>(reinterpret_cast<void*>(GetProcAddress(user32, "GetSystemMetricsForDpi")));
    }
    auto metric = [&](int index) { return metrics_for_dpi ? metrics_for_dpi(index, dpi) : GetSystemMetrics(index); };
    HINSTANCE exe = GetModuleHandleW(nullptr);
    auto load = [&](int cx, int cy) {
        return static_cast<HICON>(LoadImageW(exe, L"IDI_ICON1", IMAGE_ICON, cx, cy, LR_DEFAULTCOLOR));
    };
    if (HICON small_icon = load(metric(SM_CXSMICON), metric(SM_CYSMICON)))
        SendMessageW(hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(small_icon));
    if (HICON big_icon = load(metric(SM_CXICON), metric(SM_CYICON)))
        SendMessageW(hwnd, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(big_icon));
}
#endif

}  // namespace

struct View::Impl {
    webview_t w = nullptr;
    std::mutex mu;
    // webview_bind keeps a raw pointer to our context for the lifetime of the binding, so these must outlive it.
    std::map<std::string, std::function<std::string(const std::string&)>> handlers;
};

View::View(const Options& options) : impl_(new Impl) {
    impl_->w = webview_create(options.debug ? 1 : 0, nullptr);
    if (!impl_->w) throw std::runtime_error("cardview: could not create the window (is there a display?)");
    check(webview_set_title(impl_->w, options.title.c_str()), "set_title");
    // webview 0.12.0's GTK backend returns WEBVIEW_ERROR_INVALID_ARGUMENT ("Invalid hint") from set_size even
    // though it resized the window (its success path falls through to the error return), so don't treat a
    // set_size failure as fatal.
    webview_set_size(impl_->w, options.width, options.height, WEBVIEW_HINT_NONE);
#if defined(__linux__) && !defined(__ANDROID__)
    enable_camera(impl_->w);
#endif
#ifdef _WIN32
    use_exe_icon(impl_->w);
#endif
}

View::~View() {
    if (impl_ && impl_->w) webview_destroy(impl_->w);
}

void View::set_title(const std::string& title) { check(webview_set_title(impl_->w, title.c_str()), "set_title"); }

void View::navigate(const std::string& url) { check(webview_navigate(impl_->w, url.c_str()), "navigate"); }

void View::eval(const std::string& js) { check(webview_eval(impl_->w, js.c_str()), "eval"); }

void View::bind(const std::string& name, std::function<std::string(const std::string&)> handler) {
    auto* slot = &(impl_->handlers[name] = std::move(handler));
    struct Ctx {
        View::Impl* impl;
        std::function<std::string(const std::string&)>* fn;
    };
    auto* ctx = new Ctx{impl_.get(), slot};  // intentionally lives as long as the view
    check(webview_bind(
              impl_->w, name.c_str(),
              [](const char* id, const char* req, void* arg) {
                  auto* c = static_cast<Ctx*>(arg);
                  std::string result;
                  int status = 0;
                  try {
                      result = (*c->fn)(req);
                  } catch (const std::exception& e) {
                      status = 1;
                      result = "\"" + std::string(e.what()) + "\"";
                  }
                  webview_return(c->impl->w, id, status, result.empty() ? "null" : result.c_str());
              },
              ctx),
          "bind");
}

void View::dispatch(std::function<void()> fn) {
    auto* boxed = new std::function<void()>(std::move(fn));
    check(webview_dispatch(
              impl_->w,
              [](webview_t, void* arg) {
                  std::unique_ptr<std::function<void()>> f(static_cast<std::function<void()>*>(arg));
                  (*f)();
              },
              boxed),
          "dispatch");
}

void View::run() { check(webview_run(impl_->w), "run"); }

void View::terminate() { webview_terminate(impl_->w); }

}  // namespace cardview
