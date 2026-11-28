/**
 * cartView.js
 * The cart and checkout. The cart lives on the account (so it follows a person between devices); this file keeps a copy for the
 * badge on the market page and draws the cart and checkout sheets. Paying happens on Stripe's own page (or PayPal's): the person
 * is sent there and comes back to "/?checkout=success&order=..." (handleCheckoutReturn). Card numbers are never typed into Binder.
 */
import { addressFormHtml, addressSuggestions, readAddressForm, wireAddressForm } from './addressForm.js';
import { artHtml, escapeHtml, usd } from './dom.js';
import { goToPayment } from './links.js';
import { getSession } from './session.js';
import { openSheet } from './sheet.js';
import { getSellerState } from './shop.js';
import { shopApi } from './shopApi.js';
import { cleanShipTo } from './shopInput.js';
import { showToast } from './ui.js';

let cart = null;   // the last cart the service sent: { items, groups, itemsCents, cardCount }

const badge = () => document.getElementById('market-cart-count');

function updateBadge() {
  const el = badge();
  if (!el) return;
  const n = cartCount();
  el.textContent = n > 99 ? '99+' : String(n);
  el.classList.toggle('hidden', n === 0);
}

/** How many cards are in the cart that can still be bought. */
export function cartCount() {
  return cart ? cart.items.reduce((n, i) => n + (i.unavailable ? 0 : Math.min(i.qty, i.available)), 0) : 0;
}

/** How many of one listing are in the cart. */
export function cartQty(listingId) {
  const item = cart && cart.items.find((i) => i.listingId === listingId);
  return item ? item.qty : 0;
}

async function apply(promise) {
  cart = await promise;
  updateBadge();
  return cart;
}

/** Sets how many of a listing are in the cart (0 takes it out). Throws the service's message when it can't. */
export function changeCart(listingId, qty) {
  return apply(shopApi.setCart(listingId, qty));
}

export async function refreshCart() {
  if (!getSession()) {
    cart = null;
    updateBadge();
    return null;
  }
  try {
    return await apply(shopApi.cart());
  } catch (e) {
    return cart;
  }
}

function goToSettings(section) {
  window.dispatchEvent(new CustomEvent('binder:goto', { detail: { tab: 'settings', section } }));
}

/** True when signed in; otherwise says so and points at the Account section. */
export function requireSignIn(what = 'buy') {
  if (getSession()) return true;
  showToast(`Sign in (Account section) to ${what}`, 3200);
  goToSettings('account');
  return false;
}

export function initCart() {
  const button = document.getElementById('market-cart');
  if (button) button.addEventListener('click', () => openCart());
  window.addEventListener('binder:session', () => refreshCart());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshCart(); });   // the cart changes after paying
  refreshCart();
}

// ---- the cart sheet -----------------------------------------------------------------------------------------------------------

function lineHtml(item) {
  const l = item.listing;
  const buyable = !item.unavailable;
  const note = item.unavailable
    ? '<span class="cart-warn">No longer for sale</span>'
    : item.short
      ? `<span class="cart-warn">Only ${item.available} left</span>`
      : '';
  return `
    <div class="cart-line${buyable ? '' : ' is-gone'}" data-id="${escapeHtml(item.listingId)}">
      <span class="cart-art">${artHtml(l && l.image, l && l.name)}</span>
      <span class="cart-line-main">
        <span class="cart-line-name">${escapeHtml(l ? l.name : 'A card')}</span>
        <span class="cart-line-meta">${l ? `${escapeHtml(l.condition)}${l.foil ? ' · Foil' : ''}${l.set ? ` · ${escapeHtml(l.set)} ${escapeHtml(l.number)}` : ''}` : ''}</span>
        ${note}
      </span>
      <span class="cart-line-side">
        <span class="cart-line-price">${buyable ? usd(item.lineCents) : ''}</span>
        ${buyable
          ? `<span class="stepper"><button type="button" data-act="dec" aria-label="One fewer">&minus;</button><span>${item.qty}</span><button type="button" data-act="inc" aria-label="One more">+</button></span>`
          : '<button type="button" class="link-btn" data-act="remove">Remove</button>'}
      </span>
    </div>`;
}

function cartHtml() {
  if (!cart || !cart.items.length) {
    return `<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24"><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.7 12.4a2 2 0 002 1.6h8.1a2 2 0 002-1.6L21 7H6"/></svg></div>
      <h2>Your cart is empty</h2><p>Search for a card and add an offer to your cart.</p></div>`;
  }
  const bySeller = new Map();
  for (const item of cart.items) {
    const key = item.listing ? item.listing.seller : '';
    if (!bySeller.has(key)) bySeller.set(key, []);
    bySeller.get(key).push(item);
  }
  const groups = [...bySeller.entries()].map(([seller, items]) => `
    <div class="cart-group">
      <p class="cart-seller">${seller ? `From <strong>${escapeHtml(seller)}</strong>` : 'No longer for sale'}</p>
      ${items.map(lineHtml).join('')}
    </div>`).join('');
  const blocked = cart.items.some((i) => i.unavailable || i.short);
  return `
    ${groups}
    <div class="cart-total"><span>Cards (${cart.cardCount})</span><strong>${usd(cart.itemsCents)}</strong></div>
    <p class="field-hint">Shipping is worked out at checkout, once we know where it is going. Prices are in US dollars.</p>
    ${blocked ? '<p class="field-hint field-hint--error">Fix the highlighted lines before checking out.</p>' : ''}
    <div class="sheet-actions">
      <button class="btn btn-secondary" type="button" data-act="clear">Empty cart</button>
      <button class="btn btn-primary" type="button" data-act="checkout" ${blocked || !cart.cardCount ? 'disabled' : ''}>Checkout</button>
    </div>`;
}

export async function openCart() {
  if (!requireSignIn('use the cart')) return;
  const sheet = openSheet({ title: 'Your cart' });
  sheet.body.innerHTML = '<p class="setting-hint">Loading your cart…</p>';
  await refreshCart();
  const draw = () => { sheet.body.innerHTML = cartHtml(); };
  draw();
  sheet.body.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-act]');
    if (!button) return;
    const act = button.dataset.act;
    const row = button.closest('.cart-line');
    try {
      if (act === 'checkout') { openCheckout(sheet); return; }
      if (act === 'clear') { await apply(shopApi.clearCart()); draw(); return; }
      const id = row && row.dataset.id;
      const item = cart && cart.items.find((i) => i.listingId === id);
      if (!item) return;
      if (act === 'remove') await changeCart(id, 0);
      if (act === 'dec') await changeCart(id, item.qty - 1);
      if (act === 'inc') {
        if (item.qty >= item.available) { showToast("That's all they have", 2200); return; }
        await changeCart(id, item.qty + 1);
      }
      draw();
    } catch (err) {
      showToast(err.message || "Couldn't change the cart", 3200);
    }
  });
}

// ---- checkout ---------------------------------------------------------------------------------------------------------------

function quoteHtml(quote) {
  const groups = quote.groups.map((g) => `
    <div class="cart-group">
      <p class="cart-seller">From <strong>${escapeHtml(g.seller)}</strong></p>
      ${g.lines.map((l) => `<div class="quote-row"><span>${l.qty} × ${escapeHtml(l.name)}</span><span>${usd(l.qty * l.priceCents)}</span></div>`).join('')}
      <div class="quote-row quote-row--ship"><span>Shipping${g.shippingService ? ` · ${escapeHtml(g.shippingService)}` : ''}${g.shippingMode === 'shippo' ? ' (estimate)' : ''}</span><span>${usd(g.shippingCents)}</span></div>
    </div>`).join('');
  const problems = quote.problems.map((p) => `<p class="field-hint field-hint--error">${escapeHtml(p)}</p>`).join('');
  return `
    ${groups}
    <div class="cart-total"><span>Total (US dollars)</span><strong>${usd(quote.totalCents)}</strong></div>
    ${problems}
    <p class="field-hint">You will enter your card on Stripe's secure page. There you can choose to <strong>save your card for next time</strong>, or leave that box empty and nothing is kept.</p>`;
}

/** The checkout sheet: where it goes, what shipping costs, then off to Stripe (or PayPal) to pay. */
export async function openCheckout(cartSheet) {
  const sheet = openSheet({ title: 'Checkout' });
  sheet.body.innerHTML = '<p class="setting-hint">Loading…</p>';
  let buyer;
  try {
    buyer = await shopApi.buyer();
  } catch (err) {
    sheet.body.innerHTML = `<p class="field-hint field-hint--error">${escapeHtml(err.message || "Couldn't load checkout")}</p>`;
    return;
  }
  let address = buyer.address;
  const payments = buyer.payments || {};

  const drawAddress = (error = '') => {
    sheet.body.innerHTML = `
      <h3 class="checkout-step">1. Where should it go?</h3>
      <div id="checkout-address">${addressFormHtml(address)}</div>
      <p class="field-hint field-hint--error ${error ? '' : 'hidden'}" id="checkout-error">${escapeHtml(error)}</p>
      <div class="sheet-actions"><button class="btn btn-primary" type="button" id="checkout-review">Review shipping and total</button></div>`;
    wireAddressForm(sheet.body.querySelector('#checkout-address'), addressSuggestions(buyer.address, getSellerState().seller));
    sheet.body.querySelector('#checkout-review').addEventListener('click', review);
  };

  async function review() {
    const typed = readAddressForm(sheet.body.querySelector('#checkout-address'));
    const checked = cleanShipTo(typed);
    if (checked.error) { drawAddressKeep(typed, checked.error); return; }
    address = checked.address;
    sheet.body.querySelector('#checkout-review').disabled = true;
    try {
      const quote = await shopApi.quote(address);
      drawReview(quote);
    } catch (err) {
      drawAddressKeep(typed, err.message || "Couldn't work out the shipping");
    }
  }
  const drawAddressKeep = (typed, error) => {
    address = typed;
    drawAddress(error);
  };

  function drawReview(quote) {
    const blocked = quote.problems.length > 0;
    sheet.body.innerHTML = `
      <h3 class="checkout-step">2. Review and pay</h3>
      <p class="field-hint">Ship to: ${escapeHtml(address.name)}, ${escapeHtml(address.line1)}${address.line2 ? `, ${escapeHtml(address.line2)}` : ''}, ${escapeHtml(address.city)} ${escapeHtml(address.region)} ${escapeHtml(address.postal)} <button class="link-btn" type="button" id="checkout-edit">Change</button></p>
      ${quoteHtml(quote)}
      <div class="sheet-actions sheet-actions--stack">
        <button class="btn btn-primary" type="button" data-pay="stripe" ${blocked || !payments.stripe ? 'disabled' : ''}>Pay ${usd(quote.totalCents)} with card</button>
        ${payments.paypal ? `<button class="btn btn-secondary" type="button" data-pay="paypal" ${blocked ? 'disabled' : ''}>PayPal or Venmo</button>` : ''}
      </div>
      ${!payments.stripe ? `<p class="field-hint field-hint--error">${escapeHtml(payments.stripeProblem || "Payments aren't switched on yet")}</p>` : ''}`;
    sheet.body.querySelector('#checkout-edit').addEventListener('click', () => drawAddress());
    sheet.body.querySelectorAll('[data-pay]').forEach((button) => button.addEventListener('click', () => pay(button.dataset.pay, button)));
  }

  async function pay(provider, button) {
    sheet.body.querySelectorAll('[data-pay]').forEach((b) => { b.disabled = true; });
    button.textContent = 'Opening the payment page…';
    try {
      const { url } = await shopApi.checkout(address, provider);
      goToPayment(url);
      showToast('Finish paying on the page that opened, then come back', 4500);
      sheet.close();
      if (cartSheet) cartSheet.close();
    } catch (err) {
      showToast(err.message || "Couldn't start the payment", 4500);
      try { drawReview(await shopApi.quote(address)); } catch (e) { drawAddress(err.message || ''); }
    }
  }

  drawAddress();
}

// ---- coming back from the payment page ---------------------------------------------------------------------------------------

/**
 * Called once when the app starts: if the address says the person just came back from paying ("/?checkout=success&order=...",
 * or "...=cancel"), checks on the order and says what happened. Returns true when it handled a return.
 */
export async function handleCheckoutReturn() {
  let params;
  try {
    params = new URL(window.location.href).searchParams;
  } catch (e) {
    return false;
  }
  const result = params.get('checkout');
  const order = params.get('order');
  if (!result || !order) return false;
  try {
    const url = new URL(window.location.href);
    ['checkout', 'order', 'session_id', 'token', 'PayerID'].forEach((k) => url.searchParams.delete(k));
    window.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
  } catch (e) { /* the address stays as it was */ }
  if (!getSession()) return true;
  try {
    if (result === 'success') {
      const { order: synced } = await shopApi.syncOrder(order, !!(params.get('PayerID') || params.get('token')));
      showToast(synced.status === 'paid' ? 'Payment received. Thank you!' : 'Your payment is still being confirmed: check Orders in a moment', 5000);
    } else {
      await shopApi.abandonOrder(order);
      showToast('Payment cancelled: nothing was charged', 4000);
    }
  } catch (err) {
    showToast(err.message || "Couldn't check on that payment", 4500);
  }
  await refreshCart();
  window.dispatchEvent(new CustomEvent('binder:goto', { detail: { tab: 'settings', section: 'orders' } }));
  return true;
}
