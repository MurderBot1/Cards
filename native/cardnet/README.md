# cardnet

Runs Binder's three trained models through [ONNX Runtime](https://onnxruntime.ai/): **YOLOv8** card detection,
**DINOv2** art-crop embedding, and **PaddleOCR** text detection + recognition. Each uses its own already-trained model —
nothing is retrained here — exported to ONNX once (see "Exporting the models") and run on ONNX Runtime, which ships an
official build for every platform Binder targets, Android included (NNAPI/XNNPACK execution providers).

This is the one piece of Binder's native code that leans on a third-party library rather than being from-scratch
(unlike `native/cardvec`) — see "Why ONNX Runtime, not hand-written kernels?" below. `native/cardonnx` adapts it to the
scanner's backend interfaces.

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
export/                    one-time developer scripts: trained model -> ONNX  (the only Python in the repo)
assets/en_dict.txt         PaddleOCR's English CTC character dictionary
tests/                     test_pure_cpp.cpp (no ORT needed), test_ort_smoke.cpp (needs ORT + a tiny model file)
CMakeLists.txt             builds cardnet_core (+ the tests with -DCARDNET_BUILD_TESTS=ON)
```

## Exporting the models (one-time, per model)

This is the one step that can't be done in C++: converting a trained PyTorch / Ultralytics / PaddleOCR model into an
ONNX file needs that framework itself. The scripts in `export/` are developer-only tooling, run once on a machine with
the original framework installed — they are not part of the app, its build, or its tests:

```
pip install torch                 # export_dino.py
python export/export_dino.py   --output <data dir>/dinov2_vits14.onnx
pip install ultralytics           # export_yolo.py
python export/export_yolo.py   --weights <data dir>/yolo_card_detector.pt --output <data dir>/yolo_card_detector.onnx
pip install paddleocr             # export_paddleocr.py
python export/export_paddleocr.py --det-model-dir <...> --rec-model-dir <...> --output-dir <data dir>
```

`<data dir>` is Binder's data directory (see [BUILDING.md](../../BUILDING.md)). Each script's own docstring has the full
details, including `export_paddleocr.py`'s note on locating PaddleOCR's cached model directories (an internal,
version-sensitive detail of whichever paddleocr/paddlex version is installed).

The five output files (`dinov2_vits14.onnx`, `yolo_card_detector.onnx` + its `.names.json`, `ocr_det.onnx`,
`ocr_rec.onnx`, `ocr_dict.txt`) land next to `cards.sqlite3` and `card-vectors.cvi`. None of them is required: without a
model the scanner skips that stage (no detector -> contour-based card detection; no OCR -> art matching only; no
embedder -> no art matching).

## Building

Part of the app's build (`native/CMakeLists.txt`, see [BUILDING.md](../../BUILDING.md)), which downloads a prebuilt ONNX
Runtime for the platform — `-DBINDER_WITH_ONNX=OFF` builds without it. Standalone, point CMake at an extracted
[ONNX Runtime release](https://github.com/microsoft/onnxruntime/releases) (`<root>/include` and `<root>/lib`):

```
cmake -S native/cardnet -B build/cardnet -DONNXRUNTIME_ROOT_DIR=/path/to/onnxruntime-<platform>-<version> -DCARDNET_BUILD_TESTS=ON
```

On Android the build in `android/` fetches ONNX Runtime's official AAR (headers + one `libonnxruntime.so` per ABI) and
links against it; Gradle packages the same release's library into the APK.

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
  (a single MatMul+Add; takes the model path as an argument, so it is not part of `ctest`).
- `native/cardonnx/tests`: `DinoEmbedder` and the whole recognition pipeline against a real ONNX Runtime with a
  hand-assembled ONNX graph (`ReduceMean`, whose output is the per-channel mean of the normalized image — computable
  by hand), end to end through the data directory.

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
