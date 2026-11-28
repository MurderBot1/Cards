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
