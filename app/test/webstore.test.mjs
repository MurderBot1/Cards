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

test('kinds of list: collection by default, deck, tradelist or wishlist, kept through sync', () => {
  const { store } = make();
  const create = (body) => store.handle('POST', '/collections', body);
  assert.equal(create({ name: 'Plain' }).body.kind, undefined, 'a collection is not written down');
  assert.equal(create({ name: 'Plain 2', kind: 'collection' }).body.kind, undefined);
  assert.equal(create({ name: 'Plain 3', kind: null }).status, 201);
  assert.equal(create({ name: 'Deck', kind: 'deck' }).body.kind, 'deck');
  assert.equal(create({ name: 'Trades', kind: 'tradelist' }).body.kind, 'tradelist');
  assert.equal(create({ name: 'Wants', kind: 'wishlist' }).body.kind, 'wishlist');
  const bad = create({ name: 'Nope', kind: 'binder' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "kind must be one of ('collection', 'deck', 'tradelist', 'wishlist')");
  assert.equal(store.handle('GET', '/collections').body.length, 6, 'the refused one was not made');

  const state = store.syncState().body.collections;
  assert.deepEqual(state.map((c) => c.kind), [undefined, undefined, undefined, 'deck', 'tradelist', 'wishlist']);
  const deck = state.find((c) => c.kind === 'deck');
  const remote = { id: 'far', name: 'From elsewhere', kind: 'wishlist', updated: 900000, cards: [] };
  const applied = store.handle('POST', '/sync/apply', { collections: [{ ...deck, name: 'Deck v2', updated: 800000 }, remote], expect: { [deck.id]: deck.updated } }).body;
  assert.deepEqual(applied.applied, [deck.id, 'far']);
  assert.equal(store.handle('GET', `/collections/${deck.id}`).body.kind, 'deck');
  assert.equal(store.handle('GET', '/collections/far').body.kind, 'wishlist');
});

test('limits: lists per kind, different cards, copies of one card (same rules and messages as the native store)', () => {
  const { store } = make();
  const create = (kind) => store.handle('POST', '/collections', { name: 'L', kind });
  const ids = {};
  for (let i = 0; i < 25; i++) { const r = create('collection'); assert.equal(r.status, 201); ids.collection ??= r.body.id; }
  assert.deepEqual([create('collection').status, create('collection').body.error], [400, 'You can have at most 25 collections']);
  for (let i = 0; i < 100; i++) { const r = create('deck'); assert.equal(r.status, 201); ids.deck ??= r.body.id; }
  assert.equal(create('deck').body.error, 'You can have at most 100 decks', 'decks are counted apart from collections');
  const w = create('wishlist'); const t = create('tradelist');
  assert.deepEqual([w.status, t.status], [201, 201]);
  ids.wishlist = w.body.id; ids.tradelist = t.body.id;
  assert.deepEqual([create('wishlist').status, create('wishlist').body.error], [400, 'You can only have one wishlist']);
  assert.equal(create('tradelist').body.error, 'You can only have one tradelist');
  assert.equal(store.handle('GET', '/collections').body.length, 25 + 100 + 2);
  store.handle('DELETE', `/collections/${ids.wishlist}`);
  ids.wishlist = create('wishlist').body.id;  // deleting it frees the place
  assert.ok(ids.wishlist);
  store.handle('DELETE', `/collections/${ids.deck}`);
  assert.equal(create('deck').status, 201, 'deleting one frees a place');

  const add = (id, name, quantity) => store.handle('POST', `/collections/${id}/cards`, { name, game: 'mtg', set: 'M10', ...(quantity ? { quantity } : {}) });
  assert.equal(add(ids.collection, 'Bolt', 1000).status, 201);
  assert.equal(add(ids.collection, 'Bolt').body.error, 'A collection can hold at most 1,000 copies of one card');
  assert.equal(add(ids.collection, 'Sol Ring', 1001).status, 400);
  const row = store.handle('GET', `/collections/${ids.collection}`).body.cards[0];
  assert.equal(store.handle('PATCH', `/collections/${ids.collection}/cards/${row.id}`, { quantity: 1001 }).status, 400);
  assert.equal(store.handle('PATCH', `/collections/${ids.collection}/cards/${row.id}`, { quantity: 999 }).status, 200);
  assert.equal(store.handle('GET', `/collections/${ids.collection}`).body.cards.length, 1, 'refused ones leave no trace');

  const deck = create('deck');
  assert.equal(deck.status, 400, 'still 100 decks');
  store.handle('DELETE', `/collections/${store.handle('GET', '/collections').body.find((c) => c.kind === 'deck').id}`);
  const deckId = create('deck').body.id;
  for (let i = 0; i < 150; i++) assert.equal(add(deckId, `Card ${i}`).status, 201);
  assert.equal(add(deckId, 'One More').body.error, 'A deck can hold at most 150 different cards');
  assert.equal(add(deckId, 'Card 7', 99).status, 201, 'copies of a card already there are fine up to 100');
  assert.equal(add(deckId, 'Card 7').body.error, 'A deck can hold at most 100 copies of one card');

  const bulk = store.handle('POST', `/collections/${deckId}/cards/bulk`, { cards: [{ name: 'Card 1', game: 'mtg', set: 'M10' }, { name: 'Brand New', game: 'mtg', set: 'M10' }] });
  assert.equal(bulk.status, 400);
  assert.match(bulk.body.error, /^card 2: A deck can hold at most 150/);
  assert.equal(store.handle('GET', `/collections/${deckId}`).body.cards[1].quantity, 1, 'all or nothing');

  assert.equal(add(ids.wishlist, 'Bulk', 50000).status, 201);
  assert.equal(add(ids.wishlist, 'Bulk', 50000).status, 201, 'a wishlist has no limit on copies');
  const many = Array.from({ length: 10000 }, (_, i) => ({ name: `W${i}`, game: 'mtg', set: 'M10' }));
  assert.equal(store.handle('POST', `/collections/${ids.tradelist}/cards/bulk`, { cards: many }).status, 201);
  assert.equal(add(ids.tradelist, 'The 10001st').body.error, 'A tradelist can hold at most 10,000 different cards');
});

test('decks keep how many copies of each card the person has', () => {
  const { store } = make();
  const deck = store.handle('POST', '/collections', { name: 'Burn', kind: 'deck' }).body.id;
  const binder = store.handle('POST', '/collections', { name: 'Binder' }).body.id;
  const add = (id, name, quantity, extra = {}) => store.handle('POST', `/collections/${id}/cards`, { name, game: 'mtg', set: 'M10', quantity, ...extra });
  const bolt = add(deck, 'Bolt', 4).body.cards[0].id;
  const ring = add(deck, 'Sol Ring', 1).body.cards[1].id;
  const row = (list, id) => store.handle('GET', `/collections/${list}`).body.cards.find((c) => c.id === id);
  const patch = (list, id, body) => store.handle('PATCH', `/collections/${list}/cards/${id}`, body);
  assert.equal('owned' in row(deck, bolt), false, 'nothing had until said');

  assert.equal(patch(deck, bolt, { owned: 3 }).status, 200);
  assert.equal(row(deck, bolt).owned, 3);
  patch(deck, bolt, { owned: 99 });
  assert.equal(row(deck, bolt).owned, 4, 'never more than needed');
  patch(deck, bolt, { quantity: 2 });
  assert.equal(row(deck, bolt).owned, 2, 'lowering what is needed lowers what is had');
  patch(deck, bolt, { owned: 0 });
  assert.equal('owned' in row(deck, bolt), false, 'zero is not written down');
  for (const bad of [-1, 1.5, 'two']) {
    assert.equal(patch(deck, bolt, { owned: bad }).body.error, 'owned must be a whole number of at least 0');
  }
  const inBinder = add(binder, 'Bolt', 2).body.cards[0].id;
  assert.equal(patch(binder, inBinder, { owned: 1 }).body.error, 'only a deck keeps track of the cards you have');

  const post = (list, body) => store.handle('POST', `/collections/${list}/owned`, body);
  const many = post(deck, { owned: { [bolt]: 9, [ring]: 1, nope: 5 } });
  assert.equal(many.status, 200);
  assert.deepEqual([row(deck, bolt).owned, row(deck, ring).owned], [2, 1]);
  const stamp = store.handle('GET', `/collections/${deck}`).body.updated;
  post(deck, { owned: { [bolt]: 2 } });
  assert.equal(store.handle('GET', `/collections/${deck}`).body.updated, stamp, 'no change, no new stamp');
  post(deck, { owned: { [bolt]: 0, [ring]: 0 } });
  assert.equal('owned' in row(deck, ring), false);
  assert.equal(post(deck, {}).status, 400);
  assert.equal(post(deck, { owned: [] }).status, 400);
  assert.equal(post(deck, { owned: { [bolt]: -2 } }).status, 400);
  assert.equal(post(binder, { owned: { [inBinder]: 1 } }).status, 400);
  assert.equal(post('zzz', { owned: {} }).status, 404);

  const bulk = store.handle('POST', `/collections/${deck}/cards/bulk`, { cards: [
    { name: 'Shock', game: 'mtg', set: 'M10', quantity: 3, owned: 2 },
    { name: 'Shock', game: 'mtg', set: 'M10', quantity: 3, owned: 9 },
  ] }).body;
  const shock = bulk.cards.at(-1);
  assert.deepEqual([shock.quantity, shock.owned], [6, 6], 'stacking adds up, never over what is needed');
  const intoBinder = store.handle('POST', `/collections/${binder}/cards/bulk`, { cards: [{ name: 'Shock', game: 'mtg', set: 'M10', owned: 2 }] }).body;
  assert.equal('owned' in intoBinder.cards.at(-1), false, 'left out of anything but a deck');

  const synced = store.syncState().body.collections.find((c) => c.id === deck);
  assert.equal(synced.cards.find((c) => c.name === 'Shock').owned, 6, 'travels with the card in sync');
});

test('moving copies of a card to another list (same rules and messages as the native store)', () => {
  const { store } = make();
  const create = (name, kind) => store.handle('POST', '/collections', { name, kind }).body.id;
  const a = create('A');
  const b = create('B');
  const deck = create('Deck', 'deck');
  const list = (id) => store.handle('GET', `/collections/${id}`).body;
  const bolt = store.handle('POST', `/collections/${a}/cards`, { name: 'Bolt', game: 'mtg', set: 'M11', rarity: 'Common', image: 'http://x/b.jpg', id: 'mtg-bolt', condition: 'Lightly Played', foil: true, language: 'Japanese', number: '146', quantity: 5 }).body.cards[0].id;
  const move = (from, id, body) => store.handle('POST', `/collections/${from}/cards/${id}/move`, body);

  const some = move(a, bolt, { to: b, quantity: 2 });
  assert.equal(some.status, 200);
  assert.deepEqual([some.body.source.cards[0].quantity, some.body.target.cards[0].quantity], [3, 2]);
  const moved = some.body.target.cards[0];
  assert.deepEqual({ ...moved, id: '', updated: 0 }, { id: '', name: 'Bolt', game: 'mtg', set: 'M11', rarity: 'Common', image: 'http://x/b.jpg', condition: 'Lightly Played', quantity: 2, updated: 0, uid: 'mtg-bolt', foil: true, language: 'Japanese', number: '146' }, 'arrives with everything the card has');
  assert.notEqual(moved.id, bolt, 'a row of its own');
  assert.equal(move(a, bolt, { to: b, quantity: 1 }).status, 200);
  assert.deepEqual([list(b).cards.length, list(b).cards[0].quantity], [1, 3], 'stacks onto the same card');

  const rest = move(a, bolt, { to: b });
  assert.equal(rest.body.source.cards.length, 0, 'all by default: the row goes');
  assert.ok(bolt in rest.body.source.tomb, 'with a tombstone for sync');
  assert.equal(list(b).cards[0].quantity, 5);

  const inB = list(b).cards[0].id;
  assert.equal(move(b, inB, {}).body.error, 'to must be the id of another list');
  assert.equal(move(b, inB, { to: 7 }).status, 400);
  assert.equal(move(b, inB, { to: b }).body.error, 'choose a different list to move it to');
  assert.equal(move(b, inB, { to: 'nope' }).status, 404);
  assert.equal(move('nope', inB, { to: a }).status, 404);
  assert.equal(move(b, 'nope', { to: a }).status, 404);
  for (const bad of [0, 6, -1, 1.5, '2']) assert.equal(move(b, inB, { to: a, quantity: bad }).body.error, 'quantity must be a whole number from 1 to 5');
  assert.equal(list(b).cards[0].quantity, 5, 'refusals change nothing');
  assert.equal(list(a).cards.length, 0);

  const big = store.handle('POST', `/collections/${a}/cards`, { name: 'Big', game: 'mtg', set: 'M10', quantity: 101 }).body.cards[0].id;
  const over = move(a, big, { to: deck });
  assert.equal(over.body.error, 'A deck can hold at most 100 copies of one card', "the other list's limits hold");
  assert.deepEqual([list(a).cards[0].quantity, list(deck).cards.length], [101, 0], 'and then nothing leaves the source');
  assert.equal(move(a, big, { to: deck, quantity: 100 }).status, 200);
  assert.deepEqual([list(a).cards[0].quantity, list(deck).cards[0].quantity], [1, 100]);
  assert.equal('owned' in list(deck).cards[0], false);

  store.handle('PATCH', `/collections/${deck}/cards/${list(deck).cards[0].id}`, { owned: 90 });
  assert.equal(move(deck, list(deck).cards[0].id, { to: b, quantity: 30 }).status, 200);
  assert.deepEqual([list(deck).cards[0].quantity, list(deck).cards[0].owned], [70, 70], 'what is had is kept to what is still needed');
});
