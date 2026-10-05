#include "cardscan/engine.hpp"

namespace cardscan {

NullEngine::NullEngine(std::string reason) : reason_(std::move(reason)) {}

nlohmann::json NullEngine::search(const std::string&, const std::string&) { return nlohmann::json::array(); }

Result NullEngine::detect(const std::string&) { return {503, {{"error", reason_}}}; }

Result NullEngine::scan(const std::string&, const std::string&, double) { return {503, {{"error", reason_}}}; }

}  // namespace cardscan
