"""
build_scanner_models.py
-----------------------------------------------------------------
Builds everything scanner.py needs to recognize MTG / Pokémon /
Yu-Gi-Oh! cards:

  1. Ingests bulk card data into SQLite (data/cards.sqlite3):
       - MTG:        Scryfall "all_cards" bulk export (every printing,
                      including extra languages/promos) — downloaded as
                      a gzipped JSONL file, per Scryfall's July 2026
                      bulk-data format change (see NOTE below)
       - Pokémon:    PokemonTCG/pokemon-tcg-data (GitHub, per-set JSON)
       - Yu-Gi-Oh!:  YGOPRODeck cardinfo.php bulk export
     Every bulk download is cached under data/cache/, so re-running the
     script re-uses what it already fetched instead of re-downloading
     (pass --refresh-cache to force a fresh pull).
  2. Downloads a small art-crop image per card into
       data/card-images/<game>/<uid>.jpg
     — purely a scratch copy used to compute step 3's vectors. The app
     itself never reads these; it loads card art straight from each
     card's image_url (Scryfall / PokemonTCG / YGOPRODeck), which is
     stored in SQLite during ingest.
  3. Embeds every art crop with DINOv2 (dinov2_vits14, exported to ONNX —
     see native/cardnet/export/export_dino.py — and run via cardnet)
     and builds a cardvec cosine-similarity index over all of them
     (data/card-vectors.cvi), recording which SQLite row each
     vector belongs to.
  4. Deletes data/card-images/ now that the vectors are built (pass
     --keep-images to keep them around for debugging).

Run:
    pip install -r requirements.txt
    python build_scanner_models.py            # does all steps
    python build_scanner_models.py --skip-images --skip-vectors
    python build_scanner_models.py --only mtg  # just one game
    python build_scanner_models.py --refresh-cache  # ignore cached bulk data

It's safe to re-run: each step skips work that's already done (rows
already in SQLite, images already on disk, vectors already indexed,
bulk downloads already cached in data/cache/), so if it gets
interrupted partway through, just run it again.

------------------------------------------------------------------
NOTE on Scryfall's bulk-data format (as of July 20, 2026)
------------------------------------------------------------------
Scryfall used to serve bulk data as a single big JSON array (fetched
via each bulk_data object's `download_uri`). As of July 20, 2026,
that format is retired — bulk files are now served exclusively as
gzipped JSONL (`jsonl_download_uri`): one JSON object per line, no
wrapping array, no commas between objects. `cached_get_jsonl()` below
downloads+caches the raw `.jsonl.gz` bytes and decompresses/parses
them line by line, which is also far more memory-friendly than
loading Scryfall's entire ~2GB "all_cards" dump as one JSON array.

------------------------------------------------------------------
NOTE on YOLOv8 card detection / game classification
------------------------------------------------------------------
This script does NOT produce data/yolo_card_detector.pt. Training
that model needs a labeled dataset — photos of physical cards on
tables/in hand with bounding boxes AND a game-type label — which
doesn't exist to auto-download; you'd have to shoot and label it
yourself (e.g. with Roboflow) and then run something like:

    yolo detect train data=your_dataset.yaml model=yolov8n.pt epochs=100
    cp runs/detect/train/weights/best.pt data/yolo_card_detector.pt

If you never do this, that's fine — scanner.py automatically falls
back to a plain OpenCV contour-based rectangle detector (good enough
when the app's on-screen guide box is already framing the card) and
figures out the game type from OCR content instead of a classifier.
"""
import argparse
import gzip
import io
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import cv2
import sqlite3
import numpy as np
import requests
from PIL import Image
from tqdm import tqdm

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
IMAGES_DIR = DATA_DIR / "card-images"
CACHE_DIR = DATA_DIR / "cache"
DB_PATH = DATA_DIR / "cards.sqlite3"
VECTOR_INDEX_PATH = DATA_DIR / "card-vectors.cvi"
DINO_ONNX_PATH = DATA_DIR / "dinov2_vits14.onnx"

HTTP_TIMEOUT = 30
REQUEST_PAUSE_SEC = 0.05  # be polite to the free APIs we're hitting

# Scryfall's API rejects requests that don't send a descriptive User-Agent
# and an Accept header (returns 400 Bad Request otherwise) — see
# https://scryfall.com/docs/api. The other two APIs don't require this,
# but it's good practice to send it everywhere.
HTTP_HEADERS = {
    "User-Agent": "BinderCardTracker/1.0 (personal card-collection app)",
    "Accept": "application/json",
}
session = requests.Session()
session.headers.update(HTTP_HEADERS)

# When true (--refresh-cache), cached_get_json/cached_get_jsonl ignore
# whatever's on disk and re-download. Set by main() before any ingest_*
# function runs.
REFRESH_CACHE = False


def cached_get_json(url, cache_key, timeout=HTTP_TIMEOUT):
    """GETs a JSON URL, caching the raw response body under
    data/cache/<cache_key>.json so re-running the script (e.g. after an
    interruption, or just to pick up newly-added games) doesn't
    re-download bulk data it already has. Pass --refresh-cache on the
    command line to force a fresh download for everything.

    Raises requests.HTTPError on a non-2xx response, same as
    response.raise_for_status(), so callers can catch it the same way
    they would a plain session.get(...).raise_for_status().
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIR / f"{cache_key}.json"

    if cache_path.exists() and not REFRESH_CACHE:
        with open(cache_path, "r", encoding="utf-8") as f:
            return json.load(f)

    r = session.get(url, timeout=timeout)
    r.raise_for_status()
    data = r.json()
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(data, f)
    return data


def cached_get_jsonl(url, cache_key, timeout=HTTP_TIMEOUT):
    """GETs a gzipped JSONL URL — the format Scryfall bulk data files have
    been served in exclusively since July 20, 2026 (one JSON object per
    line, no wrapping array, no commas). Caches the raw .jsonl.gz bytes
    under data/cache/<cache_key>.jsonl.gz so re-running the script doesn't
    re-download. Pass --refresh-cache to force a fresh download.

    Streams the decompressed lines rather than pulling the whole file into
    memory as text, since Scryfall's "all_cards" dump is multiple GB
    uncompressed. Raises requests.HTTPError on a non-2xx response.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIR / f"{cache_key}.jsonl.gz"

    if cache_path.exists() and not REFRESH_CACHE:
        raw_source = cache_path.open("rb")
    else:
        r = session.get(url, timeout=timeout, stream=True)
        r.raise_for_status()
        with open(cache_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                f.write(chunk)
        raw_source = cache_path.open("rb")

    objects = []
    with raw_source, gzip.GzipFile(fileobj=raw_source) as gz:
        for line in gz:
            line = line.strip()
            if not line:
                continue
            objects.append(json.loads(line))
    return objects


def get_db():
    """Opens (creating if needed) the SQLite card catalog.

    This used to be DuckDB. SQLite is what Android can actually run:
    duckdb publishes no Android wheel and isn't in Chaquopy's native
    package repository at any Python version, whereas sqlite3 is in
    CPython's own standard library on every platform including Android.
    Nothing here needed DuckDB's analytical engine — every query in
    scanner.py is a single-row lookup by an indexed column — so this is
    a simplification for the desktop build too, not just an Android
    workaround.
    """
    DATA_DIR.mkdir(exist_ok=True)
    con = sqlite3.connect(str(DB_PATH))
    # Bulk ingest is millions of INSERTs; the default rollback journal
    # fsyncs per transaction. WAL + NORMAL is the standard bulk-load
    # setting and is safe against process crashes (only OS-level crashes
    # can lose the last transactions, and this file is regenerable).
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS cards (
            uid TEXT PRIMARY KEY,
            game TEXT,
            name TEXT,
            -- name.lower() computed in Python at ingest, because SQLite's
            -- own lower() is ASCII-only (DuckDB's, which this replaced,
            -- was Unicode-aware). scanner.search() matches against this
            -- column so names like "Ubermut"/"Eclair" with non-ASCII
            -- uppercase forms, and the non-Latin printings Scryfall's
            -- all_cards dump includes, stay searchable.
            name_lower TEXT,
            set_code TEXT,
            set_name TEXT,
            collector_number TEXT,
            rarity TEXT,
            passcode TEXT,
            image_url TEXT,   -- source URL, used to download the local copy
            image_path TEXT,  -- relative path under data/card-images once downloaded
            vector_idx INTEGER   -- row index into the cardvec index, once embedded
        )
        """
    )
    # DuckDB's columnar scans tolerated unindexed lookups; SQLite will do a
    # full table scan over a multi-hundred-thousand-row catalog without
    # these. Each one matches a WHERE clause scanner.py actually issues.
    con.execute("CREATE INDEX IF NOT EXISTS idx_cards_game_set_num ON cards(game, set_code, collector_number)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_cards_game_passcode ON cards(game, passcode)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_cards_game_name ON cards(game, name)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_cards_vector_idx ON cards(game, vector_idx)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_cards_game_collector_number ON cards(game, collector_number)")
    con.commit()
    return con


# How many card rows go into a single INSERT statement in flush_card_batch().
# How many card rows accumulate before one executemany() call writes them.
# The point is the transaction, not the statement count: SQLite in its
# default autocommit mode fsyncs once per statement, so a per-card
# con.execute() makes ingest disk-bound. Batching into one executemany()
# per CARD_BATCH_SIZE rows (committed by the caller) is what keeps MTG's
# multi-hundred-thousand-printing ingest from taking hours.
CARD_BATCH_SIZE = 2000


def _row_values(row):
    name = row["name"] or ""
    return [row["uid"], row["game"], name, name.lower(),
            row.get("set_code", ""), row.get("set_name", ""),
            row.get("collector_number", ""), row.get("rarity", ""), row.get("passcode", ""),
            row.get("image_url", "")]


def flush_card_batch(con, batch):
    """Upserts many card rows with one executemany() call
    instead of one execute() call per row (see upsert_card,
    kept below for single-row callers). This is the main ingest
    bottleneck fix: executemany() prepares the statement once and
    re-binds it per row, and all CARD_BATCH_SIZE rows land inside a
    single transaction, so SQLite pays one durability cost per batch
    instead of one per card.

    Dedupes by uid within the batch (keeping the last occurrence) first.
    Under the previous multi-row INSERT this was mandatory — touching the
    same ON CONFLICT target twice in one statement is an error. With
    executemany() the duplicates would merely apply in sequence, but
    collapsing them is still both cheaper and the same end state.
    """
    if not batch:
        return
    dedup = {row["uid"]: row for row in batch}  # last occurrence wins
    rows = [_row_values(row) for row in dedup.values()]

    con.executemany(
        """
        INSERT INTO cards (uid, game, name, name_lower, set_code, set_name,
                            collector_number, rarity, passcode, image_url,
                            image_path, vector_idx)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT (uid) DO UPDATE SET
            name=excluded.name, name_lower=excluded.name_lower,
            set_code=excluded.set_code, set_name=excluded.set_name,
            collector_number=excluded.collector_number, rarity=excluded.rarity,
            passcode=excluded.passcode, image_url=excluded.image_url
        """,
        rows,
    )


def upsert_card(con, row):
    """Single-row upsert. Kept for callers that only ever have one row at a
    time; bulk ingest loops should accumulate rows and call
    flush_card_batch() instead — see CARD_BATCH_SIZE above."""
    flush_card_batch(con, [row])


# =====================================================================
# 1a. MTG — Scryfall bulk data
# =====================================================================
def ingest_mtg(con):
    print("[mtg] fetching bulk-data index from Scryfall...")
    try:
        entries = cached_get_json("https://api.scryfall.com/bulk-data", "scryfall_bulk_index")["data"]
    except requests.HTTPError as e:
        print(f"[mtg] Scryfall returned an error: {e}", file=sys.stderr)
        raise
    # "all_cards" includes every printing Scryfall knows about (including
    # extra languages/promos that "default_cards" leaves out) — bigger
    # download, but a more complete catalog for scan matching.
    all_cards_entry = next(e for e in entries if e["type"] == "all_cards")
    jsonl_uri = all_cards_entry.get("jsonl_download_uri")
    if not jsonl_uri:
        # Shouldn't happen post-July-2026, but fail loudly instead of
        # silently trying the retired JSON-array format.
        raise RuntimeError(
            "[mtg] bulk-data entry has no jsonl_download_uri — Scryfall's "
            "API response shape may have changed again; check "
            "https://scryfall.com/docs/api/bulk-data"
        )
    # 'size' isn't guaranteed to be present in every bulk-data entry (it's
    # dropped from some responses since Scryfall's July 2026 JSONL switch),
    # so don't let a missing/renamed field crash the download over a
    # cosmetic log line.
    size_bytes = all_cards_entry.get("size")
    size_note = f"{size_bytes / 1e6:.0f}MB" if isinstance(size_bytes, (int, float)) else "size unknown"
    print(f"[mtg] downloading {size_note} card dump (gzipped JSONL, "
          f"cached at {CACHE_DIR / 'scryfall_all_cards.jsonl.gz'})...")
    cards = cached_get_jsonl(jsonl_uri, "scryfall_all_cards", timeout=120)
    print(f"[mtg] ingesting {len(cards)} printings...")

    batch = []
    for c in tqdm(cards, desc="mtg"):
        if c.get("layout") in ("art_series", "token", "double_faced_token"):
            continue
        image_url = None
        if "image_uris" in c:
            image_url = c["image_uris"].get("normal")
        elif c.get("card_faces") and "image_uris" in c["card_faces"][0]:
            image_url = c["card_faces"][0]["image_uris"].get("normal")
        batch.append({
            "uid": f"mtg-{c['id']}",
            "game": "mtg",
            "name": c["name"],
            "set_code": (c.get("set") or "").upper(),
            "set_name": c.get("set_name", ""),
            "collector_number": c.get("collector_number", ""),
            "rarity": (c.get("rarity") or "").capitalize(),
            "image_url": image_url or "",
        })
        if len(batch) >= CARD_BATCH_SIZE:
            flush_card_batch(con, batch)
            batch.clear()
    flush_card_batch(con, batch)
    con.commit()
    print("[mtg] done.")


# =====================================================================
# 1b. Pokémon — PokemonTCG/pokemon-tcg-data on GitHub (raw JSON, per set)
# =====================================================================
DEFAULT_INGEST_WORKERS = 16


def _fetch_pokemon_set(set_id):
    """Runs in a worker thread: does the network GET (or cache read) for one
    set's card list only. No database access — writes happen back on the main
    thread. Returns (set_id, cards_or_None, error_or_None)."""
    url = f"https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/cards/en/{set_id}.json"
    try:
        cards = cached_get_json(url, f"pokemon_set_{set_id}")
        return set_id, cards, None
    except requests.RequestException as e:
        return set_id, None, e


def ingest_pokemon(con, max_workers=DEFAULT_INGEST_WORKERS):
    print("[pokemon] fetching set list...")
    sets = cached_get_json(
        "https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/sets/en.json",
        "pokemon_sets",
    )
    print(f"[pokemon] {len(sets)} sets to ingest ({max_workers} workers)...")
    sets_by_id = {s["id"]: s for s in sets}

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(_fetch_pokemon_set, set_id) for set_id in sets_by_id]
        for future in tqdm(as_completed(futures), total=len(futures), desc="pokemon sets"):
            set_id, cards, err = future.result()
            if err is not None:
                continue
            s = sets_by_id[set_id]
            set_batch = []
            for c in cards:
                image_url = (c.get("images") or {}).get("large") or (c.get("images") or {}).get("small")
                set_batch.append({
                    "uid": f"pkm-{c['id']}",
                    "game": "pokemon",
                    "name": c.get("name", ""),
                    "set_code": s.get("ptcgoCode", set_id).upper(),
                    "set_name": s.get("name", ""),
                    "collector_number": c.get("number", ""),
                    "rarity": c.get("rarity", "") or "",
                    "image_url": image_url or "",
                })
            flush_card_batch(con, set_batch)  # one statement for the whole set
            con.commit()
    print("[pokemon] done.")


# =====================================================================
# 1c. Yu-Gi-Oh! — YGOPRODeck bulk export
# =====================================================================
def ingest_yugioh(con):
    print("[yugioh] downloading cardinfo.php bulk export...")
    cards = cached_get_json("https://db.ygoprodeck.com/api/v7/cardinfo.php", "ygoprodeck_cardinfo", timeout=120)["data"]
    printing_count = sum(len(c.get("card_sets") or [None]) for c in cards)
    print(f"[yugioh] ingesting {len(cards)} cards ({printing_count} printings)...")

    batch = []
    for c in tqdm(cards, desc="yugioh"):
        passcode = str(c.get("id", ""))
        image_url = ""
        if c.get("card_images"):
            image_url = c["card_images"][0].get("image_url", "")
        card_sets = c.get("card_sets") or [{}]
        for cs in card_sets:
            set_code = cs.get("set_code", "")
            uid = f"ygo-{passcode}-{set_code}" if set_code else f"ygo-{passcode}"
            batch.append({
                "uid": uid,
                "game": "yugioh",
                "name": c.get("name", ""),
                "set_code": set_code,
                "set_name": cs.get("set_name", ""),
                "collector_number": "",
                "rarity": cs.get("set_rarity", ""),
                "passcode": passcode,
                "image_url": image_url,
            })
            if len(batch) >= CARD_BATCH_SIZE:
                flush_card_batch(con, batch)
                batch.clear()
    flush_card_batch(con, batch)
    con.commit()
    print("[yugioh] done.")


# =====================================================================
# 2. Download art-crop images for every row that doesn't have one yet
# =====================================================================
_UNSAFE_FILENAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _safe_filename(uid):
    """uid is used verbatim as a filename — sanitize it, since some card
    numbers from these APIs contain characters Windows won't allow in a
    filename (e.g. a literal '?' for unknown promo numbers)."""
    return _UNSAFE_FILENAME_RE.sub("_", uid)


DEFAULT_IMAGE_WORKERS = 16


def _fetch_one_image(uid, game, image_url, dest, rel_path):
    """Runs in a worker thread: does the network GET + JPEG re-encode only.
    No database access here — sqlite3 connections aren't safe to share across
    threads, so all DB writes happen back on the main thread once this
    returns. Returns (uid, rel_path, error_or_None)."""
    try:
        r = session.get(image_url, timeout=HTTP_TIMEOUT)
        r.raise_for_status()
        img = Image.open(io.BytesIO(r.content)).convert("RGB")
        img.save(dest, "JPEG", quality=88)
        if REQUEST_PAUSE_SEC:
            time.sleep(REQUEST_PAUSE_SEC)
        return uid, rel_path, None
    except Exception as e:
        return uid, rel_path, e


def download_images(con, only_game=None, max_workers=DEFAULT_IMAGE_WORKERS):
    where = "image_path IS NULL AND image_url != ''"
    if only_game:
        where += f" AND game = '{only_game}'"
    rows = con.execute(f"SELECT uid, game, image_url FROM cards WHERE {where}").fetchall()
    print(f"[images] {len(rows)} images to download ({max_workers} workers)...")

    to_fetch = []  # (uid, game, image_url, dest, rel_path) — actually need a network request
    for uid, game, image_url in rows:
        game_dir = IMAGES_DIR / game
        game_dir.mkdir(parents=True, exist_ok=True)
        safe_name = _safe_filename(uid)
        dest = game_dir / f"{safe_name}.jpg"
        rel_path = f"{game}/{safe_name}.jpg"
        if dest.exists():
            # already on disk from a previous run — just fix up the DB row,
            # no need to spend a thread/network call on it
            con.execute("UPDATE cards SET image_path=? WHERE uid=?", [rel_path, uid])
            continue
        to_fetch.append((uid, game, image_url, dest, rel_path))
    con.commit()

    if not to_fetch:
        print("[images] done.")
        return

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [
            pool.submit(_fetch_one_image, uid, game, image_url, dest, rel_path)
            for uid, game, image_url, dest, rel_path in to_fetch
        ]
        done_since_commit = 0
        for future in tqdm(as_completed(futures), total=len(futures), desc="images"):
            uid, rel_path, err = future.result()
            if err is not None:
                print(f"[images] failed {uid}: {err}", file=sys.stderr)
                continue
            con.execute("UPDATE cards SET image_path=? WHERE uid=?", [rel_path, uid])
            done_since_commit += 1
            if done_since_commit >= 200:
                con.commit()
                done_since_commit = 0
    con.commit()
    print("[images] done.")


# =====================================================================
# 3. Embed every downloaded image with DINOv2 and build a cardvec index
# =====================================================================
DEFAULT_VECTOR_PREFETCH_WORKERS = 2

# How many image-batches to process between checkpoints (DB commit +
# cardvec.write_index). write_index() rewrites the *entire* index file
# every time it's called, not just the newly-added vectors, so calling it
# after every single small batch means the write gets more expensive as the
# index grows over the course of a run. Checkpointing every N batches
# instead trades a slightly bigger "redo window" on cancel/crash (up to
# VECTOR_CHECKPOINT_BATCHES batches' worth of embedding work) for far less
# redundant disk I/O.
VECTOR_CHECKPOINT_BATCHES = 10


def finalize_db(con):
    """Folds the write-ahead log back into cards.sqlite3 and switches the
    file out of WAL mode, so the finished catalog is a single
    self-contained file.

    This matters because the catalog gets *shipped*: copied into
    packaging/bundled_data/ for a desktop installer, or pushed to a device
    for the Android build (see android/README.md). journal_mode is stored
    in the file header and survives being copied, and a WAL database is
    really up to three files. Left as-is, either delivery path can break:
    copying only cards.sqlite3 while committed rows still sit in an
    un-checkpointed -wal silently truncates the catalog, and a stale -wal
    arriving alongside it makes scanner.py's read-only open fail outright,
    because a read-only connection cannot create the -shm file it would
    need to replay the log.

    WAL still earns its place during ingest itself (see get_db) - this
    just undoes it once the writing is finished.
    """
    con.commit()
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    con.execute("PRAGMA journal_mode=DELETE")


def _bulk_update_vector_idx(con, pairs):
    """pairs: list of (vector_idx, uid). Backfills vector_idx for many rows
    in one transaction rather than one autocommitted UPDATE per row.

    This was a single `UPDATE ... FROM (VALUES ...) AS v(idx, uid)`
    statement under DuckDB. SQLite supports `UPDATE ... FROM`, but not
    that derived-column-list form of table alias, so this uses
    executemany() instead — which is the shape SQLite optimizes for
    anyway: the statement is prepared once and re-bound per row, so the
    per-statement planning overhead the DuckDB version was avoiding
    doesn't apply here in the first place.
    """
    if not pairs:
        return
    con.executemany("UPDATE cards SET vector_idx = ? WHERE uid = ?", pairs)


def build_vectors(con, only_game=None, batch_size=32, prefetch_workers=DEFAULT_VECTOR_PREFETCH_WORKERS):
    import cardnet
    import cardvec

    if not DINO_ONNX_PATH.exists():
        print(f"[vectors] {DINO_ONNX_PATH} doesn't exist — run native/cardnet/export/export_dino.py first.",
              file=sys.stderr)
        return

    where = "image_path IS NOT NULL AND vector_idx IS NULL"
    if only_game:
        where += f" AND game = '{only_game}'"
    rows = con.execute(f"SELECT uid, image_path FROM cards WHERE {where}").fetchall()
    print(f"[vectors] {len(rows)} cards to embed...")
    if not rows:
        print("[vectors] nothing to do.")
        return

    print("[vectors] loading DINOv2 (dinov2_vits14) via ONNX Runtime...")
    embedder = cardnet.DinoEmbedder(str(DINO_ONNX_PATH))

    # load (or create) the cardvec index, and figure out where new vectors
    # should start being appended so uid <-> row-index stays consistent
    dim = 384  # dinov2_vits14 embedding size
    if VECTOR_INDEX_PATH.exists():
        index = cardvec.read_index(str(VECTOR_INDEX_PATH))
    else:
        index = cardvec.IndexFlatIP(dim)
    next_idx = index.ntotal

    def load_batch(batch_rows):
        """Reads one batch's images from disk (cv2.imread — BGR uint8,
        exactly what cardnet.DinoEmbedder.embed expects). Pure IO/JPEG-
        decode work that releases the GIL for most of its time, so it's a
        good fit for a background thread — see the prefetch loop below."""
        images, uids = [], []
        for uid, image_path in batch_rows:
            full_path = IMAGES_DIR / image_path
            img = cv2.imread(str(full_path))
            if img is None:
                print(f"[vectors] skip {uid}: could not read {full_path}", file=sys.stderr)
                continue
            images.append(img)
            uids.append(uid)
        return images, uids

    batches = [rows[i:i + batch_size] for i in range(0, len(rows), batch_size)]

    # Prefetching: decoding a batch of images from disk is IO/CPU work that
    # doesn't touch ONNX Runtime, while embedder.embed() is compute (ORT's
    # own internal thread pool). Doing these serially means the CPU
    # inference sits idle during every load_batch() call. Here a small
    # thread pool loads batch N+prefetch_workers while the main thread is
    # still embedding batch N, so disk IO overlaps with compute instead of
    # stalling it.
    with ThreadPoolExecutor(max_workers=prefetch_workers) as pool:
        pending = {}
        lookahead = max(1, prefetch_workers)
        for i in range(min(lookahead, len(batches))):
            pending[i] = pool.submit(load_batch, batches[i])

        batches_since_checkpoint = 0
        for i in tqdm(range(len(batches)), desc="vectors"):
            images, uids = pending.pop(i).result()

            next_i = i + lookahead
            if next_i < len(batches):
                pending[next_i] = pool.submit(load_batch, batches[next_i])

            if not images:
                continue
            emb = np.stack([embedder.embed(img) for img in images]).astype("float32")
            cardvec.normalize_L2(emb)  # so inner product == cosine similarity
            index.add(emb)
            _bulk_update_vector_idx(con, [(next_idx + j, uid) for j, uid in enumerate(uids)])
            next_idx += len(uids)

            batches_since_checkpoint += 1
            if batches_since_checkpoint >= VECTOR_CHECKPOINT_BATCHES:
                con.commit()
                cardvec.write_index(index, str(VECTOR_INDEX_PATH))  # persist, but not every single batch
                batches_since_checkpoint = 0

        # flush whatever's left since the last checkpoint
        if batches_since_checkpoint > 0:
            con.commit()
            cardvec.write_index(index, str(VECTOR_INDEX_PATH))

    print(f"[vectors] done — {index.ntotal} vectors in {VECTOR_INDEX_PATH}")


# =====================================================================
# 4. Delete the local art-crop images once they're no longer needed
# =====================================================================
def cleanup_local_images(only_game=None):
    """The images under data/card-images/ are only ever needed transiently,
    to compute the DINOv2/cardvec vectors in build_vectors() above — the app
    itself doesn't read them at all. It loads each card's art straight from
    the image_url captured during ingest (Scryfall for MTG, PokemonTCG for
    Pokémon, YGOPRODeck for Yu-Gi-Oh! — see scanner.py's _row_to_api_card),
    so keeping a second, local copy around afterward just wastes disk space.
    Deletes the whole data/card-images/ tree, or just one game's subfolder
    when --only was passed."""
    import shutil

    target = (IMAGES_DIR / only_game) if only_game else IMAGES_DIR
    if not target.exists():
        return
    shutil.rmtree(target)
    print(f"[cleanup] removed local art-crop images at {target}")


def main():
    global REFRESH_CACHE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", choices=["mtg", "pokemon", "yugioh"], help="only build this game")
    parser.add_argument("--skip-ingest", action="store_true")
    parser.add_argument("--skip-images", action="store_true")
    parser.add_argument("--skip-vectors", action="store_true")
    parser.add_argument(
        "--keep-images", action="store_true",
        help="don't delete data/card-images/ after the cardvec vectors are built "
             "(useful for debugging what got downloaded/embedded)",
    )
    parser.add_argument(
        "--refresh-cache", action="store_true",
        help="ignore data/cache/*.json[.gz] and re-download bulk data instead of reusing it",
    )
    parser.add_argument(
        "--image-workers", type=int, default=DEFAULT_IMAGE_WORKERS,
        help=f"number of concurrent image-download threads (default: {DEFAULT_IMAGE_WORKERS})",
    )
    parser.add_argument(
        "--ingest-workers", type=int, default=DEFAULT_INGEST_WORKERS,
        help=f"number of concurrent per-set download threads for Pokemon ingest (default: {DEFAULT_INGEST_WORKERS})",
    )
    parser.add_argument(
        "--vector-prefetch-workers", type=int, default=DEFAULT_VECTOR_PREFETCH_WORKERS,
        help="threads used to preload/preprocess upcoming image batches while the "
             f"model embeds the current one (default: {DEFAULT_VECTOR_PREFETCH_WORKERS})",
    )
    args = parser.parse_args()
    REFRESH_CACHE = args.refresh_cache

    con = get_db()

    if not args.skip_ingest:
        if args.only in (None, "mtg"):
            ingest_mtg(con)
        if args.only in (None, "pokemon"):
            ingest_pokemon(con, max_workers=args.ingest_workers)
        if args.only in (None, "yugioh"):
            ingest_yugioh(con)

    if not args.skip_images:
        download_images(con, only_game=args.only, max_workers=args.image_workers)

    if not args.skip_vectors:
        build_vectors(con, only_game=args.only, prefetch_workers=args.vector_prefetch_workers)

    # Only safe to clean up once both steps that touch data/card-images/
    # actually ran this time — if either was skipped, the images (or the
    # vectors that still need them) might not be ready yet.
    if not args.skip_images and not args.skip_vectors and not args.keep_images:
        cleanup_local_images(only_game=args.only)

    finalize_db(con)
    total = con.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
    print(f"\nAll done. {total} cards in {DB_PATH}")
    con.close()


if __name__ == "__main__":
    main()