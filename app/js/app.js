/**
 * app.js
 * Boots the app: wires up the bottom tab bar, keeps the header in
 * sync with whatever is on screen, and initializes the collection
 * and settings modules.
 */
import { initCollections, closeCollectionDetail, isInCollectionDetail } from './collections.js';
import { initSettings } from './settings.js';

const TAB_TITLES = { shop: 'Shop', collection: 'Collection', settings: 'Account' };

const tabButtons = document.querySelectorAll('.tab-btn');
const views = document.querySelectorAll('.view');
const headerTitle = document.getElementById('header-title');
const headerSubtitle = document.getElementById('header-subtitle');
const headerBackBtn = document.getElementById('header-back-btn');

let activeTab = 'shop';

function setHeader(title, subtitle) {
  headerTitle.textContent = title;
  if (subtitle) {
    headerSubtitle.textContent = subtitle;
    headerSubtitle.classList.remove('hidden');
  } else {
    headerSubtitle.classList.add('hidden');
  }
}

function showTab(tab) {
  activeTab = tab;

  views.forEach((v) => v.classList.toggle('is-active', v.dataset.view === tab));
  tabButtons.forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));

  // leaving the collection tab always resets back to its list sub-view
  if (tab !== 'collection' && isInCollectionDetail()) {
    closeCollectionDetail();
  }

  headerBackBtn.classList.toggle('hidden', !(tab === 'collection' && isInCollectionDetail()));
  setHeader(TAB_TITLES[tab], '');
}

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

headerBackBtn.addEventListener('click', () => {
  if (activeTab === 'collection' && isInCollectionDetail()) {
    closeCollectionDetail();
    headerBackBtn.classList.add('hidden');
    setHeader(TAB_TITLES.collection, '');
  }
});

// collections.js calls this when it enters/leaves a collection's detail view
function onCollectionNavigate({ inDetail, title, subtitle }) {
  headerBackBtn.classList.toggle('hidden', !inDetail);
  setHeader(title, subtitle);
}

async function boot() {
  await initSettings();
  await initCollections(onCollectionNavigate);
  showTab('shop');
}

boot();