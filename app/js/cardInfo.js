/**
 * cardInfo.js
 * What Scryfall knows about a Magic card that decks want: its mana value, its colors, whether it is a land, and where
 * it is legal. Cards don't carry this (they carry only what a person adds them with); it is looked up by the card's
 * catalog id (or, for older cards, name and set), a batch of up to 75 at a time, and kept on this device for two
 * weeks, never in the collections or in sync. A card Scryfall can't find is remembered as not found for a day, so the
 * look-up isn't repeated every time a deck is opened. Other games have none of this and are left out.
 */
import { matchMagicRows } from './importMatch.js';

const CACHE_KEY = 'binder_cardinfo_v1';
const FRESH_MS = 14 * 24 * 60 * 60 * 1000;
const MISSING_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 3000;
const LEGAL = { legal: 'l', not_legal: 'n', banned: 'b', restricted: 'r' };

/** { mv, colors, land, legal } out of a Scryfall card: colors as letters ("WU", "" for colorless), legal by format ("l", "n", "b", "r"). */
export function infoFromScryfall(card) {
  const faces = Array.isArray(card.card_faces) ? card.card_faces : [];
  const typeLine = String(card.type_line || (faces[0] && faces[0].type_line) || '');
  const front = typeLine.split(' // ')[0];  // (a card with a land on its back is still a spell)
  let colors = card.colors;
  if (!Array.isArray(colors) && faces[0]) colors = faces[0].colors;
  const legal = {};
  for (const [format, status] of Object.entries(card.legalities || {})) if (LEGAL[status]) legal[format] = LEGAL[status];
  return {
    mv: Number.isFinite(card.cmc) ? card.cmc : 0,
    colors: Array.isArray(colors) ? colors.filter((c) => 'WUBRG'.includes(c)).join('') : '',
    land: /\bLand\b/.test(front),
    legal,
  };
}

/** What a card is remembered under: its catalog id, else game, name and set. */
export function infoKey(card) {
  return card.uid || `${card.game}|${String(card.name || '').toLowerCase()}|${card.set || ''}`;
}

/**
 * The look-up for one device. Everything it touches is passed in so it can be tested:
 *   storage: { getItem, setItem }, fetchFn, nowMs, onChange(): called when something new was learnt.
 */
export function createCardInfo({ storage, fetchFn, nowMs = Date.now, onChange = () => {} }) {
  let cache = {};
  try {
    const saved = JSON.parse(storage.getItem(CACHE_KEY) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) cache = saved;
  } catch (e) { /* start empty */ }
  const save = () => {
    const keys = Object.keys(cache);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => cache[a].at - cache[b].at).slice(0, keys.length - MAX_ENTRIES + 500).forEach((k) => delete cache[k]);
    }
    try { storage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* kept for this visit only */ }
  };
  let pending = null;

  const service = {
    /** What is known of this card ({ mv, colors, land, legal }), or null (another game, not looked up yet, not found). */
    get(card) {
      if (!card || card.game !== 'mtg') return null;
      const entry = cache[infoKey(card)];
      return entry && !entry.missing ? entry : null;
    },
    /** The Magic cards of this list that need a look-up (none known, an old answer, or not found a day ago). */
    needed(cards) {
      const now = nowMs();
      const wanted = new Map();
      for (const card of cards || []) {
        if (card.game !== 'mtg') continue;
        const key = infoKey(card);
        const entry = cache[key];
        const fresh = entry && now - entry.at < (entry.missing ? MISSING_MS : FRESH_MS);
        if (!fresh && !wanted.has(key)) wanted.set(key, card);
      }
      return [...wanted.entries()];
    },
    /** Looks up what is needed for these cards; never throws (offline leaves what there is). Resolves to true when something was learnt. */
    load(cards) {
      const list = service.needed(cards);
      if (list.length === 0) return Promise.resolve(false);
      if (pending) return pending.then(() => service.load(cards));
      pending = (async () => {
        const rows = list.map(([, card]) => ({ name: card.name, setCode: card.set || '', setName: '', number: card.number || '', binderId: card.uid || '', scryfallId: '' }));
        let found = new Map();
        try {
          found = await matchMagicRows(rows, { fetchFn, convert: infoFromScryfall });
        } catch (e) { /* offline: nothing learnt */ }
        if (found.size === 0 && list.length > 0) return false;  // (a failed look-up must not mark cards as not found)
        const at = nowMs();
        list.forEach(([key], i) => {
          cache[key] = found.has(i) ? { ...found.get(i), at } : { missing: true, at };
        });
        save();
        onChange();
        return true;
      })().finally(() => { pending = null; });
      return pending;
    },
  };
  return service;
}

// ---- the one used by the page -----------------------------------------------------------------------------------

function pageStorage() {
  try { return localStorage; } catch (e) { return { getItem: () => null, setItem: () => {} }; }
}

export const cardInfo = createCardInfo({
  storage: pageStorage(),
  fetchFn: (...args) => fetch(...args),
  onChange: () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event('binder:cardinfo-changed')); },
});
