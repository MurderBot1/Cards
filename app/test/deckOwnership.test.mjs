import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deckTotals, missingOf, ownedFromCollections, ownedOf } from '../js/deckOwnership.js';

const card = (id, name, quantity, over = {}) => ({ id, name, game: 'mtg', set: 'M10', quantity, ...over });

test('what is had is a whole number from 0 up to what is needed', () => {
  assert.equal(ownedOf(card('a', 'Bolt', 4)), 0, 'no owned: not had yet');
  assert.equal(ownedOf(card('a', 'Bolt', 4, { owned: 3 })), 3);
  assert.equal(ownedOf(card('a', 'Bolt', 4, { owned: 9 })), 4, 'never more than needed');
  assert.equal(ownedOf(card('a', 'Bolt', 4, { owned: -2 })), 0);
  assert.equal(ownedOf(card('a', 'Bolt', 4, { owned: 'x' })), 0);
  assert.equal(ownedOf(null), 0);
  assert.equal(missingOf(card('a', 'Bolt', 4, { owned: 3 })), 1);
  assert.equal(missingOf(card('a', 'Bolt', 4)), 4);
  assert.equal(missingOf(card('a', 'Bolt', 4, { owned: 4 })), 0);
});

test('deck totals: copies and rows', () => {
  assert.deepEqual(deckTotals([]), { needed: 0, owned: 0, missing: 0, rows: 0, rowsMissing: 0, rowsComplete: 0 });
  const t = deckTotals([card('a', 'Bolt', 4, { owned: 4 }), card('b', 'Ring', 1), card('c', 'Shock', 3, { owned: 1 })]);
  assert.deepEqual(t, { needed: 8, owned: 5, missing: 3, rows: 3, rowsMissing: 2, rowsComplete: 1 });
});

test('checking the collections: by game and name, collections only, shared out in deck order', () => {
  const lists = [
    { id: 'c1', name: 'Binder', cards: [card('x', 'Lightning Bolt', 2, { set: 'M11' }), card('y', 'sol ring', 1)] },
    { id: 'c2', kind: undefined, name: 'Other', cards: [card('z', 'Lightning Bolt', 1, { set: 'LEA' }), { id: 'w', name: 'Lightning Bolt', game: 'pokemon', quantity: 9 }] },
    { id: 'd1', kind: 'deck', name: 'Another deck', cards: [card('q', 'Counterspell', 4)] },
    { id: 't1', kind: 'tradelist', name: 'Trades', cards: [card('r', 'Counterspell', 4)] },
    { id: 'w1', kind: 'wishlist', name: 'Wants', cards: [card('s', 'Counterspell', 4)] },
  ];
  const deck = [
    card('a', 'Lightning Bolt', 2, { set: 'M10' }),   // 3 owned in all (two printings): takes 2
    card('b', 'Lightning Bolt', 4, { set: 'LEA' }),   // 1 left
    card('c', 'Sol Ring', 1),
    card('d', 'Counterspell', 2),                      // decks, tradelists and wishlists do not count
  ];
  assert.deepEqual(ownedFromCollections(deck, lists), { a: 2, b: 1, c: 1, d: 0 });
  assert.deepEqual(ownedFromCollections(deck, []), { a: 0, b: 0, c: 0, d: 0 });
  assert.deepEqual(ownedFromCollections([], lists), {});
});
