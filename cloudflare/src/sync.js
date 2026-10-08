// Collection sync. The app sends the collections that changed on that device; this merges them with the copy stored
// for the account and answers with the merged result (and anything other devices changed since the app's cursor),
// which the app writes back locally. See native/cardstore (sync_state / sync_apply) for the device side.
//
// A collection travels as a "doc":
//   { id, name, updated, cards: [{id, uid?, name, game, set, rarity, image, condition, quantity, updated}], tomb: {cardId: ms} }
// or, once deleted, { id, deleted: ms }. Times are the device's clock in milliseconds. Merging is last-writer-wins
// per card; removals are kept as tombstones so they win over older copies instead of being resurrected.
import { fail, json, readJson, sessionUser } from './lib.js';

export const MAX_DOCS_PER_REQUEST = 90; // D1 allows 100 bound parameters per statement; one is the user id
export const PULL_LIMIT = 40;
const MAX_CARDS = 20000;
const MAX_DOC_BYTES = 1500000;
const CONDITIONS = new Set(['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged']);
const GAMES = new Set(['mtg', 'pokemon', 'yugioh']);

const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// ---- validation -------------------------------------------------------------------------------

function cleanCard(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || raw.id.length > 64) return null;
  if (typeof raw.name !== 'string' || !raw.name || !GAMES.has(raw.game)) return null;
  if (typeof raw.quantity !== 'number' || !Number.isFinite(raw.quantity)) return null;
  const card = {
    id: raw.id,
    name: text(raw.name, 300),
    game: raw.game,
    set: text(raw.set, 100),
    rarity: text(raw.rarity, 100),
    image: text(raw.image, 600),
    condition: CONDITIONS.has(raw.condition) ? raw.condition : 'Near Mint',
    quantity: raw.quantity,
    updated: isTime(raw.updated) ? raw.updated : 1,
  };
  if (typeof raw.uid === 'string' && raw.uid && raw.uid.length <= 200) card.uid = raw.uid;
  return card;
}

// A doc from the app (or the database) in canonical form, or null when it isn't one.
export function cleanDoc(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || raw.id.length > 64) return null;
  if (raw.deleted !== undefined) return isTime(raw.deleted) ? { id: raw.id, deleted: raw.deleted } : null;
  if (typeof raw.name !== 'string' || !Array.isArray(raw.cards) || raw.cards.length > MAX_CARDS) return null;
  const cards = [];
  for (const c of raw.cards) {
    const card = cleanCard(c);
    if (!card) return null;
    cards.push(card);
  }
  const tomb = {};
  if (raw.tomb && typeof raw.tomb === 'object') {
    for (const [id, at] of Object.entries(raw.tomb).slice(0, MAX_CARDS)) if (isTime(at)) tomb[id] = at;
  }
  return { id: raw.id, name: text(raw.name, 200), updated: isTime(raw.updated) ? raw.updated : 1, cards, tomb };
}

// ---- merging ----------------------------------------------------------------------------------

// Merges two versions of the same collection. Pure; the result doesn't depend on which one is `a`.
export function mergeDocs(a, b) {
  const live = [a, b].filter((d) => d.deleted === undefined);
  const deletedAt = Math.max(0, ...[a, b].filter((d) => d.deleted !== undefined).map((d) => d.deleted));
  if (live.length === 0) return { id: a.id, deleted: deletedAt };
  if (live.length === 1 && deletedAt > 0) {
    const [only] = live;
    // deleted after the last edit: stays deleted; edited since: the collection lives on
    return deletedAt >= only.updated ? { id: a.id, deleted: deletedAt } : only;
  }
  if (live.length === 1) return live[0];

  const tomb = { ...a.tomb };
  for (const [id, at] of Object.entries(b.tomb)) tomb[id] = Math.max(tomb[id] ?? 0, at);

  const byId = new Map();
  for (const card of [...a.cards, ...b.cards]) {
    const have = byId.get(card.id);
    // newest wins; on an exact tie the larger quantity does, so the choice doesn't depend on argument order
    if (!have || card.updated > have.updated || (card.updated === have.updated && card.quantity > have.quantity)) {
      byId.set(card.id, card);
    }
  }
  const cards = [...byId.values()].filter((c) => !(tomb[c.id] >= c.updated));
  cards.sort((x, y) => (x.id < y.id ? -1 : 1));
  const newest = a.updated === b.updated ? (a.name <= b.name ? a : b) : a.updated > b.updated ? a : b;
  const updated = Math.max(a.updated, b.updated, ...cards.map((c) => c.updated), ...Object.values(tomb));
  return { id: a.id, name: newest.name, updated, cards, tomb };
}

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

// ---- the endpoint -----------------------------------------------------------------------------

const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');

// POST { cursor, collections: [doc], deleted: [{id, at}] }  (Authorization: Bearer <token>)
//   -> { cursor, more, collections: [doc] }
export async function onSync({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  const body = await readJson(request);
  if (!body) return fail('Send a JSON body', 400);

  const cursor = isTime(body.cursor) ? body.cursor : 0;
  const incoming = new Map();
  for (const raw of Array.isArray(body.collections) ? body.collections : []) {
    const doc = cleanDoc(raw);
    if (!doc) return fail('One of the collections is not valid', 400);
    if (JSON.stringify(doc).length > MAX_DOC_BYTES) return fail(`"${doc.name}" is too large to sync`, 413);
    incoming.set(doc.id, incoming.has(doc.id) ? mergeDocs(incoming.get(doc.id), doc) : doc);
  }
  for (const raw of Array.isArray(body.deleted) ? body.deleted : []) {
    const doc = cleanDoc({ id: raw && raw.id, deleted: raw && raw.at });
    if (!doc) continue;
    incoming.set(doc.id, incoming.has(doc.id) ? mergeDocs(incoming.get(doc.id), doc) : doc);
  }
  if (incoming.size > MAX_DOCS_PER_REQUEST) return fail(`Send at most ${MAX_DOCS_PER_REQUEST} collections per request`, 400);

  const db = env.DB;
  const stored = new Map();
  if (incoming.size > 0) {
    const ids = [...incoming.keys()];
    const rows = await db
      .prepare(`SELECT id, doc FROM sync_docs WHERE user_id = ? AND id IN (${placeholders(ids.length)})`)
      .bind(user.id, ...ids)
      .all();
    for (const row of rows.results) {
      const doc = cleanDoc(JSON.parse(row.doc));
      if (doc) stored.set(row.id, doc);
    }
  }

  // what other devices changed since this one last looked (read before our own writes land)
  const pulled = await db
    .prepare('SELECT id, doc, server_updated FROM sync_docs WHERE user_id = ? AND server_updated > ? ORDER BY server_updated LIMIT ?')
    .bind(user.id, cursor, PULL_LIMIT + 1)
    .all();
  const more = pulled.results.length > PULL_LIMIT;
  const pulledRows = pulled.results.slice(0, PULL_LIMIT);

  const merged = new Map();
  const changed = [];
  for (const [id, doc] of incoming) {
    const have = stored.get(id);
    const result = have ? mergeDocs(have, doc) : doc;
    merged.set(id, result);
    if (!have || !same(have, result)) changed.push(result);
  }

  let nextCursor = cursor;
  if (changed.length > 0) {
    const last = await db.prepare('SELECT MAX(server_updated) AS m FROM sync_docs WHERE user_id = ?').bind(user.id).first();
    // every doc gets its own, increasing stamp, so a cursor (and paging by it) never splits docs that share one
    const first = Math.max(Date.now(), (last && last.m ? last.m : 0) + 1);
    const payload = JSON.stringify(changed.map((doc, i) => ({ id: doc.id, doc: JSON.stringify(doc), su: first + i })));
    await db
      .prepare(
        "INSERT INTO sync_docs (user_id, id, doc, server_updated) SELECT ?1, json_extract(value, '$.id'), json_extract(value, '$.doc'), json_extract(value, '$.su') " +
          'FROM json_each(?2) WHERE true ON CONFLICT(user_id, id) DO UPDATE SET doc = excluded.doc, server_updated = excluded.server_updated'
      )
      .bind(user.id, payload)
      .run();
    if (!more) nextCursor = first + changed.length - 1;
  }

  const out = new Map(merged);
  for (const row of pulledRows) {
    nextCursor = Math.max(nextCursor, row.server_updated);
    if (out.has(row.id)) continue;
    const doc = cleanDoc(JSON.parse(row.doc));
    if (doc) out.set(row.id, doc);
  }
  return json({ cursor: nextCursor, more, collections: [...out.values()] });
}
