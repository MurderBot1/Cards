import assert from 'node:assert/strict';
import { test } from 'node:test';
import { curveHtml } from '../js/curveView.js';
import { manaCurve } from '../js/manaCurve.js';

const INFO = { bolt: { mv: 1, colors: 'R' }, counter: { mv: 2, colors: 'U' }, charm: { mv: 3, colors: 'WU' }, island: { mv: 0, colors: '', land: true } };
const card = (id, quantity, game = 'mtg') => ({ id, name: id, game, quantity });
const curve = manaCurve([card('bolt', 4), card('counter', 2), card('charm', 1), card('island', 5), card('mystery', 2), card('pikachu', 3, 'pokemon')], (c) => INFO[c.id] || null);

test('the curve is drawn as columns with a legend, a table and notes', () => {
  const html = curveHtml(curve);
  assert.equal((html.match(/class="curve-col"/g) || []).length, 8, 'a column for each of 0 to 7+');
  assert.match(html, /4 cards at 1 mana \(4 red\)/);
  assert.match(html, /2 cards at 2 mana \(2 blue\)/);
  assert.match(html, /1 card at 3 mana \(1 multicolor\)/);
  assert.match(html, /No cards at 5 mana/);
  assert.match(html, /7 spells · average mana value 1\.6 · 5 lands/);
  assert.match(html, /<li><span class="curve-swatch curve-seg--R"[^>]*><\/span>Red<\/li>/);
  assert.equal(html.includes('curve-swatch curve-seg--G'), false, 'colors that are not in the deck are not in the legend');
  assert.match(html, /<details class="curve-table"><summary>Table view<\/summary><table>/);
  assert.match(html, /2 cards not looked up yet; they are not in the curve/);
  assert.match(html, /3 cards from other games are not in the curve/);
  assert.match(curveHtml(curve, { loading: true }), /2 cards still being looked up/);
  // the tallest column is the full height; the others are in proportion
  assert.match(html, /<div class="curve-bar" style="height:100px">/);
  assert.match(html, /<div class="curve-bar" style="height:50px">/);
});

test('with nothing to draw it says why', () => {
  const nothing = manaCurve([card('mystery', 3)], () => null);
  assert.match(curveHtml(nothing, { loading: true }), /Looking up mana costs/);
  assert.match(curveHtml(nothing), /could not be looked up yet/);
  assert.match(curveHtml(manaCurve([], () => null)), /No spells to show/);
  assert.match(curveHtml(manaCurve([card('island', 4)], (c) => INFO[c.id])), /4 lands \(lands are not on the curve\)/);
});
