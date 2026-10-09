import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pokemonResult, scryfallResult, searchCardsWeb, yugiohResult } from '../js/cardSearch.js';
import { isWebHost } from '../js/env.js';

test('the website is told from the app by the address it is served from', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(isWebHost(host, ''), false);
  assert.equal(isWebHost('binder.trentcridland.workers.dev', ''), true);
  assert.equal(isWebHost('example.com', '?x=1'), true);
  assert.equal(isWebHost('127.0.0.1', '?web=1'), true, 'a preview of the website on localhost');
  assert.equal(isWebHost('127.0.0.1', '?other=1'), false);
  assert.equal(isWebHost('', ''), false);
});

test("results look like the local backend's", () => {
  assert.deepEqual(scryfallResult({ id: 'abc', name: 'Bolt', set: 'm11', rarity: 'common', image_uris: { small: 's.jpg', normal: 'n.jpg' } }),
    { id: 'mtg-abc', name: 'Bolt', set: 'M11', rarity: 'Common', image: 's.jpg', game: 'mtg' });
  assert.equal(scryfallResult({ id: 'x', name: 'Two-faced', set: 'isd', rarity: 'rare', card_faces: [{ image_uris: { normal: 'front.jpg' } }, {}] }).image, 'front.jpg');
  assert.deepEqual(pokemonResult({ id: 'base1-4', name: 'Charizard', set: { id: 'base1', ptcgoCode: 'BS' }, rarity: 'Rare Holo', images: { small: 'c.png' } }),
    { id: 'pkm-base1-4', name: 'Charizard', set: 'BS', rarity: 'Rare Holo', image: 'c.png', game: 'pokemon' });
  assert.deepEqual(yugiohResult({ id: 46986414, name: 'Dark Magician', card_sets: [{ set_code: 'LOB-EN005', set_rarity: 'Ultra Rare' }], card_images: [{ image_url_small: 'd.jpg' }] }),
    { id: 'ygo-46986414', name: 'Dark Magician', set: 'LOB', rarity: 'Ultra Rare', image: 'd.jpg', game: 'yugioh' });
  assert.equal(yugiohResult({ id: 1, name: 'No Sets' }).set, '');
});

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('each game is searched at its own site, a window at a time', async () => {
  const urls = [];
  const scry = (n, from) => Array.from({ length: n }, (_, i) => ({ id: `s${from + i}`, name: `Card ${from + i}`, set: 'tst', rarity: 'common', image_uris: {} }));
  const fetchFn = async (url) => {
    urls.push(String(url));
    const u = new URL(url);
    if (u.host === 'api.scryfall.com') {
      const page = Number(u.searchParams.get('page'));
      return reply({ data: scry(page === 1 ? 175 : 20, page === 1 ? 0 : 175) });
    }
    if (u.host === 'api.pokemontcg.io') return reply({ data: [{ id: 'base1-4', name: 'Charizard', set: { id: 'base1' }, images: {} }] });
    return reply({ data: [{ id: 1, name: 'Dark Magician' }] });
  };
  // Scryfall: 175 per page, so windows are cut out of pages (and one that straddles two pages reads both)
  const first = await searchCardsWeb('mtg', 'card', { limit: 40, offset: 0 }, fetchFn);
  assert.deepEqual([first.length, first[0].name, first[39].name], [40, 'Card 0', 'Card 39']);
  assert.match(urls[0], /cards\/search\?q=card&unique=prints&order=name&page=1$/);
  const straddle = await searchCardsWeb('mtg', 'card', { limit: 40, offset: 160 }, fetchFn);
  assert.deepEqual([straddle.length, straddle[0].name, straddle.at(-1).name], [35, 'Card 160', 'Card 194']);
  assert.equal(urls.length, 2, 'page 1 was remembered; only page 2 was fetched for the second window (which ends where the results do)');
  assert.equal((await searchCardsWeb('mtg', 'card', { limit: 40, offset: 400 }, fetchFn)).length, 0, 'past the end');

  urls.length = 0;
  await searchCardsWeb('pokemon', 'char zard', { limit: 40, offset: 80 }, fetchFn);
  assert.match(decodeURIComponent(urls[0]), /q=name:char\* name:zard\*&orderBy=name&pageSize=40&page=3/);
  await searchCardsWeb('yugioh', 'dark mag', { limit: 40, offset: 40 }, fetchFn);
  assert.match(urls[1], /cardinfo\.php\?fname=dark%20mag&num=40&offset=40/);
});

test('nothing to search for, nothing found, a site that is down', async () => {
  const never = async () => { throw new Error('should not be asked'); };
  assert.deepEqual(await searchCardsWeb('mtg', '   ', {}, never), []);
  assert.deepEqual(await searchCardsWeb('digimon', 'x', {}, never), []);
  assert.deepEqual(await searchCardsWeb('pokemon', '*:()', {}, never), [], 'a query with nothing searchable in it');
  assert.deepEqual(await searchCardsWeb('mtg', 'zzzz', {}, async () => reply({}, 404)), [], 'Scryfall answers 404 for no matches');
  assert.deepEqual(await searchCardsWeb('yugioh', 'zzzz', {}, async () => reply({}, 400)), [], 'YGOPRODeck answers 400 for no matches');
  await assert.rejects(searchCardsWeb('pokemon', 'x', {}, async () => reply({}, 503)), /503/);
});
