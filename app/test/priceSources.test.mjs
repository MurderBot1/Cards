import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lookUpPrices, pokemonPrice, scryfallPrice, yugiohPasscode, yugiohPrice } from '../js/priceSources.js';

test('parsing the three sources', () => {
  assert.deepEqual(scryfallPrice({ prices: { usd: '1.50', usd_foil: '4.00' } }), { usd: 1.5, usd_foil: 4 });
  assert.deepEqual(scryfallPrice({ prices: { usd: null, usd_etched: '9.999' } }), { usd: 10, usd_foil: 10 }, 'foil-only card: the foil price is the price');
  assert.deepEqual(scryfallPrice({}), { usd: null, usd_foil: null });
  assert.deepEqual(pokemonPrice({ tcgplayer: { prices: { normal: { market: 0.5 }, holofoil: { mid: 3 } } } }), { usd: 0.5, usd_foil: 3 });
  assert.deepEqual(pokemonPrice({ tcgplayer: { prices: { holofoil: { market: 3 } } } }), { usd: 3, usd_foil: 3 });
  assert.deepEqual(pokemonPrice({}), { usd: null, usd_foil: null });
  assert.deepEqual(yugiohPrice({ card_prices: [{ tcgplayer_price: '0.25' }] }), { usd: 0.25, usd_foil: null });
  assert.deepEqual(yugiohPrice({ card_prices: [{ tcgplayer_price: '0.00' }] }), { usd: null, usd_foil: null });
  assert.equal(yugiohPasscode('ygo-46986414-LOB-EN001'), '46986414');
  assert.equal(yugiohPasscode('ygo-abc'), null);
  assert.equal(yugiohPasscode('mtg-1'), null);
});

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('looking prices up straight from the sites', async () => {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.startsWith('https://api.scryfall.com/cards/collection')) {
      const { identifiers } = JSON.parse(init.body);
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Accept, 'application/json');
      assert.deepEqual(identifiers, [{ id: 'abc' }, { name: 'Shock', set: 'm19' }]);
      return reply({ data: [{ id: 'abc', name: 'Bolt', set: 'lea', prices: { usd: '2.00', usd_foil: null } }, { id: 'zzz', name: 'Shock', set: 'm19', prices: { usd: '0.10' } }] });
    }
    if (url.startsWith('https://api.pokemontcg.io/')) {
      assert.match(decodeURIComponent(url), /q=id:"base1-4"/);
      return reply({ data: [{ id: 'base1-4', tcgplayer: { prices: { holofoil: { market: 300 } } } }] });
    }
    if (url.startsWith('https://db.ygoprodeck.com/')) {
      assert.match(url, /id=46986414$/);
      return reply({ data: [{ id: 46986414, card_prices: [{ tcgplayer_price: '1.10' }] }] });
    }
    throw new Error(`unexpected ${url}`);
  };
  const { prices, failed } = await lookUpPrices([
    { key: 'a', game: 'mtg', name: 'Bolt', set: 'LEA', uid: 'mtg-abc' },
    { key: 'b', game: 'mtg', name: 'Shock', set: 'M19', uid: '' },
    { key: 'c', game: 'pokemon', name: 'Charizard', set: '', uid: 'pkm-base1-4' },
    { key: 'd', game: 'pokemon', name: 'Old', set: '', uid: '' },
    { key: 'e', game: 'yugioh', name: 'Dark Magician', set: '', uid: 'ygo-46986414-LOB-EN005' },
  ], fetchFn);
  assert.deepEqual(failed, []);
  assert.deepEqual(prices.get('a'), { usd: 2, usd_foil: null });
  assert.deepEqual(prices.get('b'), { usd: 0.1, usd_foil: null });
  assert.deepEqual(prices.get('c'), { usd: 300, usd_foil: 300 });
  assert.deepEqual(prices.get('d'), { usd: null, usd_foil: null }, 'no catalog id: no look-up');
  assert.deepEqual(prices.get('e'), { usd: 1.1, usd_foil: null });
  assert.equal(calls.length, 3, 'one request per game');
});

test('a site that cannot be reached is reported, the others still answer', async () => {
  const fetchFn = async (url) => {
    if (url.includes('scryfall')) throw new TypeError('Failed to fetch'); // what a CORS block or being offline looks like
    if (url.includes('ygoprodeck')) return reply({ error: 'none' }, 400);
    throw new Error('unexpected');
  };
  const cards = [
    { key: 'a', game: 'mtg', name: 'Bolt', set: '', uid: 'mtg-abc' },
    { key: 'e', game: 'yugioh', name: 'X', set: '', uid: 'ygo-1' },
  ];
  const { prices, failed } = await lookUpPrices(cards, fetchFn);
  assert.deepEqual(failed.map((c) => c.key), ['a']);
  assert.deepEqual(prices.get('e'), { usd: null, usd_foil: null }, 'a 400 from YGOPRODeck means unknown ids, not an outage');
  assert.equal(prices.has('a'), false);
  assert.deepEqual((await lookUpPrices([{ key: 'q', game: 'other', name: 'x' }], fetchFn)).failed, []);
});
