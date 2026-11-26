/**
 * listingsView.js
 * A seller's side of the market: "My listings" (what they have for sale) and the editor for one listing. A listing is always one
 * card from the catalog (so the market can match it to searches and show the lowest price): the editor starts by searching for the
 * card, then asks for condition, finish, quantity and price. Only a seller who can be paid can list (the service checks).
 */
import { api, CONDITIONS } from './api.js';
import { createCrossSearch } from './catalogSearch.js';
import { artHtml, escapeHtml, gameName, usd } from './dom.js';
import { openSheet } from './sheet.js';
import { shopApi } from './shopApi.js';
import { parsePriceToCents } from './shopInput.js';
import { showToast } from './ui.js';

const LANGUAGES = ['English', 'Japanese', 'German', 'French', 'Spanish', 'Italian', 'Portuguese', 'Korean', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Russian'];
const PICK_PAGE = 8;   // per game

// ---- my listings ---------------------------------------------------------------------------------------------------------------

function listingRow(l) {
  const out = l.quantity === 0;
  return `
    <div class="my-listing${out ? ' is-out' : ''}" data-id="${escapeHtml(l.id)}">
      <span class="cart-art">${artHtml(l.image, l.name)}</span>
      <span class="cart-line-main">
        <span class="cart-line-name">${escapeHtml(l.name)}</span>
        <span class="cart-line-meta">${escapeHtml(l.condition)}${l.foil ? ' · Foil' : ''}${l.set ? ` · ${escapeHtml(l.set)} ${escapeHtml(l.number)}` : ''}</span>
        <span class="cart-line-meta">${out ? 'Sold out' : `${l.quantity} available`}</span>
      </span>
      <span class="cart-line-side">
        <span class="cart-line-price">${usd(l.priceCents)}</span>
        <span><button class="link-btn" type="button" data-act="edit">Edit</button> <button class="link-btn link-btn--danger" type="button" data-act="remove">Remove</button></span>
      </span>
    </div>`;
}

export async function openMyListings() {
  const sheet = openSheet({ title: 'My listings' });
  let listings = [];
  const draw = () => {
    sheet.body.innerHTML = `
      <div class="sheet-actions"><button class="btn btn-primary" type="button" data-act="add">Add a listing</button></div>
      ${listings.length
        ? `<div class="my-listings">${listings.map(listingRow).join('')}</div>`
        : '<div class="empty-state"><h2>Nothing listed yet</h2><p>Add a card to put it on the market. Buyers pay Binder, and you are paid when the parcel is delivered.</p></div>'}
      <p class="field-hint">Binder keeps a small fee from each sale, and is paid shipping separately by the buyer. You see the buyer's name and address only once they have paid.</p>`;
  };
  const reload = async () => {
    try {
      listings = (await shopApi.myListings()).listings;
    } catch (err) {
      sheet.body.innerHTML = `<p class="field-hint field-hint--error">${escapeHtml(err.message || "Couldn't load your listings")}</p>`;
      return false;
    }
    draw();
    return true;
  };
  sheet.body.innerHTML = '<p class="setting-hint">Loading…</p>';
  await reload();
  sheet.body.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-act]');
    if (!button) return;
    const row = button.closest('.my-listing');
    const listing = row && listings.find((l) => l.id === row.dataset.id);
    if (button.dataset.act === 'add') openListingEditor({ onSaved: reload });
    if (button.dataset.act === 'edit' && listing) openListingEditor({ listing, onSaved: reload });
    if (button.dataset.act === 'remove' && listing) {
      if (button.dataset.armed !== '1') {   // a second tap confirms
        button.dataset.armed = '1';
        button.textContent = 'Tap again';
        setTimeout(() => { button.dataset.armed = ''; button.textContent = 'Remove'; }, 3500);
        return;
      }
      try {
        await shopApi.removeListing(listing.id);
        await reload();
      } catch (err) {
        showToast(err.message || "Couldn't remove it", 3200);
      }
    }
  });
}

// ---- one listing -----------------------------------------------------------------------------------------------------------------

/**
 * Opens the editor. `card` (a search result) starts a new listing for that card, `listing` changes an existing one, and with
 * neither the person searches for the card first. `onSaved` runs after a successful save.
 */
export function openListingEditor({ card, listing, onSaved } = {}) {
  const sheet = openSheet({ title: listing ? 'Edit listing' : 'List a card' });

  const pickStage = () => {
    sheet.setTitle('Find the card to sell');
    sheet.body.innerHTML = `
      <div class="search-bar"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input type="search" data-role="q" placeholder="Search all cards by name&hellip;" autocomplete="off"></div>
      <div class="pick-list" data-role="results"></div>`;
    const input = sheet.body.querySelector('[data-role="q"]');
    const results = sheet.body.querySelector('[data-role="results"]');
    let found = [];
    let timer = null;
    let counter = 0;
    const run = async () => {
      const mine = ++counter;
      const q = input.value.trim();
      if (!q) { results.innerHTML = '<p class="setting-hint">Type a card name.</p>'; return; }
      results.innerHTML = '<p class="setting-hint">Searching…</p>';
      try {
        found = await createCrossSearch((g, text, o) => api.searchCards(g, text, o), q, { perGame: PICK_PAGE }).more();
      } catch (err) {
        if (mine === counter) results.innerHTML = `<p class="field-hint field-hint--error">${escapeHtml(err.message || "Couldn't search")}</p>`;
        return;
      }
      if (mine !== counter) return;
      results.innerHTML = found.length
        ? found.map((r, i) => `<button class="pick-row" type="button" data-i="${i}"><span class="cart-art">${artHtml(r.image, r.name)}</span><span class="cart-line-main"><span class="cart-line-name">${escapeHtml(r.name)}</span><span class="cart-line-meta">${escapeHtml(gameName(r.game))} · ${escapeHtml(r.set || '')} ${escapeHtml(r.number || '')} ${r.rarity ? `· ${escapeHtml(r.rarity)}` : ''}</span></span></button>`).join('')
        : '<p class="setting-hint">No cards found.</p>';
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
    results.addEventListener('click', (e) => {
      const row = e.target.closest('.pick-row');
      if (!row) return;
      card = found[Number(row.dataset.i)];
      formStage();
    });
    input.focus();
    run();
  };

  const formStage = () => {
    const c = listing
      ? { id: listing.cardId, name: listing.name, set: listing.set, number: listing.number, image: listing.image, game: listing.game }
      : card;
    sheet.setTitle(listing ? 'Edit listing' : 'List this card');
    const l = listing || {};
    const options = (list, current) => list.map((o) => `<option${o === current ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('');
    sheet.body.innerHTML = `
      <div class="offers-head"><span class="market-art">${artHtml(c.image, c.name)}</span>
        <div><p class="market-name">${escapeHtml(c.name)}</p><p class="market-meta">${escapeHtml(gameName(c.game))} · ${escapeHtml(c.set || '')} ${escapeHtml(c.number || '')}</p>
        ${listing ? '' : '<button class="link-btn" type="button" data-role="change">Pick a different card</button>'}</div></div>
      <label class="field-label">Condition</label>
      <select class="field-input" data-f="condition">${options(CONDITIONS, l.condition || 'Near Mint')}</select>
      <label class="field-label">Finish</label>
      <label class="check-row"><input type="checkbox" data-f="foil" ${l.foil ? 'checked' : ''}> Foil</label>
      <label class="field-label">Language</label>
      <select class="field-input" data-f="language">${options(LANGUAGES, l.language || 'English')}</select>
      <div class="seller-row">
        <div><label class="field-label">How many</label><input class="field-input" data-f="quantity" type="number" min="0" max="999" step="1" value="${l.quantity === undefined ? 1 : l.quantity}"></div>
        <div><label class="field-label">Price each (US$)</label><input class="field-input" data-f="price" type="text" inputmode="decimal" placeholder="0.00" value="${l.priceCents ? (l.priceCents / 100).toFixed(2) : ''}"></div>
      </div>
      <label class="field-label">Note (optional)</label>
      <input class="field-input" data-f="note" type="text" maxlength="200" placeholder="Anything a buyer should know" value="${escapeHtml(l.note || '')}">
      <p class="field-hint field-hint--error hidden" data-role="error"></p>
      <div class="sheet-actions"><button class="btn btn-secondary" type="button" data-role="cancel">Cancel</button><button class="btn btn-primary" type="button" data-role="save">${listing ? 'Save changes' : 'List it'}</button></div>`;
    const field = (name) => sheet.body.querySelector(`[data-f="${name}"]`);
    const error = sheet.body.querySelector('[data-role="error"]');
    const change = sheet.body.querySelector('[data-role="change"]');
    if (change) change.addEventListener('click', pickStage);
    sheet.body.querySelector('[data-role="cancel"]').addEventListener('click', () => sheet.close());
    const save = sheet.body.querySelector('[data-role="save"]');
    save.addEventListener('click', async () => {
      const priceCents = parsePriceToCents(field('price').value);
      const quantity = Number.parseInt(field('quantity').value, 10);
      const show = (message) => { error.textContent = message; error.classList.toggle('hidden', !message); };
      if (priceCents === null) { show('Enter a price between $0.01 and $10,000.00'); return; }
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999) { show('Enter how many you have, 0 to 999'); return; }
      show('');
      save.disabled = true;
      try {
        await shopApi.saveListing({
          ...(listing ? { id: listing.id } : {}),
          game: c.game, cardId: c.id, name: c.name, set: c.set || '', number: c.number || '', image: c.image || '',
          condition: field('condition').value, foil: field('foil').checked, language: field('language').value,
          priceCents, quantity, note: field('note').value,
        });
        showToast(listing ? 'Listing updated' : 'Listed on the market', 2600);
        sheet.close();
        if (onSaved) onSaved();
      } catch (err) {
        show(err.message || "Couldn't save the listing");
        save.disabled = false;
      }
    });
  };

  if (listing || card) formStage();
  else pickStage();
  return sheet;
}
