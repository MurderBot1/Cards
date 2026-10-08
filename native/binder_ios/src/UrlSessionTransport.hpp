// A cardfetch::Transport that downloads through NSURLSession, since iOS has no libcurl. Used from the backend's
// background threads for the first-launch catalog download (the iOS counterpart of Android's JvmTransport).
#pragma once

#include <filesystem>
#include <string>

#include "cardfetch/fetch.hpp"

namespace binder_ios {

class UrlSessionTransport : public cardfetch::Transport {
public:
    cardfetch::Response get(const std::string& url, int timeout_seconds) override;
    long get_to_file(const std::string& url, int timeout_seconds, const std::filesystem::path& dest) override;
};

}  // namespace binder_ios
