import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FORMATS } from '../js/deckLegality.js';
import {
  DECK_FORMATS, DECK_GAMES, deckFormatOf, deckFormatProblem, deckFormatText, formatLabel, formatsOf, gameOfCards, isDeckFormat,
} from '../js/deckFormats.js';

test('every game has its own formats; Magic has the ones that are checked', () => {
  assert.deepEqual(DECK_GAMES, ['mtg', 'pokemon', 'yugioh']);
  assert.deepEqual(formatsOf('mtg').map((f) => f.key), FORMATS.map((f) => f.key));
  assert.deepEqual(formatsOf('pokemon').map((f) => f.label), ['Standard', 'Expanded', 'Unlimited']);
  assert.deepEqual(formatsOf('yugioh').map((f) => f.label), ['Advanced', 'Traditional', 'Speed Duel']);
  assert.deepEqual(formatsOf('digimon'), []);
  assert.deepEqual(Object.keys(DECK_FORMATS), DECK_GAMES);
});

test('a format belongs to one game', () => {
  assert.equal(isDeckFormat('mtg', 'modern'), true);
  assert.equal(isDeckFormat('pokemon', 'modern'), false);
  assert.equal(isDeckFormat('pokemon', 'standard'), true, 'Standard exists in two games, each its own');
  assert.equal(isDeckFormat('yugioh', 'speed'), true);
  assert.equal(isDeckFormat('mtg', undefined), false);
  assert.equal(formatLabel('yugioh', 'speed'), 'Speed Duel');
  assert.equal(formatLabel('mtg', 'nope'), '');
});

test('what a deck has, and how it reads', () => {
  assert.deepEqual(deckFormatOf({ game: 'mtg', format: 'pauper' }), { game: 'mtg', format: 'pauper' });
  assert.equal(deckFormatOf({ game: 'mtg', format: 'expanded' }), null);
  assert.equal(deckFormatOf({}), null);
  assert.equal(deckFormatOf(null), null);
  assert.equal(deckFormatText({ game: 'mtg', format: 'modern' }), 'Magic: The Gathering · Modern');
  assert.equal(deckFormatText({ game: 'pokemon', format: 'expanded' }), 'Pokémon · Expanded');
  assert.equal(deckFormatText({}), '');
});

test('a starting guess for an older deck: the game when all its cards are from one', () => {
  assert.equal(gameOfCards([{ game: 'pokemon' }, { game: 'pokemon' }]), 'pokemon');
  assert.equal(gameOfCards([{ game: 'mtg' }, { game: 'pokemon' }]), '');
  assert.equal(gameOfCards([]), '');
  assert.equal(gameOfCards([{ game: 'digimon' }]), '');
  assert.equal(gameOfCards(undefined), '');
});

test('messages for a pick that is not allowed (the same words as the native store)', () => {
  assert.equal(deckFormatProblem('mtg', 'modern'), '');
  assert.equal(deckFormatProblem(undefined, undefined), '');
  assert.equal(deckFormatProblem(null, null), '');
  assert.equal(deckFormatProblem(undefined, undefined, { required: true }), 'game and format are required');
  assert.equal(deckFormatProblem('digimon', 'modern'), "game must be one of ('mtg', 'pokemon', 'yugioh')");
  assert.equal(deckFormatProblem('mtg'), 'format must be one of the formats of that game');
  assert.equal(deckFormatProblem(undefined, 'modern'), "game must be one of ('mtg', 'pokemon', 'yugioh')");
  assert.equal(deckFormatProblem('pokemon', 'modern'), 'format must be one of the formats of that game');
});
