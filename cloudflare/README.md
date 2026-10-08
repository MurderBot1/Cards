# Binder accounts (Cloudflare Pages)

The account service the app signs in against: a few [Pages Functions](https://developers.cloudflare.com/pages/functions/)
backed by a [D1](https://developers.cloudflare.com/d1/) database. Both are on Cloudflare's free tier.

| Endpoint | Body / header | Result |
|---|---|---|
| `POST /api/auth/register` | `{username, email, password}` | `201 {username, token, expires_at}` |
| `POST /api/auth/login` | `{username, password}` | `200 {username, token, expires_at}` |
| `GET /api/auth/me` | `Authorization: Bearer <token>` | `200 {username, expires_at}` or `401` |
| `POST /api/auth/logout` | `Authorization: Bearer <token>` | `200 {ok: true}` |

- Usernames are 3 to 32 characters (letters, digits, `.`, `-`, `_`) and unique ignoring case. Passwords are 8 to 256.
- The email is required to create an account and stored lowercased (unique). **Nothing uses it yet:** no verification, no
  mail is sent. It is there so password reset and similar can be added later.
- Passwords are stored as salted PBKDF2-SHA256 (100,000 iterations, the most Workers allows). A session token is random;
  only its SHA-256 is stored, and sessions last 30 days.
- Sign-in is rate limited: 8 failures per username or 30 per address in 15 minutes locks that name/address out for the rest
  of the window (HTTP 429).
- Requests authenticate with a header, never a cookie, so the API allows any origin (the app calls it from
  `http://127.0.0.1:<port>`).

## One-time setup (Cloudflare dashboard)

1. **Create the database.** Workers & Pages → D1 → *Create database*, name it `binder-accounts`. Open it, go to *Console*,
   paste the contents of [`schema.sql`](schema.sql) and run it.
2. **Create the Pages project.** Workers & Pages → *Create* → *Pages* → *Connect to Git* → pick this repository, then:
   - Production branch: `main`
   - Framework preset: *None*
   - Build command: *(leave empty)*
   - Build output directory: `public`
   - **Root directory (advanced): `cloudflare`**
3. **Bind the database.** Project → Settings → *Bindings* (Functions) → *Add* → *D1 database*: variable name **`DB`**,
   database `binder-accounts`. Add it for Production (and Preview if you use it), then redeploy.
4. **Point the app at it.** Put the project's URL (e.g. `https://binder-accounts.pages.dev`, no trailing slash) in
   [`app/js/config.js`](../app/js/config.js) as `AUTH_URL`, and rebuild the app.

Check it works: `curl -X POST https://<project>.pages.dev/api/auth/register -H 'Content-Type: application/json'
-d '{"username":"test","email":"t@example.com","password":"password123"}'` should answer `201` with a token.

## Local development

```
cd cloudflare
npm install
npm run dev      # applies schema.sql to a local D1, then serves the API on http://localhost:8788
npm test         # unit tests for lib/auth.js
```

To try the app against it, set `AUTH_URL` in `app/js/config.js` to `http://localhost:8788` temporarily.
