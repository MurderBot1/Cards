/**
 * shop.js
 * The Shop tab, so far: registering as a seller. A signed-in person gives their full legal name, address and phone and says how
 * they want to be paid (bank account or debit card through Stripe, Venmo, or PayPal); the account service keeps that for them
 * alone. Card and bank numbers are never typed into Binder: Stripe's own pages collect the ID check and the payout account, and
 * the app only ever sees whether that is done. (Browsing, the cart and checkout come in later releases.)
 */
import { accountRequest } from './api.js';
import { getSession } from './session.js';
import { IS_WEB } from './env.js';
import { showToast } from './ui.js';
import { openExternal } from './updates.js';
import { SELLER_COUNTRIES, cleanSeller, countryName, sellerStatus } from './sellerProfile.js';

const $ = (id) => document.getElementById(id);
const els = {
  card: $('seller-card'), title: $('seller-title'), sub: $('seller-sub'), detail: $('seller-detail'),
  open: $('seller-open'), stripe: $('seller-stripe'),
  modal: $('modal-seller'), sheetTitle: $('seller-sheet-title'),
  name: $('seller-name'), phone: $('seller-phone'), line1: $('seller-line1'), line2: $('seller-line2'),
  city: $('seller-city'), region: $('seller-region'), postal: $('seller-postal'), country: $('seller-country'),
  payout: $('seller-payout'), payoutHint: $('seller-payout-hint'), payoutRef: $('seller-payout-ref'),
  error: $('seller-error'), cancel: $('seller-cancel'), save: $('seller-save'), remove: $('seller-remove'),
};

let seller = null;     // the registered profile, or null
let payments = null;   // what the service can do: { stripe, stripeProblem, ... }
let loaded = false;
let payoutKind = 'stripe';

const regionNames = (() => { try { return new Intl.DisplayNames(undefined, { type: 'region' }); } catch (e) { return null; } })();

function render() {
  const session = getSession();
  els.card.classList.remove('is-ready');
  els.detail.classList.add('hidden');
  els.stripe.classList.add('hidden');
  els.open.classList.add('hidden');
  if (!session) {
    els.title.textContent = 'Sell your cards';
    els.sub.textContent = 'Sign in (Account tab) to register as a seller.';
    return;
  }
  if (!loaded) {
    els.title.textContent = 'Sell your cards';
    els.sub.textContent = 'Checking your seller profile…';
    return;
  }
  if (!seller) {
    els.title.textContent = 'Sell your cards';
    els.sub.textContent = 'Register as a seller with your legal name, address, phone and how you want to be paid.';
    els.open.textContent = 'Register to sell';
    els.open.classList.remove('hidden');
    return;
  }
  const status = sellerStatus(seller, payments);
  els.title.textContent = seller.legalName;
  els.sub.textContent = status.headline;
  els.detail.textContent = status.detail;
  els.detail.classList.remove('hidden');
  els.card.classList.toggle('is-ready', status.ready);
  els.stripe.classList.toggle('hidden', !status.needsStripe);
  els.stripe.textContent = seller.stripe && seller.stripe.account ? 'Continue payout setup with Stripe' : 'Set up payouts with Stripe';
  els.open.textContent = 'Edit my details';
  els.open.classList.remove('hidden');
}

async function load() {
  const session = getSession();
  if (!session) {
    seller = null;
    loaded = false;
    render();
    return;
  }
  try {
    const data = await accountRequest('/seller', { method: 'GET', token: session.token });
    seller = data.seller;
    payments = data.payments;
    loaded = true;
  } catch (err) {
    loaded = false;
    els.sub.textContent = err.offline ? "You're offline" : err.message;
    return;
  }
  render();
}

/** Called when the Shop tab is shown. */
export function refreshShop() {
  return load();
}

// ---- the registration sheet ---------------------------------------------------------------------------------------

function setPayout(kind) {
  payoutKind = kind;
  els.payout.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('is-selected', b.dataset.value === kind);
    b.setAttribute('aria-selected', String(b.dataset.value === kind));
  });
  els.payoutRef.classList.toggle('hidden', kind === 'stripe');
  els.payoutRef.type = kind === 'paypal' ? 'email' : 'tel';
  els.payoutRef.placeholder = kind === 'paypal' ? 'you@example.com' : 'Phone number your Venmo account uses';
  els.payoutHint.textContent =
    kind === 'stripe'
      ? "Stripe pays you to your bank account or debit card, and asks for your ID and those details on its own page after this. (Credit cards can't receive payouts; they are for buying.)"
      : kind === 'venmo'
        ? 'Venmo payouts are for sellers in the United States. Leave this empty to use your phone number above.'
        : 'The email address of your PayPal account.';
}

function fillCountries() {
  if (els.country.options.length) return;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Country';
  els.country.appendChild(placeholder);
  const rows = SELLER_COUNTRIES.map((code) => ({ code, name: countryName(code, regionNames) })).sort((a, b) => a.name.localeCompare(b.name));
  for (const row of rows) {
    const opt = document.createElement('option');
    opt.value = row.code;
    opt.textContent = row.name;
    els.country.appendChild(opt);
  }
}

function showError(message) {
  els.error.textContent = message;
  els.error.classList.toggle('hidden', !message);
}

function openSheet() {
  if (!getSession()) {
    showToast('Sign in (Account tab) to register as a seller', 3000);
    return;
  }
  fillCountries();
  showError('');
  const s = seller;
  els.sheetTitle.textContent = s ? 'Your seller details' : 'Register to sell';
  els.name.value = s ? s.legalName : '';
  els.phone.value = s ? s.phone : '';
  els.line1.value = s ? s.address.line1 : '';
  els.line2.value = s ? s.address.line2 : '';
  els.city.value = s ? s.address.city : '';
  els.region.value = s ? s.address.region : '';
  els.postal.value = s ? s.address.postal : '';
  els.country.value = s ? s.address.country : '';
  els.payoutRef.value = s && s.payout.kind !== 'stripe' ? s.payout.ref : '';
  setPayout(s ? s.payout.kind : 'stripe');
  els.remove.classList.toggle('hidden', !s);
  els.remove.textContent = 'Remove my seller profile';
  els.save.disabled = false;
  els.modal.classList.remove('hidden');
}
function closeSheet() {
  els.modal.classList.add('hidden');
}

function formBody() {
  return {
    legalName: els.name.value,
    phone: els.phone.value,
    address: { line1: els.line1.value, line2: els.line2.value, city: els.city.value, region: els.region.value, postal: els.postal.value, country: els.country.value },
    payout: { kind: payoutKind, ref: els.payoutRef.value },
  };
}

async function save() {
  const checked = cleanSeller(formBody());
  if (checked.error) {
    showError(checked.error);
    return;
  }
  showError('');
  els.save.disabled = true;
  try {
    const data = await accountRequest('/seller', { token: getSession().token, body: checked.seller });
    seller = data.seller;
    payments = data.payments;
    loaded = true;
    closeSheet();
    render();
    showToast(sellerStatus(seller, payments).ready ? "You're set up to sell" : 'Seller details saved', 3000);
  } catch (err) {
    showError(err.message || "Couldn't save that");
  } finally {
    els.save.disabled = false;
  }
}

let removeArmed = 0;
async function remove() {
  if (!removeArmed || Date.now() - removeArmed > 4000) {  // a second tap within a few seconds confirms
    removeArmed = Date.now();
    els.remove.textContent = 'Tap again to remove it';
    return;
  }
  removeArmed = 0;
  try {
    await accountRequest('/seller/delete', { token: getSession().token, body: {} });
    seller = null;
    closeSheet();
    render();
    showToast('Your seller profile was removed', 3000);
  } catch (err) {
    showError(err.message || "Couldn't remove it");
  }
}

// ---- Stripe's own page for the ID check and the payout account -----------------------------------------------------

function openPage(url) {
  if (IS_WEB) window.location.assign(url);
  else openExternal(url);
}

async function startStripe() {
  els.stripe.disabled = true;
  try {
    const { url } = await accountRequest('/seller/stripe', { token: getSession().token, body: {} });
    openPage(url);
  } catch (err) {
    showToast(err.message || "Couldn't start Stripe", 4000);
  } finally {
    els.stripe.disabled = false;
  }
}

export function initShop() {
  els.open.addEventListener('click', openSheet);
  els.stripe.addEventListener('click', startStripe);
  els.cancel.addEventListener('click', closeSheet);
  els.modal.addEventListener('click', (e) => { if (e.target === els.modal) closeSheet(); });
  els.save.addEventListener('click', save);
  els.remove.addEventListener('click', remove);
  els.payout.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setPayout(b.dataset.value)));
  window.addEventListener('binder:session', () => { seller = null; loaded = false; render(); load(); });
  render();
  load();
  // coming back from Stripe's page (the website opens it in this tab): "/?seller=return" or "/?seller=refresh"
  try {
    const url = new URL(window.location.href);
    const back = url.searchParams.get('seller');
    if (back) {
      url.searchParams.delete('seller');
      window.history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
      showToast(back === 'return' ? 'Welcome back from Stripe' : 'Stripe asked to start that page again: tap the button to continue', 3500);
    }
  } catch (e) { /* the address stays as it was */ }
}
