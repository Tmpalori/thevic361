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
6. **Resend webhook.** In Resend → Webhooks, add one endpoint at
   `$SITE/api/email/inbound` and subscribe it to **`email.received`**
   (replies to news@ post to Slack), **`email.bounced`** (a hard bounce
   marks the subscriber bounced) and **`email.complained`** (a spam
   complaint unsubscribes them). Put its signing secret in Railway as
   `RESEND_WEBHOOK_SECRET`. Without the last two events, a dead or
   complaining address stays active: it keeps getting issues and counts in
   referral rewards and sponsors' copies sent. Each town's endpoint acts
   only on events for mail its own domain sent (`isForTown`), so one
   Resend account can serve several towns.
7. **Turnstile** (`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`) is required
   in production: without it every newsletter signup has to confirm by
   email (the signup can't be checked as a person), and the other forms
   rely on honeypot, timing and rate limits only.

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

## New town on Railway

Each town is its own Railway **project**: one service from this repo plus
its own Postgres. It never shares Victoria's database, secrets or accounts.
`scripts/new_town.py` makes the town's files and prints the short version
of this list; this is the full one. Run `scripts/launch_check.py --town
<slug>` at the end: it fails until the town is really collecting.

**Every secret is fresh for the town** (`openssl rand -hex 32` each). Never
copy a value from Victoria's project, or from another town's: a copied
`ADMIN_SESSION_SECRET` or cron secret opens every town that shares it.

1. **Project and database.** New project → deploy from this repo's `main`
   (Railpack runs `npm start`; healthcheck path `/api/health`). Add
   Postgres (Railway injects `DATABASE_URL`) and turn on its backups. On
   first boot the town claims the empty database (`town_meta`); a database
   that already holds another town's data, or Victoria's, stops the boot.
2. **Town identity.**
   - `TOWN=<slug>` (the folder in `towns/`). Forgetting it boots the service
     as Victoria; with any `SITE_URL` that isn't thevic361.com it refuses to
     start and says so.
   - `SITE_URL=https://www.<domain>` (the town's own; Victoria's is refused).
3. **Admin login.** `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`
   (fresh). Don't set `ADMIN_TOKEN` on a new town.
4. **Cron secrets** (fresh, one each, the same value in the town's GitHub
   Environment): `NEWSLETTER_CRON_SECRET`, `EVENT_CHECK_SECRET`,
   `SUBMISSION_REVIEW_SECRET`, `ADS_SPEND_SECRET`.
5. **Email (Resend).** Verify the town's domain in Resend (SPF, DKIM, and MX
   for replies). `RESEND_API_KEY`; `NEWSLETTER_FROM="<Site name>
   <news@<domain>>"` (an address on the town's domain; Victoria's is
   refused); `NEWSLETTER_ADDRESS` (the mailing address the law requires in
   every email); `NEWSLETTER_REPLY_TO` (an inbox you read, or leave it out
   and use receiving instead); receiving: a webhook (event `email.received`)
   to `https://www.<domain>/api/email/inbound` with its secret as
   `RESEND_WEBHOOK_SECRET`.
6. **Stripe: the town's own account** (Stripe → account menu → New
   account; same LLC, EIN and payout bank), with its public business name,
   logo and statement descriptor, so checkout and card statements show the
   town, not The Vic 361. Its keys only: `STRIPE_SECRET_KEY` (a restricted
   key: Checkout Sessions, Products and Prices: write) and
   `STRIPE_WEBHOOK_SECRET` from a webhook endpoint at
   `https://www.<domain>/api/stripe/webhook` (API version as in the admin
   setup checklist) sending these events:
   `checkout.session.completed`, `checkout.session.expired`,
   `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `charge.refunded`,
   `charge.dispute.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`,
   `radar.early_fraud_warning.created`. Check it with a test-mode checkout.
7. **Referral gift cards (Tremendous).** The town's own campaign (its name
   and logo on the reward email): `TREMENDOUS_API_KEY`,
   `TREMENDOUS_CAMPAIGN_ID`, `TREMENDOUS_FUNDING_SOURCE`. Or leave them out
   and send cards by hand from the admin.
8. **Forms (Turnstile).** Add `www.<domain>` to a Turnstile widget (Managed
   mode); `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`. A site key without
   the town's hostname fails every form.
9. **GitHub.** `GITHUB_TOKEN`: a fine-grained token on this repo only, with
   Contents: write and Actions: write and nothing else (publishing the
   town's `events.json` and starting its workflows).
10. **Slack.** `SLACK_WEBHOOK_URL` (and the optional `SLACK_*_WEBHOOK_URL`
    channels, shared with Victoria is fine) and `SLACK_TOWN_TAG` (the city,
    e.g. `Bay City`), so the town's posts read `[Bay City] …`. Set
    `SLACK_TOWN_TAG` in the town's GitHub Environment too (step 12).
11. **HQ.** `HQ_API_KEY` (fresh, different per town). Then on the HQ
    service add the town to `HQ_TOWNS`
    (`{"slug":"<slug>","site_url":"https://www.<domain>","key":"<its HQ_API_KEY>"}`)
    and check its row. HQ lives in Victoria's project on purpose: it holds
    no town data and reads each town through its key.
12. **`TOWN_WORKFLOWS=1` only after** the town's GitHub Environment exists
    (MULTI_CITY_PLAN.md 3.3: its `SITE_URL`, Meta page and Instagram,
    `NTFY_TOPIC`, cron secrets, `SLACK_TOWN_TAG`). Before that the town
    starts no collect, social kit, submission review or event check, since
    they would run on Victoria's repo-level settings. 3.4 (its own
    scheduled collects), 3.5 and 3.7 must be done before launch too.
13. **Optional:** `META_PIXEL_ID` (the town's own pixel); the GA stream is
    `gaId` in `town.json` (a PR).
14. **Domain.** Add `www.<domain>` as a custom domain and CNAME it to the
    Railway target. Make the apex redirect to `www` with the path kept (a
    DNS host's 301 that keeps paths, or the apex on Railway too, where the
    server redirects it). Don't repeat Victoria's Squarespace forwarding,
    which breaks every deep link on the apex.
15. **PR environments.** Decide per town project: turn them off (simplest;
    a PR copy would get production's variables), or keep them and know
    that each copy boots with the town's `TOWN` and its own forked
    database.
16. **Watch paths** (MULTI_CITY_PLAN.md 2.6, by town #3 at the latest):
    the service watches `server/**`, `docs/**`, `package*.json` and
    `towns/<slug>/**`, so other towns' bot commits don't redeploy it.

Then: `python3 scripts/launch_check.py --town <slug>` (every automatic
check passes, including 10+ upcoming events, a collect in the last 8 days
and workflows on), its manual list, and `python3 scripts/live_check.py`
for Victoria before and after.

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
timing and rate limits still apply), and a newsletter signup gets the
confirmation email instead of going straight onto the list. Auto-publish doesn't run on boot
outside production; force a run with
`POST /api/admin/auto-publish`.
