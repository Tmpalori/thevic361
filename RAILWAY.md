# The Vic 361 — Railway deployment

This guide covers deploying the public **Submit an Event** flow + admin
submission API to Railway. The static GitHub Pages site at `thevic361.com`
keeps serving the public-facing event board untouched — Railway hosts only the
new submission backend (and a copy of the static site, in case you choose to
move DNS later, but that is **not** part of this rollout).

## What gets deployed

The Express server in `server/index.js` does three things:

1. Serves the static site from `docs/` (so Railway can stand alone if needed).
2. Exposes `POST /api/submissions` for the public submit form.
3. Exposes the admin API under `/api/admin/submissions[...]` gated by an
   admin token. The existing `docs/admin.html` UI talks to it.

Public submissions **never** auto-publish. They land in the review queue and
become candidates the editor can pull into the existing Pick events tab and
publish via the GitHub Contents API as today.

## Prerequisites

- Railway account with a project for The Vic 361.
- A Cloudflare account (free) if you want Turnstile bot protection.

## One-time Railway setup

1. **Create a new Railway service** from this repo's `main` branch.
   Railway will auto-detect Node and run `npm start`, which boots
   `server/index.js`.
2. **Add a Postgres plugin** to the project. Railway will auto-inject
   `DATABASE_URL` into the service. The server creates the
   `event_submissions` table on first request — no migration step needed.
3. **Set environment variables** under Service → Variables:

   | Variable | Required | Description |
   |---|---|---|
   | `DATABASE_URL` | recommended | Auto-injected by the Postgres plugin. If unset the server falls back to a JSON file at `data/submissions.json` (fine for dev, **not** durable on Railway because the filesystem is ephemeral). |
   | `ADMIN_TOKEN` | **yes** | A long random string. Required to call admin endpoints. Paste it into the admin tab → "Admin token" field. |
   | `TURNSTILE_SITE_KEY` | optional | Cloudflare Turnstile site key. Sent to the public submit page so the widget renders. |
   | `TURNSTILE_SECRET_KEY` | optional | Cloudflare Turnstile secret. When set, missing/invalid tokens are rejected server-side. |
   | `PORT` | no | Auto-injected by Railway. |

4. **Deploy.** Railway runs `npm install && npm start`. Visit
   `https://<your-railway-domain>/api/health` to confirm; it should return
   `{"ok":true,"storage":"postgres"}`.

## Wire the public site to the API

The public submit page lives at `docs/submit.html`. While the canonical site
is still on GitHub Pages, the form posts to the **same origin** it loads
from. Two options:

- **Option A (recommended for v1)**: Link to the Railway URL from the
  GitHub Pages site. Replace the `Submit an Event` link in
  `docs/index.html` with `https://<your-railway-domain>/submit.html`.
  Users see Railway's URL during submission only; the rest of the site
  stays on `thevic361.com`. **No DNS change needed.**
- **Option B (later)**: Move DNS for `thevic361.com` to Railway and host
  the entire site there. Express already serves `docs/` so this works,
  but it's a separate decision and is **explicitly out of scope** for
  this rollout.

## Wire the admin to the API

1. Open the existing admin (`docs/admin.html`) the same way as today.
2. Click the new **Submissions** tab.
3. Paste the Railway public URL (e.g. `https://thevic361.up.railway.app`)
   into "Submissions API" and your `ADMIN_TOKEN` into "Admin token".
   Click **Save**. Both are stored in `localStorage` only.
4. The Submissions tab now lists pending public submissions. Approve,
   reject, mark duplicate, or edit them in place.
5. Click **Pull approved into picker** to merge approved submissions into
   the candidate list, then publish via the existing GitHub Contents
   flow as you do today.

## Cloudflare Turnstile

1. Cloudflare → Turnstile → Add site. Pick "Managed" challenge.
2. Domain: the Railway domain (and `thevic361.com` if you also embed the
   submit form on the static site).
3. Copy the **site key** into `TURNSTILE_SITE_KEY` and the **secret key**
   into `TURNSTILE_SECRET_KEY`. Restart the Railway service.
4. The submit page loads the widget via `/api/config` and includes the
   token with each submission. Server-side, missing/invalid tokens are
   rejected with a 400.

If you skip Turnstile, the form still ships honeypot + timing checks +
per-IP rate limiting. Turnstile is recommended once you start advertising
the URL publicly.

## Local development

```bash
npm install
npm start  # http://localhost:3000
```

Without `DATABASE_URL`, submissions are written to `data/submissions.json`
under the repo root (gitignored). Without `TURNSTILE_SECRET_KEY`,
verification is bypassed (still honeypot + timing + rate limit). Without
`ADMIN_TOKEN`, admin endpoints return 503 — set
`ADMIN_TOKEN=dev npm start` to enable them locally.

## Tests

```bash
npm test
```

Covers:

- Field validation + sanitization
- Honeypot + timing rejection
- Turnstile gating (success / failure / disabled)
- Duplicate detection
- Admin auth + status transitions
- Approved-events shape
- Source pill rendering + private-field stripping in the admin

## Existing GitHub Actions / collector

Untouched by this rollout. The weekly Sunday collect-and-digest workflow
still runs and still writes `candidates.json` and `docs/events.json` via
GitHub Pages. The submit-an-event flow is **additive**.
