import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetSchema } from '../src/schema.js';
import { MAX_SHARES_PER_USER, escapeHtml, renderSharePage } from '../src/share.js';
import worker from '../src/worker.js';

// A tiny stand-in for D1 that understands exactly the statements share.js (and the session lookup) runs.
function fakeDb() {
  const state = { docs: [], shares: [] };  // docs: {user_id, id, doc}; shares: {token, user_id, doc_id, created_at}
  const run = (sql, a) => {
    if (sql.startsWith('CREATE') || sql.startsWith('DROP')) return { rows: [] };
    if (sql.includes('FROM sessions JOIN users')) return { rows: a[0] === 'good-hash' ? [{ id: 1, username: 'Julie', expires_at: 9e12 }] : [] };
    if (sql.startsWith('SELECT doc FROM sync_docs')) return { rows: state.docs.filter((d) => d.user_id === a[0] && d.id === a[1]).map((d) => ({ doc: d.doc })) };
    if (sql.startsWith('SELECT token FROM shares')) return { rows: state.shares.filter((s) => s.user_id === a[0] && s.doc_id === a[1]).map((s) => ({ token: s.token })) };
    if (sql.startsWith('SELECT COUNT(*) AS n FROM shares')) return { rows: [{ n: state.shares.filter((s) => s.user_id === a[0]).length }] };
    if (sql.startsWith('INSERT INTO shares')) {
      const [token, user_id, doc_id, created_at] = a;
      const have = state.shares.find((s) => s.user_id === user_id && s.doc_id === doc_id);
      if (have) Object.assign(have, { token, created_at });
      else state.shares.push({ token, user_id, doc_id, created_at });
      return { rows: [] };
    }
    if (sql.startsWith('DELETE FROM shares')) {
      state.shares = state.shares.filter((s) => !(s.user_id === a[0] && s.doc_id === a[1]));
      return { rows: [] };
    }
    if (sql.startsWith('SELECT doc_id, token FROM shares')) return { rows: state.shares.filter((s) => s.user_id === a[0]).map((s) => ({ doc_id: s.doc_id, token: s.token })) };
    if (sql.startsWith('SELECT sync_docs.doc AS doc FROM shares')) {
      const s = state.shares.find((x) => x.token === a[0]);
      const d = s && state.docs.find((x) => x.user_id === s.user_id && x.id === s.doc_id);
      return { rows: d ? [{ doc: d.doc }] : [] };
    }
    throw new Error(`fake db: unexpected statement ${sql}`);
  };
  return {
    state,
    prepare: (sql) => ({
      bind: (...a) => ({ first: async () => run(sql, a).rows[0] ?? null, all: async () => ({ results: run(sql, a).rows }), run: async () => (run(sql, a), {}) }),
    }),
    batch: async () => [],
  };
}

const TOKEN = 'good-token-good-token-good-token';  // sessionUser hashes this; the fake only checks it was hashed from "good"
async function sha256Hex(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function setup() {
  forgetSchema();
  const db = fakeDb();
  const goodHash = await sha256Hex(TOKEN);
  // route the session lookup to the right hash
  const realPrepare = db.prepare;
  db.prepare = (sql) => {
    const stmt = realPrepare(sql);
    return sql.includes('FROM sessions JOIN users') ? { bind: (hash, now) => stmt.bind(hash === goodHash ? 'good-hash' : 'bad', now) } : stmt;
  };
  const env = { DB: db };
  const call = (method, path, body, token = TOKEN) =>
    worker.fetch(new Request(`https://binder.example${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }), env);
  return { db, env, call };
}

const list = (over = {}) => ({
  id: 'L1', name: 'Mono <Red> & "Burn"', kind: 'deck', updated: 5, tomb: {},
  cards: [
    { id: 'a', name: 'Lightning Bolt', game: 'mtg', set: 'M11', rarity: 'Common', image: 'https://cards.scryfall.io/small/front/a.jpg', condition: 'Near Mint', quantity: 4, foil: true, number: '146', updated: 5 },
    { id: 'b', name: 'Evil <img src=x onerror=alert(1)>', game: 'mtg', set: 'M10', rarity: '', image: 'https://tracker.example/pixel.gif', condition: 'Damaged', quantity: 1, updated: 5 },
    { id: 'c', name: 'Charizard', game: 'pokemon', set: 'BS', rarity: 'Rare Holo', image: 'javascript:alert(1)', condition: 'Near Mint', quantity: 2, owned: 1, updated: 5 },
  ],
  ...over,
});
const store = (db, doc, user_id = 1) => db.state.docs.push({ user_id, id: doc.id, doc: JSON.stringify(doc) });

test('sharing needs a signed-in person and a list that is synced', async () => {
  const { call } = await setup();
  assert.equal((await call('POST', '/api/share', { id: 'L1' }, null)).status, 401);
  assert.equal((await call('GET', '/api/share', null, null)).status, 401);
  assert.equal((await call('POST', '/api/share/revoke', { id: 'L1' }, null)).status, 401);
  assert.equal((await call('POST', '/api/share', { id: 'L1' }, 'x'.repeat(30))).status, 401);
  const res = await call('POST', '/api/share', { id: 'L1' });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /Sync this list/);
  assert.equal((await call('POST', '/api/share', {})).status, 400);
  assert.equal((await call('POST', '/api/share', { id: 'L1' }, TOKEN)).status, 404);
});

test('a deleted list cannot be shared', async () => {
  const { db, call } = await setup();
  store(db, { id: 'L1', deleted: 9 });
  assert.equal((await call('POST', '/api/share', { id: 'L1' })).status, 404);
});

test('create gives an unguessable link, asking again returns the same one, renew replaces it', async () => {
  const { db, call } = await setup();
  store(db, list());
  const made = await (await call('POST', '/api/share', { id: 'L1' })).json();
  assert.match(made.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(made.url, `https://binder.example/s/${made.token}`);
  assert.equal(made.id, 'L1');
  assert.deepEqual(await (await call('POST', '/api/share', { id: 'L1' })).json(), made, 'same link');
  assert.equal(db.state.shares.length, 1);

  const renewed = await (await call('POST', '/api/share', { id: 'L1', renew: true })).json();
  assert.notEqual(renewed.token, made.token);
  assert.equal(db.state.shares.length, 1);
  assert.equal((await call('GET', `/s/${made.token}`)).status, 404, 'the old link is dead');
  assert.equal((await call('GET', `/s/${renewed.token}`)).status, 200);
  assert.deepEqual((await (await call('GET', '/api/share')).json()).shares, [renewed]);
});

test('tokens are different every time', async () => {
  const { db, call } = await setup();
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    store(db, list({ id: `L${i}` }));
    seen.add((await (await call('POST', '/api/share', { id: `L${i}` })).json()).token);
  }
  assert.equal(seen.size, 20);
});

test('someone else cannot share or stop sharing a list that is not theirs', async () => {
  const { db, call } = await setup();
  store(db, list(), 2);  // belongs to user 2
  assert.equal((await call('POST', '/api/share', { id: 'L1' })).status, 404);
  db.state.shares.push({ token: 'T'.repeat(32), user_id: 2, doc_id: 'L1', created_at: 1 });
  await call('POST', '/api/share/revoke', { id: 'L1' });
  assert.equal(db.state.shares.length, 1, 'user 1 cannot revoke user 2\'s link');
  assert.deepEqual((await (await call('GET', '/api/share')).json()).shares, []);
});

test('there is a cap on how many lists one person shares', async () => {
  const { db, call } = await setup();
  for (let i = 0; i < MAX_SHARES_PER_USER; i++) db.state.shares.push({ token: `t${i}`.padEnd(32, 'x'), user_id: 1, doc_id: `D${i}`, created_at: i });
  store(db, list());
  const res = await call('POST', '/api/share', { id: 'L1' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /at most 100/);
  // a list that is already shared can still be renewed at the cap
  store(db, list({ id: 'D3' }));
  assert.equal((await call('POST', '/api/share', { id: 'D3', renew: true })).status, 200);
});

test('stopping sharing kills the link at once', async () => {
  const { db, call } = await setup();
  store(db, list());
  const { token } = await (await call('POST', '/api/share', { id: 'L1' })).json();
  assert.equal((await call('GET', `/s/${token}`, null, null)).status, 200, 'no sign-in needed to view');
  assert.deepEqual(await (await call('POST', '/api/share/revoke', { id: 'L1' })).json(), { ok: true });
  assert.equal((await call('GET', `/s/${token}`, null, null)).status, 404);
  assert.equal((await call('POST', '/api/share/revoke', { id: 'L1' })).status, 200, 'revoking twice is fine');
  assert.equal((await call('POST', '/api/share/revoke', {})).status, 400);
});

test('the page shows the list and nothing private, and is safe to open', async () => {
  const { db, call } = await setup();
  store(db, list());
  const { token } = await (await call('POST', '/api/share', { id: 'L1' })).json();
  const res = await call('GET', `/s/${token}`, null, null);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /^text\/html/);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.match(res.headers.get('X-Robots-Tag'), /noindex/);
  assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(res.headers.get('Content-Security-Policy'), /default-src 'none'/);
  assert.doesNotMatch(res.headers.get('Content-Security-Policy'), /script-src/);
  const html = await res.text();
  assert.match(html, /<h1>Mono &lt;Red&gt; &amp; &quot;Burn&quot;<\/h1>/);
  assert.match(html, /Deck · 3 different cards · 7 in total/);
  assert.match(html, /Lightning Bolt/);
  assert.match(html, /×4/);
  assert.match(html, /Foil/);
  assert.match(html, /#146/);
  assert.match(html, /<img src="https:\/\/cards\.scryfall\.io\/small\/front\/a\.jpg"/);
  assert.doesNotMatch(html, /<img src=x/, 'a card name cannot inject markup');
  assert.match(html, /Evil &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /tracker\.example/, 'images only from the card catalogs');
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /Julie/, 'the owner\'s name is not on the page');
  assert.doesNotMatch(html, /owned/i, 'what a deck owner has is not shown');
  assert.doesNotMatch(html, /<script/i);
});

test('the page follows the list as last synced', async () => {
  const { db, call } = await setup();
  store(db, list());
  const { token } = await (await call('POST', '/api/share', { id: 'L1' })).json();
  db.state.docs[0].doc = JSON.stringify(list({ name: 'Renamed', cards: [] }));
  const html = await (await call('GET', `/s/${token}`, null, null)).text();
  assert.match(html, /<h1>Renamed<\/h1>/);
  assert.match(html, /Nothing in this list yet/);
  db.state.docs[0].doc = JSON.stringify({ id: 'L1', deleted: 99 });
  assert.equal((await call('GET', `/s/${token}`, null, null)).status, 404, 'a deleted list is gone');
});

test('a link that is not even shaped like a token is a plain not-found', async () => {
  const { call } = await setup();
  for (const bad of ['', 'short', 'x'.repeat(33), `${'x'.repeat(31)}!`, 'a/b']) {
    const res = await call('GET', `/s/${bad}`, null, null);
    assert.equal(res.status, 404, bad);
    assert.match(await res.text(), /doesn’t work/);
  }
});

test('a plain collection renders as HTML, and escaping covers the usual suspects', () => {
  const html = renderSharePage({ id: 'x', name: 'Binder', updated: 1, cards: [], tomb: {} }).headers.get('Content-Type');
  assert.match(html, /html/);
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});
