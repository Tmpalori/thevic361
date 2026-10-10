# The Vic 361 — Railway setup and smoke tests

The whole site runs on Railway: the Express server in `server/index.js`
serves the public pages, `/events.json`, the submit form, the admin and every
API from one service backed by Railway Postgres. `www.thevic361.com` is a
CNAME to the Railway service (see AGENTS.md "Production hosting").

The environment variable reference lives in **AGENTS.md → Environment
variables** (Railway variables, collector secrets, and GitHub Actions
secrets/variables). This file only covers standing up an environment and
checking it works.

How events go live (details in AGENTS.md): the collector runs Sunday and
Wednesday at 20:23 UTC with `--candidates-only` and commits `candidates.json`
(never `docs/events.json`); that commit redeploys the service, and on boot in
production `server/autopublish.js` publishes the upcoming candidates plus
approved submissions into the `published_events` row. Free public
submissions are reviewed by the AI review (`submission-review.yml`) and the
good ones publish automatically unless `SUBMISSION_AUTOAPPROVE=0`.

## One-time setup

1. **Create a service** from this repo's `main` branch. Railpack
   (`railpack.json`) builds with Node 22 (`.nvmrc` / `engines`), installs
   from `package-lock.json` and runs `npm start`.
2. **Add Postgres.** Railway injects `DATABASE_URL`. The server creates its
   tables on first use; there is no migration step. Without `DATABASE_URL`
   it falls back to a JSON file under `data/`, which is fine locally but not
   durable on Railway.
3. **Set the variables.** At minimum `ADMIN_USERNAME`, `ADMIN_PASSWORD` and
   `ADMIN_SESSION_SECRET` (`openssl rand -hex 32`); then work down the
   admin Home tab's setup checklist, which says what each missing variable
   turns on (Slack, Resend newsletter, Stripe, cron secrets, Turnstile,
   GitHub token). PR and staging environments don't inherit `ADMIN_*`
   automatically; set them per environment or as shared variables.
4. **Cron secrets** (`NEWSLETTER_CRON_SECRET`, `EVENT_CHECK_SECRET`,
   `SUBMISSION_REVIEW_SECRET`) must match between Railway and the GitHub
   secrets of the same name. Give each its own value; see AGENTS.md
   "Security notes".
5. **Stripe** (sponsor checkout; each town has its own Stripe account and
   endpoint). Live restricted key (`rk_live_`) in production as
   `STRIPE_SECRET_KEY`; a test key there shows a Setup checklist warning,
   and with a live key a test-mode payment is never fulfilled. Webhook
   endpoint `<SITE_URL>/api/stripe/webhook` on API version
   `2026-09-30.endive`, its signing secret as `STRIPE_WEBHOOK_SECRET`,
   subscribed to: `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`, `invoice.paid`, `charge.refunded`,
   `charge.dispute.created`, `charge.dispute.closed`,
   `radar.early_fraud_warning.created`. An endpoint made before
   `charge.dispute.closed` and `invoice.paid` were added must add them, or
   a won dispute stays "Disputed" and partner renewals can't be matched.

## Smoke test after a deploy

```bash
SITE=https://www.thevic361.com   # or the environment's Railway domain
# 1. Server is up and on Postgres
curl -sf $SITE/api/health
#   → {"ok":true,"storage":"postgres"}
# 2. Config reports the right flags
curl -s $SITE/api/config
#   → admin_login_enabled:true (github_publish_enabled:true only with GITHUB_TOKEN)
# 3. The published list is there
curl -s $SITE/events.json | jq '.events | length'
```

Use `www` (or the Railway domain), not the bare `thevic361.com`: the apex is
forwarded by Squarespace and its deep links 404.

Then sign in at `$SITE/admin.html`: the Home tab shows the setup checklist,
upcoming events and anything waiting for you.

## Save & Publish and `GITHUB_TOKEN`

`POST /api/admin/publish-events` always writes the `published_events` row,
which the site serves immediately. When `GITHUB_TOKEN` is set it also
commits `docs/events.json` (the bundled fallback) to `main`; a failure there
is reported as a warning and doesn't undo the save. Without the token the
admin still loads candidates from the bundled `candidates.json` plus
approved submissions.

## HQ dashboard (optional, its own service)

`hq/server.js` shows every town on one screen. It is a separate Railway
service in the same project; it never touches a town's database.

1. On each town's service, set `HQ_API_KEY` to a long random string (until
   it's set, that town's `/api/hq/summary` is a 404). Use a different key
   per town.
2. Add a service from this repo with start command `node hq/server.js`, no
   database, and these variables:
   - `HQ_TOWNS`: `[{"slug":"victoria","site_url":"https://www.thevic361.com","key":"<Victoria's HQ_API_KEY>"}]`
     (one entry per town)
   - `HQ_USERNAME`, `HQ_PASSWORD` (12+ characters)
   - `HQ_SESSION_SECRET` (32+ random characters)
3. Give it a domain. It refuses to start and logs why when a variable is
   missing or wrong. `/health` answers `{"ok":true}`.

Each row links to that town's admin, which still asks for its own login.

PR environments copy the hq service (with production's variables) when a PR
changes HQ's code. Outside `production` it starts in preview mode: `/health`
answers, the login is off and no town is asked.

## Local development

```bash
npm ci
ADMIN_USERNAME=admin ADMIN_PASSWORD=<pick one> \
ADMIN_SESSION_SECRET=$(openssl rand -hex 32) npm start   # http://localhost:3000
```

Without `TURNSTILE_SECRET_KEY`, form verification is skipped (honeypot,
timing and rate limits still apply). Auto-publish doesn't run on boot
outside production; force a run with
`POST /api/admin/auto-publish`.
