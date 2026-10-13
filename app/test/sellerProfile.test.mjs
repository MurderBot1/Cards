import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanSeller as workerClean, SELLER_COUNTRIES as workerCountries } from '../../cloudflare/src/sellerInput.js';
import { SELLER_COUNTRIES, cleanPhone, cleanSeller, countryName, payoutText, sellerStatus } from '../js/sellerProfile.js';

const GOOD = {
  legalName: '  Julie   Anne McRidland ',
  phone: '(555) 123-4567',
  address: { line1: '12 Main Street', line2: 'Apt 4', city: 'Portland', region: 'OR', postal: '97201', country: 'us' },
  payout: { kind: 'stripe' },
};
const withChange = (change) => ({ ...GOOD, ...change });
const withAddress = (change) => ({ ...GOOD, address: { ...GOOD.address, ...change } });

const CASES = [
  null, GOOD, { ...GOOD, payout: undefined }, withAddress({ line2: undefined }),
  withChange({ legalName: 'Julie' }), withChange({ legalName: '' }), withChange({ legalName: 'J1 M2' }), withChange({ legalName: '<b>Julie</b> McRidland' }),
  withChange({ legalName: 'Zoë Müller-Åkesson' }), withChange({ legalName: "Seán O'Brien" }),
  withChange({ phone: '123' }), withChange({ phone: '+44 20 7946 0958' }), withChange({ phone: 'call me' }),
  withAddress({ line1: '' }), withAddress({ line2: 'x'.repeat(101) }), withAddress({ city: '' }), withAddress({ region: '' }),
  withAddress({ postal: '!' }), withAddress({ postal: 'SW1A 1AA' }), withAddress({ country: 'ZZ' }), withAddress({ country: 'gb' }),
  withChange({ payout: { kind: 'bitcoin' } }), withChange({ payout: { kind: 'venmo' } }), withChange({ payout: { kind: 'venmo', ref: '12' } }),
  withChange({ payout: { kind: 'venmo', ref: '+1 (555) 987-6543' } }), { ...withAddress({ country: 'GB' }), payout: { kind: 'venmo' } },
  withChange({ payout: { kind: 'paypal', ref: ' Julie@Example.COM ' } }), withChange({ payout: { kind: 'paypal', ref: 'nope' } }),
];

test('the page and the Worker accept and refuse exactly the same registrations, with the same words', () => {
  assert.deepEqual(SELLER_COUNTRIES, workerCountries);
  for (const body of CASES) assert.deepEqual(cleanSeller(body), workerClean(body), JSON.stringify(body));
  assert.equal(cleanPhone('(555) 123-4567'), '5551234567');
});

test('what the cleaned profile looks like', () => {
  assert.deepEqual(cleanSeller(GOOD).seller, {
    legalName: 'Julie Anne McRidland',
    phone: '5551234567',
    address: { line1: '12 Main Street', line2: 'Apt 4', city: 'Portland', region: 'OR', postal: '97201', country: 'US' },
    payout: { kind: 'stripe', ref: '' },
  });
  assert.match(cleanSeller(withChange({ legalName: 'Julie' })).error, /full legal name/);
});

test('names for countries and for how a seller is paid', () => {
  assert.equal(countryName('US', new Intl.DisplayNames('en', { type: 'region' })), 'United States');
  assert.equal(countryName('US', null), 'US');
  assert.equal(payoutText({ kind: 'stripe', ref: '' }), 'Bank account or debit card, through Stripe');
  assert.equal(payoutText({ kind: 'venmo', ref: '5551234567' }), 'Venmo (5551234567)');
  assert.equal(payoutText({ kind: 'paypal', ref: 'a@b.co' }), 'PayPal (a@b.co)');
  assert.equal(payoutText(null), 'Bank account or debit card, through Stripe');
});

const seller = (over = {}) => ({ legalName: 'Julie', address: {}, payout: { kind: 'stripe', ref: '' }, stripe: { account: false }, ready: false, ...over });
const ON = { stripe: true };

test('where a seller stands', () => {
  assert.deepEqual(sellerStatus(null, ON), { ready: false, headline: 'Not a seller yet', detail: '', needsStripe: false });
  const venmo = sellerStatus(seller({ payout: { kind: 'venmo', ref: '5551234567' }, ready: true, stripe: null }), ON);
  assert.deepEqual([venmo.ready, venmo.headline, venmo.needsStripe], [true, 'Ready to sell', false]);
  assert.match(venmo.detail, /Venmo \(5551234567\)/);
  const done = sellerStatus(seller({ ready: true, stripe: { account: true, payoutsEnabled: true } }), ON);
  assert.deepEqual([done.ready, done.needsStripe], [true, false]);
  const start = sellerStatus(seller(), ON);
  assert.deepEqual([start.ready, start.headline, start.needsStripe], [false, 'One more step: set up payouts', true]);
  assert.match(start.detail, /Binder never sees those/);
  const partway = sellerStatus(seller({ stripe: { account: true, detailsSubmitted: false, payoutsEnabled: false, due: 2 } }), ON);
  assert.deepEqual([partway.headline, partway.needsStripe], ['Finish setting up payouts', true]);
  const unknown = sellerStatus(seller({ stripe: { account: true, unknown: true } }), ON);
  assert.match(unknown.detail, /Couldn't check Stripe/);
  const off = sellerStatus(seller(), { stripe: false });
  assert.deepEqual([off.ready, off.needsStripe, off.headline], [false, false, 'Profile saved']);
  assert.match(off.detail, /Payments aren't switched on/);
});
