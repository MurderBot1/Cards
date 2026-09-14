"""
android_main.py
-----------------------------------------------------------------
Entry point MainActivity.kt calls (via Chaquopy) instead of running
app.py's own _run(): Android's replacement for pywebview, since
pywebview has no Android build — see android/README.md and
app/BUILD.md's Android section for the full picture.

app.py, scanner.py, and paths.py here are Gradle-copied straight from
app/backend/ (see app/build.gradle.kts's copyPythonBackend task) — the
exact same source the desktop build runs, not a fork of it.
"""
import os
import threading

_started = False
_lock = threading.Lock()


def start(files_dir: str, frontend_dir: str, port: int = 5000) -> None:
    """Called once from MainActivity.onCreate(). Sets the two
    Android-specific paths paths.py needs *before* importing app.py
    (which imports paths.py at module level, and paths.py computes
    USER_DATA_DIR/FRONTEND_DIR once, at import time) — then starts the
    Flask server on a background thread, same as app.py's own _run()
    does for desktop, minus argparse and pywebview (MainActivity.kt
    supplies the window/WebView instead).

    Safe to call more than once (e.g. an Activity recreated on
    rotation): every call after the first is a no-op.
    """
    global _started
    with _lock:
        if _started:
            return
        _started = True

        os.environ["BINDER_ANDROID_FILES_DIR"] = files_dir
        os.environ["BINDER_ANDROID_FRONTEND_DIR"] = frontend_dir

        import app as binder_app  # noqa: PLC0415 — must import after the env vars above are set

        if not binder_app.DB_PATH.exists():
            binder_app.save_db({"collections": [], "settings": dict(binder_app.DEFAULT_SETTINGS)})

        # Same warm_up() every platform uses — loads the ONNX Runtime
        # sessions (cardnet) and the vector index (cardvec) now, in the
        # background, instead of surprising the user with a multi-second
        # stall on their first scan. A no-op if the catalog/models
        # haven't been pushed to the device yet (see android/README.md).
        threading.Thread(target=binder_app.scanner.warm_up, daemon=True).start()

        threading.Thread(
            target=binder_app.run_flask, kwargs={"host": "127.0.0.1", "port": port}, daemon=True
        ).start()
