import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { STATEMENTS, ensureSchema, forgetSchema } from '../src/schema.js';
import worker from '../src/worker.js';

test('schema.js applies exactly what schema.sql says', () => {
  const sql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
    .split(';\n')
    .map((s) => s.trim().replace(/;$/, ''))
    .filter(Boolean);
  assert.deepEqual(STATEMENTS, sql);
  assert.ok(STATEMENTS.every((s) => /^(CREATE (TABLE|INDEX) IF NOT EXISTS|DROP TABLE IF EXISTS) /.test(s)), 'only idempotent statements');
});

function fakeDb({ failFirst = false } = {}) {
  const batches = [];
  let fails = failFirst ? 1 : 0;
  return {
    batches,
    prepare: (sql) => ({ sql }),
    async batch(statements) {
      batches.push(statements.map((s) => s.sql));
      if (fails-- > 0) throw new Error('D1 unavailable');
      return [];
    },
  };
}

test('the schema is applied once per instance, and retried after a failure', async () => {
  forgetSchema();
  const db = fakeDb({ failFirst: true });
  await assert.rejects(ensureSchema(db), /D1 unavailable/);
  await ensureSchema(db);
  await ensureSchema(db);
  assert.equal(db.batches.length, 2, 'tried again after the failure, then remembered');
  assert.deepEqual(db.batches[1], STATEMENTS);
});

test('the Worker applies the schema before handling a request', async () => {
  forgetSchema();
  const db = fakeDb();
  const response = await worker.fetch(new Request('https://x/api/auth/me'), { DB: db });
  assert.equal(response.status, 401);
  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0].length, STATEMENTS.length);
});
