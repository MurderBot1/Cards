# cardvec

A small, from-scratch C++ library for exact nearest-neighbour search over card-art embeddings: a flat
inner-product index (cosine similarity, once rows are L2-normalized), `normalize_L2`, and save/load of a purpose-built
file format. It started life as a replacement for the one FAISS feature Binder used (`IndexFlatIP`), because real FAISS
pulls in a BLAS backend that isn't practical to cross-compile with the NDK; this is ~250 lines of portable C++ with an
optional AVX2 (x86_64) / NEON (arm64) dot-product fast path and a few `std::thread` workers for the search loop, so
there's nothing library-specific left to build.

It is **not** a general vector-database library. There's no IVF/PQ/HNSW and no GPU path — just exact brute-force
search, which is all Binder needs: its card-art catalogs are tens of thousands of 384-dim vectors, and brute force
over that is comfortably sub-millisecond per query with SIMD.

## Layout

```
include/cardvec/flat_index.hpp   public C++ API (FlatIndexIP, normalize_L2)
src/dot.hpp                      AVX2 / NEON / scalar dot-product kernel
src/flat_index.cpp               add / search / reconstruct / save / load
tests/test_flat_index.cpp        dependency-free self-test
CMakeLists.txt                   builds cardvec_core (and the self-test with -DCARDVEC_BUILD_TESTS=ON)
```

## Building

It is built as part of the app (`native/CMakeLists.txt`, see [BUILDING.md](../../BUILDING.md)), and its self-test
runs under `ctest` there. It also builds on its own:

```
cmake -S native/cardvec -B build/cardvec -DCARDVEC_BUILD_TESTS=ON
cmake --build build/cardvec
build/cardvec/cardvec_selftest
```

On Android it is linked statically into `libbinder_native.so` by the NDK build in `android/`. To smoke-test a cross
build on a device or emulator without the rest of the app:

```
cmake -S native/cardvec -B build-android-arm64-test \
  -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-24 -DCARDVEC_BUILD_TESTS=ON
cmake --build build-android-arm64-test
adb push build-android-arm64-test/cardvec_selftest /data/local/tmp/ && adb shell /data/local/tmp/cardvec_selftest
```

The self-test checks `normalize_L2`, `add`/`search` against a brute-force reference, and a save/load round-trip.

## File format

Little-endian, native float layout: `"CVI1"` magic, `int64 dim`, `int64 ntotal`, then `ntotal * dim` floats, row-major.
Paths are UTF-8 on every platform (Windows' narrow `fopen` would read them in the ANSI code page).

## Performance notes

- Dot products use AVX2+FMA on x86_64 and NEON on arm64, decided at compile time (no runtime CPU dispatch) — see
  `src/dot.hpp`.
- `search()` splits the database across up to 8 `std::thread` workers (skipped below ~20k rows, where spawning
  threads costs more than it saves) and merges each worker's local top-k. Binder only ever searches with one query
  vector at a time (one art crop per scan), so parallelizing across the database, not across queries, is what matters.
- No BLAS, no OpenMP: the entire dependency footprint is the C++ standard library.
