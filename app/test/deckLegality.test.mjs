import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardStatus, checkFormat, FORMATS, formatByKey, statusWord } from '../js/deckLegality.js';

const card = (id, name, quantity, game = 'mtg') => ({ id, name, game, quantity });
const ALL_LEGAL = { standard: 'l', pioneer: 'l', modern: 'l', legacy: 'l', vintage: 'l', pauper: 'l', commander: 'l', brawl: 'l' };
const INFO = {
  bolt: { legal: { ...ALL_LEGAL, standard: 'n', pauper: 'l' } },
  lotus: { legal: { ...ALL_LEGAL, standard: 'n', pioneer: 'n', modern: 'b', legacy: 'b', vintage: 'r', pauper: 'n', commander: 'b', brawl: 'n' } },
  ring: { legal: { ...ALL_LEGAL, modern: 'b' } },
  island: { legal: ALL_LEGAL },
  hare: { legal: ALL_LEGAL },
  old: { legal: { modern: 'l' } },  // an old answer that lacks the other formats
};
const infoOf = (c) => INFO[c.id] || null;
const MODERN = formatByKey('modern');

test('the formats offered, by key', () => {
  assert.deepEqual(FORMATS.map((f) => f.key), ['standard', 'pioneer', 'modern', 'legacy', 'vintage', 'pauper', 'commander', 'brawl']);
  assert.equal(formatByKey('commander').exact, 100);
  assert.equal(formatByKey('nope'), null);
});

test('how one card stands in a format', () => {
  assert.equal(cardStatus(INFO.lotus, 'modern'), 'b');
  assert.equal(cardStatus(INFO.lotus, 'vintage'), 'r');
  assert.equal(cardStatus(INFO.old, 'standard'), null, 'that format is not in its data');
  assert.equal(cardStatus(null, 'modern'), null, 'not looked up');
  assert.deepEqual(['n', 'b', 'r', 'l', null].map(statusWord), ['Not legal', 'Banned', 'Restricted', '', '']);
});

test('a legal 60-card deck, with basics and a full playset', () => {
  const deck = [card('ring', 'Sol Ring', 0), card('bolt', 'Lightning Bolt', 4), card('island', 'Island', 56)];
  const r = checkFormat(MODERN, deck, infoOf);
  assert.equal(r.verdict, 'legal');
  assert.deepEqual(r.problems, []);
  assert.match(r.notes[0], /Sideboards/);
});

test('banned and not-legal cards, too few cards, too many copies', () => {
  const deck = [card('lotus', 'Black Lotus', 1), card('ring', 'Sol Ring', 1), card('bolt', 'Lightning Bolt', 5), card('island', 'Island', 30)];
  const r = checkFormat(MODERN, deck, infoOf);
  assert.equal(r.verdict, 'illegal');
  const kinds = r.problems.map((p) => p.kind);
  assert.deepEqual(kinds, ['banned', 'size', 'copies']);
  assert.equal(r.problems[0].text, 'Banned: Black Lotus, Sol Ring');
  assert.equal(r.problems[1].text, 'Needs at least 60 cards (has 37)');
  assert.equal(r.problems[2].text, 'Too many copies: Lightning Bolt ×5 (max 4)');
  const standard = checkFormat(formatByKey('standard'), [card('bolt', 'Lightning Bolt', 4), card('island', 'Island', 56)], infoOf);
  assert.equal(standard.problems[0].kind, 'not-legal');
  assert.equal(standard.problems[0].text, 'Not legal in Standard: Lightning Bolt');
});

test('copies of one card add up across printings; basics and "any number" cards are exempt', () => {
  const deck = [card('bolt', 'Lightning Bolt', 3), { ...card('bolt', 'Lightning Bolt', 2), id: 'bolt' }, card('island', 'Island', 20), card('island', 'Snow-Covered Island', 20),
    card('hare', 'Relentless Rats', 20), card('hare', 'Seven Dwarves', 7)];
  const r = checkFormat(MODERN, deck, (c) => (c.id === 'bolt' ? INFO.bolt : INFO.island));
  assert.deepEqual(r.problems.map((p) => p.text), ['Too many copies: Lightning Bolt ×5 (max 4)']);
});

test('restricted: one copy in Vintage, and it is not a banned card', () => {
  const two = checkFormat(formatByKey('vintage'), [card('lotus', 'Black Lotus', 2), card('island', 'Island', 58)], infoOf);
  assert.deepEqual(two.problems.map((p) => p.text), ['Too many copies: Black Lotus ×2 (max 1)']);
  const one = checkFormat(formatByKey('vintage'), [card('lotus', 'Black Lotus', 1), card('island', 'Island', 59)], infoOf);
  assert.equal(one.verdict, 'legal');
});

test('Commander is exactly 100 cards and singleton; Brawl is exactly 60', () => {
  const ok = checkFormat(formatByKey('commander'), [card('ring', 'Sol Ring', 1), card('island', 'Island', 99)], infoOf);
  assert.equal(ok.verdict, 'legal');
  assert.match(ok.notes[0], /commander and its color identity/);
  const bad = checkFormat(formatByKey('commander'), [card('ring', 'Sol Ring', 2), card('island', 'Island', 99)], infoOf);
  assert.deepEqual(bad.problems.map((p) => p.kind), ['size', 'copies']);
  assert.equal(bad.problems[0].text, 'Needs exactly 100 cards (has 101)');
  const brawl = checkFormat(formatByKey('brawl'), [card('ring', 'Sol Ring', 1), card('island', 'Island', 50)], infoOf);
  assert.equal(brawl.problems[0].text, 'Needs exactly 60 cards (has 51)');
});

test('cards not looked up, other games and empty decks', () => {
  const deck = [card('ring', 'Sol Ring', 1), card('mystery', 'Not looked up', 3), card('island', 'Island', 56), card('p', 'Pikachu', 2, 'pokemon')];
  const r = checkFormat(MODERN, deck, infoOf);
  assert.equal(r.verdict, 'illegal', 'Sol Ring is banned in Modern whether or not the rest is known');
  const clean = checkFormat(formatByKey('legacy'), deck, infoOf);
  assert.equal(clean.verdict, 'unchecked', 'nothing wrong so far, but a card is not known');
  assert.equal(clean.unchecked, 3, 'counted in copies');
  assert.match(clean.notes.join(' '), /3 cards not looked up yet/);
  assert.match(clean.notes.join(' '), /2 cards from other games aren't checked/);
  assert.equal(checkFormat(MODERN, [], infoOf).verdict === 'illegal', true, 'no cards: too small');
  assert.equal(checkFormat(MODERN, [card('p', 'Pikachu', 4, 'pokemon')], infoOf).verdict, 'illegal');
  // a card whose old answer lacks the format counts as not checked
  assert.equal(checkFormat(formatByKey('pioneer'), [card('old', 'Old Card', 1), card('island', 'Island', 59)], infoOf).unchecked, 1);
  // long lists are cut
  const many = Array.from({ length: 9 }, (_, i) => card('lotus', `Banned Card ${i}`, 1));
  assert.match(checkFormat(MODERN, many, infoOf).problems[0].text, /Banned: Banned Card 0, .*Banned Card 5 and 3 more$/);
});
