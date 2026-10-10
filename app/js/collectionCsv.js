/**
 * collectionCsv.js
 * Collections to and from CSV, in the layouts the big collection apps use.
 *
 * Importing reads the header row and works out what each column means from its name, so one reader covers Moxfield,
 * Deckbox, ManaBox, the TCGplayer app, Archidekt, Delver Lens, Binder's own export and most other files that have a
 * card name column. What those apps call things differs (Deckbox's "Edition" is a set's full name, Moxfield's is its
 * code; conditions are "Good (Lightly Played)" in one and "lightly_played" in another), so values are normalised too.
 *
 * Everything here is pure; matching rows to real cards (Scryfall) is in importMatch.js.
 */
import { parseCsv, toCsv } from './csv.js';

export const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];

// ---- headers -------------------------------------------------------------------------------------------------

// header text -> the letters and digits of it, lower case ("Set Code" -> "setcode", "collector_number" -> "collectornumber")
const keyOf = (header) => String(header || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// what a column holds, by the names the apps give it; earlier names win when a file has several for one thing
const FIELD_NAMES = {
  name: ['simplename', 'name', 'cardname', 'card', 'title', 'productname'],
  quantity: ['count', 'quantity', 'qty', 'amount', 'cardcount', 'owned', 'totalquantity'],
  setCode: ['setcode', 'editioncode', 'setid', 'expansioncode', 'setabbreviation'],
  setName: ['setname', 'editionname', 'expansion', 'expansionname'],
  setAny: ['set', 'edition'],  // a code in some apps and a full name in others: decided from the values
  number: ['collectornumber', 'cardnumber', 'number', 'collectorno', 'cardno', 'cardnum', 'no'],
  condition: ['condition', 'cond', 'grade'],
  language: ['language', 'lang'],
  foil: ['foil', 'finish', 'printing', 'foiling', 'isfoil', 'foiltype'],
  rarity: ['rarity'],
  scryfallId: ['scryfallid', 'scryfalluuid'],
  binderId: ['binderid'],
  game: ['game', 'tcg', 'category'],
  image: ['imageurl', 'image'],
};

/** For each field, the index of the column that holds it (or -1): { name: 0, quantity: 1, ... }. */
export function mapColumns(header) {
  const keys = header.map(keyOf);
  const map = {};
  for (const [field, names] of Object.entries(FIELD_NAMES)) {
    map[field] = -1;
    for (const name of names) {
      const at = keys.indexOf(name);
      if (at !== -1) {
        map[field] = at;
        break;
      }
    }
  }
  return map;
}

/** Which app a header row looks like ('Moxfield', 'Deckbox', 'ManaBox', 'TCGplayer', 'Archidekt', 'Binder'), else null. */
export function detectFormat(header) {
  const keys = new Set(header.map(keyOf));
  const has = (...names) => names.every((n) => keys.has(n));
  if (has('binderid') || (has('count', 'name', 'game', 'setcode'))) return 'Binder';
  if (has('manaboxid')) return 'ManaBox';
  if (has('tradelistcount') && (keys.has('lastmodified') || keys.has('proxy') || keys.has('alter'))) return 'Moxfield';
  if (has('tradelistcount') && (keys.has('cardnumber') || keys.has('signed') || keys.has('edition'))) return 'Deckbox';
  if (keys.has('productid') || (keys.has('simplename') && keys.has('printing'))) return 'TCGplayer';
  if (has('editioncode', 'editionname') || has('multiverseid')) return 'Archidekt';
  return null;
}

// ---- values --------------------------------------------------------------------------------------------------

const CONDITION_KEYS = {
  nearmint: 'Near Mint', mint: 'Near Mint', nm: 'Near Mint', m: 'Near Mint', nmmint: 'Near Mint', nearmintmint: 'Near Mint',
  lightlyplayed: 'Lightly Played', lightplayed: 'Lightly Played', lightplay: 'Lightly Played', lp: 'Lightly Played',
  slightlyplayed: 'Lightly Played', sp: 'Lightly Played', goodlightlyplayed: 'Lightly Played', good: 'Lightly Played',
  excellent: 'Lightly Played', ex: 'Lightly Played',
  moderatelyplayed: 'Moderately Played', moderateplayed: 'Moderately Played', mp: 'Moderately Played',
  played: 'Moderately Played', pl: 'Moderately Played',
  heavilyplayed: 'Heavily Played', heavyplayed: 'Heavily Played', hp: 'Heavily Played',
  damaged: 'Damaged', dmg: 'Damaged', poor: 'Damaged', d: 'Damaged',
};

/** One of the five conditions for what an app wrote ("Good (Lightly Played)", "near_mint", "NM"), or null if unknown. */
export function normalizeCondition(value) {
  const key = String(value || '').toLowerCase().replace(/[^a-z]/g, '');
  return CONDITION_KEYS[key] || null;
}

/** Whether a finish / foil column's value means foil ("foil", "Yes", "Holofoil", "etched"), not "Normal" or blank. */
export function isFoilValue(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return false;
  if (/^(no|false|0|n|normal|nonfoil|non-foil|non foil|regular|standard|none)$/.test(v)) return false;
  if (/^(yes|true|1|y|x)$/.test(v)) return true;
  return /foil|holo|etched/.test(v) && !/non[- ]?foil/.test(v);
}

const LANGUAGES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ja: 'Japanese', jp: 'Japanese',
  ko: 'Korean', kr: 'Korean', ru: 'Russian', zhs: 'Chinese Simplified', zht: 'Chinese Traditional', cs: 'Chinese Simplified',
  ct: 'Chinese Traditional', ph: 'Phyrexian',
};

/** A language as a full name: "en" -> "English"; anything else is kept as written. */
export function normalizeLanguage(value) {
  const v = String(value || '').trim();
  return LANGUAGES[v.toLowerCase()] || v;
}

const GAME_KEYS = {
  mtg: 'mtg', magic: 'mtg', magicthegathering: 'mtg',
  pokemon: 'pokemon', pokemontcg: 'pokemon', pkm: 'pokemon',
  yugioh: 'yugioh', yugiohtcg: 'yugioh', ygo: 'yugioh',
};

/** 'mtg' | 'pokemon' | 'yugioh' for a game column's value, or null. */
export function normalizeGame(value) {
  const plain = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');  // Pokémon -> Pokemon
  return GAME_KEYS[plain.toLowerCase().replace(/[^a-z]/g, '')] || null;
}

// "1", "1.0", " 3 " -> 1, 1, 3; blank or junk -> null; zero and negatives -> 0
function parseCount(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const n = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return n > 0 ? Math.min(100000, Math.round(n)) : 0;
}

// Whether a column that could be a set code or a set name (Moxfield: code, Deckbox: name) holds codes.
function looksLikeCodes(values) {
  const present = values.filter((v) => v);
  return present.length > 0 && present.filter((v) => /^[A-Za-z0-9_-]{2,7}$/.test(v)).length >= present.length * 0.8;
}

// ---- reading a file --------------------------------------------------------------------------------------------

/**
 * Reads a collection CSV. Resolves to:
 *   { ok: true, format, columns, rows: [{ line, name, quantity, game, setCode, setName, number, condition, language,
 *     foil, rarity, scryfallId, binderId, image }], skipped, assumedCondition, hasGame }
 *   { ok: false, error }
 * `format` is the app the file looks like (or null); `skipped` counts rows with no name or a zero count; each row's
 * `game` is null when the file doesn't say (the caller chooses); `assumedCondition` counts rows whose condition cell was
 * blank or unrecognised and so became Near Mint; `language` is '' for English (the default, which isn't stored).
 */
export function parseCollectionCsv(text) {
  const table = parseCsv(text);
  if (table.length === 0) return { ok: false, error: 'That file is empty.' };
  const header = table[0];
  const columns = mapColumns(header);
  if (columns.name === -1) {
    return { ok: false, error: "Couldn't find a card name column. The first row should name its columns (Name, Count, Set, Condition…)." };
  }
  const body = table.slice(1);
  const cell = (row, field) => (columns[field] === -1 ? '' : String(row[columns[field]] == null ? '' : row[columns[field]]).trim());

  // a plain "Set" / "Edition" column is a code or a name, depending on what is in it
  let setIsCode = false;
  if (columns.setAny !== -1 && columns.setCode === -1 && columns.setName === -1) {
    setIsCode = looksLikeCodes(body.map((r) => String(r[columns.setAny] == null ? '' : r[columns.setAny]).trim()));
  }

  const rows = [];
  let skipped = 0;
  let assumedCondition = 0;
  body.forEach((raw, i) => {
    const name = cell(raw, 'name');
    const count = parseCount(cell(raw, 'quantity'));
    const quantity = count === null ? 1 : count;
    if (!name || quantity === 0) {
      skipped += 1;
      return;
    }
    let setCode = cell(raw, 'setCode');
    let setName = cell(raw, 'setName');
    const setAny = cell(raw, 'setAny');
    if (setAny && !setCode && !setName) {
      if (setIsCode) setCode = setAny;
      else setName = setAny;
    } else if (setAny && setCode && !setName) {
      setName = setAny;  // (the TCGplayer app: "Set" is the full name next to a "Set Code" column)
    }
    const conditionText = cell(raw, 'condition');
    const condition = normalizeCondition(conditionText);
    if (!condition && columns.condition !== -1) assumedCondition += 1;  // (no condition column at all is just "Near Mint")
    rows.push({
      line: i + 2,
      name,
      quantity,
      game: normalizeGame(cell(raw, 'game')),
      setCode: setCode.toUpperCase(),
      setName,
      number: cell(raw, 'number'),
      condition: condition || 'Near Mint',
      language: normalizeLanguage(cell(raw, 'language')) === 'English' ? '' : normalizeLanguage(cell(raw, 'language')),  // (English is the default, so it isn't stored)
      foil: isFoilValue(cell(raw, 'foil')),
      rarity: cell(raw, 'rarity'),
      scryfallId: cell(raw, 'scryfallId').toLowerCase(),
      binderId: cell(raw, 'binderId'),
      image: cell(raw, 'image'),
    });
  });
  if (rows.length === 0) return { ok: false, error: 'There are no cards in that file.' };
  return { ok: true, format: detectFormat(header), columns, rows, skipped, assumedCondition, hasGame: columns.game !== -1 };
}

// ---- writing ---------------------------------------------------------------------------------------------------

export const EXPORT_HEADER = [
  'Count', 'Name', 'Game', 'Set Code', 'Collector Number', 'Rarity', 'Condition', 'Foil', 'Language', 'Binder ID',
  'Scryfall ID', 'Image URL', 'Collection',
];

/**
 * Binder's own export: a row per card with everything Binder knows about it. `Binder ID` is the catalog id the card
 * came from (it lets a re-import find the exact card again), `Scryfall ID` is the same id for Magic cards, and `Foil`
 * is "foil" or blank, as Moxfield and Deckbox write it.
 */
export function exportCollectionCsv(collection) {
  const rows = [EXPORT_HEADER];
  for (const card of collection.cards || []) {
    const uid = typeof card.uid === 'string' ? card.uid : '';
    rows.push([
      card.quantity,
      card.name,
      card.game,
      card.set || '',
      card.number || '',
      card.rarity || '',
      card.condition || 'Near Mint',
      card.foil === true ? 'foil' : '',
      card.language || 'English',
      uid,
      card.game === 'mtg' && uid.startsWith('mtg-') ? uid.slice(4) : '',
      card.image || '',
      collection.name || '',
    ]);
  }
  return toCsv(rows);
}

/** A file name for a collection's export: "My Binder" -> "My Binder.csv", with nothing a file system dislikes. */
export function exportFileName(name) {
  const clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${clean || 'Binder collection'}.csv`;
}
