// Listings: what sellers have for sale, and how the market finds it. The market searches the whole card catalog (in the app);
// what lives here is what sellers offer for each catalog card.
//   GET  /api/shop/prices?ids=a,b,c       public -> { prices: { <cardId>: { fromCents, count, quantity } } }   (a card nobody sells has no entry)
//   GET  /api/shop/listings?cardId=&q=&game=&seller=&sort=&limit=&offset=   public -> { listings, hasMore }
//   GET  /api/shop/listings/mine          -> { listings }   the signed-in seller's own listings (every status but removed)
//   POST /api/shop/listing                { id?, ...fields } -> { listing }   create or change one of your listings
//   POST /api/shop/listing/remove         { id } -> { ok }
// Only a registered seller who can be paid can list. Nothing about a seller beyond their username is ever shown.
import { fail, json, readJson, sessionUser } from './lib.js';
import { newId, nowSeconds } from './money.js';
import { sellerCanSell, sellerRow } from './seller.js';
import { MAX_ACTIVE_LISTINGS, cleanListing } from './shopInput.js';

export const listingOut = (r) => ({
  id: r.id, game: r.game, cardId: r.card_id, name: r.name, set: r.set_code, number: r.number, image: r.image,
  condition: r.condition, foil: !!r.foil, language: r.language, priceCents: r.price_cents, quantity: r.quantity, note: r.note,
  status: r.status, seller: r.username || undefined, createdAt: r.created_at,
});

const SORTS = {
  price_asc: 'l.price_cents ASC, l.created_at DESC',
  price_desc: 'l.price_cents DESC, l.created_at DESC',
  new: 'l.created_at DESC',
  name: 'l.name_lower ASC, l.price_cents ASC',
};
const likeEscape = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function onPrices({ request, env }) {
  const ids = [...new Set((new URL(request.url).searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_.:\-]{1,80}$/.test(s)))].slice(0, 60);
  if (!ids.length) return json({ prices: {} });
  const rows = await env.DB
    .prepare(`SELECT card_id, MIN(price_cents) AS from_cents, SUM(quantity) AS quantity, COUNT(*) AS n FROM listings WHERE status = 'active' AND quantity > 0 AND card_id IN (${ids.map(() => '?').join(',')}) GROUP BY card_id`)
    .bind(...ids)
    .all();
  const prices = {};
  for (const r of rows.results) prices[r.card_id] = { fromCents: r.from_cents, count: r.n, quantity: r.quantity };
  return json({ prices });
}

export async function onBrowse({ request, env }) {
  const q = new URL(request.url).searchParams;
  const where = ["l.status = 'active'", 'l.quantity > 0'];
  const args = [];
  const cardId = (q.get('cardId') || '').trim();
  if (cardId) { where.push('l.card_id = ?'); args.push(cardId.slice(0, 80)); }
  const text = (q.get('q') || '').trim().toLowerCase().slice(0, 80);
  if (text) { where.push("l.name_lower LIKE ? ESCAPE '\\'"); args.push(`%${likeEscape(text)}%`); }
  const game = (q.get('game') || '').trim().toLowerCase();
  if (game) { where.push('l.game = ?'); args.push(game.slice(0, 20)); }
  const seller = (q.get('seller') || '').trim().toLowerCase();
  if (seller) { where.push('u.username_lower = ?'); args.push(seller.slice(0, 40)); }
  const order = SORTS[q.get('sort')] || (cardId ? SORTS.price_asc : SORTS.new);
  const limit = Math.min(60, Math.max(1, Number.parseInt(q.get('limit') || '24', 10) || 24));
  const offset = Math.max(0, Number.parseInt(q.get('offset') || '0', 10) || 0);
  const rows = await env.DB
    .prepare(`SELECT l.*, u.username FROM listings l JOIN users u ON u.id = l.seller_id JOIN sellers s ON s.user_id = l.seller_id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(...args, limit + 1, offset)
    .all();
  return json({ listings: rows.results.slice(0, limit).map(listingOut), hasMore: rows.results.length > limit });
}

export async function onMine({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const rows = await env.DB.prepare("SELECT l.*, ? AS username FROM listings l WHERE l.seller_id = ? AND l.status != 'removed' ORDER BY l.updated_at DESC").bind(user.username, user.id).all();
  return json({ listings: rows.results.map(listingOut) });
}

export async function onListingSave({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const body = await readJson(request);
  if (!body) return fail('Send the listing as JSON', 400);
  const checked = cleanListing(body);
  if (checked.error) return fail(checked.error, 400);
  const l = checked.listing;
  const can = await sellerCanSell(env, await sellerRow(env.DB, user.id));
  if (!can.ok) return fail(can.reason, 403);
  const at = nowSeconds();
  if (body.id !== undefined) {
    const id = typeof body.id === 'string' ? body.id : '';
    const res = await env.DB
      .prepare("UPDATE listings SET game = ?, card_id = ?, name = ?, name_lower = ?, set_code = ?, number = ?, image = ?, condition = ?, foil = ?, language = ?, price_cents = ?, quantity = ?, note = ?, updated_at = ? WHERE id = ? AND seller_id = ? AND status != 'removed'")
      .bind(l.game, l.cardId, l.name, l.name.toLowerCase(), l.set, l.number, l.image, l.condition, l.foil ? 1 : 0, l.language, l.priceCents, l.quantity, l.note, at, id, user.id)
      .run();
    if (res.meta.changes !== 1) return fail('That listing was not found', 404);
    const row = await env.DB.prepare('SELECT l.*, ? AS username FROM listings l WHERE l.id = ?').bind(user.username, id).first();
    return json({ listing: listingOut(row) });
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM listings WHERE seller_id = ? AND status = 'active'").bind(user.id).first();
  if (count.n >= MAX_ACTIVE_LISTINGS) return fail(`You can have ${MAX_ACTIVE_LISTINGS} listings at a time`, 409);
  const id = newId('lst_');
  await env.DB
    .prepare("INSERT INTO listings (id, seller_id, game, card_id, name, name_lower, set_code, number, image, condition, foil, language, price_cents, quantity, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)")
    .bind(id, user.id, l.game, l.cardId, l.name, l.name.toLowerCase(), l.set, l.number, l.image, l.condition, l.foil ? 1 : 0, l.language, l.priceCents, l.quantity, l.note, at, at)
    .run();
  const row = await env.DB.prepare('SELECT l.*, ? AS username FROM listings l WHERE l.id = ?').bind(user.username, id).first();
  return json({ listing: listingOut(row) }, 201);
}

export async function onListingRemove({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const body = await readJson(request);
  const id = body && typeof body.id === 'string' ? body.id : '';
  const res = await env.DB.prepare("UPDATE listings SET status = 'removed', updated_at = ? WHERE id = ? AND seller_id = ? AND status != 'removed'").bind(nowSeconds(), id, user.id).run();
  if (res.meta.changes !== 1) return fail('That listing was not found', 404);
  return json({ ok: true });
}
