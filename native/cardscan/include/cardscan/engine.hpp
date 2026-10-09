// cardscan — card recognition behind a small interface, so the HTTP layer
// never needs to know whether recognition is backed by OpenCV + cardnet +
// cardvec or is unavailable (a build without the ML runtime, or a catalog
// that hasn't been built yet).
#pragma once

#include <string>

#include <nlohmann/json.hpp>

namespace cardscan {

struct Result {
    int status = 200;
    nlohmann::json body;
};

class Engine {
public:
    virtual ~Engine() = default;

    // Catalog search by name for one game ("mtg" | "pokemon" | "yugioh"): a JSON array of up to `limit` cards, starting
    // `offset` cards into the (stably ordered) results, so a caller can page through them.
    virtual nlohmann::json search(const std::string& game, const std::string& query, int limit = 30, int offset = 0) = 0;

    // Detection only (no OCR / catalog lookup): is there a card in this frame, and where.
    // `image_bytes` is an encoded image (JPEG/PNG/...).
    virtual Result detect(const std::string& image_bytes) = 0;

    // Full identification. `game_hint` is "" or one of the games above. Frames whose
    // blur score is below `min_blur_score` are rejected before the expensive pipeline.
    virtual Result scan(const std::string& image_bytes, const std::string& game_hint, double min_blur_score) = 0;

    // Load models/indexes now instead of on the first request. Safe to call from a background thread.
    virtual void warm_up() {}
};

// An engine for builds/environments with no recognition available: search finds
// nothing, detect and scan answer 503 with `reason`.
class NullEngine : public Engine {
public:
    explicit NullEngine(std::string reason = "Card recognition isn't available in this build.");
    nlohmann::json search(const std::string& game, const std::string& query, int limit = 30, int offset = 0) override;
    Result detect(const std::string& image_bytes) override;
    Result scan(const std::string& image_bytes, const std::string& game_hint, double min_blur_score) override;

private:
    std::string reason_;
};

}  // namespace cardscan
