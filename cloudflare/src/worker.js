// The account service's entry point: routes /api/auth/* to the handlers, adds CORS, and turns an unexpected
// error into a JSON 500. Anything else is served from ./public (see wrangler.jsonc).
import { CORS, withCors } from './cors.js';
import { fail } from './lib.js';
import { onRequestPost as login } from './auth/login.js';
import { onRequestPost as logout } from './auth/logout.js';
import { onRequestGet as me } from './auth/me.js';
import { onRequestPost as register } from './auth/register.js';

const ROUTES = {
  'POST /api/auth/register': register,
  'POST /api/auth/login': login,
  'GET /api/auth/me': me,
  'POST /api/auth/logout': logout,
};
const PATHS = new Set(Object.keys(ROUTES).map((key) => key.split(' ')[1]));

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith('/api/')) return fail('Not found', 404);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const handler = ROUTES[`${request.method} ${pathname}`];
    if (!handler) return withCors(PATHS.has(pathname) ? fail('Method not allowed', 405) : fail('Not found', 404));
    try {
      return withCors(await handler({ request, env }));
    } catch (err) {
      console.error(err);
      return withCors(fail('Something went wrong on the server', 500));
    }
  },
};
