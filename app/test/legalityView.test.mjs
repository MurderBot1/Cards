import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFormat, formatByKey } from '../js/deckLegality.js';
import { legalityHtml } from '../js/legalityView.js';

const card = (id, name, quantity) => ({ id, name, game: 'mtg', quantity });
const LEGAL = { legal: { modern: 'l' } };
const BANNED = { legal: { modern: 'b' } };
const modern = formatByKey('modern');

test('a verdict is words and a mark; problems and notes follow', () => {
  const legal = legalityHtml(checkFormat(modern, [card('a', 'Island', 60)], () => LEGAL));
  assert.match(legal, /legal-verdict--legal"><span aria-hidden="true">✓<\/span> Legal in Modern<\/p>/);
  const bad = legalityHtml(checkFormat(modern, [card('a', 'Sol Ring', 1), card('b', 'Island', 20)], (c) => (c.id === 'a' ? BANNED : LEGAL)));
  assert.match(bad, /legal-verdict--illegal"><span aria-hidden="true">✗<\/span> Not legal in Modern \(2 problems\)/);
  assert.match(bad, /<li>Banned: Sol Ring<\/li>/);
  assert.match(bad, /<li>Needs at least 60 cards \(has 21\)<\/li>/);
  assert.match(bad, /<ul class="legal-notes"><li>Sideboards/);
});

test('cards not known yet: checking, or nothing wrong so far', () => {
  const unknown = checkFormat(modern, [card('a', 'Island', 60)], () => null);
  assert.match(legalityHtml(unknown, { loading: true }), /Checking Modern…/);
  assert.match(legalityHtml(unknown), /nothing wrong so far, but some cards are not checked/);
  assert.match(legalityHtml(checkFormat(modern, [], () => null)), /1 problem/, 'an empty deck is too small');
});

test('card names are escaped', () => {
  const html = legalityHtml(checkFormat(modern, [card('a', '<img src=x onerror=alert(1)> & "Co"', 1)], () => BANNED));
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;Co&quot;/);
});
