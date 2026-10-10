/**
 * collections.js
 * Everything for the Collection tab: the grid of collections, the
 * detail view for a single collection (search + card list), and the
 * "+" flow that lets a user add a card by searching the database or
 * scanning a physical card. A collection can hold cards from any
 * mix of games — the game is chosen per search/scan, not per collection.
 */
import { api, CONDITIONS, DEFAULT_CONDITION } from './api.js';
import { showToast } from './ui.js';
import { IS_WEB } from './env.js';
import { initImportExport } from './importExport.js';
import { getSettings } from './settings.js';
import { backfillUids, collectionValue, formatUsd, loadPrices, pricesEnabled, unitPrice } from './prices.js';
import { DEFAULT_KIND, KINDS, countLabel, kindOf, kindWords, limitsOf, listsOfKind } from './listKinds.js';
import { SORTS, activeFilterCount, emptyFilter, facetValues, filterCards, isCustomView } from './cardFilter.js';

const GAME_LABELS = { mtg: 'Magic: The Gathering', pokemon: 'Pokémon', yugioh: 'Yu-Gi-Oh!' };
const GAMES = ['mtg', 'pokemon', 'yugioh'];
const CONDITION_ABBR = {
  'Near Mint': 'NM',
  'Lightly Played': 'LP',
  'Moderately Played': 'MP',
  'Heavily Played': 'HP',
  'Damaged': 'DMG',
};

let collections = [];
// which kind of list the Collection tab is showing (collections, decks, tradelist or wishlist), kept between launches
const KIND_KEY = 'binder_list_kind';
let activeKind = DEFAULT_KIND;
try {
  const saved = localStorage.getItem(KIND_KEY);
  if (KINDS.includes(saved)) activeKind = saved;
} catch (e) { /* no storage: start on collections */ }
let activeCollection = null;
let mediaStream = null;
let onNavigate = null; // callback set by app.js to update header/tab chrome
let selectedSearchGame = 'mtg';
let selectedScanGame = 'mtg';
let deleteTargetId = null;
let detailCard = null; // card currently shown in the lightbox

const els = {
  grid: document.getElementById('collection-grid'),
  emptyList: document.getElementById('collection-empty'),
  emptyListTitle: document.getElementById('collection-empty-title'),
  emptyListText: document.getElementById('collection-empty-text'),
  kindTabs: document.getElementById('list-kind-tabs'),
  detailEmptyTitle: document.getElementById('collection-detail-empty-title'),
  detailEmptyText: document.getElementById('collection-detail-empty-text'),
  newTitle: document.getElementById('new-collection-title'),
  newHint: document.getElementById('new-collection-hint'),
  listSubview: document.getElementById('subview-collection-list'),
  detailSubview: document.getElementById('subview-collection-detail'),
  countLabel: document.getElementById('collection-count'),
  detailCount: document.getElementById('collection-detail-count'),
  detailSearch: document.getElementById('collection-search-input'),
  cardList: document.getElementById('collection-card-list'),
  detailEmpty: document.getElementById('collection-detail-empty'),
  noMatches: document.getElementById('collection-no-matches'),
  filterToggle: document.getElementById('filter-toggle-btn'),
  filterBadge: document.getElementById('filter-badge'),
  filterPanel: document.getElementById('filter-panel'),
  filterSort: document.getElementById('filter-sort'),
  filterGame: document.getElementById('filter-game'),
  filterSet: document.getElementById('filter-set'),
  filterRarity: document.getElementById('filter-rarity'),
  filterCondition: document.getElementById('filter-condition'),
  filterMin: document.getElementById('filter-min-price'),
  filterMax: document.getElementById('filter-max-price'),
  filterClear: document.getElementById('filter-clear-btn'),
  fab: document.getElementById('fab-add-card'),
  deleteCollectionBtn: document.getElementById('delete-collection-btn'),

  newModal: document.getElementById('modal-new-collection'),
  newName: document.getElementById('new-collection-name'),
  newCreateBtn: document.getElementById('new-collection-create'),
  newCancelBtn: document.getElementById('new-collection-cancel'),

  choiceModal: document.getElementById('modal-add-choice'),
  choiceSearchBtn: document.getElementById('choice-search'),
  choiceScanBtn: document.getElementById('choice-scan'),
  choiceCancelBtn: document.getElementById('add-choice-cancel'),

  searchModal: document.getElementById('modal-search'),
  searchBack: document.getElementById('search-modal-back'),
  searchGamePicker: document.getElementById('search-game-picker'),
  searchInput: document.getElementById('db-search-input'),
  searchResults: document.getElementById('db-search-results'),
  searchEmpty: document.getElementById('db-search-empty'),

  scanModal: document.getElementById('modal-scan'),
  scanBack: document.getElementById('scan-modal-back'),
  scanGamePicker: document.getElementById('scan-game-picker'),
  scanFrame: document.getElementById('scan-frame'),
  scanVideo: document.getElementById('scan-video'),
  scanFrozenFrame: document.getElementById('scan-frozen-frame'),
  scanBboxOverlay: document.getElementById('scan-bbox-overlay'),
  scanHint: document.getElementById('scan-hint'),
  scanMeta: document.getElementById('scan-meta'),
  scanNextBtn: document.getElementById('scan-next-btn'),
  scanSessionTitle: document.getElementById('scan-session-title'),
  scanSessionList: document.getElementById('scan-session-list'),

  confirmDeleteModal: document.getElementById('modal-confirm-delete'),
  confirmDeleteText: document.getElementById('confirm-delete-text'),
  confirmDeleteCancel: document.getElementById('confirm-delete-cancel'),
  confirmDeleteSubmit: document.getElementById('confirm-delete-submit'),

  cardDetailModal: document.getElementById('modal-card-detail'),
  cardDetailClose: document.getElementById('card-detail-close'),
  cardDetailImage: document.getElementById('card-detail-image'),
  cardDetailName: document.getElementById('card-detail-name'),
  cardDetailMeta: document.getElementById('card-detail-meta'),
  cardDetailPrice: document.getElementById('card-detail-price'),
  cardDetailCondition: document.getElementById('card-detail-condition'),
  cardDetailQty: document.getElementById('card-detail-qty'),
};

// -----------------------------------------------------------------
// small helpers
// -----------------------------------------------------------------
function cardIcon() {
  return `<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>`;
}

function cardThumb(card) {
  if (card.image) {
    return `<img src="${escapeHtml(card.image)}" alt="" loading="lazy">`;
  }
  return cardIcon();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function setGamePicker(container, value) {
  container.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('is-selected', btn.dataset.value === value);
    btn.setAttribute('aria-selected', btn.dataset.value === value ? 'true' : 'false');
  });
}

function wireGamePicker(container, onChange) {
  container.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      setGamePicker(container, btn.dataset.value);
      onChange(btn.dataset.value);
    });
  });
}

// -----------------------------------------------------------------
// rendering: collection list
// -----------------------------------------------------------------
function renderCollectionGrid() {
  const shown = listsOfKind(collections, activeKind);
  const words = kindWords(activeKind);
  els.grid.innerHTML = '';
  setSegmentedValue(els.kindTabs, activeKind);
  els.emptyList.classList.toggle('hidden', shown.length > 0);
  els.emptyListTitle.textContent = words.emptyTitle;
  els.emptyListText.textContent = words.emptyText;
  const maxLists = limitsOf(activeKind).lists;
  els.countLabel.textContent = maxLists === null ? countLabel(activeKind, shown.length) : `${shown.length} of ${maxLists} ${words.plural}`;

  shown.forEach((c) => {
    const gamesPresent = GAMES.filter((g) => c.cards.some((card) => card.game === g));
    const dots = gamesPresent.length
      ? `<div class="game-dots">${gamesPresent.map((g) => `<span class="game-dot game-dot--${g}" title="${GAME_LABELS[g]}"></span>`).join('')}</div>`
      : `<span class="game-dots-empty">No cards yet</span>`;

    const btn = document.createElement('button');
    btn.className = 'collection-card';
    btn.innerHTML = `
      <button class="collection-card-delete" data-action="delete-collection" aria-label="Delete ${escapeHtml(c.name)}">
        <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>
      </button>
      ${dots}
      <h3>${escapeHtml(c.name)}</h3>
      <p class="card-count">${c.cards.length} card${c.cards.length === 1 ? '' : 's'}${valueSuffix(c.cards)}</p>
    `;
    btn.addEventListener('click', () => openCollection(c.id));
    btn.querySelector('[data-action="delete-collection"]').addEventListener('click', (e) => {
      e.stopPropagation();
      openConfirmDelete(c.id, c.name);
    });
    els.grid.appendChild(btn);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'collection-card collection-card--new';
  addBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>New ${words.singular}</span>`;
  addBtn.addEventListener('click', () => openNewCollectionModal());
  els.grid.appendChild(addBtn);
}

async function refreshCollections() {
  collections = await api.getCollections();
  renderCollectionGrid();
  loadGridPrices();
}

// ---- prices (prices.js) --------------------------------------------------------------------------
// " · $123.45" for a list of cards, with a "+" when some have no known price; "" when there is nothing to show.
function valueSuffix(cards) {
  if (!pricesEnabled()) return '';
  const value = collectionValue(cards);
  if (value.priced === 0) return '';
  return ` · ${formatUsd(value.total)}${value.unpriced ? '+' : ''}`;
}

function priceBadge(card) {
  const price = unitPrice(card);
  return price === null ? '' : `<span class="card-price" title="Market price, each">${formatUsd(price)}</span>`;
}

// Looks up prices for the open collection (filling in catalog ids for older cards first) and redraws it.
let priceRunToken = 0;
async function refreshPrices(collection) {
  if (!pricesEnabled() || !collection) return;
  const token = ++priceRunToken;
  const stillOpen = () => token === priceRunToken && activeCollection && activeCollection.id === collection.id;
  try {
    const updated = await backfillUids(collection);
    if (!stillOpen()) return;
    if (updated) {
      activeCollection = updated;
      syncActiveCollectionIntoList();
    }
    const changed = await loadPrices(activeCollection.cards);
    if (!stillOpen()) return;
    if (changed || updated) {
      renderCardList(els.detailSearch.value);
      updateCardDetailPrice();
    }
  } catch (err) { /* prices are a nicety: never get in the way */ }
}

// Prices for the collections grid: whatever isn't known yet, a batch at a time.
async function loadGridPrices() {
  if (!pricesEnabled()) return;
  const cards = collections.flatMap((c) => c.cards).filter((c) => unitPrice(c) === null).slice(0, 150);
  if (cards.length === 0) return;
  if (await loadPrices(cards)) renderCollectionGrid();
}

function updateCardDetailPrice() {
  if (!detailCard || !pricesEnabled()) {
    els.cardDetailPrice.textContent = '';
    return;
  }
  const price = unitPrice(detailCard);
  els.cardDetailPrice.textContent =
    price === null ? '' : `${formatUsd(price)} each · ${formatUsd(price * detailCard.quantity)} total`;
}

// sync.js changed what's stored on this device (another device's edits arrived): show it
export async function reloadCollections() {
  collections = await api.getCollections();
  if (activeCollection) {
    const fresh = collections.find((c) => c.id === activeCollection.id);
    if (!fresh) {
      closeCardDetail();
      closeCollectionDetail();
    } else {
      activeCollection = fresh;
      renderCardList(els.detailSearch.value);
      syncActiveCollectionIntoList();
      if (detailCard) {
        detailCard = fresh.cards.find((c) => c.id === detailCard.id) || null;
        if (detailCard) {
          els.cardDetailQty.textContent = detailCard.quantity;
          updateCardDetailPrice();
        } else {
          closeCardDetail();
        }
      }
    }
  }
  renderCollectionGrid();
  loadGridPrices();
}
window.addEventListener('binder:collections-changed', () => { reloadCollections().catch(() => {}); });

// -----------------------------------------------------------------
// new collection modal (name only — games are chosen per card)
// -----------------------------------------------------------------
function openNewCollectionModal() {
  const words = kindWords(activeKind);
  els.newTitle.textContent = `New ${words.singular}`;
  els.newName.placeholder = words.placeholder;
  els.newHint.textContent = words.hint;
  els.newCreateBtn.textContent = `Create ${words.singular}`;
  els.newName.value = '';
  updateCreateBtnState();
  els.newModal.classList.remove('hidden');
  setTimeout(() => els.newName.focus(), 50);
}
function closeNewCollectionModal() {
  els.newModal.classList.add('hidden');
}
function updateCreateBtnState() {
  els.newCreateBtn.disabled = !els.newName.value.trim();
}

els.newName.addEventListener('input', updateCreateBtnState);
els.newCancelBtn.addEventListener('click', closeNewCollectionModal);
els.newModal.addEventListener('click', (e) => { if (e.target === els.newModal) closeNewCollectionModal(); });
els.newCreateBtn.addEventListener('click', async () => {
  const name = els.newName.value.trim();
  if (!name) return;
  els.newCreateBtn.disabled = true;
  try {
    const collection = await api.createCollection(name, activeKind);
    collections.push(collection);
    renderCollectionGrid();
    closeNewCollectionModal();
    showToast(`Created "${name}"`);
  } catch (err) {
    // e.g. the limit on how many lists there may be
    showToast(err.message || `Could not create the ${kindWords(activeKind).singular}`, 3500);
    closeNewCollectionModal();
  }
});

// -----------------------------------------------------------------
// delete collection (with confirmation)
// -----------------------------------------------------------------
function openConfirmDelete(id, name) {
  deleteTargetId = id;
  els.confirmDeleteText.textContent = `"${name}" and every card in it will be permanently deleted. This can't be undone.`;
  els.confirmDeleteModal.classList.remove('hidden');
}
function closeConfirmDelete() {
  deleteTargetId = null;
  els.confirmDeleteModal.classList.add('hidden');
}
els.confirmDeleteCancel.addEventListener('click', closeConfirmDelete);
els.confirmDeleteModal.addEventListener('click', (e) => { if (e.target === els.confirmDeleteModal) closeConfirmDelete(); });
els.confirmDeleteSubmit.addEventListener('click', async () => {
  if (!deleteTargetId) return;
  const id = deleteTargetId;
  const wasActive = activeCollection && activeCollection.id === id;
  const deleted = collections.find((c) => c.id === id);
  els.confirmDeleteSubmit.disabled = true;
  try {
    await api.deleteCollection(id);
    collections = collections.filter((c) => c.id !== id);
    if (wasActive) closeCollectionDetail();
    renderCollectionGrid();
    const label = kindWords(kindOf(deleted)).singular;
    showToast(`${label[0].toUpperCase()}${label.slice(1)} deleted`);
  } finally {
    els.confirmDeleteSubmit.disabled = false;
    closeConfirmDelete();
  }
});
els.deleteCollectionBtn.addEventListener('click', () => {
  if (!activeCollection) return;
  openConfirmDelete(activeCollection.id, activeCollection.name);
});

// -----------------------------------------------------------------
// collection detail
// -----------------------------------------------------------------
async function openCollection(id) {
  activeCollection = await api.getCollection(id);
  if (!activeCollection) return;
  els.listSubview.classList.add('hidden');
  els.detailSubview.classList.remove('hidden');
  els.fab.classList.remove('hidden');
  const words = kindWords(kindOf(activeCollection));
  els.detailEmptyTitle.textContent = words.listEmpty;
  els.detailEmptyText.textContent = words.listEmptyText;
  els.detailSearch.value = '';
  resetFilters();
  renderCardList('');
  const count = activeCollection.cards.length;
  if (onNavigate) {
    onNavigate({ inDetail: true, title: activeCollection.name, subtitle: `${count} card${count === 1 ? '' : 's'}` });
  }
  refreshPrices(activeCollection);
}

export function closeCollectionDetail() {
  activeCollection = null;
  els.detailSubview.classList.add('hidden');
  els.listSubview.classList.remove('hidden');
  els.fab.classList.add('hidden');
  if (onNavigate) onNavigate({ inDetail: false, title: 'Collection', subtitle: '' });
}

// filtering is done client-side against data already in memory, so this
// stays fast on its own — but we still debounce the render slightly so
// fast typing doesn't thrash the DOM on large binders.
let cardListRenderToken = 0;
function renderCardList(filter) {
  if (!activeCollection) return;
  const token = ++cardListRenderToken;
  const q = filter.trim().toLowerCase();
  const narrowed = q !== '' || activeFilterCount(cardFilter) > 0;
  const cards = filterCards(activeCollection.cards, q, cardFilter, unitPrice, DEFAULT_CONDITION);
  if (token !== cardListRenderToken) return; // a newer render already queued
  const total = activeCollection.cards.length;
  const maxCards = limitsOf(kindOf(activeCollection)).cards;
  // a deck says how full it is ("12 of 150 cards")
  const totalText = maxCards <= 1000 ? `${total} of ${maxCards} cards` : `${total} card${total === 1 ? '' : 's'}`;
  els.detailCount.textContent = `${totalText}${narrowed ? ` · ${cards.length} match${cards.length === 1 ? '' : 'es'}` : ''}${valueSuffix(activeCollection.cards)}`;
  els.cardList.innerHTML = '';
  els.detailEmpty.classList.toggle('hidden', total > 0);
  els.noMatches.classList.toggle('hidden', total === 0 || cards.length > 0);
  updateFilterControls();

  cards.forEach((card) => {
    const condition = card.condition || DEFAULT_CONDITION;
    const row = document.createElement('div');
    row.className = 'card-row card-row--owned';
    row.innerHTML = `
      <div class="card-thumb" data-action="open-detail">${cardThumb(card)}</div>
      <div class="card-info" data-action="open-detail">
        <p class="card-name">${escapeHtml(card.name)}</p>
        <p class="card-meta">
          <span class="game-dot game-dot--${card.game}" title="${GAME_LABELS[card.game] || ''}"></span>
          ${escapeHtml(card.set || '')} &middot; ${escapeHtml(card.rarity || '')}
          <span class="condition-badge" title="${escapeHtml(condition)}">${CONDITION_ABBR[condition] || condition}</span>
          ${card.foil === true ? '<span class="foil-badge" title="Foil">FOIL</span>' : ''}
          ${priceBadge(card)}
        </p>
      </div>
      <div class="card-qty">
        <button class="qty-btn" data-action="dec" aria-label="Decrease quantity"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button>
        <span>${card.quantity}</span>
        <button class="qty-btn" data-action="inc" aria-label="Increase quantity"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
      </div>
    `;
    row.querySelector('[data-action="dec"]').addEventListener('click', (e) => { e.stopPropagation(); changeQty(card, -1); });
    row.querySelector('[data-action="inc"]').addEventListener('click', (e) => { e.stopPropagation(); changeQty(card, 1); });
    row.querySelectorAll('[data-action="open-detail"]').forEach((el) => {
      el.addEventListener('click', () => openCardDetail(card));
    });
    els.cardList.appendChild(row);
  });
}

async function changeQty(card, delta) {
  const newQty = card.quantity + delta;
  try {
    activeCollection = await api.updateCardQuantity(activeCollection.id, card.id, Math.max(0, newQty));
  } catch (err) {
    showToast(err.message || 'Could not change the quantity', 3500);  // e.g. the limit on copies of one card
    return;
  }
  renderCardList(els.detailSearch.value);
  syncActiveCollectionIntoList();
}

function syncActiveCollectionIntoList() {
  const idx = collections.findIndex((c) => c.id === activeCollection.id);
  if (idx !== -1) collections[idx] = activeCollection;
  const count = activeCollection.cards.length;
  if (onNavigate) onNavigate({ inDetail: true, title: activeCollection.name, subtitle: `${count} card${count === 1 ? '' : 's'}` });
}

// ---- filter and sort (cardFilter.js) -------------------------------------------------------------
let cardFilter = emptyFilter();
let detailSearchDebounce = null;

function resetFilters() {
  cardFilter = emptyFilter();
  els.filterMin.value = '';
  els.filterMax.value = '';
  els.filterPanel.classList.add('hidden');
  els.filterToggle.setAttribute('aria-expanded', 'false');
}

function fillSelect(select, firstLabel, options, current, label = (v) => v) {
  const values = current && !options.includes(current) ? [...options, current] : options;  // keep a pick that no card has now
  select.innerHTML = '';
  const add = (value, text) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    select.appendChild(opt);
  };
  if (firstLabel !== null) add('', firstLabel);
  values.forEach((v) => add(v, label(v)));
  select.value = current;
}

// Redraws the drop-downs from the cards now in the list, and the count on the filter button.
function updateFilterControls() {
  if (!activeCollection) return;
  const facets = facetValues(activeCollection.cards, DEFAULT_CONDITION, CONDITIONS);
  fillSelect(els.filterSort, null, SORTS.map((s) => s.value), cardFilter.sort, (v) => SORTS.find((s) => s.value === v).label);
  fillSelect(els.filterGame, 'All games', facets.games, cardFilter.game, (g) => GAME_LABELS[g] || g);
  fillSelect(els.filterSet, 'All sets', facets.sets, cardFilter.set);
  fillSelect(els.filterRarity, 'All rarities', facets.rarities, cardFilter.rarity);
  fillSelect(els.filterCondition, 'All conditions', facets.conditions, cardFilter.condition);
  const count = activeFilterCount(cardFilter);
  els.filterBadge.textContent = String(count);
  els.filterBadge.classList.toggle('hidden', count === 0);
  els.filterClear.disabled = !isCustomView(cardFilter) && els.filterMin.value === '' && els.filterMax.value === '';
}

function readFilterControls() {
  cardFilter = {
    sort: els.filterSort.value,
    game: els.filterGame.value,
    set: els.filterSet.value,
    rarity: els.filterRarity.value,
    condition: els.filterCondition.value,
    minPrice: els.filterMin.value,
    maxPrice: els.filterMax.value,
  };
  renderCardList(els.detailSearch.value);
}

els.filterToggle.addEventListener('click', () => {
  const opening = els.filterPanel.classList.contains('hidden');
  els.filterPanel.classList.toggle('hidden', !opening);
  els.filterToggle.setAttribute('aria-expanded', String(opening));
});
[els.filterSort, els.filterGame, els.filterSet, els.filterRarity, els.filterCondition].forEach((el) => el.addEventListener('change', readFilterControls));
[els.filterMin, els.filterMax].forEach((el) => el.addEventListener('input', () => {
  clearTimeout(detailSearchDebounce);
  detailSearchDebounce = setTimeout(readFilterControls, 200);
}));
els.filterClear.addEventListener('click', () => {
  els.filterMin.value = '';
  els.filterMax.value = '';
  cardFilter = emptyFilter();
  renderCardList(els.detailSearch.value);
});

// debounce collection-detail search too: it's local filtering so it's
// cheap, but on a big binder re-rendering hundreds of rows on every
// keystroke is still wasted work while the person is still typing.
els.detailSearch.addEventListener('input', () => {
  clearTimeout(detailSearchDebounce);
  const value = els.detailSearch.value;
  detailSearchDebounce = setTimeout(() => renderCardList(value), 120);
});

// -----------------------------------------------------------------
// card detail lightbox — bigger image + condition + quantity editing
// -----------------------------------------------------------------
function openCardDetail(card) {
  detailCard = card;
  els.cardDetailImage.innerHTML = card.image
    ? `<img src="${escapeHtml(card.image)}" alt="${escapeHtml(card.name)}">`
    : `<div class="card-detail-placeholder">${cardIcon()}</div>`;
  els.cardDetailName.textContent = card.name;
  const metaParts = [GAME_LABELS[card.game] || card.game, card.set, card.rarity].filter(Boolean);
  els.cardDetailMeta.textContent = metaParts.join(' · ');
  updateCardDetailPrice();
  setSegmentedValue(els.cardDetailCondition, card.condition || DEFAULT_CONDITION);
  els.cardDetailQty.textContent = card.quantity;
  els.cardDetailModal.classList.remove('hidden');
}
function closeCardDetail() {
  detailCard = null;
  els.cardDetailModal.classList.add('hidden');
}
els.cardDetailClose.addEventListener('click', closeCardDetail);
els.cardDetailModal.addEventListener('click', (e) => { if (e.target === els.cardDetailModal) closeCardDetail(); });

function setSegmentedValue(group, value) {
  group.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('is-selected', btn.dataset.value === value);
    btn.setAttribute('aria-selected', btn.dataset.value === value ? 'true' : 'false');
  });
}

els.kindTabs.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeKind = btn.dataset.value;
    try { localStorage.setItem(KIND_KEY, activeKind); } catch (e) { /* not remembered */ }
    renderCollectionGrid();
  });
});

els.cardDetailCondition.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!detailCard || !activeCollection) return;
    const condition = btn.dataset.value;
    setSegmentedValue(els.cardDetailCondition, condition);
    activeCollection = await api.updateCardCondition(activeCollection.id, detailCard.id, condition);
    detailCard = activeCollection.cards.find((c) => c.id === detailCard.id) || null;
    renderCardList(els.detailSearch.value);
    syncActiveCollectionIntoList();
  });
});

els.cardDetailModal.querySelectorAll('.card-qty [data-action]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!detailCard || !activeCollection) return;
    const delta = btn.dataset.action === 'inc' ? 1 : -1;
    const newQty = Math.max(0, detailCard.quantity + delta);
    try {
      activeCollection = await api.updateCardQuantity(activeCollection.id, detailCard.id, newQty);
    } catch (err) {
      showToast(err.message || 'Could not change the quantity', 3500);
      return;
    }
    renderCardList(els.detailSearch.value);
    syncActiveCollectionIntoList();
    if (newQty <= 0) {
      closeCardDetail();
      return;
    }
    detailCard = activeCollection.cards.find((c) => c.id === detailCard.id) || null;
    if (detailCard) {
      els.cardDetailQty.textContent = detailCard.quantity;
      updateCardDetailPrice();
    }
  });
});

// -----------------------------------------------------------------
// "+" action sheet: search or scan
// -----------------------------------------------------------------
els.fab.addEventListener('click', () => {
  // the website can only search (no camera features), so there is nothing to choose between
  if (IS_WEB) openSearchModal();
  else els.choiceModal.classList.remove('hidden');
});
els.choiceCancelBtn.addEventListener('click', () => els.choiceModal.classList.add('hidden'));
els.choiceModal.addEventListener('click', (e) => { if (e.target === els.choiceModal) els.choiceModal.classList.add('hidden'); });

els.choiceSearchBtn.addEventListener('click', () => {
  els.choiceModal.classList.add('hidden');
  openSearchModal();
});
els.choiceScanBtn.addEventListener('click', () => {
  els.choiceModal.classList.add('hidden');
  openScanModal();
});

// -----------------------------------------------------------------
// search modal — pick a game, then search that game's database
// -----------------------------------------------------------------
let searchDebounce = null;
let searchRequestToken = 0; // guards against a slow, stale request overwriting a newer one

setGamePicker(els.searchGamePicker, selectedSearchGame);
wireGamePicker(els.searchGamePicker, (value) => {
  selectedSearchGame = value;
  runSearch(els.searchInput.value.trim());
});

function openSearchModal() {
  els.searchInput.value = '';
  searchRequestToken += 1;  // drops any page still on its way for the previous search
  searchExhausted = true;
  els.searchResults.innerHTML = '';
  els.searchEmpty.classList.remove('hidden');
  els.searchModal.classList.remove('hidden');
  setTimeout(() => els.searchInput.focus(), 50);
}
function closeSearchModal() {
  els.searchModal.classList.add('hidden');
}
els.searchBack.addEventListener('click', closeSearchModal);

els.searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const query = els.searchInput.value.trim();
  // 200ms debounce keeps us from firing a request per keystroke while
  // someone is still typing a card name.
  searchDebounce = setTimeout(() => runSearch(query), 200);
});

// Results come a page at a time: the first page when the search changes, and the next one whenever the end of the list
// scrolls into view (an invisible marker at the bottom of the list is watched for that).
const SEARCH_PAGE = 40;
let searchQuery = '';
let searchLoaded = 0;       // results fetched so far for the current search
let searchExhausted = false; // the last page came back short: nothing more to fetch
let searchLoadingMore = false;
let searchSentinel = null;
let searchObserver = null;

async function runSearch(query) {
  if (!activeCollection) return;
  const token = ++searchRequestToken;
  searchQuery = query;
  searchLoaded = 0;
  searchExhausted = false;
  searchLoadingMore = false;
  const results = await api.searchCards(selectedSearchGame, query, { limit: SEARCH_PAGE });
  // if the user kept typing (or changed game) while this request was in
  // flight, a newer call already started — drop this stale response
  // instead of letting it flash outdated results onto the screen.
  if (token !== searchRequestToken) return;
  els.searchResults.innerHTML = '';
  searchLoaded = results.length;
  searchExhausted = results.length < SEARCH_PAGE;
  els.searchEmpty.classList.toggle('hidden', results.length > 0);
  appendSearchResults(results);
  watchSearchEnd();
}

// The next page of the current search, appended below what is already there.
async function loadMoreSearchResults() {
  if (searchExhausted || searchLoadingMore || !activeCollection) return;
  const token = searchRequestToken;
  searchLoadingMore = true;
  let results = null;
  try {
    results = await api.searchCards(selectedSearchGame, searchQuery, { limit: SEARCH_PAGE, offset: searchLoaded });
  } catch (err) {
    showToast("Couldn't load more results");
  }
  searchLoadingMore = false;
  if (token !== searchRequestToken || !results) return;  // a newer search replaced this one (or it failed: scroll again to retry)
  searchLoaded += results.length;
  searchExhausted = results.length < SEARCH_PAGE;
  appendSearchResults(results);
  watchSearchEnd();
}

// Keeps the marker at the very end of the list, and (re)starts watching it: observing it again reports whether it is
// already in view, which is how a page too short to scroll still gets followed by the next one.
function watchSearchEnd() {
  if (!searchSentinel) {
    searchSentinel = document.createElement('div');
    searchSentinel.className = 'search-sentinel';
    searchSentinel.setAttribute('aria-hidden', 'true');
    if (typeof IntersectionObserver === 'function') {
      searchObserver = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreSearchResults();
      }, { root: els.searchResults, rootMargin: '300px' });
    }
  }
  if (searchObserver) searchObserver.unobserve(searchSentinel);
  if (searchExhausted) {
    searchSentinel.remove();
    return;
  }
  els.searchResults.appendChild(searchSentinel);
  if (searchObserver) searchObserver.observe(searchSentinel);
}

function appendSearchResults(results) {
  results.forEach((result) => {
    const card = { ...result, game: selectedSearchGame, condition: DEFAULT_CONDITION };
    const row = document.createElement('button');
    row.className = 'card-row card-row--result';
    row.innerHTML = `
      <div class="card-thumb">${cardThumb(card)}</div>
      <div class="card-info">
        <p class="card-name">${escapeHtml(card.name)}</p>
        <p class="card-meta">
          <span class="game-dot game-dot--${card.game}"></span>
          ${escapeHtml(card.set || '')} &middot; ${escapeHtml(card.rarity || '')}
        </p>
      </div>
      <div class="add-icon"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></div>
    `;
    row.addEventListener('click', async () => {
      try {
        activeCollection = await api.addCardToCollection(activeCollection.id, card);
      } catch (err) {
        showToast(err.message || `Could not add ${card.name}`, 3500);  // e.g. the list is full
        return;
      }
      renderCardList(els.detailSearch.value);
      syncActiveCollectionIntoList();
      showToast(`Added ${card.name}`);
      refreshPrices(activeCollection);
    });
    // before the marker, which stays at the end of the list
    els.searchResults.insertBefore(row, searchSentinel && searchSentinel.parentNode === els.searchResults ? searchSentinel : null);
  });
}

// -----------------------------------------------------------------
// scan modal — bulk scanning, always: pick a game, then show cards one
// after another. The whole camera frame (not a cropped guide box) is
// continuously analyzed for sharpness/brightness; once a good-enough shot
// is held steady it's captured, identified and added to the collection
// automatically (as Near Mint), and the camera stays on for the next one.
// Each card lands in a "scanned this session" list where its condition can
// be corrected or the scan undone. A card that has just been added isn't
// scanned again until it leaves the frame (or a different card replaces it).
// -----------------------------------------------------------------
setGamePicker(els.scanGamePicker, selectedScanGame);
wireGamePicker(els.scanGamePicker, (value) => {
  selectedScanGame = value;
});

// requestRate controls how often we sample a frame to evaluate.
const AUTO_CHECK_INTERVAL_MS = { low: 900, medium: 500, high: 280 };
// minImageQuality controls how sharp (focused) a frame must be before
// it's considered good enough to auto-capture. This is a Laplacian
// variance threshold on a downscaled grayscale crop of the guide box.
const AUTO_SHARPNESS_THRESHOLD = { low: 20, medium: 45, high: 80 };
const AUTO_CONSECUTIVE_GOOD_FRAMES = 3;
const AUTO_BRIGHTNESS_MIN = 35;
const AUTO_BRIGHTNESS_MAX = 235;

let autoDetectTimer = null;
let autoGoodStreak = 0;
let capturingFrame = false;
let analysisCanvas = null;

// ---- bulk scanning state
const NO_CARD_FRAMES_TO_REARM = 3;   // consecutive live-detect results with no card in view
const SWAP_DIFF_THRESHOLD = 14;      // mean grayscale difference (0-255) that means "a different card is in view"
let scanSession = [];                // newest first: { n, cardId, card, condition, busy }
let scanSeq = 0;
let awaitingNewCard = false;         // a card was just added; wait for it to be replaced or removed
let noCardStreak = 0;                // updated by the live detect loop
let capturedGray = null;             // the downscaled frame the last card was captured from
let latestGray = null;               // the most recent analyzed frame

async function openScanModal() {
  els.scanModal.classList.remove('hidden');
  els.scanHint.textContent = 'Hold the card steady in view';
  els.scanMeta.textContent = '';
  clearBboxOverlay();
  unfreezeFrame();
  resetBulkScan();
  capturingFrame = false;
  autoGoodStreak = 0;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    els.scanVideo.srcObject = mediaStream;
    startAutoDetect();
    startLiveDetectLoop();
  } catch (err) {
    els.scanHint.textContent = 'Camera unavailable — check browser permissions';
  }
}

function stopCamera() {
  stopLiveDetectLoop();
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
}

function closeScanModal() {
  stopAutoDetect();
  stopCamera();
  clearBboxOverlay();
  unfreezeFrame();
  capturingFrame = false;
  awaitingNewCard = false;
  els.scanNextBtn.classList.add('hidden');
  els.scanModal.classList.add('hidden');
}
els.scanBack.addEventListener('click', closeScanModal);

function startAutoDetect() {
  stopAutoDetect();
  const settings = getSettings() || {};
  const interval = AUTO_CHECK_INTERVAL_MS[settings.requestRate] || AUTO_CHECK_INTERVAL_MS.medium;
  autoDetectTimer = setInterval(checkFrameForAutoCapture, interval);
}
function stopAutoDetect() {
  if (autoDetectTimer) clearInterval(autoDetectTimer);
  autoDetectTimer = null;
  autoGoodStreak = 0;
}

// downscale the entire video frame to a small grayscale buffer and
// score it for sharpness (Laplacian variance) and brightness. Small on
// purpose — this runs several times a second, so it needs to stay cheap.
function analyzeFrame() {
  const video = els.scanVideo;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const w = 96;
  const h = Math.round(w * (vh / vw));
  if (!analysisCanvas) analysisCanvas = document.createElement('canvas');
  analysisCanvas.width = w;
  analysisCanvas.height = h;
  const ctx = analysisCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, vw, vh, 0, 0, w, h);

  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  let brightnessSum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    gray[p] = g;
    brightnessSum += g;
  }
  const brightness = brightnessSum / (w * h);

  let lapSum = 0;
  let lapSumSq = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const lap = 4 * gray[idx] - gray[idx - 1] - gray[idx + 1] - gray[idx - w] - gray[idx + w];
      lapSum += lap;
      lapSumSq += lap * lap;
      count++;
    }
  }
  const mean = lapSum / count;
  const sharpness = lapSumSq / count - mean * mean;

  latestGray = gray;
  return { sharpness, brightness, gray };
}

// mean absolute difference between two analyzed frames (0 = identical); Infinity if they aren't comparable
function frameDifference(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

function checkFrameForAutoCapture() {
  if (capturingFrame || !els.scanVideo.srcObject || els.scanVideo.readyState < 2) return;
  const score = analyzeFrame();
  if (!score) return;

  // Just added a card: don't capture it again. Scanning resumes once it has left the frame, or a different
  // card is in view (the picture changed a lot while the detector still sees a card).
  if (awaitingNewCard) {
    const gone = noCardStreak >= NO_CARD_FRAMES_TO_REARM;
    const swapped = noCardStreak === 0 && frameDifference(score.gray, capturedGray) > SWAP_DIFF_THRESHOLD;
    if (!gone && !swapped) {
      autoGoodStreak = 0;
      els.scanHint.textContent = 'Added — show the next card';
      els.scanNextBtn.classList.remove('hidden');
      return;
    }
    awaitingNewCard = false;
    els.scanNextBtn.classList.add('hidden');
  }

  const settings = getSettings() || {};
  const threshold = AUTO_SHARPNESS_THRESHOLD[settings.minImageQuality] ?? AUTO_SHARPNESS_THRESHOLD.medium;
  const brightnessOk = score.brightness > AUTO_BRIGHTNESS_MIN && score.brightness < AUTO_BRIGHTNESS_MAX;
  const sharpOk = score.sharpness >= threshold;

  if (sharpOk && brightnessOk) {
    autoGoodStreak++;
    els.scanHint.textContent = autoGoodStreak >= AUTO_CONSECUTIVE_GOOD_FRAMES ? 'Got it — capturing…' : 'Good shot — hold still…';
    if (autoGoodStreak >= AUTO_CONSECUTIVE_GOOD_FRAMES) {
      performCapture();
    }
  } else {
    autoGoodStreak = 0;
    els.scanHint.textContent = brightnessOk ? 'Hold the card steady in view' : 'Improve lighting on the card';
  }
}

function clearBboxOverlay() {
  const canvas = els.scanBboxOverlay;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// Swaps the live video feed out for a still image of the exact frame that
// was captured and sent to the scanner. Without this, the bbox would be
// drawn on top of whatever the live camera has moved on to by the time the
// response comes back — which can already be a slightly different shot
// than what was actually scanned.
function freezeFrame(dataUrl) {
  els.scanFrozenFrame.src = dataUrl;
  els.scanFrozenFrame.classList.remove('hidden');
  els.scanVideo.classList.add('hidden');
}
function unfreezeFrame() {
  els.scanFrozenFrame.classList.add('hidden');
  els.scanFrozenFrame.src = '';
  els.scanVideo.classList.remove('hidden');
}

// Prepares the overlay canvas for a source image's pixel space (either the
// frozen capture, or the live video) and returns the scale/offset needed
// to map points from it. Both source images are displayed with
// object-fit: cover, so a straight percentage mapping would be wrong
// whenever the frame's aspect ratio doesn't match the on-screen box —
// this replicates cover's scale+center-crop math. Sizing the canvas here
// also clears any previous drawing.
function _prepareOverlayCanvas(imageWidth, imageHeight) {
  const canvas = els.scanBboxOverlay;
  const displayW = els.scanFrame.clientWidth;
  const displayH = els.scanFrame.clientHeight;
  canvas.width = displayW;
  canvas.height = displayH;

  const scale = Math.max(displayW / imageWidth, displayH / imageHeight);
  const offsetX = (imageWidth * scale - displayW) / 2;
  const offsetY = (imageHeight * scale - displayH) / 2;
  return { scale, offsetX, offsetY };
}
function _mapPoint(x, y, t) {
  return { x: x * t.scale - t.offsetX, y: y * t.scale - t.offsetY };
}

// solid box: a confirmed detection, drawn once over the frozen capture.
// /api/scan only ever returns an axis-aligned bbox (from YOLO), so this
// stays a plain rectangle.
function drawBoundingBox(bbox, imageWidth, imageHeight) {
  if (!els.scanBboxOverlay || !bbox || !imageWidth || !imageHeight) return;
  const t = _prepareOverlayCanvas(imageWidth, imageHeight);
  const p0 = _mapPoint(bbox.x0, bbox.y0, t);
  const p1 = _mapPoint(bbox.x1, bbox.y1, t);

  const ctx = els.scanBboxOverlay.getContext('2d');
  ctx.setLineDash([]);
  ctx.strokeStyle = '#4ADE80';
  ctx.lineWidth = 3;
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 4;
  ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
}

// dashed shape: a live, continuously-updating guess, drawn every frame.
// Prefers `quad` — the card's actual 4 corners from scanner.py's contour
// finder — over `bbox`, so a card held at an angle traces its real
// trapezoid outline instead of a box drawn around it. `quad` is only
// present when the contour fallback found one; a YOLO hit is
// axis-aligned by construction and only has `bbox`.
function drawLiveShape(detection, imageWidth, imageHeight) {
  if (!els.scanBboxOverlay || !imageWidth || !imageHeight) return;
  if (!detection || (!detection.quad && !detection.bbox)) {
    clearBboxOverlay();
    return;
  }

  const t = _prepareOverlayCanvas(imageWidth, imageHeight);
  const ctx = els.scanBboxOverlay.getContext('2d');
  ctx.setLineDash([7, 5]);
  ctx.strokeStyle = 'rgba(74, 222, 128, 0.75)';
  ctx.lineWidth = 2;
  ctx.shadowBlur = 0;

  ctx.beginPath();
  if (detection.quad && detection.quad.length === 4) {
    const pts = detection.quad.map((p) => _mapPoint(p.x, p.y, t));
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  } else {
    const p0 = _mapPoint(detection.bbox.x0, detection.bbox.y0, t);
    const p1 = _mapPoint(detection.bbox.x1, detection.bbox.y1, t);
    ctx.rect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

// -----------------------------------------------------------------
// live detection loop. ALL detection happens on the Python side
// (scanner.py's detect_bbox_only — YOLO if trained, contour-quad
// fallback otherwise). The frontend just keeps a frame in flight: grab
// the current video frame, POST it to /api/detect, wait for that
// response, draw whatever bbox comes back, and immediately send the
// next frame. Strictly sequential and unthrottled — no fixed interval —
// so the loop's pace is set entirely by how fast the backend responds.
//
// This keeps running even while performCapture's own /api/scan request
// is in flight, so the video feed and its bounding box keep updating
// live instead of the screen appearing to freeze during identification.
// -----------------------------------------------------------------
let liveDetectRunning = false;
let liveDetectAbort = null;

function captureFrameBlob(video) {
  if (!video.srcObject || video.readyState < 2 || !video.videoWidth) return Promise.resolve(null);
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

async function liveDetectLoop() {
  while (liveDetectRunning) {
    const blob = await captureFrameBlob(els.scanVideo);
    if (!blob) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      continue;
    }

    try {
      liveDetectAbort = new AbortController();
      const result = await api.detectCard(blob, liveDetectAbort.signal);
      liveDetectAbort = null;
      if (!liveDetectRunning) continue; // stopLiveDetectLoop() cancelled us while this was in flight

      if (result.bbox || result.quad) {
        noCardStreak = 0;
        drawLiveShape(result, result.image_width, result.image_height);
      } else {
        noCardStreak += 1;
        clearBboxOverlay();
      }
    } catch (err) {
      liveDetectAbort = null;
      if (err.name === 'AbortError') break; // stopLiveDetectLoop() cancelled us — exit cleanly
      // a transient network/server hiccup — brief pause so a persistent
      // failure doesn't spin the loop as fast as the browser will allow
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

function startLiveDetectLoop() {
  if (liveDetectRunning) return;
  liveDetectRunning = true;
  liveDetectLoop();
}
function stopLiveDetectLoop() {
  liveDetectRunning = false;
  if (liveDetectAbort) {
    liveDetectAbort.abort();
    liveDetectAbort = null;
  }
}

async function performCapture() {
  if (!activeCollection || capturingFrame) return;
  capturingFrame = true; // blocks a second auto-capture from firing while this one's in flight
  if (autoDetectTimer) clearInterval(autoDetectTimer); // pause auto-capture checks only — the live feed and its bbox loop keep running
  els.scanHint.textContent = 'Identifying…';
  els.scanMeta.textContent = 'Good shot detected — sending to the scanner…';

  // Grab the frame to send for full identification, but don't freeze the
  // display on it — the video element (and the live detect loop drawing
  // over it) keep running the whole time /api/scan is in flight, so the
  // screen never appears to freeze during processing.
  const blob = await captureFrameBlob(els.scanVideo);
  const capturedFrameGray = latestGray;
  if (!blob) {
    capturingFrame = false;
    if (els.scanVideo.srcObject) startAutoDetect();
    return;
  }

  try {
    const { bbox, image_width, image_height, ...result } = await api.scanCard(blob, selectedScanGame);

    // added as Near Mint straight away; the session list below the camera is where it can be corrected
    const card = { ...result, game: selectedScanGame, condition: DEFAULT_CONDITION };
    await addScannedCard(card, capturedFrameGray);
    capturingFrame = false;
    autoGoodStreak = 0;
    if (els.scanVideo.srcObject) startAutoDetect();
  } catch (err) {
    els.scanMeta.textContent = err.message || 'Could not identify that card — try again';
    els.scanHint.textContent = err.bbox ? 'Card detected — no match found' : 'Hold the card steady in view';
    capturingFrame = false;
    autoGoodStreak = 0;
    if (els.scanVideo.srcObject) startAutoDetect(); // resume auto-detect after a failed attempt
  }
}

// -----------------------------------------------------------------
// bulk scanning: the "scanned this session" list under the camera
// -----------------------------------------------------------------
function resetBulkScan() {
  scanSession = [];
  awaitingNewCard = false;
  noCardStreak = 0;
  capturedGray = null;
  els.scanNextBtn.classList.add('hidden');
  renderScanSession();
}

// the stored row for a card (stacks by game, name, set and condition, like the backend does)
function findCardRow(collection, card) {
  return collection.cards.find(
    (c) => c.name === card.name && (c.set || '') === (card.set || '') && c.game === card.game &&
      (c.condition || DEFAULT_CONDITION) === card.condition && (!card.id || !c.uid || c.uid === card.id)
  ) || null;
}

async function addScannedCard(card, grayAtCapture) {
  const collectionId = activeCollection && activeCollection.id;
  if (!collectionId) return;
  const updated = await api.addCardToCollection(collectionId, card);
  if (!activeCollection || activeCollection.id !== collectionId) return; // the collection was closed meanwhile
  activeCollection = updated;
  const row = findCardRow(updated, card);
  scanSession.unshift({ n: ++scanSeq, cardId: row ? row.id : null, card, condition: card.condition, busy: false });
  awaitingNewCard = true;
  noCardStreak = 0;
  capturedGray = grayAtCapture ? Float32Array.from(grayAtCapture) : null;
  els.scanMeta.textContent = `Added ${card.name}`;
  els.scanHint.textContent = 'Added — show the next card';
  els.scanNextBtn.classList.remove('hidden');
  clearBboxOverlay();
  els.scanFrame.classList.add('is-added');
  setTimeout(() => els.scanFrame.classList.remove('is-added'), 350);
  if (navigator.vibrate) navigator.vibrate(25);
  afterCollectionChange();
}

function afterCollectionChange() {
  renderScanSession();
  renderCardList(els.detailSearch.value);
  syncActiveCollectionIntoList();
  refreshPrices(activeCollection);
}

function sessionRow(entry) {
  return activeCollection && entry.cardId ? activeCollection.cards.find((c) => c.id === entry.cardId) || null : null;
}

function renderScanSession() {
  const n = scanSession.length;
  els.scanSessionTitle.textContent = n === 0 ? 'Scanned cards appear here' : `Scanned this session: ${n} card${n === 1 ? '' : 's'}`;
  els.scanSessionList.innerHTML = '';
  scanSession.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'scan-session-row';
    row.innerHTML = `
      <div class="card-thumb">${cardThumb(entry.card)}</div>
      <div class="card-info">
        <p class="card-name">${escapeHtml(entry.card.name || 'Unknown card')}</p>
        <p class="card-meta">${escapeHtml(entry.card.set || '')}</p>
      </div>
      <select class="scan-session-condition" aria-label="Condition of ${escapeHtml(entry.card.name || 'this card')}">
        ${CONDITIONS.map((c) => `<option value="${escapeHtml(c)}"${c === entry.condition ? ' selected' : ''}>${escapeHtml(CONDITION_ABBR[c] || c)}</option>`).join('')}
      </select>
      <button class="icon-btn" data-action="undo" aria-label="Remove this scan">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    `;
    row.querySelector('select').addEventListener('change', (e) => changeScanCondition(entry, e.target.value));
    row.querySelector('[data-action="undo"]').addEventListener('click', () => undoScan(entry));
    els.scanSessionList.appendChild(row);
  });
}

// take this scan back out of the collection (one copy)
async function undoScan(entry) {
  if (entry.busy) return;
  entry.busy = true;
  try {
    const row = sessionRow(entry);
    if (row) {
      activeCollection = await api.updateCardQuantity(activeCollection.id, row.id, Math.max(0, row.quantity - 1));
    }
    scanSession = scanSession.filter((e) => e !== entry);
    afterCollectionChange();
  } catch (err) {
    entry.busy = false;
    showToast(err.message || 'Could not remove that card — try again');
  }
}

// move this one copy from its current stack to the stack for the new condition
async function changeScanCondition(entry, condition) {
  if (entry.busy || condition === entry.condition) return;
  entry.busy = true;
  try {
    const row = sessionRow(entry);
    if (row) {
      activeCollection = await api.updateCardQuantity(activeCollection.id, row.id, Math.max(0, row.quantity - 1));
    }
    const card = { ...entry.card, condition };
    activeCollection = await api.addCardToCollection(activeCollection.id, card);
    const moved = findCardRow(activeCollection, card);
    entry.cardId = moved ? moved.id : null;
    entry.condition = condition;
    entry.card = card;
  } catch (err) {
    showToast(err.message || 'Could not change the condition — try again');
  } finally {
    entry.busy = false;
    afterCollectionChange();
  }
}

els.scanNextBtn.addEventListener('click', () => {
  awaitingNewCard = false;
  autoGoodStreak = 0;
  els.scanNextBtn.classList.add('hidden');
  els.scanHint.textContent = 'Hold the card steady in view';
});

// -----------------------------------------------------------------
// public init
// -----------------------------------------------------------------
export async function initCollections(navigateCallback) {
  onNavigate = navigateCallback;
  initImportExport({
    getActiveCollection: () => activeCollection,
    createCollection: async (name) => api.createCollection(name, activeKind),
    imported: (collection) => {
      const at = collections.findIndex((c) => c.id === collection.id);
      if (at === -1) collections.push(collection);
      else collections[at] = collection;
      if (activeCollection && activeCollection.id === collection.id) {
        activeCollection = collection;
        renderCardList(els.detailSearch.value);
        syncActiveCollectionIntoList();
        refreshPrices(activeCollection);
      }
      renderCollectionGrid();
      loadGridPrices();
    },
  });
  await refreshCollections();
}

export function isInCollectionDetail() {
  return !!activeCollection;
}