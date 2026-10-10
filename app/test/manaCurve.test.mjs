import assert from 'node:assert/strict';
import { test } from 'node:test';
import { colorKey, manaCurve } from '../js/manaCurve.js';

const card = (id, name, quantity, game = 'mtg') => ({ id, name, game, quantity });
const INFO = {
  bolt: { mv: 1, colors: 'R', land: false },
  ring: { mv: 1, colors: '', land: false },
  counter: { mv: 2, colors: 'U', land: false },
  charm: { mv: 3, colors: 'WU', land: false },
  titan: { mv: 6, colors: 'G', land: false },
  emrakul: { mv: 15, colors: '', land: false },
  free: { mv: 0, colors: 'U', land: false },
  island: { mv: 0, colors: '', land: true },
  split: { mv: 2.5, colors: 'B', land: false },
};
const infoOf = (c) => INFO[c.id] || null;

test('which color a card is drawn in', () => {
  assert.equal(colorKey({ colors: 'W' }), 'W');
  assert.equal(colorKey({ colors: 'WU' }), 'M');
  assert.equal(colorKey({ colors: 'WUBRG' }), 'M');
  assert.equal(colorKey({ colors: '' }), 'C');
  assert.equal(colorKey(null), 'C');
  assert.equal(colorKey({}), 'C');
});

test('copies of spells are counted by mana value and color; lands and the unknown are counted apart', () => {
  const curve = manaCurve([
    card('bolt', 'Bolt', 4), card('ring', 'Sol Ring', 1), card('counter', 'Counterspell', 3), card('charm', 'Charm', 2),
    card('titan', 'Titan', 1), card('emrakul', 'Emrakul', 1), card('free', 'Force', 2), card('island', 'Island', 20),
    card('mystery', 'Not looked up', 3), card('p', 'Pikachu', 4, 'pokemon'), card('gone', 'Zero', 0),
  ], infoOf);
  const cols = Object.fromEntries(curve.columns.map((c) => [c.label, c]));
  assert.deepEqual(curve.columns.map((c) => c.label), ['0', '1', '2', '3', '4', '5', '6', '7+']);
  assert.equal(cols['0'].total, 2);
  assert.deepEqual([cols['1'].total, cols['1'].byColor.R, cols['1'].byColor.C], [5, 4, 1]);
  assert.deepEqual([cols['2'].total, cols['2'].byColor.U], [3, 3]);
  assert.deepEqual([cols['3'].total, cols['3'].byColor.M], [2, 2]);
  assert.equal(cols['6'].total, 1);
  assert.equal(cols['7+'].total, 1, 'seven or more share a column');
  assert.deepEqual([curve.spells, curve.lands, curve.unknown, curve.other], [14, 20, 3, 4]);
  assert.equal(curve.tallest, 5);
  // (0*2 + 1*5 + 2*3 + 3*2 + 6 + 15) / 14
  assert.equal(curve.average, (0 + 5 + 6 + 6 + 6 + 15) / 14);
});

test('a half mana value falls in the column below; an empty deck has no average', () => {
  const curve = manaCurve([card('split', 'Fire // Ice', 2)], infoOf);
  assert.equal(curve.columns[2].total, 2);
  assert.equal(curve.average, 2.5);
  const empty = manaCurve([], infoOf);
  assert.deepEqual([empty.spells, empty.average, empty.tallest], [0, null, 0]);
  assert.equal(manaCurve([card('island', 'Island', 3)], infoOf).average, null, 'lands only: no spells to average');
  assert.equal(manaCurve(null, infoOf).spells, 0);
  assert.equal(manaCurve([{ id: 'bolt', game: 'mtg', quantity: 'x' }], infoOf).spells, 0, 'a bad quantity counts nothing');
});
