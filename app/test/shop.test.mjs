import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as workerInput from '../../cloudflare/src/shopInput.js';
import { escapeHtml, usd } from '../js/dom.js';
import { dateText, groupStatusText, orderStatusText, progressSteps, saleStatusText, sellerNextStep, trackingText } from '../js/orderText.js';
import { sellerStatus } from '../js/sellerProfile.js';
import * as appInput from '../js/shopInput.js';

// ---- the same rules in the app and in the account service ----------------------------------------------------------------------

test('the app and the Worker share one copy of the shop rules (only the import line differs)', () => {
  const strip = (text) => text.split('\n').filter((l) => !/^(\/\/ What the shop accepts|\/\/ the two in step|\/\/ cleaned value|\/\/ the app \(here\)|import \{ cleanPhone \})/.test(l) && !/checked the same way/.test(l) && !/^\/\/ cleaned value\./.test(l)).join('\n');
  const worker = readFileSync(new URL('../../cloudflare/src/shopInput.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../js/shopInput.js', import.meta.url), 'utf8');
  const body = (t) => t.slice(t.indexOf('export const CONDITIONS'));
  assert.equal(body(strip(app)), body(strip(worker)));
});

const LISTING = { game: 'MTG', cardId: 'mtg-abc', name: '  Lightning   Bolt ', set: 'LEA', number: '161', image: 'https://cards.example/bolt.jpg', condition: 'Near Mint', foil: true, language: 'English', priceCents: 1250, quantity: 4, note: ' light  wear ' };
const ADDRESS = { name: 'Julie Buyer', phone: '(555) 123-0000', line1: '9 Buyer Lane', line2: '', city: 'Austin', region: 'TX', postal: '78701', country: 'us' };

for (const [label, input] of [['app', appInput], ['worker', workerInput]]) {
  test(`${label}: a listing is cleaned, and what cannot be sold is refused`, () => {
    const ok = input.cleanListing(LISTING);
    assert.equal(ok.error, undefined);
    assert.deepEqual(ok.listing, { game: 'mtg', cardId: 'mtg-abc', name: 'Lightning Bolt', set: 'LEA', number: '161', image: 'https://cards.example/bolt.jpg', condition: 'Near Mint', foil: true, language: 'English', priceCents: 1250, quantity: 4, note: 'light wear' });
    const bad = (change, pattern) => assert.match(input.cleanListing({ ...LISTING, ...change }).error || '', pattern);
    bad({ name: '' }, /card name/);
    bad({ cardId: '' }, /Pick the card/);
    bad({ cardId: 'has space' }, /Pick the card/);
    bad({ game: 'not a game!' }, /game/);
    bad({ condition: 'Mint-ish' }, /condition/);
    bad({ priceCents: 0 }, /price/);
    bad({ priceCents: 12.5 }, /price/);
    bad({ priceCents: 1000001 }, /price/);
    bad({ quantity: -1 }, /how many/);
    bad({ quantity: 1.5 }, /how many/);
    bad({ note: 'x'.repeat(201) }, /note/);
    assert.equal(input.cleanListing({ ...LISTING, image: 'http://insecure.example/a.jpg' }).listing.image, '', 'only https pictures are kept');
    assert.equal(input.cleanListing({ ...LISTING, foil: 'yes' }).listing.foil, false, 'foil must be a real true');
    assert.equal(input.cleanListing({ ...LISTING, quantity: undefined }).listing.quantity, 1);
    assert.equal(input.cleanListing(null).error, 'Fill in the listing');
  });

  test(`${label}: a shipping address is cleaned, and only US addresses are taken`, () => {
    const ok = input.cleanShipTo(ADDRESS);
    assert.deepEqual(ok.address, { name: 'Julie Buyer', phone: '5551230000', line1: '9 Buyer Lane', line2: '', city: 'Austin', region: 'TX', postal: '78701', country: 'US' });
    assert.equal(input.cleanShipTo({ ...ADDRESS, phone: '' }).address.phone, '');
    const bad = (change, pattern) => assert.match(input.cleanShipTo({ ...ADDRESS, ...change }).error || '', pattern);
    bad({ name: 'J' }, /name/);
    bad({ line1: '' }, /street/);
    bad({ city: '' }, /city/);
    bad({ region: '' }, /state/);
    bad({ postal: '!' }, /ZIP/);
    bad({ phone: 'call me' }, /phone/);
    bad({ country: 'FR' }, /United States/);
    assert.equal(input.cleanShipTo(undefined).error, 'Enter your shipping address');
    assert.equal(input.cleanShipTo({ ...ADDRESS, country: undefined }).address.country, 'US');
  });

  test(`${label}: tracking typed by hand`, () => {
    assert.deepEqual(input.cleanTracking({ carrier: ' USPS ', trackingNumber: '9400 1118 9922 4567' }).tracking, { carrier: 'USPS', trackingNumber: '9400111899224567' });
    assert.match(input.cleanTracking({ carrier: 'x', trackingNumber: '9400111899' }).error, /carrier/);
    assert.match(input.cleanTracking({ carrier: 'UPS', trackingNumber: '12' }).error, /tracking number/);
    assert.match(input.cleanTracking({ carrier: 'UPS', trackingNumber: 'no spaces?!' }).error, /tracking number/);
  });

  test(`${label}: prices typed as dollars`, () => {
    for (const [text, cents] of [['12.50', 1250], ['$12.5', 1250], ['12', 1200], ['1,234.56', 123456], ['0.01', 1], [' 5 ', 500]]) assert.equal(input.parsePriceToCents(text), cents, text);
    for (const text of ['', '0', '0.00', 'abc', '1.234', '-5', '10000.01', '12.', null, undefined]) assert.equal(input.parsePriceToCents(text), null, String(text));
  });
}

// ---- the words ------------------------------------------------------------------------------------------------------------------

test('money is shown in US dollars with cents, and markup is escaped', () => {
  assert.equal(usd(1250), '$12.50');
  assert.equal(usd(5), '$0.05');
  assert.equal(usd(123456), '$1,234.56');
  assert.equal(usd(-3), '$0.00');
  assert.equal(usd(undefined), '$0.00');
  assert.equal(escapeHtml('<b a="1">&\'x\'</b>'), '&lt;b a=&quot;1&quot;&gt;&amp;&#39;x&#39;&lt;/b&gt;');
});

const group = (over = {}) => ({ status: 'awaiting_shipment', hold: false, trackingNumber: '', trackingStatus: '', trackingMode: '', ...over });

test('where an order stands, in words', () => {
  assert.equal(groupStatusText(group()), 'Waiting for the seller to ship');
  assert.equal(groupStatusText(group({ status: 'shipped' })), 'On its way');
  assert.equal(groupStatusText(group({ status: 'paid_out' })), 'Delivered');
  assert.equal(groupStatusText(group({ status: 'refunded' })), 'Refunded');
  assert.equal(groupStatusText(group({ status: 'shipped', hold: true })), 'On hold: contact the seller');
  assert.equal(saleStatusText(group()), 'Ready to ship');
  assert.equal(saleStatusText(group({ status: 'paid_out' })), 'Paid out');
  assert.equal(saleStatusText(group({ status: 'delivered', hold: true })), 'On hold');
  assert.equal(orderStatusText({ status: 'pending', groups: [] }), 'Waiting for payment');
  assert.equal(orderStatusText({ status: 'paid', flag: 'disputed', groups: [group()] }), 'Payment disputed');
  assert.equal(orderStatusText({ status: 'paid', flag: '', groups: [group({ status: 'shipped' })] }), 'In progress');
  assert.equal(orderStatusText({ status: 'paid', flag: '', groups: [group({ status: 'paid_out' }), group({ status: 'refunded' })] }), 'Complete');
});

test('tracking: the carrier\'s word, and a progress strip', () => {
  assert.equal(trackingText(group()), '', 'nothing to say before it ships');
  assert.equal(trackingText(group({ status: 'shipped', trackingNumber: '9400', trackingStatus: 'TRANSIT' })), 'In transit');
  assert.equal(trackingText(group({ status: 'shipped', trackingNumber: '9400', trackingStatus: 'PRE_TRANSIT' })), 'Label created, not picked up yet');
  assert.equal(trackingText(group({ status: 'shipped', trackingNumber: '9400', trackingStatus: 'RETURNED' })), 'Coming back to the seller');
  assert.equal(trackingText(group({ status: 'shipped', trackingNumber: '9400', trackingStatus: '' })), 'Waiting for the carrier to scan it');
  assert.equal(trackingText(group({ status: 'paid_out', trackingNumber: '9400', trackingStatus: 'TRANSIT' })), 'Delivered');
  assert.deepEqual(progressSteps(group()).map((s) => s.done), [true, false, false]);
  assert.deepEqual(progressSteps(group({ status: 'shipped' })).map((s) => s.done), [true, true, false]);
  assert.deepEqual(progressSteps(group({ status: 'paid_out' })).map((s) => s.done), [true, true, true]);
  assert.deepEqual(progressSteps(group({ status: 'refunded' })), []);
  assert.match(sellerNextStep(group()), /Ship this order/);
  assert.match(sellerNextStep(group({ status: 'shipped', trackingMode: 'manual' })), /14 days/);
  assert.match(sellerNextStep(group({ status: 'shipped', trackingMode: 'shippo' })), /carrier reports it delivered/);
  assert.equal(dateText(0), '');
  assert.match(dateText(1795000000), /2026/);
});

test('a Venmo or PayPal seller is not ready until PayPal is switched on', () => {
  const seller = { legalName: 'Julie', address: {}, payout: { kind: 'venmo', ref: '5551234567' }, stripe: null };
  const off = sellerStatus({ ...seller, ready: false }, { stripe: true, paypal: false });
  assert.deepEqual([off.ready, off.needsStripe, off.headline], [false, false, 'Profile saved']);
  assert.match(off.detail, /not switched on yet/);
  assert.match(off.detail, /Venmo \(5551234567\)/);
  assert.equal(sellerStatus({ ...seller, ready: true }, { stripe: true, paypal: true }).ready, true);
});
