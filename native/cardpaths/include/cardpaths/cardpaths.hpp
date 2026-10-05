// cardpaths — decides where things live on disk (replaces paths.py).
//
// Writable state (db.json, logs/, the working card catalog) always lives in
// the OS's per-user app-data directory — the install folder can be read-only
// (Program Files, a signed .app bundle) — and the read-only frontend (plus an
// optional bundled catalog) is found next to the executable, or in the repo
// when running a dev build. Android can't discover either on its own, so the
// Kotlin side passes both in through Options.
#pragma once

#include <filesystem>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace cardpaths {

// Everything resolve() reads from the machine, injectable for tests.
struct Environment {
    std::string os;  // "windows" | "macos" | "linux" | "android"
    std::filesystem::path home;
    std::filesystem::path exe_path;
    std::filesystem::path cwd;
    std::function<std::string(const std::string&)> getenv;  // "" when unset
};

struct Options {
    std::optional<std::filesystem::path> user_data_dir;  // else $BINDER_USER_DATA_DIR, else per-OS default
    std::optional<std::filesystem::path> frontend_dir;   // else $BINDER_FRONTEND_DIR, else searched for
};

struct Paths {
    std::filesystem::path user_data_dir;
    std::filesystem::path log_dir;   // <user_data>/logs
    std::filesystem::path data_dir;  // <user_data>/data: cards.sqlite3, card-vectors.cvi, cardnet's .onnx models
    std::filesystem::path db_path;   // <user_data>/db.json
    std::filesystem::path startup_log;
    std::filesystem::path frontend_dir;  // first candidate containing index.html, else the first candidate
    bool frontend_found = false;
    std::vector<std::filesystem::path> frontend_candidates;  // everything tried, in order (for diagnostics)
    std::optional<std::filesystem::path> bundled_data_dir;   // catalog shipped next to an installed frontend/
};

// The real machine.
Environment system_environment();

// Pure path logic (only touches the filesystem to test for index.html and the
// bundled data directory).
Paths resolve(const Environment& env, const Options& options = {});

// Creates user_data_dir and log_dir.
void ensure_dirs(const Paths& paths);

// First-run only: copies a bundled catalog into data_dir when data_dir is
// missing or empty. Returns true if it copied.
bool ensure_bundled_catalog(const Paths& paths);

}  // namespace cardpaths
