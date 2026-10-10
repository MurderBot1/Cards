import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanDoc, mergeDocs } from '../src/sync.js';

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
