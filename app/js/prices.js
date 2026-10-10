/**
 * prices.js
 * Card prices in US dollars, asked of Scryfall, pokemontcg.io and YGOPRODeck directly (priceSources.js). Nothing else
 * is involved: no account, no server of ours. Answers are kept on this device for a few hours.
 *
 * Prices are looked up by the catalog id a card was added with (`uid`); cards saved before that was kept get theirs
 * filled in from the local catalog first (backfillUids). Answers are remembered on this device for a few hours so
 * scrolling around doesn't ask again, and an old price is still shown when the service can't be reached.
 */
import { api } from './api.js';
import { IS_WEB } from './env.js';
import { lookUpPrices } from './priceSources.js';

const CACHE_KEY = 'binder_prices_v1';
const STALE_MS = 6 * 60 * 60 * 1000;
const BACKFILL_PER_RUN = 25;

let cache = {};
try {
  cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {};
} catch (e) { /* start empty */ }

function save() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* storage full or unavailable */ }
}

export const pricesEnabled = () => true;  // the card sites need no setup

export function priceKey(card) {
  return card.uid || `${card.game}|${String(card.name).toLowerCase()}|${card.set || ''}`;
}

// The price of one copy, or null when we don't have one.
export function unitPrice(card) {
  const entry = cache[priceKey(card)];
  if (card.foil === true && entry && typeof entry.usdFoil === 'number') return entry.usdFoil;  // a foil copy: the foil price
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

  // straight from the card sites; a site that can't be reached leaves its cards for next time
  const { prices } = await lookUpPrices(list.map(request));
  for (const [key, price] of prices) remember(key, price);
  if (changed) save();
  return changed;
}

// Cards saved without a catalog id: find theirs in the local catalog (same game, name and set) and store it on the
// card. Resolves to the updated collection, or null if nothing was changed.
const triedBackfill = new Set();
export async function backfillUids(collection) {
  if (!pricesEnabled() || IS_WEB) return null;  // (the website has no catalog to find the ids in)
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
