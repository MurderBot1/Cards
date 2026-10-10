/**
 * listKinds.js
 * The four kinds of list the Collection tab holds: collections, decks, a tradelist and a wishlist (one of each of the last two). They are stored the
 * same way (a name and cards); `kind` says which one a list is, and a list saved before kinds existed is a collection.
 */

export const KINDS = ['collection', 'deck', 'tradelist', 'wishlist'];
export const DEFAULT_KIND = 'collection';

const WORDS = {
  collection: {
    tab: 'Collections', singular: 'collection', plural: 'collections',
    placeholder: 'e.g. Modern Staples',
    hint: 'You can add Magic, Pokémon, and Yu-Gi-Oh! cards to any collection.',
    emptyTitle: 'No collections yet', emptyText: 'Start a binder for your MTG, Pokémon or Yu-Gi-Oh! cards.',
    listEmpty: 'This binder is empty', listEmptyText: 'Tap the + button to search the database or scan a card.',
  },
  deck: {
    tab: 'Decks', singular: 'deck', plural: 'decks',
    placeholder: 'e.g. Mono-Red Burn',
    hint: 'A deck lists the cards you want to play, from any game.',
    emptyTitle: 'No decks yet', emptyText: 'Build a deck from cards in the database.',
    listEmpty: 'This deck is empty', listEmptyText: 'Tap the + button to add cards to the deck.',
  },
  tradelist: {
    tab: 'Tradelist', singular: 'tradelist', plural: 'tradelists',
    placeholder: 'e.g. Spare Commander Cards',
    hint: 'Your tradelist is the cards you are willing to trade away. There is one tradelist.',
    emptyTitle: 'No tradelist yet', emptyText: 'List the cards you would trade away.',
    listEmpty: 'This tradelist is empty', listEmptyText: 'Tap the + button to add cards you would trade.',
  },
  wishlist: {
    tab: 'Wishlist', singular: 'wishlist', plural: 'wishlists',
    placeholder: 'e.g. Cards I Want',
    hint: 'Your wishlist is the cards you are looking for. There is one wishlist.',
    emptyTitle: 'No wishlist yet', emptyText: 'Keep track of the cards you want next.',
    listEmpty: 'This wishlist is empty', listEmptyText: 'Tap the + button to add cards you want.',
  },
};

/** What a list is: its `kind`, or a collection when it has none (or one this version does not know). */
export function kindOf(list) {
  return list && KINDS.includes(list.kind) ? list.kind : DEFAULT_KIND;
}

/** The lists of one kind, in their stored order. */
export function listsOfKind(lists, kind) {
  return lists.filter((l) => kindOf(l) === kind);
}

/** Words for a kind (labels, placeholders, empty-state text). An unknown kind reads as a collection. */
export function kindWords(kind) {
  return WORDS[KINDS.includes(kind) ? kind : DEFAULT_KIND];
}

/** "1 deck", "3 decks" */
export function countLabel(kind, n) {
  const w = kindWords(kind);
  return `${n} ${n === 1 ? w.singular : w.plural}`;
}

/**
 * What each kind of list may hold. `null` is no limit. A "different card" is a row of the list (the same card in
 * another condition, set, finish or language is its own row). The C++ store (native/cardstore) and the Worker
 * (cloudflare/src/sync.js) hold the same numbers.
 */
export const LIMITS = {
  collection: { lists: 25, cards: 10000, perCard: 1000 },
  deck: { lists: 100, cards: 150, perCard: 100 },
  tradelist: { lists: 1, cards: 10000, perCard: null },  // one tradelist and one wishlist (all the cards you would
  wishlist: { lists: 1, cards: 10000, perCard: null },   // trade, all the cards you want), not several of each
};

export function limitsOf(kind) {
  return LIMITS[KINDS.includes(kind) ? kind : DEFAULT_KIND];
}

/** True when no more lists of this kind can be made. Lists made before a limit existed may exceed it; none is removed. */
export function atListLimit(kind, count) {
  const max = limitsOf(kind).lists;
  return max !== null && count >= max;
}

/** "3 of 25 collections", "1 deck"; a kind with a single list just says how many there are. */
export function listCountText(kind, count) {
  const max = limitsOf(kind).lists;
  return max === null || max === 1 || count > max ? countLabel(kind, count) : `${count} of ${max} ${kindWords(kind).plural}`;
}

const withCommas = (n) => n.toLocaleString('en-US');

// The messages shown when a limit stops something (the same text the C++ store sends)
export function tooManyListsMessage(kind) {
  if (limitsOf(kind).lists === 1) return `You can only have one ${kindWords(kind).singular}`;
  return `You can have at most ${limitsOf(kind).lists} ${kindWords(kind).plural}`;
}
export function tooManyCardsMessage(kind) {
  return `A ${kindWords(kind).singular} can hold at most ${withCommas(limitsOf(kind).cards)} different cards`;
}
export function tooManyCopiesMessage(kind) {
  return `A ${kindWords(kind).singular} can hold at most ${withCommas(limitsOf(kind).perCard)} copies of one card`;
}
