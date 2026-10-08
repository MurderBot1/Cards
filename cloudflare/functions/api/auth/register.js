import {
  checkEmail, checkPassword, checkUsername, createSession, fail, hashPassword, json, now, readJson,
} from '../../../lib/auth.js';

// POST { username, email, password } -> 201 { username, token, expires_at }
export async function onRequestPost({ request, env }) {
  const body = await readJson(request);
  if (!body) return fail('Send a JSON body', 400);

  const username = typeof body.username === 'string' ? body.username.trim() : body.username;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : body.email;
  const problem = checkUsername(username) || checkEmail(email) || checkPassword(body.password);
  if (problem) return fail(problem, 400);

  const usernameLower = username.toLowerCase();
  const taken = await env.DB.prepare('SELECT username_lower, email FROM users WHERE username_lower = ? OR email = ?')
    .bind(usernameLower, email)
    .first();
  if (taken) return fail(taken.username_lower === usernameLower ? 'Username taken' : 'That email is already registered', 409);

  let userId;
  try {
    const result = await env.DB.prepare(
      'INSERT INTO users (username, username_lower, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(username, usernameLower, email, await hashPassword(body.password), now())
      .run();
    userId = result.meta.last_row_id;
  } catch (err) {
    // lost a race with a concurrent sign-up for the same name or email
    if (String(err.message).includes('UNIQUE')) return fail('Username or email is already registered', 409);
    throw err;
  }
  const session = await createSession(env.DB, userId);
  return json({ username, ...session }, 201);
}
