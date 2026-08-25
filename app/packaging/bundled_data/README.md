# Bundling a prebuilt card catalog (optional)

`backend/build_scanner_models.py` produces:

```
backend/data/
  cards.duckdb
  card-vectors.faiss
  yolo_card_detector.pt
```

That build is slow, network-heavy, and needs the full ML dev toolchain
(torch, ultralytics, etc.) — not something an end user should run.
You have two options for a packaged app:

**Ship without it (default).** Don't put anything in this folder. The
packaged app starts up fine; scanning just returns "the card catalog
hasn't been built yet" (see `scanner.is_ready()` in `scanner.py`) until
someone points `BINDER_DATA_DIR` at a catalog built separately, or you
switch to option 2 and rebuild the installer.

**Ship with it.** Copy the three files above into this folder before
running `packaging/build.py` (or `pyinstaller packaging/binder.spec`
directly) and they'll be bundled into the app under `data/`.
`backend/paths.py` copies them into the user's per-user app-data
directory the first time the packaged app runs, so scanning works out
of the box.

Trade-off: `cards.duckdb` covering all three games plus the FAISS
vector index plus YOLO weights can easily be several hundred MB to a
few GB, on top of the ~1-2GB the torch/paddleocr/paddlepaddle runtime
already adds to every build. That's the real size of the installer
either way — bundling the catalog just moves *when* the user pays for
it (in the download) instead of a separate first-run step you'd have
to build yourself.

This folder is otherwise empty on purpose — nothing here is required
for `packaging/binder.spec` to work.