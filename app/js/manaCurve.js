/**
 * manaCurve.js
 * A deck's mana curve: how many copies of its spells cost 0, 1, 2 ... 7 or more mana, split by color. Lands aren't on
 * a curve (they cost nothing and aren't cast), so they are counted apart; copies of Magic cards with no mana value known
 * yet, and cards of other games, are counted apart too. Pure: what is known of each card is passed in (cardInfo.js).
 */

// stacked bottom to top, in the order the chart's colors were checked in (app/css/styles.css, --mc-*)
export const CURVE_COLORS = ['U', 'W', 'M', 'G', 'B', 'R', 'C'];
export const COLOR_NAMES = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', M: 'multicolor', C: 'colorless' };
export const MAX_COLUMN = 7;  // the last column is "7 or more"

/** Which color a card is drawn in: its one color, 'M' for two or more, 'C' for none. */
export function colorKey(info) {
  const colors = info && typeof info.colors === 'string' ? info.colors : '';
  if (colors.length === 0) return 'C';
  return colors.length === 1 ? colors : 'M';
}

const copiesOf = (card) => Math.max(0, Math.floor(Number(card && card.quantity) || 0));

/**
 * { columns: [{ mv, label, total, byColor }], spells, lands, unknown, other, average, tallest }
 *   spells: copies on the curve; lands: copies of lands; unknown: Magic copies not looked up yet; other: copies of
 *   other games' cards; average: mean mana value of the spells (null when there are none); tallest: biggest column.
 */
export function manaCurve(cards, infoOf) {
  const columns = Array.from({ length: MAX_COLUMN + 1 }, (_, mv) => ({
    mv,
    label: mv === MAX_COLUMN ? `${MAX_COLUMN}+` : String(mv),
    total: 0,
    byColor: Object.fromEntries(CURVE_COLORS.map((c) => [c, 0])),
  }));
  const out = { columns, spells: 0, lands: 0, unknown: 0, other: 0, average: null, tallest: 0 };
  let manaSum = 0;
  for (const card of cards || []) {
    const copies = copiesOf(card);
    if (copies === 0) continue;
    if (card.game !== 'mtg') {
      out.other += copies;
      continue;
    }
    const info = infoOf(card);
    if (!info) {
      out.unknown += copies;
      continue;
    }
    if (info.land) {
      out.lands += copies;
      continue;
    }
    const column = columns[Math.min(MAX_COLUMN, Math.max(0, Math.floor(info.mv || 0)))];
    column.total += copies;
    column.byColor[colorKey(info)] += copies;
    out.spells += copies;
    manaSum += (Number.isFinite(info.mv) ? info.mv : 0) * copies;
  }
  out.average = out.spells > 0 ? manaSum / out.spells : null;
  out.tallest = Math.max(0, ...columns.map((c) => c.total));
  return out;
}
