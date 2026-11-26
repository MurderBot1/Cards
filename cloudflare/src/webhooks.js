// Messages the outside world sends us, so the shop stays right even when nobody has the app open.
//   POST /api/stripe/webhook?   Stripe: payments completing or expiring, refunds made in the Stripe dashboard, disputes.
//                               Signed: STRIPE_WEBHOOK_SECRET (the endpoint's "signing secret", whsec_...) is required.
//   POST /api/shippo/webhook?token=...   Shippo: tracking updates ("delivered" pays the seller). SHIPPO_WEBHOOK_TOKEN is the
//                               ?token= added to the URL in Shippo's webhook settings.
// Everything is safe to receive twice: Stripe retries, and the buyer's return to the app may have got there first.
import { json } from './lib.js';
import { nowSeconds } from './money.js';
import { applyTracking, syncOrder } from './orders.js';

const encoder = new TextEncoder();

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Checks a Stripe-Signature header ("t=...,v1=...") against the raw body. Messages older than 5 minutes are refused. */
export async function verifyStripeSignature(rawBody, header, secret, toleranceSeconds = 300, nowS = nowSeconds()) {
  if (!secret || !header) return false;
  const parts = String(header).split(',').map((p) => p.trim().split('='));
  const t = (parts.find(([k]) => k === 't') || [])[1];
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !/^\d+$/.test(t) || !signatures.length) return false;
  if (Math.abs(nowS - Number(t)) > toleranceSeconds) return false;
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  return signatures.some((s) => safeEqual(s, expected));
}

async function seen(db, id) {
  return !!(await db.prepare('SELECT id FROM webhook_events WHERE id = ?').bind(id).first());
}
async function remember(db, id, source, type) {
  await db.prepare('INSERT OR IGNORE INTO webhook_events (id, source, type, at) VALUES (?, ?, ?, ?)').bind(id, source, type, nowSeconds()).run();
}

async function orderForPayment(db, paymentIntent) {
  return paymentIntent ? db.prepare('SELECT * FROM orders WHERE payment_ref = ?').bind(paymentIntent).first() : null;
}

export async function onStripeWebhook({ request, env }) {
  const raw = await request.text();
  if (!(await verifyStripeSignature(raw, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) return json({ error: 'Bad signature' }, 400);
  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: 'Bad body' }, 400); }
  if (!event || typeof event.id !== 'string' || !event.data || !event.data.object) return json({ ok: true });
  if (await seen(env.DB, event.id)) return json({ ok: true, duplicate: true });
  const obj = event.data.object;
  const at = nowSeconds();

  if (event.type.startsWith('checkout.session.')) {
    const orderId = (obj.metadata && obj.metadata.order_id) || obj.client_reference_id;
    const order = orderId ? await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first() : null;
    if (order) await syncOrder(env, order);   // asks Stripe itself, so a forged or stale body can change nothing
  } else if (event.type === 'charge.refunded') {
    const order = await orderForPayment(env.DB, obj.payment_intent);
    if (order && obj.refunded === true && order.status === 'paid') {
      // refunded in full from the Stripe dashboard: every part that was not already refunded is settled as refunded
      const open = (await env.DB.prepare("SELECT id, status, items_cents, shipping_cents, refunded_cents FROM order_groups WHERE order_id = ? AND status NOT IN ('refunded', 'cancelled')").bind(order.id).all()).results;
      for (const g of open) {
        await env.DB.prepare("UPDATE order_groups SET status = 'refunded', refunded_cents = ?, updated_at = ? WHERE id = ?").bind(g.items_cents + g.shipping_cents, at, g.id).run();
        if (g.status === 'awaiting_shipment') {
          const lines = (await env.DB.prepare('SELECT listing_id, qty FROM order_lines WHERE group_id = ?').bind(g.id).all()).results;
          for (const l of lines) await env.DB.prepare('UPDATE listings SET quantity = quantity + ? WHERE id = ?').bind(l.qty, l.listing_id).run();
        }
      }
      await env.DB.prepare("UPDATE orders SET status = 'refunded', updated_at = ? WHERE id = ?").bind(at, order.id).run();
    }
  } else if (event.type === 'charge.dispute.created') {
    const order = await orderForPayment(env.DB, obj.payment_intent);
    if (order) {
      await env.DB.prepare("UPDATE orders SET flag = 'disputed', updated_at = ? WHERE id = ?").bind(at, order.id).run();
      await env.DB.prepare("UPDATE order_groups SET hold = 1 WHERE order_id = ? AND status IN ('awaiting_shipment', 'shipped', 'delivered')").bind(order.id).run();
    }
  }
  await remember(env.DB, event.id, 'stripe', event.type);
  return json({ ok: true });
}

export async function onShippoWebhook({ request, env }) {
  const token = new URL(request.url).searchParams.get('token') || '';
  if (!env.SHIPPO_WEBHOOK_TOKEN || !safeEqual(token, String(env.SHIPPO_WEBHOOK_TOKEN))) return json({ error: 'Not allowed' }, 403);
  let event;
  try { event = await request.json(); } catch { return json({ error: 'Bad body' }, 400); }
  const data = event && event.data;
  if (!event || event.event !== 'track_updated' || !data || typeof data.tracking_number !== 'string') return json({ ok: true });
  const status = data.tracking_status && data.tracking_status.status;
  const group = await env.DB.prepare("SELECT * FROM order_groups WHERE tracking_number = ? AND status = 'shipped'").bind(data.tracking_number).first();
  if (group && typeof status === 'string') await applyTracking(env, group, status);
  return json({ ok: true });
}
