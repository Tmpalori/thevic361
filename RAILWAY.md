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
3. **Set the variables.** At minimum `ADMIN_USERNAME`, `ADMIN_PASSWORD`
   (12+ characters) and `ADMIN_SESSION_SECRET` (32+, `openssl rand -hex 32`;
   the same for a legacy `ADMIN_TOKEN`). Shorter ones still work, but the
   checklist marks them required and production alerts Slack on every boot.
   Then work down the
   admin Home tab's setup checklist, which says what each missing variable
   turns on (Slack, Resend newsletter, Stripe, cron secrets, Turnstile,
   GitHub token). PR and staging environments don't inherit `ADMIN_*`
   automatically; set them per environment or as shared variables.
4. **Cron secrets** (`NEWSLETTER_CRON_SECRET`, `EVENT_CHECK_SECRET`,
   `SUBMISSION_REVIEW_SECRET`) must match between Railway and the GitHub
   secrets of the same name. Give each its own value; see AGENTS.md
   "Security notes".

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

## Backups and data exports

Railway's scheduled Postgres backups (AGENTS.md "Backups") live with the
Postgres service: deleting the service or project, or losing the Railway
account, takes them too. Keep a second copy somewhere else.

- **Subscriber list:** admin → Email tab → "Back up the list, or delete
  someone's data" → **Download subscribers (CSV)** (`GET
  /api/admin/subscribers.csv`: email, status, source and dates). Store the
  file somewhere private (not in this repo).
- **Whole database, encrypted:** from a machine with `pg_dump` and
  [`age`](https://github.com/FiloSottile/age), using the Postgres service's
  public URL (Railway → Postgres → Variables → `DATABASE_PUBLIC_URL`):

  ```bash
  age-keygen -o ~/vic361-backup.key        # once; keep the key OFF the machine that holds the dumps
  pg_dump --no-owner --format=custom "$DATABASE_PUBLIC_URL" \
    | age -r "$(age-keygen -y ~/vic361-backup.key)" > vic361-$(date +%F).dump.age
  # restore: age -d -i ~/vic361-backup.key vic361-YYYY-MM-DD.dump.age | pg_restore --no-owner -d "$TARGET_URL"
  ```

  Put the `.age` file in private storage you control (R2, B2, S3, a
  personal drive). Restore one into a scratch database now and then to know
  it works.
- **Never use GitHub Actions artifacts or the repo for backups.** This repo
  is public: anyone signed in to GitHub can download its workflow
  artifacts, and anything committed is public forever.

Personal data is kept only as long as the privacy page says: a daily job
(`privacy-purge`, `server/privacy.js`) clears the IP address and user agent
on submissions older than 12 months and deletes contact-form messages older
than 24 months. To delete everything about one person on request, use
**Delete their data** in the same admin section (`POST
/api/admin/privacy/forget`): it removes their subscription, contact
messages and the contact details on their submissions, and masks their
address on sponsor orders and gift-card rewards (kept for the books). The
action is logged and posted to Slack with the masked address.

## Operations checklist

Things the code can't do for you. Check them when setting up a town and
again every few months.

- **External uptime monitor.** Set one up (UptimeRobot, Better Stack or
  similar) on `https://www.thevic361.com/api/health?deep=1` every 1 to 5
  minutes, plus a keyword check that `/events.json` contains `"events"`.
  Send it to the Slack alerts webhook and a phone push. The in-process
  checks and `uptime.yml` can't see a dead process or a DNS/TLS break, and
  GitHub's cron runs hours late.
- **Two-factor sign-in** on every account that can change the site or take
  money: GitHub, Railway, Stripe, Resend, Cloudflare, Squarespace (DNS),
  Slack and Meta. Account takeover is the most likely way in.
- **`GITHUB_TOKEN` scope.** Use a fine-grained token on this repo only,
  with an expiry date and a calendar reminder to renew it. It needs
  Actions: write for the scheduler; Contents: write only lets Save &
  Publish commit `docs/events.json`, and also lets anyone holding the token
  push code to `main`, which deploys to production. Drop Contents: write if
  you can live without that commit. Add a ruleset on `main` (no
  force-push, no deletion) and keep PR environments from receiving
  production secrets.
- **Key rotation.** Keep a list of every secret, where it's set (Railway,
  GitHub) and when it was last changed: `GITHUB_TOKEN`, `STRIPE_SECRET_KEY`
  / `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET`,
  `TREMENDOUS_API_KEY`, `OPENAI_API_KEY` / `APIFY_TOKEN` / `GEMINI_API_KEY`,
  the `META_*` tokens, the SMTP app password, `PREVIEWS_DEPLOY_KEY`, the
  three cron secrets, `HQ_API_KEY` and the `ADMIN_*` values. Rotate after
  anyone with access leaves or a secret may have leaked, and at least
  yearly. Changing `ADMIN_PASSWORD` or `ADMIN_SESSION_SECRET` signs every
  admin out (and the session secret also salts the day's visitor counts).
- **Backups.** Railway's daily backups on (7+ days kept), a test restore
  done once, and an encrypted copy off Railway (above).
- **`DATABASE_URL`** references Postgres's private URL
  (`*.railway.internal`), not the public proxy: the app doesn't verify the
  database's TLS certificate.

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
