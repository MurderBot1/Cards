// PayPal (and Venmo) for the shop: a buyer can pay with PayPal or Venmo instead of a card, and sellers who chose Venmo or
// PayPal at registration are paid through PayPal Payouts. It is OFF until PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are set
// as Worker secrets (and PAYPAL_ENV is "live" only together with PAYMENTS_LIVE=true; the default is the sandbox). Built to
// PayPal's Orders v2 / Payments v2 / Payouts v1 APIs, but never run against PayPal itself yet: test it in the sandbox first.
import { dollars } from './money.js';

const SANDBOX = 'https://api-m.sandbox.paypal.com';
const LIVE = 'https://api-m.paypal.com';

export function paypalConfig(env) {
  const id = env && typeof env.PAYPAL_CLIENT_ID === 'string' ? env.PAYPAL_CLIENT_ID.trim() : '';
  const secret = env && typeof env.PAYPAL_CLIENT_SECRET === 'string' ? env.PAYPAL_CLIENT_SECRET.trim() : '';
  if (!id || !secret) return { configured: false, test: true, problem: 'PayPal is not set up yet' };
  const live = String(env.PAYPAL_ENV || '').toLowerCase() === 'live';
  if (live && env.PAYMENTS_LIVE !== 'true') return { configured: false, test: false, problem: 'PayPal is set to live but live payments are not switched on (PAYMENTS_LIVE)' };
  return { configured: true, test: !live, problem: '', base: live ? LIVE : SANDBOX };
}

function failure(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function accessToken(env, config) {
  let res;
  try {
    res = await fetch(`${config.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`${env.PAYPAL_CLIENT_ID.trim()}:${env.PAYPAL_CLIENT_SECRET.trim()}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
  } catch {
    throw failure("Couldn't reach PayPal, try again in a moment", 502);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.access_token) throw failure('PayPal did not accept the Worker credentials', 502);
  return data.access_token;
}

/** Calls PayPal. Throws an Error with `.status` and a message that is safe to show. */
export async function paypalCall(env, method, path, body = null, { requestId } = {}) {
  const config = paypalConfig(env);
  if (!config.configured) throw failure(`Payments aren't available yet: ${config.problem}`, 503);
  const token = await accessToken(env, config);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  let res;
  try {
    res = await fetch(`${config.base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw failure("Couldn't reach PayPal, try again in a moment", 502);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw failure((data && (data.message || (data.details && data.details[0] && data.details[0].description))) || `PayPal answered ${res.status}`, res.status >= 500 ? 502 : 400);
  return data;
}

const money = (cents) => ({ currency_code: 'USD', value: dollars(cents) });

/** An order the buyer approves on PayPal's own page: returns { id, url }. */
export async function createPayPalOrder(env, { orderId, itemsCents, shippingCents, shipTo, returnUrl, cancelUrl }) {
  const data = await paypalCall(
    env,
    'POST',
    '/v2/checkout/orders',
    {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: orderId,
          custom_id: orderId,
          invoice_id: orderId,
          amount: { ...money(itemsCents + shippingCents), breakdown: { item_total: money(itemsCents), shipping: money(shippingCents) } },
          shipping: {
            name: { full_name: shipTo.name },
            address: { address_line_1: shipTo.line1, address_line_2: shipTo.line2 || undefined, admin_area_2: shipTo.city, admin_area_1: shipTo.region, postal_code: shipTo.postal, country_code: shipTo.country },
          },
        },
      ],
      payment_source: { paypal: { experience_context: { brand_name: 'Binder', user_action: 'PAY_NOW', shipping_preference: 'SET_PROVIDED_ADDRESS', return_url: returnUrl, cancel_url: cancelUrl } } },
    },
    { requestId: `binder-order-${orderId}` }
  );
  const link = (data.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  if (!data.id || !link) throw failure('PayPal did not return a payment page', 502);
  return { id: data.id, url: link.href };
}

/** Takes the money once the buyer approved: returns { completed, captureId }. */
export async function capturePayPalOrder(env, paypalOrderId, orderId) {
  const data = await paypalCall(env, 'POST', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {}, { requestId: `binder-capture-${orderId}` });
  const capture = data.purchase_units && data.purchase_units[0] && data.purchase_units[0].payments && data.purchase_units[0].payments.captures && data.purchase_units[0].payments.captures[0];
  return { completed: data.status === 'COMPLETED' && !!capture && capture.status === 'COMPLETED', captureId: capture ? capture.id : '' };
}

export async function refundPayPalCapture(env, captureId, cents, requestId) {
  return paypalCall(env, 'POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, { amount: money(cents) }, { requestId });
}

/** Pays a seller's Venmo (by phone) or PayPal (by email) through Payouts. */
export async function payoutToSeller(env, { groupId, kind, ref, cents, note }) {
  const venmo = kind === 'venmo';
  const data = await paypalCall(
    env,
    'POST',
    '/v1/payments/payouts',
    {
      sender_batch_header: { sender_batch_id: `binder-${groupId}`, email_subject: 'You have a payment from Binder', recipient_type: venmo ? 'PHONE' : 'EMAIL' },
      items: [{ amount: { value: dollars(cents), currency: 'USD' }, receiver: ref, note: note || 'Binder sale', sender_item_id: groupId, ...(venmo ? { recipient_wallet: 'VENMO' } : {}) }],
    },
    { requestId: `binder-payout-${groupId}` }
  );
  return (data.batch_header && data.batch_header.payout_batch_id) || '';
}
