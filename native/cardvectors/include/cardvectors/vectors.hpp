// cardvectors — the second half of building a catalog: download each card's image, embed it, and build the
// cosine-similarity index the scanner searches (the port of build_scanner_models.py's download_images /
// build_vectors / cleanup_local_images).
//
// The images are a scratch copy used only to compute the vectors; the app itself never reads them — it loads card
// art straight from each card's source image_url — so they're deleted once the vectors are built.
#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <string>

#include "cardcatalog/catalog.hpp"
#include "cardfetch/fetch.hpp"
#include "cardscan/backends.hpp"

namespace cardvectors {

using Log = std::function<void(const std::string&)>;

inline constexpr int kDefaultImageWorkers = 16;
inline constexpr int kDefaultPrefetchWorkers = 2;
inline constexpr int kDefaultBatchSize = 32;
// Batches between checkpoints (write the index + record the vector indexes). Writing the index rewrites the whole
// file, so doing it after every batch gets more expensive as it grows; checkpointing every N trades a bigger "redo
// window" after a crash for far less redundant disk I/O.
inline constexpr int kCheckpointBatches = 10;

// uid -> a file name every OS accepts (some card numbers contain characters like '?' that Windows forbids).
std::string safe_filename(const std::string& uid);

struct ImageStats {
    std::size_t downloaded = 0;
    std::size_t reused = 0;  // already on disk from an earlier run
    std::size_t failed = 0;
};

// Downloads every card's image that doesn't have one yet into <images_dir>/<game>/<uid>.jpg (re-encoded as JPEG)
// and records the relative path in the catalog. `only_game` ("" = all). `pause_seconds` is a courtesy delay after
// each download, per worker, to be polite to the free APIs.
ImageStats download_images(cardcatalog::Writer& writer, cardfetch::Fetcher& fetcher, const std::filesystem::path& images_dir,
                           const std::string& only_game, int workers, double pause_seconds, const Log& log);

struct VectorStats {
    std::size_t embedded = 0;
    std::size_t skipped = 0;           // images that couldn't be read
    std::int64_t total_vectors = 0;    // in the index afterwards
};

// Embeds every card that has an image but no vector, appends the normalized vectors to the index at `index_path`
// (created if missing) and records each card's row in the catalog. Resumable. Throws cardcatalog::Error / std::runtime_error
// if the existing index's dimension doesn't match the embedder's.
//
// Crash safety: the index file is written *before* the catalog records the rows that point into it, so a crash can leave
// harmless unreferenced vectors at the end of the index, but never rows pointing past its end.
VectorStats build_vectors(cardcatalog::Writer& writer, cardscan::Embedder& embedder, const std::filesystem::path& images_dir,
                          const std::filesystem::path& index_path, const std::string& only_game, int batch_size,
                          int prefetch_workers, const Log& log);

// Deletes the scratch images (all of them, or just one game's). Returns whether anything was removed.
bool cleanup_images(const std::filesystem::path& images_dir, const std::string& only_game, const Log& log);

}  // namespace cardvectors
