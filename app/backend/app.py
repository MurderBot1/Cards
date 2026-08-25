"""
Binder — Card Tracker backend
-----------------------------------------------------------------
A small Flask app that implements every endpoint the frontend's
js/api.js expects, serves the frontend itself, and does REAL card
recognition for MTG, Pokémon and Yu-Gi-Oh! using the multi-TCG
scanner pipeline in scanner.py (YOLOv8 detect+classify -> OpenCV
perspective warp -> per-game OCR -> DuckDB exact lookup -> DINOv2 +
FAISS art-similarity fallback).

Storage for collections/settings: a single JSON file (db.json) next
to this script — good enough for a personal project.

Storage for the card catalog itself: data/cards.duckdb (which stores
each card's original image URL from Scryfall/PokemonTCG/YGOPRODeck —
the frontend loads art directly from there, nothing is hosted locally)
+ a FAISS vector index at data/card-vectors.faiss — both built by
build_scanner_models.py, which only keeps local art-crop images around
long enough to compute the FAISS vectors before deleting them.

Run (dev):
    pip install -r requirements.txt
    python build_scanner_models.py   # one-time (long) catalog build
    python app.py

Then open http://localhost:5000 in a browser.

To build a standalone Windows/macOS/Linux executable instead, see
packaging/ and BUILD.md at the repo root — db.json, logs/, and the
card catalog then live under the OS's per-user app-data directory
rather than next to this file; see paths.py for the details.
"""
import argparse
import json
import logging
import socket
import time
import uuid
from logging.handlers import RotatingFileHandler
from pathlib import Path
import threading

import cv2
import numpy as np
from flask import Flask, g, jsonify, request, send_from_directory
import webview

import paths

paths.ensure_bundled_catalog()

import scanner  # noqa: E402 — must come after paths sets BINDER_DATA_DIR

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = paths.FRONTEND_DIR
DB_PATH = paths.DB_PATH

# the C++ LoginServer (see loginserver/ — built with premake5) that actually
# owns accounts/credentials. This Flask app is just a thin HTTP bridge to
# its newline-delimited TCP protocol (LOGIN/REGISTER/QUIT — see
# loginserver/README.md), so the frontend only ever has to speak JSON/HTTP.
LOGIN_SERVER_HOST = "127.0.0.1"
LOGIN_SERVER_PORT = 7777
LOGIN_SERVER_TIMEOUT_S = 5

# ---------------------------------------------------------------------
# API request logging — every request to /api/* gets one line here:
# timestamp, method, path, query string, status code, duration, caller IP.
# Rotates at 5MB, keeps 3 backups, so it can't grow unbounded.
# ---------------------------------------------------------------------
LOG_DIR = paths.LOG_DIR

api_logger = logging.getLogger("binder.api")
api_logger.setLevel(logging.INFO)
_log_handler = RotatingFileHandler(LOG_DIR / "api.log", maxBytes=5 * 1024 * 1024, backupCount=3)
_log_handler.setFormatter(logging.Formatter("%(asctime)s %(message)s", "%Y-%m-%d %H:%M:%S"))
api_logger.addHandler(_log_handler)
api_logger.propagate = False

# minImageQuality setting -> minimum Laplacian-variance blur score (see
# scanner.blur_score) an uploaded scan image must clear before we run it
# through the (expensive) recognition pipeline. Mirrors the sharpness
# thresholds the frontend's own auto-capture loop uses in collections.js
# (AUTO_SHARPNESS_THRESHOLD) — same setting, same underlying focus
# measure, just computed server-side on the actual full-resolution upload
# instead of a small downscaled live-preview frame, so it's a final
# backstop rather than a duplicate of the client-side check.
MIN_BLUR_SCORE = {"low": 15, "medium": 40, "high": 90}

app = Flask(__name__, static_folder=None)


@app.before_request
def _log_request_start():
    g._start_time = time.time()


@app.after_request
def _log_request_end(response):
    # only log actual API traffic — not the static frontend files
    if request.path.startswith("/api/"):
        duration_ms = (time.time() - getattr(g, "_start_time", time.time())) * 1000
        qs = f"?{request.query_string.decode()}" if request.query_string else ""
        api_logger.info(
            "%s %s%s -> %s (%.1fms) from %s",
            request.method,
            request.path,
            qs,
            response.status_code,
            duration_ms,
            request.remote_addr,
        )
    return response


DEFAULT_SETTINGS = {
    "theme": "dark",
    "fontSize": "medium",
    "requestRate": "medium",
    "minImageQuality": "medium",
}

# card condition grading, from best to worst. Scanned cards default to
# Near Mint (the user can correct it after — see PATCH cards/<id>) since
# assuming worst-case would be more annoying to fix than best-case.
VALID_CONDITIONS = ("Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged")
DEFAULT_CONDITION = "Near Mint"
VALID_GAMES = ("mtg", "pokemon", "yugioh")


# ---------------------------------------------------------------------
# tiny JSON-file "database" for collections + settings
# ---------------------------------------------------------------------
def load_db():
    if not DB_PATH.exists():
        return {"collections": [], "settings": dict(DEFAULT_SETTINGS)}
    with open(DB_PATH, "r") as f:
        return json.load(f)


def save_db(db):
    with open(DB_PATH, "w") as f:
        json.dump(db, f, indent=2)


def find_collection(db, collection_id):
    return next((c for c in db["collections"] if c["id"] == collection_id), None)


# ---------------------------------------------------------------------
# auth — bridges to the C++ LoginServer (loginserver/), which owns the
# actual account store (salted SHA-256 hashes, see loginserver/README.md).
# This app speaks LoginServer's tiny newline-delimited protocol over a
# plain TCP socket and translates it to/from JSON for the frontend.
# ---------------------------------------------------------------------
def _login_server_command(command, username, password):
    """Sends "<command> <username> <password>" to LoginServer and returns
    (ok, message) parsed from its one-line "OK ..." / "FAIL ..." reply.
    ok=False with a "Login server unavailable" message means the TCP
    connection itself failed (server not running, wrong host/port, etc.)
    rather than the credentials being rejected."""
    try:
        with socket.create_connection(
            (LOGIN_SERVER_HOST, LOGIN_SERVER_PORT), timeout=LOGIN_SERVER_TIMEOUT_S
        ) as sock:
            stream = sock.makefile("r", encoding="utf-8", newline="\n")
            stream.readline()  # discard greeting: "OK Connected to LoginServer"
            sock.sendall(f"{command} {username} {password}\n".encode("utf-8"))
            response = stream.readline().strip()
    except OSError as exc:
        return False, f"Login server unavailable: {exc}"

    if response.startswith("OK"):
        return True, response[3:].strip()
    if response.startswith("FAIL"):
        return False, response[5:].strip()
    return False, "Unexpected response from login server"


def _validate_credentials(body):
    """Shared username/password extraction + validation for the two auth
    routes below. LoginServer's protocol is whitespace-delimited, so a
    space in either field would silently truncate rather than error —
    reject that here instead, before it ever reaches the socket."""
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    if not username or not password:
        return None, None, "Username and password are required"
    if " " in username or " " in password:
        return None, None, "Username and password can't contain spaces"
    return username, password, None


@app.post("/api/auth/register")
def auth_register():
    body = request.get_json(force=True)
    username, password, error = _validate_credentials(body)
    if error:
        return jsonify({"error": error}), 400

    ok, message = _login_server_command("REGISTER", username, password)
    if not ok:
        status = 502 if message.startswith("Login server unavailable") else 409
        return jsonify({"error": message}), status
    return jsonify({"username": username}), 201


@app.post("/api/auth/login")
def auth_login():
    body = request.get_json(force=True)
    username, password, error = _validate_credentials(body)
    if error:
        return jsonify({"error": error}), 400

    ok, message = _login_server_command("LOGIN", username, password)
    if not ok:
        status = 502 if message.startswith("Login server unavailable") else 401
        return jsonify({"error": message}), status
    return jsonify({"username": username})


# ---------------------------------------------------------------------
# frontend (index.html, css/, js/)
# ---------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/css/<path:filename>")
def css(filename):
    return send_from_directory(FRONTEND_DIR / "css", filename)


@app.route("/js/<path:filename>")
def js(filename):
    return send_from_directory(FRONTEND_DIR / "js", filename)


# ---------------------------------------------------------------------
# collections
# ---------------------------------------------------------------------
@app.get("/api/collections")
def get_collections():
    db = load_db()
    return jsonify(db["collections"])


@app.post("/api/collections")
def create_collection():
    body = request.get_json(force=True)
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400

    db = load_db()
    collection = {"id": uuid.uuid4().hex[:8], "name": name, "cards": []}
    db["collections"].append(collection)
    save_db(db)
    return jsonify(collection), 201


@app.get("/api/collections/<collection_id>")
def get_collection(collection_id):
    db = load_db()
    collection = find_collection(db, collection_id)
    if not collection:
        return jsonify({"error": "not found"}), 404
    return jsonify(collection)


@app.delete("/api/collections/<collection_id>")
def delete_collection(collection_id):
    db = load_db()
    before = len(db["collections"])
    db["collections"] = [c for c in db["collections"] if c["id"] != collection_id]
    if len(db["collections"]) == before:
        return jsonify({"error": "not found"}), 404
    save_db(db)
    return jsonify({"deleted": True})


# ---------------------------------------------------------------------
# cards within a collection
# ---------------------------------------------------------------------
@app.post("/api/collections/<collection_id>/cards")
def add_card(collection_id):
    body = request.get_json(force=True)
    name = body.get("name")
    game = body.get("game")
    if not name:
        return jsonify({"error": "card name is required"}), 400
    if game not in VALID_GAMES:
        return jsonify({"error": f"game must be one of {VALID_GAMES}"}), 400

    db = load_db()
    collection = find_collection(db, collection_id)
    if not collection:
        return jsonify({"error": "not found"}), 404

    condition = body.get("condition") or DEFAULT_CONDITION
    if condition not in VALID_CONDITIONS:
        return jsonify({"error": f"condition must be one of {VALID_CONDITIONS}"}), 400

    # cards are only auto-stacked (quantity++) when name/set/game AND
    # condition all match — a Near Mint copy and a Heavily Played copy
    # of the same print are tracked as separate rows.
    existing = next(
        (
            c for c in collection["cards"]
            if c["name"] == name
            and c.get("set") == body.get("set")
            and c.get("game") == game
            and c.get("condition", DEFAULT_CONDITION) == condition
        ),
        None,
    )
    if existing:
        existing["quantity"] += 1
    else:
        collection["cards"].append(
            {
                "id": uuid.uuid4().hex[:8],
                "name": name,
                "game": game,
                "set": body.get("set", ""),
                "rarity": body.get("rarity", ""),
                "image": body.get("image", ""),
                "condition": condition,
                "quantity": 1,
            }
        )
    save_db(db)
    return jsonify(collection), 201


@app.patch("/api/collections/<collection_id>/cards/<card_id>")
def update_card(collection_id, card_id):
    body = request.get_json(force=True)
    quantity = body.get("quantity")
    condition = body.get("condition")
    if quantity is None and condition is None:
        return jsonify({"error": "quantity and/or condition is required"}), 400
    if condition is not None and condition not in VALID_CONDITIONS:
        return jsonify({"error": f"condition must be one of {VALID_CONDITIONS}"}), 400

    db = load_db()
    collection = find_collection(db, collection_id)
    if not collection:
        return jsonify({"error": "not found"}), 404

    if quantity is not None and quantity <= 0:
        collection["cards"] = [c for c in collection["cards"] if c["id"] != card_id]
    else:
        for c in collection["cards"]:
            if c["id"] == card_id:
                if quantity is not None:
                    c["quantity"] = quantity
                if condition is not None:
                    c["condition"] = condition
    save_db(db)
    return jsonify(collection)


# ---------------------------------------------------------------------
# card database search — now backed by the unified DuckDB catalog
# built by build_scanner_models.py, across all three games.
# ---------------------------------------------------------------------
@app.get("/api/search")
def search_cards():
    game = request.args.get("game", "")
    query = request.args.get("q", "").strip()
    return jsonify(scanner.search(game, query))


# ---------------------------------------------------------------------
# detect — lightweight, detection-only pass used by the scan modal's live
# preview loop. Unlike /api/scan, this does NOT run OCR, hit the DuckDB
# catalog, or touch FAISS — it only answers "is there a card-shaped thing
# in this frame, and roughly where." That keeps it fast enough for the
# frontend to call in a tight loop, once per frame of the live video
# stream, waiting for each response before sending the next.
# ---------------------------------------------------------------------
@app.post("/api/detect")
def detect_card():
    image_file = request.files.get("image")
    if image_file is None:
        return jsonify({"error": "image is required"}), 400

    file_bytes = np.frombuffer(image_file.read(), dtype=np.uint8)
    image_bgr = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)
    if image_bgr is None:
        return jsonify({"error": "Could not read that image"}), 400

    return jsonify(scanner.detect_bbox_only(image_bgr))


# ---------------------------------------------------------------------
# scan — accepts an uploaded image, runs it through the multi-TCG
# scanner pipeline (scanner.py): detect+classify -> perspective warp
# -> per-game OCR -> exact DuckDB lookup -> DINOv2+FAISS art fallback.
# ---------------------------------------------------------------------
@app.post("/api/scan")
def scan_card():
    game = request.form.get("game")  # game the user had selected in the UI; used as a hint
    image_file = request.files.get("image")
    if image_file is None:
        return jsonify({"error": "image is required"}), 400

    settings = load_db()["settings"]

    file_bytes = np.frombuffer(image_file.read(), dtype=np.uint8)
    image_bgr = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)
    if image_bgr is None:
        return jsonify({"error": "Could not read that image"}), 400

    min_blur_score = MIN_BLUR_SCORE.get(settings.get("minImageQuality", "medium"), MIN_BLUR_SCORE["medium"])
    if scanner.blur_score(image_bgr) < min_blur_score:
        return jsonify({"error": "Image is too blurry — hold the camera steady and make sure the card is in focus"}), 400

    if not scanner.is_ready():
        return jsonify({
            "error": "The card catalog hasn't been built yet — run build_scanner_models.py first."
        }), 503

    match, bbox_info = scanner.identify(image_bgr, game_hint=game if game in VALID_GAMES else None)
    if match is None:
        resp = {"error": "Couldn't confidently identify that card — try a clearer, well-lit photo"}
        if bbox_info:
            resp.update(bbox_info)
        return jsonify(resp), 404

    return jsonify(match)


# ---------------------------------------------------------------------
# settings
# ---------------------------------------------------------------------
@app.get("/api/settings")
def get_settings():
    db = load_db()
    return jsonify(db["settings"])


@app.put("/api/settings")
def save_settings():
    body = request.get_json(force=True)
    db = load_db()
    db["settings"].update(body)
    save_db(db)
    return jsonify(db["settings"])

def run_flask(host="127.0.0.1", port=5000):
    app.run(host=host, port=port, threaded=True)

def _status(message):
    """print() when there's a console to see it (dev/terminal launch);
    always ALSO log to startup.log, because a packaged build has
    console=False (see packaging/binder.spec) — sys.stdout can be None
    there, which would make a bare print() crash rather than just be
    invisible, and --headless run from the packaged exe has no console
    at all to print to in the first place."""
    try:
        print(message)
    except Exception:
        pass
    paths._startup_log(message)

def _run():
    import multiprocessing

    multiprocessing.freeze_support()

    parser = argparse.ArgumentParser(description="Binder — Card Tracker")
    parser.add_argument(
        "--headless",
        action="store_true",
        help=(
            "Run as a plain web server on 0.0.0.0 instead of opening a desktop "
            "window, so other devices on your network can connect to it. "
            "SECURITY NOTE: this exposes the API (and, if LoginServer isn't "
            "also reachable, an auth-less API) to your whole LAN — only use "
            "this on networks you trust."
        ),
    )
    parser.add_argument("--port", type=int, default=5000, help="port to listen on (default: 5000)")
    args = parser.parse_args()

    if not (FRONTEND_DIR / "index.html").exists():
        # This is exactly the situation that used to produce a silent
        # Flask 404 with no clue why — see paths.py's _find_resource_dir().
        # Log it loudly instead of letting the window open onto a 404.
        paths._startup_log(
            f"[app] FATAL: no index.html under FRONTEND_DIR={FRONTEND_DIR}. "
            f"See startup.log above this line for what paths.py tried."
        )
        raise FileNotFoundError(f"Frontend not found at {FRONTEND_DIR} — see {paths.LOG_DIR / 'startup.log'}")

    if not DB_PATH.exists():
        save_db({"collections": [], "settings": dict(DEFAULT_SETTINGS)})

    # Load PaddleOCR/YOLO/DINOv2/FAISS now, in the background, instead of
    # letting them trigger on whichever scan request happens to hit them
    # first — that first-touch cost is several seconds and floods stdout
    # with "Creating model" (see scanner.warm_up() for details). Daemon
    # thread so it never blocks shutdown if it's still running.
    threading.Thread(target=scanner.warm_up, daemon=True).start()

    if args.headless:
        # No window — just run the server directly on the main thread,
        # bound to every interface instead of just localhost, until it's
        # stopped (Ctrl+C, or the process is killed).
        _status(
            f"Binder running headless on http://0.0.0.0:{args.port} — "
            f"other devices on this network can connect using this machine's "
            f"LAN IP, e.g. http://<this-machine's-IP>:{args.port}"
        )
        run_flask(host="0.0.0.0", port=args.port)
        return

    # 1. Start Flask in a background daemon thread (localhost-only, as before)
    server_thread = threading.Thread(
        target=run_flask, kwargs={"host": "127.0.0.1", "port": args.port}, daemon=True
    )
    server_thread.start()

    # 2. Create the webview window pointing to your local Flask URL
    webview.create_window("Card Master", f"http://127.0.0.1:{args.port}")

    # 3. Start pywebview (this blocks the main thread until the window is closed)
    webview.start()

if __name__ == "__main__":
    try:
        _run()
    except Exception:
        # console=False (see packaging/binder.spec) swallows the default
        # traceback-to-stderr on a crash, so a packaged build fails
        # completely silently otherwise — no window, no error, nothing.
        # Write it to a file instead so it's actually debuggable.
        import traceback

        paths._startup_log("[app] FATAL startup exception:\n" + traceback.format_exc())
        raise