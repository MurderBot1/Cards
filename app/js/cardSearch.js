/**
 * cardSearch.js
 * Card search for the website, which has no local card catalog: the card sites are asked directly (the same ones
 * priceSources.js asks for prices).
 *   Magic     Scryfall      GET /cards/search?q=bolt&unique=prints&order=name   175 per page
 *   Pokémon   pokemontcg.io GET /v2/cards?q=name:char*&page=2&pageSize=40
 *   Yu-Gi-Oh! YGOPRODeck    GET cardinfo.php?fname=dark&num=40&offset=40         one result per card, not per printing
 * Results have the shape the local backend's /api/search gives: { id, name, set, rarity, image, game }, where `id` is
 * the catalog id the app stores for a card (mtg-<scryfall id>, pkm-<id>, ygo-<passcode>), which prices are looked up by.
 * An empty query lists nothing (the sites have no "everything" to page through).
 */
const TIMEOUT_MS = 10000;
const SCRYFALL_PAGE = 175;

const titleCase = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');

async function getJson(fetchFn, url, { allowMissing = [] } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetchFn(url, { headers: { Accept: 'application/json' }, signal: controller ? controller.signal : undefined });
    if (allowMissing.includes(res.status)) return null;  // "no results" is a 404 / 400 at some of the sites
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---- turning each site's cards into search results (pure) ---------------------------------------------------

export function scryfallResult(card) {
  const faces = Array.isArray(card.card_faces) ? card.card_faces : [];
  const images = card.image_uris || (faces[0] && faces[0].image_uris) || {};
  return {
    id: `mtg-${card.id}`,
    name: card.name,
    set: String(card.set || '').toUpperCase(),
    rarity: titleCase(card.rarity),
    image: images.small || images.normal || '',
    game: 'mtg',
  };
}

export function pokemonResult(card) {
  const set = card.set || {};
  return {
    id: `pkm-${card.id}`,
    name: card.name,
    set: String(set.ptcgoCode || set.id || '').toUpperCase(),
    rarity: card.rarity || '',
    image: (card.images && (card.images.small || card.images.large)) || '',
    game: 'pokemon',
  };
}

export function yugiohResult(card) {
  const printing = Array.isArray(card.card_sets) && card.card_sets[0] ? card.card_sets[0] : {};
  const image = Array.isArray(card.card_images) && card.card_images[0] ? card.card_images[0] : {};
  return {
    id: `ygo-${card.id}`,
    name: card.name,
    set: String(printing.set_code || '').split('-')[0],
    rarity: printing.set_rarity || '',
    image: image.image_url_small || image.image_url || '',
    game: 'yugioh',
  };
}

// ---- looking up one window of results ----------------------------------------------------------------------

const pages = new Map();  // recent Scryfall pages, so scrolling through one doesn't ask again

async function searchMtg(fetchFn, query, limit, offset) {
  const first = Math.floor(offset / SCRYFALL_PAGE) + 1;
  const last = Math.floor((offset + limit - 1) / SCRYFALL_PAGE) + 1;
  const results = [];
  for (let page = first; page <= last; page++) {
    const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&unique=prints&order=name&page=${page}`;
    let cards = pages.get(url);
    if (!cards) {
      const data = await getJson(fetchFn, url, { allowMissing: [404] });
      cards = data && Array.isArray(data.data) ? data.data.map(scryfallResult) : [];
      if (pages.size > 8) pages.delete(pages.keys().next().value);
      pages.set(url, cards);
    }
    results.push(...cards);
    if (cards.length < SCRYFALL_PAGE) break;
  }
  const start = offset - (first - 1) * SCRYFALL_PAGE;
  return results.slice(start, start + limit);
}

async function searchPokemon(fetchFn, query, limit, offset) {
  const terms = query.split(/\s+/).filter(Boolean).map((t) => `name:${t.replace(/["*:()\\]/g, '')}*`).filter((t) => t.length > 6);
  if (terms.length === 0) return [];
  // pokemontcg.io pages by number: a window that starts on a page boundary is one request, anything else reads from the top
  const aligned = offset % limit === 0;
  const pageSize = aligned ? limit : Math.min(250, offset + limit);
  const page = aligned ? offset / limit + 1 : 1;
  const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(terms.join(' '))}&orderBy=name&pageSize=${pageSize}&page=${page}&select=id,name,set,rarity,images`;
  const data = await getJson(fetchFn, url);
  const cards = (data && Array.isArray(data.data) ? data.data : []).map(pokemonResult);
  return aligned ? cards : cards.slice(offset, offset + limit);
}

async function searchYugioh(fetchFn, query, limit, offset) {
  const url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(query)}&num=${limit}&offset=${offset}&misc=no`;
  const data = await getJson(fetchFn, url, { allowMissing: [400] });  // answers 400 when nothing matches
  return (data && Array.isArray(data.data) ? data.data : []).map(yugiohResult);
}

const SEARCHES = { mtg: searchMtg, pokemon: searchPokemon, yugioh: searchYugioh };

/** `limit` results starting `offset` results in for `query` in `game`, straight from that game's card site. */
export async function searchCardsWeb(game, query, { limit = 30, offset = 0 } = {}, fetchFn = (...args) => fetch(...args)) {
  const q = String(query || '').trim();
  const search = SEARCHES[game];
  if (!q || !search) return [];
  return search(fetchFn, q, limit, offset);
}
