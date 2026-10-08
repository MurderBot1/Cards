// carddownload — fetches the prebuilt card catalog (cards.sqlite3) and vector index (card-vectors.cvi) that the
// release doesn't bundle, into the app's data directory, the first time they're missing. Files that already exist
// are never touched, so a catalog the user built themselves (binder-catalog) or bundled with the app stays.
#pragma once

#include <filesystem>
#include <functional>
#include <string>
#include <vector>

#include "cardfetch/fetch.hpp"

namespace carddownload {

// The "Assets" release always serves the latest upload of each file under this URL.
inline constexpr const char* kDefaultBaseUrl = "https://github.com/MurderBot1/Cards/releases/download/Assets/";

struct Options {
    std::string base_url = kDefaultBaseUrl;  // must end in '/'
    std::vector<std::string> files = {"cards.sqlite3", "card-vectors.cvi"};
    int timeout_seconds = 60;  // connecting / stalled transfer, not the total time
    // Called just before each file starts: its name, which download this is (1-based) and how many there are.
    std::function<void(const std::string& name, size_t number, size_t total)> on_file;
    // Called with the current file's size in bytes once the server has said what it is (transports that can't tell
    // never call it), after on_file for that file.
    std::function<void(unsigned long long bytes)> on_size;
};

struct Result {
    bool ok = true;                         // every file is now present
    std::vector<std::string> downloaded;    // the ones fetched by this call
    std::string error;                      // first failure, when !ok
};

// The files of `options.files` that aren't in `data_dir` yet.
std::vector<std::string> missing_files(const std::filesystem::path& data_dir, const Options& options = {});

// Downloads every missing file into `data_dir`. Each goes to <name>.part first and is renamed once complete, so an
// interrupted download never leaves a truncated file that looks like a catalog (the next launch starts that file
// again). Stops at the first failure. Never throws; `log` (optional) gets status messages.
Result download_missing(cardfetch::Transport& transport, const std::filesystem::path& data_dir,
                        const Options& options = {}, const std::function<void(const std::string&)>& log = {});

}  // namespace carddownload
