import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCardInfo, infoFromScryfall, infoKey } from '../js/cardInfo.js';

test('what a deck wants out of a Scryfall card', () => {
  assert.deepEqual(
    infoFromScryfall({ cmc: 1, colors: ['R'], type_line: 'Instant', legalities: { modern: 'legal', standard: 'not_legal', vintage: 'restricted', legacy: 'banned', weird: 'surprise' } }),
    { mv: 1, colors: 'R', land: false, legal: { modern: 'l', standard: 'n', vintage: 'r', legacy: 'b' } });
  assert.deepEqual(infoFromScryfall({ cmc: 0, colors: [], type_line: 'Basic Land — Island', legalities: {} }), { mv: 0, colors: '', land: true, legal: {} });
  assert.equal(infoFromScryfall({ cmc: 3, colors: ['W', 'U'], type_line: 'Instant' }).colors, 'WU');
  // a two-faced card: the colors and type of its front
  const mdfc = infoFromScryfall({ cmc: 2, type_line: 'Sorcery // Land', card_faces: [{ colors: ['G'], type_line: 'Sorcery' }, { colors: [], type_line: 'Land' }] });
  assert.deepEqual([mdfc.colors, mdfc.land], ['G', false]);
  assert.equal(infoFromScryfall({ cmc: 0, type_line: 'Land // Sorcery', card_faces: [{ type_line: 'Land' }, { type_line: 'Sorcery' }] }).land, true);
  assert.equal(infoFromScryfall({}).mv, 0);
  assert.equal(infoFromScryfall({ colors: ['X'], cmc: 2 }).colors, '', 'unknown colors are dropped');
});

test('a card is remembered by its catalog id, else game, name and set', () => {
  assert.equal(infoKey({ uid: 'mtg-abc', game: 'mtg', name: 'Bolt' }), 'mtg-abc');
  assert.equal(infoKey({ game: 'mtg', name: 'Lightning Bolt', set: 'M11' }), 'mtg|lightning bolt|M11');
});

const DB = [
  { id: '11111111-1111-1111-1111-111111111111', name: 'Lightning Bolt', set: 'm11', collector_number: '146', cmc: 1, colors: ['R'], type_line: 'Instant', legalities: { modern: 'legal' } },
  { id: '22222222-2222-2222-2222-222222222222', name: 'Island', set: 'm11', collector_number: '234', cmc: 0, colors: [], type_line: 'Basic Land — Island', legalities: {} },
  { id: '33333333-3333-3333-3333-333333333333', name: 'Sol Ring', set: 'cmr', collector_number: '472', cmc: 1, colors: [], type_line: 'Artifact', legalities: { commander: 'legal' } },
];

function make({ store = new Map(), clock = { now: 1_000_000 }, offline = false } = {}) {
  const requests = [];
  let changes = 0;
  const service = createCardInfo({
    storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    fetchFn: async (url, init) => {
      requests.push(JSON.parse(init.body).identifiers);
      if (offline) throw new Error('offline');
      const data = DB.filter((c) => JSON.parse(init.body).identifiers.some((q) => (q.id && q.id === c.id) || (!q.id && q.set === c.set && (q.collector_number ? q.collector_number === c.collector_number : q.name.toLowerCase() === c.name.toLowerCase())) || (!q.id && !q.set && q.name.toLowerCase() === c.name.toLowerCase())));
      return { ok: true, status: 200, json: async () => ({ data, not_found: [] }) };
    },
    nowMs: () => clock.now,
    onChange: () => { changes += 1; },
  });
  return { service, requests, store, clock, changes: () => changes };
}

const cards = [
  { game: 'mtg', name: 'Lightning Bolt', set: 'M11', uid: 'mtg-11111111-1111-1111-1111-111111111111' },
  { game: 'mtg', name: 'Island', set: 'M11', number: '234' },
  { game: 'mtg', name: 'Sol Ring', set: 'CMR' },
  { game: 'pokemon', name: 'Charizard', set: 'BS' },
  { game: 'mtg', name: 'Totally Made Up', set: 'ZZZ' },
];

test('Magic cards are looked up by id, else set and number, else name and set; other games are left out', async () => {
  const { service, requests, changes } = make();
  assert.equal(service.get(cards[0]), null, 'not known yet');
  assert.equal(service.needed(cards).length, 4, 'not the Pokémon card');
  assert.equal(await service.load(cards), true);
  assert.equal(changes(), 1);
  assert.equal(requests.length >= 1, true);
  assert.deepEqual([service.get(cards[0]).mv, service.get(cards[0]).colors, service.get(cards[0]).legal.modern], [1, 'R', 'l']);
  assert.equal(service.get(cards[1]).land, true);
  assert.equal(service.get(cards[2]).colors, '');
  assert.equal(service.get(cards[3]), null, 'other games have none');
  assert.equal(service.get(cards[4]), null, 'not found');
  assert.equal(service.needed(cards).length, 0, 'the one that was not found is not asked for again today');
  assert.equal(await service.load(cards), false);
});

test('answers are kept on the device for two weeks; "not found" for a day', async () => {
  const first = make();
  await first.service.load(cards);
  const second = make({ store: first.store, clock: first.clock });
  assert.equal(second.service.get(cards[0]).mv, 1, 'known straight away on the next visit');
  assert.equal(second.service.needed(cards).length, 0);
  assert.equal(await second.service.load(cards), false);
  assert.equal(second.requests.length, 0);

  first.clock.now += 25 * 3600 * 1000;  // a day and an hour: the made-up card is asked about again
  assert.deepEqual(second.service.needed(cards).map(([, c]) => c.name), ['Totally Made Up']);
  first.clock.now += 14 * 24 * 3600 * 1000;  // two weeks on: everything is asked again
  assert.equal(second.service.needed(cards).length, 4);
});

test('offline learns nothing and marks nothing as not found; damaged storage starts over', async () => {
  const off = make({ offline: true });
  assert.equal(await off.service.load(cards), false);
  assert.equal(off.service.needed(cards).length, 4, 'still to be asked');
  assert.equal(off.changes(), 0);
  const broken = make({ store: new Map([['binder_cardinfo_v1', 'not json{']]) });
  assert.equal(broken.service.needed(cards).length, 4);
  assert.equal(await broken.service.load([]), false, 'nothing to ask');
});
