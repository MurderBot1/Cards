# Building, running and shipping Binder

Binder is a C++ app. The backend (card store, recognition, HTTP server) and the desktop shell are C++ built with CMake
from `native/`; the UI is the HTML/CSS/JS in `app/`, shown in the system web view (WebKitGTK on Linux, WKWebView on
macOS, WebView2 on Windows) or, on Android, a native `WebView`. There is no Python in the app, its build or its tests;
the only Python left is three offline model-conversion scripts (see [Models](#models)).

```
app/        the frontend (index.html, css/, js/)
native/     the C++ modules and the app — see native/README.md for the module map
android/    the Android app (Kotlin + the NDK build of native/)
```

## Prerequisites

| | Linux | macOS | Windows |
|---|---|---|---|
| Compiler | GCC ≥ 9 or Clang | Xcode command-line tools | Visual Studio 2019/2022 or Build Tools, with the "Desktop development with C++" workload |
| CMake | ≥ 3.18 | ≥ 3.18 | ≥ 3.18 |
| Window | `libgtk-3-dev libwebkit2gtk-4.1-dev` | built in | WebView2 runtime (ships with Windows 10/11) |
| Catalog tool | `libcurl4-openssl-dev zlib1g-dev` | built in | downloaded and built for you |
| Tests | `xvfb` for the window test | | |

Everything else is downloaded and, where needed, built at configure time, pinned in `native/cmake/Deps.cmake`:
nlohmann/json, cpp-httplib, webview, OpenCV (`core`, `imgproc`, `imgcodecs` only), SQLite, and a prebuilt ONNX Runtime
for your platform. OpenCV and SQLite are taken from the system when it has them, unless `-DBINDER_STATIC_DEPS=ON`
(what release builds use). The first OpenCV build takes several minutes; CI caches it.

## Build, test, run

```
cmake -S native -B build/native -DCMAKE_BUILD_TYPE=Release
cmake --build build/native --parallel
ctest --test-dir build/native --output-on-failure        # on Linux: xvfb-run -a ctest ...   (the window test needs a display)

build/native/bin/binder                                   # opens the window
build/native/bin/binder --headless                        # no window: serve the whole LAN on port 5000
```

(Executables land in `<build>/bin/`, or `<build>/bin/Release/` with the Visual Studio generator. `RunApp.bat` does all of
this on Windows.)

`RunApp.bat` uses Visual Studio when it finds it and falls back to GCC (MinGW-w64 with Ninja or `mingw32-make` on PATH)
otherwise; with GCC the executables land in `build\native\bin\`. The GCC path is untested in CI.

`binder` options: `--headless`, `--port N` (default: any free port in window mode, 5000 with `--headless`),
`--data-dir DIR`, `--frontend-dir DIR`. `--headless` exposes the API to your whole network — only use it on networks you
trust.

### Build options

| Option | Default | |
|---|---|---|
| `BINDER_BUILD_TESTS` | ON | build every module's tests |
| `BINDER_WITH_VIEW` | ON | the native window (`cardview`); OFF gives a binary that just serves |
| `BINDER_WITH_ONNX` | ON | the detector / OCR / embedder (downloads ONNX Runtime); OFF skips those pipeline stages |
| `BINDER_WITH_CATALOG_TOOL` | ON | `binder-catalog`; skipped automatically if libcurl or zlib isn't found |
| `BINDER_STATIC_DEPS` | OFF | build OpenCV and SQLite from source and link them statically |
| `BINDER_FORCE_FETCH_OPENCV` | OFF | build OpenCV from source even if the system has one |

## Where things live at run time

Everything the app *writes* is in the per-user data directory (the install folder can be read-only):

| | |
|---|---|
| Windows | `%APPDATA%\BinderCardTracker\Binder` |
| macOS | `~/Library/Application Support/Binder` |
| Linux | `$XDG_DATA_HOME/Binder` (default `~/.local/share/Binder`) |

containing `db.json` (collections and settings), `logs/` (`api.log`, `startup.log`) and `data/` (the card catalog and
models, below). `--data-dir` or `BINDER_USER_DATA_DIR` overrides it. The frontend is found next to the executable
(`frontend/`, or `Resources/frontend` in a macOS `.app`), or in `app/` of a checkout.

## The card catalog

Scanning needs a catalog and a vector index, built once by `binder-catalog` (a port of the old
`build_scanner_models.py`). It downloads card data from Scryfall (MTG, every printing incl. other languages),
PokemonTCG and YGOPRODeck, downloads each card's image, embeds it with DINOv2 and builds the index:

```
build/native/bin/binder-catalog                  # everything, into the app's data directory
build/native/bin/binder-catalog --only pokemon   # one game
build/native/bin/binder-catalog --skip-vectors   # data and images only
build/native/bin/binder-catalog --help
```

On Windows the executable is `build\native\bin\Release\binder-catalog.exe` (Visual Studio puts the build type in the path).

It is safe to re-run: bulk downloads are cached under `data/cache/`, images and vectors already done are skipped, and an
interrupted run resumes (the index is written before the catalog records rows that point into it, so a crash never leaves
dangling references). The images are a scratch copy, deleted once the vectors exist (`--keep-images` to keep them).

On Windows the build downloads and compiles its own zlib and libcurl (libcurl using the Windows TLS stack), so nothing extra
is needed there. The files it writes are portable, so you can also build the catalog on
Linux or macOS and copy `cards.sqlite3` and `card-vectors.cvi` into the data directory of any install, or into
`native/binder/packaging/bundled_data/` to ship them with the app.

### Models

The recognizer uses three trained models as ONNX files in the same `data/` directory: `yolo_card_detector.onnx`
(+ `.names.json`), `ocr_det.onnx` / `ocr_rec.onnx` / `ocr_dict.txt`, and `dinov2_vits14.onnx` (also what `binder-catalog`
embeds with). **None is required**: without a detector the card is found by contour detection, without OCR it falls back
to art matching, without the embedder there is no art matching. Producing them means converting trained PyTorch /
Ultralytics / PaddleOCR models, which needs those frameworks — `native/cardnet/export/*.py` are the only Python in the
repo, one-off developer tooling. Training the YOLO card detector needs a labelled photo dataset that doesn't exist to
download; see `native/cardnet/export/export_yolo.py`.

## Packaging

`cmake --install build/native --component binder --prefix dist` lays out the app as it is shipped (the component keeps
the downloaded dependencies' own install rules out of it), and CI zips it:

| | Layout |
|---|---|
| Windows `Binder-windows.zip` | `Binder/binder.exe`, `frontend/`, `onnxruntime.dll`, the MSVC runtime |
| macOS `Binder-macos-arm64.zip` | `Binder.app` (`Info.plist` with the camera usage string, icon, `Frameworks/libonnxruntime.dylib`) |
| Linux `Binder-linux.zip` | `Binder/binder`, `frontend/`, `libonnxruntime.so*` (found through `$ORIGIN`) |

- **macOS:** the runners are arm64, so the app only runs on Apple Silicon, and it is **unsigned and un-notarized**.
  Gatekeeper refuses it on first launch: right-click → Open, or `xattr -dr com.apple.quarantine Binder.app`. Shipping to
  other people means signing with a Developer ID and notarizing it, which needs an Apple developer account.
- **Linux:** running it needs GTK 3 and WebKitGTK 4.1 (`libwebkit2gtk-4.1-0` on Debian/Ubuntu). It is built on Ubuntu 22.04
  so its glibc requirement stays low.
- **Windows:** the web view is the Microsoft Edge WebView2 runtime, present on Windows 10/11. Windows ships its own, older
  `onnxruntime.dll` in `System32`; the app and the tests use the copy next to the executable.
- The window's camera: Windows and macOS ask the user. WebKitGTK denies camera access unless the app allows it, so
  `cardview` allows *video-only* requests on Linux.

The Windows, macOS and Linux zips also ship the DINOv2 and OCR models. A `Models` CI job converts them with the scripts in
`native/cardnet/export/` (the one job that uses Python) and the desktop jobs drop them into
`native/binder/packaging/bundled_data/` before configuring, so `cmake --install` puts them in the app's `data/`; the app
copies that into the user data directory on first launch (only if it's empty, so an existing install keeps what it has).
The card detector and the card catalog (`cards.sqlite3`, `card-vectors.cvi`) are not bundled, but the desktop app
downloads the catalog on first launch: whichever of the two files is missing from the data directory is fetched in the
background from the [`Assets` release](https://github.com/MurderBot1/Cards/releases/tag/Assets) (about 1.2 GB; files
already there are never replaced, and a `.part` file is only renamed once complete, so an interrupted download retries on
the next launch). While it runs the app shows a "Setting up the app for you" screen with the current task (`GET /api/setup`; other
first-run work can report itself through `binder::SetupStatus`). Pass `--no-download` to skip the download. It needs the build to have libcurl (the same requirement as
`binder-catalog`); to publish a newer catalog, replace the two assets on that release. The Android APK doesn't
bundle any models.

The CI (`.github/workflows/build.yml`) runs the whole test suite first, then builds, tests, packages and uploads each
platform. A push to `main` also publishes the results to a GitHub release (see below).

## Android

`android/` is a small Kotlin app: a `WebView` plus `libbinder_native.so`, the same backend built by the NDK through CMake
(`native/binder_android`), loaded over JNI by `NativeBackend.kt`. ONNX Runtime comes from its official AAR.

```
cd android && gradle assembleDebug        # or open android/ in Android Studio
```

Needs the Android SDK (AGP downloads the NDK and CMake 3.22 it asks for), JDK 17, and builds `arm64-v8a` and `x86_64`. The
first build compiles OpenCV for each ABI, which is slow. The catalog and models are not bundled in the APK; the app
downloads the catalog on first launch (like the desktop one), or you can put
`cards.sqlite3`, `card-vectors.cvi` (and any `.onnx` files) in the app's private `files/data/` directory, e.g. for
development `adb push` them and copy with `run-as com.bindercardtracker.binder`. (Models are still not downloaded.)

## Login server

Accounts are handled by a small service on Cloudflare Pages (free tier) in [`cloudflare/`](cloudflare/README.md): sign-up
takes a username, email and password, and sign-in returns a session token the app keeps. The app calls it directly over
HTTPS; set its address as `AUTH_URL` in `app/js/config.js` (setup steps are in `cloudflare/README.md`). Until that is set,
the Sign in screen says accounts aren't set up yet and the rest of the app works as before.

The older `/api/auth/*` routes in the local backend, which spoke to a separate TCP LoginServer, are no longer used by the
app.
