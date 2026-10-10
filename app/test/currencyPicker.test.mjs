import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCurrency } from '../js/currency.js';
import { ageText, currencyRows, nameOf, summary, symbolOf } from '../js/currencyPicker.js';

const memory = (initial = {}) => {
  const data = { ...initial };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
};
const RATES = { rates: { EUR: 0.9, GBP: 0.79, JPY: 150, CHF: 0.88 } };
const names = new Intl.DisplayNames('en', { type: 'currency' });
const NOW = 1_700_000_000_000;

async function service({ locale = 'en-GB', timeZone = 'Europe/London', storage = memory(), loaded = true } = {}) {
  const s = createCurrency({ storage, fetchFn: async () => ({ ok: true, json: async () => RATES }), locale, timeZone, nowMs: () => NOW });
  if (loaded) await s.refresh();
  return s;
}
const rows = (s, query = '', locale = 'en-GB') => currencyRows(s, query, { names, locale });

test('symbols and names', () => {
  assert.equal(symbolOf('GBP', 'en-GB'), '£');
  assert.equal(symbolOf('USD', 'en-US'), '$');
  assert.equal(symbolOf('JPY', 'en-US'), '¥');
  assert.equal(symbolOf('CHF', 'en-US'), 'CHF');
  assert.equal(symbolOf('NOPE!', 'en-US'), 'NOPE!', 'something that is not a currency shows as written');
  assert.equal(nameOf('GBP', names), 'British Pound');
  assert.equal(nameOf('GBP', null), 'GBP');
});

test('how long ago the rates were read', () => {
  assert.equal(ageText(0, NOW), '');
  assert.equal(ageText(NOW - 30_000, NOW), 'just now');
  assert.equal(ageText(NOW - 5 * 60_000, NOW), '5 minutes ago');
  assert.equal(ageText(NOW - 60 * 60_000, NOW), '1 hour ago');
  assert.equal(ageText(NOW - 3 * 3600_000, NOW), '3 hours ago');
  assert.equal(ageText(NOW - 72 * 3600_000, NOW), '3 days ago');
  assert.equal(ageText(NOW + 5000, NOW), 'just now', 'a clock a little behind is not negative');
});

test('the service can price in any currency it has a rate for', async () => {
  const s = await service();
  assert.equal(s.rateOf('USD'), 1);
  assert.equal(s.rateOf('GBP'), 0.79);
  assert.equal(s.rateOf('XYZ'), null);
  assert.equal(s.formatIn('GBP', 10), '£7.90');
  assert.equal(s.formatIn('USD', 10), '$10.00');
  assert.equal(s.formatIn('XYZ', 10), null);
  assert.equal(s.updatedAt(), NOW);
  assert.equal((await service({ loaded: false })).updatedAt(), 0);
});

test('the list: Automatic first, then every currency by name, with what $10 comes to', async () => {
  const s = await service();
  const all = rows(s);
  assert.equal(all[0].value, 'auto');
  assert.equal(all[0].title, 'Automatic');
  assert.match(all[0].detail, /British Pound \(GBP\)/);
  assert.equal(all[0].sample, '$10.00 = £7.90');
  assert.equal(all[0].selected, true);
  const titles = all.slice(1).map((r) => r.title);
  assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b)), 'by name');
  assert.deepEqual(all.slice(1).map((r) => r.value).sort(), ['CHF', 'EUR', 'GBP', 'JPY', 'USD']);
  const yen = all.find((r) => r.value === 'JPY');
  assert.deepEqual([yen.symbol, yen.detail, yen.sample, yen.selected], ['¥', 'JPY', '$10.00 = JP¥1,500', false]);
  assert.equal(all.find((r) => r.value === 'USD').sample, '', 'dollars need no conversion');
});

test('the picked currency is the selected row, not Automatic', async () => {
  const s = await service();
  s.setChoice('CHF');
  const all = rows(s);
  assert.deepEqual(all.filter((r) => r.selected).map((r) => r.value), ['CHF']);
  s.setChoice('auto');
  assert.deepEqual(rows(s).filter((r) => r.selected).map((r) => r.value), ['auto']);
});

test('searching by name or code, any case; Automatic matches too', async () => {
  const s = await service();
  assert.deepEqual(rows(s, 'yen').map((r) => r.value), ['JPY']);
  assert.deepEqual(rows(s, 'JP').map((r) => r.value), ['JPY'], 'by code');
  assert.deepEqual(rows(s, '  pound ').map((r) => r.value), ['auto', 'GBP'], 'Automatic is a pound here, so it matches too');
  assert.deepEqual(rows(s, 'auto').map((r) => r.value), ['auto']);
  assert.deepEqual(rows(s, 'zzz'), []);
});

test('with no rates yet the usual currencies are listed, with no sample, and the card says dollars', async () => {
  const s = await service({ loaded: false });
  const all = rows(s);
  assert.ok(all.length > 20);
  assert.ok(all.every((r) => r.sample === ''));
  const card = summary(s, { names, locale: 'en-GB', now: NOW });
  assert.equal(card.title, 'US Dollar (USD)');
  assert.equal(card.symbol, '$');
  assert.match(card.subtitle, /Rates not loaded yet/);
  assert.equal(card.rates, 'Prices are already in US dollars');
});

test('the card: the currency in use, how it was picked, a sample and the age of the rates', async () => {
  const s = await service();
  let card = summary(s, { names, locale: 'en-GB', now: NOW + 3 * 3600_000 });
  assert.deepEqual([card.symbol, card.title], ['£', 'British Pound (GBP)']);
  assert.match(card.subtitle, /^Automatic/);
  assert.equal(card.rates, '$10.00 = £7.90 · rates from 3 hours ago');
  s.setChoice('JPY');
  card = summary(s, { names, locale: 'en-GB', now: NOW });
  assert.equal(card.subtitle, 'Your choice');
  assert.equal(card.title, 'Japanese Yen (JPY)');
  assert.equal(card.rates, '$10.00 = JP¥1,500 · rates from just now');
  s.setChoice('USD');
  card = summary(s, { names, locale: 'en-GB', now: NOW });
  assert.equal(card.rates, 'Prices are already in US dollars · rates from just now');
});

test('picking a currency with no rate shows dollars and says so', async () => {
  const s = await service();
  s.setChoice('THB');  // not in the rates read
  const card = summary(s, { names, locale: 'en-GB', now: NOW });
  assert.equal(card.title, 'US Dollar (USD)');
  assert.match(card.subtitle, /Rates not loaded yet/);
});
