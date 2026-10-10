import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeFilterCount, emptyFilter, facetValues, filterCards, isCustomView, parsePrice } from '../js/cardFilter.js';

const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
const cards = [
  { id: 'a', name: 'Lightning Bolt', game: 'mtg', set: 'M11', rarity: 'Common', condition: 'Near Mint', quantity: 2 },
  { id: 'b', name: 'Sol Ring', game: 'mtg', set: 'CMR', rarity: 'Uncommon', condition: 'Lightly Played', quantity: 1 },
  { id: 'c', name: 'Charizard', game: 'pokemon', set: 'BS', rarity: 'Rare Holo', condition: 'Damaged', quantity: 1 },
  { id: 'd', name: 'Dark Magician', game: 'yugioh', set: 'LOB', rarity: 'Ultra Rare', quantity: 1 },  // no condition: Near Mint
  { id: 'e', name: 'Counterspell', game: 'mtg', set: 'cmr', rarity: 'uncommon', condition: 'Near Mint', quantity: 1 },
];
const prices = { a: 1.5, b: 2, c: 300, d: 12.25 };  // e has no known price
const priceOf = (c) => (c.id in prices ? prices[c.id] : null);
const ids = (list) => list.map((c) => c.id).join('');
const view = (over, query = '') => ids(filterCards(cards, query, { ...emptyFilter(), ...over }, priceOf));

test('prices typed by people', () => {
  assert.equal(parsePrice('12.5'), 12.5);
  assert.equal(parsePrice(' $3 '), 3);
  assert.equal(parsePrice('12,50'), 12.5);
  assert.equal(parsePrice('0'), 0);
  for (const bad of ['', '  ', 'abc', '-4', null, undefined]) assert.equal(parsePrice(bad), null);
});

test('no filters keeps every card in stored order', () => {
  assert.equal(view({}), 'abcde');
  assert.equal(isCustomView(emptyFilter()), false);
  assert.equal(activeFilterCount(emptyFilter()), 0);
});

test('filter by game, set, rarity and condition (case does not matter)', () => {
  assert.equal(view({ game: 'mtg' }), 'abe');
  assert.equal(view({ game: 'pokemon' }), 'c');
  assert.equal(view({ set: 'CMR' }), 'be', 'CMR and cmr are the same set');
  assert.equal(view({ rarity: 'Uncommon' }), 'be');
  assert.equal(view({ condition: 'Near Mint' }), 'ade', 'a card with no condition is Near Mint');
  assert.equal(view({ condition: 'Damaged' }), 'c');
  assert.equal(view({ game: 'mtg', set: 'CMR', condition: 'Near Mint' }), 'e', 'filters combine');
  assert.equal(view({ game: 'yugioh', set: 'M11' }), '');
});

test('filter by price: min, max or both; cards without a price are left out', () => {
  assert.equal(view({ minPrice: '2' }), 'bcd', 'min is inclusive');
  assert.equal(view({ maxPrice: '2' }), 'ab', 'max is inclusive');
  assert.equal(view({ minPrice: '2', maxPrice: '20' }), 'bd');
  assert.equal(view({ minPrice: '0' }), 'abcd', 'a price limit hides cards with no known price');
  assert.equal(view({ minPrice: 'x', maxPrice: '' }), 'abcde', 'unreadable limits are ignored');
});

test('the name search combines with the filters', () => {
  assert.equal(view({}, 'ol'), 'ab', 'Bolt and Sol');
  assert.equal(view({ game: 'mtg' }, 'counter'), 'e');
  assert.equal(view({ game: 'pokemon' }, 'bolt'), '');
});

test('sorting by name and by price, unknown prices always last, ties keep stored order', () => {
  assert.equal(view({ sort: 'name-asc' }), 'cedab');
  assert.equal(view({ sort: 'name-desc' }), 'badec');
  assert.equal(view({ sort: 'price-asc' }), 'abdce');
  assert.equal(view({ sort: 'price-desc' }), 'cdbae');
  const tied = [{ id: 'x', name: 'Same', game: 'mtg' }, { id: 'y', name: 'same', game: 'mtg' }, { id: 'z', name: 'Same', game: 'mtg' }];
  assert.equal(ids(filterCards(tied, '', { ...emptyFilter(), sort: 'name-asc' })), 'xyz');
  assert.equal(ids(filterCards(tied, '', { ...emptyFilter(), sort: 'price-asc' })), 'xyz', 'no prices: stored order');
  assert.equal(view({ sort: 'bogus' }), 'abcde', 'an unknown sort leaves the order alone');
  const sorted = filterCards(cards, '', { ...emptyFilter(), sort: 'name-asc' }, priceOf);
  assert.equal(ids(cards), 'abcde', 'the list passed in is not reordered');
  assert.equal(sorted.length, 5);
});

test('filters and sorting together', () => {
  assert.equal(view({ game: 'mtg', sort: 'price-desc' }), 'bae');
  assert.equal(view({ minPrice: '1', maxPrice: '15', sort: 'price-desc' }), 'dba');
});

test('what can be picked comes from the cards in the list', () => {
  const f = facetValues(cards, 'Near Mint', CONDITIONS);
  assert.deepEqual(f.games, ['mtg', 'pokemon', 'yugioh']);
  assert.deepEqual(f.sets, ['BS', 'CMR', 'LOB', 'M11'], 'CMR and cmr once');
  assert.deepEqual(f.rarities, ['Common', 'Rare Holo', 'Ultra Rare', 'Uncommon']);
  assert.deepEqual(f.conditions, ['Near Mint', 'Lightly Played', 'Damaged'], 'in condition order, not alphabetical');
  assert.deepEqual(facetValues([], 'Near Mint', CONDITIONS), { games: [], sets: [], rarities: [], conditions: [] });
  assert.deepEqual(facetValues([{ name: 'x', game: 'mtg' }]).sets, [], 'cards with no set add none');
});

test('counting active filters and spotting a custom view', () => {
  assert.equal(activeFilterCount({ ...emptyFilter(), game: 'mtg', minPrice: '1', maxPrice: 'x' }), 2);
  assert.equal(isCustomView({ ...emptyFilter(), sort: 'name-asc' }), true, 'sorting alone counts');
  assert.equal(isCustomView({ ...emptyFilter(), set: 'M11' }), true);
});

test('deck cards by what the person has: missing or complete', () => {
  const deck = [
    { id: 'a', name: 'Bolt', game: 'mtg', set: 'M11', quantity: 4, owned: 4 },
    { id: 'b', name: 'Ring', game: 'mtg', set: 'CMR', quantity: 1 },
    { id: 'c', name: 'Shock', game: 'mtg', set: 'M11', quantity: 3, owned: 1 },
  ];
  const ids = (ownership) => filterCards(deck, '', { ...emptyFilter(), ownership }).map((c) => c.id).join('');
  assert.equal(ids(''), 'abc');
  assert.equal(ids('missing'), 'bc');
  assert.equal(ids('complete'), 'a');
  assert.equal(ids('nonsense'), 'abc', 'an unknown value filters nothing');
  assert.equal(activeFilterCount({ ...emptyFilter(), ownership: 'missing' }), 1);
  assert.equal(activeFilterCount({ ...emptyFilter(), ownership: 'nonsense' }), 0);
});
