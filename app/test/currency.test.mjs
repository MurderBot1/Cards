import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCurrency, guessCurrency, parseRates, regionOf } from '../js/currency.js';

test('the region comes from the language, else the time zone, else the language\'s usual region', () => {
  assert.equal(regionOf('en-GB', 'America/New_York'), 'GB', 'what the device says wins over where its clock is');
  assert.equal(regionOf('de-CH', ''), 'CH');
  assert.equal(regionOf('en', 'Europe/London'), 'GB', 'a language with no region: the zone');
  assert.equal(regionOf('en', 'Australia/Sydney'), 'AU');
  assert.equal(regionOf('en', 'America/Chicago'), 'US');
  assert.equal(regionOf('en', 'America/Toronto'), 'CA');
  assert.equal(regionOf('ja', 'Etc/UTC'), 'JP', 'no zone to go on: the language\'s usual region');
  assert.equal(regionOf('', ''), 'US');
  assert.equal(regionOf('not a tag!!', ''), 'US');
});

test('the currency guessed for a device', () => {
  assert.equal(guessCurrency('en-GB', ''), 'GBP');
  assert.equal(guessCurrency('en-US', 'Europe/London'), 'USD');
  assert.equal(guessCurrency('fr-FR', ''), 'EUR');
  assert.equal(guessCurrency('de-DE', ''), 'EUR');
  assert.equal(guessCurrency('es-ES', ''), 'EUR');
  assert.equal(guessCurrency('en-CA', ''), 'CAD');
  assert.equal(guessCurrency('ja-JP', ''), 'JPY');
  assert.equal(guessCurrency('en', 'Australia/Perth'), 'AUD');
  assert.equal(guessCurrency('en-NG', ''), 'USD', 'a region with no mapped currency: dollars (it can be picked in Settings)');
});

test('reading what the rate sources answer', () => {
  assert.deepEqual(parseRates({ base: 'USD', rates: { EUR: 0.9, GBP: 0.8 } }), { USD: 1, EUR: 0.9, GBP: 0.8 });
  assert.deepEqual(parseRates({ result: 'success', rates: { USD: 1, JPY: 150, bad: 3, XXX: 'no', NEG: -1, ZZZ: 0 } }), { USD: 1, JPY: 150 });
  for (const bad of [null, undefined, {}, { rates: null }, { rates: {} }, { rates: { USD: 1 } }, { rates: { EUR: 'x' } }, 'text']) assert.equal(parseRates(bad), null);
});

function make({ locale = 'en-GB', timeZone = '', answers = [], store = new Map(), clock = { now: 1_000_000 } } = {}) {
  const calls = [];
  let changes = 0;
  const service = createCurrency({
    storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    fetchFn: async (url) => {
      calls.push(url);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return { ok: next.status === undefined || next.status < 400, status: next.status || 200, json: async () => next.body };
    },
    locale, timeZone, nowMs: () => clock.now, onChange: () => { changes += 1; },
  });
  return { service, calls, store, clock, changes: () => changes };
}
const GOOD = { body: { rates: { EUR: 0.9, GBP: 0.8, JPY: 150 } } };

test('without rates prices stay in dollars; with them they are converted and formatted', async () => {
  const { service, calls } = make({ answers: [GOOD] });
  assert.equal(service.code(), 'USD', 'no rate yet');
  assert.equal(service.format(10), '$10.00');
  assert.equal(service.wanted(), 'GBP');
  assert.equal(await service.refresh(), true);
  assert.match(calls[0], /frankfurter\.dev.*base=USD/);
  assert.equal(service.code(), 'GBP');
  assert.equal(service.toLocal(10), 8);
  assert.equal(service.format(10), '£8.00');
  assert.equal(service.format(0), '£0.00');
});

test('a person\'s pick beats the guess, and a currency with no rate falls back to dollars', async () => {
  const { service, store } = make({ answers: [GOOD] });
  await service.refresh();
  service.setChoice('JPY');
  assert.equal(service.code(), 'JPY');
  assert.match(service.format(10), /^(JP)?¥1,500$/, 'yen have no decimals');
  assert.equal(store.get('binder_currency'), 'JPY');
  service.setChoice('dollars');
  assert.equal(service.choice(), 'auto', 'not a currency: back to automatic');
  service.setChoice('CHF');
  assert.equal(service.code(), 'USD', 'no rate for it');
  assert.equal(service.wanted(), 'CHF');
  service.setChoice('auto');
  assert.equal(service.code(), 'GBP');
  assert.deepEqual(service.available(), ['EUR', 'GBP', 'JPY', 'USD']);
});

test('rates are kept for 12 hours on the device, an old one is used when offline, and a second source is tried', async () => {
  const first = make({ answers: [GOOD] });
  await first.service.refresh();
  assert.equal(await first.service.refresh(), false, 'fresh: nothing asked');
  assert.equal(first.calls.length, 1);

  // a new visit on the same device reads what was saved, and asks nobody while it is fresh
  const second = make({ store: first.store, clock: first.clock, answers: [] });
  assert.equal(second.service.code(), 'GBP', 'known straight away');
  assert.equal(await second.service.refresh(), false);
  assert.equal(second.calls.length, 0);

  // 13 hours later it is asked again; offline, the old rate stays in use
  first.clock.now += 13 * 3600 * 1000;
  const offline = make({ store: first.store, clock: first.clock, answers: [new Error('offline'), new Error('offline')] });
  assert.equal(offline.service.stale(), true);
  assert.equal(await offline.service.refresh(), false);
  assert.equal(offline.calls.length, 2, 'both sources tried');
  assert.equal(offline.service.format(10), '£8.00', 'the old rate still serves');

  // the first source failing is not the end
  const fallback = make({ answers: [{ status: 503, body: {} }, { body: { result: 'success', rates: { GBP: 0.75 } } }] });
  assert.equal(await fallback.service.refresh(), true);
  assert.match(fallback.calls[1], /open\.er-api\.com/);
  assert.equal(fallback.service.toLocal(4), 3);
});

test('damaged saved data starts over, and changes are announced', async () => {
  const store = new Map([['binder_fx_v1', 'not json{'], ['binder_currency', 'EUR']]);
  const { service, changes } = make({ store, answers: [GOOD] });
  assert.equal(service.code(), 'USD');
  assert.equal(service.choice(), 'EUR');
  await service.refresh();
  assert.equal(service.code(), 'EUR');
  const before = changes();
  service.setChoice('GBP');
  assert.equal(changes(), before + 1);
  // one refresh at a time
  const busy = make({ answers: [GOOD] });
  const [a, b] = [busy.service.refresh({ force: true }), busy.service.refresh({ force: true })];
  assert.equal(a, b);
  await a;
  assert.equal(busy.calls.length, 1);
});
