import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { forgetSchema } from '../src/schema.js';
import { cleanPhone, cleanSeller } from '../src/sellerInput.js';
import { encodeForm, stripeConfig } from '../src/stripe.js';
import worker from '../src/worker.js';

const GOOD = {
  legalName: '  Julie   Anne McRidland ',
  phone: '(555) 123-4567',
  address: { line1: '12 Main Street', line2: 'Apt 4', city: 'Portland', region: 'OR', postal: '97201', country: 'us' },
  payout: { kind: 'stripe' },
};
const withChange = (change) => ({ ...GOOD, ...change });
const withAddress = (change) => ({ ...GOOD, address: { ...GOOD.address, ...change } });

test('the phone number: digits with an optional + and the usual punctuation', () => {
  assert.equal(cleanPhone('(555) 123-4567'), '5551234567');
  assert.equal(cleanPhone('+44 20 7946 0958'), '+442079460958');
  assert.equal(cleanPhone('555.123.4567'), '5551234567');
  for (const bad of ['', '12345', '1'.repeat(16), 'call me', '555-CALL-NOW', null, undefined, 5551234567]) assert.equal(cleanPhone(bad), null, String(bad));
});

test('registration input: a good form is cleaned (spaces squashed, country upper-cased)', () => {
  const { seller, error } = cleanSeller(GOOD);
  assert.equal(error, undefined);
  assert.deepEqual(seller, {
    legalName: 'Julie Anne McRidland',
    phone: '5551234567',
    address: { line1: '12 Main Street', line2: 'Apt 4', city: 'Portland', region: 'OR', postal: '97201', country: 'US' },
    payout: { kind: 'stripe', ref: '' },
  });
  assert.equal(cleanSeller({ ...GOOD, payout: undefined }).seller.payout.kind, 'stripe', 'Stripe is the default way to be paid');
  assert.equal(cleanSeller(withAddress({ line2: undefined })).seller.address.line2, '');
});

test('registration input: each thing that is missing or wrong says what to fix', () => {
  const cases = [
    [null, /Fill in the form/],
    [withChange({ legalName: 'Julie' }), /full legal name/],
    [withChange({ legalName: '' }), /full legal name/],
    [withChange({ legalName: 'J1 M2' }), /full legal name/],
    [withChange({ legalName: '<b>Julie</b> McRidland' }), /full legal name/],
    [withChange({ legalName: 'x'.repeat(101) + ' y' }), /full legal name/],
    [withChange({ phone: '123' }), /phone number/],
    [withAddress({ line1: '' }), /street address/],
    [withAddress({ line2: 'x'.repeat(101) }), /second address line/],
    [withAddress({ city: '' }), /city/],
    [withAddress({ region: '' }), /state, province or region/],
    [withAddress({ postal: '!' }), /postal or ZIP/],
    [withAddress({ country: 'ZZ' }), /country/],
    [withAddress({ country: '' }), /country/],
    [withChange({ payout: { kind: 'bitcoin' } }), /how you want to be paid/],
    [withChange({ payout: { kind: 'paypal', ref: 'not an email' } }), /PayPal/],
    [withChange({ payout: { kind: 'venmo', ref: '12' } }), /Venmo account uses/],
  ];
  for (const [body, message] of cases) {
    const result = cleanSeller(body);
    assert.match(result.error || '', message, JSON.stringify(body));
    assert.equal(result.seller, undefined);
  }
});

test('registration input: Venmo is for the United States and defaults to the seller\'s own phone; PayPal wants an email', () => {
  assert.deepEqual(cleanSeller(withChange({ payout: { kind: 'venmo' } })).seller.payout, { kind: 'venmo', ref: '5551234567' });
  assert.deepEqual(cleanSeller(withChange({ payout: { kind: 'venmo', ref: '+1 (555) 987-6543' } })).seller.payout, { kind: 'venmo', ref: '+15559876543' });
  assert.match(cleanSeller({ ...withAddress({ country: 'GB' }), payout: { kind: 'venmo' } }).error, /only available to sellers in the United States/);
  assert.deepEqual(cleanSeller(withChange({ payout: { kind: 'paypal', ref: ' Julie@Example.COM ' } })).seller.payout, { kind: 'paypal', ref: 'julie@example.com' });
  assert.equal(cleanSeller({ ...withAddress({ country: 'GB' }), payout: { kind: 'paypal', ref: 'a@b.co' } }).error, undefined);
});

test('Stripe form encoding and configuration', () => {
  assert.equal(encodeForm({ a: 1, b: { c: 'x y', d: { e: true } }, f: [1, 2], g: undefined, h: null }), 'a=1&b%5Bc%5D=x%20y&b%5Bd%5D%5Be%5D=true&f%5B0%5D=1&f%5B1%5D=2');
  assert.equal(stripeConfig({}).configured, false);
  assert.equal(stripeConfig({ STRIPE_SECRET_KEY: 'nonsense' }).configured, false);
  assert.deepEqual(stripeConfig({ STRIPE_SECRET_KEY: 'sk_test_abcdefghijkl' }), { configured: true, test: true, problem: '' });
  assert.equal(stripeConfig({ STRIPE_SECRET_KEY: 'rk_test_abcdefghijkl' }).configured, true);
  const live = stripeConfig({ STRIPE_SECRET_KEY: 'sk_live_abcdefghijkl' });
  assert.equal(live.configured, false, 'a live key is refused until live payments are switched on');
  assert.match(live.problem, /PAYMENTS_LIVE/);
  assert.deepEqual(stripeConfig({ STRIPE_SECRET_KEY: 'sk_live_abcdefghijkl', PAYMENTS_LIVE: 'true' }), { configured: true, test: false, problem: '' });
});

// ---- the endpoints, with a stand-in for D1 and for Stripe -----------------------------------------------------------

function fakeDb() {
  const state = { sellers: new Map() };
  const run = (sql, a) => {
    if (sql.startsWith('CREATE') || sql.startsWith('DROP')) return [];
    if (sql.includes('FROM sessions JOIN users')) return a[0] === 'julie-hash' ? [{ id: 1, username: 'julie', expires_at: 9e12 }] : a[0] === 'bob-hash' ? [{ id: 2, username: 'bob', expires_at: 9e12 }] : [];
    if (sql.startsWith('SELECT * FROM sellers')) return state.sellers.has(a[0]) ? [state.sellers.get(a[0])] : [];
    if (sql.startsWith('INSERT INTO sellers')) {
      const [user_id, legal_name, phone, addr_line1, addr_line2, city, region, postal, country, payout_kind, payout_ref, now] = a;
      const have = state.sellers.get(user_id);
      state.sellers.set(user_id, { user_id, legal_name, phone, addr_line1, addr_line2, city, region, postal, country, payout_kind, payout_ref, stripe_account: have ? have.stripe_account : null, created_at: have ? have.created_at : now, updated_at: now });
      return [];
    }
    if (sql.startsWith('UPDATE sellers SET stripe_account')) {
      state.sellers.get(a[2]).stripe_account = a[0];
      return [];
    }
    if (sql.startsWith('DELETE FROM sellers')) {
      state.sellers.delete(a[0]);
      return [];
    }
    throw new Error(`fake db: unexpected statement ${sql}`);
  };
  return {
    state,
    prepare: (sql) => ({ bind: (...a) => ({ first: async () => run(sql, a)[0] ?? null, all: async () => ({ results: run(sql, a) }), run: async () => (run(sql, a), {}) }) }),
    batch: async () => [],
  };
}
async function sha256Hex(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const JULIE = 'julie-token-julie-token-julie-token';
const BOB = 'bob-token-bob-token-bob-token-bob';
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function setup(extraEnv = {}) {
  forgetSchema();
  const db = fakeDb();
  const hashes = { [await sha256Hex(JULIE)]: 'julie-hash', [await sha256Hex(BOB)]: 'bob-hash' };
  const realPrepare = db.prepare;
  db.prepare = (sql) => {
    const stmt = realPrepare(sql);
    return sql.includes('FROM sessions JOIN users') ? { bind: (hash, now) => stmt.bind(hashes[hash] || 'bad', now) } : stmt;
  };
  const env = { DB: db, ...extraEnv };
  const call = (method, path, body, token = JULIE) =>
    worker.fetch(new Request(`https://binder.example${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }), env);
  return { db, call };
}

// a Stripe that remembers what it was asked
function fakeStripe({ payoutsEnabled = false, failDelete = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/v1', '');
    calls.push({ method: init.method, path, auth: init.headers && init.headers.Authorization, idem: init.headers && init.headers['Idempotency-Key'], body: init.body ? decodeURIComponent(init.body) : '' });
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (init.method === 'POST' && path === '/accounts') return json(200, { id: 'acct_123' });
    if (init.method === 'POST' && path === '/account_links') return json(200, { url: 'https://connect.stripe.com/setup/e/acct_123/abc' });
    if (init.method === 'GET' && path === '/accounts/acct_123') return json(200, { id: 'acct_123', details_submitted: payoutsEnabled, payouts_enabled: payoutsEnabled, requirements: { currently_due: payoutsEnabled ? [] : ['external_account', 'individual.id_number'] } });
    if (init.method === 'DELETE' && path === '/accounts/acct_123') return failDelete ? json(400, { error: { message: 'has a balance' } }) : json(200, { deleted: true });
    return json(404, { error: { message: 'unexpected' } });
  };
  return calls;
}
const KEYS = { STRIPE_SECRET_KEY: 'sk_test_abcdefghijklmnop' };

test('the seller endpoints need a signed-in person', async () => {
  const { call } = await setup(KEYS);
  for (const [method, path, body] of [['GET', '/api/seller'], ['POST', '/api/seller', GOOD], ['POST', '/api/seller/stripe', {}], ['POST', '/api/seller/delete', {}]]) {
    assert.equal((await call(method, path, body, null)).status, 401, `${method} ${path}`);
    assert.equal((await call(method, path, body, 'x'.repeat(30))).status, 401, `${method} ${path} (bad token)`);
  }
});

test('nobody is a seller until they register, and the answer says whether payments are set up', async () => {
  const { call } = await setup();
  const body = await (await call('GET', '/api/seller')).json();
  assert.equal(body.seller, null);
  assert.equal(body.payments.stripe, false);
  assert.match(body.payments.stripeProblem, /not set up/);
  const withKeys = await setup(KEYS);
  assert.deepEqual((await (await withKeys.call('GET', '/api/seller')).json()).payments, { stripe: true, stripeTest: true, stripeProblem: '', paypal: false });
});

test('registering stores the cleaned profile for that person only', async () => {
  const { db, call } = await setup(KEYS);
  const res = await call('POST', '/api/seller', GOOD);
  assert.equal(res.status, 200);
  const { seller } = await res.json();
  assert.equal(seller.legalName, 'Julie Anne McRidland');
  assert.equal(seller.phone, '5551234567');
  assert.equal(seller.address.country, 'US');
  assert.deepEqual(seller.payout, { kind: 'stripe', ref: '' });
  assert.deepEqual(seller.stripe, { account: false });
  assert.equal(seller.ready, false, 'bank or debit payouts are not ready until Stripe says so');
  assert.equal(db.state.sellers.size, 1);
  assert.equal((await (await call('GET', '/api/seller', null, BOB)).json()).seller, null, 'Bob sees nothing of Julie\'s profile');
  assert.equal((await call('POST', '/api/seller', { ...GOOD, legalName: 'Bob' }, BOB)).status, 400);
  assert.equal(db.state.sellers.size, 1, 'a bad form stores nothing');
});

test('Venmo and PayPal sellers are ready as soon as they have registered', async () => {
  const { call } = await setup(KEYS);
  const venmo = (await (await call('POST', '/api/seller', { ...GOOD, payout: { kind: 'venmo' } })).json()).seller;
  assert.deepEqual([venmo.payout, venmo.ready, venmo.stripe], [{ kind: 'venmo', ref: '5551234567' }, true, null]);
  const paypal = (await (await call('POST', '/api/seller', { ...GOOD, payout: { kind: 'paypal', ref: 'j@example.com' } })).json()).seller;
  assert.deepEqual([paypal.payout.kind, paypal.ready], ['paypal', true]);
});

test('registering again updates the profile and keeps the Stripe account', async () => {
  const { db, call } = await setup(KEYS);
  fakeStripe();
  await call('POST', '/api/seller', GOOD);
  await call('POST', '/api/seller/stripe', {});
  assert.equal(db.state.sellers.get(1).stripe_account, 'acct_123');
  const { seller } = await (await call('POST', '/api/seller', { ...GOOD, phone: '555 999 0000' })).json();
  assert.equal(seller.phone, '5559990000');
  assert.equal(db.state.sellers.get(1).stripe_account, 'acct_123');
  assert.equal(db.state.sellers.size, 1);
});

test('Stripe onboarding: registers first, makes the account once, and hands back Stripe\'s own page', async () => {
  const { call } = await setup(KEYS);
  const calls = fakeStripe();
  assert.equal((await call('POST', '/api/seller/stripe', {})).status, 404, 'register first');
  await call('POST', '/api/seller', GOOD);
  const res = await call('POST', '/api/seller/stripe', {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, 'https://connect.stripe.com/setup/e/acct_123/abc');
  const make = calls.find((c) => c.path === '/accounts' && c.method === 'POST');
  assert.equal(make.auth, `Bearer ${KEYS.STRIPE_SECRET_KEY}`);
  assert.equal(make.idem, 'binder-seller-1');
  assert.match(make.body, /type=express/);
  assert.match(make.body, /country=US/);
  assert.match(make.body, /individual\[address\]\[postal_code\]=97201/);
  assert.match(make.body, /capabilities\[transfers\]\[requested\]=true/);
  assert.doesNotMatch(make.body, /external_account|card\[|bank_account|cvc|account_number/i, 'no card or bank details are ever sent from here');
  const link = calls.find((c) => c.path === '/account_links');
  assert.match(link.body, /account=acct_123/);
  assert.match(link.body, /return_url=https:\/\/binder\.example\/\?seller=return/);
  // asking again reuses the account
  await call('POST', '/api/seller/stripe', {});
  assert.equal(calls.filter((c) => c.path === '/accounts' && c.method === 'POST').length, 1);
  assert.equal(calls.filter((c) => c.path === '/account_links').length, 2);
});

test('Stripe not set up, or failing: a plain message, and nothing breaks', async () => {
  const none = await setup();
  await none.call('POST', '/api/seller', GOOD);
  const off = await none.call('POST', '/api/seller/stripe', {});
  assert.equal(off.status, 503);
  assert.match((await off.json()).error, /Payments aren't available yet/);

  const live = await setup({ STRIPE_SECRET_KEY: 'sk_live_abcdefghijklmnop' });
  await live.call('POST', '/api/seller', GOOD);
  const refused = await live.call('POST', '/api/seller/stripe', {});
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).error, /PAYMENTS_LIVE/);

  const { call } = await setup(KEYS);
  await call('POST', '/api/seller', GOOD);
  globalThis.fetch = async () => { throw new Error('network down'); };
  const down = await call('POST', '/api/seller/stripe', {});
  assert.equal(down.status, 502);
  assert.match((await down.json()).error, /Couldn't reach Stripe/);
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'country is not supported' } }) });
  const refusedByStripe = await call('POST', '/api/seller/stripe', {});
  assert.equal(refusedByStripe.status, 400);
  assert.equal((await refusedByStripe.json()).error, 'country is not supported');
});

test('the seller\'s Stripe status is read from Stripe: ready only when payouts are enabled', async () => {
  const { call } = await setup(KEYS);
  fakeStripe({ payoutsEnabled: false });
  await call('POST', '/api/seller', GOOD);
  await call('POST', '/api/seller/stripe', {});
  let { seller } = await (await call('GET', '/api/seller')).json();
  assert.deepEqual(seller.stripe, { account: true, detailsSubmitted: false, payoutsEnabled: false, due: 2 });
  assert.equal(seller.ready, false);
  fakeStripe({ payoutsEnabled: true });
  ({ seller } = await (await call('GET', '/api/seller')).json());
  assert.deepEqual([seller.stripe.payoutsEnabled, seller.stripe.due, seller.ready], [true, 0, true]);
  globalThis.fetch = async () => { throw new Error('down'); };
  ({ seller } = await (await call('GET', '/api/seller')).json());
  assert.deepEqual(seller.stripe, { account: true, unknown: true }, 'Stripe being unreachable does not break the page');
  assert.equal(seller.ready, false);
});

test('removing the seller profile deletes it, and the Stripe account when Stripe allows', async () => {
  const { db, call } = await setup(KEYS);
  const calls = fakeStripe();
  await call('POST', '/api/seller', GOOD);
  await call('POST', '/api/seller/stripe', {});
  assert.deepEqual(await (await call('POST', '/api/seller/delete', {})).json(), { ok: true, stripe: 'deleted' });
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/accounts/acct_123'));
  assert.equal(db.state.sellers.size, 0);
  assert.equal((await (await call('GET', '/api/seller')).json()).seller, null);
  assert.deepEqual(await (await call('POST', '/api/seller/delete', {})).json(), { ok: true, stripe: 'none' }, 'twice is fine');

  fakeStripe({ failDelete: true });
  await call('POST', '/api/seller', GOOD);
  await call('POST', '/api/seller/stripe', {});
  assert.deepEqual(await (await call('POST', '/api/seller/delete', {})).json(), { ok: true, stripe: 'kept' });
  assert.equal(db.state.sellers.size, 0, 'the profile goes even when Stripe keeps the account');
});
