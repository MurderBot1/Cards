// Unit tests for lib/auth.js (run with `npm test`). The full register/login flow is exercised against a local D1 by
// `npm run dev` (see README.md).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkEmail, checkPassword, checkUsername, hashPassword, spendPasswordTime, verifyPassword,
} from '../src/lib.js';

test('usernames', () => {
  assert.equal(checkUsername('julie_m-1.x'), null);
  assert.ok(checkUsername('ab'));
  assert.ok(checkUsername('a'.repeat(33)));
  assert.ok(checkUsername('has space'));
  assert.ok(checkUsername('émile'));
  assert.ok(checkUsername(undefined));
});

test('emails', () => {
  assert.equal(checkEmail('a@b.co'), null);
  assert.ok(checkEmail('nope'));
  assert.ok(checkEmail('a@b'));
  assert.ok(checkEmail('a b@c.de'));
  assert.ok(checkEmail(''));
  assert.ok(checkEmail('a@' + 'b'.repeat(250) + '.com'));
});

test('passwords', () => {
  assert.equal(checkPassword('12345678'), null);
  assert.ok(checkPassword('1234567'));
  assert.ok(checkPassword('x'.repeat(257)));
  assert.ok(checkPassword(''));
});

test('hash and verify', async () => {
  const stored = await hashPassword('correct horse');
  assert.match(stored, /^pbkdf2\$100000\$/);
  assert.equal(await verifyPassword('correct horse', stored), true);
  assert.equal(await verifyPassword('wrong horse', stored), false);
  assert.notEqual(stored, await hashPassword('correct horse'), 'salted: same password, different hash');
  assert.equal(await verifyPassword('x', 'garbage'), false);
  await spendPasswordTime('anything'); // the dummy hash must be well-formed
});
