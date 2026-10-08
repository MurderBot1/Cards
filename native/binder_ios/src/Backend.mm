#include "Backend.hpp"

#import <Foundation/Foundation.h>

#include <memory>
#include <mutex>
#include <thread>

#include "app.hpp"
#include "carddownload/download.hpp"
#include "cardpaths/cardpaths.hpp"

#include "UrlSessionTransport.hpp"

namespace binder_ios {

namespace {

std::mutex g_mu;
std::unique_ptr<binder::App> g_app;
std::thread g_server;
int g_port = -1;

std::filesystem::path user_data_dir() {
    NSURL* support = [[NSFileManager defaultManager] URLForDirectory:NSApplicationSupportDirectory
                                                            inDomain:NSUserDomainMask
                                                   appropriateForURL:nil
                                                              create:YES
                                                               error:nil];
    return std::filesystem::path(support.path.UTF8String) / "Binder";
}

std::filesystem::path frontend_dir() {
    return std::filesystem::path(NSBundle.mainBundle.bundlePath.UTF8String) / "frontend";
}

// The catalog and models are large and can be downloaded again, so keep them out of iCloud/iTunes backups.
void exclude_from_backup(const std::filesystem::path& dir) {
    std::error_code ec;
    std::filesystem::create_directories(dir, ec);
    NSURL* url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:dir.c_str()] isDirectory:YES];
    [url setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
}

void log_line(const std::string& message) { NSLog(@"[Binder] %s", message.c_str()); }

}  // namespace

bool catalog_missing() {
    return !carddownload::missing_files(user_data_dir() / "data").empty();
}

int start_backend(bool download_now) {
    std::lock_guard<std::mutex> lock(g_mu);
    if (g_app) return g_port;
    try {
        cardpaths::Options options;
        options.user_data_dir = user_data_dir();
        options.frontend_dir = frontend_dir();
        cardpaths::Environment environment = cardpaths::system_environment();

        binder::AppOptions app_options;
        app_options.paths = cardpaths::resolve(environment, options);
        app_options.log = log_line;
        // The catalog isn't in the app: fetch it on first launch through NSURLSession (there is no libcurl on iOS).
        app_options.download_missing_data = download_now;
        app_options.make_transport = [] { return std::make_unique<UrlSessionTransport>(); };
        auto app = std::make_unique<binder::App>(std::move(app_options));
        exclude_from_backup(user_data_dir());

        int bound = app->bind_any_port("127.0.0.1");
        if (bound <= 0) {
            log_line("could not listen on 127.0.0.1");
            return -1;
        }
        g_app = std::move(app);
        g_port = bound;
        g_server = std::thread([] { g_app->serve(); });
        if (!download_now) g_app->announce_pending_download("Waiting for Wi-Fi to download assets");
        g_app->warm_up_in_background();
        log_line("backend serving on 127.0.0.1:" + std::to_string(g_port));
        return g_port;
    } catch (const std::exception& e) {
        log_line(std::string("backend failed to start: ") + e.what());
        g_app.reset();
        return -1;
    }
}

void start_download() {
    std::lock_guard<std::mutex> lock(g_mu);
    if (g_app) g_app->download_when_ready();
}

}  // namespace binder_ios
