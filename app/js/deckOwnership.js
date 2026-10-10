/**
 * deckOwnership.js
 * Which cards of a deck the person has. A deck card says how many copies it needs (`quantity`) and how many of those
 * the person has (`owned`, from 0, never more than needed; a card with no `owned` is one they don't have yet).
 * Pure functions on card objects, shared by the apps and the website.
 */
import { kindOf } from './listKinds.js';

/** Copies of this deck card the person has: a whole number from 0 to `quantity`. */
export function ownedOf(card) {
  const need = Math.max(0, Math.floor(Number(card && card.quantity) || 0));
  const have = Math.floor(Number(card && card.owned) || 0);
  return Math.min(Math.max(0, have), need);
}

/** Copies this deck card still needs. */
export function missingOf(card) {
  return Math.max(0, Math.floor(Number(card && card.quantity) || 0)) - ownedOf(card);
}

/** { needed, owned, missing, rows, rowsMissing, rowsComplete } for a deck's cards: copies, and rows (different cards). */
export function deckTotals(cards) {
  const t = { needed: 0, owned: 0, missing: 0, rows: 0, rowsMissing: 0, rowsComplete: 0 };
  for (const card of cards || []) {
    const need = Math.max(0, Math.floor(Number(card.quantity) || 0));
    const have = ownedOf(card);
    t.rows += 1;
    t.needed += need;
    t.owned += have;
    t.missing += need - have;
    if (have >= need) t.rowsComplete += 1;
    else t.rowsMissing += 1;
  }
  return t;
}

const matchKey = (card) => `${card.game}|${String(card.name || '').trim().toLowerCase()}`;

/**
 * What the person's collections already hold of a deck's cards: { deck card id: copies }, for the "check my
 * collections" button. A card matches by game and name (any printing will do for a deck); only lists that are
 * collections count (not other decks, tradelists or wishlists); copies are shared out between rows of the same card in
 * the order the deck has them, and no row is given more than it needs.
 */
export function ownedFromCollections(deckCards, lists) {
  const pool = new Map();
  for (const list of lists || []) {
    if (kindOf(list) !== 'collection') continue;
    for (const card of list.cards || []) {
      const key = matchKey(card);
      pool.set(key, (pool.get(key) || 0) + Math.max(0, Math.floor(Number(card.quantity) || 0)));
    }
  }
  const owned = {};
  for (const card of deckCards || []) {
    const key = matchKey(card);
    const need = Math.max(0, Math.floor(Number(card.quantity) || 0));
    const take = Math.min(need, pool.get(key) || 0);
    pool.set(key, (pool.get(key) || 0) - take);
    owned[card.id] = take;
  }
  return owned;
}
