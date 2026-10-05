# Binder for Android

A small native app (Kotlin) that shows the same frontend as the desktop app (`app/`: `index.html`, `css/`, `js/`) in a real
Android `WebView`, backed by the same C++ backend the desktop app runs — built by the NDK into `libbinder_native.so` and
loaded over JNI.

```
WebView  (getUserMedia() for the camera, like any browser)
   -> http://127.0.0.1:<port>   (the C++ HTTP server, started by NativeBackend.start)
   -> binder::App               (native/binder: store + recognition + routes — the desktop app's backend)
   -> cardscan / cardnet / cardvec / OpenCV / SQLite   (native/, linked statically; ONNX Runtime comes from its AAR)
```

## What's here

```
android/
├── settings.gradle.kts, build.gradle.kts, gradle.properties
└── app/
    ├── build.gradle.kts          ABIs, the NDK/CMake build of ../../native, the frontend Copy task, the ONNX Runtime AAR
    └── src/main/
        ├── AndroidManifest.xml   camera permission, network security config (localhost cleartext)
        ├── java/.../MainActivity.kt    WebView + camera-permission bridge + retry-on-cold-start
        ├── java/.../NativeBackend.kt   the JNI entry points: start(filesDir, frontendDir, port) / stop()
        └── res/                  minimal layout/theme/placeholder launcher icon
```

The native side is `native/binder_android` (`jni_bridge.cpp` and its CMake target); `native/CMakeLists.txt` is the CMake
project Gradle builds. The frontend isn't duplicated: `copyFrontendAssets` copies `app/index.html`, `css/` and `js/` into
`app/src/main/assets/frontend/` on every build, and `MainActivity` extracts them to the app's private storage so the C++
server can serve them.

## Building

1. Install the Android SDK (Android Studio, or the command-line tools) and JDK 17. The Android Gradle Plugin downloads
   the NDK and CMake 3.22 it needs.
2. `cd android && gradle assembleDebug` (or open `android/` in Android Studio). The first build compiles OpenCV for each
   ABI (`arm64-v8a` and `x86_64`), which takes a while; later builds reuse it.
3. `minSdk` is 24 (the NDK-side minimum for ONNX Runtime and `std::filesystem`); `compileSdk`/`targetSdk` are 34.

That gives an app that launches, shows the collection UI and lets you browse/add/edit cards. Scanning needs a catalog.

## The card catalog and models

They are not in the APK. Build the catalog on a desktop with `binder-catalog` (see [BUILDING.md](../BUILDING.md)) and put
`cards.sqlite3` and `card-vectors.cvi` — plus any exported `.onnx` models — in the app's private `files/data/` directory,
e.g. during development:

```
adb push cards.sqlite3 card-vectors.cvi /data/local/tmp/
adb shell run-as com.bindercardtracker.binder sh -c 'mkdir -p files/data && cp /data/local/tmp/cards.sqlite3 /data/local/tmp/card-vectors.cvi files/data/'
```

An in-app downloader doesn't exist. Without a catalog the scanner answers "the card catalog hasn't been built yet"; without
the models it skips the OCR / detector / art-matching stages it can't run.

## Camera permission

`AndroidManifest.xml` declares `android.permission.CAMERA` (not `required` at the `<uses-feature>` level, so the app still
installs on a camera-less device or emulator). `MainActivity.kt` requests the runtime permission on launch and only grants
the WebView's `getUserMedia()` request (via `WebChromeClient.onPermissionRequest`) if the OS-level permission was actually
granted, and then only for video.

## Not verified

The Android build is verified by CI compiling and packaging the APK — the native backend is the same code that the desktop
tests exercise, but nothing here has been run on a device or emulator yet.
