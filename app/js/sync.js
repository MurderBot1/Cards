/**
 * sync.js
 * Keeps this device's collections in step with the signed-in account.
 *
 * Each sync: export this device's collections from the local backend (GET /api/sync/state), send the ones that
 * changed since they were last synced to the account service, and write what it answers (the merged collections,
 * plus anything other devices changed) back through the local backend (POST /api/sync/apply). The merging itself
 * happens on the service (cloudflare/src/sync.js), last writer wins per card, so every device ends up the same.
 *
 * What counts as "changed": collections carry an `updated` time; we remember the value each one had when it was
 * last synced (per account, in localStorage) and push whichever differ. Removed collections are pushed as deletions.
 *
 * A sync runs after signing in, on startup, a few seconds after any change, when the app comes back to the front or
 * online, and every few minutes. Syncs never overlap; a request that arrives mid-sync schedules another.
 */
import { AUTH_URL } from './config.js';
import { accountRequest, api } from './api.js';
import { clearSession, getSession } from './session.js';
import { showToast } from './ui.js';

const META_PREFIX = 'binder_sync_meta:';
const OWNER_KEY = 'binder_sync_owner'; // whose collections are on this device
const BATCH = 40; // collections per request (the service accepts up to 90)
const AFTER_CHANGE_MS = 4000;
const PERIODIC_MS = 5 * 60 * 1000;

let running = false;
let again = false;
let timer = null;
let status = { state: 'idle', at: 0, error: '' };
const listeners = new Set();

export function onSyncStatus(fn) {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}
function setStatus(patch) {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn(status));
}

// ---- per-account bookkeeping ---------------------------------------------------------------------

function loadMeta(username) {
  try {
    const meta = JSON.parse(localStorage.getItem(META_PREFIX + username) || 'null');
    if (meta && typeof meta === 'object') return { cursor: 0, synced: {}, deletedSynced: {}, lastSyncAt: 0, ...meta };
  } catch (e) { /* start over: everything is pushed again and merged, nothing is lost */ }
  return { cursor: 0, synced: {}, deletedSynced: {}, lastSyncAt: 0 };
}
function saveMeta(username, meta) {
  try { localStorage.setItem(META_PREFIX + username, JSON.stringify(meta)); } catch (e) { /* see loadMeta */ }
}
function getOwner() {
  try { return localStorage.getItem(OWNER_KEY); } catch (e) { return null; }
}
function setOwner(username) {
  try { localStorage.setItem(OWNER_KEY, username); } catch (e) { /* ignore */ }
}

const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

// ---- one sync ------------------------------------------------------------------------------------

async function runSync(session) {
  const meta = loadMeta(session.username);
  const local = await api.syncState();
  const expect = {}; // the `updated` each collection had when we looked, so apply can tell if it changed since
  for (const c of local.collections) expect[c.id] = c.updated;

  const dirty = local.collections.filter((c) => meta.synced[c.id] !== c.updated);
  const dirtyDeleted = local.deleted.filter((d) => meta.deletedSynced[d.id] !== d.at);
  let changedLocally = false;

  const applyResponse = async (response) => {
    const docs = response.collections || [];
    if (docs.length === 0) return;
    const result = await api.syncApply({ collections: docs, expect });
    const applied = new Set(result.applied || []);
    for (const doc of docs) {
      if (!applied.has(doc.id)) continue;
      const previous = expect[doc.id];
      if (doc.deleted !== undefined) {
        delete meta.synced[doc.id];
        meta.deletedSynced[doc.id] = doc.deleted;
        delete expect[doc.id];
        if (previous !== undefined) changedLocally = true;
      } else {
        meta.synced[doc.id] = doc.updated;
        delete meta.deletedSynced[doc.id];
        expect[doc.id] = doc.updated;
        if (previous !== doc.updated) changedLocally = true;
      }
    }
  };

  let cursor = meta.cursor;
  const batches = chunk(dirty, BATCH);
  if (batches.length === 0) batches.push([]);
  for (let i = 0; i < batches.length; i++) {
    let response = await accountRequest('/sync', {
      token: session.token,
      body: { cursor, collections: batches[i], deleted: i === 0 ? dirtyDeleted.map((d) => ({ id: d.id, at: d.at })) : [] },
    });
    await applyResponse(response);
    cursor = response.cursor;
    while (response.more) {
      response = await accountRequest('/sync', { token: session.token, body: { cursor, collections: [] } });
      await applyResponse(response);
      cursor = response.cursor;
    }
    meta.cursor = cursor;
    saveMeta(session.username, meta); // progress survives a failure part-way through
  }
  meta.lastSyncAt = Date.now();
  saveMeta(session.username, meta);
  if (changedLocally) window.dispatchEvent(new Event('binder:collections-changed'));
  return meta.lastSyncAt;
}

export async function syncNow() {
  const session = getSession();
  if (!session || !AUTH_URL) return;
  if (getOwner() && getOwner() !== session.username) return; // waiting for the "whose collections are these?" answer
  if (running) {
    again = true;
    return;
  }
  clearTimeout(timer);
  running = true;
  setStatus({ state: 'syncing', error: '' });
  try {
    const at = await runSync(session);
    setStatus({ state: 'ok', at, error: '' });
  } catch (err) {
    if (err.status === 401) {
      clearSession();
      showToast('Your session expired — sign in again to keep syncing');
      setStatus({ state: 'idle', error: '' });
    } else {
      setStatus({ state: 'error', error: err.offline ? "you're offline" : err.message });
    }
  } finally {
    running = false;
    if (again) {
      again = false;
      schedule(1500);
    }
  }
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(syncNow, ms);
}

// ---- switching accounts on one device --------------------------------------------------------------

const switchEls = {
  modal: document.getElementById('modal-sync-owner'),
  text: document.getElementById('sync-owner-text'),
  merge: document.getElementById('sync-owner-merge'),
  cancel: document.getElementById('sync-owner-cancel'),
};

// Collections on this device belong to whoever synced them last. If someone else signs in, ask before their
// account takes them in.
async function checkOwner(session) {
  const owner = getOwner();
  if (!owner || owner === session.username) {
    setOwner(session.username);
    return true;
  }
  let hasData = true;
  try {
    const local = await api.syncState();
    hasData = local.collections.length > 0 || local.deleted.length > 0;
  } catch (e) { /* assume there is */ }
  if (!hasData) {
    setOwner(session.username);
    return true;
  }
  switchEls.text.textContent =
    `This device has collections from "${owner}". Add them to "${session.username}"'s account too? ` +
    'If not, you will be signed out and nothing is changed.';
  switchEls.modal.classList.remove('hidden');
  return new Promise((resolve) => {
    const done = (merge) => {
      switchEls.modal.classList.add('hidden');
      switchEls.merge.onclick = null;
      switchEls.cancel.onclick = null;
      if (merge) setOwner(session.username);
      else clearSession();
      resolve(merge);
    };
    switchEls.merge.onclick = () => done(true);
    switchEls.cancel.onclick = () => done(false);
  });
}

// ---- wiring ---------------------------------------------------------------------------------------

export function initSync() {
  window.addEventListener('binder:session', async (event) => {
    const session = event.detail;
    if (!session) {
      clearTimeout(timer);
      setStatus({ state: 'idle', at: 0, error: '' });
      return;
    }
    if (await checkOwner(session)) syncNow();
  });
  window.addEventListener('binder:local-change', () => {
    if (getSession()) schedule(AFTER_CHANGE_MS);
  });
  const soon = () => {
    if (getSession() && Date.now() - (status.at || 0) > 60 * 1000) syncNow();
  };
  window.addEventListener('online', soon);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') soon(); });
  setInterval(() => { if (getSession()) syncNow(); }, PERIODIC_MS);

  const session = getSession();
  if (session) {
    const meta = loadMeta(session.username);
    if (meta.lastSyncAt) setStatus({ at: meta.lastSyncAt });
    checkOwner(session).then((ok) => { if (ok) syncNow(); });
  }
}
