import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GAMES, createCrossSearch } from '../js/catalogSearch.js';

/** A one-game search over a fixed list, like api.searchCards. */
function fakeSearch(catalog, calls = []) {
  return async (game, query, { limit, offset }) => {
    calls.push({ game, query, limit, offset });
    const all = catalog[game];
    if (all instanceof Error) throw all;
    return all.slice(offset, offset + limit).map((name) => ({ id: `${game}-${name}`, name }));
  };
}

test('searches every game and weaves the answers together, so no game crowds out the others', async () => {
  const calls = [];
  const search = createCrossSearch(fakeSearch({ mtg: ['m1', 'm2', 'm3'], pokemon: ['p1', 'p2'], yugioh: ['y1'] }, calls), 'bolt', { perGame: 3 });
  assert.deepEqual(GAMES, ['mtg', 'pokemon', 'yugioh']);
  const first = await search.more();
  assert.deepEqual(first.map((c) => c.id), ['mtg-m1', 'pokemon-p1', 'yugioh-y1', 'mtg-m2', 'pokemon-p2', 'mtg-m3']);
  assert.deepEqual(first.map((c) => c.game), ['mtg', 'pokemon', 'yugioh', 'mtg', 'pokemon', 'mtg'], 'each card says which game it is from');
  assert.deepEqual(calls.map((c) => c.game).sort(), ['mtg', 'pokemon', 'yugioh'], 'all games were asked');
  assert.ok(calls.every((c) => c.query === 'bolt' && c.limit === 3 && c.offset === 0));
  assert.equal(search.done, false, 'Magic filled its page, so it may have more');
  assert.deepEqual(await search.more(), [], 'the next page finds nothing more');
  assert.equal(search.done, true);
  assert.deepEqual(await search.more(), [], 'nothing is asked once everything is done');
  assert.equal(calls.length, 4, 'only Magic was asked for a second page');
  assert.equal(calls[3].game, 'mtg');
  assert.equal(calls[3].offset, 3);
});

test('paging continues per game until each has run out', async () => {
  const names = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
  const search = createCrossSearch(fakeSearch({ mtg: names('m', 5), pokemon: names('p', 2), yugioh: [] }), 'x', { perGame: 2 });
  const seen = [];
  for (let i = 0; i < 6 && !search.done; i++) seen.push(...(await search.more()).map((c) => c.id));
  assert.equal(search.done, true);
  assert.deepEqual(seen.sort(), ['mtg-m1', 'mtg-m2', 'mtg-m3', 'mtg-m4', 'mtg-m5', 'pokemon-p1', 'pokemon-p2']);
});

test('a game that fails is skipped, and only every game failing is an error', async () => {
  const partly = createCrossSearch(fakeSearch({ mtg: new Error('Scryfall is down'), pokemon: ['p1'], yugioh: ['y1'] }), 'x', { perGame: 5 });
  assert.deepEqual((await partly.more()).map((c) => c.id), ['pokemon-p1', 'yugioh-y1']);
  assert.equal(partly.done, true);
  const down = new Error('offline');
  const all = createCrossSearch(fakeSearch({ mtg: down, pokemon: down, yugioh: down }), 'x');
  await assert.rejects(all.more(), /offline/);
});
