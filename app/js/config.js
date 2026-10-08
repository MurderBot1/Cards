/**
 * config.js
 * Where the account service lives: the Cloudflare Worker from /cloudflare (see cloudflare/README.md), e.g.
 * 'https://binder.trentcridland.workers.dev'. No trailing slash. If this is empty, signing in and creating an account
 * say the service isn't set up yet; everything else in the app works without it.
 */
export const AUTH_URL = 'https://binder.trentcridland.workers.dev';
