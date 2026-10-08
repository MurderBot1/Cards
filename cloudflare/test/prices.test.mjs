import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onPrices, pokemonPrice, scryfallPrice, yugiohPrice } from '../src/prices.js';

test('parsing the sources', () => {
  assert.deepEqual(scryfallPrice({ prices: { usd: '1.50', usd_foil: '4.00' } }), { usd: 1.5, usd_foil: 4 });
  assert.deepEqual(scryfallPrice({ prices: { usd: null, usd_foil: '3.25' } }), { usd: 3.25, usd_foil: 3.25 }); // foil-only card
  assert.deepEqual(scryfallPrice({ prices: { usd_etched: '9.99' } }), { usd: 9.99, usd_foil: 9.99 });
  assert.deepEqual(scryfallPrice({ prices: {} }), { usd: null, usd_foil: null });
  assert.deepEqual(pokemonPrice({ tcgplayer: { prices: { normal: { market: 0.5 }, holofoil: { market: 12.34 } } } }), { usd: 0.5, usd_foil: 12.34 });
  assert.deepEqual(pokemonPrice({ tcgplayer: { prices: { holofoil: { market: 20 } } } }), { usd: 20, usd_foil: 20 });
  assert.deepEqual(pokemonPrice({}), { usd: null, usd_foil: null });
  assert.deepEqual(yugiohPrice({ card_prices: [{ tcgplayer_price: '0.35' }] }), { usd: 0.35, usd_foil: null });
  assert.deepEqual(yugiohPrice({ card_prices: [{ tcgplayer_price: '0.00' }] }), { usd: null, usd_foil: null });
});

// A tiny in-memory stand-in for the D1 calls onPrices makes.
function fakeDb() {
  const prices = new Map();
  const hits = new Map();
  const statement = (sql) => ({
    bind(...args) {
      return {
        async all() {
          if (sql.startsWith('SELECT key')) {
            return { results: args.map((k) => prices.get(k)).filter(Boolean) };
          }
          throw new Error('unexpected: ' + sql);
        },
        async first() {
          if (sql.startsWith('INSERT INTO api_hits')) {
            const k = args.join('|');
            hits.set(k, (hits.get(k) || 0) + 1);
            return { n: hits.get(k) };
          }
          throw new Error('unexpected: ' + sql);
        },
        async run() {
          if (sql.startsWith('INSERT OR REPLACE INTO prices')) {
            for (let i = 0; i < args.length; i += 4) prices.set(args[i], { key: args[i], usd: args[i + 1], usd_foil: args[i + 2], updated_at: args[i + 3] });
          }
          return {};
        },
      };
    },
  });
  return { prepare: statement, prices };
}

const post = (cards) => new Request('https://x/api/prices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cards }) });

test('looks cards up at the right sources, caches them, then answers from the cache', async () => {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body });
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.includes('scryfall')) {
      return ok({ data: [{ id: 'abc', name: 'Lightning Bolt', set: 'm10', prices: { usd: '2.00', usd_foil: '5.00' } }, { id: 'def', name: 'Sol Ring', set: 'cmr', prices: { usd: '1.25' } }] });
    }
    if (u.includes('pokemontcg')) return ok({ data: [{ id: 'base1-4', tcgplayer: { prices: { holofoil: { market: 300 } } } }] });
    if (u.includes('ygoprodeck')) return ok({ data: [{ id: 46986414, card_prices: [{ tcgplayer_price: '2.10' }] }] });
    throw new Error('unexpected ' + u);
  };
  const env = { DB: fakeDb() };
  const cards = [
    { key: 'mtg-abc', game: 'mtg', name: 'Lightning Bolt', set: 'M10', uid: 'mtg-abc' },
    { key: 'sol', game: 'mtg', name: 'Sol Ring', set: 'CMR' }, // an older card with no uid: priced by name and set
    { key: 'pkm-base1-4', game: 'pokemon', name: 'Charizard', set: 'BS', uid: 'pkm-base1-4' },
    { key: 'pkm-gone', game: 'pokemon', name: 'Mystery', set: 'XX', uid: 'pkm-gone' },
    { key: 'ygo-46986414-LOB-EN005', game: 'yugioh', name: 'Dark Magician', set: 'LOB', uid: 'ygo-46986414-LOB-EN005' },
    { key: 'old-ygo', game: 'yugioh', name: 'Old', set: '' }, // no uid: no price
  ];
  const first = await (await onPrices({ request: post(cards), env }, fetchFn)).json();
  assert.equal(first.currency, 'USD');
  assert.deepEqual([first.prices['mtg-abc'].usd, first.prices['mtg-abc'].usd_foil], [2, 5]);
  assert.equal(first.prices.sol.usd, 1.25);
  assert.equal(first.prices['pkm-base1-4'].usd_foil, 300);
  assert.equal(first.prices['pkm-gone'], null);
  assert.equal(first.prices['ygo-46986414-LOB-EN005'].usd, 2.1);
  assert.equal(first.prices['old-ygo'], null);
  assert.deepEqual(first.unavailable, []);
  const scry = calls.find((c) => c.url.includes('scryfall'));
  assert.deepEqual(JSON.parse(scry.body).identifiers, [{ id: 'abc' }, { name: 'Sol Ring', set: 'cmr' }]);
  assert.equal(calls.length, 3); // one request per game

  calls.length = 0;
  const second = await (await onPrices({ request: post(cards), env }, fetchFn)).json();
  assert.equal(calls.length, 0, 'served from the cache');
  assert.deepEqual(second.prices, first.prices);
});

test('a source being down is reported, not cached, and does not hide the other games', async () => {
  const fetchFn = async (url) => {
    if (String(url).includes('scryfall')) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 46986414, card_prices: [{ tcgplayer_price: '1.00' }] }] }) };
  };
  const env = { DB: fakeDb() };
  const out = await (await onPrices({ request: post([
    { key: 'a', game: 'mtg', name: 'Bolt', set: 'M10', uid: 'mtg-abc' },
    { key: 'b', game: 'yugioh', name: 'DM', set: '', uid: 'ygo-46986414' },
  ]), env }, fetchFn)).json();
  assert.deepEqual(out.unavailable, ['a']);
  assert.equal(out.prices.b.usd, 1);
  assert.equal(env.DB.prices.has('a'), false);
});

test('bad requests and the rate limit', async () => {
  const env = { DB: fakeDb() };
  const bad = async (cards) => (await onPrices({ request: post(cards), env }, async () => ({}))).status;
  assert.equal(await bad([]), 400);
  assert.equal(await bad([{ key: 'a', game: 'digimon', name: 'x' }]), 400);
  assert.equal(await bad(Array.from({ length: 61 }, (_, i) => ({ key: `k${i}`, game: 'mtg', name: 'x' }))), 400);
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  let status = 200;
  for (let i = 0; i < 31; i++) status = (await onPrices({ request: post([{ key: `r${i}`, game: 'mtg', name: 'x' }]), env }, fetchFn)).status;
  assert.equal(status, 429);
});
