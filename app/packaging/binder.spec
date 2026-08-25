# packaging/binder.spec
# -----------------------------------------------------------------
# PyInstaller spec for Binder — Card Tracker.
#
# Build with (from the repo root, after installing
# packaging/requirements-build.txt on top of backend/requirements.txt):
#   pyinstaller packaging/binder.spec --noconfirm --clean
#
# ...or just run packaging/build.py, which wraps this with a layout
# sanity check and zips the result. That's what the per-OS
# build-*.{sh,ps1} scripts and the CI workflow both call.
#
# Produces a "onedir" build (dist/Binder/, a folder — not a single
# .exe/binary). Heavy ML deps (torch, paddleocr, paddlepaddle) make
# onefile's per-run extraction-to-temp slow to start and easy to run
# a machine out of disk on, so onedir is deliberate here, not a
# shortcut. dist/Binder/ (or dist/Binder.app on macOS) is what you
# zip up and ship.
#
# PyInstaller does NOT cross-compile: run this on an actual Windows
# machine to get the Windows build, an actual Mac for the macOS
# build, etc. See .github/workflows/build-desktop.yml for a CI matrix
# that does all three automatically.
# -----------------------------------------------------------------
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all

REPO_ROOT = Path(SPECPATH).resolve().parent  # noqa: F821 — SPECPATH is injected by PyInstaller
BACKEND_DIR = REPO_ROOT / "backend"

# --- packages with data files / dynamic libs PyInstaller can't infer on
#     its own (config yamls, char dicts, compiled extensions, ...) --------
COLLECT_ALL_PACKAGES = [
    "ultralytics",
    "paddleocr",
    "paddlex",
    "paddle",
    "faiss",
    "duckdb",
    "rapidfuzz",
    "cv2",
]
datas = []
binaries = []
hiddenimports = []
for pkg in COLLECT_ALL_PACKAGES:
    try:
        pkg_datas, pkg_binaries, pkg_hiddenimports = collect_all(pkg)
    except Exception as exc:  # pragma: no cover - build-time diagnostics only
        print(f"[binder.spec] collect_all skipped for {pkg!r}: {exc}")
        continue
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hiddenimports

# --- frontend: index.html, css/, js/ -> bundled under "frontend/" so it
#     lines up with backend/paths.py's FROZEN-mode FRONTEND_DIR -----------
datas += [
    (str(REPO_ROOT / "index.html"), "frontend"),
    (str(REPO_ROOT / "css"), "frontend/css"),
    (str(REPO_ROOT / "js"), "frontend/js"),
]

# --- optional prebuilt card catalog: drop build_scanner_models.py's
#     output at packaging/bundled_data/{cards.duckdb,card-vectors.faiss,
#     yolo_card_detector.pt} to ship scanning working out of the box.
#     See packaging/bundled_data/README.md. Skipped entirely if empty. ----
BUNDLED_DATA = REPO_ROOT / "packaging" / "bundled_data"
if BUNDLED_DATA.exists() and any(BUNDLED_DATA.glob("*")):
    datas.append((str(BUNDLED_DATA), "data"))

# --- app icon, if provided. See packaging/icons/README.md. ---------------
ICON_DIR = REPO_ROOT / "packaging" / "icons"
if sys.platform == "win32":
    _icon = ICON_DIR / "icon.ico"
elif sys.platform == "darwin":
    _icon = ICON_DIR / "icon.icns"
else:
    _icon = None
icon_path = str(_icon) if _icon and _icon.exists() else None

block_cipher = None

a = Analysis(  # noqa: F821 — injected by PyInstaller at spec-exec time
    [str(BACKEND_DIR / "app.py")],
    pathex=[str(BACKEND_DIR)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Binder",
    debug=False,
    strip=False,
    upx=False,  # UPX + torch/paddle's compiled extensions is a common source
                # of "works when built, crashes on the target machine" bugs
    console=False,
    icon=icon_path,
)

coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="Binder",
)

if sys.platform == "darwin":
    app = BUNDLE(  # noqa: F821
        coll,
        name="Binder.app",
        icon=icon_path,
        bundle_identifier="com.bindercardtracker.binder",
        info_plist={
            "NSHighResolutionCapable": "True",
            # scanning uses the camera through the webview; macOS refuses
            # camera access to any app without this key in Info.plist,
            # regardless of what the user clicks on the permission prompt
            "NSCameraUsageDescription": "Binder uses your camera to scan trading cards.",
        },
    )
