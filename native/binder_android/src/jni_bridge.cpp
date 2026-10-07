// JNI entry points for com.bindercardtracker.binder.NativeBackend.
#include <android/log.h>
#include <jni.h>

#include <filesystem>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "app.hpp"
#include "cardfetch/fetch.hpp"
#include "cardpaths/cardpaths.hpp"

namespace {

constexpr const char* kTag = "Binder";

std::string to_string(JNIEnv* env, jstring s) {
    if (!s) return {};
    const char* chars = env->GetStringUTFChars(s, nullptr);
    std::string out = chars ? chars : "";
    if (chars) env->ReleaseStringUTFChars(s, chars);
    return out;
}

// A cardfetch::Transport that downloads through com.bindercardtracker.binder.Downloader (HttpURLConnection), since the
// NDK has no libcurl. Used from the backend's background threads, which attach themselves to the JVM per call.
JavaVM* g_vm = nullptr;
jclass g_downloader = nullptr;  // global ref
jmethodID g_download = nullptr;

class JvmTransport : public cardfetch::Transport {
public:
    cardfetch::Response get(const std::string&, int) override {
        throw cardfetch::Error("JvmTransport only supports downloads to a file");
    }

    long get_to_file(const std::string& url, int timeout_seconds, const std::filesystem::path& dest) override {
        if (!g_vm || !g_downloader) throw cardfetch::Error("the JVM downloader isn't available");
        JNIEnv* env = nullptr;
        bool attached = false;
        if (g_vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) {
            if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) throw cardfetch::Error("could not attach to the JVM");
            attached = true;
        }
        jstring jurl = env->NewStringUTF(url.c_str());
        jstring jdest = env->NewStringUTF(dest.u8string().c_str());
        jint status = env->CallStaticIntMethod(g_downloader, g_download, jurl, jdest, static_cast<jint>(timeout_seconds));
        std::string failure;
        if (env->ExceptionCheck()) {
            jthrowable ex = env->ExceptionOccurred();
            env->ExceptionClear();
            failure = "request to " + url + " failed";
            if (jclass cls = env->GetObjectClass(ex)) {
                if (jmethodID to_string_id = env->GetMethodID(cls, "toString", "()Ljava/lang/String;")) {
                    if (auto text = static_cast<jstring>(env->CallObjectMethod(ex, to_string_id))) {
                        failure += ": " + to_string(env, text);
                        env->DeleteLocalRef(text);
                    }
                }
                env->ExceptionClear();
                env->DeleteLocalRef(cls);
            }
            env->DeleteLocalRef(ex);
        }
        env->DeleteLocalRef(jurl);
        env->DeleteLocalRef(jdest);
        if (attached) g_vm->DetachCurrentThread();
        if (!failure.empty()) throw cardfetch::Error(failure);
        return status;
    }
};

std::mutex g_mu;
std::unique_ptr<binder::App> g_app;
std::thread g_server;
int g_port = -1;

void log_info(const std::string& message) { __android_log_print(ANDROID_LOG_INFO, kTag, "%s", message.c_str()); }
void log_error(const std::string& message) { __android_log_print(ANDROID_LOG_ERROR, kTag, "%s", message.c_str()); }

}  // namespace

extern "C" {

// Starts the backend (once; later calls return the port it's already on). `port` <= 0 picks a free one.
// Returns the port it's serving on, or -1 on failure (the reason is in logcat under the tag "Binder").
JNIEXPORT jint JNICALL Java_com_bindercardtracker_binder_NativeBackend_start(JNIEnv* env, jclass, jstring files_dir,
                                                                          jstring frontend_dir, jint port) {
    std::lock_guard<std::mutex> lock(g_mu);
    if (g_app) return g_port;
    try {
        // Android can't discover either location on its own: the Kotlin side passes Context.filesDir (db.json,
        // logs/, the catalog under data/) and the directory it extracted the frontend assets to.
        cardpaths::Options options;
        options.user_data_dir = std::filesystem::u8path(to_string(env, files_dir));
        options.frontend_dir = std::filesystem::u8path(to_string(env, frontend_dir));
        cardpaths::Environment environment = cardpaths::system_environment();
        environment.os = "android";

        binder::AppOptions app_options;
        app_options.paths = cardpaths::resolve(environment, options);
        app_options.log = log_info;
        // The catalog isn't in the APK: fetch it on first launch through the JVM (see Downloader.kt).
        app_options.download_missing_data = true;
        app_options.make_transport = [] { return std::make_unique<JvmTransport>(); };
        if (!g_downloader && env->GetJavaVM(&g_vm) == JNI_OK) {
            jclass local = env->FindClass("com/bindercardtracker/binder/Downloader");
            if (local) {
                g_downloader = static_cast<jclass>(env->NewGlobalRef(local));
                g_download = env->GetStaticMethodID(g_downloader, "download", "(Ljava/lang/String;Ljava/lang/String;I)I");
                env->DeleteLocalRef(local);
            }
            if (env->ExceptionCheck()) env->ExceptionClear();
            if (!g_download) log_error("Downloader class not found; the card catalog can't be downloaded");
        }
        auto app = std::make_unique<binder::App>(std::move(app_options));

        int bound = port > 0 ? (app->bind("127.0.0.1", port) ? port : -1) : app->bind_any_port("127.0.0.1");
        if (bound <= 0) {
            log_error("could not listen on 127.0.0.1:" + std::to_string(port));
            return -1;
        }
        g_app = std::move(app);
        g_port = bound;
        g_server = std::thread([] { g_app->serve(); });
        g_app->warm_up_in_background();
        log_info("backend serving on 127.0.0.1:" + std::to_string(g_port));
        return g_port;
    } catch (const std::exception& e) {
        log_error(std::string("backend failed to start: ") + e.what());
        g_app.reset();
        return -1;
    }
}

JNIEXPORT void JNICALL Java_com_bindercardtracker_binder_NativeBackend_stop(JNIEnv*, jclass) {
    std::lock_guard<std::mutex> lock(g_mu);
    if (!g_app) return;
    g_app->stop();
    if (g_server.joinable()) g_server.join();
    g_app.reset();
    g_port = -1;
}

}  // extern "C"
