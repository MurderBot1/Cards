/**
 * legalityView.js
 * The text of a deck's legality check (deckLegality.js) as HTML: a verdict line, what is wrong, and what isn't checked.
 * The verdict is words and a mark, never color alone.
 */

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** HTML for one format's result; `loading` says card data is still being looked up. */
export function legalityHtml(result, { loading = false } = {}) {
  const name = escapeHtml(result.format.label);
  let verdict;
  if (result.verdict === 'legal') {
    verdict = `<p class="legal-verdict legal-verdict--legal"><span aria-hidden="true">✓</span> Legal in ${name}</p>`;
  } else if (result.verdict === 'illegal') {
    verdict = `<p class="legal-verdict legal-verdict--illegal"><span aria-hidden="true">✗</span> Not legal in ${name} (${plural(result.problems.length, 'problem')})</p>`;
  } else {
    const text = loading ? `Checking ${name}…` : result.unchecked > 0 ? `${name}: nothing wrong so far, but some cards are not checked` : `${name}: add cards to check`;
    verdict = `<p class="legal-verdict legal-verdict--unchecked"><span aria-hidden="true">?</span> ${text}</p>`;
  }
  const problems = result.problems.length ? `<ul class="legal-problems">${result.problems.map((p) => `<li>${escapeHtml(p.text)}</li>`).join('')}</ul>` : '';
  const notes = result.notes.length ? `<ul class="legal-notes">${result.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : '';
  return verdict + problems + notes;
}
