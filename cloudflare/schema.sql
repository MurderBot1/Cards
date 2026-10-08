-- Binder accounts. Apply with:  wrangler d1 execute binder-accounts --remote --file=schema.sql
-- (safe to run again: every statement is IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL,            -- as typed, for display
  username_lower TEXT NOT NULL UNIQUE,     -- what uniqueness and sign-in compare
  email          TEXT NOT NULL UNIQUE,     -- stored lowercased; collected now, not used yet (no verification, no mail sent)
  password_hash  TEXT NOT NULL,            -- pbkdf2$<iterations>$<salt b64>$<hash b64>
  created_at     INTEGER NOT NULL          -- unix seconds
);

-- Only a SHA-256 of the session token is stored, so a leaked database can't be used to sign in.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Failed sign-ins, for rate limiting (see lib/auth.js).
CREATE TABLE IF NOT EXISTS login_failures (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username_lower TEXT NOT NULL,
  ip             TEXT NOT NULL,
  at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_failures_lookup ON login_failures(username_lower, at);
CREATE INDEX IF NOT EXISTS login_failures_ip ON login_failures(ip, at);
