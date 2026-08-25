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

`.github/workflows/build-desktop.yml` builds Windows, macOS, and Linux
in parallel on GitHub's own runners and uploads each as a workflow
artifact. Trigger it from the Actions tab (`workflow_dispatch`) or by
pushing a tag matching `v*`. This is the easiest way to get all three
platforms without owning three machines.

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

`build_scanner_models.py` (torch, ultralytics, network access to
Scryfall/PokemonTCG/YGOPRODeck, several minutes to hours) is a
developer-only, one-time step — it's not something to ask an end user
to run. For a packaged build you choose one of:

1. **Ship without a catalog.** Scanning shows "the card catalog hasn't
   been built yet" until you either rebuild with option 2, or point
   the installed app's `BINDER_DATA_DIR` (an env var read by
   `scanner.py`) at a catalog folder built separately.
2. **Bundle a prebuilt catalog into the installer.** Copy
   `backend/data/{cards.duckdb,card-vectors.faiss,yolo_card_detector.pt}`
   into `packaging/bundled_data/` before building. See that folder's
   README for the size trade-off — it's not small.

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

## Known rough edges

- **Antivirus false positives.** PyInstaller-built executables
  (especially with big ML dependencies) commonly get flagged by
  Windows Defender/other AV as suspicious purely because of *how*
  PyInstaller bundles Python — this is a well-known false-positive
  pattern, not a sign anything's wrong with this build.
- **Build size.** Expect roughly 1–2GB+ per platform even before
  bundling a card catalog, almost entirely from torch + paddlepaddle +
  paddleocr. There isn't a way to trim that meaningfully without
  dropping one of those dependencies.
- **The C++ `loginserver/`** that `backend/app.py`'s `/api/auth/*`
  routes talk to over TCP is a separate build (see its own
  `loginserver/README.md`) and isn't part of `packaging/binder.spec`.
  Sign-in/registration will report "Login server unavailable" in a
  packaged build unless you build and run that alongside it — same as
  running from source without it started.