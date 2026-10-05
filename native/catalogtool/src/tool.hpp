// The catalog builder's pipeline: ingest -> images -> vectors -> cleanup -> finalize. Takes its transport and
// embedder as arguments, so the whole run is testable without a network or a model.
#pragma once

#include <filesystem>
#include <functional>
#include <memory>
#include <string>

#include "cardfetch/fetch.hpp"
#include "cardingest/ingest.hpp"
#include "cardscan/backends.hpp"

namespace catalogtool {

struct Options {
    std::filesystem::path data_dir;  // cards.sqlite3, card-vectors.cvi, cache/ and card-images/ live here
    std::string only;                // "" = every game, else "mtg" | "pokemon" | "yugioh"
    bool skip_ingest = false;
    bool skip_images = false;
    bool skip_vectors = false;
    bool keep_images = false;  // don't delete card-images/ once the vectors are built (for debugging)
    bool refresh_cache = false;  // ignore cache/ and download bulk data again
    int image_workers = 16;
    int ingest_workers = 16;
    int vector_prefetch_workers = 2;
    double request_pause_seconds = 0.05;  // courtesy delay after each image download, per worker
};

// Returns the embedder, or nullptr if there isn't one (its model isn't exported yet / not built in) — the vectors step
// is then skipped with an explanation. Called only when there are vectors to build.
using EmbedderFactory = std::function<std::unique_ptr<cardscan::Embedder>(const std::filesystem::path& data_dir)>;

// 0 on success, 1 on failure (the reason is logged). Safe to re-run: every step skips work already done.
int run(const Options& options, cardfetch::Transport& transport, const EmbedderFactory& make_embedder,
        const std::function<void(const std::string&)>& log, const cardingest::Sources& sources = {});

}  // namespace catalogtool
