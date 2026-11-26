/**
 * links.js
 * Sending a person to a page outside the app: Stripe's payment page, a shipping label, a carrier's tracking page. The website
 * just goes there (a payment in the same tab, so the browser's back button and the return address both work); the apps hand
 * the page to the system browser, which only opens the shop's own pages (see open_url.cpp / MainActivity.kt / BinderViewController.mm).
 */
import { IS_WEB } from './env.js';
import { openExternal } from './updates.js';

/** Where a payment ends up opening: the same tab on the website, the system browser in the apps. */
export function goToPayment(url) {
  if (IS_WEB) window.location.assign(url);
  else openExternal(url);
}

/** A label or tracking page: a new tab on the website, the system browser in the apps. */
export function openLink(url) {
  if (!url) return;
  if (IS_WEB) window.open(url, '_blank', 'noopener');
  else openExternal(url);
}
