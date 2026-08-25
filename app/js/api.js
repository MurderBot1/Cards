/**
 * api.js
 * -----------------------------------------------------------------
 * Every function here is the ONE place that talks to the outside
 * world. When the Python backend exists, each function should point
 * at a real endpoint (see the comments marked BACKEND). Until then,
 * USE_MOCK keeps the app fully working against data saved in
 * localStorage, so the UI can be built and demoed standalone.
 *
 * Swap USE_MOCK to false once the backend is running — no other
 * file needs to change.
 * -----------------------------------------------------------------
 */

const USE_MOCK = false;
const API_BASE = '/api';
const MOCK_DB_KEY = 'binder_mock_db_v1';

// ---------------------------------------------------------------
// mock persistence helpers
// ---------------------------------------------------------------
function loadMockDb() {
  const raw = localStorage.getItem(MOCK_DB_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch (e) { /* fall through */ }
  }
  return {
    collections: [],
    settings: {
      theme: 'dark',
      fontSize: 'medium',
      requestRate: 'medium',
      minImageQuality: 'medium',
    },
    // mock-mode-only account store: username -> password. The real backend
    // never round-trips plaintext like this — see loginserver's salted
    // SHA-256 storage — this is purely a standalone-demo stand-in.
    users: {},
  };
}
function saveMockDb(db) {
  localStorage.setItem(MOCK_DB_KEY, JSON.stringify(db));
}
function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
function delay(ms = 120) {
  return new Promise((res) => setTimeout(res, ms));
}

export const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
export const DEFAULT_CONDITION = 'Near Mint';

// lowercased-name index per game, built once per game and reused, so the
// mock search doesn't re-lowercase every card's name on every keystroke.
const mockSearchIndex = {};
function indexFor(game) {
  if (!mockSearchIndex[game]) {
    const pool = SAMPLE_CARDS[game] || [];
    mockSearchIndex[game] = pool.map((c) => ({ card: c, lname: c.name.toLowerCase() }));
  }
  return mockSearchIndex[game];
}

// small built-in sample databases so "Search" has something to find
// in mock mode. A real backend would query Scryfall / the Pokémon
// TCG API / YGOPRODeck (or a cached mirror of them) instead.
const SAMPLE_CARDS = {
  mtg: [
    { id: 'mtg-1', name: 'Lightning Bolt', set: 'M11', rarity: 'Common' },
    { id: 'mtg-2', name: 'Sol Ring', set: 'CMR', rarity: 'Uncommon' },
    { id: 'mtg-3', name: 'Black Lotus', set: 'LEA', rarity: 'Rare' },
    { id: 'mtg-4', name: 'Counterspell', set: 'MH2', rarity: 'Uncommon' },
    { id: 'mtg-5', name: 'Wrath of God', set: 'DOM', rarity: 'Rare' },
  ],
  pokemon: [
    { id: 'pkm-1', name: 'Pikachu', set: 'Base Set', rarity: 'Common' },
    { id: 'pkm-2', name: 'Charizard', set: 'Base Set', rarity: 'Rare Holo' },
    { id: 'pkm-3', name: 'Mewtwo', set: 'Base Set', rarity: 'Rare Holo' },
    { id: 'pkm-4', name: 'Eevee', set: 'Jungle', rarity: 'Common' },
    { id: 'pkm-5', name: 'Gengar', set: 'Fossil', rarity: 'Rare Holo' },
  ],
  yugioh: [
    { id: 'ygo-1', name: 'Dark Magician', set: 'LOB', rarity: 'Ultra Rare' },
    { id: 'ygo-2', name: 'Blue-Eyes White Dragon', set: 'LOB', rarity: 'Ultra Rare' },
    { id: 'ygo-3', name: 'Pot of Greed', set: 'SDY', rarity: 'Common' },
    { id: 'ygo-4', name: 'Exodia the Forbidden One', set: 'LOB', rarity: 'Secret Rare' },
    { id: 'ygo-5', name: 'Summoned Skull', set: 'LOB', rarity: 'Ultra Rare' },
  ],
};

// ---------------------------------------------------------------
// generic request wrapper for the real backend
// ---------------------------------------------------------------
async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // prefer the backend's own error message (e.g. "Invalid credentials",
    // "Username taken") over a bare status code, when it sent one
    throw new Error((data && data.error) || `API ${path} failed: ${res.status}`);
  }
  return data;
}

// ---------------------------------------------------------------
// Public API surface used by the rest of the app
// ---------------------------------------------------------------
export const api = {

  // ---- collections -----------------------------------------------------
  async getCollections() {
    if (USE_MOCK) {
      await delay();
      return loadMockDb().collections;
    }
    // BACKEND: GET /api/collections -> [{id, name, game, cards: [...]}]
    return request('/collections');
  },

  async createCollection(name) {
    if (USE_MOCK) {
      await delay();
      const db = loadMockDb();
      const collection = { id: uid(), name, cards: [] };
      db.collections.push(collection);
      saveMockDb(db);
      return collection;
    }
    // BACKEND: POST /api/collections {name} -> collection. Collections hold
    // cards from any game — each card carries its own `game` field instead.
    return request('/collections', { method: 'POST', body: JSON.stringify({ name }) });
  },

  async deleteCollection(collectionId) {
    if (USE_MOCK) {
      await delay();
      const db = loadMockDb();
      db.collections = db.collections.filter((c) => c.id !== collectionId);
      saveMockDb(db);
      return true;
    }
    // BACKEND: DELETE /api/collections/:id
    return request(`/collections/${collectionId}`, { method: 'DELETE' });
  },

  async getCollection(collectionId) {
    if (USE_MOCK) {
      await delay();
      return loadMockDb().collections.find((c) => c.id === collectionId) || null;
    }
    // BACKEND: GET /api/collections/:id
    return request(`/collections/${collectionId}`);
  },

  // ---- cards within a collection ----------------------------------------
  async addCardToCollection(collectionId, card) {
    if (USE_MOCK) {
      await delay();
      const db = loadMockDb();
      const collection = db.collections.find((c) => c.id === collectionId);
      if (!collection) throw new Error('Collection not found');
      const condition = card.condition || DEFAULT_CONDITION;
      const existing = collection.cards.find(
        (c) => c.name === card.name && c.set === card.set && c.game === card.game && c.condition === condition
      );
      if (existing) {
        existing.quantity += 1;
      } else {
        collection.cards.push({ ...card, condition, id: uid(), quantity: 1 });
      }
      saveMockDb(db);
      return collection;
    }
    // BACKEND: POST /api/collections/:id/cards {card} -> updated collection
    return request(`/collections/${collectionId}/cards`, { method: 'POST', body: JSON.stringify(card) });
  },

  async updateCardQuantity(collectionId, cardId, quantity) {
    if (USE_MOCK) {
      await delay(60);
      const db = loadMockDb();
      const collection = db.collections.find((c) => c.id === collectionId);
      if (!collection) throw new Error('Collection not found');
      collection.cards = collection.cards
        .map((c) => (c.id === cardId ? { ...c, quantity } : c))
        .filter((c) => c.quantity > 0);
      saveMockDb(db);
      return collection;
    }
    // BACKEND: PATCH /api/collections/:id/cards/:cardId {quantity}
    return request(`/collections/${collectionId}/cards/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify({ quantity }),
    });
  },

  async updateCardCondition(collectionId, cardId, condition) {
    if (USE_MOCK) {
      await delay(60);
      const db = loadMockDb();
      const collection = db.collections.find((c) => c.id === collectionId);
      if (!collection) throw new Error('Collection not found');
      collection.cards = collection.cards.map((c) => (c.id === cardId ? { ...c, condition } : c));
      saveMockDb(db);
      return collection;
    }
    // BACKEND: PATCH /api/collections/:id/cards/:cardId {condition}
    return request(`/collections/${collectionId}/cards/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify({ condition }),
    });
  },

  // ---- card database search ----------------------------------------------
  async searchCards(game, query) {
    if (USE_MOCK) {
      await delay(150);
      const idx = indexFor(game);
      if (!query) return idx.map((e) => e.card);
      const q = query.toLowerCase();
      // prefix matches first (what people are usually typing toward),
      // then contains-matches, mirroring the backend's search ordering.
      const starts = [];
      const contains = [];
      for (const e of idx) {
        if (e.lname.startsWith(q)) starts.push(e.card);
        else if (e.lname.includes(q)) contains.push(e.card);
      }
      return starts.concat(contains);
    }
    // BACKEND: GET /api/search?game=mtg&q=bolt -> [{id, name, set, rarity, image}]
    return request(`/search?game=${encodeURIComponent(game)}&q=${encodeURIComponent(query)}`);
  },

  // ---- live detection (scan-modal preview loop) ---------------------------
  async detectCard(imageBlob, signal) {
    if (USE_MOCK) {
      await delay(60);
      return { bbox: null, image_width: 0, image_height: 0, game: null };
    }
    // BACKEND: POST /api/detect (multipart form: image) -> {bbox|null, quad|null, image_width, image_height, game}
    // Detection-only — no OCR/catalog lookup — so it's cheap enough to call
    // once per frame in a tight, sequential loop from the scan modal. `quad`
    // (4 ordered corner points) is present when the contour fallback found
    // one, so a tilted card can be traced as its actual trapezoid instead
    // of just its axis-aligned bbox.
    const form = new FormData();
    form.append('image', imageBlob, 'frame.jpg');
    const res = await fetch(`${API_BASE}/detect`, { method: 'POST', body: form, signal });
    if (!res.ok) throw new Error(`Detect failed: ${res.status}`);
    return res.json();
  },

  // ---- scanning ------------------------------------------------------------
  async scanCard(imageBlob, game) {
    if (USE_MOCK) {
      await delay(900);
      const pool = SAMPLE_CARDS[game] || SAMPLE_CARDS.mtg;
      return pool[Math.floor(Math.random() * pool.length)];
    }
    // BACKEND: POST /api/scan (multipart form: image, game) -> matched card
    const form = new FormData();
    form.append('image', imageBlob, 'scan.jpg');
    form.append('game', game);
    const res = await fetch(`${API_BASE}/scan`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // even on a miss, the backend may have found a card-shaped region
      // and just failed to match it — carry that through so the UI can
      // still show the detection box instead of only an error message.
      const err = new Error(data.error || 'Scan failed');
      err.bbox = data.bbox;
      err.image_width = data.image_width;
      err.image_height = data.image_height;
      throw err;
    }
    return data;
  },

  // ---- auth ------------------------------------------------------------
  // Backed by the C++ LoginServer (see loginserver/) via app.py's
  // /api/auth/* bridge routes — see loginserver/README.md for the
  // underlying LOGIN/REGISTER protocol.
  async login(username, password) {
    if (USE_MOCK) {
      await delay(200);
      const db = loadMockDb();
      if (!db.users[username] || db.users[username] !== password) {
        throw new Error('Invalid credentials');
      }
      return { username };
    }
    // BACKEND: POST /api/auth/login {username, password} -> {username} | {error}
    return request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  },

  async register(username, password) {
    if (USE_MOCK) {
      await delay(200);
      const db = loadMockDb();
      if (db.users[username]) {
        throw new Error('Username taken');
      }
      db.users[username] = password;
      saveMockDb(db);
      return { username };
    }
    // BACKEND: POST /api/auth/register {username, password} -> {username} | {error}
    return request('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) });
  },

  // ---- settings --------------------------------------------------------------
  async getSettings() {
    if (USE_MOCK) {
      await delay(60);
      return loadMockDb().settings;
    }
    // BACKEND: GET /api/settings
    return request('/settings');
  },

  async saveSettings(settings) {
    if (USE_MOCK) {
      await delay(60);
      const db = loadMockDb();
      db.settings = { ...db.settings, ...settings };
      saveMockDb(db);
      return db.settings;
    }
    // BACKEND: PUT /api/settings {settings}
    return request('/settings', { method: 'PUT', body: JSON.stringify(settings) });
  },
};