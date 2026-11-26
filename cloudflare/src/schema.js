// The database schema, applied by the Worker itself the first time it runs after a deploy, so nobody has to paste
// schema.sql into the D1 console (a test keeps this list identical to schema.sql, which is still the readable copy and
// works in the console too). Every statement is idempotent: tables and indexes are created only if missing, and the
// two DROPs remove the price-cache tables an earlier version used. Add new tables/indexes to the end of both files.
export const STATEMENTS = [
  'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, username_lower TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)',
  'CREATE TABLE IF NOT EXISTS login_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, username_lower TEXT NOT NULL, ip TEXT NOT NULL, at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS login_failures_lookup ON login_failures(username_lower, at)',
  'CREATE INDEX IF NOT EXISTS login_failures_ip ON login_failures(ip, at)',
  'CREATE TABLE IF NOT EXISTS sync_docs (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, doc TEXT NOT NULL, server_updated INTEGER NOT NULL, PRIMARY KEY (user_id, id))',
  'CREATE INDEX IF NOT EXISTS sync_docs_pull ON sync_docs(user_id, server_updated)',
  'CREATE TABLE IF NOT EXISTS shares (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, doc_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (user_id, doc_id))',
  'CREATE TABLE IF NOT EXISTS public_lists (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, doc_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, kind))',
  'CREATE TABLE IF NOT EXISTS sellers (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, legal_name TEXT NOT NULL, phone TEXT NOT NULL, addr_line1 TEXT NOT NULL, addr_line2 TEXT NOT NULL DEFAULT \'\', city TEXT NOT NULL, region TEXT NOT NULL, postal TEXT NOT NULL, country TEXT NOT NULL, payout_kind TEXT NOT NULL, payout_ref TEXT NOT NULL DEFAULT \'\', stripe_account TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS listings (id TEXT PRIMARY KEY, seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, game TEXT NOT NULL, card_id TEXT NOT NULL DEFAULT \'\', name TEXT NOT NULL, name_lower TEXT NOT NULL, set_code TEXT NOT NULL DEFAULT \'\', number TEXT NOT NULL DEFAULT \'\', image TEXT NOT NULL DEFAULT \'\', condition TEXT NOT NULL, foil INTEGER NOT NULL DEFAULT 0, language TEXT NOT NULL DEFAULT \'English\', price_cents INTEGER NOT NULL, quantity INTEGER NOT NULL, note TEXT NOT NULL DEFAULT \'\', status TEXT NOT NULL DEFAULT \'active\', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS listings_browse ON listings(status, name_lower)',
  'CREATE INDEX IF NOT EXISTS listings_seller ON listings(seller_id, status)',
  'CREATE TABLE IF NOT EXISTS cart_items (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE, qty INTEGER NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (user_id, listing_id))',
  'CREATE TABLE IF NOT EXISTS buyers (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, stripe_customer TEXT, ship_name TEXT NOT NULL DEFAULT \'\', ship_phone TEXT NOT NULL DEFAULT \'\', ship_line1 TEXT NOT NULL DEFAULT \'\', ship_line2 TEXT NOT NULL DEFAULT \'\', ship_city TEXT NOT NULL DEFAULT \'\', ship_region TEXT NOT NULL DEFAULT \'\', ship_postal TEXT NOT NULL DEFAULT \'\', ship_country TEXT NOT NULL DEFAULT \'\', updated_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, buyer_id INTEGER NOT NULL, status TEXT NOT NULL, provider TEXT NOT NULL, provider_ref TEXT NOT NULL DEFAULT \'\', checkout_url TEXT NOT NULL DEFAULT \'\', payment_ref TEXT NOT NULL DEFAULT \'\', charge_ref TEXT NOT NULL DEFAULT \'\', items_cents INTEGER NOT NULL, shipping_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL, ship_name TEXT NOT NULL, ship_phone TEXT NOT NULL DEFAULT \'\', ship_line1 TEXT NOT NULL, ship_line2 TEXT NOT NULL DEFAULT \'\', ship_city TEXT NOT NULL, ship_region TEXT NOT NULL, ship_postal TEXT NOT NULL, ship_country TEXT NOT NULL, flag TEXT NOT NULL DEFAULT \'\', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, paid_at INTEGER, expires_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS orders_buyer ON orders(buyer_id, created_at)',
  'CREATE INDEX IF NOT EXISTS orders_pending ON orders(status, expires_at)',
  'CREATE TABLE IF NOT EXISTS order_groups (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, seller_id INTEGER NOT NULL, status TEXT NOT NULL, items_cents INTEGER NOT NULL, shipping_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL, card_count INTEGER NOT NULL, ship_mode TEXT NOT NULL, ship_service TEXT NOT NULL DEFAULT \'\', carrier TEXT NOT NULL DEFAULT \'\', tracking_number TEXT NOT NULL DEFAULT \'\', tracking_url TEXT NOT NULL DEFAULT \'\', label_url TEXT NOT NULL DEFAULT \'\', label_cost_cents INTEGER NOT NULL DEFAULT 0, tracking_status TEXT NOT NULL DEFAULT \'\', tracking_mode TEXT NOT NULL DEFAULT \'\', shipped_at INTEGER, delivered_at INTEGER, release_at INTEGER, payout_cents INTEGER NOT NULL DEFAULT 0, payout_ref TEXT NOT NULL DEFAULT \'\', paid_out_at INTEGER, refunded_cents INTEGER NOT NULL DEFAULT 0, hold INTEGER NOT NULL DEFAULT 0, last_polled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS order_groups_order ON order_groups(order_id)',
  'CREATE INDEX IF NOT EXISTS order_groups_seller ON order_groups(seller_id, status)',
  'CREATE INDEX IF NOT EXISTS order_groups_tracking ON order_groups(tracking_number)',
  'CREATE TABLE IF NOT EXISTS order_lines (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, group_id TEXT NOT NULL REFERENCES order_groups(id) ON DELETE CASCADE, listing_id TEXT NOT NULL, name TEXT NOT NULL, set_code TEXT NOT NULL DEFAULT \'\', number TEXT NOT NULL DEFAULT \'\', image TEXT NOT NULL DEFAULT \'\', condition TEXT NOT NULL, foil INTEGER NOT NULL DEFAULT 0, language TEXT NOT NULL DEFAULT \'English\', qty INTEGER NOT NULL, price_cents INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS order_lines_group ON order_lines(group_id)',
  'CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, source TEXT NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL)',
  'DROP TABLE IF EXISTS prices',
  'DROP TABLE IF EXISTS api_hits',
];

let applied = null;

// Applies STATEMENTS once per Worker instance (in one batch); later calls share the result. A failure is not
// remembered, so the next request tries again.
export function ensureSchema(db) {
  if (!applied) {
    applied = db
      .batch(STATEMENTS.map((sql) => db.prepare(sql)))
      .then(() => undefined)
      .catch((err) => {
        applied = null;
        throw err;
      });
  }
  return applied;
}

// for tests
export function forgetSchema() {
  applied = null;
}
