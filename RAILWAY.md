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
   | `ADMIN_USERNAME` | **yes** | Username for the admin login page. |
   | `ADMIN_PASSWORD` | **yes** | Password for the admin login page. Use a long, unique value. |
   | `ADMIN_SESSION_SECRET` | **yes** | HMAC key used to sign session tokens. Generate with `openssl rand -hex 32`. Rotating this value forces every signed-in admin to log in again. |
   | `ADMIN_SESSION_TTL_HOURS` | optional | Session lifetime in hours. Default `12`. |
   | `GITHUB_TOKEN` (or `GITHUB_PAT`) | **optional** | Only required if you also want **Save & Publish** to commit `docs/events.json` back to GitHub. Without it, the admin still loads candidates (from the bundled `candidates.json` plus approved submissions) and **Save & Publish** still works — it stores the published payload in Railway's Postgres and the public site at the Railway domain serves it from there. Set this only when you want a parallel commit to `Tmpalori/thevic361`. |
   | `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BRANCH` | optional | Override the default `Tmpalori` / `thevic361` / `main` target. |
   | `ADMIN_TOKEN` | optional | Legacy single-token admin auth, kept as a fallback. If you set the three login variables above you do **not** need this. |
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

## Admin login

The admin UI now signs in via a username / password form instead of a
GitHub PAT.

1. Visit `https://<your-railway-domain>/admin.html` (the Express server
   serves the static admin from `docs/`).
2. Enter `ADMIN_USERNAME` + `ADMIN_PASSWORD`. The server returns a signed
   session token (HMAC over `{sub, iat, exp}` with `ADMIN_SESSION_SECRET`)
   and the browser stores it in `localStorage` as
   `vic361_admin_session`. Tokens expire after `ADMIN_SESSION_TTL_HOURS`
   hours (default 12). Login attempts are rate-limited to 10 per IP per
   15 minutes.
3. Once signed in, every admin call — picker candidates, publishing
   events, listing submissions, status transitions — uses the server
   session token. No GitHub PAT is ever held in the browser when
   `GITHUB_TOKEN` is configured.
4. The **Submissions** tab uses the same session, so you no longer need
   to paste an `ADMIN_TOKEN` into the tab. The legacy override panel
   ("Override API / token…") is still available for pointing the admin
   at a different backend or for using the old `ADMIN_TOKEN` env var.
5. Click **Pull approved into picker** to merge approved submissions
   into the candidate list, then click **Save & Publish** to publish via
   the new server-side `POST /api/admin/publish-events` endpoint.

### Smoke test (5 minutes after a deploy)

```bash
# 1. Server is up
curl -sf https://<your-railway-domain>/api/health
# 2. Config reports the right flags
curl -s https://<your-railway-domain>/api/config
#   → expect admin_login_enabled:true, github_publish_enabled:true
# 3. Login works
curl -s -X POST https://<your-railway-domain>/api/admin/login \
  -H 'content-type: application/json' \
  -d '{"username":"<ADMIN_USERNAME>","password":"<ADMIN_PASSWORD>"}'
#   → { ok:true, token:"...", expires_at:"..." }
# 4. Token unlocks admin endpoints
TOKEN=<token-from-step-3>
curl -s -H "Authorization: Bearer $TOKEN" \
  https://<your-railway-domain>/api/admin/me
#   → { ok:true, kind:"session", sub:"<ADMIN_USERNAME>" }
```

Then sign in via the browser at `/admin.html`, click **Reload candidates**,
pick a couple of events, and hit **Save & Publish**. With `GITHUB_TOKEN`
set, you should see "Published to Railway and GitHub" and a new commit on
`main`. Without it, you'll see "Saved to Railway. GitHub token not
configured…" and the Railway public events feed updates immediately.

### What loads candidates when `GITHUB_TOKEN` is missing

The admin **Pick events** tab works without a GitHub token:

- The server first tries the GitHub Contents API. If `GITHUB_TOKEN` is unset
  *or* the API returns an auth error, it falls back to reading the
  `candidates.json` file bundled with the deploy.
- Approved submissions from the review queue (`event_submissions` table or
  `data/submissions.json` fallback) are merged into the candidate list
  automatically — you no longer need to click **Pull approved into picker**
  to see them.
- The admin UI surfaces a banner like "Note: github-fetch-failed-401 —
  showing bundled candidates instead." so you can tell the difference at a
  glance.

### Save & Publish without GitHub

`POST /api/admin/publish-events` now does two things:

1. **Always** writes the published payload to the local store (Postgres
   `published_events` row when `DATABASE_URL` is set, otherwise the JSON
   file). Express serves `/events.json` from this store, so the public site
   at the Railway domain reflects the publish immediately.
2. **If `GITHUB_TOKEN` is configured**, additionally commits
   `docs/events.json` on `main` via the Contents API. A failure here is
   surfaced as a warning (`destinations.github.error`) but does **not** roll
   back the local save — you can fix the token and re-publish to push the
   GitHub copy back into sync.

### Legacy GitHub PAT fallback

The "Use PAT instead" form is only shown when server login is not
configured at all (no `ADMIN_USERNAME` / `ADMIN_PASSWORD` /
`ADMIN_SESSION_SECRET`). With login configured the server handles
candidates and publishing; the browser never holds a PAT.

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
verification is bypassed (still honeypot + timing + rate limit).

For local admin testing, set:

```bash
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD=hunter2
export ADMIN_SESSION_SECRET=$(openssl rand -hex 32)
# Optional: also enable server-side publishing
export GITHUB_TOKEN=ghp_...   # contents:write on Tmpalori/thevic361
npm start
```

Without these vars, admin endpoints return 503. The legacy `ADMIN_TOKEN`
env var is also still accepted as an alternative for scripts.

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
- Candidates load with no `GITHUB_TOKEN` (local-file fallback) and on a
  GitHub 401 (token-rejected fallback)
- `Save & Publish` works without `GITHUB_TOKEN` (local-only) and stays in
  sync with GitHub when both are configured

## Existing GitHub Actions / collector

Untouched by this rollout. The weekly Sunday collect-and-digest workflow
still runs and still writes `candidates.json` and `docs/events.json` via
GitHub Pages. The submit-an-event flow is **additive**.
