"""
test_catalog_sqlite.py
-----------------------------------------------------------------
Exercises the SQLite card-catalog code paths in build_scanner_models.py
(write side) and scanner.py (read side) against a small synthetic
catalog built in a temp directory.

Run it directly — no pytest, no network, no ML models, no cardvec/cardnet:

    python app/backend/tests/test_catalog_sqlite.py

This exists because the catalog moved off DuckDB (which has no Android
wheel and isn't in Chaquopy's package repository) onto the standard
library's sqlite3, and that migration has failure modes that only show
up at runtime rather than at import:

  * DuckDB put `.description` on the *connection*; sqlite3 puts it on
    the cursor, so the old `dict(zip([d[0] for d in con.description],
    row))` idiom raises AttributeError. Every call site now relies on
    `row_factory = sqlite3.Row` plus `dict(row)` instead.
  * `UPDATE ... FROM (VALUES ...) AS v(idx, uid)` is valid in DuckDB but
    not in SQLite, which rejects a derived column list on a table alias.
  * sqlite3 forbids sharing a connection across threads by default, and
    Flask serves requests on many.
  * SQLite's `lower()` is ASCII-only where DuckDB's was Unicode-aware, so
    `search()` now matches a stored `name_lower` column instead — without
    it, every card whose name has a non-ASCII uppercase form silently
    stops being findable.
  * A WAL-mode database is up to three files, and this one gets shipped.

Two non-SQLite regressions from the same pass are pinned here too, since
this is where the fixtures already are: the art-vector fallback's
candidate filter (which must be keyed by name, not uid, now that
`_get_names` collapses printings) and `_normalize_title`'s Unicode
handling.

Each of those is asserted below. It does not test OCR, detection,
embedding or vector search — those need real models, and their
algorithms have their own tests under native/cardvec and native/cardnet.
-----------------------------------------------------------------
"""
import difflib
import os
import pathlib
import sqlite3
import sys
import tempfile
import threading
import types

# Some of the assertions below print non-Latin card names, and a Windows
# console defaults to a codepage that can't encode them — which would fail
# the run inside print() rather than on an actual assertion.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):  # pragma: no cover - non-reconfigurable stream
    pass

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
TMP = pathlib.Path(tempfile.mkdtemp(prefix="binder_catalog_test_"))
(TMP / "data").mkdir()

# scanner.py reads this at import time (normally set by paths.py).
os.environ["BINDER_DATA_DIR"] = str(TMP / "data")
sys.path.insert(0, str(BACKEND_DIR))

CARDS = [
    {"uid": "mtg-1", "game": "mtg", "name": "Lightning Bolt", "set_code": "LEA",
     "set_name": "Alpha", "collector_number": "161", "rarity": "common",
     "passcode": "", "image_url": "http://example/1.jpg"},
    {"uid": "mtg-2", "game": "mtg", "name": "Lightning Bolt", "set_code": "M10",
     "set_name": "Magic 2010", "collector_number": "146", "rarity": "common",
     "passcode": "", "image_url": "http://example/2.jpg"},
    {"uid": "mtg-3", "game": "mtg", "name": "Black Lotus", "set_code": "LEA",
     "set_name": "Alpha", "collector_number": "232", "rarity": "rare",
     "passcode": "", "image_url": "http://example/3.jpg"},
    {"uid": "ygo-1", "game": "yugioh", "name": "Dark Magician", "set_code": "LOB",
     "set_name": "Legend of Blue Eyes", "collector_number": "005",
     "rarity": "ultra", "passcode": "46986414", "image_url": "http://example/4.jpg"},
    {"uid": "pkm-1", "game": "pokemon", "name": "Charizard", "set_code": "BS",
     "set_name": "Base Set", "collector_number": "4", "rarity": "rare",
     "passcode": "", "image_url": "http://example/5.jpg"},
    # Scryfall's all_cards dump carries every language a card was printed
    # in. These two pin the Unicode handling that an ASCII-only lower() or
    # an ASCII-only normalization regex would silently break.
    {"uid": "mtg-4", "game": "mtg", "name": "Übermut", "set_code": "GER",
     "set_name": "German Printing", "collector_number": "12", "rarity": "uncommon",
     "passcode": "", "image_url": "http://example/6.jpg"},
    {"uid": "mtg-5", "game": "mtg", "name": "稲妻の剣", "set_code": "JPN",
     "set_name": "Japanese Printing", "collector_number": "77", "rarity": "rare",
     "passcode": "", "image_url": "http://example/7.jpg"},
]


def load_build_helpers():
    """Loads build_scanner_models.py's DB helpers without its heavy
    module-scope imports (requests/PIL/tqdm/cv2/numpy and the two native
    modules), none of which the catalog code under test touches. Stubbing
    them keeps this runnable in a bare checkout."""
    for name in ("requests", "PIL", "PIL.Image", "tqdm", "cv2", "numpy",
                 "cardnet", "cardvec"):
        if name not in sys.modules:
            mod = types.ModuleType(name)
            mod.__path__ = []
            sys.modules[name] = mod
    sys.modules["requests"].Session = lambda: types.SimpleNamespace(headers={})
    sys.modules["requests"].HTTPError = type("HTTPError", (Exception,), {})
    sys.modules["PIL"].Image = sys.modules["PIL.Image"]
    sys.modules["tqdm"].tqdm = lambda it, **kw: it

    path = BACKEND_DIR / "build_scanner_models.py"
    ns = {"__name__": "build_scanner_models_under_test", "__file__": str(path)}
    exec(compile(path.read_text(encoding="utf-8"), str(path), "exec"), ns)
    # Redirect writes to the temp dir instead of the real backend/data/.
    ns["DATA_DIR"] = TMP / "data"
    ns["DB_PATH"] = TMP / "data" / "cards.sqlite3"
    return ns


def check(label, condition, detail=""):
    if not condition:
        raise AssertionError(f"{label} {detail}".strip())
    print(f"[ok] {label}" + (f" -> {detail}" if detail else ""))


def test_write_side(bsm):
    con = bsm["get_db"]()
    check("get_db() creates cards.sqlite3", bsm["DB_PATH"].exists())

    indexes = {r[1] for r in con.execute("PRAGMA index_list(cards)")}
    expected = {"idx_cards_game_set_num", "idx_cards_game_passcode",
                "idx_cards_game_name", "idx_cards_vector_idx",
                "idx_cards_game_collector_number"}
    check("every lookup index was created", expected <= indexes,
          str(sorted(expected - indexes)) + " missing")

    # The trailing duplicate exercises the in-batch dedupe (last wins).
    bsm["flush_card_batch"](con, CARDS + [dict(CARDS[0])])
    con.commit()
    count = con.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
    check("flush_card_batch inserted, deduping by uid", count == len(CARDS), str(count))

    bsm["flush_card_batch"](con, [dict(CARDS[2], rarity="mythic")])
    con.commit()
    rarity = con.execute("SELECT rarity FROM cards WHERE uid='mtg-3'").fetchone()[0]
    check("ON CONFLICT (uid) DO UPDATE re-ingests cleanly", rarity == "mythic", rarity)

    bsm["upsert_card"](con, dict(CARDS[0]))
    con.commit()

    # SQLite rejects DuckDB's `(VALUES ...) AS v(idx, uid)` alias form.
    bsm["_bulk_update_vector_idx"](
        con, [(i, row["uid"]) for i, row in enumerate(CARDS)])
    con.commit()
    got = dict(con.execute("SELECT uid, vector_idx FROM cards").fetchall())
    want = {row["uid"]: i for i, row in enumerate(CARDS)}
    check("_bulk_update_vector_idx backfilled every row", got == want, str(got))
    con.close()


def test_read_side(scanner):
    check("scanner.DB_PATH points at the SQLite catalog",
          scanner.DB_PATH == TMP / "data" / "cards.sqlite3", str(scanner.DB_PATH))
    check("is_ready() true once a catalog exists", scanner.is_ready())

    con = scanner._get_db()
    check("_get_db() returned a connection", con is not None)

    card = scanner._lookup(con, "mtg", set_code="M10", collector_number="146")
    check("_lookup by set_code+collector_number",
          card["uid"] == "mtg-2" and card["set_name"] == "Magic 2010", card["uid"])
    check("dict(row) carried every column", len(card) == 12, f"{len(card)} columns")
    check("_lookup miss returns None",
          scanner._lookup(con, "mtg", set_code="ZZZ", collector_number="1") is None)
    check("_lookup by yugioh passcode",
          scanner._lookup(con, "yugioh", passcode="46986414")["uid"] == "ygo-1")

    try:
        con.execute("UPDATE cards SET name='x' WHERE uid='mtg-1'")
        con.commit()
        raise AssertionError("mode=ro connection accepted a write")
    except sqlite3.OperationalError as exc:
        check("mode=ro rejects writes", "readonly" in str(exc), str(exc))

    # the query _art_lookup() runs per vector hit
    row = con.execute("SELECT * FROM cards WHERE vector_idx = ? AND game = ?",
                      [2, "mtg"]).fetchone()
    check("vector_idx lookup plus dict(row)", dict(row)["uid"] == "mtg-3")

    # the query _best_printing_by_art() runs to enumerate printings
    prints = sorted(tuple(r) for r in con.execute(
        "SELECT uid, vector_idx FROM cards WHERE game = ? AND name = ? "
        "AND vector_idx IS NOT NULL", ["mtg", "Lightning Bolt"]))
    check("printings-of-a-name query", prints == [("mtg-1", 0), ("mtg-2", 1)], str(prints))
    con.close()

    check("search() prefix and substring",
          [c["id"] for c in scanner.search("mtg", "lightning")] == ["mtg-1", "mtg-2"])
    check("search() with no query returns all games",
          len(scanner.search(None, "")) == len(CARDS))
    results = scanner.search("mtg", "bolt")
    check("search() matches mid-name",
          [c["id"] for c in results] == ["mtg-1", "mtg-2"])
    check("search() shapes rows for the API",
          results[0]["set"] == "LEA" and results[0]["image"] == "http://example/1.jpg")

    # SQLite's own lower() is ASCII-only, so these only work because
    # build_scanner_models.py stores a Python-lowercased name_lower column.
    check("search() finds an accented name by lowercase query",
          [c["id"] for c in scanner.search("mtg", "übermut")] == ["mtg-4"])
    check("search() finds a non-Latin name",
          [c["id"] for c in scanner.search("mtg", "稲妻")] == ["mtg-5"])


def test_fuzzy_matching(scanner):
    names = scanner._get_names("mtg")
    check("_get_names collapses printings to unique names",
          names == {"lightning bolt": "mtg-1", "black lotus": "mtg-3",
                    "übermut": "mtg-4", "稲妻の剣": "mtg-5"}, str(names))
    check("_normalize_title keeps non-Latin scripts intact",
          scanner._normalize_title("稲妻の剣!") == "稲妻の剣")
    check("_normalize_title keeps accented characters",
          scanner._normalize_title("Übermut") == "übermut")
    check("_normalize_title strips punctuation and case",
          scanner._normalize_title("  Sol  Ring, the/BEST! ") == "sol ring the best")

    # Representative OCR damage. These are sanity checks on the difflib
    # scorer that replaced rapidfuzz, not a claim about real-world accuracy;
    # see scanner.FUZZY_MATCH_THRESHOLD on why that threshold needs tuning
    # against real scans rather than against these.
    cases = [
        ("Lightning Bolt", "mtg-1"),   # clean read
        ("L1ghtning B0lt", "mtg-1"),   # digit-for-letter, the classic OCR slip
        ("lightnin bolt", "mtg-1"),    # dropped character
        ("BLACK LOTUS", "mtg-3"),      # case only
    ]
    for ocr, expected_uid in cases:
        text = scanner._normalize_title(ocr)
        close = difflib.get_close_matches(
            text, names.keys(), n=5, cutoff=scanner.FUZZY_CANDIDATE_CUTOFF)
        check(f"fuzzy {ocr!r} produced a candidate", bool(close))
        score = difflib.SequenceMatcher(None, text, close[0]).ratio() * 100.0
        check(f"fuzzy {ocr!r} matched {close[0]!r} at {score:.1f}",
              names[close[0]] == expected_uid
              and score >= scanner.FUZZY_MATCH_THRESHOLD)

    text = scanner._normalize_title("Completely Unrelated Gibberish")
    close = difflib.get_close_matches(
        text, names.keys(), n=5, cutoff=scanner.FUZZY_CANDIDATE_CUTOFF)
    accepted = bool(close) and (
        difflib.SequenceMatcher(None, text, close[0]).ratio() * 100.0
        >= scanner.FUZZY_MATCH_THRESHOLD)
    check("an unrelated title is not accepted outright", not accepted)


def test_art_lookup_candidate_filter(scanner):
    """_art_lookup() filters vector hits by *name*, and that distinction is
    load-bearing.

    The cardvec index has one row per printing, but the fuzzy candidates
    upstream are one per unique name (_get_names collapses them). An
    earlier version filtered by uid, which meant a vector hit on any
    printing except the one representing its name got discarded — turning
    the whole art fallback into a silent no-op for most cards. This pins
    the fix by pointing the index at the *second* printing of a name whose
    representative uid is the first.

    The vector index and the embedder are stubbed: this is about the
    candidate filter and the SQL behind it, not about embedding quality.
    """
    representative = scanner._get_names("mtg")["lightning bolt"]
    check("the collapsed name is represented by the first printing",
          representative == "mtg-1", representative)

    class FakeIndex:
        """Returns vector_idx 1 (= mtg-2) as the top hit."""
        ntotal = len(CARDS)

        def search(self, vec, k):
            return [[0.99, 0.5]], [[1, 0]]

    original_index, original_embed = scanner._get_vector_index, scanner._embed_art
    scanner._get_vector_index = lambda: FakeIndex()
    scanner._embed_art = lambda warped, game: [[0.0]]
    try:
        con = scanner._get_db()
        try:
            card = scanner._art_lookup(con, None, ["mtg"], {"lightning bolt"})
            check("art fallback accepts a non-representative printing",
                  card is not None and card["uid"] == "mtg-2",
                  card["uid"] if card else "None (the uid-filter regression)")

            card = scanner._art_lookup(con, None, ["mtg"], {"black lotus"})
            check("art fallback still rejects a hit outside the candidates",
                  card is None, card["uid"] if card else "None")

            card = scanner._art_lookup(con, None, ["mtg"], None)
            check("art fallback with no candidate set takes the top hit",
                  card is not None and card["uid"] == "mtg-2")
        finally:
            con.close()
    finally:
        scanner._get_vector_index, scanner._embed_art = original_index, original_embed


def test_finalize_db(bsm):
    """finalize_db() has to leave a single self-contained file behind: the
    catalog gets copied into an installer or pushed to a device, and a WAL
    database is really up to three files (see the function's docstring)."""
    db_path = bsm["DB_PATH"]
    con = bsm["get_db"]()
    mode = con.execute("PRAGMA journal_mode").fetchone()[0]
    check("ingest runs in WAL mode", mode.lower() == "wal", mode)

    bsm["finalize_db"](con)
    mode = con.execute("PRAGMA journal_mode").fetchone()[0]
    check("finalize_db leaves the file out of WAL mode", mode.lower() == "delete", mode)
    con.close()

    leftovers = [p.name for p in db_path.parent.glob(db_path.name + "-*")]
    check("no -wal/-shm sidecar files remain", not leftovers, str(leftovers))

    # The whole point: it must still be readable, and complete, afterwards.
    con = sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)
    count = con.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
    con.close()
    check("the finalized catalog opens read-only with every row intact",
          count == len(CARDS), str(count))


def test_thread_safety(scanner):
    """sqlite3 raises if a connection crosses threads. _get_db() opens a
    fresh one per call and every caller closes it in a finally — this
    guards against someone later turning that into a cached singleton the
    way the ONNX/cardvec objects are."""
    errors = []

    def worker():
        try:
            for _ in range(20):
                con = scanner._get_db()
                try:
                    row = scanner._lookup(con, "mtg", set_code="LEA",
                                          collector_number="232")
                    assert row["uid"] == "mtg-3", row
                finally:
                    con.close()
        except Exception as exc:  # noqa: BLE001 - collected and reported below
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    check("8 threads x 20 lookups without a cross-thread error", not errors, str(errors))


def main():
    bsm = load_build_helpers()
    test_write_side(bsm)

    import scanner
    test_read_side(scanner)
    test_fuzzy_matching(scanner)
    test_art_lookup_candidate_filter(scanner)
    test_thread_safety(scanner)
    # Last: it takes the catalog out of WAL mode, which is the state it
    # ships in but not the state the rest of these tests exercise.
    test_finalize_db(bsm)
    print(f"\nALL PASS  (scratch catalog: {TMP})")


if __name__ == "__main__":
    main()
