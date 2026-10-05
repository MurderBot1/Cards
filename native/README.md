# native/ — Binder's C++ modules

Each concern is its own small library with its own tests, in the same style as
`cardvec` / `cardnet`:

| Module | Role | Replaces (Python) |
|---|---|---|
| `cardlog` | rotating `api.log`, best-effort `startup.log` | `logging` setup in `app.py`, `paths._startup_log` |
| `cardpaths` | where db / logs / catalog / frontend live, per OS | `paths.py` |
| `cardstore` | collections + settings in `db.json`, validation, stacking rules | `load_db` / the collection routes in `app.py` |
| `cardtext` | Unicode title normalization, a faithful `difflib` port, OCR identifier patterns | `_normalize_title`, `difflib` use, the `*_RE` patterns in `scanner.py` |
| `cardcatalog` | the SQLite catalog: schema, read-only `Reader`, bulk-ingest `Writer` | the sqlite3 code in `scanner.py` and `build_scanner_models.py` |
| `cardhttp` | HTTP server: routes, path params, multipart, static files, access log | Flask |
| `cardauth` | LoginServer TCP client (`LOGIN` / `REGISTER`) | `_login_server_command` |
| `cardscan` | recognition behind an `Engine` interface: OpenCV image ops + the identify() pipeline over small detector/OCR/embedder/index interfaces | `scanner.py` |
| `cardonnx` | ONNX Runtime-backed detector / OCR / embedder (via `cardnet`), loaded from the data directory | `cardnet.*` calls in `scanner.py` |
| `cardview` | the native window around the system web view (WebKitGTK / WKWebView / WebView2), via `webview/webview` | pywebview |
| `cardfetch` | HTTP client (libcurl), on-disk cache, streaming gzipped-JSONL reader — for the catalog builder | `requests` / the cache helpers in `build_scanner_models.py` |
| `cardingest` | Scryfall / PokemonTCG / YGOPRODeck bulk data -> catalog rows | `ingest_mtg` / `ingest_pokemon` / `ingest_yugioh` |
| `cardvectors` | image download, batched embedding, crash-safe vector-index building | `download_images` / `build_vectors` |
| `catalogtool` | the `binder-catalog` executable that runs the above | `build_scanner_models.py` |
| `binder` | the app: `binder::App` (store + engine + server + `/api/*` routes), `main()` and the packaging | `app.py` |
| `binder_android` | the JNI library the Android app loads | Chaquopy + `android_main.py` |
| `cardvec`, `cardnet` | vector index, detection/OCR/embedding (ONNX Runtime) | faiss, ultralytics, paddleocr, torch |
| `cardtest` | tiny header-only test helpers | — |

Build and test everything (needs a C++17 compiler and CMake ≥ 3.18; dependencies
are fetched at configure time — nlohmann/json, cpp-httplib):

```
cmake -S native -B build/native
cmake --build build/native --parallel
ctest --test-dir build/native --output-on-failure
```

Run the app (the frontend is found in the repo automatically):

```
build/native/bin/binder                  # opens the window
build/native/bin/binder --headless       # no window: serve the LAN on port 5000 instead
```

The window needs the platform's web view: on Linux, `libgtk-3-dev` and `libwebkit2gtk-4.1-dev` to build and
WebKitGTK at runtime; configure with `-DBINDER_WITH_VIEW=OFF` to build without it (the app then just serves).
The `cardview` test opens a real window, so under CI it runs inside `xvfb-run`; with no display it's skipped.

Dependencies (nlohmann/json, cpp-httplib, webview, ONNX Runtime, and where there's no system copy SQLite and a
minimal static OpenCV) are fetched at configure time and pinned in `cmake/Deps.cmake`. Executables land in `<build>/bin/`.
Options, packaging and everything else about building is in [BUILDING.md](../BUILDING.md).

`cardvec` and `cardnet` are built by this superbuild too. `cardnet` needs ONNX Runtime, which is downloaded for your platform at
configure time; pass `-DBINDER_WITH_ONNX=OFF` to build without it, in which case scans skip the
detector / OCR / embedder stages and answer from whatever the catalog + vector index can.

Trained models are not in the repo: put the exported `.onnx` files (see `cardnet/export/`) in the
data directory next to `cards.sqlite3` and `card-vectors.cvi`.

The `difflib` port and the Unicode tables in `cardtext` were checked against CPython on
~200,000 code points and ~8,800 string pairs; expected values in the tests come from Python.
