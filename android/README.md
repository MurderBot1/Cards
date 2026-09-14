# Binder for Android

Android's answer to `pywebview`: a small native app (Kotlin) that embeds
the exact same Python backend the desktop build runs — via
[Chaquopy](https://chaquo.com/chaquopy/) (MIT-licensed, free to use,
no commercial license needed) — and shows the existing frontend
(`index.html`/`css`/`js`) in a real Android `WebView` instead of a
desktop window shell. `pywebview` itself has no Android build; this is
what replaces its role there.

```
frame -> WebView (getUserMedia() for camera capture, same as any browser)
       -> http://127.0.0.1:5000 (Flask, running on Chaquopy's embedded CPython)
       -> app.py / scanner.py / paths.py (same source as the desktop build)
       -> cardvec / cardnet (this repo's Android-buildable native modules)
```

## What's here

```
android/
├── settings.gradle.kts, build.gradle.kts, gradle.properties
└── app/
    ├── build.gradle.kts          Chaquopy config, ABIs, Copy tasks (see below)
    └── src/main/
        ├── AndroidManifest.xml   camera permission, PyApplication, network security config
        ├── java/.../MainActivity.kt   WebView + camera-permission bridge + retry-on-cold-start
        ├── python/android_main.py     Android's entry point (replaces app.py's _run())
        └── res/                  minimal layout/theme/placeholder launcher icon
```

`app.py`, `scanner.py`, and `paths.py` are **not** duplicated here —
`app/build.gradle.kts`'s `copyPythonBackend` Gradle task copies them
from `app/backend/` on every build, so Android always runs the same
backend source as the desktop app, not a fork of it. Same for the
frontend: `copyFrontendAssets` pulls `index.html`/`css`/`js` from the
repo root into `app/src/main/assets/frontend/`. `paths.py` gained a
third mode (`ANDROID`, alongside its existing `DEV`/`FROZEN`) that
reads two paths from environment variables `android_main.py` sets —
see its own docstring for the full three-way explanation.

## Building

1. Install Android Studio (or just the command-line SDK tools) — this
   pulls in the Android SDK/build tools. Chaquopy does **not** need the
   NDK installed separately; its own native libraries ship precompiled.
2. Open `android/` as a project (or `cd android && ./gradlew assembleDebug`
   once you've generated the Gradle wrapper: `gradle wrapper` from
   inside `android/`, using any Gradle 8.x install, if you don't have
   Android Studio generate one for you on first open).
3. `minSdk` is 24; `compileSdk`/`targetSdk` are 34 — bump the versions
   in `build.gradle.kts`/`app/build.gradle.kts` to match whatever your
   installed AGP/Kotlin plugin versions actually support if Gradle
   complains about a mismatch (normal Android-tooling churn, not
   specific to this project).

That gets you an app that **launches, shows the collection UI, and lets
you browse/add/edit cards** — `db.json` works immediately, since Flask +
platformdirs-free JSON storage has no native-library gap on Android.
Scanning needs the rest of this document.

## What's not solved yet

Being upfront about the real remaining gaps, in order of how much work
each is:

1. **`cardvec`/`cardnet` need an Android wheel**, cross-compiled against
   Chaquopy's own bundled Python-for-Android rather than a system
   Python — see each module's own README ("Option B"). The practical
   path: build once with `-DCARDNET_BUILD_PYTHON=OFF`/`CARDVEC_BUILD_PYTHON=OFF`
   using the NDK toolchain file (no Chaquopy Python needed for that
   half), then separately locate Chaquopy's extracted Python-for-Android
   build (under Gradle's build/cache output after a sync — its exact
   path isn't stable across Chaquopy versions, so inspect your own
   `android/app/build/` after a sync rather than trusting a hardcoded
   path here) to point `-DPython3_INCLUDE_DIR`/`-DPython3_LIBRARY` at
   for the Python-module half, then package the result as a wheel
   (`pip wheel .` against that same cross Python) and reference it from
   `chaquopy { defaultConfig { pip { install("libs/....whl") } } }`.
   This is the one remaining hard blocker for scanning.

2. **Delivering the card catalog to a device.** Desktop has
   `packaging/bundled_data/` (baked into the installer at build time).
   Android has no equivalent yet — `cards.sqlite3`, `card-vectors.cvi`,
   and the four `cardnet` `.onnx` files (all normally under
   `app/backend/data/`, all gitignored) need to reach the device some
   other way: `adb push` them to `BINDER_ANDROID_FILES_DIR/data` for
   development, or build a real in-app downloader for a released app.
   Neither is implemented here.

### Third-party packages, and the two that were removed

Chaquopy installs pure-Python packages from PyPI, but native ones only
from [its own package repository](https://chaquo.com/pypi-13.1/). What
that repository actually carries decided two things:

| package | status |
|---|---|
| `flask`, `platformdirs` | pure Python — install from PyPI normally |
| `numpy` | in Chaquopy's repository, Python 3.10–3.13 |
| `opencv-python` | in Chaquopy's repository, but newest is **4.5.1.48, cp310 max** |
| `duckdb` | **absent at every Python version** |
| `rapidfuzz` | **absent at every Python version** |

So `app/build.gradle.kts` pins `version = "3.10"`: cp310 is the only
Python where numpy and opencv both resolve, and `scanner.py` imports
`cv2` at module scope. (Every OpenCV call the app makes — `Canny`,
`findContours`, `approxPolyDP`, `getPerspectiveTransform`,
`warpPerspective`, `Laplacian`, and friends — predates 4.5 and is
unchanged since, including `findContours`' 4.x two-value return, so the
old version costs nothing here.) Note this means the *build machine*
also needs Python 3.10 on PATH, since Chaquopy requires a host Python
matching the app's.

`duckdb` and `rapidfuzz` had no such escape hatch, so they were removed
from the app outright rather than worked around:

- the card catalog is now **stdlib `sqlite3`** (`build_scanner_models.get_db()`),
  which loses nothing — every query `scanner.py` issues is a single-row
  lookup on an indexed column, not the analytical work DuckDB exists for.
  This also drops a dependency from the desktop build.
- fuzzy title matching is now **stdlib `difflib`**
  (`scanner._title_candidates()`). This one is a real fidelity change,
  not a free swap: `rapidfuzz.fuzz.WRatio` returned the maximum of four
  sub-scorers, so `difflib`'s single ratio is stricter at the same
  number and `FUZZY_MATCH_THRESHOLD` was loosened from 88 to 80 to
  partly compensate. It hasn't been re-tuned against real scans; erring
  high just routes more scans to the art-vector fallback, which
  generally resolves them anyway.

None of this blocks the app from launching and being useful for
collection tracking today — `scanner.py`'s every ML/DB call is already
gated behind a file-existence check with graceful fallback (see
`scanner.is_ready()` and each `_get_*()` singleton), the same design
that lets a desktop build run before `build_scanner_models.py` has ever
been run. Scanning specifically just won't do anything until the three
items above are addressed.

## Camera permission

`AndroidManifest.xml` declares `android.permission.CAMERA` (not
`required` at the `<uses-feature>` level, so the app still installs on
a camera-less device/emulator). `MainActivity.kt` requests the runtime
permission on launch and only grants the WebView's `getUserMedia()`
request (via `WebChromeClient.onPermissionRequest`) if the OS-level
permission was actually granted — mirroring what a desktop browser's
own camera-permission prompt does, and what macOS's `NSCameraUsageDescription`
does for the PyWebView build (see `app/BUILD.md`).

## Why a native WebView instead of trying to run pywebview itself

`pywebview`'s various backends (WebView2 on Windows, Cocoa+WebKit on
macOS, GTK+WebKit on Linux) are each a thin Python wrapper around an
OS-native webview API that only exists on that OS. There's no fourth
backend for Android because the equivalent native API
(`android.webkit.WebView`) isn't reachable from pure Python at all — it
needs a real Android app (a `Context`, an `Activity`, a view hierarchy)
around it, which is exactly what `MainActivity.kt` is. This is a
different *kind* of fix than `cardvec`/`cardnet`: those replaced a
Python library with another Python library (same call sites, different
implementation underneath); this replaces the whole outer shell.
