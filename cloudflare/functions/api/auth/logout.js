import { bearerToken, deleteSession, json } from '../../../lib/auth.js';

// POST (Authorization: Bearer <token>) -> { ok: true }; ends that session. Always succeeds, so signing out twice is harmless.
export async function onRequestPost({ request, env }) {
  const token = bearerToken(request);
  if (token) await deleteSession(env.DB, token);
  return json({ ok: true });
}
