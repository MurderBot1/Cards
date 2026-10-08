// The Binder HTTP API (replaces the Flask routes in app.py).
#pragma once

#include <filesystem>
#include <functional>
#include <string>

#include "cardauth/auth.hpp"
#include "cardhttp/server.hpp"
#include "cardscan/engine.hpp"
#include "cardstore/store.hpp"
#include "setup_status.hpp"

namespace binder {

struct ApiContext {
    cardstore::Store& store;
    cardscan::Engine& engine;
    cardauth::Config auth;
    std::filesystem::path frontend_dir;  // index.html, css/, js/
    SetupStatus* setup = nullptr;        // background first-run work, for GET /api/setup; none = nothing to report
    // How POST /api/open-url opens a release URL (already checked to be one); default: the system browser. Tests
    // replace it so nothing is launched.
    std::function<bool(const std::string&)> open_url;
};

// Minimum Laplacian-variance blur score an uploaded scan must clear, per the
// minImageQuality setting ("low" | "medium" | "high"; anything else = medium).
// Mirrors the sharpness thresholds the frontend's auto-capture loop uses —
// same setting, same focus measure, just computed on the full-resolution
// upload as a final backstop.
double min_blur_score_for(const std::string& min_image_quality);

// Registers /api/* and the static frontend routes.
void register_routes(cardhttp::Server& server, ApiContext& ctx);

}  // namespace binder
