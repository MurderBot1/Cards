/**
 * ordersView.js
 * The Orders section of Settings: what the signed-in person has bought, with each seller's parcel, its status and its tracking
 * (a link to the carrier's page); and, for a seller, what they have sold, with what to do next (buy a label through Binder, or type
 * in the tracking number of a parcel they posted themselves). Money is held until a parcel is delivered, then paid to the seller.
 */
import { artHtml, escapeHtml, usd } from './dom.js';
import { openLink } from './links.js';
import { dateText, groupStatusText, orderStatusText, progressSteps, saleStatusText, sellerNextStep, trackingText } from './orderText.js';
import { getSession } from './session.js';
import { openSheet } from './sheet.js';
import { shopApi } from './shopApi.js';
import { showToast } from './ui.js';

let root = null;
let orders = [];
let sales = [];
let state = 'idle';   // 'idle' | 'loading' | 'error'
let errorText = '';

const stepsHtml = (group) => {
  const steps = progressSteps(group);
  return steps.length
    ? `<ol class="steps">${steps.map((s) => `<li class="${s.done ? 'is-done' : ''}">${escapeHtml(s.label)}</li>`).join('')}</ol>`
    : '';
};

const linesHtml = (lines) => lines
  .map((l) => `<div class="order-line"><span class="cart-art cart-art--small">${artHtml(l.image, l.name)}</span><span>${l.qty} × ${escapeHtml(l.name)}${l.foil ? ' (Foil)' : ''}<span class="cart-line-meta"> ${escapeHtml(l.condition)}${l.set ? ` · ${escapeHtml(l.set)} ${escapeHtml(l.number)}` : ''}</span></span><span class="order-line-price">${usd(l.qty * l.priceCents)}</span></div>`)
  .join('');

function trackingHtml(g, { seller = false } = {}) {
  if (!g.trackingNumber) return '';
  return `
    <div class="tracking">
      <p class="tracking-status">${escapeHtml(trackingText(g))}</p>
      <p class="tracking-line">${escapeHtml((g.carrier || '').toUpperCase())} <span class="tracking-number">${escapeHtml(g.trackingNumber)}</span>
        ${g.trackingUrl ? `<button class="link-btn" type="button" data-act="track" data-url="${escapeHtml(g.trackingUrl)}">Track</button>` : ''}
        ${seller && g.labelUrl ? `<button class="link-btn" type="button" data-act="label" data-url="${escapeHtml(g.labelUrl)}">Print label</button>` : ''}</p>
    </div>`;
}

// ---- as a buyer -----------------------------------------------------------------------------------------------------------------

function orderHtml(o) {
  const groups = o.groups.map((g) => `
    <div class="order-group" data-gid="${escapeHtml(g.id)}">
      <div class="order-group-head"><span>From <strong>${escapeHtml(g.seller)}</strong></span><span class="pill">${escapeHtml(groupStatusText(g))}</span></div>
      ${stepsHtml(g)}
      ${linesHtml(g.lines)}
      ${trackingHtml(g)}
      <div class="order-actions">
        ${g.canConfirm ? '<button class="btn btn-secondary btn-small" type="button" data-act="received">I received it</button>' : ''}
        ${g.canCancel ? '<button class="btn btn-secondary btn-small" type="button" data-act="cancel">Cancel &amp; refund</button>' : ''}
      </div>
    </div>`).join('');
  return `
    <div class="order">
      <div class="order-head"><span>${escapeHtml(dateText(o.createdAt))} · ${escapeHtml(orderStatusText(o))}</span><strong>${usd(o.totalCents)}</strong></div>
      ${o.resumeUrl ? `<p class="field-hint">Not paid yet. <button class="link-btn" type="button" data-act="resume" data-url="${escapeHtml(o.resumeUrl)}">Finish paying</button></p>` : ''}
      ${groups}
      <p class="field-hint">Ships to ${escapeHtml(o.shipTo.name)}, ${escapeHtml(o.shipTo.line1)}, ${escapeHtml(o.shipTo.city)} ${escapeHtml(o.shipTo.region)}. Items ${usd(o.itemsCents)} + shipping ${usd(o.shippingCents)}.</p>
    </div>`;
}

// ---- as a seller ----------------------------------------------------------------------------------------------------------------

function saleHtml(s) {
  const to = s.shipTo;
  const actions = [];
  if (s.canShip) {
    actions.push('<button class="btn btn-primary btn-small" type="button" data-act="buy-label">Buy shipping label</button>');
    actions.push('<button class="btn btn-secondary btn-small" type="button" data-act="add-tracking">I have a tracking number</button>');
  }
  if (s.canRefund) actions.push('<button class="btn btn-secondary btn-small" type="button" data-act="refund">Refund buyer</button>');
  return `
    <div class="order sale" data-gid="${escapeHtml(s.id)}">
      <div class="order-head"><span>${escapeHtml(dateText(s.paidAt))} · to ${escapeHtml(s.buyer)}</span><span class="pill">${escapeHtml(saleStatusText(s))}</span></div>
      ${stepsHtml(s)}
      ${linesHtml(s.lines)}
      <div class="ship-to"><p class="ship-to-title">Ship to</p>
        <p>${escapeHtml(to.name)}<br>${escapeHtml(to.line1)}${to.line2 ? `<br>${escapeHtml(to.line2)}` : ''}<br>${escapeHtml(to.city)} ${escapeHtml(to.region)} ${escapeHtml(to.postal)}${to.phone ? `<br>${escapeHtml(to.phone)}` : ''}</p></div>
      ${trackingHtml(s, { seller: true })}
      <p class="field-hint">${escapeHtml(sellerNextStep(s))} You receive <strong>${usd(s.payoutCents)}</strong> ${s.shipMode === 'flat' && s.trackingMode !== 'shippo' ? '(including the shipping the buyer paid, if you post it yourself)' : '(Binder\'s fee taken out)'}.</p>
      <div class="order-actions">${actions.join('')}</div>
    </div>`;
}

// ---- drawing and acting ---------------------------------------------------------------------------------------------------------

function draw() {
  if (!root) return;
  if (!getSession()) { root.innerHTML = '<p class="setting-hint">Sign in to see your orders.</p>'; return; }
  if (state === 'loading' && !orders.length && !sales.length) { root.innerHTML = '<p class="setting-hint">Loading your orders…</p>'; return; }
  if (state === 'error') { root.innerHTML = `<p class="field-hint field-hint--error">${escapeHtml(errorText)}</p>`; return; }
  const bought = orders.length
    ? orders.map(orderHtml).join('')
    : '<p class="setting-hint">No orders yet. When you buy a card it shows up here with its tracking.</p>';
  root.innerHTML = `
    <h4 class="orders-title">Your orders</h4>
    ${bought}
    ${sales.length ? `<h4 class="orders-title">Your sales</h4>${sales.map(saleHtml).join('')}` : ''}`;
}

/** Fetches orders and sales and draws them. */
export async function refreshOrders() {
  if (!root) return;
  if (!getSession()) { orders = []; sales = []; draw(); return; }
  state = 'loading';
  draw();
  try {
    const [bought, sold] = await Promise.all([shopApi.orders(), shopApi.sales().catch(() => ({ sales: [] }))]);
    orders = bought.orders;
    sales = sold.sales;
    state = 'idle';
    // In the apps the person pays in the system browser and comes back by hand: ask the payment provider about any order still
    // waiting for its money, so it shows as paid without waiting for a webhook.
    const waiting = orders.filter((o) => o.status === 'pending');
    if (waiting.length) {
      let changed = false;
      for (const o of waiting) {
        try { changed = (await shopApi.syncOrder(o.id)).order.status !== 'pending' || changed; } catch (e) { /* asked again next time */ }
      }
      if (changed) orders = (await shopApi.orders()).orders;
    }
  } catch (err) {
    state = 'error';
    errorText = err.offline ? "You're offline" : err.message || "Couldn't load your orders";
  }
  draw();
}

function openTrackingSheet(groupId) {
  const sheet = openSheet({ title: 'Add tracking' });
  sheet.body.innerHTML = `
    <p class="field-hint">Post it with a carrier, then enter the tracking number. The buyer sees it, and you are paid when it is delivered.</p>
    <label class="field-label">Carrier</label>
    <select class="field-input" data-f="carrier"><option>USPS</option><option>UPS</option><option>FedEx</option><option>DHL</option><option value="">Other…</option></select>
    <input class="field-input hidden" data-f="other" type="text" maxlength="40" placeholder="Carrier name">
    <label class="field-label">Tracking number</label>
    <input class="field-input" data-f="number" type="text" maxlength="40" autocomplete="off" placeholder="e.g. 9400 1118 9922 4567">
    <p class="field-hint field-hint--error hidden" data-role="error"></p>
    <div class="sheet-actions"><button class="btn btn-secondary" type="button" data-role="cancel">Cancel</button><button class="btn btn-primary" type="button" data-role="save">Mark as shipped</button></div>`;
  const f = (name) => sheet.body.querySelector(`[data-f="${name}"]`);
  const error = sheet.body.querySelector('[data-role="error"]');
  f('carrier').addEventListener('change', () => f('other').classList.toggle('hidden', f('carrier').value !== ''));
  sheet.body.querySelector('[data-role="cancel"]').addEventListener('click', () => sheet.close());
  const save = sheet.body.querySelector('[data-role="save"]');
  save.addEventListener('click', async () => {
    const carrier = f('carrier').value || f('other').value;
    save.disabled = true;
    try {
      await shopApi.ship(groupId, carrier, f('number').value);
      sheet.close();
      showToast('Marked as shipped', 2600);
      refreshOrders();
    } catch (err) {
      error.textContent = err.message || "Couldn't save that";
      error.classList.remove('hidden');
      save.disabled = false;
    }
  });
}

const armed = new Map();   // a destructive button needs a second tap within a few seconds

async function onClick(e) {
  const button = e.target.closest('[data-act]');
  if (!button) return;
  const act = button.dataset.act;
  const groupId = (button.closest('[data-gid]') || {}).dataset && button.closest('[data-gid]').dataset.gid;
  if (act === 'track' || act === 'label' || act === 'resume') { openLink(button.dataset.url); return; }
  if (act === 'add-tracking') { openTrackingSheet(groupId); return; }
  const confirm = { cancel: 'Tap again to cancel & refund', refund: 'Tap again to refund the buyer' }[act];
  if (confirm && armed.get(groupId + act) !== true) {
    armed.set(groupId + act, true);
    const label = button.innerHTML;
    button.textContent = confirm;
    setTimeout(() => { armed.delete(groupId + act); if (button.isConnected) button.innerHTML = label; }, 3500);
    return;
  }
  armed.delete(groupId + act);
  button.disabled = true;
  try {
    if (act === 'received') await shopApi.received(groupId);
    if (act === 'cancel') await shopApi.cancelGroup(groupId);
    if (act === 'refund') await shopApi.refund(groupId);
    if (act === 'buy-label') {
      await shopApi.buyLabel(groupId);
      showToast('Label bought: print it and send the parcel', 3500);
    }
    if (act === 'received') showToast('Thanks! The seller has been paid', 3000);
    if (act === 'cancel') showToast('Order cancelled: the money is on its way back', 3500);
    if (act === 'refund') showToast('Refunded', 3000);
  } catch (err) {
    showToast(err.message || 'That did not work', 4500);
    if (act === 'buy-label') showToast((err.message || '') + ' You can enter a tracking number instead.', 5000);
  }
  refreshOrders();
}

export function initOrders() {
  root = document.getElementById('orders-root');
  if (!root) return;
  root.addEventListener('click', onClick);
  window.addEventListener('binder:session', () => { orders = []; sales = []; draw(); });
  window.addEventListener('binder:settings-open', (e) => { if (e.detail === 'orders') refreshOrders(); });
  // coming back to the app (from the browser, after paying or shipping) while the orders are on screen
  document.addEventListener('visibilitychange', () => { if (!document.hidden && root && root.offsetParent !== null && getSession()) refreshOrders(); });
  draw();
}
