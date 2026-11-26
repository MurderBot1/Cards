#include "open_url.hpp"

#include <cctype>
#include <cstring>

#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif

#if defined(_WIN32)
#include <windows.h>
#include <shellapi.h>
#elif defined(__ANDROID__) || (defined(__APPLE__) && TARGET_OS_IPHONE)
// nothing to include: the Android WebView and the iOS app open downloads through their own bridges
#else
#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>

#include <thread>
#endif

namespace binder {

namespace {
constexpr const char* kReleasePrefix = "https://github.com/MurderBot1/Cards/releases/";
// Pages of the shop that may be opened in the system browser: Stripe's seller sign-up and payment pages, PayPal's payment page,
// Shippo's shipping labels, and the big carriers' tracking pages.
constexpr const char* kShopPrefixes[] = {
    "https://connect.stripe.com/",
    "https://checkout.stripe.com/",
    "https://www.paypal.com/",
    "https://www.sandbox.paypal.com/",
    "https://shippo-delivery-east.s3.amazonaws.com/",
    "https://shippo-delivery-west.s3.amazonaws.com/",
    "https://tools.usps.com/",
    "https://www.ups.com/",
    "https://www.fedex.com/",
    "https://www.dhl.com/",
};
constexpr size_t kMaxUrl = 400;

bool plain_url_chars(const std::string& url) {
    for (unsigned char c : url) {
        // the characters of an ordinary URL; no spaces, quotes, backticks, angle brackets, backslashes or control characters
        if (c == 0 || !(std::isalnum(c) || std::strchr("-._~:/?#[]@!$&()*+,;=%", c))) return false;
    }
    return true;
}
}  // namespace

bool is_release_url(const std::string& url) {
    return url.size() <= kMaxUrl && url.rfind(kReleasePrefix, 0) == 0 && plain_url_chars(url);
}

bool is_openable_url(const std::string& url) {
    if (is_release_url(url)) return true;
    if (url.size() > kMaxUrl || !plain_url_chars(url)) return false;
    for (const char* prefix : kShopPrefixes) {
        if (url.rfind(prefix, 0) == 0) return true;
    }
    return false;
}

bool open_release_url(const std::string& url) {
    if (!is_openable_url(url)) return false;
#if defined(_WIN32)
    return reinterpret_cast<INT_PTR>(ShellExecuteA(nullptr, "open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL)) > 32;
#elif defined(__ANDROID__) || (defined(__APPLE__) && TARGET_OS_IPHONE)
    return false;
#else
#if defined(__APPLE__)
    const char* opener = "open";
#else
    const char* opener = "xdg-open";
#endif
    pid_t pid = fork();
    if (pid < 0) return false;
    if (pid == 0) {
        int null = open("/dev/null", O_RDWR);
        if (null >= 0) {
            dup2(null, 0);
            dup2(null, 1);
            dup2(null, 2);
        }
        execlp(opener, opener, url.c_str(), static_cast<char*>(nullptr));
        _exit(127);
    }
    std::thread([pid] {  // reap it when it exits; the browser itself keeps running
        int status = 0;
        waitpid(pid, &status, 0);
    }).detach();
    return true;
#endif
}

}  // namespace binder
