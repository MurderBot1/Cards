/**
 * deckLegality.js
 * Is a deck legal in a Magic format? Each card's legality comes from Scryfall (cardInfo.js: `legal` by format, as
 * "l" legal, "n" not legal, "b" banned, "r" restricted); the deck's size and copy limits are the format's rules. Pure:
 * what is known of each card is passed in.
 *
 * Two things are not tracked, and the results say so: sideboards (the whole list is checked as a main deck) and a
 * Commander deck's commander and color identity.
 */

export const FORMATS = [
  { key: 'standard', label: 'Standard', min: 60, copies: 4 },
  { key: 'pioneer', label: 'Pioneer', min: 60, copies: 4 },
  { key: 'modern', label: 'Modern', min: 60, copies: 4 },
  { key: 'legacy', label: 'Legacy', min: 60, copies: 4 },
  { key: 'vintage', label: 'Vintage', min: 60, copies: 4 },
  { key: 'pauper', label: 'Pauper', min: 60, copies: 4 },
  { key: 'commander', label: 'Commander', exact: 100, copies: 1 },
  { key: 'brawl', label: 'Brawl', exact: 60, copies: 1 },
];

const BASIC_LAND = /^(snow-covered )?(plains|island|swamp|mountain|forest)$|^wastes$/i;
// cards whose text lets a deck hold any number of them (7 for Seven Dwarves)
const ANY_NUMBER = new Set([
  'persistent petitioners', 'rat colony', 'relentless rats', 'shadowborn apostle', 'dragon\'s approach', 'slime against humanity',
  'hare apparent', 'templar knight',
]);
const SEVEN = new Set(['seven dwarves']);

const LEGALITY_WORDS = { n: 'Not legal', b: 'Banned', r: 'Restricted' };

export const formatByKey = (key) => FORMATS.find((f) => f.key === key) || null;

const copiesOf = (card) => Math.max(0, Math.floor(Number(card && card.quantity) || 0));
const nameKey = (card) => String(card.name || '').trim().toLowerCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** How a card stands in a format: "l", "n", "b" or "r", or null when not known (not looked up, or that format isn't in its data). */
export function cardStatus(info, formatKey) {
  return info && info.legal && typeof info.legal[formatKey] === 'string' ? info.legal[formatKey] : null;
}

/** The word to show for a card that isn't plainly legal ("Banned", "Not legal", "Restricted"), else ''. */
export function statusWord(status) {
  return LEGALITY_WORDS[status] || '';
}

// the most copies of a card a deck may hold in the format, or Infinity
function copyLimit(format, card, info) {
  const name = nameKey(card);
  if (BASIC_LAND.test(name) || ANY_NUMBER.has(name) || (info && info.basic)) return Infinity;
  if (SEVEN.has(name)) return Math.max(7, format.copies);
  if (cardStatus(info, format.key) === 'r') return 1;
  return format.copies;
}

const listNames = (names, max = 6) => (names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`);

/**
 * Checks a deck against one format: { format, verdict, problems: [{ kind, text }], notes, unchecked }.
 *   verdict: "legal", "illegal" (problems say why) or "unchecked" (nothing wrong so far, but some cards aren't known yet).
 *   kinds: "banned", "not-legal", "size", "copies".
 */
export function checkFormat(format, cards, infoOf) {
  const magic = (cards || []).filter((c) => c.game === 'mtg' && copiesOf(c) > 0);
  const other = (cards || []).filter((c) => c.game !== 'mtg').reduce((n, c) => n + copiesOf(c), 0);
  const problems = [];
  let unchecked = 0;

  const banned = new Set();
  const notLegal = new Set();
  const byName = new Map();  // name -> { card, copies, info }
  let total = 0;
  for (const card of magic) {
    const info = infoOf(card);
    const status = cardStatus(info, format.key);
    if (status === null) unchecked += copiesOf(card);
    else if (status === 'b') banned.add(card.name);
    else if (status === 'n') notLegal.add(card.name);
    const key = nameKey(card);
    const entry = byName.get(key) || { card, copies: 0, info };
    entry.copies += copiesOf(card);
    if (info && !entry.info) entry.info = info;
    byName.set(key, entry);
    total += copiesOf(card);
  }
  if (banned.size) problems.push({ kind: 'banned', text: `Banned: ${listNames([...banned])}` });
  if (notLegal.size) problems.push({ kind: 'not-legal', text: `Not legal in ${format.label}: ${listNames([...notLegal])}` });

  if (format.exact !== undefined && total !== format.exact) {
    problems.push({ kind: 'size', text: `Needs exactly ${format.exact} cards (has ${total})` });
  } else if (format.min !== undefined && total < format.min) {
    problems.push({ kind: 'size', text: `Needs at least ${format.min} cards (has ${total})` });
  }

  const over = [];
  for (const { card, copies, info } of byName.values()) {
    const limit = copyLimit(format, card, info);
    if (copies > limit) over.push(`${card.name} ×${copies} (max ${limit})`);
  }
  if (over.length) problems.push({ kind: 'copies', text: `Too many copies: ${listNames(over, 5)}` });

  const notes = [];
  if (format.key === 'commander') notes.push("The commander and its color identity aren't checked.");
  else if (format.key === 'brawl') notes.push("The commander and its color identity aren't checked.");
  else notes.push("Sideboards aren't tracked, so the whole list is checked as a main deck.");
  if (other > 0) notes.push(`${plural(other, 'card')} from other games ${other === 1 ? "isn't" : "aren't"} checked.`);
  if (unchecked > 0) notes.push(`${plural(unchecked, 'card')} not looked up yet, so ${unchecked === 1 ? 'it is' : 'they are'} not checked.`);

  const verdict = problems.length ? 'illegal' : unchecked > 0 ? 'unchecked' : magic.length === 0 ? 'unchecked' : 'legal';
  return { format, verdict, problems, notes, unchecked };
}
