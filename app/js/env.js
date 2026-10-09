/**
 * env.js
 * Whether the app is running as the website (served from the account service's address, with no local backend and no
 * camera features) or as the real app (desktop, Android or iOS, which all serve the page from localhost). The website
 * keeps collections in the browser's storage (webstore.js), searches the card sites directly (cardSearch.js) and
 * leaves out scanning and app updates. Opening any page with ?web=1 on localhost previews it.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isWebHost(hostname, search = '') {
  if (/(^|[?&])web=1(&|$)/.test(search)) return true;
  return !!hostname && !LOOPBACK.has(hostname);
}

export const IS_WEB = typeof location !== 'undefined' && isWebHost(location.hostname, location.search);

if (IS_WEB && typeof document !== 'undefined') document.documentElement.classList.add('is-web');
