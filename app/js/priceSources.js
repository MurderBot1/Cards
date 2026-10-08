/**
 * priceSources.js
 * Looks card prices (USD) up straight from the three card sites, no account service in between:
 *   Magic     Scryfall      POST /cards/collection (up to 75 cards per call)   prices.usd / usd_foil / usd_etched
 *   Pokémon   pokemontcg.io GET /v2/cards?q=id:"a" OR id:"b"                   tcgplayer.prices.*.market
 *   Yu-Gi-Oh! YGOPRODeck    GET cardinfo.php?id=1,2,3                          card_prices[0].tcgplayer_price (per card)
 * These are market prices from those sites, not offers. Cards are identified by the catalog `uid` the app stores
 * (mtg-<scryfall id>, pkm-<id>, ygo-<passcode>[-<set>]); older cards without one are priced by name and set, Magic only.
 *
 * The page asks the sites itself, so each device uses its own address's rate limits and nothing has to be set up. A
 * site that can't be reached (offline, blocked, rate limited) throws for that batch; prices.js then falls back to the
 * account service's shared cache when there is one.
 */

const TIMEOUT_MS = 10000;
const GAP_MS = 120; // Scryfall asks for 50-100 ms between requests

const toPrice = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

const NONE = Object.freeze({ usd: null, usd_foil: null });

// ---- parsing the three sources (pure) ------------------------------------------------------------

export function scryfallPrice(card) {
  const p = (card && card.prices) || {};
  const usd = toPrice(p.usd);
  const foil = toPrice(p.usd_foil) ?? toPrice(p.usd_etched);
  return { usd: usd ?? foil, usd_foil: foil };
}

export function pokemonPrice(card) {
  const prices = (card && card.tcgplayer && card.tcgplayer.prices) || {};
  const market = (kind) => toPrice(prices[kind] && (prices[kind].market ?? prices[kind].mid));
  const foil = market('holofoil') ?? market('reverseHolofoil') ?? market('1stEditionHolofoil') ?? market('unlimitedHolofoil');
  const plain = market('normal') ?? market('1stEditionNormal') ?? market('unlimited');
  return { usd: plain ?? foil, usd_foil: foil };
}

export function yugiohPrice(card) {
  const entry = card && Array.isArray(card.card_prices) ? card.card_prices[0] : null;
  return { usd: toPrice(entry && entry.tcgplayer_price), usd_foil: null };
}

const stripPrefix = (uid, prefix) => (typeof uid === 'string' && uid.startsWith(prefix) ? uid.slice(prefix.length) : null);

export function yugiohPasscode(uid) {
  const rest = stripPrefix(uid, 'ygo-');
  const code = rest ? rest.split('-')[0] : '';
  return /^\d{1,10}$/.test(code) ? code : null;
}

// ---- looking cards up ----------------------------------------------------------------------------

async function getJson(fetchFn, url, init = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetchFn(url, { ...init, headers: { Accept: 'application/json', ...(init.headers || {}) }, signal: controller ? controller.signal : undefined });
    if (!res.ok) {
      const err = new Error(`${new URL(url).host} answered ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Each look-up takes cards (with `.key`, `.name`, `.set`, `.uid`) and resolves to Map(key -> {usd, usd_foil}); a card
// the site doesn't know maps to {usd: null, usd_foil: null}. A failed request throws.

export async function lookUpMtg(fetchFn, cards) {
  const result = new Map();
  for (let i = 0; i < cards.length; i += 75) {
    if (i) await pause(GAP_MS);
    const chunk = cards.slice(i, i + 75);
    const identifiers = chunk.map((c) => {
      const id = stripPrefix(c.uid, 'mtg-');
      if (id) return { id };
      return c.set ? { name: c.name, set: c.set.toLowerCase() } : { name: c.name };
    });
    const data = await getJson(fetchFn, 'https://api.scryfall.com/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers }),
    });
    const byId = new Map();
    const byNameSet = new Map();
    for (const card of data.data || []) {
      byId.set(card.id, card);
      byNameSet.set(`${String(card.name).toLowerCase()}|${String(card.set).toLowerCase()}`, card);
      if (!byNameSet.has(`${String(card.name).toLowerCase()}|`)) byNameSet.set(`${String(card.name).toLowerCase()}|`, card);
    }
    for (const c of chunk) {
      const id = stripPrefix(c.uid, 'mtg-');
      const card = id ? byId.get(id) : byNameSet.get(`${c.name.toLowerCase()}|${(c.set || '').toLowerCase()}`);
      result.set(c.key, card ? scryfallPrice(card) : NONE);
    }
  }
  return result;
}

export async function lookUpPokemon(fetchFn, cards) {
  const result = new Map();
  const known = cards.filter((c) => stripPrefix(c.uid, 'pkm-'));
  for (const c of cards) if (!stripPrefix(c.uid, 'pkm-')) result.set(c.key, NONE);
  for (let i = 0; i < known.length; i += 25) {
    if (i) await pause(GAP_MS);
    const chunk = known.slice(i, i + 25);
    const q = chunk.map((c) => `id:"${stripPrefix(c.uid, 'pkm-').replace(/"/g, '')}"`).join(' OR ');
    const url = `https://api.pokemontcg.io/v2/cards?pageSize=${chunk.length}&select=id,tcgplayer&q=${encodeURIComponent(q)}`;
    const data = await getJson(fetchFn, url);
    const byId = new Map((data.data || []).map((card) => [card.id, card]));
    for (const c of chunk) {
      const card = byId.get(stripPrefix(c.uid, 'pkm-'));
      result.set(c.key, card ? pokemonPrice(card) : NONE);
    }
  }
  return result;
}

export async function lookUpYugioh(fetchFn, cards) {
  const result = new Map();
  const known = cards.filter((c) => yugiohPasscode(c.uid));
  for (const c of cards) if (!yugiohPasscode(c.uid)) result.set(c.key, NONE);
  for (let i = 0; i < known.length; i += 25) {
    if (i) await pause(GAP_MS);
    const chunk = known.slice(i, i + 25);
    const codes = [...new Set(chunk.map((c) => yugiohPasscode(c.uid)))];
    let data;
    try {
      data = await getJson(fetchFn, `https://db.ygoprodeck.com/api/v7/cardinfo.php?id=${codes.join(',')}`);
    } catch (err) {
      // YGOPRODeck answers 400 when none of the ids exist; that is "no price", not an outage
      if (err.status === 400) data = { data: [] };
      else throw err;
    }
    const byCode = new Map((data.data || []).map((card) => [String(card.id), card]));
    for (const c of chunk) {
      const card = byCode.get(yugiohPasscode(c.uid));
      result.set(c.key, card ? yugiohPrice(card) : NONE);
    }
  }
  return result;
}

const LOOKUPS = { mtg: lookUpMtg, pokemon: lookUpPokemon, yugioh: lookUpYugioh };

/**
 * Prices for `cards` ([{key, game, name, set, uid}]) straight from the card sites. Resolves to
 * { prices: Map(key -> {usd, usd_foil}), failed: [cards whose site couldn't be asked] }; never throws.
 */
export async function lookUpPrices(cards, fetchFn = (...args) => fetch(...args)) {
  const prices = new Map();
  const failed = [];
  const byGame = new Map();
  for (const card of cards) {
    if (!LOOKUPS[card.game]) continue;
    if (!byGame.has(card.game)) byGame.set(card.game, []);
    byGame.get(card.game).push(card);
  }
  for (const [game, list] of byGame) {
    try {
      for (const [key, price] of await LOOKUPS[game](fetchFn, list)) prices.set(key, price);
    } catch (err) {
      failed.push(...list);
    }
  }
  return { prices, failed };
}
