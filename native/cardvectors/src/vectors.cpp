#include "cardvectors/vectors.hpp"

#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <fstream>
#include <future>
#include <map>
#include <mutex>
#include <sstream>
#include <thread>

#include "cardscan/image.hpp"
#include "cardvec/flat_index.hpp"

namespace fs = std::filesystem;

namespace cardvectors {

std::string safe_filename(const std::string& uid) {
    std::string out;
    for (unsigned char c : uid) {
        bool bad = c < 0x20 || c == '<' || c == '>' || c == ':' || c == '"' || c == '/' || c == '\\' || c == '|' || c == '?' || c == '*';
        out += bad ? '_' : static_cast<char>(c);
    }
    return out;
}

// ============================================================================
// images
// ============================================================================
ImageStats download_images(cardcatalog::Writer& writer, cardfetch::Fetcher& fetcher, const fs::path& images_dir,
                           const std::string& only_game, int workers, double pause_seconds, const Log& log) {
    auto rows = writer.cards_needing_images(only_game);
    log("[images] " + std::to_string(rows.size()) + " images to download (" + std::to_string(workers) + " workers)...");

    ImageStats stats;
    struct Job {
        std::string uid, url;
        fs::path dest;
        std::string rel;
    };
    std::vector<Job> jobs;
    std::vector<std::pair<std::string, std::string>> already;  // on disk from a previous run: just fix up the catalog row
    for (const auto& r : rows) {
        std::string name = safe_filename(r.uid) + ".jpg";
        fs::path dest = images_dir / r.game / name;
        std::string rel = r.game + "/" + name;
        std::error_code ec;
        if (fs::exists(dest, ec)) already.emplace_back(r.uid, rel);
        else jobs.push_back({r.uid, r.image_url, dest, rel});
    }
    writer.set_image_paths(already);
    stats.reused = already.size();
    if (jobs.empty()) {
        log("[images] done.");
        return stats;
    }

    // Workers do the network GET + decode + JPEG re-encode only. The catalog is written from this thread, as results arrive.
    struct Result {
        std::size_t job;
        std::string error;
    };
    std::mutex mu;
    std::condition_variable cv;
    std::deque<Result> done;
    std::atomic<std::size_t> next{0};
    auto worker = [&] {
        for (;;) {
            std::size_t i = next.fetch_add(1);
            if (i >= jobs.size()) return;
            const Job& job = jobs[i];
            Result r{i, ""};
            try {
                std::string bytes = fetcher.get_bytes(job.url, 30);
                auto img = cardscan::decode_image(bytes);
                if (!img) throw std::runtime_error("not a readable image");
                auto jpeg = cardscan::encode_jpeg(*img, 88);
                if (!jpeg) throw std::runtime_error("could not re-encode as JPEG");
                fs::create_directories(job.dest.parent_path());
                std::ofstream out(job.dest, std::ios::binary | std::ios::trunc);
                out.write(jpeg->data(), static_cast<std::streamsize>(jpeg->size()));
                if (!out) throw std::runtime_error("could not write " + job.dest.u8string());
                if (pause_seconds > 0) std::this_thread::sleep_for(std::chrono::duration<double>(pause_seconds));
            } catch (const std::exception& e) {
                r.error = e.what();
            }
            {
                std::lock_guard<std::mutex> lock(mu);
                done.push_back(std::move(r));
            }
            cv.notify_one();
        }
    };
    std::vector<std::thread> pool;
    int n_threads = std::max(1, std::min<int>(workers, static_cast<int>(jobs.size())));
    for (int i = 0; i < n_threads; ++i) pool.emplace_back(worker);

    std::vector<std::pair<std::string, std::string>> pending;
    for (std::size_t received = 0; received < jobs.size(); ++received) {
        Result r;
        {
            std::unique_lock<std::mutex> lock(mu);
            cv.wait(lock, [&] { return !done.empty(); });
            r = std::move(done.front());
            done.pop_front();
        }
        const Job& job = jobs[r.job];
        if (!r.error.empty()) {
            ++stats.failed;
            log("[images] failed " + job.uid + ": " + r.error);
        } else {
            ++stats.downloaded;
            pending.emplace_back(job.uid, job.rel);
        }
        if (pending.size() >= 200) {  // commit in batches, not one transaction per image
            writer.set_image_paths(pending);
            pending.clear();
        }
        if ((received + 1) % 1000 == 0) log("[images] " + std::to_string(received + 1) + "/" + std::to_string(jobs.size()));
    }
    for (auto& t : pool) t.join();
    writer.set_image_paths(pending);
    log("[images] done: " + std::to_string(stats.downloaded) + " downloaded, " + std::to_string(stats.reused) + " already there, " +
        std::to_string(stats.failed) + " failed.");
    return stats;
}

// ============================================================================
// vectors
// ============================================================================
namespace {

std::optional<cardscan::Image> load_image(const fs::path& file) {
    std::ifstream f(file, std::ios::binary);
    if (!f) return std::nullopt;
    std::ostringstream ss;
    ss << f.rdbuf();
    return cardscan::decode_image(ss.str());
}

void normalize_l2(std::vector<float>& v) {
    cardvec::normalize_L2(v.data(), 1, static_cast<std::int64_t>(v.size()));
}

// Write-then-rename: an interrupted save can't leave a corrupt index behind.
void save_index_atomically(const cardvec::FlatIndexIP& index, const fs::path& path) {
    if (path.has_parent_path()) fs::create_directories(path.parent_path());
    fs::path tmp = path;
    tmp += ".part";
    index.save(tmp.u8string());
    fs::rename(tmp, path);
}

}  // namespace

VectorStats build_vectors(cardcatalog::Writer& writer, cardscan::Embedder& embedder, const fs::path& images_dir,
                          const fs::path& index_path, const std::string& only_game, int batch_size, int prefetch_workers,
                          const Log& log) {
    VectorStats stats;
    auto rows = writer.cards_needing_vectors(only_game);
    log("[vectors] " + std::to_string(rows.size()) + " cards to embed...");
    if (rows.empty()) {
        log("[vectors] nothing to do.");
        std::error_code ec;
        if (fs::exists(index_path, ec)) stats.total_vectors = cardvec::FlatIndexIP::load(index_path.u8string()).ntotal();
        return stats;
    }
    if (batch_size < 1) batch_size = 1;

    // The existing index, or one created once we know the embedding size.
    std::unique_ptr<cardvec::FlatIndexIP> index;
    std::error_code ec;
    if (fs::exists(index_path, ec)) index = std::make_unique<cardvec::FlatIndexIP>(cardvec::FlatIndexIP::load(index_path.u8string()));
    std::int64_t next_idx = index ? index->ntotal() : 0;  // where new vectors start, so uid <-> row index stays consistent

    std::vector<std::vector<std::pair<std::string, std::string>>> batches;
    for (std::size_t i = 0; i < rows.size(); i += static_cast<std::size_t>(batch_size))
        batches.emplace_back(rows.begin() + i, rows.begin() + std::min(rows.size(), i + static_cast<std::size_t>(batch_size)));

    struct Loaded {
        std::vector<cardscan::Image> images;
        std::vector<std::string> uids;
        std::size_t unreadable = 0;
    };
    // Decoding a batch from disk is I/O + CPU work that doesn't touch the model, so a few threads load upcoming batches
    // while this one is being embedded, instead of the model sitting idle during every load.
    auto load_batch = [&](std::size_t b) {
        Loaded out;
        for (const auto& [uid, rel] : batches[b]) {
            auto img = load_image(images_dir / fs::u8path(rel));
            if (!img) {
                ++out.unreadable;
                continue;
            }
            out.images.push_back(std::move(*img));
            out.uids.push_back(uid);
        }
        return out;
    };
    std::map<std::size_t, std::future<Loaded>> pending_loads;
    std::size_t lookahead = static_cast<std::size_t>(std::max(1, prefetch_workers));
    for (std::size_t i = 0; i < std::min(lookahead, batches.size()); ++i) pending_loads[i] = std::async(std::launch::async, load_batch, i);

    std::vector<std::pair<std::int64_t, std::string>> unrecorded;  // vectors in the index file not yet recorded in the catalog
    int since_checkpoint = 0;
    auto checkpoint = [&] {
        if (!index) return;
        save_index_atomically(*index, index_path);  // first the index...
        writer.set_vector_indexes(unrecorded);       // ...then the rows that point into it
        unrecorded.clear();
        since_checkpoint = 0;
    };

    for (std::size_t b = 0; b < batches.size(); ++b) {
        Loaded loaded = pending_loads[b].get();
        pending_loads.erase(b);
        if (b + lookahead < batches.size()) pending_loads[b + lookahead] = std::async(std::launch::async, load_batch, b + lookahead);
        stats.skipped += loaded.unreadable;
        if (loaded.unreadable) log("[vectors] skipped " + std::to_string(loaded.unreadable) + " unreadable image(s)");
        if (loaded.images.empty()) continue;

        std::vector<float> flat;
        std::int64_t dim = 0;
        for (const auto& img : loaded.images) {
            std::vector<float> v = embedder.embed(img);
            normalize_l2(v);  // so inner product == cosine similarity
            if (dim == 0) dim = static_cast<std::int64_t>(v.size());
            if (static_cast<std::int64_t>(v.size()) != dim) throw std::runtime_error("the embedder returned vectors of different sizes");
            flat.insert(flat.end(), v.begin(), v.end());
        }
        if (!index) index = std::make_unique<cardvec::FlatIndexIP>(dim);
        if (index->dim() != dim)
            throw std::runtime_error("the existing vector index has dimension " + std::to_string(index->dim()) + " but the embedder produces " +
                                     std::to_string(dim) + "; delete " + index_path.u8string() + " (and re-run) to rebuild it");
        index->add(flat.data(), static_cast<std::int64_t>(loaded.images.size()));
        for (const auto& uid : loaded.uids) unrecorded.emplace_back(next_idx++, uid);
        stats.embedded += loaded.images.size();

        if (++since_checkpoint >= kCheckpointBatches) checkpoint();
        if ((b + 1) % 100 == 0) log("[vectors] " + std::to_string(b + 1) + "/" + std::to_string(batches.size()) + " batches");
    }
    if (since_checkpoint > 0 || !unrecorded.empty()) checkpoint();  // whatever's left since the last checkpoint

    stats.total_vectors = index ? index->ntotal() : 0;
    log("[vectors] done — " + std::to_string(stats.total_vectors) + " vectors in " + index_path.u8string());
    return stats;
}

bool cleanup_images(const fs::path& images_dir, const std::string& only_game, const Log& log) {
    fs::path target = only_game.empty() ? images_dir : images_dir / only_game;
    std::error_code ec;
    if (!fs::exists(target, ec)) return false;
    fs::remove_all(target, ec);
    log("[cleanup] removed local art-crop images at " + target.u8string());
    return !ec;
}

}  // namespace cardvectors
