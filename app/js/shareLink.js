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

/** Makes the link for this list (or returns the one it has); `renew` swaps it for a new one, so the old one stops working. */
export async function createShare(id, deps, { renew = false } = {}) {
  const { token } = needSession(deps);
  for (let attempt = 1; ; attempt++) {
    try {
      await deps.sync();  // gets the latest edits to the account first
    } catch (e) { /* the service answers below if it still hasn't got the list */ }
    try {
      return await deps.request('/share', { token, body: renew ? { id, renew: true } : { id } });
    } catch (err) {
      if (err.status !== 404 || attempt >= RETRIES) throw err;
      await deps.wait(RETRY_MS);
    }
  }
}

/** Stops sharing: the link stops working straight away. */
export async function stopShare(id, deps) {
  const { token } = needSession(deps);
  await deps.request('/share/revoke', { token, body: { id } });
}
