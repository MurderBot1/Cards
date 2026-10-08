#include "open_url.hpp"

#include <cctype>
#include <cstring>

#if defined(_WIN32)
#include <windows.h>
#include <shellapi.h>
#elif !defined(__ANDROID__)
#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>

#include <thread>
#endif

namespace binder {

namespace {
constexpr const char* kReleasePrefix = "https://github.com/MurderBot1/Cards/releases/";
constexpr size_t kMaxUrl = 400;
}  // namespace

bool is_release_url(const std::string& url) {
    if (url.size() > kMaxUrl || url.rfind(kReleasePrefix, 0) != 0) return false;
    for (unsigned char c : url) {
        // the characters of an ordinary URL; no spaces, quotes, backticks, angle brackets, backslashes or control characters
        if (c == 0 || !(std::isalnum(c) || std::strchr("-._~:/?#[]@!$&()*+,;=%", c))) return false;
    }
    return true;
}

bool open_release_url(const std::string& url) {
    if (!is_release_url(url)) return false;
#if defined(_WIN32)
    return reinterpret_cast<INT_PTR>(ShellExecuteA(nullptr, "open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL)) > 32;
#elif defined(__ANDROID__)
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
