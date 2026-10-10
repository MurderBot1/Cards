// Saving a file the page made (a collection's CSV export) into the user's Downloads folder. The page can't download a
// blob from inside the app's window, so it posts the text here (POST /api/save-file).
#pragma once

#include <filesystem>
#include <string>

namespace binder {

// A name that is safe to create in a folder of ours: 1-120 characters, a ".csv" extension, no path separators,
// control characters or characters Windows forbids, and not starting with a dot.
bool is_safe_export_name(const std::string& name);

struct SaveResult {
    bool ok = false;
    std::filesystem::path path;  // where it went (a "(2)" is added to the name when the file already exists)
    std::string error;
};

// Writes `content` to <dir>/<name>, creating `dir` if needed and never replacing an existing file.
SaveResult save_export(const std::filesystem::path& dir, const std::string& name, const std::string& content);

}  // namespace binder
