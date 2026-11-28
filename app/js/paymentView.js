/**
 * paymentView.js
 * "Shipping & saved cards" in Settings: the address orders go to, and the cards the person chose to save on Stripe's payment page.
 * Binder never sees a card number: Stripe tells us only the brand, last four digits and expiry, which is all that is shown here.
 */
import { addressFormHtml, addressLine, addressSuggestions, readAddressForm, wireAddressForm } from './addressForm.js';
import { escapeHtml } from './dom.js';
import { getSession } from './session.js';
import { openSheet } from './sheet.js';
import { getSellerState } from './shop.js';
import { shopApi } from './shopApi.js';
import { cleanShipTo } from './shopInput.js';
import { showToast } from './ui.js';

let root = null;
let buyer = null;
let error = '';

const brandName = (b) => ({ visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', jcb: 'JCB', diners: 'Diners Club', unionpay: 'UnionPay' })[b] || (b ? b[0].toUpperCase() + b.slice(1) : 'Card');

function draw() {
  if (!root) return;
  if (!getSession()) { root.innerHTML = '<p class="setting-hint">Sign in to keep a shipping address and saved cards.</p>'; return; }
  if (error) { root.innerHTML = `<p class="field-hint field-hint--error">${escapeHtml(error)}</p>`; return; }
  if (!buyer) { root.innerHTML = '<p class="setting-hint">Loading…</p>'; return; }
  const cards = buyer.methods.length
    ? buyer.methods.map((m) => `
        <div class="saved-card"><span class="saved-card-name">${escapeHtml(brandName(m.brand))} ending ${escapeHtml(m.last4)}</span><span class="cart-line-meta">expires ${String(m.expMonth).padStart(2, '0')}/${String(m.expYear).slice(-2)}</span>
        <button class="link-btn link-btn--danger" type="button" data-act="remove-card" data-id="${escapeHtml(m.id)}">Remove</button></div>`).join('')
    : '<p class="setting-hint">No saved cards. When you pay, Stripe\'s page has a box to save your card for next time; leave it empty and nothing is kept.</p>';
  root.innerHTML = `
    <div class="setting-row">
      <div class="setting-label"><span>Shipping address</span><span class="setting-hint">${buyer.address ? escapeHtml(addressLine(buyer.address)) : 'None saved yet. It is saved when you check out.'}</span></div>
      <div class="setting-actions">
        <button class="btn btn-secondary btn-small" type="button" data-act="edit-address">${buyer.address ? 'Change' : 'Add an address'}</button>
        ${buyer.address ? '<button class="link-btn link-btn--danger" type="button" data-act="remove-address">Delete</button>' : ''}
      </div>
    </div>
    <div class="setting-row setting-row--stack"><div class="setting-label"><span>Saved cards</span></div>${cards}</div>`;
}

export async function refreshPayment() {
  if (!root) return;
  error = '';
  if (!getSession()) { buyer = null; draw(); return; }
  try {
    buyer = await shopApi.buyer();
  } catch (err) {
    error = err.offline ? "You're offline" : err.message || "Couldn't load your details";
  }
  draw();
}

function editAddress() {
  const sheet = openSheet({ title: 'Shipping address' });
  sheet.body.innerHTML = `
    <div data-role="form">${addressFormHtml(buyer && buyer.address)}</div>
    <p class="field-hint field-hint--error hidden" data-role="error"></p>
    <div class="sheet-actions"><button class="btn btn-secondary" type="button" data-role="cancel">Cancel</button><button class="btn btn-primary" type="button" data-role="save">Save</button></div>`;
  wireAddressForm(sheet.body.querySelector('[data-role="form"]'), addressSuggestions(null, getSellerState().seller));
  const err = sheet.body.querySelector('[data-role="error"]');
  sheet.body.querySelector('[data-role="cancel"]').addEventListener('click', () => sheet.close());
  const save = sheet.body.querySelector('[data-role="save"]');
  save.addEventListener('click', async () => {
    const checked = cleanShipTo(readAddressForm(sheet.body.querySelector('[data-role="form"]')));
    const show = (m) => { err.textContent = m; err.classList.toggle('hidden', !m); };
    if (checked.error) { show(checked.error); return; }
    save.disabled = true;
    try {
      buyer = await shopApi.saveAddress(checked.address);
      sheet.close();
      showToast('Address saved', 2400);
      draw();
    } catch (e) {
      show(e.message || "Couldn't save that");
      save.disabled = false;
    }
  });
}

export function initPayment() {
  root = document.getElementById('payment-root');
  if (!root) return;
  root.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-act]');
    if (!button) return;
    if (button.dataset.act === 'edit-address') editAddress();
    if (button.dataset.act === 'remove-address') {
      if (button.dataset.armed !== '1') {
        button.dataset.armed = '1';
        button.textContent = 'Tap again';
        setTimeout(() => { button.dataset.armed = ''; if (button.isConnected) button.textContent = 'Delete'; }, 3500);
        return;
      }
      try {
        buyer = await shopApi.removeAddress();
        draw();
        showToast('Address deleted', 2400);
      } catch (err) {
        showToast(err.message || "Couldn't delete it", 3500);
      }
    }
    if (button.dataset.act === 'remove-card') {
      if (button.dataset.armed !== '1') {
        button.dataset.armed = '1';
        button.textContent = 'Tap again';
        setTimeout(() => { button.dataset.armed = ''; if (button.isConnected) button.textContent = 'Remove'; }, 3500);
        return;
      }
      try {
        buyer = await shopApi.removeMethod(button.dataset.id);
        draw();
        showToast('Card removed', 2400);
      } catch (err) {
        showToast(err.message || "Couldn't remove it", 3500);
      }
    }
  });
  window.addEventListener('binder:session', () => { buyer = null; draw(); });
  window.addEventListener('binder:settings-open', (e) => { if (e.detail === 'payment') refreshPayment(); });
  draw();
}
