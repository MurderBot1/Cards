/**
 * importExport.js
 * The "Import" and "Export" buttons of a collection: reading a CSV file from Moxfield, Deckbox, ManaBox, the TCGplayer
 * app, Archidekt, Delver Lens or Binder itself into a collection (collectionCsv.js reads it, importMatch.js finds the
 * cards at Scryfall), and saving a collection as Binder's own CSV (fileSave.js).
 */
import { api } from './api.js';
import { exportCollectionCsv, exportFileName, parseCollectionCsv } from './collectionCsv.js';
import { buildCards, matchMagicRows } from './importMatch.js';
import { saveTextFile } from './fileSave.js';
import { showToast } from './ui.js';

const MAGIC_FORMATS = new Set(['Moxfield', 'Deckbox', 'ManaBox', 'Archidekt']);
const GAME_NAMES = { mtg: 'Magic', pokemon: 'Pokémon', yugioh: 'Yu-Gi-Oh!' };

const $ = (id) => document.getElementById(id);
const els = {
  modal: $('modal-import'),
  title: $('import-title'),
  file: $('import-file'),
  text: $('import-text'),
  newGroup: $('import-new-group'),
  newName: $('import-new-name'),
  gameGroup: $('import-game-group'),
  game: $('import-game'),
  summary: $('import-summary'),
  error: $('import-error'),
  bar: $('import-bar'),
  cancel: $('import-cancel'),
  go: $('import-go'),
};

let hooks = null;
let target = null;   // the collection being imported into, or null to make a new one
let parsed = null;   // the parse result of the text, when it is a collection file
let fileName = '';
let busy = false;
let game = 'mtg';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function setGame(value) {
  game = value;
  els.game.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', b.dataset.value === value ? 'true' : 'false'));
}

function refresh() {
  els.error.classList.add('hidden');
  els.bar.classList.add('hidden');
  const text = els.text.value;
  parsed = null;
  els.summary.textContent = '';
  els.gameGroup.classList.add('hidden');
  if (text.trim()) {
    const result = parseCollectionCsv(text);
    if (!result.ok) {
      els.error.textContent = result.error;
      els.error.classList.remove('hidden');
    } else {
      parsed = result;
      // the Magic apps say what game it is; for other files (and the TCGplayer app, which covers several) ask
      const needsGame = !result.hasGame && !MAGIC_FORMATS.has(result.format);
      els.gameGroup.classList.toggle('hidden', !needsGame);
      if (!needsGame && !result.hasGame) setGame('mtg');
      const copies = result.rows.reduce((n, r) => n + r.quantity, 0);
      const lines = [`${result.format ? `${result.format} file` : 'CSV file'}: ${plural(copies, 'card')} in ${plural(result.rows.length, 'row')}.`];
      if (result.skipped) lines.push(`${plural(result.skipped, 'row')} with no name or a count of 0 will be skipped.`);
      if (result.assumedCondition) lines.push(`${plural(result.assumedCondition, 'row')} with no recognisable condition will be Near Mint.`);
      els.summary.textContent = lines.join('\n');
    }
  }
  const needName = !target;
  els.go.disabled = busy || !parsed || (needName && !els.newName.value.trim());
}

async function readFile(file) {
  fileName = file.name.replace(/\.[^.]+$/, '');
  els.text.value = typeof file.text === 'function' ? await file.text() : await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(file);
  });
  if (!target && !els.newName.value.trim()) els.newName.value = fileName.slice(0, 40);
  refresh();
}

function open(collection) {
  target = collection;
  parsed = null;
  fileName = '';
  els.file.value = '';
  els.text.value = '';
  els.newName.value = '';
  els.title.textContent = collection ? `Import into “${collection.name}”` : 'Import a collection';
  els.newGroup.classList.toggle('hidden', !!collection);
  setGame('mtg');
  refresh();
  els.modal.classList.remove('hidden');
}

function close() {
  if (busy) return;
  els.modal.classList.add('hidden');
}

async function run() {
  if (!parsed || busy) return;
  busy = true;
  els.go.disabled = true;
  els.cancel.disabled = true;
  els.error.classList.add('hidden');
  els.bar.classList.remove('hidden');
  els.bar.removeAttribute('value');  // (an indeterminate bar until there is a count to show)
  const rows = parsed.rows;
  try {
    // Magic rows are matched to real cards at Scryfall; everything else goes in as written
    const magicIndexes = rows.map((r, i) => ((r.game || game) === 'mtg' ? i : -1)).filter((i) => i !== -1);
    const matches = new Map();
    if (magicIndexes.length) {
      els.summary.textContent = `Finding ${plural(magicIndexes.length, 'Magic row')} at Scryfall…`;
      const found = await matchMagicRows(magicIndexes.map((i) => rows[i]), {
        onProgress: (done, total) => {
          els.bar.max = total;
          els.bar.value = done;
          els.summary.textContent = `Finding Magic cards at Scryfall… ${done} of ${total}`;
        },
      });
      for (const [position, card] of found) matches.set(magicIndexes[position], card);
    }
    const cards = buildCards(rows, matches, game);
    els.summary.textContent = `Adding ${plural(cards.length, 'row')}…`;
    els.bar.removeAttribute('value');
    let collection = target;
    if (!collection) collection = await hooks.createCollection(els.newName.value.trim());
    const updated = await api.addCardsToCollection(collection.id, cards);
    const copies = cards.reduce((n, c) => n + c.quantity, 0);
    const unmatched = magicIndexes.length - magicIndexes.filter((i) => matches.has(i)).length;
    busy = false;
    els.cancel.disabled = false;
    els.modal.classList.add('hidden');
    hooks.imported(updated);
    showToast(
      `Imported ${plural(copies, 'card')}` +
        (unmatched ? ` — ${unmatched} Magic row${unmatched === 1 ? '' : 's'} couldn't be matched at Scryfall (kept as written)` : '')
    );
  } catch (err) {
    busy = false;
    els.cancel.disabled = false;
    els.bar.classList.add('hidden');
    els.error.textContent = err && err.message ? err.message : "Couldn't import that file";
    els.error.classList.remove('hidden');
    els.go.disabled = false;
  }
}

async function exportActive() {
  const collection = hooks.getActiveCollection();
  if (!collection) return;
  if (!collection.cards.length) {
    showToast('Nothing to export yet');
    return;
  }
  const result = await saveTextFile(exportFileName(collection.name), exportCollectionCsv(collection));
  showToast(result.ok ? `Exported ${plural(collection.cards.length, 'row')} to ${result.where}` : result.error);
}

/**
 * `hooks`: getActiveCollection() -> the open collection (or null); createCollection(name) -> a new collection;
 * imported(collection) -> called with the updated collection once its cards are in.
 */
export function initImportExport(h) {
  hooks = h;
  $('import-collection-btn').addEventListener('click', () => {
    const collection = hooks.getActiveCollection();
    if (collection) open(collection);
  });
  $('import-new-collection-btn').addEventListener('click', () => open(null));
  $('export-collection-btn').addEventListener('click', exportActive);
  els.cancel.addEventListener('click', close);
  els.modal.addEventListener('click', (e) => { if (e.target === els.modal) close(); });
  els.file.addEventListener('change', () => {
    const file = els.file.files && els.file.files[0];
    if (file) readFile(file).catch(() => {
      els.error.textContent = "Couldn't read that file";
      els.error.classList.remove('hidden');
    });
  });
  els.text.addEventListener('input', refresh);
  els.newName.addEventListener('input', refresh);
  els.game.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (button) setGame(button.dataset.value);
  });
  els.go.addEventListener('click', run);
}

export { GAME_NAMES };
