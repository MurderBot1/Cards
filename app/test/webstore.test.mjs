import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebStore } from '../js/webstore.js';

function make() {
  const data = new Map();
  let n = 0;
  let clock = 100000;
  const store = new WebStore({
    storage: { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, v) },
    makeId: () => `id${++n}`,
    nowMs: () => (clock += 10),
  });
  return { store, data };
}
const card = (over = {}) => ({ name: 'Lightning Bolt', game: 'mtg', set: 'M11', rarity: 'Common', image: '', ...over });

test('collections: create, list, get, delete (with the deletion remembered)', () => {
  const { store } = make();
  assert.deepEqual(store.handle('GET', '/collections').body, []);
  assert.equal(store.handle('POST', '/collections', { name: '   ' }).status, 400);
  assert.equal(store.handle('POST', '/collections', {}).body.error, 'name is required');
  const created = store.handle('POST', '/collections', { name: '  Binder ' });
  assert.equal(created.status, 201);
  assert.equal(created.body.id, 'id1');
  assert.equal(created.body.name, 'Binder');
  assert.deepEqual(created.body.cards, []);
  assert.equal(typeof created.body.updated, 'number');
  assert.equal(store.handle('GET', '/collections/id1').body.name, 'Binder');
  assert.equal(store.handle('GET', '/collections/nope').status, 404);
  assert.equal(store.handle('DELETE', '/collections/nope').status, 404);
  assert.deepEqual(store.handle('DELETE', '/collections/id1').body, { deleted: true });
  assert.deepEqual(store.handle('GET', '/collections').body, []);
  const deleted = store.syncState().body.deleted;
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].id, 'id1');
});

test('adding cards: validation, stacking and the catalog id', () => {
  const { store } = make();
  store.handle('POST', '/collections', { name: 'C' });
  const add = (body) => store.handle('POST', '/collections/id1/cards', body);
  assert.equal(add({ game: 'mtg' }).body.error, 'card name is required');
  assert.match(add({ name: 'x', game: 'digimon' }).body.error, /^game must be one of/);
  assert.match(add({ name: 'x', game: 'mtg', condition: 'Mint' }).body.error, /^condition must be one of/);
  assert.equal(store.handle('POST', '/collections/zzz/cards', card()).status, 404);

  const first = add(card({ id: 'mtg-abc' }));
  assert.equal(first.status, 201);
  assert.equal(first.body.cards.length, 1);
  assert.deepEqual({ ...first.body.cards[0], updated: 0 }, { id: 'id2', name: 'Lightning Bolt', game: 'mtg', set: 'M11', rarity: 'Common', image: '', condition: 'Near Mint', quantity: 1, updated: 0, uid: 'mtg-abc' });
  assert.equal(add(card()).body.cards[0].quantity, 2, 'same name, set, game and condition stack');
  assert.equal(add(card({ condition: 'Heavily Played' })).body.cards.length, 2, 'another condition is its own row');
  assert.equal(add(card({ set: 'M10' })).body.cards.length, 3, 'another set is its own row');
  assert.equal(add({ name: 'No Set', game: 'mtg' }).body.cards.at(-1).set, '');
  assert.equal(add({ name: 'No Set', game: 'mtg' }).body.cards.length, 5, 'a request with no set never stacks');
  assert.equal(add(card({ uid: 'mtg-explicit', id: 'ignored', set: 'ZZZ' })).body.cards.at(-1).uid, 'mtg-explicit');
});

test('changing and removing cards', () => {
  const { store } = make();
  store.handle('POST', '/collections', { name: 'C' });
  store.handle('POST', '/collections/id1/cards', card());
  const patch = (body) => store.handle('PATCH', '/collections/id1/cards/id2', body);
  assert.equal(patch({}).body.error, 'quantity and/or condition is required');
  assert.equal(patch({ quantity: 'lots' }).body.error, 'quantity must be a number');
  assert.equal(patch({ uid: 5 }).body.error, 'uid must be a string');
  assert.match(patch({ condition: 'Mint' }).body.error, /^condition must be one of/);
  assert.equal(store.handle('PATCH', '/collections/zzz/cards/id2', { quantity: 2 }).status, 404);

  const changed = patch({ quantity: 4, condition: 'Damaged', uid: 'mtg-x' }).body.cards[0];
  assert.deepEqual([changed.quantity, changed.condition, changed.uid], [4, 'Damaged', 'mtg-x']);
  const removed = patch({ quantity: 0 }).body;
  assert.deepEqual(removed.cards, []);
  assert.deepEqual(Object.keys(removed.tomb), ['id2'], 'the removal is remembered for sync');
});

test('settings merge into the defaults', () => {
  const { store } = make();
  assert.equal(store.handle('GET', '/settings').body.theme, 'dark');
  assert.equal(store.handle('PUT', '/settings', [1]).status, 400);
  const saved = store.handle('PUT', '/settings', { theme: 'light', minImageQuality: 'high' }).body;
  assert.deepEqual([saved.theme, saved.fontSize, saved.minImageQuality], ['light', 'medium', 'high']);
  assert.equal(store.handle('GET', '/settings').body.theme, 'light');
});

test('sync state and apply follow the native backend', () => {
  const { store } = make();
  store.handle('POST', '/collections', { name: 'Mine' });
  store.handle('POST', '/collections/id1/cards', card());
  const state = store.syncState().body;
  assert.equal(state.collections.length, 1);
  assert.equal(state.collections[0].updated, state.collections[0].cards[0].updated, 'a collection is never older than its newest card');

  assert.equal(store.handle('POST', '/sync/apply', []).status, 400);
  assert.equal(store.handle('POST', '/sync/apply', { collections: 5 }).status, 400);

  // a merged result from the account replaces the collection, if nothing changed locally since the sync began
  const merged = { id: 'id1', name: 'Merged', updated: 5000, cards: [{ id: 'k', name: 'Sol Ring', game: 'mtg', set: 'CMR', condition: 'Near Mint', quantity: 1, updated: 5000 }], tomb: { gone: 4000 } };
  const expect = { id1: state.collections[0].updated };
  assert.deepEqual(store.handle('POST', '/sync/apply', { collections: [merged], expect }).body, { applied: ['id1'], skipped: [] });
  assert.equal(store.handle('GET', '/collections/id1').body.name, 'Merged');
  // ...and is left alone when it changed in the meantime
  store.handle('POST', '/collections/id1/cards', card());
  const skipped = store.handle('POST', '/sync/apply', { collections: [{ ...merged, name: 'Stale' }], expect: { id1: 5000 } }).body;
  assert.deepEqual(skipped, { applied: [], skipped: ['id1'] });
  assert.equal(store.handle('GET', '/collections/id1').body.name, 'Merged');
  // a collection that arrives from another device is added; one deleted elsewhere is removed and remembered
  const fromElsewhere = { id: 'remote', name: 'Elsewhere', updated: 7000, cards: [] };
  assert.deepEqual(store.handle('POST', '/sync/apply', { collections: [fromElsewhere], expect: {} }).body.applied, ['remote']);
  const current = store.syncState().body.collections.find((c) => c.id === 'remote').updated;
  assert.deepEqual(store.handle('POST', '/sync/apply', { collections: [{ id: 'remote', deleted: 8000 }], expect: { remote: current } }).body.applied, ['remote']);
  assert.equal(store.handle('GET', '/collections/remote').status, 404);
  assert.deepEqual(store.syncState().body.deleted, [{ id: 'remote', at: 8000 }]);
});

test('unknown routes, bad storage and a fresh browser', () => {
  const { store, data } = make();
  assert.equal(store.handle('GET', '/nothing').status, 404);
  assert.equal(store.handle('PATCH', '/collections').status, 404);
  data.set('binder_web_db_v1', 'not json{');
  assert.deepEqual(store.handle('GET', '/collections').body, [], 'damaged storage starts over empty');
  data.set('binder_web_db_v1', JSON.stringify({ collections: 'x', settings: null }));
  assert.deepEqual(store.handle('GET', '/collections').body, []);
  assert.equal(store.handle('GET', '/settings').body.theme, 'dark');
});
