/**
 * catalogSearch.js
 * One search across every game's card catalog at once, for the shop (the market, and the card picker when listing a card): a person
 * searches for a name and sees Magic, Pokémon and Yu-Gi-Oh! cards together, instead of choosing a game first. The catalog search
 * itself (api.searchCards) works one game at a time, so this asks all of them, a page each, and weaves the answers together so no
 * game crowds out the others. Pages continue per game until every game has run out.
 */
export const GAMES = ['mtg', 'pokemon', 'yugioh'];

/**
 * A search for `query` over all games. `searchOne(game, query, { limit, offset })` is the one-game search. Each call of more()
 * resolves to the next batch of cards (each with its `game`), and `done` says whether anything is left to fetch. A game that
 * fails is left out (the others still answer); only when every game fails does more() throw.
 */
export function createCrossSearch(searchOne, query, { perGame = 12, games = GAMES } = {}) {
  const state = games.map((game) => ({ game, offset: 0, done: false }));
  return {
    get done() { return state.every((s) => s.done); },
    async more() {
      const active = state.filter((s) => !s.done);
      if (!active.length) return [];
      const answers = await Promise.all(active.map(async (s) => {
        try {
          const found = await searchOne(s.game, query, { limit: perGame, offset: s.offset });
          s.offset += found.length;
          if (found.length < perGame) s.done = true;
          return { ok: true, cards: found.map((c) => ({ ...c, game: s.game })) };
        } catch (err) {
          s.done = true;
          return { ok: false, err };
        }
      }));
      if (answers.every((a) => !a.ok)) throw answers[0].err;
      // weave: first of each game, then second of each, …
      const lists = answers.filter((a) => a.ok).map((a) => a.cards);
      const out = [];
      for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
      return out;
    },
  };
}
