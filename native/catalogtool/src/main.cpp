// binder-catalog — builds the card catalog and vector index. See tool.hpp for the steps.
#include <cstdlib>
#include <iostream>

#include "cardfetch/curl_transport.hpp"
#include "cardpaths/cardpaths.hpp"
#include "cardscan/model_source.hpp"
#include "tool.hpp"
#ifdef BINDER_HAVE_ONNX
#include "cardonnx/onnx_models.hpp"
#endif

namespace {

const char* kUsage =
    "binder-catalog — download card data and build the catalog + vector index Binder reads\n"
    "  --data-dir DIR                 where to write (default: Binder's per-user data directory, so the app finds it)\n"
    "  --only mtg|pokemon|yugioh      just one game\n"
    "  --skip-ingest                  don't download card data\n"
    "  --skip-images                  don't download card images\n"
    "  --skip-vectors                 don't compute the image vectors\n"
    "  --keep-images                  keep the scratch images after the vectors are built (debugging)\n"
    "  --refresh-cache                download bulk data again instead of reusing cache/\n"
    "  --image-workers N              concurrent image downloads (default 16)\n"
    "  --ingest-workers N             concurrent per-set downloads for Pokémon (default 16)\n"
    "  --vector-prefetch-workers N    threads preloading images while the model embeds (default 2)\n"
    "It's safe to re-run: every step skips work that's already done, so an interrupted run just resumes.\n";

bool parse(int argc, char** argv, catalogtool::Options& o, bool& help, std::string& error) {
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto value = [&](std::string& out) {
            if (i + 1 >= argc) {
                error = a + " needs a value";
                return false;
            }
            out = argv[++i];
            return true;
        };
        auto number = [&](int& out) {
            std::string v;
            if (!value(v)) return false;
            out = std::atoi(v.c_str());
            if (out < 1) {
                error = a + " must be a positive number";
                return false;
            }
            return true;
        };
        std::string v;
        if (a == "--help" || a == "-h") help = true;
        else if (a == "--skip-ingest") o.skip_ingest = true;
        else if (a == "--skip-images") o.skip_images = true;
        else if (a == "--skip-vectors") o.skip_vectors = true;
        else if (a == "--keep-images") o.keep_images = true;
        else if (a == "--refresh-cache") o.refresh_cache = true;
        else if (a == "--only") {
            if (!value(o.only)) return false;
            if (o.only != "mtg" && o.only != "pokemon" && o.only != "yugioh") {
                error = "--only must be mtg, pokemon or yugioh";
                return false;
            }
        } else if (a == "--data-dir") {
            if (!value(v)) return false;
            o.data_dir = std::filesystem::u8path(v);
        } else if (a == "--image-workers") { if (!number(o.image_workers)) return false; }
        else if (a == "--ingest-workers") { if (!number(o.ingest_workers)) return false; }
        else if (a == "--vector-prefetch-workers") { if (!number(o.vector_prefetch_workers)) return false; }
        else {
            error = "unknown argument: " + a;
            return false;
        }
    }
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    catalogtool::Options options;
    bool help = false;
    std::string error;
    if (!parse(argc, argv, options, help, error)) {
        std::cerr << error << "\n" << kUsage;
        return 2;
    }
    if (help) {
        std::cout << kUsage;
        return 0;
    }
    if (options.data_dir.empty()) options.data_dir = cardpaths::resolve(cardpaths::system_environment()).data_dir;

    auto log = [](const std::string& m) { std::cout << m << std::endl; };
    cardfetch::CurlTransport transport;

    catalogtool::EmbedderFactory embedder = [](const std::filesystem::path& data_dir) -> std::unique_ptr<cardscan::Embedder> {
#ifdef BINDER_HAVE_ONNX
        std::filesystem::path model = data_dir / cardscan::kEmbedderModelFile;
        std::error_code ec;
        if (!std::filesystem::exists(model, ec)) return nullptr;
        return cardonnx::make_embedder(model);
#else
        (void)data_dir;
        return nullptr;
#endif
    };
    return catalogtool::run(options, transport, embedder, log);
}
