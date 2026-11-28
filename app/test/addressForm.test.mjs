import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPhone, formatZip, addressFormHtml } from '../js/addressForm.js';

test('phone numbers are shown as (555) 123-4567 while typing', () => {
  assert.equal(formatPhone(''), '');
  assert.equal(formatPhone('5'), '(5');
  assert.equal(formatPhone('5551'), '(555) 1');
  assert.equal(formatPhone('5551234567'), '(555) 123-4567');
  assert.equal(formatPhone('(555) 123-4567 ext 9'), '(555) 123-4567');
  assert.equal(formatPhone('+44 20 7946 0958'), '+442079460958');
});

test('ZIP codes keep digits and a dash after the fifth', () => {
  assert.equal(formatZip('78701'), '78701');
  assert.equal(formatZip('787011234'), '78701-1234');
  assert.equal(formatZip('78a701'), '78701');
});

test('a saved address fills the form, already formatted', () => {
  const html = addressFormHtml({ name: 'A', phone: '5551234567', postal: '787011234', line1: '9 Lane', line2: '', city: 'Austin', region: 'TX' });
  assert.match(html, /value="\(555\) 123-4567"/);
  assert.match(html, /value="78701-1234"/);
  assert.match(html, /class="address-form"/);
});

test('saved and seller addresses are offered once each, and only when they start with what was typed', async () => {
  const { addressSuggestions, matchSuggestions } = await import('../js/addressForm.js');
  const saved = { name: 'Julie Buyer', phone: '5551230000', line1: '9 Buyer Lane', line2: '', city: 'Austin', region: 'TX', postal: '78701', country: 'US' };
  const seller = { legalName: 'Julie Buyer', phone: '5551230000', address: { line1: '9 Buyer Lane', line2: '', city: 'Austin', region: 'TX', postal: '78701', country: 'US' } };
  assert.equal(addressSuggestions(saved, seller).length, 1, 'the same address is not repeated');
  assert.equal(addressSuggestions(null, null).length, 0);
  const other = { ...seller, legalName: 'Bob Seller', address: { ...seller.address, line1: '1 Bob Road' } };
  const both = addressSuggestions(saved, other);
  assert.equal(both.length, 2);
  assert.deepEqual(matchSuggestions(both, 'name', 'ju').map((a) => a.line1), ['9 Buyer Lane']);
  assert.deepEqual(matchSuggestions(both, 'line1', '1 b').map((a) => a.name), ['Bob Seller']);
  assert.deepEqual(matchSuggestions(both, 'name', ''), [], 'nothing typed, nothing offered');
  assert.deepEqual(matchSuggestions(both, 'name', 'julie buyer'), [], 'already fully typed');
  assert.equal(addressSuggestions(saved, { ...seller, address: { ...seller.address, country: 'CA' } }).length, 1, 'only US seller addresses');
});

test('typing a street asks the lookup once things settle, ignores stale answers, and a found street fills only the address', async () => {
  const { wireAddressForm } = await import('../js/addressForm.js');
  // a tiny stand-in for the page: fields by data-f, listeners kept so the test can "type"
  const fields = {};
  const listeners = {};
  for (const k of ['name', 'phone', 'line1', 'line2', 'city', 'region', 'postal']) fields[k] = { value: '', addEventListener: (ev, fn) => { listeners[k] = fn; } };
  const made = [];
  const root = { querySelector: (sel) => (sel === '.address-form' ? { insertBefore: (el) => made.push(el) } : fields[/data-f="(\w+)"/.exec(sel)[1]]) };
  global.document = { createElement: () => ({ classList: { add() {}, toggle() {} }, replaceChildren() {}, addEventListener() {} }) };
  const asked = [];
  const answers = { '1932 mark': [{ line1: 'OLD', city: 'X', region: 'CA', postal: '1', country: 'US' }], '1932 market': [{ line1: '1932 Market Street', city: 'San Francisco', region: 'CA', postal: '94102', country: 'US' }] };
  const handle = wireAddressForm(root, [], async (q) => { asked.push(q); if (q === '1932 mark') await new Promise((r) => setTimeout(r, 600)); return answers[q]; });
  fields.line1.value = '1932 mark'; listeners.line1();
  await new Promise((r) => setTimeout(r, 400));
  fields.line1.value = '1932 market'; listeners.line1();
  await new Promise((r) => setTimeout(r, 1000));
  assert.deepEqual(asked, ['1932 mark', '1932 market']);
  assert.deepEqual(handle.suggestionsShown().map((a) => a.line1), ['1932 Market Street'], 'the stale answer was dropped');
  fields.line1.value = '19'; listeners.line1();
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(asked, ['1932 mark', '1932 market'], 'too short to ask');
  delete global.document;
});
