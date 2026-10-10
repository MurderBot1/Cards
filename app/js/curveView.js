/**
 * curveView.js
 * Draws a deck's mana curve (manaCurve.js) as HTML: a stacked column per mana value, a legend, and a table of the same
 * numbers. Colors are the --mc-* tokens (app/css/styles.css), which carry identity next to the legend and the table, so
 * nothing relies on color alone.
 */
import { COLOR_NAMES, CURVE_COLORS } from './manaCurve.js';

const PLOT_PX = 100;  // the height of the tallest column
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// "2 white, 6 blue" for a column's colors
function describe(column) {
  return CURVE_COLORS.filter((c) => column.byColor[c] > 0).map((c) => `${column.byColor[c]} ${COLOR_NAMES[c]}`).join(', ');
}

/** The HTML of a curve: `curve` comes from manaCurve(); `loading` says the card data is still being fetched. */
export function curveHtml(curve, { loading = false } = {}) {
  if (curve.spells === 0) {
    const waiting = curve.unknown > 0 ? (loading ? 'Looking up mana costs…' : 'Mana costs could not be looked up yet (are you online?). Try again later.') : 'No spells to show.';
    return `<p class="field-hint">${waiting}</p>${curve.lands ? `<p class="field-hint">${plural(curve.lands, 'land')} (lands are not on the curve).</p>` : ''}`;
  }
  const columns = curve.columns.map((column) => {
    const colored = CURVE_COLORS.filter((c) => column.byColor[c] > 0);
    const segments = colored.map((c) => `<span class="curve-seg curve-seg--${c}" style="flex-grow:${column.byColor[c]}"></span>`).join('');
    const height = column.total > 0 ? Math.max(4, Math.round((column.total / curve.tallest) * PLOT_PX)) : 0;
    const label = column.total > 0 ? `${plural(column.total, 'card')} at ${column.label} mana (${describe(column)})` : `No cards at ${column.label} mana`;
    return `<div class="curve-col" title="${label}" aria-label="${label}">
      <span class="curve-count">${column.total || ''}</span>
      <div class="curve-bar" style="height:${height}px">${segments}</div>
      <span class="curve-x">${column.label}</span>
    </div>`;
  }).join('');

  const present = CURVE_COLORS.filter((c) => curve.columns.some((col) => col.byColor[c] > 0));
  const legend = present.map((c) => `<li><span class="curve-swatch curve-seg--${c}" aria-hidden="true"></span>${cap(COLOR_NAMES[c])}</li>`).join('');
  const rows = curve.columns.map((col) => `<tr><th scope="row">${col.label}</th><td>${col.total}</td>${present.map((c) => `<td>${col.byColor[c]}</td>`).join('')}</tr>`).join('');
  const head = `<tr><th scope="col">Mana</th><th scope="col">Cards</th>${present.map((c) => `<th scope="col">${cap(COLOR_NAMES[c])}</th>`).join('')}</tr>`;
  const notes = [
    `${plural(curve.spells, 'spell')}`,
    `average mana value ${curve.average.toFixed(1)}`,
    curve.lands ? plural(curve.lands, 'land') : '',
  ].filter(Boolean).join(' · ');
  const missing = curve.unknown > 0
    ? `<p class="field-hint">${plural(curve.unknown, 'card')} ${loading ? 'still being looked up' : 'not looked up yet'}; ${curve.unknown === 1 ? 'it is' : 'they are'} not in the curve.</p>`
    : '';
  const other = curve.other > 0 ? `<p class="field-hint">${plural(curve.other, 'card')} from other games ${curve.other === 1 ? 'is' : 'are'} not in the curve.</p>` : '';
  return `<figure class="curve">
    <figcaption class="curve-caption">${notes}</figcaption>
    <div class="curve-plot" role="group" aria-label="Mana curve">${columns}</div>
    <ul class="curve-legend">${legend}</ul>
    <details class="curve-table"><summary>Table view</summary><table>${head}${rows}</table></details>
    ${missing}${other}
  </figure>`;
}
