/**
 * listKinds.js
 * The four kinds of list the Collection tab holds: collections, decks, tradelists and wishlists. They are stored the
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
    hint: 'A tradelist is the cards you are willing to trade away.',
    emptyTitle: 'No tradelists yet', emptyText: 'List the cards you would trade away.',
    listEmpty: 'This tradelist is empty', listEmptyText: 'Tap the + button to add cards you would trade.',
  },
  wishlist: {
    tab: 'Wishlist', singular: 'wishlist', plural: 'wishlists',
    placeholder: 'e.g. Cards I Want',
    hint: 'A wishlist is the cards you are looking for.',
    emptyTitle: 'No wishlists yet', emptyText: 'Keep track of the cards you want next.',
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
