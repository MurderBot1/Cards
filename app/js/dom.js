/** Small DOM helpers shared by the shop views. */
export function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** "$12.50" from whole US cents (the shop trades in US dollars). */
export function usd(cents) {
  const n = Math.max(0, Math.round(Number(cents) || 0));
  return `$${(n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The picture of a card (or a blank when it has none): only https pictures are ever shown. */
export function artHtml(image, name) {
  return image && /^https:\/\//.test(image)
    ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(name || '')}" loading="lazy">`
    : '<span class="market-art-blank" aria-hidden="true"></span>';
}

export const GAME_NAMES = { mtg: 'Magic', pokemon: 'Pokémon', yugioh: 'Yu-Gi-Oh!' };
export const gameName = (game) => GAME_NAMES[game] || game || '';
