// The recognition pipeline (the port of scanner.py's identify/search/detect), as an Engine:
//
//   frame -> detect card + guess game (YOLO, or contour fallback)
//         -> perspective-warp to 750x1050
//         -> per-game OCR of the region(s) carrying an exact identifier (set + collector #, or YGO passcode)
//         -> exact SQLite lookup
//         -> [fallback] title OCR + fuzzy name matching
//         -> [fallback] art-crop embedding + vector similarity, restricted to the fuzzy-matched names
//         -> art-based printing verification whenever a name was resolved
//
// Everything degrades gracefully: with no catalog identify() returns nothing, with no models the stages
// that need them are skipped.
#pragma once

#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "cardscan/backends.hpp"
#include "cardscan/engine.hpp"

namespace cardscan {

class PipelineEngine : public Engine {
public:
    using Logger = std::function<void(const std::string&)>;

    PipelineEngine(std::filesystem::path catalog_path, std::unique_ptr<ModelSource> models, Logger log = {});

    // Engine
    nlohmann::json search(const std::string& game, const std::string& query, int limit = 30, int offset = 0) override;
    Result detect(const std::string& image_bytes) override;
    Result scan(const std::string& image_bytes, const std::string& game_hint, double min_blur_score) override;
    void warm_up() override;

    // Forgets what was loaded (or failed to load) so the next request re-reads the catalog and vector index; call
    // after they were downloaded or rebuilt while the app was running.
    void reload_data();

    // Whether the catalog exists (the catalog builder has run).
    bool is_ready() const;

    struct Identified {
        std::optional<nlohmann::json> card;       // API-shaped card (+ bbox info), or nullopt
        std::optional<nlohmann::json> bbox_info;  // nullopt only if we bailed before detection ran
    };
    Identified identify(const Image& frame, const std::string& game_hint = "");

    // Detection only: {bbox, quad, image_width, image_height, game}.
    nlohmann::json detect_bbox_only(const Image& frame);

private:
    struct NameTable {
        std::vector<std::string> keys;                          // normalized names, first-seen order
        std::unordered_map<std::string, std::string> uid_by_key;  // -> uid of one printing
    };
    struct Candidate {
        std::string game, name;
        std::string uid;
        double score;
    };

    // Lazily-loaded models, each attempted once (null if unavailable or the load failed).
    LoadedDetector* detector();
    Ocr* ocr();
    Embedder* embedder();
    VectorIndex* index();

    std::shared_ptr<const NameTable> names_for(const std::string& game);

    std::string ocr_text(const Image& image);
    std::vector<Candidate> title_candidates(const std::string& game, const Image& warped, size_t limit = 5);
    std::optional<std::vector<float>> embed_art(const Image& warped, const std::string& game);

    std::filesystem::path catalog_path_;
    std::unique_ptr<ModelSource> models_;
    Logger log_;

    std::mutex mu_;  // guards the lazy loaders and the name cache
    bool detector_tried_ = false, ocr_tried_ = false, embedder_tried_ = false, index_tried_ = false;
    std::optional<LoadedDetector> detector_;
    std::unique_ptr<Ocr> ocr_;
    std::unique_ptr<Embedder> embedder_;
    std::unique_ptr<VectorIndex> index_;
    std::map<std::string, std::shared_ptr<const NameTable>> name_cache_;
};

}  // namespace cardscan
