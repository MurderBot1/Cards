/**
 * currency.js
 * Showing card prices in the person's own currency. Prices come in US dollars (prices.js); this turns them into the
 * currency of the person's region and formats them, nothing else changes.
 *
 * Which currency: the person's choice in Settings, else a guess from the device's language region ("en-GB") or, when the
 * language names no region ("en"), its time zone. That is a rough guess from settings the page can already read: no
 * location is asked for and nothing is sent anywhere. Rates: US dollars to each currency, from Frankfurter (the
 * European Central Bank's rates; free, no key) with open.er-api.com as a second source, asked of straight from the page and
 * kept on the device for 12 hours (an old rate is still used while offline). With no rate at all, prices stay in dollars.
 */

import { currencyRows, summary } from './currencyPicker.js';

const RATES_KEY = 'binder_fx_v1';
const CHOICE_KEY = 'binder_currency';
const FRESH_MS = 12 * 60 * 60 * 1000;
const TIMEOUT_MS = 10000;

// the currencies the rate sources cover (Frankfurter's list): what can be picked when no rates have been read yet
export const CURRENCIES = [
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CNY', 'INR', 'KRW', 'MXN', 'BRL', 'CHF', 'SEK', 'NOK', 'DKK',
  'PLN', 'CZK', 'HUF', 'RON', 'TRY', 'ZAR', 'ILS', 'SGD', 'HKD', 'MYR', 'THB', 'PHP', 'IDR', 'ISK',
];

const EURO_REGIONS = 'AT BE BG CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK'.split(' ');
const REGION_CURRENCY = {
  US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD', JP: 'JPY', CN: 'CNY', IN: 'INR', KR: 'KRW', MX: 'MXN',
  BR: 'BRL', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON', TR: 'TRY',
  ZA: 'ZAR', IL: 'ILS', SG: 'SGD', HK: 'HKD', MY: 'MYR', TH: 'THB', PH: 'PHP', ID: 'IDR', IS: 'ISK',
};
for (const region of EURO_REGIONS) REGION_CURRENCY[region] = 'EUR';

// time zones that tell the region when the language does not (the rest of the world: see regionOf)
const ZONE_REGION = {
  'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Berlin': 'DE', 'Europe/Paris': 'FR', 'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE', 'Europe/Vienna': 'AT', 'Europe/Lisbon': 'PT',
  'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO', 'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI',
  'Europe/Warsaw': 'PL', 'Europe/Prague': 'CZ', 'Europe/Budapest': 'HU', 'Europe/Athens': 'GR', 'Europe/Zurich': 'CH',
  'Europe/Istanbul': 'TR', 'Europe/Bucharest': 'RO', 'Europe/Sofia': 'BG', 'Europe/Zagreb': 'HR',
  'Europe/Luxembourg': 'LU', 'Europe/Tallinn': 'EE', 'Europe/Riga': 'LV', 'Europe/Vilnius': 'LT',
  'Europe/Bratislava': 'SK', 'Europe/Ljubljana': 'SI', 'Europe/Malta': 'MT', 'Atlantic/Reykjavik': 'IS',
  'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA', 'America/Winnipeg': 'CA',
  'America/Halifax': 'CA', 'America/Mexico_City': 'MX', 'America/Sao_Paulo': 'BR', 'Pacific/Auckland': 'NZ',
  'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR', 'Asia/Shanghai': 'CN', 'Asia/Hong_Kong': 'HK', 'Asia/Singapore': 'SG',
  'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Jerusalem': 'IL', 'Africa/Johannesburg': 'ZA', 'Asia/Bangkok': 'TH',
  'Asia/Manila': 'PH', 'Asia/Jakarta': 'ID', 'Asia/Kuala_Lumpur': 'MY',
};

/** The region (two letters) a language tag and time zone point at: the tag's own, else the zone's, else the language's usual. */
export function regionOf(locale, timeZone) {
  let tag = null;
  try { tag = new Intl.Locale(String(locale || '')); } catch (e) { /* not a language tag */ }
  if (tag && tag.region) return tag.region.toUpperCase();
  if (timeZone) {
    if (ZONE_REGION[timeZone]) return ZONE_REGION[timeZone];
    if (timeZone.startsWith('Australia/')) return 'AU';
    if (timeZone.startsWith('America/') || timeZone.startsWith('US/') || timeZone === 'Pacific/Honolulu') return 'US';
  }
  try { if (tag) return tag.maximize().region || 'US'; } catch (e) { /* fall through */ }
  return 'US';
}

/** The currency to guess for a device: the region's, or US dollars for a region we don't map (it can be picked in Settings). */
export function guessCurrency(locale, timeZone) {
  return REGION_CURRENCY[regionOf(locale, timeZone)] || 'USD';
}

/** Rates (units of each currency per US dollar) out of what Frankfurter or open.er-api.com answered, or null. */
export function parseRates(body) {
  const raw = body && typeof body === 'object' ? body.rates : null;
  if (!raw || typeof raw !== 'object') return null;
  const rates = { USD: 1 };
  for (const [code, rate] of Object.entries(raw)) {
    if (/^[A-Z]{3}$/.test(code) && typeof rate === 'number' && Number.isFinite(rate) && rate > 0) rates[code] = rate;
  }
  return Object.keys(rates).length > 1 ? rates : null;
}

const SOURCES = [
  'https://api.frankfurter.dev/v1/latest?base=USD',
  'https://open.er-api.com/v6/latest/USD',
];

async function getJson(fetchFn, url) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetchFn(url, { headers: { Accept: 'application/json' }, signal: controller ? controller.signal : undefined });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A currency "service" for one device. Everything it touches is passed in so it can be tested:
 *   storage: { getItem, setItem }, fetchFn, locale, timeZone, nowMs, onChange(): called when what is shown changes.
 */
export function createCurrency({ storage, fetchFn, locale, timeZone, nowMs = Date.now, onChange = () => {} }) {
  const read = (key) => { try { return storage.getItem(key); } catch (e) { return null; } };
  const write = (key, value) => { try { storage.setItem(key, value); } catch (e) { /* kept for this visit only */ } };

  let cache = null;  // { at, rates }
  try {
    const saved = JSON.parse(read(RATES_KEY) || 'null');
    if (saved && typeof saved.at === 'number' && parseRates({ rates: saved.rates })) cache = { at: saved.at, rates: parseRates({ rates: saved.rates }) };
  } catch (e) { /* start without rates */ }
  let choice = read(CHOICE_KEY) || 'auto';
  let pending = null;

  const service = {
    /** 'auto' or the currency code the person picked. */
    choice: () => choice,
    setChoice(next) {
      choice = next === 'auto' || /^[A-Z]{3}$/.test(next) ? next : 'auto';
      write(CHOICE_KEY, choice);
      onChange();
    },
    /** The currency that would be shown if rates are known: the pick, else the guess. */
    wanted: () => (choice === 'auto' ? guessCurrency(locale, timeZone) : choice),
    /** The currency prices are shown in: the wanted one if there is a rate for it, else US dollars. */
    code() {
      const wanted = service.wanted();
      return cache && cache.rates[wanted] ? wanted : 'USD';
    },
    rate: () => (cache ? cache.rates[service.code()] : 1),
    /** The currencies that can be picked: those with a rate, else the usual list. */
    available: () => (cache ? Object.keys(cache.rates).sort() : CURRENCIES.slice()),
    /** A US dollar amount in the shown currency (a number). */
    toLocal: (usd) => usd * service.rate(),
    /** The rate for one currency (units per US dollar), or null when there is none. */
    rateOf: (code) => (code === 'USD' ? 1 : cache && cache.rates[code] ? cache.rates[code] : null),
    /** A US dollar amount as text in any currency that has a rate ("£7.90", "¥1,150"), or null when there is none. */
    formatIn(code, usd) {
      const rate = service.rateOf(code);
      if (rate === null) return null;
      const amount = usd * rate;
      const tag = code === 'USD' ? 'en-US' : locale || 'en-US';
      try {
        return amount.toLocaleString(tag, { style: 'currency', currency: code });
      } catch (e) {
        return `${amount.toFixed(2)} ${code}`;
      }
    },
    /** A US dollar amount as text in the shown currency. */
    format: (usd) => service.formatIn(service.code(), usd),
    /** When the rates were read (ms), or 0 when there are none. */
    updatedAt: () => (cache ? cache.at : 0),
    /** True when the rates are old enough to ask again. */
    stale: () => !cache || nowMs() - cache.at > FRESH_MS,
    /** Reads the rates if they are stale; never throws (offline keeps what there is). Resolves to true when they changed. */
    refresh({ force = false } = {}) {
      if (!force && !service.stale()) return Promise.resolve(false);
      if (pending) return pending;
      pending = (async () => {
        for (const url of SOURCES) {
          try {
            const rates = parseRates(await getJson(fetchFn, url));
            if (!rates) continue;
            cache = { at: nowMs(), rates };
            write(RATES_KEY, JSON.stringify({ at: cache.at, rates }));
            onChange();
            return true;
          } catch (e) { /* try the next source */ }
        }
        return false;
      })().finally(() => { pending = null; });
      return pending;
    },
  };
  return service;
}

// ---- the one used by the page ---------------------------------------------------------------------------------

function pageStorage() {
  try { return localStorage; } catch (e) { return { getItem: () => null, setItem: () => {} }; }
}

export const currency = createCurrency({
  storage: pageStorage(),
  fetchFn: (...args) => fetch(...args),
  locale: typeof navigator !== 'undefined' ? (navigator.languages && navigator.languages[0]) || navigator.language : 'en-US',
  timeZone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return ''; } })(),
  onChange: () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event('binder:currency-changed')); },
});

export const formatPrice = (usd) => currency.format(usd);
export const toLocalPrice = (usd) => currency.toLocal(usd);
export const priceCurrency = () => currency.code();

// The Settings picker: a card showing the currency in use (tap it to choose another). Reads the rates in the background.
export function initCurrencySetting() {
  const card = document.getElementById('currency-setting');
  if (!card) return;
  const locale = typeof navigator !== 'undefined' ? (navigator.languages && navigator.languages[0]) || navigator.language : 'en-US';
  const names = (() => { try { return new Intl.DisplayNames(undefined, { type: 'currency' }); } catch (e) { return null; } })();
  const $ = (id) => document.getElementById(id);
  const sheet = $('modal-currency');
  const list = $('currency-list');
  const search = $('currency-search');

  const showCard = () => {
    const now = summary(currency, { names, locale, now: Date.now() });
    $('currency-badge').textContent = now.symbol;
    $('currency-title').textContent = now.title;
    $('currency-sub').textContent = now.subtitle;
    $('currency-rates').textContent = now.rates;
  };
  const showList = () => {
    const rows = currencyRows(currency, search.value, { names, locale });
    list.innerHTML = '';
    for (const row of rows) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `currency-row${row.selected ? ' is-selected' : ''}`;
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', String(row.selected));
      btn.dataset.value = row.value;
      const badge = document.createElement('span');
      badge.className = 'currency-badge';
      badge.textContent = row.symbol;
      const text = document.createElement('span');
      text.className = 'currency-row-text';
      const title = document.createElement('span');
      title.className = 'currency-row-title';
      title.textContent = row.title;
      const detail = document.createElement('span');
      detail.className = 'currency-row-detail';
      detail.textContent = row.detail;
      text.append(title, detail);
      const sample = document.createElement('span');
      sample.className = 'currency-row-sample';
      sample.textContent = row.sample;
      const tick = document.createElement('span');
      tick.className = 'currency-tick';
      tick.textContent = row.selected ? '\u2713' : '';
      btn.append(badge, text, sample, tick);
      btn.addEventListener('click', () => {
        currency.setChoice(row.value);
        close();
      });
      list.appendChild(btn);
    }
    $('currency-empty').classList.toggle('hidden', rows.length > 0);
  };
  const open = () => {
    search.value = '';
    showList();
    sheet.classList.remove('hidden');
    const chosen = list.querySelector('.is-selected');
    if (chosen) chosen.scrollIntoView({ block: 'center' });
    currency.refresh();
  };
  const close = () => sheet.classList.add('hidden');

  card.addEventListener('click', open);
  $('currency-close').addEventListener('click', close);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
  search.addEventListener('input', showList);
  window.addEventListener('binder:currency-changed', () => { showCard(); if (!sheet.classList.contains('hidden')) showList(); });
  showCard();
  currency.refresh();
}
