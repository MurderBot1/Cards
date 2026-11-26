/**
 * market.js
 * The Shop tab: a search of ALL cards (the same catalog search the "add a card" sheet uses), where each result shows the lowest price
 * any Binder seller is asking, or "Unavailable" when nobody is selling it. With nothing typed it shows what was listed most recently.
 * Tapping a card lists every offer for it (condition, seller, price) with a way to put it in the cart; a seller can list the same card.
 */
import { api } from './api.js';
import { artHtml, escapeHtml, gameName, usd } from './dom.js';
import { cartQty, changeCart, initCart, openCart, refreshCart, requireSignIn } from './cartView.js';
import { openListingEditor } from './listingsView.js';
import { getSellerState } from './shop.js';
import { openSheet } from './sheet.js';
import { shopApi } from './shopApi.js';
import { showToast } from './ui.js';

const PAGE = 24;
const CONDITION_ABBR = { 'Near Mint': 'NM', 'Lightly Played': 'LP', 'Moderately Played': 'MP', 'Heavily Played': 'HP', Damaged: 'DMG' };

const $ = (id) => document.getElementById(id);
let els = null;

let game = 'mtg';
let query = '';
let results = [];        // catalog cards: { id, name, set, number, rarity, image, game }
let prices = {};         // catalog id -> { fromCents, count, quantity }; a card with no entry is unavailable
let loaded = 0;          // how much the source (search or feed) has given so far
let exhausted = false;
let loading = false;
let token = 0;           // bumped by every new search, so a slow answer to an old one is dropped
let sentinel = null;
let observer = null;

// ---- the list ---------------------------------------------------------------------------------------------------------------

function itemHtml(card, index) {
  const p = prices[card.id];
  const price = p
    ? `<span class="market-price">From ${usd(p.fromCents)}</span><span class="market-sub">${p.count} offer${p.count === 1 ? '' : 's'} · ${p.quantity} available</span>`
    : '<span class="market-price market-price--none">Unavailable</span>';
  const meta = [card.set, card.number, card.rarity].filter(Boolean).map(escapeHtml).join(' · ');
  return `
    <button class="market-item" type="button" data-index="${index}">
      <span class="market-art">${artHtml(card.image, card.name)}</span>
      <span class="market-body">
        <span class="market-name">${escapeHtml(card.name)}</span>
        ${price}
        <span class="market-meta"><span class="game-dot game-dot--${escapeHtml(card.game)}"></span>${meta}</span>
      </span>
    </button>`;
}

function render() {
  els.list.innerHTML = results.map(itemHtml).join('');
  els.heading.textContent = query ? `Results for “${query}”` : 'For sale on Binder';
  els.heading.classList.toggle('hidden', results.length === 0 && !loading);
  const none = results.length === 0 && !loading;
  els.empty.classList.toggle('hidden', !none);
  els.emptyTitle.textContent = query ? 'No cards found' : 'Nothing is for sale yet';
  els.emptyText.textContent = query ? `Nothing in ${gameName(game)} matches that name.` : 'Search for any card above to see its price, or who is selling it.';
  watchEnd();
}

/** Prices for a batch of cards: asks the service, and a failure just leaves them "Unavailable". */
async function priceBatch(cards) {
  if (!cards.length) return;
  try {
    const { prices: found } = await shopApi.prices(cards.map((c) => c.id));
    Object.assign(prices, found);
  } catch (e) { /* the cards show as Unavailable */ }
}

async function load(reset) {
  if (reset) {
    token += 1;
    results = [];
    prices = {};
    loaded = 0;
    exhausted = false;
    loading = false;
  }
  if (loading || exhausted) return;
  const mine = token;
  loading = true;
  if (reset) render();
  let batch = [];
  try {
    if (query) {
      const found = await api.searchCards(game, query, { limit: PAGE, offset: loaded });
      batch = found.map((c) => ({ ...c, game }));
      loaded += found.length;
      exhausted = found.length < PAGE;
    } else {
      const feed = await shopApi.listings({ sort: 'new', game, limit: PAGE, offset: loaded });
      loaded += feed.listings.length;
      exhausted = !feed.hasMore;
      const seen = new Set(results.map((c) => c.id));
      for (const l of feed.listings) {
        if (seen.has(l.cardId)) continue;
        seen.add(l.cardId);
        batch.push({ id: l.cardId, name: l.name, set: l.set, number: l.number, rarity: '', image: l.image, game: l.game });
      }
    }
    await priceBatch(batch);
  } catch (err) {
    if (mine === token) {
      loading = false;
      exhausted = true;
      if (!results.length) showToast(err.message || "Couldn't load the market", 3500);
      render();
    }
    return;
  }
  if (mine !== token) return;   // a newer search took over while this one was loading
  results = results.concat(batch);
  loading = false;
  render();
}

function watchEnd() {
  if (!sentinel) {
    sentinel = document.createElement('div');
    sentinel.className = 'search-sentinel';
    sentinel.setAttribute('aria-hidden', 'true');
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) load(false);
      }, { rootMargin: '300px' });
    }
  }
  if (observer) observer.unobserve(sentinel);
  if (exhausted || !results.length) { sentinel.remove(); return; }
  els.list.appendChild(sentinel);
  if (observer) observer.observe(sentinel);
}

// ---- one card: its offers ----------------------------------------------------------------------------------------------------

function offerHtml(l) {
  const mine = cartQty(l.id);
  const control = mine > 0
    ? `<span class="stepper"><button type="button" data-act="dec" aria-label="One fewer">&minus;</button><span>${mine}</span><button type="button" data-act="inc" aria-label="One more">+</button></span>`
    : '<button class="btn btn-primary btn-small" type="button" data-act="inc">Add to cart</button>';
  return `
    <div class="offer" data-id="${escapeHtml(l.id)}" data-qty="${l.quantity}">
      <div class="offer-main">
        <p class="offer-line"><span class="condition-badge" title="${escapeHtml(l.condition)}">${CONDITION_ABBR[l.condition] || escapeHtml(l.condition)}</span>${l.foil ? ' <span class="foil-badge">FOIL</span>' : ''} ${escapeHtml(l.condition)} · ${escapeHtml(l.language)}</p>
        <p class="offer-sub">Sold by <strong>${escapeHtml(l.seller)}</strong> · ${l.quantity} available</p>
        ${l.note ? `<p class="offer-sub">“${escapeHtml(l.note)}”</p>` : ''}
      </div>
      <div class="offer-buy"><span class="offer-price">${usd(l.priceCents)}</span>${control}</div>
    </div>`;
}

async function openOffers(card) {
  const sheet = openSheet({ title: card.name });
  const meta = [gameName(card.game), card.set, card.number, card.rarity].filter(Boolean).map(escapeHtml).join(' · ');
  sheet.body.innerHTML = `
    <div class="offers-head"><span class="market-art">${artHtml(card.image, card.name)}</span><div><p class="market-name">${escapeHtml(card.name)}</p><p class="market-meta">${meta}</p></div></div>
    <div class="offers-list"><p class="setting-hint">Looking for sellers…</p></div>
    <div class="sheet-actions sheet-actions--stack">
      <button class="btn btn-secondary" type="button" data-act="cart">Open cart</button>
      <button class="btn btn-secondary" type="button" data-act="sell">Sell this card</button>
    </div>`;
  const list = sheet.body.querySelector('.offers-list');
  let offers = [];
  const draw = () => {
    list.innerHTML = offers.length
      ? offers.map(offerHtml).join('')
      : '<div class="offers-none"><p class="market-price market-price--none">Unavailable</p><p class="setting-hint">Nobody is selling this card right now.</p></div>';
  };
  try {
    offers = (await shopApi.listings({ cardId: card.id, limit: 60 })).listings;
  } catch (err) {
    list.innerHTML = `<p class="field-hint field-hint--error">${escapeHtml(err.message || "Couldn't load the offers")}</p>`;
  }
  if (offers.length || !list.querySelector('.field-hint--error')) draw();
  sheet.body.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-act]');
    if (!button) return;
    const act = button.dataset.act;
    if (act === 'cart') { openCart(); return; }
    if (act === 'sell') {
      if (!requireSignIn('sell a card')) return;
      const state = getSellerState();
      if (!state.ready) {
        showToast(state.seller ? 'Finish your seller set-up in Settings first' : 'Register as a seller in Settings first', 3500);
        window.dispatchEvent(new CustomEvent('binder:goto', { detail: { tab: 'settings', section: 'selling' } }));
        return;
      }
      openListingEditor({ card, onSaved: () => load(true) });
      return;
    }
    const row = button.closest('.offer');
    if (!row || !requireSignIn('buy')) return;
    const id = row.dataset.id;
    const have = cartQty(id);
    const next = act === 'inc' ? have + 1 : have - 1;
    if (act === 'inc' && next > Number(row.dataset.qty)) { showToast("That's all they have", 2200); return; }
    try {
      await changeCart(id, next);
      const offer = offers.find((o) => o.id === id);
      row.outerHTML = offerHtml(offer);
    } catch (err) {
      showToast(err.message || "Couldn't change the cart", 3200);
    }
  });
}

// ---- starting up -------------------------------------------------------------------------------------------------------------

function markGame() {
  els.game.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('is-selected', b.dataset.value === game);
    b.setAttribute('aria-selected', String(b.dataset.value === game));
  });
}

function updateSellButton() {
  els.sell.classList.toggle('hidden', !getSellerState().ready);
}

export function initMarket() {
  els = {
    game: $('market-game'), search: $('market-search'), heading: $('market-heading'), list: $('market-list'),
    empty: $('market-empty'), emptyTitle: $('market-empty-title'), emptyText: $('market-empty-text'), sell: $('market-sell'),
  };
  initCart();
  markGame();
  let timer = null;
  els.search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { query = els.search.value.trim(); load(true); }, 250);
  });
  els.game.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    game = button.dataset.value;
    markGame();
    load(true);
  });
  els.list.addEventListener('click', (e) => {
    const item = e.target.closest('.market-item');
    if (item) openOffers(results[Number(item.dataset.index)]);
  });
  els.sell.addEventListener('click', () => openListingEditor({ onSaved: () => load(true) }));
  window.addEventListener('binder:seller', updateSellButton);
  updateSellButton();
  load(true);
}

/** Called when the Shop tab is shown: a fresh cart and fresh prices for what is on screen (the search itself is left alone). */
export async function refreshMarket() {
  refreshCart();
  if (!els || !results.length) return;
  const mine = token;
  const shown = results.slice();
  const before = prices;
  prices = {};
  await priceBatch(shown);
  if (mine !== token) { prices = before; return; }
  render();
}
