// A buyer's saved details: the address orders are sent to, and the cards they chose to save on Stripe.
//   GET  /api/shop/buyer                     -> { address: null | {...}, methods: [{ id, brand, last4, expMonth, expYear }], payments }
//   POST /api/shop/buyer                     { address } -> the same as GET        save the shipping address
//   POST /api/shop/buyer/address/remove      -> the same as GET        forget the saved shipping address
//   POST /api/shop/buyer/method/remove       { id } -> the same as GET             forget a saved card
// Only Stripe ever sees card numbers (on its own page). What is shown here is what Stripe says about a saved card: its brand,
// last four digits and expiry.
import { fail, json, readJson, sessionUser } from './lib.js';
import { nowSeconds } from './money.js';
import { paymentsOut } from './seller.js';
import { cleanShipTo } from './shopInput.js';
import { stripeCall, stripeConfig } from './stripe.js';

export async function buyerRow(db, userId) {
  return db.prepare('SELECT * FROM buyers WHERE user_id = ?').bind(userId).first();
}

export const addressOf = (row) =>
  row && row.ship_line1 ? { name: row.ship_name, phone: row.ship_phone, line1: row.ship_line1, line2: row.ship_line2, city: row.ship_city, region: row.ship_region, postal: row.ship_postal, country: row.ship_country } : null;

async function savedMethods(env, row) {
  if (!row || !row.stripe_customer || !stripeConfig(env).configured) return [];
  try {
    const data = await stripeCall(env, 'GET', `/v1/customers/${encodeURIComponent(row.stripe_customer)}/payment_methods?type=card&limit=10`);
    return (data.data || []).filter((m) => m && m.card).map((m) => ({ id: m.id, brand: m.card.brand, last4: m.card.last4, expMonth: m.card.exp_month, expYear: m.card.exp_year }));
  } catch {
    return [];
  }
}

async function respond(env, userId) {
  const row = await buyerRow(env.DB, userId);
  return json({ address: addressOf(row), methods: await savedMethods(env, row), payments: paymentsOut(env) });
}

export async function onBuyerGet({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  return respond(env, user.id);
}

export async function saveAddress(db, userId, a) {
  await db
    .prepare('INSERT INTO buyers (user_id, ship_name, ship_phone, ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET ship_name = excluded.ship_name, ship_phone = excluded.ship_phone, ship_line1 = excluded.ship_line1, ship_line2 = excluded.ship_line2, ship_city = excluded.ship_city, ship_region = excluded.ship_region, ship_postal = excluded.ship_postal, ship_country = excluded.ship_country, updated_at = excluded.updated_at')
    .bind(userId, a.name, a.phone, a.line1, a.line2, a.city, a.region, a.postal, a.country, nowSeconds())
    .run();
}

export async function onBuyerSave({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const body = await readJson(request);
  const checked = cleanShipTo(body && body.address);
  if (checked.error) return fail(checked.error, 400);
  await saveAddress(env.DB, user.id, checked.address);
  return respond(env, user.id);
}

export async function onAddressRemove({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  // orders keep their own copy of where they were sent, so only what is saved for next time goes
  await env.DB.prepare("UPDATE buyers SET ship_name = '', ship_phone = '', ship_line1 = '', ship_line2 = '', ship_city = '', ship_region = '', ship_postal = '', ship_country = '', updated_at = ? WHERE user_id = ?").bind(nowSeconds(), user.id).run();
  return respond(env, user.id);
}

export async function onMethodRemove({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const body = await readJson(request);
  const id = body && typeof body.id === 'string' ? body.id : '';
  const row = await buyerRow(env.DB, user.id);
  const mine = (await savedMethods(env, row)).some((m) => m.id === id);  // only cards that are this person's can be removed
  if (!mine) return fail('That card was not found', 404);
  try {
    await stripeCall(env, 'POST', `/v1/payment_methods/${encodeURIComponent(id)}/detach`, {});
  } catch (err) {
    return fail(err.message || "Couldn't remove that card", err.status || 502);
  }
  return respond(env, user.id);
}
