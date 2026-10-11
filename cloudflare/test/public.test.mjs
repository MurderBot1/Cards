import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetSchema } from '../src/schema.js';
import { publicPathOf } from '../src/share.js';
import worker from '../src/worker.js';

// A tiny stand-in for D1 that understands exactly the statements the public-page code (and the session lookup) runs.
function fakeDb() {
  const state = { docs: [], pub: [], users: [{ id: 1, username: 'Julie_M', lower: 'julie_m' }, { id: 2, username: 'Bob', lower: 'bob' }] };
  const run = (sql, a) => {
    if (sql.startsWith('CREATE') || sql.startsWith('DROP')) return [];
    if (sql.includes('FROM sessions JOIN users')) return a[0] === 'julie-hash' ? [{ id: 1, username: 'Julie_M', expires_at: 9e12 }] : a[0] === 'bob-hash' ? [{ id: 2, username: 'Bob', expires_at: 9e12 }] : [];
    if (sql.startsWith('SELECT doc FROM sync_docs')) return state.docs.filter((d) => d.user_id === a[0] && d.id === a[1]).map((d) => ({ doc: d.doc }));
    if (sql.startsWith('SELECT kind, doc_id FROM public_lists')) return state.pub.filter((p) => p.user_id === a[0]).map((p) => ({ kind: p.kind, doc_id: p.doc_id })).sort((x, y) => (x.kind < y.kind ? -1 : 1));
    if (sql.startsWith('INSERT INTO public_lists')) {
      const [user_id, kind, doc_id, created_at] = a;
      const have = state.pub.find((p) => p.user_id === user_id && p.kind === kind);
      if (have) Object.assign(have, { doc_id, created_at });
      else state.pub.push({ user_id, kind, doc_id, created_at });
      return [];
    }
    if (sql.startsWith('DELETE FROM public_lists')) {
      state.pub = state.pub.filter((p) => !(p.user_id === a[0] && p.kind === a[1]));
      return [];
    }
    if (sql.startsWith('SELECT users.username AS username, sync_docs.doc AS doc FROM users')) {
      const [kind, lower] = a;
      const user = state.users.find((u) => u.lower === lower);
      const entry = user && state.pub.find((p) => p.user_id === user.id && p.kind === kind);
      const d = entry && state.docs.find((x) => x.user_id === user.id && x.id === entry.doc_id);
      return d ? [{ username: user.username, doc: d.doc }] : [];
    }
    throw new Error(`fake db: unexpected statement ${sql}`);
  };
  return {
    state,
    prepare: (sql) => ({
      bind: (...a) => ({ first: async () => run(sql, a)[0] ?? null, all: async () => ({ results: run(sql, a) }), run: async () => (run(sql, a), {}) }),
    }),
    batch: async () => [],
  };
}

async function sha256Hex(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const JULIE = 'julie-token-julie-token-julie-token';
const BOB = 'bob-token-bob-token-bob-token-bob';

async function setup() {
  forgetSchema();
  const db = fakeDb();
  const hashes = { [await sha256Hex(JULIE)]: 'julie-hash', [await sha256Hex(BOB)]: 'bob-hash' };
  const realPrepare = db.prepare;
  db.prepare = (sql) => {
    const stmt = realPrepare(sql);
    return sql.includes('FROM sessions JOIN users') ? { bind: (hash, now) => stmt.bind(hashes[hash] || 'bad', now) } : stmt;
  };
  const env = { DB: db };
  const call = (method, path, body, token = JULIE) =>
    worker.fetch(new Request(`https://binder.example${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }), env);
  return { db, call };
}

const card = (id, name, over = {}) => ({ id, name, game: 'mtg', set: 'M11', rarity: 'Common', image: '', condition: 'Near Mint', quantity: 1, updated: 5, ...over });
const list = (over = {}) => ({ id: 'wishlist', name: 'Wishlist', kind: 'wishlist', updated: 5, tomb: {}, cards: [card('a', 'Lightning Bolt', { quantity: 4 }), card('b', 'Evil <img src=x onerror=alert(1)>')], ...over });
const store = (db, doc, user_id = 1) => db.state.docs.push({ user_id, id: doc.id, doc: JSON.stringify(doc) });

test('which paths are public page addresses', () => {
  assert.deepEqual(publicPathOf('/julie/wishlist'), { username: 'julie', kind: 'wishlist' });
  assert.deepEqual(publicPathOf('/Julie_M/tradelist'), { username: 'Julie_M', kind: 'tradelist' });
  assert.deepEqual(publicPathOf('/a.b-c_d/wishlist'), { username: 'a.b-c_d', kind: 'wishlist' });
  for (const no of ['/julie', '/julie/', '/julie/wishlist/', '/julie/decks', '/ju/wishlist', `/${'x'.repeat(33)}/wishlist`, '/julie/Wishlist', '/api/auth/me', '/s/abc', '/a b/wishlist', '/julie/wishlist/x', '/']) {
    assert.equal(publicPathOf(no), null, no);
  }
});

test('making a list public needs a signed-in person and a synced list of the right kind', async () => {
  const { db, call } = await setup();
  assert.equal((await call('POST', '/api/public', { id: 'wishlist' }, null)).status, 401);
  assert.equal((await call('GET', '/api/public', null, null)).status, 401);
  assert.equal((await call('POST', '/api/public/revoke', { kind: 'wishlist' }, null)).status, 401);
  assert.equal((await call('POST', '/api/public', {})).status, 400);
  const res = await call('POST', '/api/public', { id: 'wishlist' });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /Sync this list/);
  store(db, { id: 'deck1', name: 'Burn', kind: 'deck', updated: 5, tomb: {}, cards: [] });
  store(db, { id: 'bin', name: 'Binder', updated: 5, tomb: {}, cards: [] });
  for (const id of ['deck1', 'bin']) {
    const r = await call('POST', '/api/public', { id });
    assert.equal(r.status, 400, id);
    assert.match((await r.json()).error, /Only a wishlist or a tradelist/);
  }
  store(db, { id: 'gone', deleted: 9 });
  assert.equal((await call('POST', '/api/public', { id: 'gone' })).status, 404);
  assert.equal(db.state.pub.length, 0, 'nothing was made public by any of those');
});

test('publish gives the address, listing shows it, and the page is there', async () => {
  const { db, call } = await setup();
  store(db, list());
  store(db, list({ id: 'trades', name: 'Trades', kind: 'tradelist', cards: [card('t', 'Sol Ring')] }));
  const w = await (await call('POST', '/api/public', { id: 'wishlist' })).json();
  assert.deepEqual(w, { kind: 'wishlist', id: 'wishlist', url: 'https://binder.example/Julie_M/wishlist' });
  assert.deepEqual(await (await call('POST', '/api/public', { id: 'wishlist' })).json(), w, 'asking again is fine');
  const t = await (await call('POST', '/api/public', { id: 'trades' })).json();
  assert.equal(t.url, 'https://binder.example/Julie_M/tradelist');
  assert.deepEqual((await (await call('GET', '/api/public')).json()).public, [t, w].sort((x, y) => (x.kind < y.kind ? -1 : 1)));
  assert.equal(db.state.pub.length, 2);
  for (const path of ['/Julie_M/wishlist', '/julie_m/wishlist', '/JULIE_M/WISHLIST'.replace('WISHLIST', 'wishlist')]) {
    assert.equal((await call('GET', path, null, null)).status, 200, `${path} (no sign-in, any case)`);
  }
  const html = await (await call('GET', '/Julie_M/tradelist', null, null)).text();
  assert.match(html, /<h1>Julie_M’s trade list<\/h1>/);
  assert.match(html, /Sol Ring/);
});

test('the public page says whose it is, shows the cards, and is safe to open', async () => {
  const { db, call } = await setup();
  store(db, list());
  await call('POST', '/api/public', { id: 'wishlist' });
  const res = await call('GET', '/julie_m/wishlist', null, null);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /^text\/html/);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.match(res.headers.get('X-Robots-Tag'), /noindex/);
  assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(res.headers.get('Content-Security-Policy'), /default-src 'none'/);
  const html = await res.text();
  assert.match(html, /<h1>Julie_M’s wishlist<\/h1>/, 'the username as the account spelled it');
  assert.match(html, /Wishlist · 2 different cards · 5 in total/);
  assert.match(html, /Lightning Bolt/);
  assert.match(html, /×4/);
  assert.doesNotMatch(html, /<img src=x/, 'a card name cannot inject markup');
  assert.match(html, /Evil &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /[\w.]+@[\w.-]+\.\w+/, 'no email address');
});

test('private, unknown, deleted and someone else\'s all look the same: a plain 404', async () => {
  const { db, call } = await setup();
  store(db, list());
  const missing = await call('GET', '/julie_m/wishlist', null, null);   // not made public yet
  const unknown = await call('GET', '/nobody_here/wishlist', null, null);
  assert.deepEqual([missing.status, unknown.status], [404, 404]);
  assert.equal(await missing.text(), await unknown.text(), 'no telling who has an account');
  await call('POST', '/api/public', { id: 'wishlist' });
  assert.equal((await call('GET', '/julie_m/tradelist', null, null)).status, 404, 'the other address is not public');
  assert.equal((await call('GET', '/bob/wishlist', null, null)).status, 404, 'another person\'s address is not affected');
  db.state.docs[0].doc = JSON.stringify({ id: 'wishlist', deleted: 99 });
  assert.equal((await call('GET', '/julie_m/wishlist', null, null)).status, 404, 'a deleted list is gone');
  db.state.docs[0].doc = JSON.stringify(list({ kind: 'deck' }));
  assert.equal((await call('GET', '/julie_m/wishlist', null, null)).status, 404, 'a list that is not a wishlist is never shown there');
});

test('the page follows the list as last synced', async () => {
  const { db, call } = await setup();
  store(db, list());
  await call('POST', '/api/public', { id: 'wishlist' });
  db.state.docs[0].doc = JSON.stringify(list({ cards: [card('z', 'Brand New Card')] }));
  const html = await (await call('GET', '/julie_m/wishlist', null, null)).text();
  assert.match(html, /Brand New Card/);
  assert.doesNotMatch(html, /Lightning Bolt/);
});

test('taking it down kills the address at once; only the owner can', async () => {
  const { db, call } = await setup();
  store(db, list());
  await call('POST', '/api/public', { id: 'wishlist' });
  assert.deepEqual(await (await call('POST', '/api/public/revoke', { kind: 'wishlist' }, BOB)).json(), { ok: true });
  assert.equal(db.state.pub.length, 1, 'Bob cannot take down Julie\'s page (he only touches his own)');
  assert.equal((await call('GET', '/julie_m/wishlist', null, null)).status, 200);
  assert.equal((await call('POST', '/api/public/revoke', { kind: 'deck' })).status, 400);
  assert.equal((await call('POST', '/api/public/revoke', {})).status, 400);
  assert.deepEqual(await (await call('POST', '/api/public/revoke', { kind: 'wishlist' })).json(), { ok: true });
  assert.equal((await call('GET', '/julie_m/wishlist', null, null)).status, 404);
  assert.deepEqual((await (await call('GET', '/api/public')).json()).public, []);
  assert.equal((await call('POST', '/api/public/revoke', { kind: 'wishlist' })).status, 200, 'twice is fine');
});

test('someone else cannot make your list public', async () => {
  const { db, call } = await setup();
  store(db, list(), 2);  // Bob's
  assert.equal((await call('POST', '/api/public', { id: 'wishlist' }, JULIE)).status, 404, 'Julie has no such list');
  assert.equal((await call('POST', '/api/public', { id: 'wishlist' }, BOB)).status, 200);
  assert.equal((await call('GET', '/bob/wishlist', null, null)).status, 200);
  assert.equal((await call('GET', '/julie_m/wishlist', null, null)).status, 404);
});

test('a path that is not an address still goes where it did (the API, the share pages, the app files)', async () => {
  const { call } = await setup();
  assert.equal((await call('GET', '/api/auth/me', null, null)).status, 401);
  assert.equal((await call('GET', '/api/nothing-here', null, null)).status, 404);
  assert.equal((await call('GET', '/s/short', null, null)).status, 404);
  assert.equal((await call('POST', '/julie_m/wishlist', {}, JULIE)).status, 404, 'only a GET shows the page');
});
