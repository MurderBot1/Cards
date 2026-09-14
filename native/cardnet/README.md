# cardnet

ONNX Runtime-backed replacements for the three ML frameworks Binder's
scanning pipeline depended on that have no supported Android build path:
**ultralytics** (YOLOv8 card detection), **torch.hub** (DINOv2 art-crop
embedding), and **paddleocr**/**paddlepaddle** (text detection +
recognition). Each keeps using its own already-trained model — nothing
is retrained here — just exported to ONNX once and run through [ONNX
Runtime](https://onnxruntime.ai/), which ships an official Mobile build
with Android support (NNAPI/XNNPACK execution providers) that those
three frameworks don't have.

This is the one piece of Binder's native code that leans on a
third-party library rather than being from-scratch (unlike
`native/cardvec`) — see "Why ONNX Runtime, not hand-written kernels?"
below.

## What's actually from scratch here

Everything *around* the neural net: ONNX Runtime runs the model, cardnet
supplies every pre/post-processing step by hand, matching each
framework's own reference algorithm:

- `src/nms.cpp` — greedy non-maximum suppression for YOLO's raw detection
  head output.
- `src/ctc_decode.cpp` — greedy CTC decoding (argmax + collapse-repeats +
  drop-blank) for the text recognizer's per-timestep character logits.
- `src/geometry.cpp` — convex hull, minimum-area rotated rectangle
  (rotating calipers), and a perspective warp+bilinear-sample — cardnet's
  from-scratch equivalent of `cv2.minAreaRect`/`cv2.warpPerspective`.
- `src/db_postprocess.cpp` — DBNet detection postprocessing: binarize the
  probability map, connected-component the foreground, fit + unclip a
  box per component. Matches PaddleOCR's `DBPostProcess` in its default
  `box_type="quad"`, `score_mode="fast"` configuration.
- `src/yolo_detector.cpp` / `src/dino_embedder.cpp` / `src/ocr_pipeline.cpp`
  — the letterbox/resize/normalize preprocessing and output decoding that
  glues the above into one call per model, matching each framework's own
  reference preprocessing (see comments in each file for the exact
  normalization constants and layout assumptions).

`tests/test_pure_cpp.cpp` unit-tests all of the above against synthetic
data (no model weights needed) — see "Validation" below for exactly what
has and hasn't been checked against the real trained models.

## Layout

```
include/cardnet/          public C++ API
src/                       implementation (see above)
python/bindings.cpp        pybind11 module: YoloDetector, DinoEmbedder, OcrPipeline
export/                    one-time dev scripts: framework model -> ONNX
assets/en_dict.txt         PaddleOCR's English CTC character dictionary
tests/                     test_pure_cpp.cpp (no ORT needed), test_ort_smoke.cpp (needs ORT)
CMakeLists.txt             builds cardnet_core (+ optionally the Python module and/or tests)
pyproject.toml             scikit-build-core config for `pip install .`
```

## Exporting the models (one-time, per model)

Run these on a machine with the *original* framework installed (same as
`build_scanner_models.py` already required torch/ultralytics) — they are
dev-only steps, not part of the app's runtime:

```
python export/export_dino.py   --output backend/data/dinov2_vits14.onnx
python export/export_yolo.py   --weights backend/data/yolo_card_detector.pt \
                                --output backend/data/yolo_card_detector.onnx
python export/export_paddleocr.py --det-model-dir <...> --rec-model-dir <...> \
                                   --output-dir backend/data
```

Each script's own docstring has the full details, including
`export_paddleocr.py`'s note on locating PaddleOCR's cached model
directories (its one step that can't be scripted sight-unseen, since
that cache path is an internal, version-sensitive detail of whatever
paddleocr/paddlex version is installed).

All five output files (`dinov2_vits14.onnx`, `yolo_card_detector.onnx` +
its `.names.json`, `ocr_det.onnx`, `ocr_rec.onnx`, `ocr_dict.txt`) land
in `backend/data/` alongside `cards.duckdb`/`card-vectors.cvi` — the
existing "developer builds these once, ships them with the packaged app
via `packaging/bundled_data/`" convention (see `app/BUILD.md`).

## Building

### Desktop (Windows / macOS / Linux)

1. Download an ONNX Runtime release for your platform from
   [github.com/microsoft/onnxruntime/releases](https://github.com/microsoft/onnxruntime/releases)
   (e.g. `onnxruntime-win-x64-<version>.zip`, `onnxruntime-osx-arm64-<version>.tgz`,
   `onnxruntime-linux-x64-<version>.tgz`) and extract it somewhere.
2. `pip install ./native/cardnet --config-settings=cmake.define.ONNXRUNTIME_ROOT_DIR=/path/to/onnxruntime-<platform>-<version>`

That builds and installs the `cardnet` extension module, matching the
`cardvec` install pattern already documented in `app/BUILD.md`.

### Android

ONNX Runtime ships an official Android build (Java/Kotlin AAR *and* a
C/C++ package) with NNAPI and XNNPACK execution providers — see [ONNX
Runtime's Android docs](https://onnxruntime.ai/docs/build/android.html).
Two ways to bring cardnet along, same split as `native/cardvec`'s README:

- **Plain native library, called over JNI** (no embedded CPython): fetch
  ONNX Runtime's Android C/C++ package (or build it from source with
  `--android` per their docs), then:
  ```sh
  cmake -S native/cardnet -B build-android-arm64 \
    -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" \
    -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-24 \
    -DONNXRUNTIME_ROOT_DIR=/path/to/onnxruntime-android-<version> \
    -DCARDNET_BUILD_PYTHON=OFF
  cmake --build build-android-arm64
  ```
  Link the resulting `libcardnet_core.a` into your own JNI shared
  library, same as `native/cardvec`'s Option A.
- **Python module, if embedding CPython** (e.g. Chaquopy): cross-compile
  the pybind11 module against that toolchain's cross-built CPython and
  ONNX Runtime's Android package, analogous to `native/cardvec`'s Option
  B — the same caveat applies: which Android Python toolchain to use
  hasn't been decided yet for Binder.

## Why ONNX Runtime, not hand-written kernels?

The first pass at "make Binder's ML pipeline buildable for Android" (see
`native/cardvec`) replaced FAISS with ~250 lines of from-scratch C++,
because `IndexFlatIP` is one small, self-contained algorithm. YOLOv8,
DINOv2, and PaddleOCR's detector+recognizer are neural networks —
reimplementing *those* from scratch means writing a general conv2d/
attention/GEMM inference engine, which is realistically a multi-week
undertaking with meaningfully higher correctness risk than using a
runtime that's already solved (and continuously tested against) exactly
that problem. ONNX Runtime keeps the trained weights and architectures
Binder already has; cardnet only reimplements the pre/post-processing
around them, which *is* small and self-contained per model, and is
exactly what's covered by the pure-C++ unit tests in `tests/`.

## Validation

What's been checked in this repo, without any of the actual trained
model files available to test against:

- `tests/test_pure_cpp.cpp`: NMS, CTC decoding, convex hull / min-area
  rect / quad ordering / perspective warp, and DBNet postprocessing —
  all against synthetic data with hand-computable expected results.
- `tests/test_ort_smoke.cpp`: `OrtSession` end-to-end (load a model, bind
  an input tensor, run, extract outputs, surface errors as exceptions)
  against a real ONNX Runtime build and a tiny hand-built ONNX model
  (a single MatMul+Add), checked against the hand-computed expected
  output.

What is **not** yet validated, and needs a developer with the actual
exported models to check: that `yolo_detector.cpp`'s assumed
`(1, 4+num_classes, num_anchors)` output layout, `dino_embedder.cpp`'s
assumed `(1, 384)` direct CLS-token output, and `ocr_pipeline.cpp`'s
assumed `(1, 1, H, W)` detector probability map / `(1, T, num_classes)`
recognizer logits all match what `export_yolo.py`/`export_dino.py`/
`export_paddleocr.py` actually produce for the specific model versions
in use — these are well-documented conventions for each framework's
ONNX export, but "well-documented" isn't "verified against this repo's
actual weights," which wasn't possible without those multi-gigabyte
framework installs in the environment this was written in.
