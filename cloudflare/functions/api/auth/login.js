import {
  checkUsername, clearFailures, clientIp, createSession, fail, json, readJson, recordFailure, spendPasswordTime,
  tooManyFailures, verifyPassword,
} from '../../../lib/auth.js';

// POST { username, password } -> 200 { username, token, expires_at }
export async function onRequestPost({ request, env }) {
  const body = await readJson(request);
  if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') {
    return fail('Enter your username and password', 400);
  }
  const username = body.username.trim();
  if (checkUsername(username) || body.password.length > 256) return fail('Invalid username or password', 401);

  const usernameLower = username.toLowerCase();
  const ip = clientIp(request);
  if (await tooManyFailures(env.DB, usernameLower, ip)) {
    return fail('Too many failed attempts. Try again in a few minutes.', 429, { 'Retry-After': '900' });
  }

  const user = await env.DB.prepare('SELECT id, username, password_hash FROM users WHERE username_lower = ?')
    .bind(usernameLower)
    .first();
  let ok = false;
  if (user) ok = await verifyPassword(body.password, user.password_hash);
  else await spendPasswordTime(body.password);

  if (!ok) {
    await recordFailure(env.DB, usernameLower, ip);
    return fail('Invalid username or password', 401);
  }
  await clearFailures(env.DB, usernameLower);
  return json({ username: user.username, ...(await createSession(env.DB, user.id)) });
}
