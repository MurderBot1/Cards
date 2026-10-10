/**
 * deckFormats.js
 * The game a deck is for and the format it is built for, chosen when the deck is made. A format belongs to one game.
 * Only Magic decks are checked against their format (deckLegality.js, from Scryfall); for the other games the format is
 * a label. The same lists are held by the native store (native/cardstore/src/store.cpp, `valid_deck_format`) and the
 * Worker (cloudflare/src/sync.js, `DECK_FORMATS`).
 */
import { FORMATS as MAGIC_RULES } from './deckLegality.js';

export const DECK_GAMES = ['mtg', 'pokemon', 'yugioh'];
export const GAME_NAMES = { mtg: 'Magic: The Gathering', pokemon: 'Pokémon', yugioh: 'Yu-Gi-Oh!' };

export const DECK_FORMATS = {
  mtg: MAGIC_RULES.map(({ key, label }) => ({ key, label })),
  pokemon: [
    { key: 'standard', label: 'Standard' },
    { key: 'expanded', label: 'Expanded' },
    { key: 'unlimited', label: 'Unlimited' },
  ],
  yugioh: [
    { key: 'advanced', label: 'Advanced' },
    { key: 'traditional', label: 'Traditional' },
    { key: 'speed', label: 'Speed Duel' },
  ],
};

/** The formats of a game (none for something that isn't one). */
export function formatsOf(game) {
  return DECK_FORMATS[game] || [];
}

export function isDeckFormat(game, format) {
  return formatsOf(game).some((f) => f.key === format);
}

/** "Modern", or '' when the game or format isn't known. */
export function formatLabel(game, format) {
  const found = formatsOf(game).find((f) => f.key === format);
  return found ? found.label : '';
}

/** The game and format a deck has, or null when it has none (decks made before this existed). */
export function deckFormatOf(deck) {
  return deck && isDeckFormat(deck.game, deck.format) ? { game: deck.game, format: deck.format } : null;
}

/** "Magic: The Gathering · Modern", or '' for a deck with none. */
export function deckFormatText(deck) {
  const have = deckFormatOf(deck);
  return have ? `${GAME_NAMES[have.game]} · ${formatLabel(have.game, have.format)}` : '';
}

/** The game that all of a deck's cards are from, or '' when it has none or a mix (a starting point for an older deck). */
export function gameOfCards(cards) {
  const games = new Set((cards || []).map((c) => c.game).filter((g) => DECK_GAMES.includes(g)));
  return games.size === 1 ? [...games][0] : '';
}

/** The message when a pick isn't allowed, else ''. The same words as the native store. */
export function deckFormatProblem(game, format, { required = false } = {}) {
  const none = (v) => v === undefined || v === null;
  if (none(game) && none(format)) return required ? 'game and format are required' : '';
  if (!DECK_GAMES.includes(game)) return "game must be one of ('mtg', 'pokemon', 'yugioh')";
  if (!isDeckFormat(game, format)) return 'format must be one of the formats of that game';
  return '';
}
