/**
 * session.js
 * The signed-in account on this device: the username and the session token the account service issued. Kept in
 * localStorage so it survives a reload; anything that needs to react to signing in or out listens for the
 * 'binder:session' event (detail: {username, token} or null).
 */
const USER_KEY = 'binder_signed_in_user';
const TOKEN_KEY = 'binder_session_token';

function read(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (e) { /* storage unavailable: the session just won't survive a reload */ }
}

let current = null;
{
  const username = read(USER_KEY);
  const token = read(TOKEN_KEY);
  // signed in under the old, tokenless flow: ask again
  if (username && token) current = { username, token };
}

export function getSession() {
  return current;
}

function announce() {
  window.dispatchEvent(new CustomEvent('binder:session', { detail: current }));
}

export function setSession(username, token) {
  current = { username, token };
  write(USER_KEY, username);
  write(TOKEN_KEY, token);
  announce();
}

export function clearSession() {
  if (!current) return;
  current = null;
  write(USER_KEY, null);
  write(TOKEN_KEY, null);
  announce();
}
