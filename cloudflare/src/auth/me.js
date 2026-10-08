import { fail, json, sessionUser } from '../lib.js';

// GET (Authorization: Bearer <token>) -> { username, expires_at }, or 401 when the session is missing or expired
export async function onRequestGet({ request, env }) {
  const user = await sessionUser(env.DB, request);
  if (!user) return fail('Not signed in', 401);
  return json({ username: user.username, expires_at: user.expires_at });
}
