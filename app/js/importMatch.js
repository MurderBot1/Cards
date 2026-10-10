/**
 * importMatch.js
 * Turns the rows of an imported collection file into cards Binder can store, finding the real printing of each Magic
 * card at Scryfall (so it gets its catalog id, rarity and picture, and so prices work). A card is looked up by the most
 * exact thing the file gives (Scryfall id, then set and collector number, then name and set, then the name alone); one
 * that isn't found that way is tried again with the next one. Rows that can't be matched are still imported, as the
 * file wrote them. Other games aren't looked up: they are imported as written.
 */
import { scryfallResult } from './cardSearch.js';

const COLLECTION_URL = 'https://api.scryfall.com/cards/collection';
const SETS_URL = 'https://api.scryfall.com/sets';
const BATCH = 75;
const GAP_MS = 120;  // Scryfall asks for 50-100 ms between requests

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frontFace = (name) => String(name || '').split(' // ')[0].toLowerCase();

async function postJson(fetchFn, url, body) {
  const res = await fetchFn(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Scryfall answered ${res.status}`);
  return res.json();
}

let setsByName = null;

/** Scryfall's sets as { "magic 2011": "m11", ... }, fetched once (needed for files that give a set's name, not its code). */
export async function loadSetsByName(fetchFn = (...args) => fetch(...args)) {
  if (setsByName) return setsByName;
  const res = await fetchFn(SETS_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Scryfall answered ${res.status}`);
  const data = await res.json();
  const map = {};
  for (const set of data.data || []) if (set.name && set.code) map[set.name.toLowerCase()] = set.code;
  setsByName = map;
  return map;
}

// the Scryfall identifiers that could find a row, most exact first
export function identifiersFor(row, setCodeByName = {}) {
  const out = [];
  const binderId = row.binderId && row.binderId.startsWith('mtg-') ? row.binderId.slice(4) : '';
  const id = UUID.test(row.scryfallId) ? row.scryfallId : UUID.test(binderId) ? binderId : '';
  if (id) out.push({ id });
  const code = (row.setCode || setCodeByName[String(row.setName || '').toLowerCase()] || '').toLowerCase();
  if (code && row.number) out.push({ set: code, collector_number: row.number });
  if (code) out.push({ name: row.name, set: code });
  out.push({ name: row.name });
  return out;
}

const keyOf = (identifier) => JSON.stringify(identifier);

// the card in `found` an identifier asked for, or undefined
function pick(found, identifier) {
  if (identifier.id) return found.find((c) => c.id === identifier.id);
  if (identifier.collector_number) return found.find((c) => c.set === identifier.set && String(c.collector_number) === String(identifier.collector_number));
  if (identifier.set) return found.find((c) => c.set === identifier.set && frontFace(c.name) === frontFace(identifier.name));
  return found.find((c) => frontFace(c.name) === frontFace(identifier.name));
}

/**
 * Finds the Scryfall card for each Magic row. `rows` are parsed rows (collectionCsv.js); resolves to a Map from a row's
 * index to its search-result-shaped card ({ id: 'mtg-…', name, set, number, rarity, image, game }). Rows that aren't
 * found are left out. `onProgress(done, total)` is called as batches finish. A request that fails (offline) ends the
 * look-up early, leaving whatever was found; it never throws.
 */
export async function matchMagicRows(rows, { fetchFn = (...args) => fetch(...args), onProgress = () => {} } = {}) {
  const matches = new Map();
  let sets = {};
  if (rows.some((r) => !r.setCode && r.setName)) {
    try { sets = await loadSetsByName(fetchFn); } catch (e) { sets = {}; }
  }
  const candidates = rows.map((row) => identifiersFor(row, sets));
  let pending = rows.map((_, i) => i);
  const total = rows.length;
  const maxPasses = Math.max(...candidates.map((c) => c.length));
  try {
    for (let pass = 0; pass < maxPasses && pending.length; pass++) {
      // rows asking for the same identifier share one request
      const wanted = new Map();  // identifier key -> { identifier, rows: [index] }
      for (const i of pending) {
        const identifier = candidates[i][Math.min(pass, candidates[i].length - 1)];
        const key = keyOf(identifier);
        if (!wanted.has(key)) wanted.set(key, { identifier, rows: [] });
        wanted.get(key).rows.push(i);
      }
      const entries = [...wanted.values()];
      const missed = new Set();
      for (let at = 0; at < entries.length; at += BATCH) {
        if (at) await pause(GAP_MS);
        const batch = entries.slice(at, at + BATCH);
        const data = await postJson(fetchFn, COLLECTION_URL, { identifiers: batch.map((e) => e.identifier) });
        const found = Array.isArray(data.data) ? data.data : [];
        for (const entry of batch) {
          const card = pick(found, entry.identifier);
          for (const i of entry.rows) {
            if (card) matches.set(i, scryfallResult(card));
            else missed.add(i);
          }
        }
        onProgress(matches.size, total);
      }
      pending = pending.filter((i) => missed.has(i));
    }
  } catch (e) {
    // offline or Scryfall unwell: keep what was found
  }
  onProgress(matches.size, total);
  return matches;
}

/**
 * The cards to store for imported rows. `matches` is what matchMagicRows found (or an empty Map); `defaultGame` is used
 * for rows whose file didn't say. A matched card takes its name, set, collector number, rarity, picture and catalog id
 * from the match; the file supplies condition, finish, language and how many.
 */
export function buildCards(rows, matches, defaultGame = 'mtg') {
  return rows.map((row, i) => {
    const game = row.game || defaultGame;
    const match = game === 'mtg' ? matches.get(i) : null;
    const prefix = { mtg: 'mtg-', pokemon: 'pkm-', yugioh: 'ygo-' }[game];
    const uid = match ? match.id : row.binderId && row.binderId.startsWith(prefix) ? row.binderId : '';  // (a Binder export's own id)
    const card = {
      name: match ? match.name : row.name,
      game,
      set: match ? match.set : row.setCode || row.setName,
      rarity: match ? match.rarity : row.rarity,
      image: match ? match.image : row.image,
      condition: row.condition,
      quantity: row.quantity,
    };
    const number = row.number || (match ? match.number : '');
    if (number) card.number = number;
    if (uid) card.uid = uid;
    if (row.foil) card.foil = true;
    if (row.language) card.language = row.language;
    return card;
  });
}
