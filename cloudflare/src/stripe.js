// A very small Stripe client for the Worker: server side only, with the secret key from the Worker's secrets
// (`wrangler secret put STRIPE_SECRET_KEY`). Card details never come near this code: buyers type them into Stripe's own
// fields and sellers give their bank or debit card to Stripe's own onboarding pages; we only hold Stripe's ids.
//
// Test mode first: a live key (sk_live_ / rk_live_) is refused unless the owner has also set PAYMENTS_LIVE to "true".

const API = 'https://api.stripe.com/v1';

/** { configured, test, problem }: whether payments with Stripe are on, and why not. */
export function stripeConfig(env) {
  const key = env && typeof env.STRIPE_SECRET_KEY === 'string' ? env.STRIPE_SECRET_KEY.trim() : '';
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(key)) return { configured: false, test: true, problem: 'Stripe is not set up yet' };
  const live = /^(sk|rk)_live_/.test(key);
  if (live && env.PAYMENTS_LIVE !== 'true') {
    return { configured: false, test: false, problem: 'A live Stripe key is set but live payments are not switched on (PAYMENTS_LIVE)' };
  }
  return { configured: true, test: !live, problem: '' };
}

// Stripe takes form-encoded bodies with nested keys: { a: { b: 1 }, c: [1, 2] } -> a[b]=1&c[0]=1&c[1]=2
export function encodeForm(params, prefix = '', out = []) {
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) value.forEach((v, i) => (typeof v === 'object' && v !== null ? encodeForm(v, `${name}[${i}]`, out) : out.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(v)}`)));
    else if (typeof value === 'object') encodeForm(value, name, out);
    else out.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  }
  return out.join('&');
}

/**
 * Calls Stripe. Throws an Error with `.status` (Stripe's HTTP status, or 503 when payments are off) and a message that is safe
 * to show a person; the secret key and the request body are never put in it.
 */
export async function stripeCall(env, method, path, params = null, { idempotencyKey } = {}) {
  const config = stripeConfig(env);
  if (!config.configured) {
    const err = new Error(`Payments aren't available yet: ${config.problem}`);
    err.status = 503;
    throw err;
  }
  const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY.trim()}` };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let body;
  if (params && method !== 'GET') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = encodeForm(params);
  }
  let res;
  try {
    res = await fetch(`${API}${path}`, { method, headers, body });
  } catch {
    const err = new Error("Couldn't reach Stripe, try again in a moment");
    err.status = 502;
    throw err;
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || `Stripe answered ${res.status}`);
    err.status = res.status >= 500 ? 502 : 400;
    err.stripeStatus = res.status;
    throw err;
  }
  return data;
}
