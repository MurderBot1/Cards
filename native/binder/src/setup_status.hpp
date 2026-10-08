// What the app is busy setting up in the background (downloading the card catalog, and whatever first-run work comes
// later), so the frontend can show a "setting up" screen with the current task. One task at a time: set_task() names
// what's running now, clear() says setup is done, fail() leaves a message for the screen to show.
#pragma once

#include <filesystem>
#include <mutex>
#include <string>

namespace binder {

class SetupStatus {
public:
    struct Snapshot {
        bool active = false;
        std::string task;             // e.g. "Downloading assets"
        std::string detail;           // e.g. "card-vectors.cvi (2 of 2)"
        unsigned long long bytes = 0; // size so far of `progress_file`, when the task has one
        unsigned long long total = 0; // what `bytes` is heading for, when that's known (else 0)
        std::string error;            // set when setup stopped on a failure
    };

    // `progress_file`: a file that grows while the task runs (its size is reported as `bytes`).
    void set_task(std::string task, std::string detail = "", std::filesystem::path progress_file = {}) {
        std::lock_guard<std::mutex> l(mu_);
        task_ = std::move(task);
        detail_ = std::move(detail);
        progress_file_ = std::move(progress_file);
        total_ = 0;
        error_.clear();
        active_ = true;
    }
    // The size `progress_file` will reach, once known.
    void set_total(unsigned long long total) {
        std::lock_guard<std::mutex> l(mu_);
        total_ = total;
    }
    void clear() {
        std::lock_guard<std::mutex> l(mu_);
        active_ = false;
        task_.clear();
        detail_.clear();
        progress_file_.clear();
        total_ = 0;
    }
    // Ends the active task, remembering why so the screen can say so instead of silently disappearing.
    void fail(std::string error) {
        std::lock_guard<std::mutex> l(mu_);
        active_ = false;
        error_ = std::move(error);
    }

    Snapshot snapshot() const {
        std::lock_guard<std::mutex> l(mu_);
        Snapshot s{active_, task_, detail_, 0, total_, error_};
        if (active_ && !progress_file_.empty()) {
            std::error_code ec;
            auto size = std::filesystem::file_size(progress_file_, ec);
            if (!ec) s.bytes = size;
        }
        return s;
    }

private:
    mutable std::mutex mu_;
    bool active_ = false;
    std::string task_, detail_, error_;
    std::filesystem::path progress_file_;
    unsigned long long total_ = 0;
};

}  // namespace binder
