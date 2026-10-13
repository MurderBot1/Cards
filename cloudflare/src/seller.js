// Seller registration (the first step of the shop). A signed-in person gives their full legal name, address and phone and
// says how they want to be paid; that profile is theirs alone (nothing here is ever shown to anyone else, on a public page or in a
// listing, and none of it is logged). Payments go through Stripe and PayPal/Venmo: card and bank details are typed into
// their pages, never into Binder, so the only payment data kept here is Stripe's account id and the Venmo/PayPal reference
// the seller gave for being paid.
//   GET  /api/seller              -> { seller: null | {...}, payments: { stripe, stripeProblem, paypal } }
//   POST /api/seller              { legalName, phone, address: {line1, line2?, city, region, postal, country},
//                                   payout?: { kind: 'stripe' | 'venmo' | 'paypal', ref? } }   (register or update) -> same as GET
//   POST /api/seller/stripe       -> { url }   Stripe's own pages where the seller gives their ID and bank/debit card
//   POST /api/seller/delete       -> { ok, stripe: 'deleted' | 'kept' | 'none' }   remove the profile
import { fail, json, readJson, sessionUser } from './lib.js';
import { cleanSeller } from './sellerInput.js';
import { stripeCall, stripeConfig } from './stripe.js';

const origin = (request) => new URL(request.url).origin;

async function sellerRow(db, userId) {
  return db.prepare('SELECT * FROM sellers WHERE user_id = ?').bind(userId).first();
}

// What Stripe says about the seller's account, or { account: false } before they have one, or { account: true, unknown: true }
// when Stripe can't be asked right now.
async function stripeState(env, row) {
  if (!row.stripe_account) return { account: false };
  try {
    const acct = await stripeCall(env, 'GET', `/accounts/${encodeURIComponent(row.stripe_account)}`);
    return {
      account: true,
      detailsSubmitted: !!acct.details_submitted,
      payoutsEnabled: !!acct.payouts_enabled,
      due: acct.requirements && Array.isArray(acct.requirements.currently_due) ? acct.requirements.currently_due.length : 0,
    };
  } catch {
    return { account: true, unknown: true };
  }
}

function paymentsOut(env) {
  const stripe = stripeConfig(env);
  return { stripe: stripe.configured, stripeTest: stripe.test, stripeProblem: stripe.configured ? '' : stripe.problem, paypal: false };
}

async function sellerOut(env, row) {
  const stripe = row.payout_kind === 'stripe' ? await stripeState(env, row) : null;
  return {
    legalName: row.legal_name,
    phone: row.phone,
    address: { line1: row.addr_line1, line2: row.addr_line2, city: row.city, region: row.region, postal: row.postal, country: row.country },
    payout: { kind: row.payout_kind, ref: row.payout_ref },
    stripe,
    // ready to sell: paid through Stripe once Stripe says payouts are enabled, or through Venmo/PayPal with the reference given
    ready: row.payout_kind === 'stripe' ? !!(stripe && stripe.payoutsEnabled) : true,
  };
}

async function respond(env, db, userId) {
  const row = await sellerRow(db, userId);
  return json({ seller: row ? await sellerOut(env, row) : null, payments: paymentsOut(env) });
}

export async function onSellerGet({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  return respond(env, env.DB, user.id);
}

export async function onSellerSave({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const { seller, error } = cleanSeller(await readJson(request));
  if (error) return fail(error, 400);
  const now = Date.now();
  const a = seller.address;
  await env.DB
    .prepare(
      'INSERT INTO sellers (user_id, legal_name, phone, addr_line1, addr_line2, city, region, postal, country, payout_kind, payout_ref, created_at, updated_at) ' +
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12) ' +
        'ON CONFLICT(user_id) DO UPDATE SET legal_name = excluded.legal_name, phone = excluded.phone, addr_line1 = excluded.addr_line1, ' +
        'addr_line2 = excluded.addr_line2, city = excluded.city, region = excluded.region, postal = excluded.postal, country = excluded.country, ' +
        'payout_kind = excluded.payout_kind, payout_ref = excluded.payout_ref, updated_at = excluded.updated_at'
    )
    .bind(user.id, seller.legalName, seller.phone, a.line1, a.line2, a.city, a.region, a.postal, a.country, seller.payout.kind, seller.payout.ref, now)
    .run();
  return respond(env, env.DB, user.id);
}

export async function onSellerStripe({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const row = await sellerRow(env.DB, user.id);
  if (!row) return fail('Register as a seller first', 404);
  const config = stripeConfig(env);
  if (!config.configured) return fail(`Payments aren't available yet: ${config.problem}`, 503);
  try {
    let account = row.stripe_account;
    if (!account) {
      // a Stripe "Express" account: Stripe's own pages collect the ID check and the bank account or debit card for payouts
      const created = await stripeCall(
        env,
        'POST',
        '/accounts',
        {
          type: 'express',
          country: row.country,
          business_type: 'individual',
          capabilities: { transfers: { requested: true } },
          business_profile: { product_description: 'Trading cards sold on Binder' },
          individual: {
            phone: row.phone,
            address: { line1: row.addr_line1, line2: row.addr_line2 || undefined, city: row.city, state: row.region, postal_code: row.postal, country: row.country },
          },
          metadata: { binder_user: String(user.id) },
        },
        { idempotencyKey: `binder-seller-${user.id}` }
      );
      account = created.id;
      await env.DB.prepare('UPDATE sellers SET stripe_account = ?, updated_at = ? WHERE user_id = ?').bind(account, Date.now(), user.id).run();
    }
    const link = await stripeCall(env, 'POST', '/account_links', {
      account,
      type: 'account_onboarding',
      refresh_url: `${origin(request)}/?seller=refresh`,
      return_url: `${origin(request)}/?seller=return`,
    });
    return json({ url: link.url });
  } catch (err) {
    return fail(err.message || 'Stripe could not be reached', err.status || 502);
  }
}

export async function onSellerDelete({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const row = await sellerRow(env.DB, user.id);
  let stripe = 'none';
  if (row && row.stripe_account) {
    stripe = 'kept';
    try {
      await stripeCall(env, 'DELETE', `/accounts/${encodeURIComponent(row.stripe_account)}`);  // only works while there is nothing in it
      stripe = 'deleted';
    } catch { /* it stays in Stripe; the profile here goes either way */ }
  }
  await env.DB.prepare('DELETE FROM sellers WHERE user_id = ?').bind(user.id).run();
  return json({ ok: true, stripe });
}
