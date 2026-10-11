// Public share links. A signed-in person can turn one synced list into a read-only page anyone with the link can open:
//   POST /api/share        { id, renew? }  -> { id, token, url }   create the link (or fetch it; renew: a new one)
//   POST /api/share/revoke { id }          -> { ok: true }         stop sharing (the old link stops working at once)
//   GET  /api/share                        -> { shares: [{ id, token, url }] }
//   GET  /s/<token>                        -> the page (HTML)
// Public pages (opt-in, only for the wishlist and the tradelist) live at a readable address instead, /<username>/wishlist
// and /<username>/tradelist, and say whose they are (the address does):
//   GET  /api/public                       -> { public: [{ kind, id, url }] }
//   POST /api/public        { id }         -> { kind, id, url }    make that list public (its kind says which address)
//   POST /api/public/revoke { kind }       -> { ok: true }         take it down (the address is a 404 again at once)
//   GET  /<username>/wishlist | /<username>/tradelist              -> the page (HTML)
// The link is a random 32-character token, so it can't be guessed. The page is made from the list as last synced to the
// account (so it follows later syncs), shows only the list's name and cards (never the username or email), and is
// served with no-store so a revoked link is dead immediately.
import { cleanDoc } from './sync.js';
import { fail, json, readJson, sessionUser } from './lib.js';

export const MAX_SHARES_PER_USER = 100;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const KIND_WORDS = { deck: 'Deck', tradelist: 'Trade list', wishlist: 'Wishlist' };
const GAME_NAMES = { mtg: 'Magic: The Gathering', pokemon: 'Pokémon', yugioh: 'Yu-Gi-Oh!' };
const IMAGE_HOSTS = ['cards.scryfall.io', 'images.pokemontcg.io', 'images.ygoprodeck.com'];

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');  // 24 bytes: no '=' padding
}

const shareOut = (request, id, token) => ({ id, token, url: `${new URL(request.url).origin}/s/${token}` });

async function liveDoc(db, userId, id) {
  const row = await db.prepare('SELECT doc FROM sync_docs WHERE user_id = ? AND id = ?').bind(userId, id).first();
  const doc = row ? cleanDoc(JSON.parse(row.doc)) : null;
  return doc && doc.deleted === undefined ? doc : null;
}

export async function onShareCreate({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const body = await readJson(request);
  if (!body || typeof body.id !== 'string' || !body.id || body.id.length > 64) return fail('Say which list to share', 400);
  const db = env.DB;
  if (!(await liveDoc(db, user.id, body.id))) return fail('Sync this list to your account first, then share it', 404);

  const existing = await db.prepare('SELECT token FROM shares WHERE user_id = ? AND doc_id = ?').bind(user.id, body.id).first();
  if (existing && body.renew !== true) return json(shareOut(request, body.id, existing.token));
  if (!existing) {
    const count = await db.prepare('SELECT COUNT(*) AS n FROM shares WHERE user_id = ?').bind(user.id).first();
    if (count.n >= MAX_SHARES_PER_USER) return fail(`You can share at most ${MAX_SHARES_PER_USER} lists at once — stop sharing one first`, 400);
  }
  const token = newToken();
  await db
    .prepare('INSERT INTO shares (token, user_id, doc_id, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(user_id, doc_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at')
    .bind(token, user.id, body.id, Date.now())
    .run();
  return json(shareOut(request, body.id, token));
}

export async function onShareRevoke({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const body = await readJson(request);
  if (!body || typeof body.id !== 'string' || !body.id) return fail('Say which list to stop sharing', 400);
  await env.DB.prepare('DELETE FROM shares WHERE user_id = ? AND doc_id = ?').bind(user.id, body.id).run();
  return json({ ok: true });
}

export async function onShareList({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const rows = await env.DB.prepare('SELECT doc_id, token FROM shares WHERE user_id = ? ORDER BY created_at').bind(user.id).all();
  return json({ shares: rows.results.map((r) => shareOut(request, r.doc_id, r.token)) });
}

// ---- the public page --------------------------------------------------------------------------

export const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function imageUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && IMAGE_HOSTS.includes(url.hostname) ? url.href : '';
  } catch {
    return '';
  }
}

const PAGE_STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#1b1f27;--muted:#5d6676;--line:#dfe3ea;--accent:#2a5fd0}
@media(prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1c2027;--text:#e8ebf0;--muted:#9aa3b2;--line:#2b313b;--accent:#7ea4f2}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}
h1{margin:0 0 4px;font-size:1.6rem;overflow-wrap:anywhere}.sub{margin:0 0 20px;color:var(--muted)}
ul{list-style:none;margin:0;padding:0;background:var(--card);border:1px solid var(--line);border-radius:12px}
li{display:flex;gap:12px;align-items:center;padding:10px 14px;border-top:1px solid var(--line)}li:first-child{border-top:0}
img{width:44px;height:auto;border-radius:4px;flex:none}
.info{flex:1;min-width:0}.name{font-weight:600;overflow-wrap:anywhere}.meta{color:var(--muted);font-size:.875rem;overflow-wrap:anywhere}
.qty{font-weight:600;white-space:nowrap}.empty{padding:24px;text-align:center;color:var(--muted)}
footer{margin-top:24px;color:var(--muted);font-size:.875rem;text-align:center}a{color:var(--accent)}`;

function shell(title, bodyHtml, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>` +
    `<body><main>${bodyHtml}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src ${IMAGE_HOSTS.map((h) => `https://${h}`).join(' ')}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}

const notFound = () => shell('Link not found', '<h1>This link doesn’t work</h1><p class="sub">It may have been turned off by its owner, or the list was deleted.</p><footer><a href="/">Binder</a></footer>', 404);

function cardRow(card) {
  const image = imageUrl(card.image);
  const bits = [GAME_NAMES[card.game] || card.game, card.set, card.number ? `#${card.number}` : '', card.rarity, card.condition, card.foil ? 'Foil' : '', card.language]
    .filter(Boolean)
    .map(escapeHtml)
    .join(' · ');
  return `<li>${image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}` +
    `<div class="info"><div class="name">${escapeHtml(card.name)}</div><div class="meta">${bits}</div></div><div class="qty">×${escapeHtml(card.quantity)}</div></li>`;
}

export function renderSharePage(doc, owner = null) {
  const cards = [...doc.cards].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  const copies = cards.reduce((sum, c) => sum + Math.max(0, Math.floor(c.quantity)), 0);
  const kind = KIND_WORDS[doc.kind] || 'Collection';
  const count = `${cards.length.toLocaleString('en-US')} different card${cards.length === 1 ? '' : 's'} · ${copies.toLocaleString('en-US')} in total`;
  const list = cards.length ? `<ul>${cards.map(cardRow).join('')}</ul>` : '<ul><li class="empty">Nothing in this list yet.</li></ul>';
  // a public page is headed with whose it is ("Julie's wishlist"); a share link with the list's own name
  const heading = owner ? `${owner}’s ${kind.toLowerCase()}` : doc.name;
  return shell(
    `${heading} — ${kind}`,
    `<h1>${escapeHtml(heading)}</h1><p class="sub">${escapeHtml(kind)} · ${count}</p>${list}<footer>Shared from <a href="/">Binder</a></footer>`
  );
}

export async function onSharePage({ env, token }) {
  if (!TOKEN_RE.test(token)) return notFound();
  const row = await env.DB
    .prepare('SELECT sync_docs.doc AS doc FROM shares JOIN sync_docs ON sync_docs.user_id = shares.user_id AND sync_docs.id = shares.doc_id WHERE shares.token = ?')
    .bind(token)
    .first();
  const doc = row ? cleanDoc(JSON.parse(row.doc)) : null;
  return doc && doc.deleted === undefined ? renderSharePage(doc) : notFound();
}

// ---- public pages: /<username>/wishlist and /<username>/tradelist -----------------------------------------

export const PUBLIC_KINDS = ['wishlist', 'tradelist'];
const PUBLIC_PATH_RE = /^\/([A-Za-z0-9_.-]{3,32})\/(wishlist|tradelist)$/;

/** The username and kind a path asks for ("/julie/wishlist"), or null when it is not a public page address. */
export function publicPathOf(pathname) {
  const match = PUBLIC_PATH_RE.exec(pathname);
  return match ? { username: match[1], kind: match[2] } : null;
}

const publicOut = (request, username, kind, id) => ({ kind, id, url: `${new URL(request.url).origin}/${username}/${kind}` });

export async function onPublicList({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const rows = await env.DB.prepare('SELECT kind, doc_id FROM public_lists WHERE user_id = ? ORDER BY kind').bind(user.id).all();
  return json({ public: rows.results.map((r) => publicOut(request, user.username, r.kind, r.doc_id)) });
}

export async function onPublish({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const body = await readJson(request);
  if (!body || typeof body.id !== 'string' || !body.id || body.id.length > 64) return fail('Say which list to make public', 400);
  const doc = await liveDoc(env.DB, user.id, body.id);
  if (!doc) return fail('Sync this list to your account first, then make it public', 404);
  if (!PUBLIC_KINDS.includes(doc.kind)) return fail('Only a wishlist or a tradelist can be made public', 400);
  await env.DB
    .prepare('INSERT INTO public_lists (user_id, kind, doc_id, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(user_id, kind) DO UPDATE SET doc_id = excluded.doc_id, created_at = excluded.created_at')
    .bind(user.id, doc.kind, doc.id, Date.now())
    .run();
  return json(publicOut(request, user.username, doc.kind, doc.id));
}

export async function onUnpublish({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const body = await readJson(request);
  if (!body || !PUBLIC_KINDS.includes(body.kind)) return fail('Say which one to take down: the wishlist or the tradelist', 400);
  await env.DB.prepare('DELETE FROM public_lists WHERE user_id = ? AND kind = ?').bind(user.id, body.kind).run();
  return json({ ok: true });
}

// The page for /<username>/<kind>. Someone who doesn't exist, a list that isn't public and one that has been deleted all
// look the same, so the address can't be used to find out who has an account.
export async function onPublicPage({ env, username, kind }) {
  const row = await env.DB
    .prepare(
      'SELECT users.username AS username, sync_docs.doc AS doc FROM users ' +
        'JOIN public_lists ON public_lists.user_id = users.id AND public_lists.kind = ?1 ' +
        'JOIN sync_docs ON sync_docs.user_id = users.id AND sync_docs.id = public_lists.doc_id ' +
        'WHERE users.username_lower = ?2'
    )
    .bind(kind, username.toLowerCase())
    .first();
  const doc = row ? cleanDoc(JSON.parse(row.doc)) : null;
  return doc && doc.deleted === undefined && doc.kind === kind ? renderSharePage(doc, row.username) : notFound();
}
