# Binder accounts (Cloudflare Worker)

The account service the app signs in against: one [Cloudflare Worker](https://developers.cloudflare.com/workers/) backed
by a [D1](https://developers.cloudflare.com/d1/) database. Both are on Cloudflare's free tier.

| Endpoint | Body / header | Result |
|---|---|---|
| `POST /api/auth/register` | `{username, email, password}` | `201 {username, token, expires_at}` |
| `POST /api/auth/login` | `{username, password}` | `200 {username, token, expires_at}` |
| `GET /api/auth/me` | `Authorization: Bearer <token>` | `200 {username, expires_at}` or `401` |
| `POST /api/auth/logout` | `Authorization: Bearer <token>` | `200 {ok: true}` |
| `POST /api/sync` | `{cursor, collections: [doc], deleted: [{id, at}]}` + token | `200 {cursor, more, collections: [doc]}` |
| `GET /api/share` | token | `200 {shares: [{id, token, url}]}` (the lists this account shares) |
| `POST /api/share` | `{id, renew?}` + token | `200 {id, token, url}`; `404` until the list has been synced |
| `POST /api/share/revoke` | `{id}` + token | `200 {ok: true}` |
| `GET /s/<token>` | none | the read-only page for a shared list (HTML), `404` once revoked |

- Usernames are 3 to 32 characters (letters, digits, `.`, `-`, `_`) and unique ignoring case. Passwords are 8 to 256.
- The email is required to create an account and stored lowercased (unique). **Nothing uses it yet:** no verification, no
  mail is sent. It is there so password reset and similar can be added later.
- Passwords are stored as salted PBKDF2-SHA256 (100,000 iterations, the most Workers allows). A session token is random;
  only its SHA-256 is stored, and sessions last 30 days.
- Sign-in is rate limited: 8 failures per username or 30 per address in 15 minutes locks that name/address out for the rest
  of the window (HTTP 429).
- Requests authenticate with a header, never a cookie, so the API allows any origin (the app calls it from
  `http://127.0.0.1:<port>`).

**Sync** (`src/sync.js`): the app sends the collections that changed on that device; the service merges them with the
account's copy and answers with the merged result plus anything other devices changed since the app's `cursor`. A collection
is a doc `{id, name, updated, cards: [...], tomb: {cardId: ms}}` (or `{id, deleted: ms}` once deleted); every card has
`updated` (the device's clock, in ms). The newest edit of a card wins, and a removal (a `tomb` entry) beats an older copy
of the card, so nothing is resurrected. Two devices adding different cards both keep them; two devices changing the *same*
card at about the same time keep the later change (clock differences between devices can swing that). A deleted collection
stays deleted unless it was edited after the deletion. At most 90 collections per request (the app batches) and about
1.5 MB per collection.

**Share links** (`src/share.js`): a signed-in person can turn one synced list into a public, read-only page at
`/s/<token>`. The token is 32 random URL-safe characters (24 random bytes), stored in the `shares` table next to the
account's copy of the list; the page is built from that copy on every view, so it follows later syncs, shows only the list's
name and cards (never the username or email, and not which deck cards the owner has), and is sent `no-store` with
`noindex`, a locked-down Content-Security-Policy (no scripts; card pictures only from Scryfall, pokemontcg.io and
YGOPRODeck) and no referrer, so revoking or renewing a link takes effect at once. One link per list, at most 100 shared
lists per account; deleting an account or a list removes the page. Anyone holding the link can see the list, so treat it
like a password-less invite.

The service does accounts, collection sync and the share pages, and nothing else. Anything about cards themselves (prices, card data) is
fetched by the app straight from the card sites (`app/js/priceSources.js`) and never passes through here.

Layout: `src/worker.js` (routing, CORS), `src/auth/*.js` (the account endpoints), `src/sync.js`, `src/share.js`,
`src/lib.js` (validation, hashing, sessions, rate limiting), `src/schema.js` + `schema.sql` (the tables), `wrangler.jsonc`. The app itself (`../app`) is served as the website.

## One-time setup (Cloudflare dashboard)

1. **Create the database.** Workers & Pages → D1 → *Create database*, name it `binder-accounts`. That is all: the Worker
   creates its own tables (and any it gains later) the first time it runs after a deploy, from the statements in
   [`src/schema.js`](src/schema.js); there is nothing to paste into the console. [`schema.sql`](schema.sql) is the same
   list in plain SQL (a test keeps the two identical) for reference or for running by hand in the console. It has no
   comments on purpose: a `--` comment swallows the rest of the line if the console flattens a paste, and D1 then reports
   "Requests without any query are not supported". Notes on the columns: `email` is stored lowercased and unused for
   now; `password_hash` is `pbkdf2$<iterations>$<salt b64>$<hash b64>`; `sessions` keeps only a SHA-256 of each token.
   Every statement is idempotent (`IF NOT EXISTS`); the two `DROP TABLE IF EXISTS` lines remove the price-cache tables an
   earlier version used. To change the schema, add statements to the end of both files.
2. **Put the database ID in [`wrangler.jsonc`](wrangler.jsonc)** (`database_id`; it's on the database's page, and it is
   not a secret). This is what binds the database to the Worker as `DB`.
3. **Deploy from this folder.** In the Worker's *Settings → Build* (Workers Builds), set **Root directory** to
   `cloudflare`. The deploy command stays `npx wrangler deploy`. Without the root directory, wrangler looks in the repo
   root, finds no config and fails with "Missing entry-point to Worker script or to assets directory".
4. **Point the app at it.** Put the Worker's URL (e.g. `https://binder.<account>.workers.dev`, no trailing slash) in
   [`app/js/config.js`](../app/js/config.js) as `AUTH_URL`, and rebuild the app.

Check it works: opening `https://<worker>/api/auth/me` should show `{"error":"Not signed in"}`, and
`curl -X POST https://<worker>/api/auth/register -H 'Content-Type: application/json'
-d '{"username":"test","email":"t@example.com","password":"password123"}'` should answer `201` with a token.

## Local development

```
cd cloudflare
npm install
npm run dev      # applies schema.sql to a local D1, then serves the API on http://localhost:8787
npm test         # unit tests for src/lib.js
```

To try the app against it, set `AUTH_URL` in `app/js/config.js` to `http://localhost:8787` temporarily.
