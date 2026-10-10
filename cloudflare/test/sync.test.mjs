import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanDoc, limitMessage, mergeDocs } from '../src/sync.js';

const card = (id, over = {}) => ({ id, name: `Card ${id}`, game: 'mtg', set: 'M10', rarity: '', image: '', condition: 'Near Mint', quantity: 1, updated: 100, ...over });
const doc = (over = {}) => ({ id: 'c1', name: 'Binder', updated: 100, cards: [], tomb: {}, ...over });
const ids = (d) => d.cards.map((c) => c.id);

test('cleanDoc accepts good docs and rejects bad ones', () => {
  assert.deepEqual(cleanDoc({ id: 'x', deleted: 5 }), { id: 'x', deleted: 5 });
  assert.equal(cleanDoc({ id: 'x', deleted: 'no' }), null);
  assert.equal(cleanDoc({ name: 'no id', cards: [] }), null);
  assert.equal(cleanDoc({ id: 'x', name: 'n', cards: 'nope' }), null);
  assert.equal(cleanDoc({ id: 'x', name: 'n', cards: [{ id: 'a', name: 'n', game: 'digimon', quantity: 1 }] }), null);
  const clean = cleanDoc({ id: 'x', name: 'n', updated: 7, cards: [{ id: 'a', name: 'Bolt', game: 'mtg', quantity: 2, condition: 'Mint', evil: '<script>' }], tomb: { z: 3, bad: 'x' } });
  assert.equal(clean.cards[0].condition, 'Near Mint'); // unknown condition falls back
  assert.equal(clean.cards[0].evil, undefined); // unknown fields are dropped
  assert.deepEqual(clean.tomb, { z: 3 });
  assert.equal(cleanDoc({ id: 'x', name: 'n', cards: [] }).updated, 1);
});

test('finish, language and collector number survive, and only when they say something', () => {
  const clean = cleanDoc({ id: 'x', name: 'n', updated: 7, cards: [
    { id: 'a', name: 'Bolt', game: 'mtg', quantity: 1, foil: true, language: 'Japanese', number: '146' },
    { id: 'b', name: 'Bolt', game: 'mtg', quantity: 1, foil: false, language: '', number: 5 },
    { id: 'c', name: 'Bolt', game: 'mtg', quantity: 1, foil: 'yes' },
  ] });
  assert.deepEqual([clean.cards[0].foil, clean.cards[0].language, clean.cards[0].number], [true, 'Japanese', '146']);
  assert.equal('foil' in clean.cards[1] || 'language' in clean.cards[1] || 'number' in clean.cards[1], false);
  assert.equal('foil' in clean.cards[2], false, 'only a real true counts');
});

test('cards added on two devices are both kept', () => {
  const a = doc({ cards: [card('a1')], updated: 110 });
  const b = doc({ cards: [card('b1')], updated: 120 });
  const m = mergeDocs(a, b);
  assert.deepEqual(ids(m), ['a1', 'b1']);
  assert.equal(m.updated, 120);
});

test('the newer edit of the same card wins, whichever way round', () => {
  const a = doc({ cards: [card('k', { quantity: 3, updated: 200 })], updated: 200 });
  const b = doc({ cards: [card('k', { quantity: 5, updated: 300 })], updated: 300 });
  assert.equal(mergeDocs(a, b).cards[0].quantity, 5);
  assert.equal(mergeDocs(b, a).cards[0].quantity, 5);
  // an exact tie resolves the same way both ways
  const t1 = doc({ cards: [card('k', { quantity: 2, updated: 400 })] });
  const t2 = doc({ cards: [card('k', { quantity: 4, updated: 400 })] });
  assert.deepEqual(mergeDocs(t1, t2), mergeDocs(t2, t1));
});

test('a removal beats an older copy but not a newer edit', () => {
  const removed = doc({ cards: [], tomb: { k: 250 }, updated: 250 });
  assert.deepEqual(ids(mergeDocs(removed, doc({ cards: [card('k', { updated: 200 })] }))), []);
  assert.deepEqual(ids(mergeDocs(removed, doc({ cards: [card('k', { updated: 300 })], updated: 300 }))), ['k']);
});

test('merging is idempotent, commutative and keeps the newest name', () => {
  const a = doc({ name: 'Old name', updated: 100, cards: [card('a')] });
  const b = doc({ name: 'New name', updated: 500, cards: [card('b')] });
  const m = mergeDocs(a, b);
  assert.equal(m.name, 'New name');
  assert.deepEqual(mergeDocs(a, b), mergeDocs(b, a));
  assert.deepEqual(mergeDocs(m, m), m);
  assert.deepEqual(mergeDocs(m, a), m);
});

test('deleted collections', () => {
  const live = doc({ updated: 300, cards: [card('a', { updated: 300 })] });
  assert.deepEqual(mergeDocs(live, { id: 'c1', deleted: 400 }), { id: 'c1', deleted: 400 }); // deleted after the last edit
  assert.deepEqual(mergeDocs({ id: 'c1', deleted: 400 }, live), { id: 'c1', deleted: 400 });
  assert.deepEqual(mergeDocs(live, { id: 'c1', deleted: 200 }), live); // edited since: it lives on
  assert.deepEqual(mergeDocs({ id: 'c1', deleted: 100 }, { id: 'c1', deleted: 900 }), { id: 'c1', deleted: 900 });
});

test('the kind of a list (deck, tradelist, wishlist) survives cleaning and merging; a collection has none', () => {
  for (const kind of ['deck', 'tradelist', 'wishlist']) assert.equal(cleanDoc(doc({ kind })).kind, kind);
  for (const kind of ['collection', 'binder', 5, null, undefined]) {
    assert.equal('kind' in cleanDoc(doc({ kind })), false, `${String(kind)} is not written down`);
  }
  const a = cleanDoc(doc({ kind: 'deck', updated: 100, cards: [card('a')] }));
  const b = cleanDoc(doc({ updated: 200, cards: [card('b', { updated: 200 })] }));  // an older client that never sent a kind
  assert.equal(mergeDocs(a, b).kind, 'deck');
  assert.equal(mergeDocs(b, a).kind, 'deck', 'whichever way round');
  assert.equal('kind' in mergeDocs(b, cleanDoc(doc({ updated: 300 }))), false);
  assert.equal(mergeDocs(a, { id: 'c1', deleted: 50 }).kind, 'deck', 'a list that lives on after an older delete keeps its kind');
  assert.equal(JSON.stringify(mergeDocs(a, a)), JSON.stringify(a), 'merging a list with itself changes nothing');
});

test('limits per kind are enforced on what is sent (different cards, copies of one card)', () => {
  const cards = (n, over = {}) => Array.from({ length: n }, (_, i) => card(`c${i}`, over));
  assert.equal(limitMessage(cleanDoc(doc({ kind: 'deck', cards: cards(150, { quantity: 100 }) }))), null);
  assert.equal(limitMessage(cleanDoc(doc({ kind: 'deck', cards: cards(151) }))), '"Binder": a deck can hold at most 150 different cards');
  assert.equal(limitMessage(cleanDoc(doc({ kind: 'deck', cards: cards(1, { quantity: 101 }) }))), '"Binder": a deck can hold at most 100 copies of one card');
  assert.equal(limitMessage(cleanDoc(doc({ cards: cards(10000, { quantity: 1000 }) }))), null, 'a collection: 10,000 cards, 1,000 copies');
  assert.match(limitMessage(cleanDoc(doc({ cards: cards(10001) }))), /a collection can hold at most 10,000 different cards/);
  assert.match(limitMessage(cleanDoc(doc({ cards: cards(1, { quantity: 1001 }) }))), /a collection can hold at most 1,000 copies/);
  assert.equal(limitMessage(cleanDoc(doc({ kind: 'wishlist', cards: cards(3, { quantity: 99999 }) }))), null, 'no limit on copies in a wishlist');
  assert.equal(limitMessage(cleanDoc(doc({ kind: 'tradelist', cards: cards(10000, { quantity: 5000 }) }))), null);
  assert.match(limitMessage(cleanDoc(doc({ kind: 'tradelist', cards: cards(10001) }))), /a tradelist can hold at most 10,000/);
  assert.equal(limitMessage({ id: 'x', deleted: 5 }), null, 'a deleted list has no cards to count');
});

test('how many copies of a deck card the person has is kept: a whole number from 1, never over what is needed', () => {
  const owned = (over) => cleanDoc(doc({ kind: 'deck', cards: [card('a', { quantity: 4, ...over })] })).cards[0];
  assert.equal(owned({ owned: 3 }).owned, 3);
  assert.equal(owned({ owned: 99 }).owned, 4, 'never over what is needed');
  for (const bad of [0, -1, 1.5, '2', null, undefined]) assert.equal('owned' in owned({ owned: bad }), false, `${String(bad)} is not kept`);
  // it merges with the card like any other field (the newer edit wins)
  const a = cleanDoc(doc({ kind: 'deck', cards: [card('a', { quantity: 4, owned: 1, updated: 100 })] }));
  const b = cleanDoc(doc({ kind: 'deck', cards: [card('a', { quantity: 4, owned: 3, updated: 200 })] }));
  assert.equal(mergeDocs(a, b).cards[0].owned, 3);
  assert.equal(mergeDocs(b, a).cards[0].owned, 3);
});

test('a deck keeps its game and format, only as a matching pair, and only on a deck', () => {
  const deck = (over) => cleanDoc(doc({ kind: 'deck', ...over }));
  assert.deepEqual([deck({ game: 'mtg', format: 'modern' }).game, deck({ game: 'mtg', format: 'modern' }).format], ['mtg', 'modern']);
  assert.equal(deck({ game: 'pokemon', format: 'expanded' }).format, 'expanded');
  assert.equal(deck({ game: 'yugioh', format: 'speed' }).format, 'speed');
  for (const bad of [
    { game: 'pokemon', format: 'modern' }, { game: 'mtg', format: 'expanded' }, { game: 'digimon', format: 'modern' },
    { game: 'mtg' }, { format: 'modern' }, { game: 5, format: 'modern' }, { game: '__proto__', format: 'x' }, {},
  ]) {
    const clean = deck(bad);
    assert.equal('game' in clean || 'format' in clean, false, JSON.stringify(bad));
  }
  const notDeck = cleanDoc(doc({ kind: 'wishlist', game: 'mtg', format: 'modern' }));
  assert.equal('game' in notDeck || 'format' in notDeck, false, 'only a deck has them');
  assert.equal('game' in cleanDoc(doc({ game: 'mtg', format: 'modern' })), false);
});

test('merging decks: the newer game and format win; one that has none does not wipe the other', () => {
  const older = cleanDoc(doc({ kind: 'deck', game: 'mtg', format: 'modern', updated: 100, cards: [card('a')] }));
  const newer = cleanDoc(doc({ kind: 'deck', game: 'mtg', format: 'commander', updated: 200, cards: [card('b', { updated: 200 })] }));
  assert.equal(mergeDocs(older, newer).format, 'commander');
  assert.equal(mergeDocs(newer, older).format, 'commander', 'whichever way round');
  const bare = cleanDoc(doc({ kind: 'deck', updated: 300, cards: [card('c', { updated: 300 })] }));  // an older client that never sent one
  const kept = mergeDocs(newer, bare);
  assert.deepEqual([kept.game, kept.format], ['mtg', 'commander']);
  assert.deepEqual(mergeDocs(bare, newer), kept);
  assert.equal('game' in mergeDocs(bare, cleanDoc(doc({ kind: 'deck', updated: 400 }))), false);
  assert.equal(JSON.stringify(mergeDocs(newer, newer)), JSON.stringify(newer), 'merging with itself changes nothing');
});
