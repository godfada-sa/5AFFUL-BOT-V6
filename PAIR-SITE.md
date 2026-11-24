# Pairing site contract — brief for freebuff

This is what the 5AFFUL V6 bot needs from `https://fiveafful-pair.onrender.com/`
(or any host set with `PAIR_SITE_URL`). The site does the WhatsApp linking; the
bot only downloads the finished login from it. Nothing here is optional.

The old site (RE'd) is useful for the UI flow, but it is **not** the source of
truth: this document is. The old site is being replaced, and the bot must keep
working when its address changes.

---

## 1. The only endpoint the bot calls

```
GET {PAIR_SITE_URL}/api/session/{ID}
```

- No `Authorization` header, no cookie, no API key, no query string.
- No CORS needed: this is server-to-server (Node `fetch`), not a browser call.
- `PAIR_SITE_URL` is read from **config.js** (`pairSiteUrl`) / the env variable
  `PAIR_SITE_URL` / `config.env`. Trailing slashes are stripped by the bot.
- The bot URL-encodes the ID; dashes stay as dashes:
  `TFX-A2BC-D3EF-G4HJ`.

## 2. Session ID format

```
TFX-XXXX-XXXX-XXXX
```

- Uppercase letters and digits only, 12 characters after `TFX-`.
- The alphabet used by the bot is `A-H J-N P-Z 2-9` — i.e. **no `I`, `O`, `0`,
  `1`** (avoids look-alikes). Generate IDs from that set.
- The bot normalises what the user pastes: lowercase, missing dashes and a
  missing `TFX` prefix all still work. The site should normalise the same way
  before lookup, so a hand-typed ID is not a 404.

## 3. Success response

`200` with the **creds object itself** as the JSON body (not wrapped):

```json
{
  "noiseKey": { "...": "..." },
  "signedIdentityKey": { "...": "..." },
  "signedPreKey": { "...": "..." },
  "registrationId": 12345,
  "advSecretKey": "....",
  "me": { "id": "27821234567:12@s.whatsapp.net", "name": "Owner" },
  "platform": "android",
  "registered": true
}
```

- **Minimum the bot accepts:** `me.id`. It sets `registered = true` itself when
  `me.id` exists, then writes the whole object to `session/creds.json`.
- Recommended: return exactly what Baileys wrote to its `creds.json`, so the
  bot's next start needs no repair.
- **Buffers must stay Buffers.** Baileys writes them as
  `{ "type": "Buffer", "data": [1,2,3] }`. Keep that shape; do not convert them
  to base64 strings or hex. `JSON.parse(JSON.stringify(creds))` is safe.
- The body must be JSON. A redirect to an HTML page, `204`, or
  `{"success":true}` without creds is a failure for the bot.

## 4. Status codes and retry behaviour

The bot calls once, then decides (`core/sessionid.js`):

| Site answers | Bot does |
|---|---|
| `200` + valid creds | saves the login, links the number |
| `400` or `404` | treated as "unknown / expired / already used" — **final**, no retry, user is told to link again |
| `202`, `301`, `500`, `503`, timeout | retried — 3 attempts total, 45 s each, 4 s then 8 s pause |
| any `2xx` other than 200 | `res.ok` is true, so it is parsed as creds (avoid this) |

Design consequences:

- **Return 404, not 200 with an error body** for unknown/expired IDs.
- **Do not use 302** to a login page for the API route.
- Do not return `202 Accepted` while pairing is still running. The ID should
  only exist *after* pairing succeeded; the GET must be fast.

## 5. Lifetime and idempotency

- An ID is shown to the user and expires **5 minutes** later.
- Within those 5 minutes, `GET` must be **idempotent**: the same ID returns the
  same creds every time. The bot may legitimately fetch twice (network drop
  after the site sent the body, or a crash before it saved the file).
- After the TTL, return `404` and wipe the creds.
- Do **not** delete on first read. A single lost response would burn a valid ID
  and the user would have to link again.

The bot also keeps a local hash marker (`data/session-id.json`) so it does not
re-download an ID it already used. That is bot-side only — the site must still
enforce its own TTL.

## 6. Concurrency

With two numbers, the bot runs two child processes. At startup **both call the
site at the same time**, with two different IDs:

```
GET /api/session/TFX-AAAA-BBBB-CCCC   (main)
GET /api/session/TFX-DDDD-EEEE-FFFF   (second device)
```

- Handle concurrent reads of different IDs without a global lock.
- The same ID may be read concurrently during a retry. Both responses must be
  identical.
- No relationship between IDs is required. The site does not need to know that
  two IDs belong to the same user, or that "device 2" exists.

## 7. Cold starts (Render free tier)

The free instance sleeps. The first request after sleep can take ~50 s. The bot
already tolerates this: 45 s timeout, 3 tries, 4 s and 8 s back-off.

To make it reliable:

- Keep the `/api/session/:id` handler cheap: map lookup + JSON, no Baileys work
  inside the GET.
- Add `GET /healthz` returning `200` quickly, and ping it from a cron/UptimeRobot
  if you want to reduce cold starts.
- Do pairing work in the background *before* the ID is displayed, not during the
  bot's download.

## 8. What the site does NOT need

- No bot callback, webhook, or "linked" notification.
- No knowledge of accounts, devices, prefixes or the bot's files.
- No re-download endpoint: the bot fetches an ID once and keeps `creds.json`.
- No user accounts or dashboard for the bot. The ID is the only hand-off.
- No number-to-bot registry. Two numbers = two independent IDs.

## 9. How pairing produces an ID (suggested flow)

1. User enters a phone number on the site.
2. Site starts a Baileys socket with a temporary auth state and requests a
   pairing code (`sock.requestPairingCode(number)`), or shows the QR.
3. On `connection.update` with `connection === 'open'`, copy the auth state's
   `creds`, close the socket.
4. Store `{ creds, expires: Date.now() + 5*60*1000 }` under a fresh
   `TFX-XXXX-XXXX-XXXX`.
5. Show the ID to the user. Tell them it expires in 5 minutes and works once.
6. `GET /api/session/:id` serves it until expiry, then 404.

Minimal handler shape:

```js
const express = require('express');
const app = express();
const store = new Map(); // id -> { creds, expires }
const TTL = 5 * 60 * 1000;

app.get('/api/session/:id', (req, res) => {
  const id = canonical(req.params.id);          // uppercase, dashes, TFX prefix
  const row = id && store.get(id);
  if (!row) return res.status(404).json({ error: 'unknown or expired session ID' });
  if (Date.now() > row.expires) {
    store.delete(id);
    return res.status(404).json({ error: 'expired' });
  }
  res.set('Cache-Control', 'no-store');
  return res.json(row.creds);                    // the creds object itself
});
```

## 10. Security

- A session ID is a **bearer secret**: whoever has it can take over that
  WhatsApp session during its 5-minute life. Treat it like a password.
- Never log creds, `advSecretKey`, keys or the full ID in request logs.
- HTTPS only; the bot rejects non-`http(s)` URLs.
- Rate-limit `GET /api/session/:id` (e.g. 10/min/IP) to blunt ID guessing.
- IDs are 12 chars from a 32-symbol alphabet — guessing is already hard, but do
  not make it easier with sequential IDs or short IDs.
- Do not bind an ID to the requester's IP: bots run on panels behind changing
  NAT/proxy addresses.
- Delete the stored creds when the TTL expires, and on process shutdown if you
  can. Do not keep them in a public bucket or in git.

## 11. Acceptance checklist (use this to test the new site)

- [ ] `GET /api/session/TFX-UNKNOWN-0000-0000` returns `404` (not `200`, not `302`).
- [ ] Pair a number, get an ID, `GET` it: `200` + JSON with `me.id`.
- [ ] `GET` the same ID again within 5 min: `200` + byte-identical creds.
- [ ] `GET` it after 5 min: `404`, creds gone.
- [ ] Paste the ID in the bot with `SESSION_ID=`, restart: login restored, no console question.
- [ ] Paste the ID lowercase and without dashes: still `200` (normalisation).
- [ ] Add a second ID in `session_id.txt`: both logins restore, both bots run.
- [ ] Put both IDs in the file and start once: both `GET`s succeed concurrently.
- [ ] Restart the site (cold start), then `GET` a valid ID: bot still succeeds within retries.
- [ ] Response body is JSON, creds are not wrapped and Buffers are
      `{type:"Buffer",data:[...]}`.
- [ ] No creds or full IDs in logs.

## 12. Compatibility note

The bot's side of this contract lives in `core/sessionid.js`:

- request: line 187, `${base}/api/session/${encodeURIComponent(id)}`
- timeout/retries: line 187, `{ timeoutMs: 45000, tries: 3, pauseMs: 4000 }`
- response validation: lines 193–207
- write: `session/creds.json`, previous login moved to `data/session-previous`

If the site matches sections 1–6, it is compatible. Anything else is optional.
