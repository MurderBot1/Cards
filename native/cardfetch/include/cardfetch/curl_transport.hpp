// The libcurl implementation of cardfetch::Transport.
#pragma once

#include <string>

#include "cardfetch/fetch.hpp"

namespace cardfetch {

class CurlTransport : public Transport {
public:
    explicit CurlTransport(std::string user_agent = kUserAgent);
    Response get(const std::string& url, int timeout_seconds) override;
    long get_to_file(const std::string& url, int timeout_seconds, const std::filesystem::path& dest) override;

private:
    std::string user_agent_;
};

}  // namespace cardfetch
