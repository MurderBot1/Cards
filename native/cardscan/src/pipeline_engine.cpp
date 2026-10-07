#include "cardscan/pipeline_engine.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <set>

#include "cardcatalog/catalog.hpp"
#include "cardtext/text.hpp"

namespace cardscan {

using nlohmann::json;

namespace {

// Score (0-100) at which a fuzzy title match is accepted outright, without falling through to the
// art-vector path. Compared against difflib-style ratios, which are stricter than the WRatio this was
// first tuned against, so it was loosened from 88 to 80; it hasn't been re-tuned on real scans. The
// effect of getting it wrong is graceful: too high just sends more scans down the art fallback.
constexpr double kFuzzyMatchThreshold = 80;
// Ratio (0-1) below which a name isn't even a candidate; looser on purpose, it only decides which names
// reach the art fallback's candidate set.
constexpr double kFuzzyCandidateCutoff = 0.55;
constexpr int kVectorTopK = 8;

constexpr std::array<const char*, 3> kGames = {"mtg", "pokemon", "yugioh"};

// Regions of interest in the 750x1050 warped-card space.
struct GameRois {
    Roi title, art;
};
GameRois rois_for(const std::string& game) {
    if (game == "pokemon") return {{100, 30, 650, 120}, {80, 130, 670, 550}};
    if (game == "yugioh") return {{60, 40, 680, 110}, {120, 210, 630, 580}};
    return {{50, 30, 700, 120}, {75, 120, 675, 580}};  // mtg
}
constexpr Roi kMtgPrimary = {0, 920, 350, 1050};
constexpr Roi kPokemonModern = {0, 940, 300, 1030};
constexpr Roi kPokemonVintage = {500, 940, 730, 1030};
constexpr Roi kYugiohPasscode = {20, 980, 220, 1040};
constexpr Roi kYugiohSetCode = {450, 600, 700, 660};

json bbox_json(const std::optional<std::array<int, 4>>& b) {
    if (!b) return nullptr;
    return {{"x0", (*b)[0]}, {"y0", (*b)[1]}, {"x1", (*b)[2]}, {"y1", (*b)[3]}};
}

json to_api_card(const cardcatalog::Card& c) {
    // Images are served straight from the source API that supplied them (Scryfall / PokemonTCG / YGOPRODeck)
    // rather than from a local copy.
    return {{"id", c.uid}, {"name", c.name}, {"set", c.set_code}, {"rarity", c.rarity}, {"game", c.game}, {"image", c.image_url}};
}

}  // namespace

PipelineEngine::PipelineEngine(std::filesystem::path catalog_path, std::unique_ptr<ModelSource> models, Logger log)
    : catalog_path_(std::move(catalog_path)), models_(std::move(models)), log_(std::move(log)) {
    if (!models_) models_ = std::make_unique<ModelSource>();
    if (!log_) log_ = [](const std::string&) {};
}

void PipelineEngine::reload_data() {
    std::lock_guard<std::mutex> lock(mu_);
    index_tried_ = false;
    index_.reset();
    name_cache_.clear();
}

bool PipelineEngine::is_ready() const { return cardcatalog::exists(catalog_path_); }

// ---------------------------------------------------------------------------
// lazy model loading — each model is attempted once; a failure is logged and the stage is skipped
// ---------------------------------------------------------------------------
LoadedDetector* PipelineEngine::detector() {
    std::lock_guard<std::mutex> lock(mu_);
    if (!detector_tried_) {
        detector_tried_ = true;
        try {
            detector_ = models_->load_detector();
        } catch (const std::exception& e) {
            log_(std::string("could not load the card detector (") + e.what() + "); falling back to contour detection");
        }
    }
    return detector_ && detector_->detector ? &*detector_ : nullptr;
}

Ocr* PipelineEngine::ocr() {
    std::lock_guard<std::mutex> lock(mu_);
    if (!ocr_tried_) {
        ocr_tried_ = true;
        try {
            ocr_ = models_->load_ocr();
        } catch (const std::exception& e) {
            log_(std::string("could not load the OCR pipeline (") + e.what() + ")");
        }
    }
    return ocr_.get();
}

Embedder* PipelineEngine::embedder() {
    std::lock_guard<std::mutex> lock(mu_);
    if (!embedder_tried_) {
        embedder_tried_ = true;
        try {
            embedder_ = models_->load_embedder();
        } catch (const std::exception& e) {
            log_(std::string("could not load the art embedder (") + e.what() + ")");
        }
    }
    return embedder_.get();
}

VectorIndex* PipelineEngine::index() {
    std::lock_guard<std::mutex> lock(mu_);
    if (!index_tried_) {
        index_tried_ = true;
        try {
            index_ = models_->load_index();
        } catch (const std::exception& e) {
            log_(std::string("could not load the vector index (") + e.what() + ")");
        }
    }
    return index_.get();
}

void PipelineEngine::warm_up() {
    if (!is_ready()) return;
    detector();
    ocr();
    index();
    embedder();
}

// ---------------------------------------------------------------------------
// names for fuzzy matching: {normalized name -> uid}, keyed by *name* not printing, so a heavily
// reprinted card contributes one entry instead of dozens (which cuts what the fuzzy scan walks several-fold on
// MTG). Whichever uid comes back only resolves a name; best-printing-by-art then picks the actual printing.
// ---------------------------------------------------------------------------
std::shared_ptr<const PipelineEngine::NameTable> PipelineEngine::names_for(const std::string& game) {
    {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = name_cache_.find(game);
        if (it != name_cache_.end()) return it->second;
    }
    auto table = std::make_shared<NameTable>();
    if (is_ready()) {
        cardcatalog::Reader reader(catalog_path_);
        for (const auto& [name, uid] : reader.unique_names(game)) {
            if (name.empty()) continue;
            std::string key = cardtext::normalize_title(name);
            if (!table->uid_by_key.count(key)) table->keys.push_back(key);
            table->uid_by_key[key] = uid;  // a later name normalizing to the same key wins
        }
    }
    std::lock_guard<std::mutex> lock(mu_);
    return name_cache_.emplace(game, table).first->second;
}

std::string PipelineEngine::ocr_text(const Image& image) {
    if (image.empty()) return "";
    Ocr* o = ocr();
    if (!o) return "";
    std::string out;
    for (const auto& line : o->recognize(image)) {
        if (line.empty()) continue;
        if (!out.empty()) out += ' ';
        out += line;
    }
    return out;
}

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------
namespace {
struct DetectResult {
    std::optional<std::array<int, 4>> bbox;
    std::string game;
};
}  // namespace

static DetectResult detect_and_classify(LoadedDetector* det, const Image& frame) {
    if (!det) return {};  // no trained detector: the caller uses the whole frame
    auto detections = det->detector->detect(frame);
    if (detections.empty()) return {};
    const Detection* best = &detections[0];
    for (const auto& d : detections)
        if (d.score > best->score) best = &d;  // first of equal scores wins
    DetectResult r;
    r.bbox = std::array<int, 4>{static_cast<int>(best->x0), static_cast<int>(best->y0), static_cast<int>(best->x1), static_cast<int>(best->y1)};
    auto it = det->class_names.find(best->class_id);
    if (it != det->class_names.end() && cardcatalog::is_game(it->second)) r.game = it->second;
    return r;
}

json PipelineEngine::detect_bbox_only(const Image& frame) {
    DetectResult d = detect_and_classify(detector(), frame);
    json quad = nullptr;
    if (!d.bbox) {
        if (auto q = find_card_quad(frame)) {
            quad = json::array();
            float min_x = (*q)[0].x, max_x = min_x, min_y = (*q)[0].y, max_y = min_y;
            for (const auto& p : *q) {
                quad.push_back({{"x", p.x}, {"y", p.y}});
                min_x = std::min(min_x, p.x), max_x = std::max(max_x, p.x);
                min_y = std::min(min_y, p.y), max_y = std::max(max_y, p.y);
            }
            d.bbox = std::array<int, 4>{static_cast<int>(min_x), static_cast<int>(min_y), static_cast<int>(max_x), static_cast<int>(max_y)};
        }
    }
    return {{"bbox", bbox_json(d.bbox)},
            {"quad", quad},
            {"image_width", frame.width},
            {"image_height", frame.height},
            {"game", d.game.empty() ? json(nullptr) : json(d.game)}};
}

// ---------------------------------------------------------------------------
// fuzzy title matching
// ---------------------------------------------------------------------------
std::vector<PipelineEngine::Candidate> PipelineEngine::title_candidates(const std::string& game, const Image& warped, size_t limit) {
    std::string text = cardtext::normalize_title(ocr_text(crop(warped, rois_for(game).title)));
    if (text.empty()) return {};
    auto names = names_for(game);
    if (names->keys.empty()) return {};
    std::vector<Candidate> out;
    for (const auto& name : cardtext::get_close_matches(text, names->keys, limit, kFuzzyCandidateCutoff))
        out.push_back({game, name, names->uid_by_key.at(name), cardtext::sequence_ratio(text, name) * 100.0});
    return out;
}

// ---------------------------------------------------------------------------
// art embedding / vector search
// ---------------------------------------------------------------------------
std::optional<std::vector<float>> PipelineEngine::embed_art(const Image& warped, const std::string& game) {
    Image art = crop(warped, rois_for(game).art);
    if (art.empty()) return std::nullopt;
    Embedder* e = embedder();
    if (!e) return std::nullopt;
    std::vector<float> v = e->embed(art);
    double norm = 0;
    for (float x : v) norm += static_cast<double>(x) * x;
    norm = std::sqrt(norm);
    if (norm > 1e-12)  // L2-normalize, leaving a (near-)zero vector alone, like faiss
        for (float& x : v) x = static_cast<float>(x / norm);
    return v;
}

namespace {

// Top vector hit within the allowed game / candidate-name set.
std::optional<cardcatalog::Card> art_lookup(cardcatalog::Reader& reader, VectorIndex* index,
                                            const std::function<std::optional<std::vector<float>>(const std::string&)>& embed,
                                            const std::vector<std::string>& candidate_games,
                                            const std::set<std::string>* candidate_names) {
    if (!index || index->ntotal() == 0) return std::nullopt;
    for (const auto& game : candidate_games) {
        auto vec = embed(game);
        if (!vec) continue;
        std::vector<float> scores(kVectorTopK);
        std::vector<std::int64_t> labels(kVectorTopK);
        index->search(vec->data(), kVectorTopK, scores.data(), labels.data());
        for (int i = 0; i < kVectorTopK; ++i) {
            if (labels[i] < 0) continue;
            auto card = reader.by_vector_idx(labels[i], game);
            if (!card) continue;
            // Filter by *name*, not uid: the index holds one row per printing, while the fuzzy candidates are
            // per unique name, so comparing uids would reject every printing but the representative one and
            // silently turn this fallback into a no-op for most cards.
            if (candidate_names && !candidate_names->count(cardtext::normalize_title(card->name))) continue;
            return card;
        }
    }
    return std::nullopt;
}

// Given a name we're confident about, use the art crop to pick which *printing* it is: art is far more
// reliable than the tiny, easily-misread set-code/collector-number text. Returns nullopt if art-based
// verification wasn't possible; callers keep what they already had.
std::optional<cardcatalog::Card> best_printing_by_art(cardcatalog::Reader& reader, VectorIndex* index,
                                                      const std::function<std::optional<std::vector<float>>(const std::string&)>& embed,
                                                      const std::string& game, const std::string& name) {
    if (!index || index->ntotal() == 0) return std::nullopt;
    auto printings = reader.printings(game, name);
    if (printings.empty()) return std::nullopt;
    auto query = embed(game);
    if (!query) return std::nullopt;

    const cardcatalog::Printing* best = nullptr;
    double best_score = -1.0;
    for (const auto& p : printings) {
        std::vector<float> v = index->reconstruct(p.vector_idx);  // L2-normalized at build time
        double score = 0;
        for (size_t i = 0; i < v.size() && i < query->size(); ++i) score += static_cast<double>((*query)[i]) * v[i];
        if (score > best_score) {
            best = &p;
            best_score = score;
        }
    }
    if (!best) return std::nullopt;
    return reader.by_uid(best->uid);
}

}  // namespace

// ---------------------------------------------------------------------------
// identify
// ---------------------------------------------------------------------------
PipelineEngine::Identified PipelineEngine::identify(const Image& frame, const std::string& game_hint) {
    if (!is_ready()) return {};
    std::unique_ptr<cardcatalog::Reader> reader_owner;
    try {
        reader_owner = std::make_unique<cardcatalog::Reader>(catalog_path_);
    } catch (const std::exception& e) {
        log_(std::string("could not open the catalog (") + e.what() + ")");
        return {};
    }
    cardcatalog::Reader& reader = *reader_owner;

    DetectResult det = detect_and_classify(detector(), frame);
    Image warped = warp_perspective(frame);

    std::vector<std::string> games_to_try;
    if (!det.game.empty()) games_to_try = {det.game};
    else if (cardcatalog::is_game(game_hint)) games_to_try = {game_hint};
    else games_to_try.assign(kGames.begin(), kGames.end());

    std::optional<json> result;
    std::string matched_game, matched_name;  // set once a (game, name) is resolved, to verify against art
    auto accept = [&](const cardcatalog::Card& c) {
        result = to_api_card(c);
        matched_game = c.game;
        matched_name = c.name;
    };

    // --- exact-identifier OCR path, per game
    for (const auto& game : games_to_try) {
        std::optional<cardcatalog::Card> card;
        if (game == "mtg") {
            if (auto m = cardtext::parse_mtg_primary(ocr_text(crop(warped, kMtgPrimary))))
                card = reader.lookup("mtg", m->set_code, m->collector_number);
        } else if (game == "pokemon") {
            if (auto m = cardtext::parse_pokemon_modern(ocr_text(crop(warped, kPokemonModern))))
                card = reader.lookup("pokemon", m->set_code, m->collector_number);
            if (!card)
                if (auto number = cardtext::parse_pokemon_vintage(ocr_text(crop(warped, kPokemonVintage))))
                    card = reader.lookup("pokemon", "", *number);
        } else if (game == "yugioh") {
            auto passcode = cardtext::parse_yugioh_passcode(ocr_text(crop(warped, kYugiohPasscode)));
            auto set_code = cardtext::parse_yugioh_set_code(ocr_text(crop(warped, kYugiohSetCode)));
            if (passcode && set_code) card = reader.lookup("yugioh", *set_code, "", *passcode);
            if (!card && passcode) card = reader.lookup("yugioh", "", "", *passcode);
        }
        if (card) {
            accept(*card);
            break;
        }
    }

    auto embed = [&](const std::string& game) { return embed_art(warped, game); };

    // --- fuzzy title-OCR fallback, then the art-vector fallback
    if (!result) {
        std::vector<Candidate> all;
        for (const auto& game : games_to_try)
            for (auto& c : title_candidates(game, warped)) all.push_back(std::move(c));
        std::stable_sort(all.begin(), all.end(), [](const Candidate& a, const Candidate& b) { return a.score > b.score; });

        if (!all.empty() && all[0].score >= kFuzzyMatchThreshold) {
            if (auto row = reader.by_uid(all[0].uid)) accept(*row);
        }

        // art-vector fallback, restricted to the fuzzy-matched candidates (only reached when the name is
        // still unknown: no primary-parser hit and no confident fuzzy title match)
        if (!result) {
            std::set<std::string> candidate_names;
            std::vector<std::string> candidate_games;
            for (const auto& c : all) {
                candidate_names.insert(c.name);
                if (std::find(candidate_games.begin(), candidate_games.end(), c.game) == candidate_games.end()) candidate_games.push_back(c.game);
            }
            if (candidate_games.empty()) candidate_games = games_to_try;
            if (auto card = art_lookup(reader, index(), embed, candidate_games, candidate_names.empty() ? nullptr : &candidate_names))
                accept(*card);
        }
    }

    // --- art-based printing verification: whenever a name was resolved (by either path), double-check
    // which printing it is against every known printing of that name. OCR of the set-code/collector-number
    // text is small and easy to misread, and a misread can still land on a real (wrong) row.
    if (!matched_name.empty()) {
        if (auto art_row = best_printing_by_art(reader, index(), embed, matched_game, matched_name)) result = to_api_card(*art_row);
    }

    // the detector's box, in the original frame's pixel space, attached whether or not a card matched, so a
    // failed scan can still show where the detector looked
    json bbox_info = {{"bbox", bbox_json(det.bbox)}, {"image_width", frame.width}, {"image_height", frame.height}};
    if (result) result->update(bbox_info);
    return {result, bbox_info};
}

// ---------------------------------------------------------------------------
// Engine interface
// ---------------------------------------------------------------------------
json PipelineEngine::search(const std::string& game, const std::string& query) {
    if (!is_ready()) return json::array();
    try {
        cardcatalog::Reader reader(catalog_path_);
        json out = json::array();
        for (const auto& c : reader.search(game, query)) out.push_back(to_api_card(c));
        return out;
    } catch (const std::exception& e) {
        log_(std::string("search failed (") + e.what() + ")");
        return json::array();
    }
}

Result PipelineEngine::detect(const std::string& image_bytes) {
    auto img = decode_image(image_bytes);
    if (!img) return {400, {{"error", "Could not read that image"}}};
    return {200, detect_bbox_only(*img)};
}

Result PipelineEngine::scan(const std::string& image_bytes, const std::string& game_hint, double min_blur_score) {
    auto img = decode_image(image_bytes);
    if (!img) return {400, {{"error", "Could not read that image"}}};

    if (blur_score(*img) < min_blur_score)
        return {400, {{"error", "Image is too blurry — hold the camera steady and make sure the card is in focus"}}};

    if (!is_ready())
        return {503, {{"error", "The card catalog hasn't been built yet — run the catalog builder (cardcatalog) first."}}};

    Identified id = identify(*img, game_hint);
    if (!id.card) {
        json resp = {{"error", "Couldn't confidently identify that card — try a clearer, well-lit photo"}};
        if (id.bbox_info) resp.update(*id.bbox_info);
        return {404, resp};
    }
    return {200, *id.card};
}

}  // namespace cardscan
