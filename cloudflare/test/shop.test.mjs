import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ADDRESS, LISTING, createShop, fakeWorld } from './helpers/shopKit.mjs';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const listing = (change = {}) => ({ ...LISTING, ...change });

/** A shop where bob (Stripe) sells a Lightning Bolt (4 x $12.50). */
async function shopWithListings(env = {}) {
  const shop = await createShop(env);
  shop.world = fakeWorld();
  shop.makeSeller('bob');
  const created = await shop.call('POST', '/api/shop/listing', listing(), 'bob');
  assert.equal(created.status, 201, created.text);
  shop.bolt = created.data.listing;
  return shop;
}

// ---- listings and the market -------------------------------------------------------------------------------------------------

test('only a seller who can be paid can list, and a listing is tied to a catalog card', async () => {
  const shop = await createShop();
  fakeWorld();
  assert.equal((await shop.call('POST', '/api/shop/listing', listing(), 'bob')).status, 403, 'not registered');
  shop.makeSeller('bob');
  fakeWorld({ sellerPayoutsActive: false });
  const blocked = await shop.call('POST', '/api/shop/listing', listing(), 'bob');
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /Stripe still needs details/);
  fakeWorld();
  assert.equal((await shop.call('POST', '/api/shop/listing', listing({ cardId: '' }), 'bob')).status, 400, 'a card from the catalog is required');
  assert.equal((await shop.call('POST', '/api/shop/listing', listing({ priceCents: 0 }), 'bob')).status, 400);
  assert.equal((await shop.call('POST', '/api/shop/listing', listing(), null)).status, 401);
  const ok = await shop.call('POST', '/api/shop/listing', listing(), 'bob');
  assert.equal(ok.status, 201);
  assert.equal(ok.data.listing.priceCents, 1250);
  assert.equal(ok.data.listing.seller, 'bob');
});

test('prices by catalog card: the lowest price when someone sells it, nothing (unavailable) when nobody does', async () => {
  const { call, bolt } = await shopWithListings();
  await call('POST', '/api/shop/listing', listing({ priceCents: 900, quantity: 2, condition: 'Lightly Played' }), 'bob');
  await call('POST', '/api/shop/listing', listing({ cardId: 'mtg-sold-out', name: 'Gone', quantity: 0 }), 'bob');
  const res = await call('GET', '/api/shop/prices?ids=mtg-abc,mtg-nobody,mtg-sold-out', undefined, null);
  assert.equal(res.status, 200, 'prices are public');
  assert.deepEqual(res.data.prices, { 'mtg-abc': { fromCents: 900, count: 2, quantity: 6 } });
  assert.equal(res.data.prices['mtg-nobody'], undefined);
  assert.equal(res.data.prices['mtg-sold-out'], undefined, 'a sold-out listing is not an offer');
  assert.deepEqual((await call('GET', '/api/shop/prices', undefined, null)).data, { prices: {} });
  const cheap = (await call('GET', '/api/shop/listings/mine', undefined, 'bob')).data.listings.find((l) => l.priceCents === 900);
  await call('POST', '/api/shop/listing/remove', { id: cheap.id }, 'bob');
  assert.equal((await call('GET', '/api/shop/prices?ids=mtg-abc', undefined, null)).data.prices['mtg-abc'].fromCents, bolt.priceCents);
});

test('browsing listings: by card (cheapest first), by name text, and never more than a username about a seller', async () => {
  const { call } = await shopWithListings();
  await call('POST', '/api/shop/listing', listing({ priceCents: 700, note: 'light wear' }), 'bob');
  await call('POST', '/api/shop/listing', listing({ cardId: 'mtg-def', name: 'Counterspell 100%', priceCents: 300 }), 'bob');
  const byCard = (await call('GET', '/api/shop/listings?cardId=mtg-abc', undefined, null)).data;
  assert.deepEqual(byCard.listings.map((l) => l.priceCents), [700, 1250]);
  assert.equal(byCard.hasMore, false);
  assert.deepEqual((await call('GET', '/api/shop/listings?q=counter', undefined, null)).data.listings.map((l) => l.name), ['Counterspell 100%']);
  assert.equal((await call('GET', '/api/shop/listings?q=%25', undefined, null)).data.listings.length, 1, 'only the name that really has a % in it');
  assert.equal((await call('GET', '/api/shop/listings?q=zzz%25', undefined, null)).data.listings.length, 0, 'a % in the search is not a wildcard');
  assert.deepEqual(Object.keys(byCard.listings[0]).sort(), ['cardId', 'condition', 'createdAt', 'foil', 'game', 'id', 'image', 'language', 'name', 'note', 'number', 'priceCents', 'quantity', 'seller', 'set', 'status']);
  const page = (await call('GET', '/api/shop/listings?limit=1&sort=price_asc', undefined, null)).data;
  assert.equal(page.listings.length, 1);
  assert.equal(page.hasMore, true);
});

test('a seller edits and removes only their own listings', async () => {
  const { call, bolt } = await shopWithListings();
  assert.equal((await call('POST', '/api/shop/listing', listing({ id: bolt.id, priceCents: 1000 }), 'bob')).data.listing.priceCents, 1000);
  assert.equal((await call('POST', '/api/shop/listing', listing({ id: bolt.id, priceCents: 1 }), 'carol')).status, 403, 'carol is not a seller');
  assert.equal((await call('POST', '/api/shop/listing/remove', { id: bolt.id }, 'julie')).status, 404);
  assert.equal((await call('POST', '/api/shop/listing/remove', { id: bolt.id }, 'bob')).status, 200);
  assert.equal((await call('GET', '/api/shop/listings?cardId=mtg-abc', undefined, null)).data.listings.length, 0);
});

// ---- the cart -----------------------------------------------------------------------------------------------------------------

test('the cart: add, change, clamp to stock, flag what sold out, and never your own listing', async () => {
  const { call, bolt, DB } = await shopWithListings();
  assert.equal((await call('GET', '/api/shop/cart', undefined, null)).status, 401);
  assert.equal((await call('POST', '/api/shop/cart/set', { listingId: bolt.id, qty: 1 }, 'bob')).status, 400, 'not your own listing');
  const added = await call('POST', '/api/shop/cart/set', { listingId: bolt.id, qty: 2 }, 'julie');
  assert.equal(added.status, 200);
  assert.equal(added.data.itemsCents, 2500);
  assert.deepEqual(added.data.groups, [{ seller: 'bob', itemsCents: 2500, cardCount: 2 }]);
  assert.equal((await call('POST', '/api/shop/cart/set', { listingId: bolt.id, qty: 50 }, 'julie')).data.items[0].qty, 4, 'clamped to what is in stock');
  assert.equal((await call('POST', '/api/shop/cart/set', { listingId: 'nope', qty: 1 }, 'julie')).status, 404);
  DB.sql('UPDATE listings SET quantity = 1 WHERE id = ?', bolt.id);
  const short = (await call('GET', '/api/shop/cart', undefined, 'julie')).data;
  assert.equal(short.items[0].short, true);
  assert.equal(short.itemsCents, 1250, 'only what is there is counted');
  await call('POST', '/api/shop/listing/remove', { id: bolt.id }, 'bob');
  const gone = (await call('GET', '/api/shop/cart', undefined, 'julie')).data;
  assert.equal(gone.items[0].unavailable, true);
  assert.equal(gone.itemsCents, 0);
  assert.equal((await call('POST', '/api/shop/cart/set', { listingId: bolt.id, qty: 0 }, 'julie')).data.items.length, 0);
});

// ---- buying: quote, checkout, paying ---------------------------------------------------------------------------------------------

const cartWith = (shop, qty = 2) => shop.call('POST', '/api/shop/cart/set', { listingId: shop.bolt.id, qty }, 'julie');

test('quote: shipping falls back to a flat rate without Shippo; with Shippo it is the live rate plus 20%', async () => {
  const shop = await shopWithListings();
  await cartWith(shop);
  assert.equal((await shop.call('POST', '/api/shop/checkout/quote', {})).status, 400, 'needs an address');
  assert.equal((await shop.call('POST', '/api/shop/checkout/quote', { address: { ...ADDRESS, country: 'FR' } })).status, 400);
  const flat = (await shop.call('POST', '/api/shop/checkout/quote', { address: ADDRESS })).data;
  assert.deepEqual([flat.itemsCents, flat.shippingCents, flat.totalCents], [2500, 500, 3000]);
  assert.equal(flat.groups[0].shippingMode, 'flat');
  assert.deepEqual(flat.problems, []);

  const withShippo = await shopWithListings({ SHIPPO_API_KEY: 'shippo_test_key' });
  await cartWith(withShippo);
  const live = (await withShippo.call('POST', '/api/shop/checkout/quote', { address: ADDRESS })).data;
  assert.equal(live.groups[0].shippingMode, 'shippo');
  assert.equal(live.shippingCents, 480, '$4.00 + 20%');
  assert.match(live.groups[0].shippingService, /USPS Ground Advantage/);
  const sent = withShippo.world.find((c) => c.host === 'api.goshippo.com' && c.path === '/shipments/')[0];
  assert.equal(sent.headers.Authorization, 'ShippoToken shippo_test_key');
  assert.equal(sent.json.address_from.zip, '97201', "from the seller's address");
  assert.equal(sent.json.address_to.zip, '78701', "to the buyer's address");
  assert.equal(sent.json.parcels[0].weight, '4', 'two cards: the envelope tier');

  const custom = await shopWithListings({ SHIPPO_API_KEY: 'k', SHIPPING_MARKUP_PERCENT: '50' });
  await cartWith(custom);
  assert.equal((await custom.call('POST', '/api/shop/checkout/quote', { address: ADDRESS })).data.shippingCents, 600, 'the markup is a variable');

  const down = await shopWithListings({ SHIPPO_API_KEY: 'k' });
  await cartWith(down);
  down.world = fakeWorld({ shippoDown: true });
  assert.equal((await down.call('POST', '/api/shop/checkout/quote', { address: ADDRESS })).data.groups[0].shippingMode, 'flat', 'Shippo being down never blocks a sale');
});

test('checkout: cards are reserved, Stripe gets the lines and the save-card box, paying finishes the order and empties the cart', async () => {
  const shop = await shopWithListings();
  await cartWith(shop, 3);
  const res = await shop.call('POST', '/api/shop/checkout', { address: ADDRESS });
  assert.equal(res.status, 200, res.text);
  assert.match(res.data.url, /^https:\/\/checkout\.stripe\.com\//);
  assert.equal(shop.DB.sql('SELECT quantity FROM listings WHERE id = ?', shop.bolt.id)[0].quantity, 1, '3 of 4 reserved');
  const session = shop.world.find((c) => c.path === '/v1/checkout/sessions' && c.method === 'POST')[0];
  const f = session.form;
  assert.equal(f.get('mode'), 'payment');
  assert.equal(f.get('saved_payment_method_options[payment_method_save]'), 'enabled', "Stripe's own save-my-card box");
  assert.equal(f.get('line_items[0][price_data][unit_amount]'), '1250');
  assert.equal(f.get('line_items[0][quantity]'), '3');
  assert.equal(f.get('line_items[1][price_data][unit_amount]'), '500', 'shipping line');
  assert.equal(f.get('payment_intent_data[transfer_group]'), res.data.orderId);
  assert.match(f.get('success_url'), /\?checkout=success&order=ord_[0-9a-f]+&session_id=\{CHECKOUT_SESSION_ID\}$/);
  assert.ok(Number(f.get('expires_at')) > Math.floor(Date.now() / 1000) + 30 * 60);
  assert.doesNotMatch(session.body, /card\[number\]|cvc|bank_account/i);
  assert.equal(session.headers['Idempotency-Key'], `binder-order-${res.data.orderId}`);

  let synced = (await shop.call('POST', '/api/shop/orders/sync', { orderId: res.data.orderId })).data.order;
  assert.equal(synced.status, 'pending');
  assert.ok(synced.resumeUrl);
  shop.world.pay(res.data.url.split('/').pop());
  synced = (await shop.call('POST', '/api/shop/orders/sync', { orderId: res.data.orderId })).data.order;
  assert.equal(synced.status, 'paid');
  assert.equal(synced.groups[0].status, 'awaiting_shipment');
  assert.equal(synced.totalCents, 3750 + 500);
  assert.equal((await shop.call('GET', '/api/shop/cart', undefined, 'julie')).data.items.length, 0, 'the cart is emptied once paid');
  assert.equal((await shop.call('POST', '/api/shop/orders/sync', { orderId: res.data.orderId })).data.order.status, 'paid');
  assert.equal((await shop.call('GET', '/api/shop/buyer')).data.address.line1, ADDRESS.line1);
  assert.equal(shop.world.find((c) => c.path === '/v1/customers').length, 1);
  const sales = (await shop.call('GET', '/api/shop/sales', undefined, 'bob')).data.sales;
  assert.equal(sales.length, 1);
  assert.equal(sales[0].shipTo.line1, ADDRESS.line1);
  assert.equal(sales[0].canShip, true);
  assert.doesNotMatch(JSON.stringify(sales), /example\.com/);
  assert.equal((await shop.call('POST', '/api/shop/orders/sync', { orderId: res.data.orderId }, 'carol')).status, 404);
});

test('checkout refuses what cannot be bought, and gives cards back when payment cannot start', async () => {
  const shop = await shopWithListings();
  await cartWith(shop, 4);
  shop.DB.sql('UPDATE listings SET quantity = 1 WHERE id = ?', shop.bolt.id);
  const refused = await shop.call('POST', '/api/shop/checkout', { address: ADDRESS });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /Only 1 of Lightning Bolt left/);
  shop.DB.sql('UPDATE listings SET quantity = 4 WHERE id = ?', shop.bolt.id);
  fakeWorld({ sellerPayoutsActive: false });
  const blocked = await shop.call('POST', '/api/shop/checkout', { address: ADDRESS });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /bob can't take orders/);
  fakeWorld();
  const prior = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).includes('/v1/checkout/sessions') ? { ok: false, status: 400, json: async () => ({ error: { message: 'Stripe said no' } }) } : prior(url, init));
  const failed = await shop.call('POST', '/api/shop/checkout', { address: ADDRESS });
  assert.equal(failed.status, 400);
  assert.equal(failed.data.error, 'Stripe said no');
  assert.equal(shop.DB.sql('SELECT quantity FROM listings WHERE id = ?', shop.bolt.id)[0].quantity, 4);
  assert.equal(shop.DB.sql("SELECT COUNT(*) AS n FROM orders WHERE status = 'cancelled'")[0].n, 1);
  const off = await createShop({ STRIPE_SECRET_KEY: '' });
  assert.equal((await off.call('POST', '/api/shop/checkout', { address: ADDRESS })).status, 503);
});

test('coming back without paying (or an unpaid order timing out) puts the cards back on sale', async () => {
  const shop = await shopWithListings();
  await cartWith(shop, 2);
  const order = (await shop.call('POST', '/api/shop/checkout', { address: ADDRESS })).data;
  assert.equal(shop.DB.sql('SELECT quantity FROM listings')[0].quantity, 2);
  const abandoned = await shop.call('POST', '/api/shop/orders/abandon', { orderId: order.orderId });
  assert.equal(abandoned.data.order.status, 'cancelled');
  assert.equal(shop.DB.sql('SELECT quantity FROM listings')[0].quantity, 4);
  assert.ok(shop.world.find((c) => c.path.endsWith('/expire')).length >= 1, "Stripe's page is closed too");
  assert.equal((await shop.call('GET', '/api/shop/orders')).data.orders.length, 0, 'an abandoned order is not shown');
  const second = (await shop.call('POST', '/api/shop/checkout', { address: ADDRESS })).data;
  shop.DB.sql('UPDATE orders SET expires_at = 1 WHERE id = ?', second.orderId);
  const { runMaintenance, finalizePaid } = await import('../src/orders.js');
  assert.equal((await runMaintenance(shop.env)).expired, 1);
  assert.equal(shop.DB.sql('SELECT quantity FROM listings')[0].quantity, 4);
  const row = shop.DB.sql('SELECT * FROM orders WHERE id = ?', second.orderId)[0];
  assert.equal(await finalizePaid(shop.env, row, { paymentRef: 'pi_late', chargeRef: 'ch_late' }), 'refunded_late', 'paid on a page that was given up on: refunded at once');
  assert.equal(shop.world.state.refunds.length, 1);
});

// ---- shipping, delivery, payout ------------------------------------------------------------------------------------------------------

async function paidOrder(shop, qty = 2) {
  await cartWith(shop, qty);
  const res = (await shop.call('POST', '/api/shop/checkout', { address: ADDRESS })).data;
  shop.world.pay(res.url.split('/').pop());
  const order = (await shop.call('POST', '/api/shop/orders/sync', { orderId: res.orderId })).data.order;
  return { orderId: res.orderId, group: order.groups[0] };
}

test('a label is bought through Shippo: tracking appears, the buyer sees it, delivery pays the seller minus the 10% fee', async () => {
  const shop = await shopWithListings({ SHIPPO_API_KEY: 'k', SHIPPO_WEBHOOK_TOKEN: 'hook-secret' });
  const { group, orderId } = await paidOrder(shop, 2);
  assert.equal(group.itemsCents, 2500);
  const labelled = await shop.call('POST', '/api/shop/sales/label', { groupId: group.id }, 'bob');
  assert.equal(labelled.status, 200, labelled.text);
  const sale = labelled.data.sale;
  assert.equal(sale.status, 'shipped');
  assert.match(sale.trackingNumber, /^9400/);
  assert.match(sale.labelUrl, /^https:\/\/shippo-delivery-east\.s3\.amazonaws\.com\//);
  assert.equal(shop.world.find((c) => c.path === '/transactions')[0].json.rate, 'rate_1');
  assert.equal((await shop.call('POST', '/api/shop/sales/label', { groupId: group.id }, 'bob')).status, 409, 'no second label');
  assert.equal((await shop.call('POST', '/api/shop/sales/label', { groupId: group.id }, 'carol')).status, 404);
  const mine = (await shop.call('GET', '/api/shop/orders')).data.orders[0];
  assert.equal(mine.groups[0].status, 'shipped');
  assert.equal(mine.groups[0].trackingNumber, sale.trackingNumber);
  assert.equal(mine.groups[0].labelUrl, '', "the label is the seller's");
  assert.equal(mine.groups[0].canConfirm, true);
  const hook = (token, status) => shop.call('POST', `/api/shippo/webhook?token=${token}`, { event: 'track_updated', data: { tracking_number: sale.trackingNumber, tracking_status: { status } } }, null);
  assert.equal((await hook('wrong', 'DELIVERED')).status, 403);
  assert.equal((await hook('hook-secret', 'TRANSIT')).status, 200);
  assert.equal(shop.DB.sql('SELECT status FROM order_groups')[0].status, 'shipped');
  assert.equal((await hook('hook-secret', 'DELIVERED')).status, 200);
  const row = shop.DB.sql('SELECT * FROM order_groups')[0];
  assert.equal(row.status, 'paid_out');
  assert.equal(row.payout_cents, 2250, 'items minus the 10% fee; the buyer-paid shipping stays with Binder, which bought the label');
  const transfer = shop.world.state.transfers[0].form;
  assert.equal(transfer.get('amount'), '2250');
  assert.equal(transfer.get('destination'), 'acct_bob');
  assert.equal(transfer.get('transfer_group'), orderId);
  assert.equal(transfer.get('source_transaction'), `ch_${shop.DB.sql('SELECT provider_ref FROM orders')[0].provider_ref}`);
  await hook('hook-secret', 'DELIVERED');
  assert.equal(shop.world.state.transfers.length, 1, 'a repeated message pays once');
});

test('without Shippo the seller types the tracking: the shipping money is theirs, the buyer confirms (or 14 days pass)', async () => {
  const shop = await shopWithListings();
  const { group } = await paidOrder(shop, 1);
  assert.equal((await shop.call('POST', '/api/shop/sales/label', { groupId: group.id }, 'bob')).status, 502, 'no label service');
  assert.equal((await shop.call('POST', '/api/shop/sales/ship', { groupId: group.id, carrier: 'x', trackingNumber: '1' }, 'bob')).status, 400);
  const shipped = await shop.call('POST', '/api/shop/sales/ship', { groupId: group.id, carrier: 'USPS', trackingNumber: '9400 1118 9922 4567' }, 'bob');
  assert.equal(shipped.status, 200, shipped.text);
  assert.equal(shipped.data.sale.trackingNumber, '9400111899224567');
  assert.match(shipped.data.sale.trackingUrl, /tools\.usps\.com.*9400111899224567/);
  assert.equal((await shop.call('POST', '/api/shop/orders/received', { groupId: group.id }, 'carol')).status, 404);
  assert.equal((await shop.call('POST', '/api/shop/orders/received', { groupId: group.id })).status, 200);
  const row = shop.DB.sql('SELECT * FROM order_groups')[0];
  assert.equal(row.status, 'paid_out');
  assert.equal(row.payout_cents, 1250 - 125 + 500, 'items - 10% fee + the flat shipping the seller posted themselves');

  const timed = await shopWithListings();
  const second = await paidOrder(timed, 1);
  await timed.call('POST', '/api/shop/sales/ship', { groupId: second.group.id, carrier: 'UPS', trackingNumber: '1Z999AA10123456784' }, 'bob');
  const { runMaintenance } = await import('../src/orders.js');
  assert.equal((await runMaintenance(timed.env)).autoReleased, 0, 'not yet');
  timed.DB.sql('UPDATE order_groups SET release_at = 1');
  assert.equal((await runMaintenance(timed.env)).autoReleased, 1);
  assert.equal(timed.DB.sql('SELECT status FROM order_groups')[0].status, 'paid_out');
});

test('the fee is a variable (10% by default), and a failed transfer is retried by the hourly sweep', async () => {
  const shop = await shopWithListings({ PLATFORM_FEE_PERCENT: '5' });
  const { group } = await paidOrder(shop, 4);
  shop.world = fakeWorld({ failTransfer: true });
  await shop.call('POST', '/api/shop/sales/ship', { groupId: group.id, carrier: 'USPS', trackingNumber: '9400111899224567' }, 'bob');
  await shop.call('POST', '/api/shop/orders/received', { groupId: group.id });
  assert.equal(shop.DB.sql('SELECT status FROM order_groups')[0].status, 'delivered', 'the transfer failed: still owed, not lost');
  const world = fakeWorld();
  const { runMaintenance } = await import('../src/orders.js');
  assert.equal((await runMaintenance(shop.env)).retried, 1);
  const row = shop.DB.sql('SELECT * FROM order_groups')[0];
  assert.equal(row.status, 'paid_out');
  assert.equal(row.fee_cents, 250, '5% of $50.00');
  assert.equal(row.payout_cents, 5000 - 250 + 500);
  assert.equal(world.state.transfers.length, 1);
});

test('refunds: a buyer cancels before it ships, a seller refunds after, and cards come back only when they never left', async () => {
  const shop = await shopWithListings();
  const { group, orderId } = await paidOrder(shop, 2);
  assert.equal(shop.DB.sql('SELECT quantity FROM listings')[0].quantity, 2);
  assert.equal((await shop.call('POST', '/api/shop/orders/cancel', { groupId: group.id }, 'carol')).status, 404);
  const cancelled = await shop.call('POST', '/api/shop/orders/cancel', { groupId: group.id });
  assert.equal(cancelled.status, 200, cancelled.text);
  const refund = shop.world.state.refunds[0].form;
  assert.equal(refund.get('amount'), String(2500 + 500), 'items and shipping');
  assert.equal(refund.get('payment_intent'), `pi_${shop.DB.sql('SELECT provider_ref FROM orders')[0].provider_ref}`);
  assert.equal(shop.DB.sql('SELECT quantity FROM listings')[0].quantity, 4, 'never shipped: back on sale');
  assert.equal(shop.DB.sql('SELECT status FROM orders WHERE id = ?', orderId)[0].status, 'refunded');
  assert.equal((await shop.call('POST', '/api/shop/orders/cancel', { groupId: group.id })).status, 409, 'only once');

  const second = await paidOrder(shop, 1);
  await shop.call('POST', '/api/shop/sales/ship', { groupId: second.group.id, carrier: 'USPS', trackingNumber: '9400111899224567' }, 'bob');
  assert.equal((await shop.call('POST', '/api/shop/orders/cancel', { groupId: second.group.id })).status, 409);
  await shop.call('POST', '/api/shop/orders/received', { groupId: second.group.id });
  assert.equal(shop.DB.sql("SELECT COUNT(*) AS n FROM order_groups WHERE status = 'paid_out'")[0].n, 1);
  const stock = shop.DB.sql('SELECT quantity FROM listings')[0].quantity;
  const refunded = await shop.call('POST', '/api/shop/sales/refund', { groupId: second.group.id }, 'bob');
  assert.equal(refunded.status, 200, refunded.text);
  assert.equal(shop.world.find((c) => /\/v1\/transfers\/tr_[0-9]+\/reversals$/.test(c.path)).length, 1, 'the seller payout was reversed first');
  assert.equal(shop.DB.sql('SELECT quantity FROM listings')[0].quantity, stock, 'it shipped, so the card is not back on sale');
  assert.equal((await shop.call('POST', '/api/shop/sales/refund', { groupId: second.group.id }, 'bob')).status, 409);
});

test('a parcel never shipped is refunded by the hourly sweep after 10 days', async () => {
  const shop = await shopWithListings();
  await paidOrder(shop, 1);
  const { runMaintenance } = await import('../src/orders.js');
  assert.equal((await runMaintenance(shop.env)).autoRefunded, 0);
  shop.DB.sql('UPDATE orders SET paid_at = 1');
  assert.equal((await runMaintenance(shop.env)).autoRefunded, 1);
  assert.equal(shop.DB.sql('SELECT status FROM order_groups')[0].status, 'refunded');
});

test('Shippo says the parcel came back: the seller is not paid', async () => {
  const shop = await shopWithListings({ SHIPPO_API_KEY: 'k', SHIPPO_WEBHOOK_TOKEN: 't' });
  const { group } = await paidOrder(shop, 1);
  const sale = (await shop.call('POST', '/api/shop/sales/label', { groupId: group.id }, 'bob')).data.sale;
  await shop.call('POST', '/api/shippo/webhook?token=t', { event: 'track_updated', data: { tracking_number: sale.trackingNumber, tracking_status: { status: 'RETURNED' } } }, null);
  assert.equal(shop.DB.sql('SELECT hold FROM order_groups')[0].hold, 1);
  await shop.call('POST', '/api/shop/orders/received', { groupId: group.id });
  assert.equal(shop.DB.sql('SELECT status FROM order_groups')[0].status, 'delivered', 'on hold, not paid');
  assert.equal(shop.world.state.transfers.length, 0);
});

// ---- webhooks ---------------------------------------------------------------------------------------------------------------------

async function stripeEvent(shop, event, secret = 'whsec_test', timestamp = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(event);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return shop.call('POST', '/api/stripe/webhook', body, null, { 'Stripe-Signature': `t=${timestamp},v1=${sig}` });
}

test('Stripe webhooks: signed, de-duplicated, and a payment event finishes the order even if the buyer never came back', async () => {
  const shop = await shopWithListings({ STRIPE_WEBHOOK_SECRET: 'whsec_test' });
  await cartWith(shop, 1);
  const order = (await shop.call('POST', '/api/shop/checkout', { address: ADDRESS })).data;
  shop.world.pay(order.url.split('/').pop());
  const event = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs', metadata: { order_id: order.orderId } } } };
  assert.equal((await shop.call('POST', '/api/stripe/webhook', JSON.stringify(event), null)).status, 400, 'no signature');
  assert.equal((await stripeEvent(shop, event, 'whsec_wrong')).status, 400, 'wrong secret');
  assert.equal((await stripeEvent(shop, event, 'whsec_test', 1000)).status, 400, 'too old');
  assert.equal(shop.DB.sql('SELECT status FROM orders')[0].status, 'pending');
  assert.equal((await stripeEvent(shop, event)).status, 200);
  assert.equal(shop.DB.sql('SELECT status FROM orders')[0].status, 'paid');
  assert.equal((await stripeEvent(shop, event)).data.duplicate, true);
  const pi = shop.DB.sql('SELECT payment_ref FROM orders')[0].payment_ref;
  await stripeEvent(shop, { id: 'evt_2', type: 'charge.dispute.created', data: { object: { payment_intent: pi } } });
  assert.equal(shop.DB.sql('SELECT flag FROM orders')[0].flag, 'disputed');
  assert.equal(shop.DB.sql('SELECT hold FROM order_groups')[0].hold, 1);
  await stripeEvent(shop, { id: 'evt_3', type: 'charge.refunded', data: { object: { payment_intent: pi, refunded: true } } });
  assert.equal(shop.DB.sql('SELECT status FROM orders')[0].status, 'refunded');
  assert.equal(shop.DB.sql('SELECT quantity FROM listings')[0].quantity, 4, 'it never shipped: back on sale');
  const none = await createShop({ STRIPE_WEBHOOK_SECRET: '' });
  assert.equal((await none.call('POST', '/api/stripe/webhook', '{}', null)).status, 400, 'no secret set: nothing is trusted');
});

// ---- saved cards and addresses ---------------------------------------------------------------------------------------------------

test('saved cards are listed from Stripe (brand and last four only) and can be removed, only your own', async () => {
  const shop = await shopWithListings();
  assert.equal((await shop.call('GET', '/api/shop/buyer')).data.address, null);
  assert.equal((await shop.call('POST', '/api/shop/buyer', { address: { name: 'x' } })).status, 400);
  assert.equal((await shop.call('POST', '/api/shop/buyer', { address: ADDRESS })).data.address.city, 'Austin');
  await cartWith(shop, 1);
  await shop.call('POST', '/api/shop/checkout', {});   // creates the Stripe customer, using the saved address
  shop.world.state.methods = [{ id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } }];
  const buyer = (await shop.call('GET', '/api/shop/buyer')).data;
  assert.deepEqual(buyer.methods, [{ id: 'pm_1', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 }]);
  assert.doesNotMatch(JSON.stringify(buyer), /number|cvc/i);
  assert.equal((await shop.call('POST', '/api/shop/buyer/method/remove', { id: 'pm_other' })).status, 404, 'not one of your cards');
  assert.deepEqual((await shop.call('POST', '/api/shop/buyer/method/remove', { id: 'pm_1' })).data.methods, []);
});

test('a seller with open orders cannot remove their profile', async () => {
  const shop = await shopWithListings();
  await paidOrder(shop, 1);
  const refused = await shop.call('POST', '/api/seller/delete', {}, 'bob');
  assert.equal(refused.status, 409);
  const group = shop.DB.sql('SELECT id FROM order_groups')[0];
  await shop.call('POST', '/api/shop/orders/cancel', { groupId: group.id });
  assert.equal((await shop.call('POST', '/api/seller/delete', {}, 'bob')).status, 200);
  assert.equal((await shop.call('GET', '/api/shop/listings?cardId=mtg-abc', undefined, null)).data.listings.length, 0, 'their listings go with the profile');
});

// ---- PayPal and Venmo (built, off by default) --------------------------------------------------------------------------------------

test('PayPal: off until configured; when on, a PayPal/Venmo buyer pays a PayPal/Venmo seller and the seller is paid through Payouts', async () => {
  const off = await shopWithListings();
  assert.equal((await off.call('POST', '/api/shop/checkout', { address: ADDRESS, provider: 'paypal' })).status, 503);

  const shop = await createShop({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' });
  shop.world = fakeWorld();
  shop.makeSeller('carol');
  const made = await shop.call('POST', '/api/shop/listing', listing({ cardId: 'mtg-pp', name: 'Counterspell', priceCents: 800 }), 'carol');
  assert.equal(made.status, 201, made.text);
  const stripeSeller = (await createShop({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' }));
  assert.ok(stripeSeller);
  await shop.call('POST', '/api/shop/cart/set', { listingId: made.data.listing.id, qty: 2 }, 'julie');
  const res = await shop.call('POST', '/api/shop/checkout', { address: ADDRESS, provider: 'paypal' });
  assert.equal(res.status, 200, res.text);
  assert.match(res.data.url, /sandbox\.paypal\.com/);
  const created = shop.world.find((c) => c.path === '/v2/checkout/orders')[0].json;
  assert.equal(created.purchase_units[0].amount.value, '21.00', '$16.00 of cards + $5.00 flat shipping');
  assert.equal(shop.world.find((c) => c.path === '/v1/oauth2/token')[0].headers.Authorization, `Basic ${btoa('id:secret')}`);
  // not approved on PayPal yet: still pending; approved: captured and paid
  const orderId = res.data.orderId;
  assert.equal((await shop.call('POST', '/api/shop/orders/sync', { orderId, paypalApproved: true })).data.order.status, 'pending');
  shop.world.approve(shop.DB.sql('SELECT provider_ref FROM orders')[0].provider_ref);
  assert.equal((await shop.call('POST', '/api/shop/orders/sync', { orderId, paypalApproved: true })).data.order.status, 'paid');
  const group = shop.DB.sql('SELECT id FROM order_groups')[0];
  await shop.call('POST', '/api/shop/sales/ship', { groupId: group.id, carrier: 'USPS', trackingNumber: '9400111899224567' }, 'carol');
  await shop.call('POST', '/api/shop/orders/received', { groupId: group.id });
  const payout = shop.world.state.paypalPayouts[0];
  assert.equal(payout.items[0].recipient_wallet, 'VENMO');
  assert.equal(payout.items[0].receiver, '5557770000');
  assert.equal(payout.items[0].amount.value, ((1600 - 160 + 500) / 100).toFixed(2));
});

test('PayPal money cannot pay a Stripe seller', async () => {
  const shop = await shopWithListings({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' });
  await cartWith(shop, 1);
  const res = await shop.call('POST', '/api/shop/checkout', { address: ADDRESS, provider: 'paypal' });
  assert.equal(res.status, 409);
  assert.match(res.data.error, /PayPal or Venmo/);
});
