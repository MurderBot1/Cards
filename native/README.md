# native/ — Binder's C++ modules

Each concern is its own small library with its own tests, in the same style as
`cardvec` / `cardnet`:

| Module | Role | Replaces (Python) |
|---|---|---|
| `cardlog` | rotating `api.log`, best-effort `startup.log` | `logging` setup in `app.py`, `paths._startup_log` |
| `cardpaths` | where db / logs / catalog / frontend live, per OS | `paths.py` |
| `cardstore` | collections + settings in `db.json`, validation, stacking rules | `load_db` / the collection routes in `app.py` |
| `cardhttp` | HTTP server: routes, path params, multipart, static files, access log | Flask |
| `cardauth` | LoginServer TCP client (`LOGIN` / `REGISTER`) | `_login_server_command` |
| `cardscan` | recognition behind an `Engine` interface | `scanner.py` *(interface only so far)* |
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

`cardvec` and `cardnet` are not part of this superbuild yet — `cardnet` needs an
ONNX Runtime download — and are still built/tested on their own.
