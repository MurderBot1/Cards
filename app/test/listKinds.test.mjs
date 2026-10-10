import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countLabel, kindOf, kindWords, KINDS, listsOfKind } from '../js/listKinds.js';

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
