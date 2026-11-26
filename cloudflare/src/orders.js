// Orders: from a cart to money in a seller's hands.
//
//   buyer:   POST /api/shop/checkout/quote   { address? }                       -> what it would cost, by seller (shipping quoted)
//            POST /api/shop/checkout         { address?, provider? }            -> { orderId, url }   cards are reserved, pay on Stripe's page
//            POST /api/shop/orders/sync      { orderId, ... }                   -> { order }          after paying (or to check on it)
//            POST /api/shop/orders/abandon   { orderId }                        -> { ok }             came back without paying
//            GET  /api/shop/orders                                              -> { orders }
//            POST /api/shop/orders/cancel    { groupId }                        -> { ok }             before it ships: full refund
//            POST /api/shop/orders/received  { groupId }                        -> { ok }             "it arrived": pays the seller
//   seller:  GET  /api/shop/sales                                               -> { sales }          what to ship
//            POST /api/shop/sales/label     { groupId }                        -> { sale }           buy the label through Shippo
//            POST /api/shop/sales/ship      { groupId, carrier, trackingNumber } -> { sale }         tracking typed by hand
//            POST /api/shop/sales/refund    { groupId }                        -> { ok }
//
// The money: the buyer pays Binder (one Stripe payment for the whole cart; the card is typed on Stripe's page, with its own
// "save my payment info" box). Binder holds it, and when a seller's parcel is DELIVERED (the carrier says so, or the buyer taps
// "received", or 14 days pass on a hand-tracked order) it pays that seller the item price minus Binder's fee (and, when the seller
// posted it themselves, the shipping the buyer paid). A parcel that is never shipped is refunded after 10 days.
import { addressOf, buyerRow, saveAddress } from './buyer.js';
import { loadCart } from './cart.js';
import { fail, json, readJson, sessionUser } from './lib.js';
import { MANUAL_RELEASE_SECONDS, ORDER_HOLD_SECONDS, UNSHIPPED_REFUND_SECONDS, feeCents, feePercent, newId, nowSeconds } from './money.js';
import { capturePayPalOrder, createPayPalOrder, paypalConfig, payoutToSeller, refundPayPalCapture } from './paypal.js';
import { paymentsOut, sellerCanSell, sellerRow } from './seller.js';
import { buyLabel, quoteShipping, registerTracking, shippoCarrierToken, trackingLink, trackingStatus } from './shipping.js';
import { cleanShipTo, cleanTracking } from './shopInput.js';
import { stripeCall, stripeConfig } from './stripe.js';

const origin = (request) => new URL(request.url).origin;

// ---- pricing a cart -------------------------------------------------------------------------------------------------------

/**
 * Turns the buyer's cart into one group per seller with shipping quoted: { address, groups, itemsCents, shippingCents,
 * totalCents, problems }. `problems` are things that stop checkout (sold out, a seller who can't be paid right now).
 */
async function priceCart(env, user, body) {
  const buyer = await buyerRow(env.DB, user.id);
  let address;
  if (body && body.address) {
    const checked = cleanShipTo(body.address);
    if (checked.error) return { error: checked.error, status: 400 };
    address = checked.address;
  } else {
    address = addressOf(buyer);
  }
  if (!address) return { error: 'Add your shipping address first', status: 400 };
  const lines = await loadCart(env.DB, user.id);
  if (!lines.length) return { error: 'Your cart is empty', status: 400 };

  const problems = [];
  const bySeller = new Map();
  for (const l of lines) {
    const name = l.listing ? l.listing.name : 'A card';
    if (!l.listing || l.available <= 0) { problems.push(`${name} is no longer for sale: remove it from your cart`); continue; }
    if (l.qty > l.available) { problems.push(`Only ${l.available} of ${name} left (you have ${l.qty} in your cart)`); continue; }
    const g = bySeller.get(l.sellerId) || { sellerId: l.sellerId, seller: l.listing.seller, lines: [], itemsCents: 0, cardCount: 0 };
    g.lines.push({ listing: l.listing, qty: l.qty });
    g.itemsCents += l.qty * l.listing.priceCents;
    g.cardCount += l.qty;
    bySeller.set(l.sellerId, g);
  }
  const groups = [...bySeller.values()];
  await Promise.all(
    groups.map(async (g) => {
      g.row = await sellerRow(env.DB, g.sellerId);
      const can = await sellerCanSell(env, g.row);
      if (!can.ok) { problems.push(`${g.seller} can't take orders right now`); g.blocked = true; return; }
      g.shipping = await quoteShipping(env, { seller: g.row, to: address, cardCount: g.cardCount });
    })
  );
  const ok = groups.filter((g) => !g.blocked);
  const itemsCents = ok.reduce((n, g) => n + g.itemsCents, 0);
  const shippingCents = ok.reduce((n, g) => n + g.shipping.cents, 0);
  return { address, buyer, groups, itemsCents, shippingCents, totalCents: itemsCents + shippingCents, problems };
}

const quoteOut = (priced) => ({
  address: priced.address,
  groups: priced.groups.map((g) => ({
    seller: g.seller, itemsCents: g.itemsCents, cardCount: g.cardCount,
    shippingCents: g.shipping ? g.shipping.cents : 0, shippingService: g.shipping ? g.shipping.service : '', shippingMode: g.shipping ? g.shipping.mode : '',
    lines: g.lines.map((l) => ({ name: l.listing.name, qty: l.qty, priceCents: l.listing.priceCents })),
  })),
  itemsCents: priced.itemsCents, shippingCents: priced.shippingCents, totalCents: priced.totalCents, problems: priced.problems,
});

export async function onQuote({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Sign in to check out', 401);
  const priced = await priceCart(env, user, (await readJson(request)) || {});
  if (priced.error) return fail(priced.error, priced.status);
  return json({ ...quoteOut(priced), payments: paymentsOut(env) });
}

// ---- checkout -------------------------------------------------------------------------------------------------------------

async function restoreStock(db, orderId) {
  const lines = await db.prepare('SELECT listing_id, qty FROM order_lines WHERE order_id = ?').bind(orderId).all();
  for (const l of lines.results) await db.prepare('UPDATE listings SET quantity = quantity + ?, updated_at = ? WHERE id = ?').bind(l.qty, nowSeconds(), l.listing_id).run();
}

/** Gives up on an unpaid order: its cards go back on sale. True when this call cancelled it. */
export async function cancelOrder(env, orderId, flag) {
  const res = await env.DB.prepare("UPDATE orders SET status = 'cancelled', flag = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(flag || '', nowSeconds(), orderId).run();
  if (res.meta.changes !== 1) return false;
  await env.DB.prepare("UPDATE order_groups SET status = 'cancelled', updated_at = ? WHERE order_id = ?").bind(nowSeconds(), orderId).run();
  await restoreStock(env.DB, orderId);
  return true;
}

async function stripeCustomer(env, user, buyer) {
  if (buyer && buyer.stripe_customer) return buyer.stripe_customer;
  const mine = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(user.id).first();
  const created = await stripeCall(env, 'POST', '/v1/customers', { email: mine ? mine.email : undefined, name: user.username, metadata: { binder_user: String(user.id) } }, { idempotencyKey: `binder-customer-${user.id}` });
  await env.DB.prepare('UPDATE buyers SET stripe_customer = ? WHERE user_id = ?').bind(created.id, user.id).run();
  return created.id;
}

const lineName = (l) => `${l.name}${l.set || l.set_code ? ` (${l.set || l.set_code}${l.number ? ` ${l.number}` : ''})` : ''} - ${l.condition}${l.foil ? ' - Foil' : ''}`.slice(0, 240);

export async function onCheckout({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Sign in to check out', 401);
  const body = (await readJson(request)) || {};
  const provider = body.provider === 'paypal' ? 'paypal' : 'stripe';
  if (provider === 'stripe' && !stripeConfig(env).configured) return fail(`Payments aren't available yet: ${stripeConfig(env).problem}`, 503);
  if (provider === 'paypal' && !paypalConfig(env).configured) return fail(`Payments aren't available yet: ${paypalConfig(env).problem}`, 503);

  const priced = await priceCart(env, user, body);
  if (priced.error) return fail(priced.error, priced.status);
  if (priced.problems.length) return fail(priced.problems[0], 409);
  if (provider === 'paypal' && priced.groups.some((g) => g.row.payout_kind === 'stripe')) {
    return fail('PayPal payments can only buy from sellers who are paid through PayPal or Venmo: pay by card instead', 409);
  }
  const { address, groups } = priced;
  if (body.address) await saveAddress(env.DB, user.id, address);  // the address used is remembered for next time

  // reserve the cards: each one comes off the listing now, and goes back if the order is not paid
  const at = nowSeconds();
  const orderId = newId('ord_');
  const reserved = [];
  for (const g of groups) {
    for (const l of g.lines) {
      const res = await env.DB.prepare("UPDATE listings SET quantity = quantity - ?, updated_at = ? WHERE id = ? AND status = 'active' AND quantity >= ?").bind(l.qty, at, l.listing.id, l.qty).run();
      if (res.meta.changes !== 1) {
        for (const r of reserved) await env.DB.prepare('UPDATE listings SET quantity = quantity + ? WHERE id = ?').bind(r.qty, r.listing.id).run();
        return fail(`Someone just bought ${l.listing.name}: check your cart`, 409);
      }
      reserved.push(l);
    }
  }
  const percent = feePercent(env);
  const statements = [
    env.DB
      .prepare("INSERT INTO orders (id, buyer_id, status, provider, items_cents, shipping_cents, total_cents, ship_name, ship_phone, ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country, created_at, updated_at, expires_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(orderId, user.id, provider, priced.itemsCents, priced.shippingCents, priced.totalCents, address.name, address.phone, address.line1, address.line2, address.city, address.region, address.postal, address.country, at, at, at + ORDER_HOLD_SECONDS),
  ];
  for (const g of groups) {
    g.id = newId('grp_');
    statements.push(
      env.DB
        .prepare("INSERT INTO order_groups (id, order_id, seller_id, status, items_cents, shipping_cents, fee_cents, card_count, ship_mode, ship_service, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(g.id, orderId, g.sellerId, g.itemsCents, g.shipping.cents, feeCents(g.itemsCents, percent), g.cardCount, g.shipping.mode, g.shipping.service, at, at)
    );
    for (const l of g.lines) {
      statements.push(
        env.DB
          .prepare('INSERT INTO order_lines (id, order_id, group_id, listing_id, name, set_code, number, image, condition, foil, language, qty, price_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(newId('lin_'), orderId, g.id, l.listing.id, l.listing.name, l.listing.set, l.listing.number, l.listing.image, l.listing.condition, l.listing.foil ? 1 : 0, l.listing.language, l.qty, l.listing.priceCents)
      );
    }
  }
  await env.DB.batch(statements);

  try {
    const base = origin(request);
    let session;
    if (provider === 'stripe') {
      const customer = await stripeCustomer(env, user, await buyerRow(env.DB, user.id));
      const items = [];
      for (const g of groups) {
        for (const l of g.lines) {
          items.push({ quantity: l.qty, price_data: { currency: 'usd', unit_amount: l.listing.priceCents, product_data: { name: lineName(l.listing), description: `Sold by ${g.seller}` } } });
        }
        if (g.shipping.cents > 0) items.push({ quantity: 1, price_data: { currency: 'usd', unit_amount: g.shipping.cents, product_data: { name: `Shipping from ${g.seller}`, description: g.shipping.service } } });
      }
      const created = await stripeCall(
        env,
        'POST',
        '/v1/checkout/sessions',
        {
          mode: 'payment',
          customer,
          line_items: items,
          // Stripe's own "save my payment info" box, so a buyer chooses on the payment page whether to keep the card
          saved_payment_method_options: { payment_method_save: 'enabled' },
          client_reference_id: orderId,
          metadata: { order_id: orderId },
          payment_intent_data: {
            transfer_group: orderId,
            metadata: { order_id: orderId },
            shipping: { name: address.name, phone: address.phone || undefined, address: { line1: address.line1, line2: address.line2 || undefined, city: address.city, state: address.region, postal_code: address.postal, country: address.country } },
          },
          expires_at: at + 31 * 60,
          success_url: `${base}/?checkout=success&order=${orderId}&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${base}/?checkout=cancel&order=${orderId}`,
        },
        { idempotencyKey: `binder-order-${orderId}` }
      );
      session = { id: created.id, url: created.url };
    } else {
      session = await createPayPalOrder(env, { orderId, itemsCents: priced.itemsCents, shippingCents: priced.shippingCents, shipTo: address, returnUrl: `${base}/?checkout=success&order=${orderId}`, cancelUrl: `${base}/?checkout=cancel&order=${orderId}` });
    }
    await env.DB.prepare('UPDATE orders SET provider_ref = ?, checkout_url = ?, updated_at = ? WHERE id = ?').bind(session.id, session.url, nowSeconds(), orderId).run();
    return json({ orderId, url: session.url });
  } catch (err) {
    await cancelOrder(env, orderId, 'payment_setup_failed');
    return fail(err.message || 'The payment page could not be started', err.status || 502);
  }
}

// ---- paid, abandoned, expired ------------------------------------------------------------------------------------------------

async function orderRow(db, id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
}

/**
 * The money arrived. Moves a pending order to paid exactly once (a webhook and the buyer's return can both get here), clears the
 * bought lines from the buyer's cart, and refunds at once a payment that arrived after the order was given up on.
 */
export async function finalizePaid(env, order, { paymentRef, chargeRef }) {
  const at = nowSeconds();
  const res = await env.DB.prepare("UPDATE orders SET status = 'paid', paid_at = ?, payment_ref = ?, charge_ref = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(at, paymentRef || '', chargeRef || '', at, order.id).run();
  if (res.meta.changes === 1) {
    await env.DB.prepare("UPDATE order_groups SET status = 'awaiting_shipment', updated_at = ? WHERE order_id = ? AND status = 'pending'").bind(at, order.id).run();
    await env.DB.prepare('DELETE FROM cart_items WHERE user_id = ? AND listing_id IN (SELECT listing_id FROM order_lines WHERE order_id = ?)').bind(order.buyer_id, order.id).run();
    return 'paid';
  }
  const now = await orderRow(env.DB, order.id);
  if (now.status === 'cancelled') {
    // the buyer paid after the order was cancelled (the page was left open): give the money back
    await env.DB.prepare("UPDATE orders SET payment_ref = ?, charge_ref = ?, flag = 'late_payment_refunded' WHERE id = ?").bind(paymentRef || '', chargeRef || '', order.id).run();
    try { await refundMoney(env, { ...now, payment_ref: paymentRef || '', charge_ref: chargeRef || '' }, now.total_cents, `binder-late-${order.id}`, order.id); } catch { /* shows up as a flagged order */ }
    return 'refunded_late';
  }
  return 'already';
}

/** Looks at the payment provider and moves a pending order along. Returns the fresh order row. */
export async function syncOrder(env, order, { paypalApproved = false } = {}) {
  if (order.status !== 'pending' || !order.provider_ref) return order;
  try {
    if (order.provider === 'stripe') {
      const session = await stripeCall(env, 'GET', `/v1/checkout/sessions/${encodeURIComponent(order.provider_ref)}?expand[0]=payment_intent`);
      if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
        const pi = session.payment_intent && typeof session.payment_intent === 'object' ? session.payment_intent : { id: session.payment_intent };
        await finalizePaid(env, order, { paymentRef: pi.id, chargeRef: typeof pi.latest_charge === 'string' ? pi.latest_charge : (pi.latest_charge && pi.latest_charge.id) || '' });
      } else if (session.status === 'expired') {
        await cancelOrder(env, order.id, 'expired');
      }
    } else if (order.provider === 'paypal' && paypalApproved) {
      const captured = await capturePayPalOrder(env, order.provider_ref, order.id);
      if (captured.completed) await finalizePaid(env, order, { paymentRef: captured.captureId, chargeRef: captured.captureId });
    }
  } catch { /* the provider could not be asked just now: the order stays as it was and is looked at again later */ }
  return orderRow(env.DB, order.id);
}

async function ownOrder(env, user, orderId) {
  const order = typeof orderId === 'string' ? await orderRow(env.DB, orderId) : null;
  return order && order.buyer_id === user.id ? order : null;
}

export async function onSync({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const body = (await readJson(request)) || {};
  const order = await ownOrder(env, user, body.orderId);
  if (!order) return fail('That order was not found', 404);
  const fresh = await syncOrder(env, order, { paypalApproved: body.paypalApproved === true });
  return json({ order: (await ordersOut(env, [fresh]))[0] });
}

export async function onAbandon({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const body = (await readJson(request)) || {};
  const order = await ownOrder(env, user, body.orderId);
  if (!order) return fail('That order was not found', 404);
  const fresh = await syncOrder(env, order);       // maybe it was paid after all
  if (fresh.status === 'pending') {
    if (fresh.provider === 'stripe' && fresh.provider_ref) {
      try { await stripeCall(env, 'POST', `/v1/checkout/sessions/${encodeURIComponent(fresh.provider_ref)}/expire`, {}); } catch { /* already over */ }
    }
    await cancelOrder(env, fresh.id, 'abandoned');
  }
  return json({ ok: true, order: (await ordersOut(env, [await orderRow(env.DB, order.id)]))[0] });
}

// ---- reading orders -------------------------------------------------------------------------------------------------------

async function ordersOut(env, orders) {
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const marks = ids.map(() => '?').join(',');
  const groups = (await env.DB.prepare(`SELECT g.*, u.username FROM order_groups g JOIN users u ON u.id = g.seller_id WHERE g.order_id IN (${marks}) ORDER BY g.created_at`).bind(...ids).all()).results;
  const lines = (await env.DB.prepare(`SELECT * FROM order_lines WHERE order_id IN (${marks})`).bind(...ids).all()).results;
  const at = nowSeconds();
  return orders.map((o) => ({
    id: o.id, status: o.status, provider: o.provider, flag: o.flag,
    itemsCents: o.items_cents, shippingCents: o.shipping_cents, totalCents: o.total_cents,
    shipTo: { name: o.ship_name, line1: o.ship_line1, line2: o.ship_line2, city: o.ship_city, region: o.ship_region, postal: o.ship_postal, country: o.ship_country },
    createdAt: o.created_at, paidAt: o.paid_at,
    resumeUrl: o.status === 'pending' && o.expires_at > at ? o.checkout_url : '',
    groups: groups.filter((g) => g.order_id === o.id).map((g) => groupOut(g, lines.filter((l) => l.group_id === g.id), { forBuyer: true })),
  }));
}

function groupOut(g, lines, { forBuyer }) {
  return {
    id: g.id, seller: g.username, status: g.status, itemsCents: g.items_cents, shippingCents: g.shipping_cents, cardCount: g.card_count,
    shipMode: g.ship_mode, shipService: g.ship_service, carrier: g.carrier, trackingNumber: g.tracking_number,
    trackingUrl: g.tracking_url, labelUrl: forBuyer ? '' : g.label_url, trackingStatus: g.tracking_status, trackingMode: g.tracking_mode,
    shippedAt: g.shipped_at, deliveredAt: g.delivered_at, hold: !!g.hold, refundedCents: g.refunded_cents,
    payoutCents: g.status === 'paid_out' ? g.payout_cents : payoutFor(g), paidOutAt: g.paid_out_at,
    lines: lines.map((l) => ({ name: l.name, set: l.set_code, number: l.number, image: l.image, condition: l.condition, foil: !!l.foil, qty: l.qty, priceCents: l.price_cents })),
    canCancel: forBuyer && g.status === 'awaiting_shipment',
    canConfirm: forBuyer && g.status === 'shipped',
  };
}

/** What the seller gets for a group: the items minus Binder's fee, plus the shipping if the seller posted it themselves. */
export function payoutFor(g) {
  return Math.max(0, g.items_cents - g.fee_cents + (g.tracking_mode === 'manual' ? g.shipping_cents : 0));
}

export async function onOrders({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const rows = (await env.DB.prepare("SELECT * FROM orders WHERE buyer_id = ? AND (status != 'cancelled' OR flag != 'abandoned') ORDER BY created_at DESC LIMIT 50").bind(user.id).all()).results;
  const orders = await ordersOut(env, rows.filter((o) => o.status !== 'cancelled'));
  return json({ orders });
}

export async function onSales({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  return json({ sales: await salesFor(env, user.id) });
}

async function salesFor(env, sellerId, groupId) {
  const groups = (await env.DB
    .prepare(`SELECT g.*, u.username, o.ship_name, o.ship_phone, o.ship_line1, o.ship_line2, o.ship_city, o.ship_region, o.ship_postal, o.ship_country, o.paid_at, o.id AS oid FROM order_groups g JOIN orders o ON o.id = g.order_id JOIN users u ON u.id = o.buyer_id WHERE g.seller_id = ? AND g.status NOT IN ('pending', 'cancelled')${groupId ? ' AND g.id = ?' : ''} ORDER BY g.created_at DESC LIMIT 100`)
    .bind(...(groupId ? [sellerId, groupId] : [sellerId]))
    .all()).results;
  if (!groups.length) return [];
  const marks = groups.map(() => '?').join(',');
  const lines = (await env.DB.prepare(`SELECT * FROM order_lines WHERE group_id IN (${marks})`).bind(...groups.map((g) => g.id)).all()).results;
  return groups.map((g) => ({
    ...groupOut({ ...g, username: g.username }, lines.filter((l) => l.group_id === g.id), { forBuyer: false }),
    buyer: g.username,
    shipTo: { name: g.ship_name, phone: g.ship_phone, line1: g.ship_line1, line2: g.ship_line2, city: g.ship_city, region: g.ship_region, postal: g.ship_postal, country: g.ship_country },
    orderId: g.oid, paidAt: g.paid_at, canShip: g.status === 'awaiting_shipment', canRefund: ['awaiting_shipment', 'shipped', 'delivered', 'paid_out'].includes(g.status) && g.refunded_cents === 0,
  }));
}

// ---- refunds --------------------------------------------------------------------------------------------------------------

async function refundMoney(env, order, cents, key, groupId) {
  if (order.provider === 'paypal') return refundPayPalCapture(env, order.charge_ref, cents, key);
  return stripeCall(env, 'POST', '/v1/refunds', { payment_intent: order.payment_ref, amount: cents, reason: 'requested_by_customer', metadata: { order_id: order.id, group_id: groupId || '' } }, { idempotencyKey: key });
}

/**
 * Refunds one seller's part of an order to the buyer (the items and the shipping). If the seller was already paid, that transfer is
 * reversed first. Cards that never shipped go back on sale. Returns { ok } or { error }.
 */
export async function refundGroup(env, group, { reason }) {
  const order = await orderRow(env.DB, group.order_id);
  if (!order || order.status !== 'paid') return { error: 'That order has not been paid' };
  if (['refunded', 'cancelled', 'pending'].includes(group.status)) return { error: 'That part of the order is already settled' };
  const cents = group.items_cents + group.shipping_cents - group.refunded_cents;
  if (cents <= 0) return { error: 'There is nothing left to refund' };
  try {
    if (group.status === 'paid_out') {
      if (!group.payout_ref.startsWith('tr_')) return { error: "This seller was already paid through PayPal and that can't be taken back: contact them" };
      await stripeCall(env, 'POST', `/v1/transfers/${encodeURIComponent(group.payout_ref)}/reversals`, { amount: group.payout_cents, metadata: { group_id: group.id, reason } }, { idempotencyKey: `binder-reverse-${group.id}` });
    }
    await refundMoney(env, order, cents, `binder-refund-${group.id}`, group.id);
  } catch (err) {
    return { error: err.message || "The refund didn't go through" };
  }
  const at = nowSeconds();
  await env.DB.prepare("UPDATE order_groups SET status = 'refunded', refunded_cents = ?, hold = 0, updated_at = ? WHERE id = ?").bind(cents, at, group.id).run();
  if (group.status === 'awaiting_shipment') {
    const lines = await env.DB.prepare('SELECT listing_id, qty FROM order_lines WHERE group_id = ?').bind(group.id).all();
    for (const l of lines.results) await env.DB.prepare('UPDATE listings SET quantity = quantity + ?, updated_at = ? WHERE id = ?').bind(l.qty, at, l.listing_id).run();
  }
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM order_groups WHERE order_id = ? AND status NOT IN ('refunded', 'cancelled')").bind(order.id).first();
  if (open.n === 0) await env.DB.prepare("UPDATE orders SET status = 'refunded', updated_at = ? WHERE id = ?").bind(at, order.id).run();
  return { ok: true };
}

async function myGroup(env, groupId, column, userId) {
  const g = typeof groupId === 'string' ? await env.DB.prepare('SELECT * FROM order_groups WHERE id = ?').bind(groupId).first() : null;
  if (!g) return null;
  if (column === 'seller') return g.seller_id === userId ? g : null;
  const order = await orderRow(env.DB, g.order_id);
  return order && order.buyer_id === userId ? g : null;
}

export async function onBuyerCancel({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const group = await myGroup(env, ((await readJson(request)) || {}).groupId, 'buyer', user.id);
  if (!group) return fail('That order was not found', 404);
  if (group.status !== 'awaiting_shipment') return fail("It has already shipped, so it can't be cancelled: ask the seller for a refund", 409);
  const done = await refundGroup(env, group, { reason: 'buyer_cancelled' });
  return done.error ? fail(done.error, 502) : json({ ok: true });
}

export async function onSellerRefund({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const group = await myGroup(env, ((await readJson(request)) || {}).groupId, 'seller', user.id);
  if (!group) return fail('That sale was not found', 404);
  const done = await refundGroup(env, group, { reason: 'seller_refunded' });
  return done.error ? fail(done.error, 409) : json({ ok: true });
}

// ---- shipping and delivery ----------------------------------------------------------------------------------------------

async function shippedGroup(env, groupId) {
  return env.DB.prepare(`SELECT g.*, o.ship_name, o.ship_phone, o.ship_line1, o.ship_line2, o.ship_city, o.ship_region, o.ship_postal, o.ship_country FROM order_groups g JOIN orders o ON o.id = g.order_id WHERE g.id = ?`).bind(groupId).first();
}

export async function onLabel({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const group = await myGroup(env, ((await readJson(request)) || {}).groupId, 'seller', user.id);
  if (!group) return fail('That sale was not found', 404);
  // claim it first, so a double tap can't buy two labels
  const claim = await env.DB.prepare("UPDATE order_groups SET tracking_mode = 'buying', updated_at = ? WHERE id = ? AND status = 'awaiting_shipment' AND tracking_mode = ''").bind(nowSeconds(), group.id).run();
  if (claim.meta.changes !== 1) return fail('That order is not waiting to be shipped', 409);
  try {
    const full = await shippedGroup(env, group.id);
    const label = await buyLabel(env, {
      seller: await sellerRow(env.DB, user.id),
      to: { name: full.ship_name, phone: full.ship_phone, line1: full.ship_line1, line2: full.ship_line2, city: full.ship_city, region: full.ship_region, postal: full.ship_postal, country: full.ship_country },
      cardCount: group.card_count,
      metadata: group.id,
    });
    const at = nowSeconds();
    await env.DB
      .prepare("UPDATE order_groups SET status = 'shipped', tracking_mode = 'shippo', carrier = ?, tracking_number = ?, tracking_url = ?, label_url = ?, label_cost_cents = ?, ship_service = ?, shipped_at = ?, tracking_status = 'PRE_TRANSIT', updated_at = ? WHERE id = ?")
      .bind(label.carrier, label.trackingNumber, label.trackingUrl || trackingLink(label.carrier, label.trackingNumber), label.labelUrl, label.labelCostCents, label.service, at, at, group.id)
      .run();
  } catch (err) {
    await env.DB.prepare("UPDATE order_groups SET tracking_mode = '' WHERE id = ? AND tracking_mode = 'buying'").bind(group.id).run();
    return fail(err.message || "The label couldn't be bought", 502);
  }
  return json({ sale: (await salesFor(env, user.id, group.id))[0] });
}

export async function onShip({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const body = (await readJson(request)) || {};
  const group = await myGroup(env, body.groupId, 'seller', user.id);
  if (!group) return fail('That sale was not found', 404);
  const checked = cleanTracking(body);
  if (checked.error) return fail(checked.error, 400);
  const { carrier, trackingNumber } = checked.tracking;
  const at = nowSeconds();
  const res = await env.DB
    .prepare("UPDATE order_groups SET status = 'shipped', tracking_mode = 'manual', carrier = ?, tracking_number = ?, tracking_url = ?, shipped_at = ?, release_at = ?, tracking_status = 'PRE_TRANSIT', updated_at = ? WHERE id = ? AND status = 'awaiting_shipment' AND tracking_mode = ''")
    .bind(carrier, trackingNumber, trackingLink(carrier, trackingNumber), at, at + MANUAL_RELEASE_SECONDS, at, group.id)
    .run();
  if (res.meta.changes !== 1) return fail('That order is not waiting to be shipped', 409);
  await registerTracking(env, carrier, trackingNumber, group.id);   // if Shippo follows that carrier it will tell us when it is delivered
  return json({ sale: (await salesFor(env, user.id, group.id))[0] });
}

/** A parcel arrived. Marks it delivered and pays the seller. */
export async function markDelivered(env, group, source) {
  const at = nowSeconds();
  const res = await env.DB.prepare("UPDATE order_groups SET status = 'delivered', delivered_at = ?, tracking_status = 'DELIVERED', updated_at = ? WHERE id = ? AND status = 'shipped'").bind(at, at, group.id).run();
  if (res.meta.changes !== 1) return { changed: false };
  const paid = await releasePayout(env, group.id);
  return { changed: true, source, ...paid };
}

export async function onReceived({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const group = await myGroup(env, ((await readJson(request)) || {}).groupId, 'buyer', user.id);
  if (!group) return fail('That order was not found', 404);
  if (group.status !== 'shipped') return fail('That order has not shipped yet', 409);
  await markDelivered(env, group, 'buyer');
  return json({ ok: true });
}

/** Pays the seller for a delivered group. Safe to call again: a payment that went through is never repeated. */
export async function releasePayout(env, groupId) {
  const group = await env.DB.prepare('SELECT g.*, o.charge_ref, o.payment_ref, o.provider, o.flag, o.id AS oid FROM order_groups g JOIN orders o ON o.id = g.order_id WHERE g.id = ?').bind(groupId).first();
  if (!group || group.status !== 'delivered') return { paid: false };
  if (group.hold || group.flag === 'disputed') return { paid: false, reason: 'on hold' };
  const seller = await sellerRow(env.DB, group.seller_id);
  const cents = payoutFor(group);
  let ref = 'none';
  try {
    if (cents > 0) {
      if (!seller) throw new Error('The seller profile is gone');
      if (seller.payout_kind === 'stripe') {
        if (!seller.stripe_account) throw new Error('The seller has no Stripe account');
        const transfer = await stripeCall(env, 'POST', '/v1/transfers', { amount: cents, currency: 'usd', destination: seller.stripe_account, transfer_group: group.oid, source_transaction: group.provider === 'stripe' && group.charge_ref ? group.charge_ref : undefined, metadata: { order_id: group.oid, group_id: group.id } }, { idempotencyKey: `binder-payout-${group.id}` });
        ref = transfer.id;
      } else {
        ref = (await payoutToSeller(env, { groupId: group.id, kind: seller.payout_kind, ref: seller.payout_ref, cents, note: 'Binder sale' })) || 'paypal';
      }
    }
  } catch (err) {
    return { paid: false, reason: err.message || 'payout failed' };
  }
  await env.DB.prepare("UPDATE order_groups SET status = 'paid_out', payout_cents = ?, payout_ref = ?, paid_out_at = ?, updated_at = ? WHERE id = ? AND status = 'delivered'").bind(cents, ref, nowSeconds(), nowSeconds(), group.id).run();
  return { paid: true, cents };
}

/** A carrier update for a shipped group: delivered pays the seller; a parcel coming back puts the payout on hold. */
export async function applyTracking(env, group, status) {
  if (!status) return { changed: false };
  await env.DB.prepare('UPDATE order_groups SET tracking_status = ?, updated_at = ? WHERE id = ? AND status = ?').bind(status, nowSeconds(), group.id, group.status).run();
  if (status === 'DELIVERED') return markDelivered(env, group, 'tracking');
  if ((status === 'RETURNED' || status === 'FAILURE') && group.status === 'shipped') {
    await env.DB.prepare('UPDATE order_groups SET hold = 1 WHERE id = ?').bind(group.id).run();
    return { changed: true, held: true };
  }
  return { changed: false };
}

// ---- the hourly sweep -------------------------------------------------------------------------------------------------------

/** Everything that happens on a clock: expiring unpaid orders, refunding unshipped ones, auto-pay of hand-tracked orders, tracking polls, payout retries. */
export async function runMaintenance(env) {
  const at = nowSeconds();
  const report = { expired: 0, autoRefunded: 0, autoReleased: 0, polled: 0, retried: 0 };
  const stale = (await env.DB.prepare("SELECT * FROM orders WHERE status = 'pending' AND expires_at < ? LIMIT 50").bind(at).all()).results;
  for (const order of stale) {
    const fresh = await syncOrder(env, order);
    if (fresh.status === 'pending') {
      if (fresh.provider === 'stripe' && fresh.provider_ref) { try { await stripeCall(env, 'POST', `/v1/checkout/sessions/${encodeURIComponent(fresh.provider_ref)}/expire`, {}); } catch { /* already over */ } }
      if (await cancelOrder(env, fresh.id, 'expired')) report.expired++;
    }
  }
  const unshipped = (await env.DB.prepare("SELECT g.* FROM order_groups g JOIN orders o ON o.id = g.order_id WHERE g.status = 'awaiting_shipment' AND o.paid_at < ? LIMIT 25").bind(at - UNSHIPPED_REFUND_SECONDS).all()).results;
  for (const g of unshipped) if ((await refundGroup(env, g, { reason: 'seller_never_shipped' })).ok) report.autoRefunded++;
  const overdue = (await env.DB.prepare("SELECT * FROM order_groups WHERE status = 'shipped' AND release_at IS NOT NULL AND release_at < ? AND hold = 0 LIMIT 25").bind(at).all()).results;
  for (const g of overdue) if ((await markDelivered(env, g, 'timeout')).changed) report.autoReleased++;
  const followed = (await env.DB.prepare("SELECT * FROM order_groups WHERE status = 'shipped' AND tracking_number != '' AND last_polled < ? ORDER BY last_polled LIMIT 20").bind(at - 3 * 3600).all()).results;
  for (const g of followed) {
    await env.DB.prepare('UPDATE order_groups SET last_polled = ? WHERE id = ?').bind(at, g.id).run();
    const token = g.tracking_mode === 'shippo' ? g.carrier : shippoCarrierToken(g.carrier);
    if (!token) continue;
    await applyTracking(env, g, await trackingStatus(env, token, g.tracking_number));
    report.polled++;
  }
  const unpaid = (await env.DB.prepare("SELECT id FROM order_groups WHERE status = 'delivered' AND hold = 0 LIMIT 25").all()).results;
  for (const g of unpaid) if ((await releasePayout(env, g.id)).paid) report.retried++;
  return report;
}
