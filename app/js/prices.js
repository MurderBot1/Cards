/**
 * prices.js
 * Card prices in US dollars. Every look-up goes straight to Scryfall, pokemontcg.io and YGOPRODeck (priceSources.js), so
 * no account or setup is needed. The account service (config.js) is only a shared cache: when it is configured, prices
 * other devices already found are read from it first, and a signed-in device writes what it looked up back to it.
 *
 * Prices are looked up by the catalog id a card was added with (`uid`); cards saved before that was kept get theirs
 * filled in from the local catalog first (backfillUids). Answers are remembered on this device for a few hours so
 * scrolling around doesn't ask again, and an old price is still shown when the service can't be reached.
 */
import { AUTH_URL } from './config.js';
import { accountRequest, api } from './api.js';
import { lookUpPrices } from './priceSources.js';
import { getSession } from './session.js';

const CACHE_KEY = 'binder_prices_v1';
const STALE_MS = 6 * 60 * 60 * 1000;
const CACHE_CHUNK = 90; // keys per shared-cache read (the service accepts up to 90)
const STORE_CHUNK = 60; // prices per shared-cache write
const CATALOG_KEY = /^(mtg|pkm|ygo)-[A-Za-z0-9_.-]{1,120}$/; // the cache only holds cards that have a catalog id
const BACKFILL_PER_RUN = 25;

let cache = {};
try {
  cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {};
} catch (e) { /* start empty */ }

function save() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* storage full or unavailable */ }
}

export const pricesEnabled = () => true;  // the card sites need no setup; the account service is only a fallback

export function priceKey(card) {
  return card.uid || `${card.game}|${String(card.name).toLowerCase()}|${card.set || ''}`;
}

// The price of one copy, or null when we don't have one.
export function unitPrice(card) {
  const entry = cache[priceKey(card)];
  return entry && typeof entry.usd === 'number' ? entry.usd : null;
}

export function formatUsd(amount) {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// What a list of owned cards is worth: { total, priced, unpriced } where unpriced counts cards with no known price.
export function collectionValue(cards) {
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  for (const card of cards) {
    const price = unitPrice(card);
    if (price === null) unpriced += 1;
    else {
      total += price * (Number(card.quantity) || 0);
      priced += 1;
    }
  }
  return { total, priced, unpriced };
}

// Asks for the prices of any of these cards we don't have (or that are stale). Resolves to true if anything changed.
// Never throws: offline or a busy service just leaves what we already know.
export async function loadPrices(cards) {
  if (!pricesEnabled()) return false;
  const wanted = new Map();
  const now = Date.now();
  for (const card of cards) {
    const key = priceKey(card);
    const entry = cache[key];
    if (!entry || now - entry.at > STALE_MS) wanted.set(key, card);
  }
  const list = [...wanted.entries()];
  let changed = false;
  const remember = (key, price) => {
    cache[key] = price
      ? { usd: price.usd ?? null, usdFoil: price.usd_foil ?? null, at: Date.now() }
      : { usd: null, usdFoil: null, at: Date.now() };
    changed = true;
  };
  const request = ([key, c]) => ({ key, game: c.game, name: c.name, set: c.set || '', uid: c.uid || '' });
  const shareable = ([key]) => CATALOG_KEY.test(key);

  // 1. the shared cache (never an error: it is only a shortcut)
  const known = new Set();
  if (AUTH_URL) {
    const candidates = list.filter(shareable);
    for (let i = 0; i < candidates.length; i += CACHE_CHUNK) {
      const part = candidates.slice(i, i + CACHE_CHUNK);
      try {
        const response = await accountRequest('/prices/cached', { body: { keys: part.map(([key]) => key) } });
        for (const [key] of part) {
          if (Object.prototype.hasOwnProperty.call(response.prices, key)) {
            remember(key, response.prices[key]);
            known.add(key);
          }
        }
      } catch (err) {
        break;
      }
    }
  }

  // 2. everything else straight from the card sites
  const direct = await lookUpPrices(list.filter(([key]) => !known.has(key)).map(request));
  for (const [key, price] of direct.prices) remember(key, price);

  // 3. share what was just looked up, if signed in
  const session = getSession();
  if (AUTH_URL && session) {
    const found = [...direct.prices].filter(([key]) => CATALOG_KEY.test(key));
    for (let i = 0; i < found.length; i += STORE_CHUNK) {
      try {
        await accountRequest('/prices/store', {
          token: session.token,
          body: { prices: found.slice(i, i + STORE_CHUNK).map(([key, p]) => ({ key, usd: p.usd, usd_foil: p.usd_foil })) },
        });
      } catch (err) {
        break;
      }
    }
  }
  if (changed) save();
  return changed;
}

// Cards saved without a catalog id: find theirs in the local catalog (same game, name and set) and store it on the
// card. Resolves to the updated collection, or null if nothing was changed.
const triedBackfill = new Set();
export async function backfillUids(collection) {
  if (!pricesEnabled()) return null;
  let latest = null;
  let done = 0;
  for (const card of collection.cards) {
    if (card.uid || triedBackfill.has(card.id)) continue;
    if (done >= BACKFILL_PER_RUN) break;
    triedBackfill.add(card.id);
    done += 1;
    try {
      const results = await api.searchCards(card.game, card.name);
      const sameName = results.filter((r) => r.name === card.name);
      const match = sameName.find((r) => (r.set || '') === (card.set || '')) || (card.set ? null : sameName[0]);
      if (match && match.id) latest = (await api.updateCardUid(collection.id, card.id, match.id)) || latest;
    } catch (err) { /* the catalog may still be downloading: skip */ }
  }
  return latest;
}
