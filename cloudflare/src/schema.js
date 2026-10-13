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
