// cardingest — turns the three card sources' bulk data into catalog rows (the port of build_scanner_models.py's
// ingest_* functions):
//   MTG        Scryfall "all_cards" bulk export (every printing, including extra languages/promos), gzipped JSONL
//   Pokémon    PokemonTCG/pokemon-tcg-data on GitHub: one JSON file per set
//   Yu-Gi-Oh!  YGOPRODeck cardinfo.php bulk export
// Every download goes through a cardfetch::Fetcher, so it's cached and an interrupted run resumes; each ingest is
// safe to repeat (rows upsert by uid).
#pragma once

#include <cstddef>
#include <functional>
#include <string>

#include "cardcatalog/catalog.hpp"
#include "cardfetch/fetch.hpp"

namespace cardingest {

using Log = std::function<void(const std::string&)>;

struct Sources {
    std::string scryfall_bulk_index = "https://api.scryfall.com/bulk-data";
    std::string pokemon_sets = "https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/sets/en.json";
    // "{id}" is replaced by the set id
    std::string pokemon_set = "https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/cards/en/{id}.json";
    std::string ygoprodeck = "https://db.ygoprodeck.com/api/v7/cardinfo.php";
};

struct Stats {
    std::size_t cards = 0;    // rows written
    std::size_t skipped = 0;  // source entries left out (tokens, art series, entries missing an id or name, failed sets)
};

// How many rows accumulate before one transaction writes them: the point is the transaction, not the statement
// count — a durability cost per card would make MTG's multi-hundred-thousand-printing ingest take hours.
inline constexpr std::size_t kCardBatchSize = 2000;
inline constexpr int kDefaultIngestWorkers = 16;

// Throws cardfetch::Error on a failed download, std::runtime_error if the source's response shape isn't what we expect.
Stats ingest_mtg(cardfetch::Fetcher& fetcher, cardcatalog::Writer& writer, const Log& log, const Sources& sources = {});
Stats ingest_pokemon(cardfetch::Fetcher& fetcher, cardcatalog::Writer& writer, const Log& log,
                     int max_workers = kDefaultIngestWorkers, const Sources& sources = {});
Stats ingest_yugioh(cardfetch::Fetcher& fetcher, cardcatalog::Writer& writer, const Log& log, const Sources& sources = {});

}  // namespace cardingest
