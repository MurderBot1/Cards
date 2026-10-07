#include "carddownload/download.hpp"

namespace fs = std::filesystem;

namespace carddownload {

std::vector<std::string> missing_files(const fs::path& data_dir, const Options& options) {
    std::vector<std::string> missing;
    for (const auto& name : options.files) {
        std::error_code ec;
        if (!fs::exists(data_dir / fs::u8path(name), ec)) missing.push_back(name);
    }
    return missing;
}

Result download_missing(cardfetch::Transport& transport, const fs::path& data_dir, const Options& options,
                        const std::function<void(const std::string&)>& log) {
    auto say = [&](const std::string& m) {
        if (log) log(m);
    };
    Result result;
    const auto todo = missing_files(data_dir, options);
    size_t number = 0;
    for (const auto& name : todo) {
        ++number;
        if (options.on_file) options.on_file(name, number, todo.size());
        const std::string url = options.base_url + name;
        const fs::path dest = data_dir / fs::u8path(name);
        fs::path part = dest;
        part += ".part";
        say("downloading " + url);
        try {
            fs::create_directories(data_dir);
            long status = transport.get_to_file(url, options.timeout_seconds, part);
            if (!cardfetch::is_success(status)) {
                std::error_code ec;
                fs::remove(part, ec);
                throw cardfetch::Error("HTTP " + std::to_string(status));
            }
            fs::rename(part, dest);
        } catch (const std::exception& e) {
            std::error_code ec;
            fs::remove(part, ec);
            result.ok = false;
            result.error = "could not download " + name + " (" + e.what() + ")";
            say(result.error);
            return result;
        }
        result.downloaded.push_back(name);
        say("downloaded " + name);
    }
    return result;
}

}  // namespace carddownload
