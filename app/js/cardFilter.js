/**
 * cardFilter.js
 * Filtering and sorting the cards of one list: by game, set, rarity, condition and price, and by name or price.
 * Pure functions on card objects, so the website and the apps share them and they can be tested without a page.
 */

import { missingOf } from './deckOwnership.js';

export const SORTS = [
  { value: '', label: 'Order added' },
  { value: 'name-asc', label: 'Name A–Z' },
  { value: 'name-desc', label: 'Name Z–A' },
  { value: 'price-asc', label: 'Price low–high' },
  { value: 'price-desc', label: 'Price high–low' },
];

const SORT_VALUES = new Set(SORTS.map((s) => s.value));

export function emptyFilter() {
  // `ownership` (decks): '' for every card, 'missing' for cards still needing copies, 'complete' for cards fully had
  return { game: '', set: '', rarity: '', condition: '', ownership: '', minPrice: '', maxPrice: '', sort: '' };
}

// "12.5", "$12.50" and "12,50" all read as 12.5; anything else (including blank) is no limit.
export function parsePrice(text) {
  const cleaned = String(text == null ? '' : text).trim().replace(/^\$/, '').replace(',', '.');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/** How many of the filters (not the sort) are narrowing the list. */
export function activeFilterCount(filter) {
  let n = 0;
  for (const key of ['game', 'set', 'rarity', 'condition']) if (filter[key]) n += 1;
  if (filter.ownership === 'missing' || filter.ownership === 'complete') n += 1;
  if (parsePrice(filter.minPrice) !== null) n += 1;
  if (parsePrice(filter.maxPrice) !== null) n += 1;
  return n;
}

/** True when the list is narrowed or ordered differently from how it is stored. */
export function isCustomView(filter) {
  return activeFilterCount(filter) > 0 || (SORT_VALUES.has(filter.sort) && filter.sort !== '');
}

/**
 * What can be picked in each drop-down, from the cards in the list: { games, sets, rarities, conditions }.
 * Sets and rarities are matched ignoring case (catalogs spell them differently), shown as first seen, sorted.
 */
export function facetValues(cards, defaultCondition = 'Near Mint', conditionOrder = []) {
  const distinct = (values) => {
    const seen = new Map();
    for (const v of values) {
      const text = String(v || '').trim();
      if (text && !seen.has(text.toLowerCase())) seen.set(text.toLowerCase(), text);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  };
  const conditions = distinct(cards.map((c) => c.condition || defaultCondition));
  const rank = (c) => { const i = conditionOrder.indexOf(c); return i === -1 ? conditionOrder.length : i; };
  conditions.sort((a, b) => rank(a) - rank(b));
  return {
    games: distinct(cards.map((c) => c.game)),
    sets: distinct(cards.map((c) => c.set)),
    rarities: distinct(cards.map((c) => c.rarity)),
    conditions,
  };
}

/**
 * The cards that pass the name search and the filters, in the order asked for.
 * `priceOf(card)` is the price of one copy or null; cards with no known price fail a price limit and sort last.
 */
export function filterCards(cards, query, filter, priceOf = () => null, defaultCondition = 'Near Mint') {
  const q = String(query || '').trim().toLowerCase();
  const min = parsePrice(filter.minPrice);
  const max = parsePrice(filter.maxPrice);
  const out = [];
  cards.forEach((card, index) => {
    if (q && !String(card.name || '').toLowerCase().includes(q)) return;
    if (filter.game && card.game !== filter.game) return;
    if (filter.set && !same(card.set, filter.set)) return;
    if (filter.rarity && !same(card.rarity, filter.rarity)) return;
    if (filter.condition && !same(card.condition || defaultCondition, filter.condition)) return;
    if (filter.ownership === 'missing' && missingOf(card) === 0) return;
    if (filter.ownership === 'complete' && missingOf(card) > 0) return;
    const price = priceOf(card);
    if (min !== null || max !== null) {
      if (price === null || price === undefined) return;
      if (min !== null && price < min) return;
      if (max !== null && price > max) return;
    }
    out.push({ card, index, price: price === undefined ? null : price });
  });

  const byName = (a, b) => String(a.card.name || '').localeCompare(String(b.card.name || ''), undefined, { sensitivity: 'base', numeric: true });
  const byPrice = (direction) => (a, b) => {
    if (a.price === null && b.price === null) return 0;
    if (a.price === null) return 1;   // unknown prices go last whichever way it is sorted
    if (b.price === null) return -1;
    return direction * (a.price - b.price);
  };
  const order = {
    'name-asc': byName,
    'name-desc': (a, b) => byName(b, a),
    'price-asc': byPrice(1),
    'price-desc': byPrice(-1),
  }[filter.sort];
  if (order) out.sort((a, b) => order(a, b) || a.index - b.index);
  return out.map((o) => o.card);
}
