# Building Binder as a desktop app (Windows / macOS / Linux)

Binder is a Flask backend + `pywebview` window around the existing
HTML/CSS/JS frontend. `packaging/` turns that into a standalone,
double-click executable per OS using [PyInstaller](https://pyinstaller.org/).

## Project layout this assumes

```
.
├── index.html
├── css/styles.css
├── js/{api,app,collections,settings,ui}.js
├── backend/
│   ├── app.py
│   ├── scanner.py
│   ├── paths.py                 # dev vs. packaged path resolution
│   ├── build_scanner_models.py
│   ├── requirements.txt
│   └── data/                    # created by build_scanner_models.py (dev only)
└── packaging/
    ├── binder.spec              # PyInstaller spec
    ├── build.py                 # cross-platform build driver
    ├── build-windows.ps1
    ├── build-macos.sh
    ├── build-linux.sh
    ├── requirements-build.txt
    ├── icons/                   # optional icon.ico / icon.icns
    └── bundled_data/            # optional prebuilt card catalog
```

`packaging/build.py` checks this layout on every run and fails fast
with a clear message if something's missing, rather than letting
PyInstaller fail confusingly three steps later.

## Prerequisite: build the `cardvec` and `cardnet` native modules

Before installing `backend/requirements.txt`, build and install two
in-repo native modules that replaced what used to be five PyPI packages
(`faiss-cpu`, `ultralytics`, `torch`, `paddleocr`, `paddlepaddle`) — see
each one's own README for why: none of those five have a supported
Android/NDK build path, and these do.

```
pip install ./native/cardvec
pip install ./native/cardnet --config-settings=cmake.define.ONNXRUNTIME_ROOT_DIR=/path/to/onnxruntime-<platform>-<version>
```

`cardvec` needs just a C++17 compiler and CMake ≥ 3.18. `cardnet` also
needs an extracted [ONNX Runtime release](https://github.com/microsoft/onnxruntime/releases)
for your platform (see `native/cardnet/README.md`) — and, before you can
export the models it runs, the *original* frameworks
(torch/ultralytics/paddleocr) on whatever machine builds the catalog, per
`native/cardnet/export/`'s scripts; they're one-time dev-machine
dependencies, not part of `requirements.txt` or the packaged app.

Do this once per environment you build in — neither module is on PyPI.

## Quick start (per OS)

Run these **on** the OS you're targeting — PyInstaller does not
cross-compile. A build made on Windows only produces a Windows
executable, and so on.

```
# Windows (PowerShell)
.\packaging\build-windows.ps1

# macOS
./packaging/build-macos.sh

# Linux (see the GTK note below first)
./packaging/build-linux.sh
```

Each script installs `backend/requirements.txt` +
`packaging/requirements-build.txt`, then runs `packaging/build.py`,
which drives PyInstaller against `packaging/binder.spec`. Output:

- **Windows/Linux:** `dist/Binder/` (the app folder) and
  `dist/Binder-<os>.zip` (that folder, zipped — this is what you ship)
- **macOS:** `dist/Binder.app`

You can also just run `python packaging/build.py` yourself if you've
already installed both requirements files.

## Building all three automatically (CI)

`.github/workflows/build.yml` builds Windows, macOS, Linux, and an
Android debug APK in parallel on GitHub's own runners and uploads each
as a workflow artifact. Trigger it from the Actions tab
(`workflow_dispatch`) or by pushing a tag matching `v*`. This is the
easiest way to get all four platforms without owning that much
hardware.

## Why `onedir`, not a single `.exe`

The spec builds a folder (`dist/Binder/`), not PyInstaller's
"onefile" single binary. Onefile re-extracts the whole bundle to a
temp directory on *every launch* — with torch + paddleocr +
paddlepaddle in the bundle, that's a slow, disk-hungry startup every
single time. Onedir extracts once, at build time, and launches
instantly after that. Zip the folder to distribute it; that's normal
for apps this size (Blender, most Electron apps, etc. all ship this
way too).

## Where the app stores data once packaged

`backend/paths.py` is the piece that makes an installed app behave
differently from `python app.py` run out of the repo:

| | Dev (`python app.py`) | Packaged app |
|---|---|---|
| `db.json`, `logs/` | next to `backend/app.py` | OS per-user app-data dir (`platformdirs`) |
| card catalog (`data/`) | `backend/data/` | same per-user app-data dir, copied there from the bundle on first launch if you shipped one (see `packaging/bundled_data/README.md`) |
| `index.html`/`css/`/`js/` | read straight from the repo | read from the read-only bundle (`sys._MEIPASS`) |

This matters because an installed app's own folder is often read-only
(`Program Files` on Windows, a `.app` bundle on macOS) — writing
`db.json` there would fail outright, and PyInstaller onefile builds
extract to a temp dir that's wiped after every run, which would lose
your collections on exit. Nothing about this changes how you run the
app from source; it only kicks in when `sys.frozen` is set, i.e. once
it's actually packaged.

## The card catalog

> **If you have a catalog built before the Android work, rebuild it.**
> Three separate things about its on-disk format changed and none is
> migrated in place: the vector index went from FAISS (`.faiss`) to
> `cardvec` (`.cvi`), the DINOv2 art preprocessing moved into C++ (so
> previously-computed vectors are no longer comparable to new ones), and
> the catalog database went from DuckDB (`cards.duckdb`) to SQLite
> (`cards.sqlite3`). Delete `backend/data/` and re-run
> `build_scanner_models.py`.

`build_scanner_models.py` (network access to Scryfall/PokemonTCG/
YGOPRODeck, several minutes to hours) plus `native/cardnet/export/`'s
three model-export scripts (torch, ultralytics, paddleocr — one-time,
on a dev machine, see `native/cardnet/README.md`) are developer-only,
one-time steps — not something to ask an end user to run. For a
packaged build you choose one of:

1. **Ship without a catalog.** Scanning shows "the card catalog hasn't
   been built yet" until you either rebuild with option 2, or point
   the installed app's `BINDER_DATA_DIR` (an env var read by
   `scanner.py`) at a catalog folder built separately.
2. **Bundle a prebuilt catalog into the installer.** Copy
   `backend/data/{cards.sqlite3,card-vectors.cvi,yolo_card_detector.onnx,`
   `yolo_card_detector.names.json,dinov2_vits14.onnx,ocr_det.onnx,`
   `ocr_rec.onnx,ocr_dict.txt}` into `packaging/bundled_data/` before
   building. See that folder's README for the size trade-off — it's not
   small.

## Platform-specific notes

### Windows
Uses the WebView2 runtime, which ships with Windows 10/11 by default —
nothing extra to install. Unsigned `.exe` files trigger a Windows
SmartScreen warning ("Windows protected your PC") on first run; that's
expected without a paid code-signing certificate, not a build bug.

### macOS
`pywebview` needs `pyobjc`'s Cocoa/WebKit bindings — already in
`backend/requirements.txt` with a `sys_platform == "darwin"` marker,
so they only install on Mac.

The output is **unsigned and not notarized**. On the machine you built
it on it opens fine. Copied to another Mac, Gatekeeper will refuse a
plain double-click; right-click → Open → Open anyway gets past that
once. Real distribution to other people's Macs needs an Apple
Developer ID, `codesign`, and `notarytool` — out of scope here, but
straightforward to add to `packaging/build.py` if/when you have a
certificate.

`Info.plist` (set in `binder.spec`) includes
`NSCameraUsageDescription`, required for the webview's camera access
(used by the scan flow) to work at all on macOS — without it, macOS
silently denies the permission instead of prompting for it.

### Linux
`pywebview`'s GTK backend depends on a system WebKit package pip
cannot install for you:

```
sudo apt-get install -y python3-gi python3-gi-cairo gir1.2-gtk-3.0 \
    gir1.2-webkit2-4.1 libgirepository1.0-dev
```

(Older distros may only have `gir1.2-webkit2-4.0` — install whichever
exists.) `packaging/build-linux.sh` checks for this before building
and fails with the same instructions if it's missing, rather than
producing a build that crashes on launch.

There's no single "Linux executable" format the way `.exe`/`.app` are
— `dist/Binder-linux.zip` is a portable folder containing `Binder`
(the launcher binary) plus its bundled libraries; users extract it and
run `./Binder`. Packaging as a proper `.deb`/`.rpm`/Flatpak/AppImage is
a reasonable next step but isn't included here.

## Android

A real (if not fully polished) Android app lives at `android/` —
see `android/README.md` for the full picture. Summary of how each
desktop-only piece was replaced:

- **`pywebview`** (a desktop-only window shell; there's no Android
  build of it) → a native `WebView` inside a real Android app
  (`android/app/src/main/java/.../MainActivity.kt`), embedding the same
  Flask backend via [Chaquopy](https://chaquo.com/chaquopy/) (MIT
  licensed) instead of the desktop process pywebview would otherwise
  wrap. `android_main.py` is Android's equivalent of `app.py`'s
  `_run()`.
- **FAISS** → `native/cardvec`, a from-scratch C++ reimplementation of
  the one feature the app used (DINOv2 art-crop similarity search).
- **ultralytics / torch / paddleocr / paddlepaddle** → `native/cardnet`,
  the same trained YOLOv8/DINOv2/PaddleOCR models, each exported to ONNX
  once and run via ONNX Runtime (which has an official Android Mobile
  build), instead of via their original, Android-incompatible
  frameworks.

- **`duckdb`** → the standard library's `sqlite3`. DuckDB has no Android
  wheel and isn't in Chaquopy's package repository at any Python version.
  Nothing needed its analytical engine — every catalog query is a
  single-row lookup on an indexed column — so this is a simplification
  for the desktop build too, not only an Android workaround.
- **`rapidfuzz`** → the standard library's `difflib`, for the same
  availability reason. Unlike the others this one is *not* behaviour-
  preserving; see `android/README.md` and `scanner.FUZZY_MATCH_THRESHOLD`
  for what changed and why the threshold moved from 88 to 80.

`opencv-python` survives, but only at Python 3.10 — which is why
`android/app/build.gradle.kts` pins Chaquopy to `version = "3.10"`, and
why an Android build needs Python 3.10 on the build machine.

What's still genuinely unsolved: `cardvec`/`cardnet` need an actual
wheel cross-compiled against Chaquopy's bundled Python (both READMEs
describe the approach, neither has been executed — no Android SDK/NDK
was available to build or test any of the Android-side work), and
there's no catalog-delivery story for a device yet (desktop's
`packaging/bundled_data/` doesn't apply to an APK). Neither blocks the
app from launching and handling plain collection tracking — only
scanning needs them.

## Tests

```
python app/backend/tests/test_catalog_sqlite.py     # catalog: sqlite3 + fuzzy matching
```

No pytest, no network, no models, and it doesn't need `cardvec`/`cardnet`
installed — it builds a synthetic catalog in a temp directory and runs the
real `build_scanner_models.py` / `scanner.py` functions against it. Worth
running after any change to the catalog schema or the lookup queries.

The native modules have their own C++ tests; see `native/cardvec/tests/`
and `native/cardnet/tests/`. The ML pipeline itself (detection, OCR,
embedding) has no automated test — it needs real exported models and real
card photos.

## Known rough edges

- **Antivirus false positives.** PyInstaller-built executables
  (especially with big ML dependencies) commonly get flagged by
  Windows Defender/other AV as suspicious purely because of *how*
  PyInstaller bundles Python — this is a well-known false-positive
  pattern, not a sign anything's wrong with this build.
- **Build size.** ONNX Runtime is a fraction of the size of torch +
  paddlepaddle + paddleocr combined, so packaged builds are meaningfully
  smaller since switching to `cardnet` — expect the runtime itself to add
  tens of MB, not GB, on top of OpenCV. (DuckDB and RapidFuzz no longer
  factor in at all; both were replaced by standard-library modules.)
- **The C++ `loginserver/`** that `backend/app.py`'s `/api/auth/*`
  routes talk to over TCP is a separate build (see its own
  `loginserver/README.md`) and isn't part of `packaging/binder.spec`.
  Sign-in/registration will report "Login server unavailable" in a
  packaged build unless you build and run that alongside it — same as
  running from source without it started.