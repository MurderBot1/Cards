// The shared price cache. The app looks card prices up at Scryfall, pokemontcg.io and YGOPRODeck itself (app/js/
// priceSources.js); this only remembers what it found so other devices can skip the look-up:
//   POST /api/prices/cached  { keys: [...] }              -> { currency, prices: { key: {usd, usd_foil, updated_at} | null } }
//   POST /api/prices/store   { prices: [{key, usd, usd_foil}] }   (signed in)  -> { stored: n }
// `cached` only answers for keys it holds a fresh answer for (a null means "looked up, the site has no price"); a key it
// leaves out is for the app to look up. Keys are the catalog ids the app stores for cards (mtg-<scryfall id>, pkm-<id>,
// ygo-<passcode>[-<set>]). Prices are market prices from those sites, not offers.
import { clientIp, fail, json, now, readJson, sessionUser } from './lib.js';

export const MAX_KEYS = 90; // D1 allows 100 bound parameters per statement
export const MAX_STORE = 60;
const FRESH_SECONDS = 12 * 60 * 60;
const MISSING_SECONDS = 6 * 60 * 60; // a card with no price is asked about again after this
const KEEP_SECONDS = 30 * 60; // a price stored this recently isn't overwritten (one device's look-up is enough)
const RATE_PER_MINUTE = 60;
const KEY = /^(mtg|pkm|ygo)-[A-Za-z0-9_.-]{1,120}$/;
const MAX_PRICE = 1_000_000;

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

const tooMany = () => fail('Too many price requests. Try again in a minute.', 429, { 'Retry-After': '60' });

async function rowsFor(db, keys) {
  const rows = await db
    .prepare(`SELECT key, usd, usd_foil, updated_at FROM prices WHERE key IN (${keys.map(() => '?').join(',')})`)
    .bind(...keys)
    .all();
  return new Map(rows.results.map((r) => [r.key, r]));
}

export async function onCachedPrices({ request, env }) {
  const body = await readJson(request);
  const keys = body && Array.isArray(body.keys) ? [...new Set(body.keys)] : null;
  if (!keys || keys.length === 0 || keys.length > MAX_KEYS || !keys.every((k) => typeof k === 'string' && KEY.test(k))) {
    return fail(`Send between 1 and ${MAX_KEYS} card keys`, 400);
  }
  if (await overRateLimit(env.DB, clientIp(request))) return tooMany();

  const t = now();
  const rows = await rowsFor(env.DB, keys);
  const prices = {};
  for (const key of keys) {
    const row = rows.get(key);
    if (!row) continue;
    const hasPrice = row.usd !== null || row.usd_foil !== null;
    if (t - row.updated_at < (hasPrice ? FRESH_SECONDS : MISSING_SECONDS)) {
      prices[key] = hasPrice ? { usd: row.usd, usd_foil: row.usd_foil, updated_at: row.updated_at } : null;
    }
  }
  return json({ currency: 'USD', prices });
}

const cleanPrice = (v) => {
  if (v === null || v === undefined) return null;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_PRICE ? Math.round(v * 100) / 100 : undefined;
};

export async function onStorePrices({ request, env }) {
  if (!(await sessionUser(env.DB, request))) return fail('Sign in to share prices', 401);
  const body = await readJson(request);
  if (!body || !Array.isArray(body.prices) || body.prices.length === 0 || body.prices.length > MAX_STORE) {
    return fail(`Send between 1 and ${MAX_STORE} prices`, 400);
  }
  const entries = new Map();
  for (const p of body.prices) {
    const usd = p ? cleanPrice(p.usd) : undefined;
    const foil = p ? cleanPrice(p.usd_foil) : undefined;
    if (!p || typeof p.key !== 'string' || !KEY.test(p.key) || usd === undefined || foil === undefined) {
      return fail('Each price needs a card key and usd / usd_foil numbers (or null)', 400);
    }
    entries.set(p.key, { key: p.key, usd, usd_foil: foil });
  }
  if (await overRateLimit(env.DB, clientIp(request))) return tooMany();

  const t = now();
  const existing = await rowsFor(env.DB, [...entries.keys()]);
  const fresh = [...entries.values()].filter((e) => {
    const row = existing.get(e.key);
    return !row || t - row.updated_at >= KEEP_SECONDS;
  });
  for (let i = 0; i < fresh.length; i += 18) {
    const chunk = fresh.slice(i, i + 18);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO prices (key, usd, usd_foil, updated_at) VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(',')}`
    )
      .bind(...chunk.flatMap((p) => [p.key, p.usd, p.usd_foil, t]))
      .run();
  }
  return json({ stored: fresh.length });
}
