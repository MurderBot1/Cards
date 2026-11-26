// Shared set-up for the shop tests: a real SQLite database with the Worker's schema, three people with sessions
// (julie the buyer, bob and carol sellers), and helpers to call the Worker and to stand in for Stripe and Shippo.
import { forgetSchema } from '../../src/schema.js';
import worker from '../../src/worker.js';
import { createD1 } from './d1.mjs';

export const TOKENS = {
  julie: 'julie-token-julie-token-julie-token',
  bob: 'bob-token-bob-token-bob-token-bob',
  carol: 'carol-token-carol-token-carol-tok',
};
export const IDS = { julie: 1, bob: 2, carol: 3 };

async function sha256Hex(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const ADDRESS = { name: 'Julie Buyer', phone: '5551230000', line1: '9 Buyer Lane', line2: '', city: 'Austin', region: 'TX', postal: '78701', country: 'US' };

export async function createShop(extraEnv = {}) {
  forgetSchema();
  const DB = await createD1();
  const env = {
    DB,
    STRIPE_SECRET_KEY: 'sk_test_abcdefghijklmnop',
    ...extraEnv,
  };
  // the Worker creates its schema on the first request
  await worker.fetch(new Request('https://binder.example/api/auth/me'), env);
  const farFuture = Math.floor(Date.now() / 1000) + 86400;
  for (const [name, id] of Object.entries(IDS)) {
    DB.sql('INSERT INTO users (id, username, username_lower, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, name, name, `${name}@example.com`, 'x', 1);
    DB.sql('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', await sha256Hex(TOKENS[name]), id, 1, farFuture);
  }
  const call = async (method, path, body, who = 'julie', headers = {}) => {
    const res = await worker.fetch(
      new Request(`https://binder.example${path}`, {
        method,
        headers: { ...(who ? { Authorization: `Bearer ${TOKENS[who]}` } : {}), ...(body && typeof body === 'object' ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      }),
      env
    );
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, text, headers: res.headers };
  };
  /** Makes bob/carol sellers (a Stripe account for bob, a Venmo payout for carol, a Stripe one with country override). */
  const makeSeller = (who, extra = {}) => {
    const row = { stripe_account: who === 'carol' ? null : `acct_${who}`, payout_kind: who === 'carol' ? 'venmo' : 'stripe', country: 'US', ...extra };
    DB.sql(
      'INSERT INTO sellers (user_id, legal_name, phone, addr_line1, addr_line2, city, region, postal, country, payout_kind, payout_ref, stripe_account, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      IDS[who], `${who[0].toUpperCase()}${who.slice(1)} Seller`, '5557770000', `1 ${who} Road`, '', 'Portland', 'OR', '97201', row.country, row.payout_kind, row.payout_kind === 'stripe' ? '' : '5557770000', row.stripe_account, 1, 1
    );
  };
  return { env, DB, call, makeSeller };
}

export const LISTING = {
  game: 'mtg', cardId: 'mtg-abc', name: 'Lightning Bolt', set: 'LEA', number: '161', image: 'https://cards.example/bolt.jpg',
  condition: 'Near Mint', foil: false, language: 'English', priceCents: 1250, quantity: 4, note: '',
};

/**
 * A stand-in for the outside world (Stripe v1 and v2, Shippo): install it on globalThis.fetch. Remembers every call in
 * `calls` and answers the way those APIs do, closely enough for the Worker's code paths.
 */
export function fakeWorld({ shippoRates = [{ amount: '4.00', provider: 'USPS', servicelevel: { name: 'Ground Advantage', token: 'usps_ground_advantage' }, estimated_days: 3, object_id: 'rate_1' }], shippoDown = false, failTransfer = false, failRefund = false, sellerPayoutsActive = true } = {}) {
  const calls = [];
  let counter = 0;
  const uid = (p) => `${p}_${++counter}`;
  const state = { sessions: new Map(), customers: new Map(), refunds: [], transfers: [], methods: [], tracks: new Map() };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const headers = init.headers || {};
    const rawBody = init.body || '';
    let form = null;
    let json = null;
    if (typeof rawBody === 'string' && rawBody) {
      if ((headers['Content-Type'] || '').includes('json')) json = JSON.parse(rawBody);
      else form = new URLSearchParams(rawBody);
    }
    const call = { host: u.host, method, path: u.pathname, search: u.search, headers, form, json, body: rawBody };
    calls.push(call);
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

    if (u.host === 'api.stripe.com') {
      const p = u.pathname;
      if (p.startsWith('/v2/core/accounts/') && method === 'GET') {
        return reply(200, { id: p.split('/')[4], configuration: { merchant: { capabilities: { card_payments: { status: sellerPayoutsActive ? 'active' : 'restricted' }, stripe_balance: { payouts: { status: sellerPayoutsActive ? 'active' : 'restricted' } } } } }, requirements: { entries: sellerPayoutsActive ? [] : [{ description: 'x' }] } });
      }
      if (p === '/v1/customers' && method === 'POST') { const id = uid('cus'); state.customers.set(id, form); return reply(200, { id }); }
      if (p === '/v1/checkout/sessions' && method === 'POST') {
        const id = uid('cs_test');
        const session = { id, url: `https://checkout.stripe.com/c/pay/${id}`, status: 'open', payment_status: 'unpaid', metadata: { order_id: form.get('metadata[order_id]') }, form };
        state.sessions.set(id, session);
        return reply(200, { id, url: session.url });
      }
      const sm = /^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/.exec(p);
      if (sm) {
        const session = state.sessions.get(sm[1]);
        if (!session) return reply(404, { error: { message: 'No such session' } });
        if (sm[2] && method === 'POST') { session.status = 'expired'; return reply(200, { id: session.id, status: 'expired' }); }
        if (method === 'GET') {
          const paid = session.status === 'complete';
          return reply(200, { id: session.id, status: paid ? 'complete' : session.status, payment_status: paid ? 'paid' : 'unpaid', metadata: session.metadata, payment_intent: paid ? { id: `pi_${session.id}`, latest_charge: `ch_${session.id}` } : null });
        }
      }
      if (/^\/v1\/customers\/[^/]+\/payment_methods$/.test(p) && method === 'GET') return reply(200, { data: state.methods });
      if (/^\/v1\/payment_methods\/[^/]+\/detach$/.test(p) && method === 'POST') { state.methods = state.methods.filter((m) => m.id !== p.split('/')[3]); return reply(200, { id: p.split('/')[3] }); }
      if (p === '/v1/refunds' && method === 'POST') {
        if (failRefund) return reply(400, { error: { message: 'Refund failed' } });
        const id = uid('re'); state.refunds.push({ id, form }); return reply(200, { id, amount: Number(form.get('amount')) });
      }
      if (p === '/v1/transfers' && method === 'POST') {
        if (failTransfer) return reply(400, { error: { message: 'Insufficient funds' } });
        const id = uid('tr'); state.transfers.push({ id, form }); return reply(200, { id });
      }
      if (/^\/v1\/transfers\/[^/]+\/reversals$/.test(p) && method === 'POST') return reply(200, { id: uid('trr') });
    }
    if (u.host === 'api.goshippo.com') {
      if (shippoDown) return reply(503, { detail: 'down' });
      if (u.pathname === '/shipments/' && method === 'POST') return reply(200, { object_id: 'shp_1', status: 'SUCCESS', rates: shippoRates });
      if (u.pathname === '/transactions' && method === 'POST') {
        const n = ++counter;
        return reply(200, { object_id: `txn_${n}`, status: 'SUCCESS', tracking_number: `9400${n}`, tracking_url_provider: `https://track.example/9400${n}`, label_url: `https://shippo-delivery-east.s3.amazonaws.com/label_${n}.pdf`, rate: json && json.rate });
      }
      const tm = /^\/tracks\/([^/]+)\/([^/]+)$/.exec(u.pathname);
      if (tm && method === 'GET') return reply(200, { tracking_number: tm[2], carrier: tm[1], tracking_status: { status: state.tracks.get(tm[2]) || 'TRANSIT' } });
    }
    if (u.host === 'api-m.sandbox.paypal.com') {
      const p = u.pathname;
      if (p === '/v1/oauth2/token') return reply(200, { access_token: 'pp_token' });
      if (p === '/v2/checkout/orders' && method === 'POST') { const id = uid('PPORDER'); state.paypalOrders.set(id, { json }); return reply(200, { id, links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] }); }
      const cm = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(p);
      if (cm) { const order = state.paypalOrders.get(cm[1]); if (!order || !order.approved) return reply(422, { message: 'Not approved' }); return reply(200, { status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: `CAP_${cm[1]}`, status: 'COMPLETED' }] } }] }); }
      if (/^\/v2\/payments\/captures\/[^/]+\/refund$/.test(p)) { state.paypalRefunds.push(json); return reply(200, { id: uid('PPREFUND') }); }
      if (p === '/v1/payments/payouts') { state.paypalPayouts.push(json); return reply(200, { batch_header: { payout_batch_id: uid('BATCH') } }); }
    }
    return reply(404, { error: { message: `unexpected ${method} ${url}` } });
  };
  state.paypalOrders = new Map();
  state.paypalRefunds = [];
  state.paypalPayouts = [];
  return {
    calls,
    state,
    find: (fn) => calls.filter(fn),
    /** The buyer completed payment on Stripe's page. */
    pay: (sessionId) => { state.sessions.get(sessionId).status = 'complete'; },
    /** The buyer approved on PayPal's page. */
    approve: (paypalOrderId) => { state.paypalOrders.get(paypalOrderId).approved = true; },
  };
}
