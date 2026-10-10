/**
 * webstore.js
 * The website's stand-in for the local backend's collections and settings (native/cardstore/src/store.cpp): the same
 * rules, status codes and messages, over the same routes, but kept in the browser's storage. Because it speaks the
 * same sync protocol (/sync/state, /sync/apply), sync.js keeps these collections in step with the account exactly as it
 * does for the apps.
 *
 *   handle('GET', '/collections') -> { status: 200, body: [...] }
 */
import { limitsOf, tooManyCardsMessage, tooManyCopiesMessage, tooManyListsMessage } from './listKinds.js';
import { ownedOf } from './deckOwnership.js';

const DB_KEY = 'binder_web_db_v1';
const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
const GAMES = ['mtg', 'pokemon', 'yugioh'];
const DEFAULT_CONDITION = 'Near Mint';
// the messages the frontend shows (same text as the native backend)
const CONDITIONS_REPR = "('Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged')";
const GAMES_REPR = "('mtg', 'pokemon', 'yugioh')";
// kinds of list; only the last three are written down (no `kind` means a collection)
const KINDS = ['collection', 'deck', 'tradelist', 'wishlist'];
const KINDS_REPR = "('collection', 'deck', 'tradelist', 'wishlist')";
const isSpecialKind = (k) => KINDS.includes(k) && k !== 'collection';
const isDeck = (list) => !!list && list.kind === 'deck';
// a whole number of copies from 0, else -1
const wholeCopies = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : -1);
// writes how many copies of a deck card the person has: only when there is something to say, never more than needed
function writeOwned(card, owned) {
  const kept = ownedOf({ quantity: card.quantity, owned });
  if (kept > 0) card.owned = kept;
  else delete card.owned;
}

const defaultSettings = () => ({ theme: 'dark', fontSize: 'medium', requestRate: 'medium', minImageQuality: 'medium' });
const emptyDb = () => ({ collections: [], settings: defaultSettings() });
const error = (status, message) => ({ status, body: { error: message } });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
// Python-style truthiness of a request field: missing, null, "", 0, [] and {} all mean "not provided"
const truthy = (v) => {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isObject(v)) return Object.keys(v).length > 0;
  return true;
};
// `updated` of a stored collection/card; 1 for data written before stamps existed
const stampOf = (v) => (v && isNumber(v.updated) ? v.updated : 1);
const clone = (v) => JSON.parse(JSON.stringify(v));

function randomId() {
  let id = '';
  for (let i = 0; i < 8; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

// localStorage, or memory when the browser won't give us any (private windows, blocked storage)
function defaultStorage() {
  const memory = new Map();
  let real = null;
  try {
    real = typeof localStorage !== 'undefined' ? localStorage : null;
    if (real) real.getItem(DB_KEY);
  } catch (e) {
    real = null;
  }
  return {
    getItem(key) {
      try { if (real) return real.getItem(key); } catch (e) { /* use memory */ }
      return memory.has(key) ? memory.get(key) : null;
    },
    setItem(key, value) {
      memory.set(key, value);
      try { if (real) real.setItem(key, value); } catch (e) { /* kept in memory */ }
    },
  };
}

export class WebStore {
  constructor({ storage = defaultStorage(), makeId = randomId, nowMs = () => Date.now() } = {}) {
    this.storage = storage;
    this.makeId = makeId;
    this.nowMs = nowMs;
  }

  load() {
    let db = null;
    try { db = JSON.parse(this.storage.getItem(DB_KEY) || 'null'); } catch (e) { db = null; }
    if (!isObject(db)) db = emptyDb();
    if (!Array.isArray(db.collections)) db.collections = [];
    if (!isObject(db.settings)) db.settings = defaultSettings();
    return db;
  }

  save(db) {
    this.storage.setItem(DB_KEY, JSON.stringify(db));
  }

  listCollections() {
    return { status: 200, body: this.load().collections };
  }

  createCollection(body) {
    const name = body && typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return error(400, 'name is required');
    const kind = body ? body.kind : undefined;
    if (kind !== undefined && kind !== null && !KINDS.includes(kind)) return error(400, `kind must be one of ${KINDS_REPR}`);
    const db = this.load();
    const madeKind = KINDS.includes(kind) ? kind : 'collection';
    const maxLists = limitsOf(madeKind).lists;
    if (maxLists !== null && db.collections.filter((c) => (KINDS.includes(c.kind) ? c.kind : 'collection') === madeKind).length >= maxLists) {
      return error(400, tooManyListsMessage(madeKind));
    }
    const collection = { id: this.makeId(), name, cards: [], updated: this.nowMs() };
    if (isSpecialKind(kind)) collection.kind = kind;
    db.collections.push(collection);
    this.save(db);
    return { status: 201, body: collection };
  }

  getCollection(id) {
    const c = this.load().collections.find((x) => x.id === id);
    return c ? { status: 200, body: c } : error(404, 'not found');
  }

  deleteCollection(id) {
    const db = this.load();
    const kept = db.collections.filter((c) => c.id !== id);
    if (kept.length === db.collections.length) return error(404, 'not found');
    db.collections = kept;
    if (!isObject(db.deleted)) db.deleted = {};
    db.deleted[id] = this.nowMs();
    this.save(db);
    return { status: 200, body: { deleted: true } };
  }

  // Adds one card (or `quantity` copies) to `collection`, stacking onto a matching row. Returns an error response, or
  // null when it was added. Doesn't load or save.
  addOne(collection, body, now, probe = false) {
    body = isObject(body) ? body : {};
    const { name, game } = body;
    if (!truthy(name)) return error(400, 'card name is required');
    if (typeof game !== 'string' || !GAMES.includes(game)) return error(400, `game must be one of ${GAMES_REPR}`);

    const conditionIn = body.condition;
    const condition = truthy(conditionIn) ? (typeof conditionIn === 'string' ? conditionIn : '') : DEFAULT_CONDITION;
    if (!CONDITIONS.includes(condition)) return error(400, `condition must be one of ${CONDITIONS_REPR}`);

    let copies = 1;
    if (body.quantity !== undefined && body.quantity !== null) {
      if (!Number.isInteger(body.quantity) || body.quantity < 1 || body.quantity > 100000) {
        return error(400, 'quantity must be a whole number of at least 1');
      }
      copies = body.quantity;
    }

    // Cards only stack (quantity + n) when name, set, game, condition, finish, language and collector number all match.
    // A request with no "set" never stacks: stored cards always carry one ("" by default), and a missing set is not "".
    const setIn = body.set === undefined ? null : body.set;
    const foil = body.foil === true;
    const language = typeof body.language === 'string' ? body.language : '';
    const number = typeof body.number === 'string' ? body.number : '';
    const existing = collection.cards.find(
      (c) =>
        c.name === name &&
        (c.set === undefined ? null : c.set) === setIn &&
        c.game === game &&
        (c.condition ?? DEFAULT_CONDITION) === condition &&
        (c.foil === true) === foil &&
        (typeof c.language === 'string' ? c.language : '') === language &&
        (typeof c.number === 'string' ? c.number : '') === number
    );
    if (!probe) {
      const listKind = KINDS.includes(collection.kind) ? collection.kind : 'collection';
      const limits = limitsOf(listKind);
      if (limits.perCard !== null && (existing ? existing.quantity + copies : copies) > limits.perCard) {
        return error(400, tooManyCopiesMessage(listKind));
      }
      if (!existing && collection.cards.length >= limits.cards) return error(400, tooManyCardsMessage(listKind));
    }
    // `owned` (a deck's "I have these", e.g. from a re-imported export): kept for decks, quietly left out elsewhere
    const ownedIn = isDeck(collection) ? wholeCopies(body.owned) : -1;
    if (existing) {
      existing.quantity += copies;
      if (ownedIn > 0) writeOwned(existing, (existing.owned || 0) + ownedIn);
      existing.updated = now;
    } else {
      const card = {
        id: probe ? '' : this.makeId(),  // (a probe only validates: it must not use up an id)
        name,
        game,
        set: body.set !== undefined ? body.set : '',
        rarity: body.rarity !== undefined ? body.rarity : '',
        image: body.image !== undefined ? body.image : '',
        condition,
        quantity: copies,
        updated: now,
      };
      // the catalog id the card was picked from (a search result's "id"): lets prices be looked up exactly
      const catalogId = body.uid !== undefined ? body.uid : body.id;
      if (typeof catalogId === 'string' && catalogId) card.uid = catalogId;
      // finish, language and collector number are only kept when there is something to say
      if (foil) card.foil = true;
      if (language) card.language = language;
      if (number) card.number = number;
      if (ownedIn > 0) writeOwned(card, ownedIn);
      collection.cards.push(card);
    }
    collection.updated = now;
    return null;
  }

  addCard(collectionId, body) {
    const invalid = this.addOne({ cards: [] }, body, 0, true);
    if (invalid) return invalid;  // (a bad request is a 400 even for a missing collection)
    const db = this.load();
    const collection = db.collections.find((c) => c.id === collectionId);
    if (!collection) return error(404, 'not found');
    const refused = this.addOne(collection, body, this.nowMs());
    if (refused) return refused;  // (a limit)
    this.save(db);
    return { status: 201, body: collection };
  }

  // Many cards at once (an import): body { cards: [card, ...] }, all or nothing.
  addCards(collectionId, body) {
    if (!isObject(body) || !Array.isArray(body.cards)) return error(400, 'cards must be an array');
    if (body.cards.length === 0 || body.cards.length > 20000) return error(400, 'send between 1 and 20000 cards');
    const db = this.load();
    const collection = db.collections.find((c) => c.id === collectionId);
    if (!collection) return error(404, 'not found');
    const now = this.nowMs();
    const work = clone(collection);
    for (let i = 0; i < body.cards.length; i++) {
      if (!isObject(body.cards[i])) return error(400, `card ${i + 1} is not an object`);
      const bad = this.addOne(work, body.cards[i], now);
      if (bad) return error(bad.status, `card ${i + 1}: ${bad.body.error}`);
    }
    db.collections[db.collections.indexOf(collection)] = work;
    this.save(db);
    return { status: 201, body: work };
  }

  updateCard(collectionId, cardId, body) {
    body = isObject(body) ? body : {};
    const { quantity, condition, uid, owned } = body;
    const has = (v) => v !== undefined && v !== null;
    if (!has(quantity) && !has(condition) && !has(uid) && !has(owned)) return error(400, 'quantity and/or condition is required');
    if (has(uid) && typeof uid !== 'string') return error(400, 'uid must be a string');
    if (has(quantity) && !isNumber(quantity)) return error(400, 'quantity must be a number');
    if (has(owned) && wholeCopies(owned) < 0) return error(400, 'owned must be a whole number of at least 0');
    if (has(condition) && !(typeof condition === 'string' && CONDITIONS.includes(condition))) {
      return error(400, `condition must be one of ${CONDITIONS_REPR}`);
    }
    const db = this.load();
    const collection = db.collections.find((c) => c.id === collectionId);
    if (!collection) return error(404, 'not found');

    if (has(owned) && !isDeck(collection)) return error(400, 'only a deck keeps track of the cards you have');
    if (has(quantity) && quantity > 0) {
      const listKind = KINDS.includes(collection.kind) ? collection.kind : 'collection';
      const perCard = limitsOf(listKind).perCard;
      if (perCard !== null && quantity > perCard) return error(400, tooManyCopiesMessage(listKind));
    }

    const now = this.nowMs();
    if (has(quantity) && quantity <= 0) {
      const kept = collection.cards.filter((c) => c.id !== cardId);
      if (kept.length !== collection.cards.length) {
        collection.cards = kept;
        if (!isObject(collection.tomb)) collection.tomb = {};
        collection.tomb[cardId] = now;
        collection.updated = now;
      }
    } else {
      for (const c of collection.cards) {
        if (c.id !== cardId) continue;
        if (has(quantity)) c.quantity = quantity;
        if (has(condition)) c.condition = condition;
        if (has(uid)) c.uid = uid;
        // (what is had never exceeds what is needed, so lowering the quantity lowers it too)
        if (has(owned)) writeOwned(c, owned);
        else if (has(quantity) && c.owned) writeOwned(c, c.owned);
        c.updated = now;
        collection.updated = now;
      }
    }
    this.save(db);
    return { status: 200, body: collection };
  }

  // ---- sync (see sync.js and cloudflare/src/sync.js) ----------------------------------------------------------
  syncState() {
    const db = this.load();
    const collections = db.collections.map((c) => {
      let newest = stampOf(c);
      const cards = (c.cards || []).map((card) => {
        const copy = { ...card, updated: stampOf(card) };
        newest = Math.max(newest, copy.updated);
        return copy;
      });
      const doc = { id: c.id || '', name: c.name || '', updated: newest, cards, tomb: isObject(c.tomb) ? c.tomb : {} };
      if (isSpecialKind(c.kind)) doc.kind = c.kind;
      return doc;
    });
    const deleted = isObject(db.deleted)
      ? Object.entries(db.deleted).filter(([, at]) => isNumber(at)).map(([id, at]) => ({ id, at }))
      : [];
    return { status: 200, body: { collections, deleted } };
  }

  syncApply(body) {
    if (!isObject(body)) return error(400, 'sync body must be a JSON object');
    const incoming = body.collections === undefined ? [] : body.collections;
    const expect = isObject(body.expect) ? body.expect : {};
    if (!Array.isArray(incoming)) return error(400, 'collections must be an array');

    const db = this.load();
    const applied = [];
    const skipped = [];
    if (!isObject(db.deleted)) db.deleted = {};

    for (const doc of incoming) {
      if (!isObject(doc) || typeof doc.id !== 'string') continue;
      const id = doc.id;
      // what this device had for it when the sync started, versus now
      const local = db.collections.find((c) => c.id === id);
      let localStamp = 0;
      if (local) {
        localStamp = stampOf(local);
        for (const card of local.cards || []) localStamp = Math.max(localStamp, stampOf(card));
      }
      const expectedPresent = isNumber(expect[id]);
      if (local ? !(expectedPresent && expect[id] === localStamp) : expectedPresent) {
        skipped.push(id);
        continue;
      }

      if ('deleted' in doc) {
        if (!isNumber(doc.deleted)) continue;
        if (local) db.collections = db.collections.filter((c) => c.id !== id);
        db.deleted[id] = doc.deleted;
        applied.push(id);
        continue;
      }
      if (!Array.isArray(doc.cards) || typeof doc.name !== 'string') continue;

      const merged = { id, name: doc.name, cards: doc.cards, updated: stampOf(doc) };
      if (isObject(doc.tomb)) merged.tomb = doc.tomb;
      if (isSpecialKind(doc.kind)) merged.kind = doc.kind;
      if (local) db.collections[db.collections.indexOf(local)] = merged;
      else db.collections.push(merged);
      delete db.deleted[id];
      applied.push(id);
    }
    this.save(db);
    return { status: 200, body: { applied, skipped } };
  }

  // Sets how many copies of each card of a deck the person has, in one go: body { owned: { card id: copies } }.
  setOwned(collectionId, body) {
    const owned = isObject(body) ? body.owned : undefined;
    if (!isObject(owned)) return error(400, 'owned must be an object of card id to copies');
    if (Object.values(owned).some((v) => wholeCopies(v) < 0)) return error(400, 'owned must be a whole number of at least 0');
    const db = this.load();
    const collection = db.collections.find((c) => c.id === collectionId);
    if (!collection) return error(404, 'not found');
    if (!isDeck(collection)) return error(400, 'only a deck keeps track of the cards you have');
    const now = this.nowMs();
    let changed = false;
    for (const c of collection.cards) {
      if (!Object.prototype.hasOwnProperty.call(owned, c.id)) continue;
      const before = c.owned || 0;
      writeOwned(c, owned[c.id]);
      if ((c.owned || 0) !== before) {
        c.updated = now;
        changed = true;
      }
    }
    if (changed) {
      collection.updated = now;
      this.save(db);
    }
    return { status: 200, body: collection };
  }

  getSettings() {
    return { status: 200, body: this.load().settings };
  }

  updateSettings(body) {
    if (!isObject(body)) return error(400, 'settings must be a JSON object');
    const db = this.load();
    Object.assign(db.settings, body);
    this.save(db);
    return { status: 200, body: db.settings };
  }

  // The routes of the local backend that the page uses, so api.js needs no second code path.
  // `path` is what follows /api, e.g. '/collections/ab12/cards'.
  handle(method, path, body) {
    const parts = path.split('?')[0].split('/').filter(Boolean);
    const [root, id, sub, cardId] = parts;
    if (root === 'collections') {
      if (!id) {
        if (method === 'GET') return this.listCollections();
        if (method === 'POST') return this.createCollection(body);
      } else if (!sub) {
        if (method === 'GET') return this.getCollection(id);
        if (method === 'DELETE') return this.deleteCollection(id);
      } else if (sub === 'cards') {
        if (!cardId && method === 'POST') return this.addCard(id, body);
        if (cardId === 'bulk' && method === 'POST') return this.addCards(id, body);
        if (cardId && method === 'PATCH') return this.updateCard(id, cardId, body);
      } else if (sub === 'owned' && method === 'POST') {
        return this.setOwned(id, body);
      }
    } else if (root === 'sync') {
      if (id === 'state' && method === 'GET') return this.syncState();
      if (id === 'apply' && method === 'POST') return this.syncApply(body);
    } else if (root === 'settings' && !id) {
      if (method === 'GET') return this.getSettings();
      if (method === 'PUT') return this.updateSettings(body);
    }
    return error(404, 'not found');
  }
}

let shared = null;
export function webStore() {
  if (!shared) shared = new WebStore();
  return shared;
}
