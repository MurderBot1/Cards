/**
 * shareLink.js
 * Public, read-only share links for a list. The account service (cloudflare/src/share.js) keeps one random link per
 * list and serves the page; this is the app's side of asking for, finding and turning off that link.
 *
 * A link is made from the copy of the list stored on the account, so the list has to have been synced first. Making a
 * link therefore syncs, and tries again a couple of times if the service hasn't seen the list yet. The browser pieces
 * (session, request, sync, timer) are passed in as `deps`, so this file has no page in it and is tested on its own:
 *   deps = { session: () => ({token}) | null, request: (path, {method, body, token}) => Promise, sync: () => Promise, wait: (ms) => Promise }
 */
const RETRIES = 3;
const RETRY_MS = 1500;

function needSession(deps) {
  const session = deps.session();
  if (!session) {
    const err = new Error('Sign in (Account tab) to share a list');
    err.needsSignIn = true;
    throw err;
  }
  return session;
}

/** The link already made for this list, or null. */
export async function findShare(id, deps) {
  const { token } = needSession(deps);
  const { shares } = await deps.request('/share', { method: 'GET', token });
  return (shares || []).find((s) => s.id === id) || null;
}

// Syncs, then runs `ask` (a request), and when the account says it hasn't got the list yet (404) syncs and asks again,
// a few times at most.
async function afterSync(deps, ask) {
  for (let attempt = 1; ; attempt++) {
    try {
      await deps.sync();  // gets the latest edits to the account first
    } catch (e) { /* the service answers below if it still hasn't got the list */ }
    try {
      return await ask();
    } catch (err) {
      if (err.status !== 404 || attempt >= RETRIES) throw err;
      await deps.wait(RETRY_MS);
    }
  }
}

/** Makes the link for this list (or returns the one it has); `renew` swaps it for a new one, so the old one stops working. */
export async function createShare(id, deps, { renew = false } = {}) {
  const { token } = needSession(deps);
  return afterSync(deps, () => deps.request('/share', { token, body: renew ? { id, renew: true } : { id } }));
}

/** Stops sharing: the link stops working straight away. */
export async function stopShare(id, deps) {
  const { token } = needSession(deps);
  await deps.request('/share/revoke', { token, body: { id } });
}

// ---- public pages: /<username>/wishlist and /<username>/tradelist (only those two lists can have one) ----------------

/** The public page this kind of list has ({ kind, id, url }), or null. */
export async function findPublic(kind, deps) {
  const { token } = needSession(deps);
  const { public: pages } = await deps.request('/public', { method: 'GET', token });
  return (pages || []).find((p) => p.kind === kind) || null;
}

/** Makes this list the public page for its kind (the address is the person's username plus the kind). */
export async function publishList(id, deps) {
  const { token } = needSession(deps);
  return afterSync(deps, () => deps.request('/public', { token, body: { id } }));
}

/** Takes the public page of a kind down: its address stops working straight away. */
export async function unpublishList(kind, deps) {
  const { token } = needSession(deps);
  await deps.request('/public/revoke', { token, body: { kind } });
}
