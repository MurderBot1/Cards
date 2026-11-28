// The cart, kept on the account so it follows a person between devices.
//   GET  /api/shop/cart                      -> { items, groups, itemsCents, cardCount }
//   POST /api/shop/cart/set                  { listingId, qty }   qty 0 takes it out -> the same as GET
//   POST /api/shop/cart/clear                -> the same as GET
// Prices are always the listing's price right now; a line whose listing was sold out or removed is flagged, not dropped.
import { fail, json, readJson, sessionUser } from './lib.js';
import { nowSeconds } from './money.js';
import { listingOut } from './listings.js';
import { MAX_CART_LINES } from './shopInput.js';

/** The cart lines with their listings (and each seller's username) joined in. */
export async function loadCart(db, userId) {
  const rows = await db
    .prepare('SELECT c.listing_id AS cart_listing, c.qty AS cart_qty, l.*, u.username FROM cart_items c LEFT JOIN listings l ON l.id = c.listing_id LEFT JOIN users u ON u.id = l.seller_id WHERE c.user_id = ? ORDER BY c.added_at')
    .bind(userId)
    .all();
  return rows.results.map((r) => {
    const live = r.id && r.status === 'active' && r.quantity > 0;
    return {
      listingId: r.cart_listing,
      qty: r.cart_qty,
      available: live ? r.quantity : 0,
      listing: r.id ? listingOut(r) : null,
      sellerId: r.seller_id || 0,
    };
  });
}

export function cartOut(lines) {
  const items = lines.map((l) => {
    const buyable = l.available > 0;
    const qty = Math.min(l.qty, l.available);
    return { listingId: l.listingId, qty: l.qty, available: l.available, unavailable: !buyable, short: buyable && l.qty > l.available, listing: l.listing, lineCents: buyable ? qty * l.listing.priceCents : 0 };
  });
  const groups = new Map();
  for (const it of items) {
    if (it.unavailable) continue;
    const g = groups.get(it.listing.seller) || { seller: it.listing.seller, itemsCents: 0, cardCount: 0 };
    const qty = Math.min(it.qty, it.available);
    g.itemsCents += qty * it.listing.priceCents;
    g.cardCount += qty;
    groups.set(it.listing.seller, g);
  }
  const list = [...groups.values()];
  return { items, groups: list, itemsCents: list.reduce((n, g) => n + g.itemsCents, 0), cardCount: list.reduce((n, g) => n + g.cardCount, 0) };
}

async function respond(env, userId) {
  return json(cartOut(await loadCart(env.DB, userId)));
}

export async function onCartGet({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  return respond(env, user.id);
}

// Test accounts named in SELF_PURCHASE_USERS (comma separated usernames, default none) may buy their own listings, so a whole
// sale can be tried with one account in Stripe's test mode. Everyone else still can't. Usernames are unique (users.username_lower),
// so each name matches exactly one account: the whole username, never a part of it, and each name counts once.
function canBuyOwn(env, user) {
  const names = new Set(String((env && env.SELF_PURCHASE_USERS) || '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean));
  return names.has(String(user.username || '').toLowerCase());
}

export async function onCartSet({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Sign in to use the cart', 401);
  const body = await readJson(request);
  const listingId = body && typeof body.listingId === 'string' ? body.listingId : '';
  const qty = body ? body.qty : undefined;
  if (!listingId || !Number.isInteger(qty) || qty < 0 || qty > 999) return fail('Send a listing and a quantity', 400);
  if (qty === 0) {
    await env.DB.prepare('DELETE FROM cart_items WHERE user_id = ? AND listing_id = ?').bind(user.id, listingId).run();
    return respond(env, user.id);
  }
  const listing = await env.DB.prepare("SELECT id, seller_id, quantity FROM listings WHERE id = ? AND status = 'active' AND quantity > 0").bind(listingId).first();
  if (!listing) return fail('That card is no longer for sale', 404);
  if (listing.seller_id === user.id && !canBuyOwn(env, user)) return fail("You can't buy your own listing", 400);
  const have = await env.DB.prepare('SELECT COUNT(*) AS n FROM cart_items WHERE user_id = ? AND listing_id != ?').bind(user.id, listingId).first();
  if (have.n >= MAX_CART_LINES) return fail(`The cart holds ${MAX_CART_LINES} different listings`, 409);
  const clamped = Math.min(qty, listing.quantity);
  await env.DB
    .prepare('INSERT INTO cart_items (user_id, listing_id, qty, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, listing_id) DO UPDATE SET qty = excluded.qty')
    .bind(user.id, listingId, clamped, nowSeconds())
    .run();
  return respond(env, user.id);
}

export async function onCartClear({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  await env.DB.prepare('DELETE FROM cart_items WHERE user_id = ?').bind(user.id).run();
  return respond(env, user.id);
}
