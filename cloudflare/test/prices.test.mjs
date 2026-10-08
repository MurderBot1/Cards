import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onCachedPrices, onStorePrices } from '../src/prices.js';

// A tiny in-memory stand-in for the D1 calls the price routes make.
function fakeDb({ signedIn = true } = {}) {
  const prices = new Map();
  const hits = new Map();
  const statement = (sql) => ({
    bind(...args) {
      return {
        async all() {
          if (sql.startsWith('SELECT key')) return { results: args.map((k) => prices.get(k)).filter(Boolean) };
          throw new Error('unexpected: ' + sql);
        },
        async first() {
          if (sql.startsWith('INSERT INTO api_hits')) {
            const k = args.join('|');
            hits.set(k, (hits.get(k) || 0) + 1);
            return { n: hits.get(k) };
          }
          if (sql.includes('FROM sessions')) return signedIn ? { id: 1, username: 'alice', expires_at: 9e9 } : null;
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

const TOKEN = 'a'.repeat(30);
const req = (path, body, auth = true) =>
  new Request(`https://x/api/prices/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(body),
  });
const cached = (env, keys) => onCachedPrices({ request: req('cached', { keys }, false), env });
const store = (env, prices, auth = true) => onStorePrices({ request: req('store', { prices }, auth), env });

test('what one device stores, another gets from the cache', async () => {
  const env = { DB: fakeDb() };
  assert.deepEqual((await (await cached(env, ['mtg-abc', 'pkm-base1-4'])).json()).prices, {}, 'nothing known yet');

  const stored = await store(env, [
    { key: 'mtg-abc', usd: 2, usd_foil: 5 },
    { key: 'pkm-base1-4', usd: null, usd_foil: null }, // looked up, no price
    { key: 'ygo-46986414-LOB-EN005', usd: 2.104, usd_foil: null },
  ]);
  assert.equal(stored.status, 200);
  assert.equal((await stored.json()).stored, 3);

  const out = await (await cached(env, ['mtg-abc', 'pkm-base1-4', 'ygo-46986414-LOB-EN005', 'mtg-unknown'])).json();
  assert.equal(out.currency, 'USD');
  assert.deepEqual([out.prices['mtg-abc'].usd, out.prices['mtg-abc'].usd_foil], [2, 5]);
  assert.equal(out.prices['pkm-base1-4'], null, 'a known "no price" is null');
  assert.equal(out.prices['ygo-46986414-LOB-EN005'].usd, 2.1, 'rounded to cents');
  assert.equal('mtg-unknown' in out.prices, false, 'unknown keys are left for the app to look up');
});

test('old entries are not served, and recent ones are not overwritten', async () => {
  const env = { DB: fakeDb() };
  const old = Math.floor(Date.now() / 1000) - 13 * 3600;
  env.DB.prices.set('mtg-old', { key: 'mtg-old', usd: 1, usd_foil: null, updated_at: old });
  env.DB.prices.set('mtg-oldmissing', { key: 'mtg-oldmissing', usd: null, usd_foil: null, updated_at: Math.floor(Date.now() / 1000) - 7 * 3600 });
  assert.deepEqual((await (await cached(env, ['mtg-old', 'mtg-oldmissing'])).json()).prices, {}, 'a price past 12 hours, a "no price" past 6');

  await store(env, [{ key: 'mtg-new', usd: 3, usd_foil: null }]);
  const again = await (await store(env, [{ key: 'mtg-new', usd: 99, usd_foil: null }])).json();
  assert.equal(again.stored, 0, 'a price stored minutes ago stays');
  assert.equal(env.DB.prices.get('mtg-new').usd, 3);
  assert.equal((await (await store(env, [{ key: 'mtg-old', usd: 1.5, usd_foil: null }])).json()).stored, 1, 'an old one is replaced');
});

test('storing needs a signed-in user and sane data', async () => {
  const env = { DB: fakeDb({ signedIn: false }) };
  assert.equal((await store(env, [{ key: 'mtg-abc', usd: 1, usd_foil: null }])).status, 401);
  assert.equal((await store(env, [{ key: 'mtg-abc', usd: 1, usd_foil: null }], false)).status, 401);

  const signedIn = { DB: fakeDb() };
  const bad = async (prices) => (await store(signedIn, prices)).status;
  assert.equal(await bad([]), 400);
  assert.equal(await bad([{ key: 'mtg-abc', usd: -1, usd_foil: null }]), 400);
  assert.equal(await bad([{ key: 'mtg-abc', usd: 'free', usd_foil: null }]), 400);
  assert.equal(await bad([{ key: 'mtg-abc', usd: 2e6, usd_foil: null }]), 400);
  assert.equal(await bad([{ key: 'Lightning Bolt|M10', usd: 1, usd_foil: null }]), 400, 'only catalog-id keys');
  assert.equal(await bad([{ key: 'digimon-1', usd: 1, usd_foil: null }]), 400);
  assert.equal(await bad(Array.from({ length: 61 }, (_, i) => ({ key: `mtg-${i}`, usd: 1, usd_foil: null }))), 400);
  assert.equal(signedIn.DB.prices.size, 0, 'nothing from a rejected request is kept');
});

test('bad cache reads and the rate limit', async () => {
  const env = { DB: fakeDb() };
  const bad = async (keys) => (await cached(env, keys)).status;
  assert.equal(await bad([]), 400);
  assert.equal(await bad(['not a key']), 400);
  assert.equal(await bad(Array.from({ length: 91 }, (_, i) => `mtg-${i}`)), 400);
  let status = 200;
  for (let i = 0; i < 61; i++) status = (await cached(env, [`mtg-${i}`])).status;
  assert.equal(status, 429);
});
