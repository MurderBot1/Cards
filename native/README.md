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
| `cardscan` | recognition behind an `Engine` interface: OpenCV image ops + the identify() pipeline over small detector/OCR/embedder/index interfaces | `scanner.py` *(ONNX adapters still to come)* |
| `binder` | the app: wires the modules together, `/api/*` routes | `app.py` |
| `cardvec`, `cardnet` | vector index, detection/OCR/embedding (ONNX Runtime) | faiss, ultralytics, paddleocr, torch |
| `cardtest` | tiny header-only test helpers | — |

Build and test everything (needs a C++17 compiler and CMake ≥ 3.18; dependencies
are fetched at configure time — nlohmann/json, cpp-httplib):

```
cmake -S native -B build/native
cmake --build build/native --parallel
ctest --test-dir build/native --output-on-failure
```

Run the server (frontend is found in the repo automatically):

```
build/native/binder/binder --port 5000      # add --headless to listen on the LAN
```

Dependencies (nlohmann/json, cpp-httplib, and where there's no system copy SQLite and a
minimal static OpenCV) are fetched at configure time and pinned in `cmake/Deps.cmake`. With
a fetched OpenCV, executables land in `<build>/bin/`.

`cardvec`'s core library is part of this superbuild; `cardnet` is not yet — it needs an ONNX
Runtime download — and is still built/tested on its own. Until its adapters land, a build
has no detector/OCR/embedder, so scans fall back to whatever the catalog + vector index can
answer.

The `difflib` port and the Unicode tables in `cardtext` were checked against CPython on
~200,000 code points and ~8,800 string pairs; expected values in the tests come from Python.
