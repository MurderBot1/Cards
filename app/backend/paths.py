"""
paths.py
-----------------------------------------------------------------
Central place that decides where things live on disk, so app.py and
scanner.py don't each have to guess. Import this BEFORE scanner (app.py
does) — it sets the BINDER_DATA_DIR env var scanner.py reads.

Two very different situations need two very different answers:

  DEV — `python app.py` straight out of the repo
    Everything lives next to the source tree, exactly like before
    packaging existed: db.json and logs/ next to backend/app.py, the
    card catalog under backend/data/, and the frontend one directory
    up (index.html, css/, js/).

  FROZEN — a packaged app (PyInstaller onedir build, see
  packaging/binder.spec)
    The install folder can be read-only (Program Files on Windows, a
    signed .app bundle on macOS) and, for a onefile build, is a temp
    directory wiped after the process exits. So:
      - read-only stuff (the bundled frontend, and a bundled copy of
        the card catalog if one was shipped — see
        packaging/bundled_data/README.md) is read from wherever
        PyInstaller actually put it — see _find_resource_dir(), which
        checks sys._MEIPASS and a couple of onedir-layout fallbacks
        instead of assuming one, since that's moved across PyInstaller
        versions (its 6.0+ `_internal` contents-directory default).
      - anything the app needs to WRITE (db.json, logs, the working
        copy of the card catalog) lives under the OS's normal
        per-user app-data directory instead (via platformdirs), which
        persists across runs and across reinstalls/updates.
    On first launch, if a catalog was bundled but no user-data copy
    exists yet, it's copied over once (see ensure_bundled_catalog()).
-----------------------------------------------------------------
"""
import os
import shutil
import sys
from pathlib import Path

APP_NAME = "Binder"
APP_AUTHOR = "BinderCardTracker"

FROZEN = bool(getattr(sys, "frozen", False))
_SRC_DIR = Path(__file__).resolve().parent  # this file's own directory (backend/)

# USER_DATA_DIR has to be known before we can log anything, and doesn't
# depend on where the bundled resources ended up — compute it first.
if FROZEN:
    from platformdirs import user_data_dir

    USER_DATA_DIR = Path(user_data_dir(APP_NAME, APP_AUTHOR, roaming=True))
else:
    USER_DATA_DIR = _SRC_DIR

USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR = USER_DATA_DIR / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
_LOG_FILE = LOG_DIR / "startup.log"


def _startup_log(message):
    """console=False (see packaging/binder.spec) means print()/stderr are
    invisible in a packaged build — there's no console to show them in.
    This writes path-resolution diagnostics to a plain file instead, so a
    startup problem is debuggable from the installed app alone instead of
    needing a special debug rebuild."""
    try:
        with open(_LOG_FILE, "a", encoding="utf-8") as f:
            f.write(message.rstrip("\n") + "\n")
    except Exception:
        pass  # best-effort — never let logging itself crash startup


def _find_resource_dir():
    """Where PyInstaller actually put the bundled frontend/ (and data/, if
    a catalog was bundled). Don't just trust sys._MEIPASS — PyInstaller's
    onedir layout has moved around across versions (6.0+'s default
    `_internal` contents-directory changed where sys._MEIPASS points
    relative to the exe), so check the real candidates and use whichever
    one actually has our files rather than assuming."""
    exe_dir = Path(sys.executable).resolve().parent
    candidates = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(Path(meipass))
    candidates.append(exe_dir / "_internal")
    candidates.append(exe_dir)

    for c in candidates:
        if (c / "frontend" / "index.html").exists():
            _startup_log(f"[paths] resource dir: {c} (found frontend/index.html here)")
            return c

    tried = "\n  - ".join(str(c) for c in candidates)
    _startup_log(
        f"[paths] WARNING: frontend/index.html not found under any candidate:\n  - {tried}\n"
        f"[paths] sys.executable={sys.executable} sys._MEIPASS={meipass!r}"
    )
    return candidates[0] if candidates else exe_dir


if FROZEN:
    RESOURCE_DIR = _find_resource_dir()
    FRONTEND_DIR = RESOURCE_DIR / "frontend"
    BUNDLED_DATA_DIR = RESOURCE_DIR / "data"
else:
    FRONTEND_DIR = _SRC_DIR.parent  # index.html, css/, js/ live one level up
    BUNDLED_DATA_DIR = None

DB_PATH = USER_DATA_DIR / "db.json"
DATA_DIR = USER_DATA_DIR / "data"  # scanner catalog: cards.duckdb, card-vectors.faiss, yolo weights

# scanner.py reads this at import time instead of hardcoding BASE_DIR/data,
# so it works unmodified in both dev and packaged runs.
os.environ["BINDER_DATA_DIR"] = str(DATA_DIR)


def ensure_bundled_catalog():
    """First-run-only: if build_scanner_models.py's output was bundled
    into the packaged app, copy it into USER_DATA_DIR/data once so
    scanner.py finds it there. No-op in dev mode, if nothing was
    bundled, or if it's already been copied on a previous run."""
    if not FROZEN or BUNDLED_DATA_DIR is None or not BUNDLED_DATA_DIR.exists():
        return
    if DATA_DIR.exists() and any(DATA_DIR.iterdir()):
        return
    shutil.copytree(BUNDLED_DATA_DIR, DATA_DIR, dirs_exist_ok=True)