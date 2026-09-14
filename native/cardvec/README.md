# cardvec

A small, from-scratch C++ library that replaces the *one* FAISS feature
Binder actually uses — `faiss.IndexFlatIP` (brute-force cosine similarity
search over DINOv2 art-crop embeddings) plus `normalize_L2` /
`read_index` / `write_index` — with something that cross-compiles cleanly
for Android. Real FAISS pulls in a BLAS backend and a SWIG-generated
binding layer that aren't practical to cross-compile with the NDK; this
library is ~250 lines of portable C++ with an optional AVX2 (x86_64) /
NEON (arm64) dot-product fast path and a few `std::thread` workers for
the search loop, so there's nothing FAISS-specific left to build.

It is **not** a general FAISS replacement. There's no IVF/PQ/HNSW and no
GPU path — just exact brute-force search, which is exactly what Binder's
`IndexFlatIP` usage already was. Binder's card-art catalogs are tens of
thousands of 384-dim vectors; brute force over that is comfortably
sub-millisecond per query with SIMD, so there was nothing to gain from
reimplementing an approximate index.

## Layout

```
include/cardvec/flat_index.hpp   public C++ API (FlatIndexIP, normalize_L2)
src/dot.hpp                      AVX2 / NEON / scalar dot-product kernel
src/flat_index.cpp               add/search/save/load implementation
python/bindings.cpp              pybind11 module (mirrors the faiss API subset used)
tests/test_flat_index.cpp        dependency-free C++ self-test (no Python)
CMakeLists.txt                   builds the core lib, the Python module, and/or the self-test
pyproject.toml                   scikit-build-core config, so `pip install .` "just works" on desktop
```

## Desktop build (Windows / macOS / Linux) — what Binder's backend uses

```
pip install ./native/cardvec
```

That builds `cardvec_core` (static) plus the `cardvec` pybind11 extension
module via CMake (driven by `scikit-build-core`) and installs it into
your venv/site-packages, same as any other compiled Python package.
Requires a C++17 compiler (MSVC on Windows, clang on macOS, gcc/clang on
Linux) and CMake ≥ 3.18 — both already needed to build the rest of
Binder's dependency stack (torch, ultralytics, paddleocr).

`app/backend/scanner.py` and `app/backend/build_scanner_models.py` do
`import cardvec as faiss` and otherwise use the exact same calls
(`faiss.IndexFlatIP`, `faiss.normalize_L2`, `faiss.read_index`,
`faiss.write_index`, `index.add`, `index.search`, `index.reconstruct`,
`index.ntotal`) as
before — no other code changes needed.

**Rebuild the vector catalog after switching.** `cardvec`'s index file
format is its own (see the header comment in `flat_index.hpp`) — it does
not read FAISS's index files. Delete `backend/data/card-vectors.faiss`
and rerun `build_scanner_models.py` (or just its vector-building step,
`--skip-ingest --skip-images`, if you kept the downloaded art crops
around with `--keep-images`) to regenerate it in the new format.

## Android build

Android is the reason this library exists, but "compile the whole app
for Android" is a much bigger project than swapping out FAISS — Binder's
backend also depends on `pywebview` (a desktop-only window shell),
`torch`, `ultralytics`, and `paddleocr`, none of which are part of this
change. What's here is the piece that specifically blocked Android:
FAISS itself has no supported Android/NDK build path, and this does.

There are two ways to consume `cardvec` on Android, depending on how you
plan to run Binder's Python backend there:

### Option A — a plain native library, called over JNI

If you're not embedding CPython on-device (e.g. you're driving the
scanning pipeline from Kotlin/Java and only need the vector search part
in native code), cross-compile just the core library — no Python headers
involved at all:

```sh
cmake -S native/cardvec -B build-android-arm64 \
  -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI=arm64-v8a \
  -DANDROID_PLATFORM=android-24 \
  -DCARDVEC_BUILD_PYTHON=OFF \
  -DCMAKE_BUILD_TYPE=Release
cmake --build build-android-arm64
```

This produces `libcardvec_core.a`. Link it into your own JNI shared
library and call `cardvec::FlatIndexIP` directly from C++; write a thin
`extern "C"` wrapper around the handful of methods you need
(`add`/`search`/`save`/`load`) for the JNI boundary. Repeat with
`-DANDROID_ABI=armeabi-v7a` / `x86_64` for the other ABIs you ship.

### Option B — the Python module, if you're embedding CPython (e.g. Chaquopy)

If Binder's Flask backend runs on-device via an embedded CPython (as
Chaquopy or a similar toolchain provides), cross-compile the same
pybind11 module against *that* toolchain's cross-built CPython, then
place the resulting `.so` where its Python resolves `import cardvec` from
(for Chaquopy: alongside your other native dependencies, per its own
docs on shipping compiled extensions):

```sh
cmake -S native/cardvec -B build-android-arm64-py \
  -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI=arm64-v8a \
  -DANDROID_PLATFORM=android-24 \
  -DCARDVEC_BUILD_PYTHON=ON \
  -DCARDVEC_PYTHON_EXECUTABLE=/path/to/a/host/python-matching-the-target-version \
  -Dpybind11_DIR=/path/to/cross/pybind11/share/cmake/pybind11 \
  -DPython3_INCLUDE_DIR=/path/to/chaquopy/cross-build/include/pythonX.Y \
  -DPython3_LIBRARY=/path/to/chaquopy/cross-build/lib/libpythonX.Y.so
cmake --build build-android-arm64-py
```

The exact `Python3_INCLUDE_DIR`/`Python3_LIBRARY` paths depend entirely
on which Android Python toolchain you adopt — there's no single official
answer, since none of the common ones (Chaquopy, python-for-android,
BeeWare/briefcase) target the *same* prebuilt CPython, and this decision
hasn't been made yet for Binder. `CARDVEC_PYTHON_EXECUTABLE` only needs
to point at a *host* Python of the same major.minor version so CMake can
run `python -m pybind11 --cmakedir`; it is not the Python that ends up
running on-device.

### Smoke-testing a cross build without any Python at all

```sh
cmake -S native/cardvec -B build-android-arm64-test \
  -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI=arm64-v8a \
  -DANDROID_PLATFORM=android-24 \
  -DCARDVEC_BUILD_PYTHON=OFF \
  -DCARDVEC_BUILD_TESTS=ON
cmake --build build-android-arm64-test
adb push build-android-arm64-test/cardvec_selftest /data/local/tmp/
adb shell /data/local/tmp/cardvec_selftest
```

`tests/test_flat_index.cpp` has no dependencies beyond libc++, so it's a
quick way to confirm a given NDK/ABI/optimization combination produces
correct results (it checks `normalize_L2`, `add`/`search` against a
brute-force reference, and a save/load round-trip) before wiring
anything else up around it.

## Performance notes

- Dot products use AVX2+FMA on x86_64 and NEON on arm64, decided at
  compile time (no runtime CPU dispatch) — see `src/dot.hpp`.
- `search()` splits the database across up to 8 `std::thread` workers
  (skipped below ~20k rows, where spawning threads costs more than it
  saves) and merges each worker's local top-k. Binder only ever searches
  with one query vector at a time (one art crop per scan), so
  parallelizing across the database, not across queries, is what
  actually matters here.
- No BLAS, no OpenMP, no SWIG — the entire dependency footprint is the
  C++ standard library (plus pybind11 for the Python module), which is
  what makes cross-compiling for Android straightforward in the first
  place.
