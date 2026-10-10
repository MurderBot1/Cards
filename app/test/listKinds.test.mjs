import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  countLabel, kindOf, kindWords, KINDS, limitsOf, listsOfKind, tooManyCardsMessage, tooManyCopiesMessage, tooManyListsMessage,
} from '../js/listKinds.js';

test('a list with no kind, or one we do not know, is a collection', () => {
  assert.equal(kindOf({ id: '1', name: 'Old' }), 'collection');
  assert.equal(kindOf({ kind: 'binder' }), 'collection');
  assert.equal(kindOf({ kind: 'deck' }), 'deck');
  assert.equal(kindOf(null), 'collection');
  assert.deepEqual(KINDS, ['collection', 'deck', 'tradelist', 'wishlist']);
});

test('each kind shows only its own lists, in stored order', () => {
  const lists = [{ id: 'a' }, { id: 'b', kind: 'deck' }, { id: 'c', kind: 'wishlist' }, { id: 'd', kind: 'deck' }, { id: 'e', kind: 'collection' }, { id: 'f', kind: 'tradelist' }];
  const ids = (k) => listsOfKind(lists, k).map((l) => l.id).join('');
  assert.equal(ids('collection'), 'ae');
  assert.equal(ids('deck'), 'bd');
  assert.equal(ids('tradelist'), 'f');
  assert.equal(ids('wishlist'), 'c');
});

test('every kind has all of its words', () => {
  for (const kind of KINDS) {
    const w = kindWords(kind);
    for (const key of ['tab', 'singular', 'plural', 'placeholder', 'hint', 'emptyTitle', 'emptyText', 'listEmpty', 'listEmptyText']) {
      assert.ok(typeof w[key] === 'string' && w[key].length > 0, `${kind}.${key}`);
    }
  }
  assert.equal(kindWords('nonsense').singular, 'collection');
});

test('counting lists', () => {
  assert.equal(countLabel('deck', 1), '1 deck');
  assert.equal(countLabel('deck', 0), '0 decks');
  assert.equal(countLabel('collection', 2), '2 collections');
  assert.equal(countLabel('wishlist', 1), '1 wishlist');
});

test('limits for each kind, and the messages shown when one is hit', () => {
  assert.deepEqual(limitsOf('collection'), { lists: 25, cards: 10000, perCard: 1000 });
  assert.deepEqual(limitsOf('deck'), { lists: 100, cards: 150, perCard: 100 });
  assert.deepEqual(limitsOf('tradelist'), { lists: null, cards: 10000, perCard: null });
  assert.deepEqual(limitsOf('wishlist'), { lists: null, cards: 10000, perCard: null });
  assert.deepEqual(limitsOf('nonsense'), limitsOf('collection'));
  assert.equal(tooManyListsMessage('collection'), 'You can have at most 25 collections');
  assert.equal(tooManyListsMessage('deck'), 'You can have at most 100 decks');
  assert.equal(tooManyCardsMessage('deck'), 'A deck can hold at most 150 different cards');
  assert.equal(tooManyCardsMessage('collection'), 'A collection can hold at most 10,000 different cards');
  assert.equal(tooManyCardsMessage('wishlist'), 'A wishlist can hold at most 10,000 different cards');
  assert.equal(tooManyCopiesMessage('collection'), 'A collection can hold at most 1,000 copies of one card');
  assert.equal(tooManyCopiesMessage('deck'), 'A deck can hold at most 100 copies of one card');
});
