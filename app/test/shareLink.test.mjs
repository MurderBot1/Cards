import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createShare, findShare, stopShare } from '../js/shareLink.js';

function deps({ session = { token: 'tok' }, replies = [] } = {}) {
  const calls = { request: [], sync: 0, wait: [] };
  const queue = [...replies];
  return {
    calls,
    session: () => session,
    request: async (path, opts) => {
      calls.request.push({ path, ...opts });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    sync: async () => { calls.sync += 1; },
    wait: async (ms) => { calls.wait.push(ms); },
  };
}
const notSynced = () => Object.assign(new Error('Sync this list to your account first, then share it'), { status: 404 });
const link = { id: 'L1', token: 'T'.repeat(32), url: `https://x/s/${'T'.repeat(32)}` };

test('guests are told to sign in, and nothing is sent', async () => {
  for (const run of [createShare, findShare, stopShare]) {
    const d = deps({ session: null });
    await assert.rejects(run('L1', d), (err) => err.needsSignIn === true && /Sign in/.test(err.message));
    assert.equal(d.calls.request.length, 0);
    assert.equal(d.calls.sync, 0);
  }
});

test('making a link syncs first, then asks for it with the account token', async () => {
  const d = deps({ replies: [link] });
  assert.deepEqual(await createShare('L1', d), link);
  assert.equal(d.calls.sync, 1);
  assert.deepEqual(d.calls.request, [{ path: '/share', token: 'tok', body: { id: 'L1' } }]);
});

test('renewing says so', async () => {
  const d = deps({ replies: [link] });
  await createShare('L1', d, { renew: true });
  assert.deepEqual(d.calls.request[0].body, { id: 'L1', renew: true });
});

test('if the account has not got the list yet it syncs and tries again, a few times at most', async () => {
  const d = deps({ replies: [notSynced(), link] });
  assert.deepEqual(await createShare('L1', d), link);
  assert.equal(d.calls.sync, 2);
  assert.equal(d.calls.wait.length, 1);

  const never = deps({ replies: [notSynced(), notSynced(), notSynced(), link] });
  await assert.rejects(createShare('L1', never), /Sync this list/);
  assert.equal(never.calls.request.length, 3);
});

test('other errors are not retried', async () => {
  const d = deps({ replies: [Object.assign(new Error('Not signed in'), { status: 401 }), link] });
  await assert.rejects(createShare('L1', d), /Not signed in/);
  assert.equal(d.calls.request.length, 1);
});

test('a failing sync does not stop the request being tried', async () => {
  const d = deps({ replies: [link] });
  d.sync = async () => { throw new Error('offline'); };
  assert.deepEqual(await createShare('L1', d), link);
});

test('finding and stopping', async () => {
  const d = deps({ replies: [{ shares: [{ id: 'other', token: 'a' }, link] }, { shares: [] }, { ok: true }] });
  assert.deepEqual(await findShare('L1', d), link);
  assert.equal(await findShare('L1', d), null);
  assert.deepEqual(d.calls.request[0], { path: '/share', method: 'GET', token: 'tok' });
  await stopShare('L1', d);
  assert.deepEqual(d.calls.request[2], { path: '/share/revoke', token: 'tok', body: { id: 'L1' } });
});
