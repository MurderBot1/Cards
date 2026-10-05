#include "tool.hpp"

#include "cardcatalog/catalog.hpp"
#include "cardscan/model_source.hpp"
#include "cardvectors/vectors.hpp"

namespace fs = std::filesystem;

namespace catalogtool {

int run(const Options& o, cardfetch::Transport& transport, const EmbedderFactory& make_embedder,
        const std::function<void(const std::string&)>& log, const cardingest::Sources& sources) {
    try {
        if (!o.only.empty() && !cardcatalog::is_game(o.only)) {
            log("--only must be mtg, pokemon or yugioh");
            return 1;
        }
        const fs::path db_path = o.data_dir / cardscan::kCatalogFile;
        const fs::path index_path = o.data_dir / cardscan::kVectorIndexFile;
        const fs::path images_dir = o.data_dir / "card-images";

        cardcatalog::Writer writer(db_path);
        cardfetch::Fetcher fetcher(transport, o.data_dir / "cache", o.refresh_cache);

        if (!o.skip_ingest) {
            if (o.only.empty() || o.only == "mtg") cardingest::ingest_mtg(fetcher, writer, log, sources);
            if (o.only.empty() || o.only == "pokemon") cardingest::ingest_pokemon(fetcher, writer, log, o.ingest_workers, sources);
            if (o.only.empty() || o.only == "yugioh") cardingest::ingest_yugioh(fetcher, writer, log, sources);
        }

        if (!o.skip_images)
            cardvectors::download_images(writer, fetcher, images_dir, o.only, o.image_workers, o.request_pause_seconds, log);

        bool vectors_built = false;
        if (!o.skip_vectors) {
            if (writer.cards_needing_vectors(o.only).empty()) {
                log("[vectors] nothing to do.");
                vectors_built = true;  // everything that can be embedded already is
            } else if (auto embedder = make_embedder(o.data_dir)) {
                log("[vectors] embedding with the DINOv2 model...");
                cardvectors::build_vectors(writer, *embedder, images_dir, index_path, o.only, cardvectors::kDefaultBatchSize,
                                           o.vector_prefetch_workers, log);
                vectors_built = true;
            } else {
                log("[vectors] no embedding model available (" + (o.data_dir / cardscan::kEmbedderModelFile).u8string() +
                    " is missing, or this build has no ONNX Runtime) — skipping. Export it with native/cardnet/export/export_dino.py.");
            }
        }

        // The images are only a scratch copy for the vectors; once the vectors exist they're dead weight. Only safe to
        // remove if both steps that use them actually ran — otherwise they (or the vectors still waiting on them) are needed.
        if (!o.skip_images && vectors_built && !o.keep_images) cardvectors::cleanup_images(images_dir, o.only, log);

        writer.finalize();
        log("\nAll done. " + std::to_string(writer.count()) + " cards in " + db_path.u8string());
        return 0;
    } catch (const std::exception& e) {
        log(std::string("error: ") + e.what());
        return 1;
    }
}

}  // namespace catalogtool
