"""
scanner.py
-----------------------------------------------------------------
The unified multi-TCG recognition pipeline:

    frame -> detect card + guess game (YOLOv8, or OpenCV fallback)
          -> perspective-warp to 750x1050
          -> per-game OCR of the region(s) that carry an exact
             identifier (set+collector#, or YGO passcode+set code)
          -> exact DuckDB lookup
          -> [fallback] title OCR + RapidFuzz name matching
          -> [fallback] DINOv2 art-crop embedding + FAISS similarity
             search, restricted to the fuzzy-matched name candidates

Everything is written to degrade gracefully: if data/cards.duckdb or
data/card-vectors.faiss don't exist yet (build_scanner_models.py
hasn't been run), identify() just returns None instead of crashing.
Heavy ML deps (torch, ultralytics, paddleocr) are imported lazily so
importing this module — and thus starting the Flask app — stays fast
and doesn't hard-require them until a scan actually happens.
"""
import os
import re
import threading
from pathlib import Path

import cv2
import numpy as np

BASE_DIR = Path(__file__).resolve().parent
# BINDER_DATA_DIR lets a packaged app (see backend/paths.py) point this at a
# writable per-user directory instead of BASE_DIR/data, which may be
# read-only once installed. Unset (plain `python app.py` from source) ->
# same behavior as before.
DATA_DIR = Path(os.environ["BINDER_DATA_DIR"]) if os.environ.get("BINDER_DATA_DIR") else (BASE_DIR / "data")
DB_PATH = DATA_DIR / "cards.duckdb"
FAISS_PATH = DATA_DIR / "card-vectors.faiss"
YOLO_WEIGHTS = DATA_DIR / "yolo_card_detector.pt"

WARP_W, WARP_H = 750, 1050
GAMES = ("mtg", "pokemon", "yugioh")

# region-of-interest boxes in the 750x1050 warped-card space, from the
# design doc. (x0, y0, x1, y1)
ROIS = {
    "mtg": {
        "primary": (0, 920, 350, 1050),
        "title": (50, 30, 700, 120),
        "art": (75, 120, 675, 580),
    },
    "pokemon": {
        "primary_modern": (0, 940, 300, 1030),
        "primary_vintage": (500, 940, 730, 1030),
        "title": (100, 30, 650, 120),
        "art": (80, 130, 670, 550),
    },
    "yugioh": {
        "passcode": (20, 980, 220, 1040),
        "set_code": (450, 600, 700, 660),
        "title": (60, 40, 680, 110),
        "art": (120, 210, 630, 580),
    },
}

MTG_PRIMARY_RE = re.compile(r"([A-Z0-9]{3,5})\s*·?\s*(\d{1,4}/\d{1,4})")
PKM_MODERN_RE = re.compile(r"([A-Z0-9]{2,5})\s+(\d{1,3}/\d{1,3})")
PKM_VINTAGE_RE = re.compile(r"(\d{1,3}/\d{1,3})")
YGO_PASSCODE_RE = re.compile(r"\d{8}")
YGO_SETCODE_RE = re.compile(r"([A-Z0-9]{3,4}-[A-Z]{0,2}\d{3})")

FUZZY_MATCH_THRESHOLD = 88  # RapidFuzz score (0-100) to accept a title-OCR match outright
FAISS_TOP_K = 8

# ---------------------------------------------------------------------
# lazily-constructed singletons (only touched once a scan actually runs)
# ---------------------------------------------------------------------
_yolo_model = None
_yolo_load_attempted = False
_ocr_engine = None
_dino_model = None
_dino_device = None
_faiss_index = None
_name_cache = {}  # game -> [(uid, name), ...] pulled from DuckDB, for fuzzy matching

# guards the four _get_*() singletons below. Without this, app.py's startup
# warm_up() (running on a background thread) racing against an early real
# request hitting the same _get_*() at the same moment could each see the
# global as still None and both build their own — the exact "Creating
# model" x2" duplicate-load pattern this was written to prevent.
_singleton_lock = threading.Lock()


def _get_yolo():
    """Returns a loaded YOLO model, or None if no trained weights exist."""
    global _yolo_model, _yolo_load_attempted
    if _yolo_load_attempted:
        return _yolo_model
    with _singleton_lock:
        if _yolo_load_attempted:
            return _yolo_model
        _yolo_load_attempted = True
        if not YOLO_WEIGHTS.exists():
            return None
        try:
            from ultralytics import YOLO
            _yolo_model = YOLO(str(YOLO_WEIGHTS))
        except Exception as e:
            print(f"[scanner] could not load YOLO weights ({e}); falling back to contour detection")
            _yolo_model = None
    return _yolo_model


def _get_ocr():
    global _ocr_engine
    if _ocr_engine is None:
        with _singleton_lock:
            if _ocr_engine is None:
                from paddleocr import PaddleOCR
                # PaddleOCR 3.x replaced use_angle_cls/show_log with these — crops
                # here are already-warped single-region card cutouts, so the doc-level
                # orientation/unwarping models are unnecessary overhead; textline
                # orientation stays on since scanned cards can be tilted.
                # enable_mkldnn=False works around a bug in PaddlePaddle 3.3.x's
                # oneDNN CPU backend (NotImplementedError: ConvertPirAttribute2Run-
                # timeAttribute...) that otherwise crashes every inference call —
                # see https://github.com/PaddlePaddle/Paddle/issues/77340. Costs
                # some CPU speed; drop this once upstream fixes it or you pin an
                # unaffected paddlepaddle version.
                _ocr_engine = PaddleOCR(
                    use_doc_orientation_classify=False,
                    use_doc_unwarping=False,
                    use_textline_orientation=True,
                    lang="en",
                    enable_mkldnn=False,
                )
    return _ocr_engine


def _get_dino():
    global _dino_model, _dino_device
    if _dino_model is None:
        with _singleton_lock:
            if _dino_model is None:
                import torch
                _dino_device = "cuda" if torch.cuda.is_available() else "cpu"
                _dino_model = torch.hub.load("facebookresearch/dinov2", "dinov2_vits14")
                _dino_model.eval().to(_dino_device)
    return _dino_model, _dino_device


def _get_faiss():
    global _faiss_index
    if _faiss_index is None and FAISS_PATH.exists():
        with _singleton_lock:
            if _faiss_index is None:
                import faiss
                _faiss_index = faiss.read_index(str(FAISS_PATH))
    return _faiss_index


def _get_db():
    import duckdb
    if not DB_PATH.exists():
        return None
    return duckdb.connect(str(DB_PATH), read_only=True)


def _get_names(game):
    """Cached (uid, name) list for a game, used for RapidFuzz title matching."""
    if game not in _name_cache:
        con = _get_db()
        if con is None:
            _name_cache[game] = []
        else:
            rows = con.execute("SELECT uid, name FROM cards WHERE game = ?", [game]).fetchall()
            _name_cache[game] = rows
            con.close()
    return _name_cache[game]


def is_ready():
    """Whether the DuckDB catalog exists at all (build_scanner_models.py has run)."""
    return DB_PATH.exists()


def warm_up():
    """Eagerly constructs every lazy singleton above instead of leaving them
    to trigger on whichever request happens to hit them first. Building
    PaddleOCR's pipeline (and, on a fallback-path scan, DINOv2) the first
    time takes several seconds and floods stdout with "Creating model" —
    call this once, on a background thread, right after the app starts
    (see app.py's _run()) so that cost lands during startup, while the
    user's still looking at the collection screen, instead of surprising
    them on their first scan. A no-op if the catalog isn't built yet, and
    each individual model is still only ever loaded once even if this
    somehow overlaps with a real request reaching the same _get_*() first
    — see _singleton_lock above."""
    if not is_ready():
        return
    for label, getter in (
        ("YOLO detector", _get_yolo),
        ("OCR engine", _get_ocr),
        ("FAISS index", _get_faiss),
        ("DINOv2 embedder", _get_dino),
    ):
        try:
            getter()
        except Exception as e:
            # Best-effort — a warm-up failure (e.g. DINOv2 needs to be
            # fetched via torch.hub and the machine is offline) just means
            # that one falls back to loading lazily, on whichever request
            # needs it first, same as before this function existed.
            print(f"[scanner] warm_up: {label} failed to preload ({e}); will retry lazily on first use")


# blurriness gate applied to uploaded scan images before they're run through
# the (expensive) recognition pipeline. Variance of the Laplacian is a
# standard focus-measure: a sharp image has strong edges in every
# direction, so its second-derivative response has high variance; a blurry
# one is smoothed out and the variance collapses toward zero. The image is
# resized to a fixed width first so the score doesn't depend on the
# resolution of whatever camera/upload produced it — a phone shooting
# 4032px-wide photos would otherwise always look "sharper" than a 720p
# webcam purely from having more edge pixels to sum over.
BLUR_SCORE_RESIZE_WIDTH = 600


def blur_score(image_bgr):
    """Focus measure for a full (unwarped) frame — higher is sharper.
    Roughly comparable across images regardless of their original
    resolution; see BLUR_SCORE_RESIZE_WIDTH above."""
    h, w = image_bgr.shape[:2]
    if w > BLUR_SCORE_RESIZE_WIDTH:
        scale = BLUR_SCORE_RESIZE_WIDTH / w
        image_bgr = cv2.resize(image_bgr, (BLUR_SCORE_RESIZE_WIDTH, int(h * scale)), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


# =====================================================================
# Step 2: detection + perspective warp
# =====================================================================
def detect_and_classify(frame_bgr):
    """Returns (bbox, game_or_None). bbox is (x0,y0,x1,y1) in frame_bgr's
    own pixel space, or None to mean "use the whole frame"."""
    yolo = _get_yolo()
    if yolo is not None:
        results = yolo.predict(frame_bgr, verbose=False)[0]
        if len(results.boxes) > 0:
            best = max(results.boxes, key=lambda b: float(b.conf[0]))
            x0, y0, x1, y1 = [int(v) for v in best.xyxy[0].tolist()]
            game = yolo.names[int(best.cls[0])]
            return (x0, y0, x1, y1), (game if game in GAMES else None)
    return None, None  # no trained detector — caller uses the whole frame


def detect_bbox_only(frame_bgr):
    """Lightweight, detection-only pass for the live-preview loop: 'is
    there a card-shaped thing in frame, and roughly where' — no OCR, no
    DuckDB lookup, no FAISS art search. Uses the trained YOLO detector if
    one is loaded; otherwise falls back to the same contour-based quad
    finder warp_perspective uses. Cheap enough to call on every frame of
    a live video stream, and works even before build_scanner_models.py
    has been run (it doesn't touch the catalog at all).

    Returns "quad" (the card's actual 4 corners, in frame_bgr's pixel
    space, ordered tl/tr/br/bl) whenever the contour path found one — a
    card held at an angle is a trapezoid on camera, not a rectangle, and
    the quad follows that shape instead of just bounding it. YOLO hits
    are axis-aligned by construction, so those only populate "bbox".
    """
    bbox, game = detect_and_classify(frame_bgr)
    quad = None
    if bbox is None:
        raw_quad = _find_card_quad(frame_bgr)
        if raw_quad is not None:
            ordered = _order_corners(raw_quad)
            quad = ordered.tolist()  # [[x,y], [x,y], [x,y], [x,y]], tl/tr/br/bl
            xs = [p[0] for p in quad]
            ys = [p[1] for p in quad]
            bbox = (int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys)))

    h, w = frame_bgr.shape[:2]
    return {
        "bbox": {"x0": bbox[0], "y0": bbox[1], "x1": bbox[2], "y1": bbox[3]} if bbox else None,
        "quad": [{"x": x, "y": y} for x, y in quad] if quad else None,
        "image_width": w,
        "image_height": h,
        "game": game,
    }


def _order_corners(pts):
    pts = pts.reshape(4, 2).astype("float32")
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1).flatten()
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(diff)]
    bl = pts[np.argmax(diff)]
    return np.array([tl, tr, br, bl], dtype="float32")


def _find_card_quad(frame_bgr):
    """Finds the largest card-like quadrilateral via edge detection, in
    frame_bgr's own pixel space. Returns the raw 4x2 contour points, or
    None if nothing convincing was found. Shared by warp_perspective
    (which needs the ordered corners for a perspective warp) and
    detect_bbox_only (which just needs the bounding rect, for live
    preview when no trained YOLO detector is loaded)."""
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    frame_area = frame_bgr.shape[0] * frame_bgr.shape[1]
    best_quad = None
    best_area = 0
    for c in contours:
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        area = cv2.contourArea(approx)
        if len(approx) == 4 and area > 0.15 * frame_area and area > best_area:
            best_quad, best_area = approx, area
    return best_quad


def warp_perspective(frame_bgr):
    """Finds the largest card-like quadrilateral via edge detection and
    warps it to WARP_W x WARP_H. Falls back to a plain resize of the
    whole frame if no clean quad is found (still reasonable, since the
    app's scan UI already frames the card fairly tightly)."""
    best_quad = _find_card_quad(frame_bgr)

    if best_quad is None:
        return cv2.resize(frame_bgr, (WARP_W, WARP_H))

    src = _order_corners(best_quad)
    dst = np.array([[0, 0], [WARP_W, 0], [WARP_W, WARP_H], [0, WARP_H]], dtype="float32")
    matrix = cv2.getPerspectiveTransform(src, dst)
    return cv2.warpPerspective(frame_bgr, matrix, (WARP_W, WARP_H))


def _crop(warped, roi):
    x0, y0, x1, y1 = roi
    return warped[y0:y1, x0:x1]


# =====================================================================
# Step 3: per-game OCR + exact DuckDB lookup
# =====================================================================
def _ocr_text(image_bgr):
    if image_bgr.size == 0:
        return ""
    ocr = _get_ocr()
    result = ocr.predict(image_bgr)
    if not result:
        return ""
    texts = result[0].get("rec_texts") or []
    return " ".join(t for t in texts if t)


def _lookup(con, game, **fields):
    clauses, params = [], []
    for col, val in fields.items():
        if val:
            clauses.append(f"{col} = ?")
            params.append(val)
    if not clauses:
        return None
    query = f"SELECT * FROM cards WHERE game = ? AND {' AND '.join(clauses)} LIMIT 1"
    row = con.execute(query, [game] + params).fetchone()
    if not row:
        return None
    cols = [d[0] for d in con.description]
    return dict(zip(cols, row))


def _try_mtg_primary(con, warped):
    text = _ocr_text(_crop(warped, ROIS["mtg"]["primary"]))
    m = MTG_PRIMARY_RE.search(text.upper())
    if not m:
        return None
    set_code, collector_number = m.group(1), m.group(2).split("/")[0]
    return _lookup(con, "mtg", set_code=set_code, collector_number=collector_number)


def _try_pokemon_primary(con, warped):
    text = _ocr_text(_crop(warped, ROIS["pokemon"]["primary_modern"]))
    m = PKM_MODERN_RE.search(text.upper())
    if m:
        set_code, collector_number = m.group(1), m.group(2).split("/")[0]
        card = _lookup(con, "pokemon", set_code=set_code, collector_number=collector_number)
        if card:
            return card

    text = _ocr_text(_crop(warped, ROIS["pokemon"]["primary_vintage"]))
    m = PKM_VINTAGE_RE.search(text)
    if m:
        collector_number = m.group(1).split("/")[0]
        return _lookup(con, "pokemon", collector_number=collector_number)
    return None


def _try_yugioh_primary(con, warped):
    passcode_text = _ocr_text(_crop(warped, ROIS["yugioh"]["passcode"]))
    setcode_text = _ocr_text(_crop(warped, ROIS["yugioh"]["set_code"]))
    passcode_m = YGO_PASSCODE_RE.search(passcode_text)
    setcode_m = YGO_SETCODE_RE.search(setcode_text.upper())
    if passcode_m and setcode_m:
        card = _lookup(con, "yugioh", passcode=passcode_m.group(0), set_code=setcode_m.group(1))
        if card:
            return card
    if passcode_m:
        return _lookup(con, "yugioh", passcode=passcode_m.group(0))
    return None


_PRIMARY_PARSERS = {"mtg": _try_mtg_primary, "pokemon": _try_pokemon_primary, "yugioh": _try_yugioh_primary}


# =====================================================================
# Step 3 fallback: title OCR + RapidFuzz
# =====================================================================
def _title_candidates(game, warped, limit=5):
    from rapidfuzz import process, fuzz
    text = _ocr_text(_crop(warped, ROIS[game]["title"])).strip()
    if not text:
        return []
    names = _get_names(game)
    if not names:
        return []
    choices = {uid: name for uid, name in names}
    matches = process.extract(text, choices, scorer=fuzz.WRatio, limit=limit)
    # matches: [(matched_name, score, uid), ...]
    return matches


# =====================================================================
# Step 4: DINOv2 + FAISS art disambiguation (universal fallback)
# =====================================================================
DINO_INPUT_SIZE = 224
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


def _preprocess_for_dino(pil_image):
    """Resize-shorter-side + center-crop + normalize, by hand — deliberately
    not using torchvision.transforms, since torchvision/torch version
    mismatches (e.g. pulled in transitively by ultralytics) are a common
    source of breakage and this needs nothing beyond numpy + torch, which
    we already depend on."""
    import numpy as np
    import torch
    from PIL import Image

    w, h = pil_image.size
    scale = DINO_INPUT_SIZE / min(w, h)
    new_w, new_h = round(w * scale), round(h * scale)
    img = pil_image.resize((new_w, new_h), Image.BICUBIC)

    left = (new_w - DINO_INPUT_SIZE) // 2
    top = (new_h - DINO_INPUT_SIZE) // 2
    img = img.crop((left, top, left + DINO_INPUT_SIZE, top + DINO_INPUT_SIZE))

    arr = np.asarray(img).astype("float32") / 255.0  # HWC, [0,1]
    arr = (arr - np.array(IMAGENET_MEAN, dtype="float32")) / np.array(IMAGENET_STD, dtype="float32")
    arr = arr.transpose(2, 0, 1)  # CHW
    return torch.from_numpy(arr)


def _embed_art(warped, game):
    import torch
    import faiss
    from PIL import Image as PILImage

    art = _crop(warped, ROIS[game]["art"])
    if art.size == 0:
        return None
    model, device = _get_dino()
    img = PILImage.fromarray(cv2.cvtColor(art, cv2.COLOR_BGR2RGB))
    tensor = _preprocess_for_dino(img).unsqueeze(0).to(device)
    with torch.no_grad():
        vec = model(tensor).cpu().numpy().astype("float32")
    faiss.normalize_L2(vec)
    return vec


def _art_lookup(con, warped, candidate_games, candidate_uids=None):
    index = _get_faiss()
    if index is None or index.ntotal == 0:
        return None

    best_card = None
    for game in candidate_games:
        vec = _embed_art(warped, game)
        if vec is None:
            continue
        scores, idxs = index.search(vec, FAISS_TOP_K)
        for score, vector_idx in zip(scores[0], idxs[0]):
            if vector_idx < 0:
                continue
            row = con.execute(
                "SELECT * FROM cards WHERE vector_idx = ? AND game = ?", [int(vector_idx), game]
            ).fetchone()
            if not row:
                continue
            cols = [d[0] for d in con.description]
            card = dict(zip(cols, row))
            if candidate_uids and card["uid"] not in candidate_uids:
                continue
            return card  # top hit within the allowed game/candidate set
    return best_card


def _best_printing_by_art(con, warped, game, name):
    """Given a card name we're already confident about (from exact-identifier
    OCR or a strong fuzzy title match), use the art crop to pick which
    specific *printing* it is — art is far more reliable here than the tiny,
    easily-misread set-code/collector-number text OCR relies on, especially
    for cards reprinted many times across sets whose codes look similar at
    a glance (or in a blurry photo). This is what catches the case where the
    primary-identifier OCR path confidently, but wrongly, landed on a
    different printing of the same card.

    Always runs once a name is known — including when that name has only
    one known printing — so a bad OCR read never slips through just because
    there was nothing to disambiguate against; the single candidate's own
    art score still confirms (or, on a truly bad photo, can still reject
    via the caller falling back to whatever it already had) the match.

    Returns a raw DB row dict (not the API-shaped card — pass it through
    _row_to_api_card), or None if art-based verification wasn't possible
    (FAISS index missing, no art crop, etc.). Callers should keep their
    existing result in that case rather than treat None as "no match".
    """
    index = _get_faiss()
    if index is None or index.ntotal == 0:
        return None

    rows = con.execute(
        "SELECT uid, vector_idx FROM cards WHERE game = ? AND name = ? AND vector_idx IS NOT NULL",
        [game, name],
    ).fetchall()
    if not rows:
        return None

    vec = _embed_art(warped, game)
    if vec is None:
        return None
    query = vec[0]  # (dim,), already L2-normalized

    best_uid, best_score = None, -1.0
    for uid, vector_idx in rows:
        printing_vec = index.reconstruct(int(vector_idx))  # already L2-normalized at build time
        score = float(np.dot(query, printing_vec))
        if score > best_score:
            best_uid, best_score = uid, score

    if best_uid is None:
        return None
    row = con.execute("SELECT * FROM cards WHERE uid = ?", [best_uid]).fetchone()
    if not row:
        return None
    cols = [d[0] for d in con.description]
    return dict(zip(cols, row))


# =====================================================================
# public API
# =====================================================================
def _row_to_api_card(row):
    # Images are served straight from the source API that supplied them
    # (Scryfall for MTG, PokemonTCG for Pokémon, YGOPRODeck for Yu-Gi-Oh! —
    # see build_scanner_models.py's ingest_* functions) rather than from a
    # local copy: build_scanner_models.py only ever downloads art crops
    # transiently, to compute the DINOv2/FAISS vectors, and deletes them
    # once that's done (see cleanup_local_images() there).
    return {
        "id": row["uid"],
        "name": row["name"],
        "set": row.get("set_code", ""),
        "rarity": row.get("rarity", ""),
        "game": row["game"],
        "image": row.get("image_url") or "",
    }


def identify(image_bgr, game_hint=None):
    """Main entry point. `image_bgr` is an OpenCV BGR numpy array (a
    single decoded frame/photo). `game_hint` narrows the search to one
    game if the caller already knows it (e.g. the user picked a game
    tab in the UI) — pass None to consider all three.

    Returns a (card, bbox_info) tuple. `card` is an API-shaped card
    dict, or None if nothing could be confidently identified. `bbox_info`
    is {"bbox": {...} | None, "image_width": w, "image_height": h} and is
    populated whenever a frame was actually run through detection — i.e.
    even on a miss — so the caller can still show where the detector
    looked. It's None only when we bailed out before detection ran at
    all (catalog not built yet).
    """
    if not is_ready():
        return None, None

    con = _get_db()
    if con is None:
        return None, None

    try:
        bbox, yolo_game = detect_and_classify(image_bgr)
        warped = warp_perspective(image_bgr)

        games_to_try = [yolo_game] if yolo_game else ([game_hint] if game_hint else list(GAMES))

        result = None
        matched_game = None  # set once we have a resolved (game, name) to
        matched_name = None  # verify against art — even a 1-printing name

        # --- exact-identifier OCR path, per game -----------------------
        for game in games_to_try:
            card = _PRIMARY_PARSERS[game](con, warped)
            if card:
                result = _row_to_api_card(card)
                matched_game, matched_name = card["game"], card["name"]
                break

        # --- fuzzy title-OCR fallback -----------------------------------
        if result is None:
            all_candidates = []  # (game, uid, score)
            for game in games_to_try:
                for _name, score, uid in _title_candidates(game, warped):
                    all_candidates.append((game, uid, score))
            all_candidates.sort(key=lambda t: t[2], reverse=True)

            if all_candidates and all_candidates[0][2] >= FUZZY_MATCH_THRESHOLD:
                game, uid, _score = all_candidates[0]
                row = con.execute("SELECT * FROM cards WHERE uid = ?", [uid]).fetchone()
                if row:
                    cols = [d[0] for d in con.description]
                    row = dict(zip(cols, row))
                    result = _row_to_api_card(row)
                    matched_game, matched_name = row["game"], row["name"]

            # --- art-vector fallback, restricted to fuzzy-matched candidates
            # (only reached when the name itself is still unknown — no
            # primary-parser hit and no confident fuzzy title match)
            if result is None:
                candidate_uids = {uid for _g, uid, _s in all_candidates} or None
                candidate_games = list({g for g, _u, _s in all_candidates}) or games_to_try
                card = _art_lookup(con, warped, candidate_games, candidate_uids)
                if card:
                    result = _row_to_api_card(card)
                    matched_game, matched_name = card["game"], card["name"]

        # --- art-based printing verification -----------------------------
        # Whenever a name was resolved above (by either path), double-check
        # *which printing* it is using the art crop, against every known
        # printing of that name — not just when the name has multiple
        # printings, and not just as a fallback for a failed OCR match. OCR
        # of the primary set-code/collector-number region is small text
        # that's easy to misread, and a misread can still land on a real
        # (wrong) row in the catalog, so this runs unconditionally rather
        # than only kicking in when something upstream already looked shaky.
        if matched_name is not None:
            art_row = _best_printing_by_art(con, warped, matched_game, matched_name)
            if art_row is not None:
                result = _row_to_api_card(art_row)

        # the raw YOLO detection box, in the original frame's pixel space
        # (before the perspective warp) — attached whether or not a card
        # was ultimately matched, so a failed scan can still show the user
        # where the detector looked. None if no trained detector is loaded.
        h, w = image_bgr.shape[:2]
        bbox_info = {
            "bbox": {"x0": bbox[0], "y0": bbox[1], "x1": bbox[2], "y1": bbox[3]} if bbox else None,
            "image_width": w,
            "image_height": h,
        }
        if result is not None:
            result.update(bbox_info)

        return result, bbox_info
    finally:
        con.close()


def search(game, query, limit=30):
    """Used by /api/search. Prefix matches first, then contains, like
    the old MTG-only search — just generalized across all three games
    (or one, if `game` is given)."""
    con = _get_db()
    if con is None:
        return []
    try:
        games = [game] if game in GAMES else list(GAMES)
        q = (query or "").strip().lower()
        placeholders = ",".join("?" for _ in games)
        if not q:
            rows = con.execute(
                f"SELECT * FROM cards WHERE game IN ({placeholders}) LIMIT ?", games + [limit]
            ).fetchall()
        else:
            rows = con.execute(
                f"""
                SELECT * FROM cards WHERE game IN ({placeholders}) AND lower(name) LIKE ?
                ORDER BY (lower(name) LIKE ?) DESC, name
                LIMIT ?
                """,
                games + [f"%{q}%", f"{q}%", limit],
            ).fetchall()
        cols = [d[0] for d in con.description]
        return [_row_to_api_card(dict(zip(cols, r))) for r in rows]
    finally:
        con.close()