// Card prices (USD). The app asks for the cards it is showing; answers come from a shared D1 cache, and cache misses
// are looked up at the card sources in one request per game:
//   Magic     Scryfall   POST /cards/collection (up to 75 cards per call)  prices.usd / usd_foil / usd_etched
//   Pokémon   pokemontcg.io  GET /v2/cards?q=id:"a" OR id:"b"               tcgplayer.prices.*.market
//   Yu-Gi-Oh! YGOPRODeck  GET cardinfo.php?id=1,2,3                          card_prices[0].tcgplayer_price (per card, not per printing)
// Prices are market prices from those sites, not offers. Cards are identified by the catalog `uid` the app stores
// (mtg-<scryfall id>, pkm-<id>, ygo-<passcode>[-<set>]); older cards without one are priced by name and set for Magic only.
import { clientIp, fail, json, now, readJson } from './lib.js';

export const MAX_CARDS = 60;
const FRESH_SECONDS = 12 * 60 * 60;
const MISSING_SECONDS = 6 * 60 * 60; // a card with no price is asked about again after this
const UPSTREAM_TIMEOUT_MS = 8000;
const RATE_PER_MINUTE = 30;
const USER_AGENT = 'BinderCardTracker/1.0 (personal card-collection app)';
const GAMES = new Set(['mtg', 'pokemon', 'yugioh']);

const toPrice = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

// ---- parsing the three sources (pure; exported for tests) ---------------------------------------

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
  const usd = toPrice(entry && entry.tcgplayer_price);
  return { usd, usd_foil: null };
}

// ---- looking cards up ---------------------------------------------------------------------------

async function getJson(fetchFn, url, init = {}) {
  const res = await fetchFn(url, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

const stripPrefix = (uid, prefix) => (typeof uid === 'string' && uid.startsWith(prefix) ? uid.slice(prefix.length) : null);

// Each look-up takes the cards (with `.key`) and resolves to Map(key -> {usd, usd_foil}); a card the source doesn't
// know maps to {usd: null, usd_foil: null}. A failed request throws, so nothing is cached for it.

async function lookUpMtg(fetchFn, cards) {
  const result = new Map();
  for (let i = 0; i < cards.length; i += 75) {
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
      result.set(c.key, card ? scryfallPrice(card) : { usd: null, usd_foil: null });
    }
  }
  return result;
}

async function lookUpPokemon(fetchFn, cards, apiKey) {
  const result = new Map();
  const known = cards.filter((c) => stripPrefix(c.uid, 'pkm-'));
  for (const c of cards) if (!stripPrefix(c.uid, 'pkm-')) result.set(c.key, { usd: null, usd_foil: null });
  for (let i = 0; i < known.length; i += 25) {
    const chunk = known.slice(i, i + 25);
    const q = chunk.map((c) => `id:"${stripPrefix(c.uid, 'pkm-').replace(/"/g, '')}"`).join(' OR ');
    const url = `https://api.pokemontcg.io/v2/cards?pageSize=${chunk.length}&select=id,tcgplayer&q=${encodeURIComponent(q)}`;
    const data = await getJson(fetchFn, url, { headers: apiKey ? { 'X-Api-Key': apiKey } : {} });
    const byId = new Map((data.data || []).map((card) => [card.id, card]));
    for (const c of chunk) {
      const card = byId.get(stripPrefix(c.uid, 'pkm-'));
      result.set(c.key, card ? pokemonPrice(card) : { usd: null, usd_foil: null });
    }
  }
  return result;
}

async function lookUpYugioh(fetchFn, cards) {
  const result = new Map();
  const passcodeOf = (c) => {
    const rest = stripPrefix(c.uid, 'ygo-');
    const code = rest ? rest.split('-')[0] : '';
    return /^\d{1,10}$/.test(code) ? code : null;
  };
  const known = cards.filter((c) => passcodeOf(c));
  for (const c of cards) if (!passcodeOf(c)) result.set(c.key, { usd: null, usd_foil: null });
  for (let i = 0; i < known.length; i += 25) {
    const chunk = known.slice(i, i + 25);
    const codes = [...new Set(chunk.map(passcodeOf))];
    let data;
    try {
      data = await getJson(fetchFn, `https://db.ygoprodeck.com/api/v7/cardinfo.php?id=${codes.join(',')}`);
    } catch (err) {
      // YGOPRODeck answers 400 when none of the ids exist; that is "no price", not an outage
      if (String(err.message).endsWith('400')) data = { data: [] };
      else throw err;
    }
    const byCode = new Map((data.data || []).map((card) => [String(card.id), card]));
    for (const c of chunk) {
      const card = byCode.get(passcodeOf(c));
      result.set(c.key, card ? yugiohPrice(card) : { usd: null, usd_foil: null });
    }
  }
  return result;
}

// ---- the endpoint -------------------------------------------------------------------------------

async function overRateLimit(db, ip) {
  const at = now();
  const bucket = Math.floor(at / 60);
  const row = await db
    .prepare('INSERT INTO api_hits (ip, bucket, n) VALUES (?, ?, 1) ON CONFLICT(ip, bucket) DO UPDATE SET n = n + 1 RETURNING n')
    .bind(ip, bucket)
    .first();
  if (Math.random() < 0.05) await db.prepare('DELETE FROM api_hits WHERE bucket < ?').bind(bucket - 5).run();
  return row.n > RATE_PER_MINUTE;
}

function cleanRequest(body) {
  if (!body || !Array.isArray(body.cards) || body.cards.length === 0 || body.cards.length > MAX_CARDS) return null;
  const cards = [];
  const seen = new Set();
  for (const c of body.cards) {
    if (!c || typeof c.key !== 'string' || !c.key || c.key.length > 200 || !GAMES.has(c.game)) return null;
    if (typeof c.name !== 'string' || !c.name || c.name.length > 300) return null;
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    cards.push({
      key: c.key,
      game: c.game,
      name: c.name,
      set: typeof c.set === 'string' ? c.set.slice(0, 50) : '',
      uid: typeof c.uid === 'string' && c.uid.length <= 200 ? c.uid : '',
    });
  }
  return cards;
}

// POST { cards: [{key, game, name, set, uid}] } -> { currency: 'USD', prices: {key: {usd, usd_foil, updated_at} | null}, unavailable: [key] }
// `prices[key]` is null when the source has no price for that card; keys in `unavailable` couldn't be looked up right now.
export async function onPrices({ request, env }, fetchFn = fetch) {
  const body = await readJson(request);
  const cards = cleanRequest(body);
  if (!cards) return fail(`Send between 1 and ${MAX_CARDS} cards, each with key, game and name`, 400);
  if (await overRateLimit(env.DB, clientIp(request))) {
    return fail('Too many price requests. Try again in a minute.', 429, { 'Retry-After': '60' });
  }

  const t = now();
  const rows = await env.DB.prepare(`SELECT key, usd, usd_foil, updated_at FROM prices WHERE key IN (${cards.map(() => '?').join(',')})`)
    .bind(...cards.map((c) => c.key))
    .all();
  const prices = {};
  const cached = new Map(rows.results.map((r) => [r.key, r]));
  const misses = [];
  for (const c of cards) {
    const row = cached.get(c.key);
    const hasPrice = row && (row.usd !== null || row.usd_foil !== null);
    if (row && t - row.updated_at < (hasPrice ? FRESH_SECONDS : MISSING_SECONDS)) {
      prices[c.key] = hasPrice ? { usd: row.usd, usd_foil: row.usd_foil, updated_at: row.updated_at } : null;
    } else {
      misses.push(c);
    }
  }

  const unavailable = [];
  const fresh = [];
  const byGame = { mtg: [], pokemon: [], yugioh: [] };
  for (const c of misses) byGame[c.game].push(c);
  const lookups = {
    mtg: (list) => lookUpMtg(fetchFn, list),
    pokemon: (list) => lookUpPokemon(fetchFn, list, env.POKEMONTCG_API_KEY),
    yugioh: (list) => lookUpYugioh(fetchFn, list),
  };
  await Promise.all(
    Object.entries(byGame)
      .filter(([, list]) => list.length > 0)
      .map(async ([game, list]) => {
        try {
          const found = await lookups[game](list);
          for (const c of list) {
            const price = found.get(c.key) || { usd: null, usd_foil: null };
            fresh.push({ key: c.key, ...price });
            prices[c.key] = price.usd !== null || price.usd_foil !== null ? { ...price, updated_at: t } : null;
          }
        } catch (err) {
          console.error(`price lookup for ${game} failed: ${err.message}`);
          for (const c of list) {
            const row = cached.get(c.key); // an old price beats none
            if (row && (row.usd !== null || row.usd_foil !== null)) {
              prices[c.key] = { usd: row.usd, usd_foil: row.usd_foil, updated_at: row.updated_at };
            } else {
              unavailable.push(c.key);
            }
          }
        }
      })
  );

  for (let i = 0; i < fresh.length; i += 18) {
    const chunk = fresh.slice(i, i + 18);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO prices (key, usd, usd_foil, updated_at) VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(',')}`
    )
      .bind(...chunk.flatMap((p) => [p.key, p.usd, p.usd_foil, t]))
      .run();
  }
  return json({ currency: 'USD', prices, unavailable });
}
