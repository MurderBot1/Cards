#!/usr/bin/env python3
"""
packaging/build.py
-----------------------------------------------------------------
Cross-platform build driver for Binder's desktop app. Run from
anywhere — it resolves everything off its own location:

    python packaging/build.py

It always builds for the OS it's running ON. PyInstaller doesn't
cross-compile, so getting all three desktop platforms means running
this once each on a real (or CI) Windows, macOS, and Linux machine —
see .github/workflows/build-desktop.yml for a matrix that does that
automatically and uploads all three as build artifacts.

What it does:
  1. Sanity-checks the project layout packaging/binder.spec expects
     (index.html, css/, js/, backend/app.py, ...) so a bad checkout
     fails fast with a clear message instead of a confusing
     PyInstaller error three steps later.
  2. Runs PyInstaller against packaging/binder.spec.
  3. Zips the result (dist/Binder-<os>.zip on Windows/Linux; leaves
     dist/Binder.app as-is on macOS, since .app bundles are meant to
     be distributed as a folder/dmg, not a plain zip's contents) and
     prints the final path.
-----------------------------------------------------------------
"""
import platform
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PACKAGING_DIR = REPO_ROOT / "packaging"
SPEC_FILE = PACKAGING_DIR / "binder.spec"
DIST_DIR = REPO_ROOT / "dist"

REQUIRED_PATHS = [
    REPO_ROOT / "index.html",
    REPO_ROOT / "css" / "styles.css",
    REPO_ROOT / "js" / "app.js",
    REPO_ROOT / "backend" / "app.py",
    REPO_ROOT / "backend" / "scanner.py",
    REPO_ROOT / "backend" / "paths.py",
    REPO_ROOT / "backend" / "requirements.txt",
]


def check_layout():
    missing = [str(p.relative_to(REPO_ROOT)) for p in REQUIRED_PATHS if not p.exists()]
    if missing:
        print("Project layout doesn't match what packaging/binder.spec expects.\n")
        print("Missing:")
        for m in missing:
            print(f"  - {m}")
        print(
            "\nExpected layout (repo root):\n"
            "  index.html\n"
            "  css/styles.css\n"
            "  js/*.js\n"
            "  backend/app.py, backend/scanner.py, backend/paths.py, "
            "backend/requirements.txt\n"
        )
        sys.exit(1)


def check_pyinstaller():
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print(
            "PyInstaller isn't installed. Run:\n"
            "  pip install -r backend/requirements.txt\n"
            "  pip install -r packaging/requirements-build.txt\n"
        )
        sys.exit(1)


def run_pyinstaller():
    cmd = [sys.executable, "-m", "PyInstaller", str(SPEC_FILE), "--noconfirm", "--clean"]
    print(f"$ {' '.join(cmd)}")
    subprocess.run(cmd, cwd=REPO_ROOT, check=True)


def package_output():
    system = platform.system()  # "Windows" | "Darwin" | "Linux"

    if system == "Darwin":
        app_path = DIST_DIR / "Binder.app"
        print(f"\nBuilt: {app_path}")
        print(
            "This is unsigned — macOS Gatekeeper will refuse to open it with a "
            "plain double-click on another machine. See BUILD.md for the "
            "right-click-Open workaround and notes on real code signing."
        )
        return app_path

    onedir = DIST_DIR / "Binder"
    archive_base = DIST_DIR / f"Binder-{system.lower()}"
    archive = shutil.make_archive(
        str(archive_base), "zip", root_dir=onedir.parent, base_dir=onedir.name
    )
    print(f"\nBuilt: {onedir}")
    print(f"Zipped: {archive}")
    return Path(archive)


if __name__ == "__main__":
    check_layout()
    check_pyinstaller()
    run_pyinstaller()
    package_output()