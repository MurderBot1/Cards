// Shared by the /api/auth functions: input validation, password hashing, sessions and rate limiting.

export const PBKDF2_ITERATIONS = 100000; // the most Workers' WebCrypto allows
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const FAILURE_WINDOW_SECONDS = 15 * 60;
const MAX_FAILURES_PER_USERNAME = 8;
const MAX_FAILURES_PER_IP = 30;

const encoder = new TextEncoder();

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}
export const fail = (message, status, extra = {}) => json({ error: message }, status, extra);

export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

// ---- validation ------------------------------------------------------------------------------

// Returns an error message, or null when acceptable.
export function checkUsername(username) {
  if (typeof username !== 'string') return 'Enter a username';
  if (username.length < 3 || username.length > 32) return 'Username must be 3 to 32 characters';
  if (!/^[A-Za-z0-9_.-]+$/.test(username)) return 'Username can only use letters, numbers, dots, dashes and underscores';
  return null;
}
export function checkEmail(email) {
  if (typeof email !== 'string' || email.length === 0) return 'Enter an email address';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email address';
  return null;
}
export function checkPassword(password) {
  if (typeof password !== 'string' || password.length === 0) return 'Enter a password';
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 256) return 'Password is too long';
  return null;
}

// ---- passwords -------------------------------------------------------------------------------

const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password, stored) {
  const [scheme, iterations, salt, hash] = String(stored).split('$');
  if (scheme !== 'pbkdf2') return false;
  const derived = await pbkdf2(password, fromB64(salt), Number(iterations));
  return equalBytes(derived, fromB64(hash));
}

// Burns the same time as a real check, so "no such user" isn't distinguishable by how long the reply takes.
const DUMMY_HASH = `pbkdf2$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;
export async function spendPasswordTime(password) {
  await verifyPassword(password, DUMMY_HASH);
}

// ---- sessions --------------------------------------------------------------------------------

const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

export const now = () => Math.floor(Date.now() / 1000);

export async function createSession(db, userId) {
  const token = toB64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const created = now();
  const expires = created + SESSION_SECONDS;
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, created, expires)
    .run();
  // tidy up this user's expired sessions while we're here
  await db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(userId, created).run();
  return { token, expires_at: expires };
}

export function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(header);
  return match ? match[1] : null;
}

// The signed-in user for this request's bearer token, or null.
export async function sessionUser(db, request) {
  const token = bearerToken(request);
  if (!token) return null;
  const row = await db
    .prepare(
      'SELECT users.id AS id, users.username AS username, sessions.expires_at AS expires_at ' +
        'FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?'
    )
    .bind(await sha256Hex(token), now())
    .first();
  return row || null;
}

export async function deleteSession(db, token) {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

// ---- rate limiting ---------------------------------------------------------------------------

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

// True when this username or this address has failed too often recently.
export async function tooManyFailures(db, usernameLower, ip) {
  const since = now() - FAILURE_WINDOW_SECONDS;
  const byUser = await db
    .prepare('SELECT COUNT(*) AS n FROM login_failures WHERE username_lower = ? AND at > ?')
    .bind(usernameLower, since)
    .first();
  const byIp = await db.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND at > ?').bind(ip, since).first();
  return byUser.n >= MAX_FAILURES_PER_USERNAME || byIp.n >= MAX_FAILURES_PER_IP;
}

export async function recordFailure(db, usernameLower, ip) {
  const at = now();
  await db.prepare('INSERT INTO login_failures (username_lower, ip, at) VALUES (?, ?, ?)').bind(usernameLower, ip, at).run();
  await db.prepare('DELETE FROM login_failures WHERE at < ?').bind(at - FAILURE_WINDOW_SECONDS).run();
}

export async function clearFailures(db, usernameLower) {
  await db.prepare('DELETE FROM login_failures WHERE username_lower = ?').bind(usernameLower).run();
}
