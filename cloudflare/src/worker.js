// The account service's entry point: routes /api/* to the handlers, serves the public share pages (/s/<token>), adds CORS, and turns an unexpected
// error into a JSON 500. Anything else is served from ./public (see wrangler.jsonc).
import { CORS, withCors } from './cors.js';
import { fail } from './lib.js';
import { onRequestPost as login } from './auth/login.js';
import { onRequestPost as logout } from './auth/logout.js';
import { onRequestGet as me } from './auth/me.js';
import { onRequestPost as register } from './auth/register.js';
import { ensureSchema } from './schema.js';
import { onSharePage, onShareCreate, onShareList, onShareRevoke } from './share.js';
import { onSync } from './sync.js';

const ROUTES = {
  'POST /api/auth/register': register,
  'POST /api/auth/login': login,
  'GET /api/auth/me': me,
  'POST /api/auth/logout': logout,
  'POST /api/sync': onSync,
  'GET /api/share': onShareList,
  'POST /api/share': onShareCreate,
  'POST /api/share/revoke': onShareRevoke,
};
const PATHS = new Set(Object.keys(ROUTES).map((key) => key.split(' ')[1]));

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname.startsWith('/s/')) {
      try {
        await ensureSchema(env.DB);
        return await onSharePage({ env, token: pathname.slice(3) });
      } catch (err) {
        console.error(err);
        return fail('Something went wrong on the server', 500);
      }
    }
    if (!pathname.startsWith('/api/')) return fail('Not found', 404);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const handler = ROUTES[`${request.method} ${pathname}`];
    if (!handler) return withCors(PATHS.has(pathname) ? fail('Method not allowed', 405) : fail('Not found', 404));
    try {
      await ensureSchema(env.DB);  // creates any missing tables the first time this instance runs
      return withCors(await handler({ request, env }));
    } catch (err) {
      console.error(err);
      return withCors(fail('Something went wrong on the server', 500));
    }
  },
};
