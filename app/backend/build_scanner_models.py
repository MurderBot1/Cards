"""
build_scanner_models.py
-----------------------------------------------------------------
Builds everything scanner.py needs to recognize MTG / Pokémon /
Yu-Gi-Oh! cards:

  1. Ingests bulk card data into DuckDB (data/cards.duckdb):
       - MTG:        Scryfall "all_cards" bulk export (every printing,
                      including extra languages/promos)
       - Pokémon:    PokemonTCG/pokemon-tcg-data (GitHub, per-set JSON)
       - Yu-Gi-Oh!:  YGOPRODeck cardinfo.php bulk export
     Every bulk download is cached as raw JSON under data/cache/, so
     re-running the script re-uses what it already fetched instead of
     re-downloading (pass --refresh-cache to force a fresh pull).
  2. Downloads a small art-crop image per card into
       data/card-images/<game>/<uid>.jpg
     — purely a scratch copy used to compute step 3's vectors. The app
     itself never reads these; it loads card art straight from each
     card's image_url (Scryfall / PokemonTCG / YGOPRODeck), which is
     stored in DuckDB during ingest.
  3. Embeds every art crop with DINOv2 (dinov2_vits14, via torch.hub)
     and builds a FAISS cosine-similarity index over all of them
     (data/card-vectors.faiss), recording which DuckDB row each
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
already in DuckDB, images already on disk, vectors already indexed,
bulk downloads already cached in data/cache/), so if it gets
interrupted partway through, just run it again.

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
import io
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import duckdb
import requests
from PIL import Image
from tqdm import tqdm

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
IMAGES_DIR = DATA_DIR / "card-images"
CACHE_DIR = DATA_DIR / "cache"
DB_PATH = DATA_DIR / "cards.duckdb"
FAISS_PATH = DATA_DIR / "card-vectors.faiss"

HTTP_TIMEOUT = 30
REQUEST_PAUSE_SEC = 0.05  # be polite to the free APIs we're hitting

DINO_INPUT_SIZE = 224
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


def preprocess_for_dino(pil_image):
    """Resize-shorter-side + center-crop + normalize, by hand — deliberately
    NOT using torchvision.transforms here. torchvision ships as a separate
    package from torch with its own version compatibility matrix, and
    pulling it in (directly, or transitively via ultralytics) is a common
    source of 'operator torchvision::nms does not exist'-style breakage
    if the two versions don't line up. This needs numpy, ubiquitous, and
    torch, which we need anyway — nothing else."""
    import numpy as np
    import torch

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

# When true (--refresh-cache), cached_get_json ignores whatever's on disk
# and re-downloads. Set by main() before any ingest_* function runs.
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


def get_db():
    DATA_DIR.mkdir(exist_ok=True)
    con = duckdb.connect(str(DB_PATH))
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS cards (
            uid VARCHAR PRIMARY KEY,
            game VARCHAR,
            name VARCHAR,
            set_code VARCHAR,
            set_name VARCHAR,
            collector_number VARCHAR,
            rarity VARCHAR,
            passcode VARCHAR,
            image_url VARCHAR,   -- source URL, used to download the local copy
            image_path VARCHAR,  -- relative path under data/card-images once downloaded
            vector_idx INTEGER   -- row index into the FAISS index, once embedded
        )
        """
    )
    return con


def upsert_card(con, row):
    con.execute(
        """
        INSERT INTO cards (uid, game, name, set_code, set_name, collector_number,
                            rarity, passcode, image_url, image_path, vector_idx)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT (uid) DO UPDATE SET
            name=excluded.name, set_code=excluded.set_code, set_name=excluded.set_name,
            collector_number=excluded.collector_number, rarity=excluded.rarity,
            passcode=excluded.passcode, image_url=excluded.image_url
        """,
        [row["uid"], row["game"], row["name"], row.get("set_code", ""), row.get("set_name", ""),
         row.get("collector_number", ""), row.get("rarity", ""), row.get("passcode", ""),
         row.get("image_url", "")],
    )


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
    print(f"[mtg] downloading {all_cards_entry['size'] / 1e6:.0f}MB card dump "
          f"(cached at {CACHE_DIR / 'scryfall_all_cards.json'})...")
    cards = cached_get_json(all_cards_entry["download_uri"], "scryfall_all_cards", timeout=120)
    print(f"[mtg] ingesting {len(cards)} printings...")

    for c in tqdm(cards, desc="mtg"):
        if c.get("layout") in ("art_series", "token", "double_faced_token"):
            continue
        image_url = None
        if "image_uris" in c:
            image_url = c["image_uris"].get("normal")
        elif c.get("card_faces") and "image_uris" in c["card_faces"][0]:
            image_url = c["card_faces"][0]["image_uris"].get("normal")
        upsert_card(con, {
            "uid": f"mtg-{c['id']}",
            "game": "mtg",
            "name": c["name"],
            "set_code": (c.get("set") or "").upper(),
            "set_name": c.get("set_name", ""),
            "collector_number": c.get("collector_number", ""),
            "rarity": (c.get("rarity") or "").capitalize(),
            "image_url": image_url or "",
        })
    con.commit()
    print("[mtg] done.")


# =====================================================================
# 1b. Pokémon — PokemonTCG/pokemon-tcg-data on GitHub (raw JSON, per set)
# =====================================================================
DEFAULT_INGEST_WORKERS = 16


def _fetch_pokemon_set(set_id):
    """Runs in a worker thread: does the network GET (or cache read) for one
    set's card list only. No DuckDB access — writes happen back on the main
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
            for c in cards:
                image_url = (c.get("images") or {}).get("large") or (c.get("images") or {}).get("small")
                upsert_card(con, {
                    "uid": f"pkm-{c['id']}",
                    "game": "pokemon",
                    "name": c.get("name", ""),
                    "set_code": s.get("ptcgoCode", set_id).upper(),
                    "set_name": s.get("name", ""),
                    "collector_number": c.get("number", ""),
                    "rarity": c.get("rarity", "") or "",
                    "image_url": image_url or "",
                })
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

    for c in tqdm(cards, desc="yugioh"):
        passcode = str(c.get("id", ""))
        image_url = ""
        if c.get("card_images"):
            image_url = c["card_images"][0].get("image_url", "")
        card_sets = c.get("card_sets") or [{}]
        for cs in card_sets:
            set_code = cs.get("set_code", "")
            uid = f"ygo-{passcode}-{set_code}" if set_code else f"ygo-{passcode}"
            upsert_card(con, {
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
    No DuckDB access here — duckdb connections aren't safe to share across
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
# 3. Embed every downloaded image with DINOv2 and build a FAISS index
# =====================================================================
def build_vectors(con, only_game=None, batch_size=32):
    import faiss
    import torch

    where = "image_path IS NOT NULL AND vector_idx IS NULL"
    if only_game:
        where += f" AND game = '{only_game}'"
    rows = con.execute(f"SELECT uid, image_path FROM cards WHERE {where}").fetchall()
    print(f"[vectors] {len(rows)} cards to embed...")
    if not rows:
        print("[vectors] nothing to do.")
        return

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[vectors] loading DINOv2 (dinov2_vits14) on {device}...")
    model = torch.hub.load("facebookresearch/dinov2", "dinov2_vits14")
    model.eval().to(device)

    # load (or create) the FAISS index, and figure out where new vectors
    # should start being appended so uid <-> row-index stays consistent
    dim = 384  # dinov2_vits14 embedding size
    if FAISS_PATH.exists():
        index = faiss.read_index(str(FAISS_PATH))
    else:
        index = faiss.IndexFlatIP(dim)
    next_idx = index.ntotal

    def load_batch(batch_rows):
        tensors, uids = [], []
        for uid, image_path in batch_rows:
            full_path = IMAGES_DIR / image_path
            try:
                img = Image.open(full_path).convert("RGB")
                tensors.append(preprocess_for_dino(img))
                uids.append(uid)
            except Exception as e:
                print(f"[vectors] skip {uid}: {e}", file=sys.stderr)
        return tensors, uids

    for i in tqdm(range(0, len(rows), batch_size), desc="vectors"):
        batch_rows = rows[i:i + batch_size]
        tensors, uids = load_batch(batch_rows)
        if not tensors:
            continue
        batch = torch.stack(tensors).to(device)
        with torch.no_grad():
            emb = model(batch).cpu().numpy().astype("float32")
        faiss.normalize_L2(emb)  # so inner product == cosine similarity
        index.add(emb)
        for j, uid in enumerate(uids):
            con.execute("UPDATE cards SET vector_idx=? WHERE uid=?", [next_idx + j, uid])
        next_idx += len(uids)
        con.commit()
        faiss.write_index(index, str(FAISS_PATH))  # persist incrementally

    print(f"[vectors] done — {index.ntotal} vectors in {FAISS_PATH}")


# =====================================================================
# 4. Delete the local art-crop images once they're no longer needed
# =====================================================================
def cleanup_local_images(only_game=None):
    """The images under data/card-images/ are only ever needed transiently,
    to compute the DINOv2/FAISS vectors in build_vectors() above — the app
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
        help="don't delete data/card-images/ after the FAISS vectors are built "
             "(useful for debugging what got downloaded/embedded)",
    )
    parser.add_argument(
        "--refresh-cache", action="store_true",
        help="ignore data/cache/*.json and re-download bulk data instead of reusing it",
    )
    parser.add_argument(
        "--image-workers", type=int, default=DEFAULT_IMAGE_WORKERS,
        help=f"number of concurrent image-download threads (default: {DEFAULT_IMAGE_WORKERS})",
    )
    parser.add_argument(
        "--ingest-workers", type=int, default=DEFAULT_INGEST_WORKERS,
        help=f"number of concurrent per-set download threads for Pokemon ingest (default: {DEFAULT_INGEST_WORKERS})",
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
        build_vectors(con, only_game=args.only)

    # Only safe to clean up once both steps that touch data/card-images/
    # actually ran this time — if either was skipped, the images (or the
    # vectors that still need them) might not be ready yet.
    if not args.skip_images and not args.skip_vectors and not args.keep_images:
        cleanup_local_images(only_game=args.only)

    total = con.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
    print(f"\nAll done. {total} cards in {DB_PATH}")
    con.close()


if __name__ == "__main__":
    main()