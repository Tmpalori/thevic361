# Agent Instructions — The Vic 361

Read this file first if you are a coding agent (Codex, Claude Code, Cursor, etc.) about to make a change to this repo. It tells you how the system works, what you are and aren't allowed to touch, how to run the tests, and which invariants matter.

The companion files `CLAUDE.md` and `.cursorrules` redirect to this document so every agent flavor lands on the same source of truth.

---

## What this is

**The Vic 361** is a weekly community-events website for Victoria, TX (population ~65k). It collects events from public calendars and Apify-scraped Facebook/Instagram (OpenAI extracts events from posts and polishes descriptions); an admin curates the candidate list each Sunday; the curated list is served from Railway Postgres at [thevic361.com](https://thevic361.com).

- **Live site:** [thevic361.com](https://thevic361.com) — Railway (Express + Postgres)
- **Repo:** `Tmpalori/thevic361` (this repo)
- **Owner:** Tristen Palori ([tristen.m.palori@gmail.com](mailto:tristen.m.palori@gmail.com))

Production hosting:

- Apex `thevic361.com` is an A record to `151.101.2.15` (Railway/Fastly edge).
- `www.thevic361.com` is a CNAME to `oln7ktx9.up.railway.app`.
- DNS is managed in Squarespace.
- Railway environments: `production`, `staging`, and PR-environments (auto-created per open PR, auto-destroyed on PR close). Each has its own forked Postgres.

---

## Architecture in one diagram

```
┌────────────────────────────────────────────────────────────────────┐
│  Sunday 23:00 UTC — .github/workflows/weekly-collect.yml           │
│                                                                    │
│   collect_events.py  ──>  candidates.json (every raw event)        │
│   --candidates-only       collection_metadata.json (per-source)    │
│                           docs/events.json   ❌ NOT WRITTEN here    │
└────────────────────────────────────────────────────────────────────┘
                                 │
                                 │ Sunday 02:00 UTC Mon — weekly-digest.yml
                                 │ → email Tristen the candidate summary
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  Sunday ~22:00 Central — Tristen at thevic361.com/admin.html       │
│                                                                    │
│   Login (ADMIN_USERNAME / ADMIN_PASSWORD) → Candidates tab         │
│   Auto-publish on deploy, or Pick events → Save & Publish          │
│                                                                    │
│   Server writes published_events row in Railway Postgres (live).   │
│   If GITHUB_TOKEN is set, also commits docs/events.json to repo.   │
└────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  Monday — newsletter sends (Resend; newsletter.yml).               │
│  Public site renders Postgres-backed /events.json continuously.    │
└────────────────────────────────────────────────────────────────────┘
```

---

## Source of truth — read this twice

| Layer | Role |
|---|---|
| **Railway Postgres `published_events.id=1`** | The **live** curated source. Written by admin **Save & Publish** only. The Express app serves `/events.json` from here. |
| **`docs/events.json`** | A **curated bundled fallback**, not authoritative. Only the admin Save & Publish flow may write it (and only when `GITHUB_TOKEN` is configured). The weekly collector workflow runs with `--candidates-only` and **must not** overwrite this file. |
| **`candidates.json`** | The full raw collector output for the admin to screen each Sunday. Auto-committed by the weekly workflow. Safe to overwrite. |

Test `test_collect_events_safety.py` pins the `--candidates-only` invariant. **Do not break it.**

---

## File layout

```
thevic361/
├── AGENTS.md                     ← you are here
├── CLAUDE.md, .cursorrules       ← thin pointers to AGENTS.md
├── README.md, RAILWAY.md, SETUP_GUIDE.md, TRISTEN_WEEKLY_SOP.md, ADMIN_ROADMAP.md
│
├── collect_events.py             # 3.3k LOC monolith — orchestrator + every scraper
├── send_digest.py                # Sunday-night candidate-summary email
├── discover_venues.py            # OPT-IN ONLY — Google Maps venue discovery, NOT in CI
├── approve_events.py             # LEGACY — decommissioned reply-to-email publisher
│
├── server/                       # Express backend (flat, no routes/ subdir)
│   ├── index.js                  # createApp factory + 18 routes
│   ├── auth.js                   # username/password login + HMAC session tokens
│   ├── db.js                     # FileStore + PgStore + factory; inline schema
│   ├── github.js                 # GitHub Contents API + workflow_dispatch
│   ├── rateLimit.js              # in-memory sliding-window limiter
│   ├── analytics.js              # first-party visitor stats for the admin Traffic tab
│   ├── metaPixel.js              # /pixel.js — Meta Pixel for ads, off until META_PIXEL_ID is set
│   ├── seo.js                    # server-rendered pages: home, intent pages, /events/:slug, /about, sitemap.xml, llms.txt
│   ├── sources.js                # /api/admin/sources payload builder
│   ├── turnstile.js              # Cloudflare Turnstile verify
│   └── validate.js               # submission validation + bot signals
│
├── docs/                         # Static site root (Express serves from here)
│   ├── index.html, app.js, base.css, style.css   # public site
│   ├── admin.html, admin.js, admin-submissions.js, admin.css   # admin UI
│   ├── submit.html, submit.js, submit.css        # public submission form
│   ├── events.json               # CURATED FALLBACK — see source-of-truth note above
│   ├── og-image.png, favicon.svg, robots.txt   # sitemap.xml + llms.txt are served by server/seo.js
│
├── tests/                        # vitest (server + admin/submit pages)
│   ├── admin.test.js, admin_login.test.js, admin_submissions.test.js
│   ├── app_preview.test.js, candidates_fallback.test.js
│   ├── publish_preserves_extras.test.js, published_events.test.js
│   ├── seo.test.js, sources.test.js, submissions_api.test.js, submit_form.test.js
│
├── test_*.py                     # pytest, currently AT REPO ROOT (not /tests/python/)
│   ├── test_ai_review.py
│   ├── test_collect_events_safety.py    # ⚠️  PINS the --candidates-only invariant
│   ├── test_discover_venues.py
│   ├── test_fb_posts.py, test_ig_posts.py
│   ├── test_library_cap.py, test_quality.py, test_venues_seed.py
│
├── .github/workflows/
│   ├── weekly-collect.yml        # Sun 23:00 UTC — collector → candidates.json
│   ├── weekly-digest.yml         # Mon 02:00 UTC — digest email to Tristen
│   ├── pr-preview.yml            # static PR previews via sibling repo
│   └── staging-deploy.yml        # static staging deploy via sibling repo
│
├── venues.json                   # 47 manually-curated venues with tier (HIGH/MEDIUM/LOW)
├── local_events.yaml             # backbone: recurring + one-off curated events
├── extras.yaml                   # New & Notable + sponsor block
├── candidates.json               # weekly raw output (committed by CI)
├── collection_metadata.json      # per-source stats (committed by CI; admin reads it)
├── facebook_venues.json          # legacy one-cycle fallback
├── facebook_venues.backup.json   # currently byte-identical to facebook_venues.json
├── pending_venues.json           # legacy holding file ({}); discovery decommissioned
│
├── package.json, vitest.config.js
├── requirements.txt, requirements-dev.txt
├── railpack.json                 # Railpack build config (forces Node start command)
└── .gitignore                    # __pycache__, .env, node_modules, data/, etc.
```

---

## Run, test, lint

### Node (server + frontend)

```bash
npm install
npm start          # node server/index.js — listens on $PORT or 3000
npm run dev        # alias to start (no nodemon configured)
npm test           # vitest run — runs every tests/*.test.js
```

### Python (collector + digest)

```bash
pip install -r requirements.txt
pip install -r requirements-dev.txt   # adds pytest

# Run the collector locally (writes candidates.json + ./events.json):
python collect_events.py --output ./docs/events.json --local-dir .

# CI-safe mode (does NOT touch docs/events.json):
python collect_events.py --candidates-only --output ./docs/events.json --local-dir .

# Run the test suite (tests live AT THE REPO ROOT, not under tests/):
pytest -q
```

`.github/workflows/tests.yml` runs both suites on every PR and on pushes to `main`. Run them locally before opening a PR too.

There is no linter configured. Match the existing style (4-space Python, 2-space JS, ES modules in `server/` and `tests/`).

---

## Collector quality

`merge_events` in `collect_events.py` is the single quality gate: it drops scraped events outside Victoria County (`out_of_area_reason`; local YAML is trusted), moves street addresses out of the venue field (`clean_venue`), and fuzzy-dedupes per day (`is_same_event`), keeping the record from the higher-ranked source in `SOURCE_RANK` and filling gaps from the other. `safe_fetch` tags every event with `_source`, which the admin shows as a pill. Tests: `test_quality.py`.

## SEO / AI search

Crawlers like GPTBot and ClaudeBot don't run JavaScript, so `server/seo.js` renders events into plain HTML from the same published payload as `/events.json`: the homepage (injected into `docs/index.html`), intent pages (`/today`, `/this-weekend`, `/free-things-to-do`, `/kids-and-family`, `/live-music`, `/food-and-drink`), one page per event at `/events/<date>-<slug>` with schema.org `Event` JSON-LD, `/about`, `/sitemap.xml`, and `/llms.txt`. `docs/app.js` still re-renders the homepage in the browser and powers admin preview. Keep the two event renderers' markup in sync. Every published event is also written to an archive (`event_archive` table / `event_archive` key in the file store) so its page keeps working after the week rotates out. `featured: true` (set from the admin edit modal) pins an event to the top of its day; `/advertise` sells it. `/llms.txt` lists the week's sponsor and the Vic's Picks in their own sections, labeled as paid, so AI answers drawn from it carry them too.

## Venues, guides, social kit

`server/guides.js` generates `/venues` + `/venues/<slug>` from `venues.json` (organizer accounts skipped) and the live + archived events, seasonal guides (`SEASONS`: holidays and festivals in calendar order, from Crawfish season and Valentine's Day through Oktoberfest and New Year's Eve; seasonal only, year-round draws like car shows don't belong here) that appear in the nav, sitemap and `llms.txt` only while they have an upcoming matching event (an event counts only when its date falls in the guide's `months`; with nothing upcoming the page still loads for old links but is noindexed), and `/events/<slug>.ics`. Event pages carry calendar and share buttons; the homepage has client-side filter chips (`docs/app.js`). `scripts/social_kit.py` runs every morning (each post is a teaser, not the whole list: at most three branded slides — cover with three highlights, a day-by-day peek with two events per day and "+ N more", and a see-all/subscribe slide — and captions with two events per day, Vic's Picks/sponsored first and marked ⭐, then "+ N more" and the link; `scripts/social_slides.py` lays slides out as HTML in Fredoka/Nunito with the day colors, icons, logo and skyline and screenshots them with headless Chrome in one run, falling back to plain Pillow slides if Chrome is missing or fails) (`social-kit.yml`, also on changes to the generator) and commits slides, captions and `kit.json` to `docs/social/latest/`: Monday rebuilds the week, weekend and today kits, Thursday the weekend (plus `weekend.mp4`, a vertical Reel made with ffmpeg) and today, other days only today. Instagram captions @mention venues that have a handle in `venues.json`, and Monday's run sends Slack `outreach.txt` (this week's venues with their event links, to send them for a reshare) (open `/social/latest/`, linked from the admin header). `scripts/social_post.py` then posts the kit to the Facebook Page and Instagram when the `SOCIAL_AUTOPOST` repo variable is `1` and the `META_PAGE_ID` / `META_PAGE_TOKEN` (+ `IG_USER_ID`) secrets are set: Monday posts the week, Thursday the weekend (as a Reel on Instagram when `weekend.mp4` exists), other days today. `kit.json` carries a per-run `build` id the poster waits for (so it never posts an earlier same-day kit), and `posted.json` records what went out per day and kind so re-running a half-failed job skips the platform that already posted.

## Traffic stats

`server/analytics.js` powers the admin **Traffic** tab. People are counted from a `docs/track.js` beacon (`POST /api/track`: page views and sponsor/event/subscribe clicks; skipped in a browser signed into the admin). A page view is sent only once the visitor engages (scroll, tap, click or key) or the page has been visible for 5 seconds, so JS-running bots and instant bounces aren't counted; counts dropped when this started on 2026-10-05. search and AI crawlers are counted server-side by user agent (HTML pages plus `/events.json` and `/llms.txt`). AI bots are tagged `ask` (an assistant fetched the page to answer someone, e.g. ChatGPT-User), `search` or `training`; the summary's `ai` block reports people sent by AI referrers (or `utm_source`, which ChatGPT adds when there's no referrer) and those three counts. Rows go to the `traffic` table (Postgres, ~400 days kept) with a daily salted visitor hash and no IPs or cookies. `GET /api/admin/traffic?days=N` returns the summary.

**Meta ads.** Pages reached from links carrying a subscriber token (`/subscribe/confirm`, `/unsubscribe`) render with `layout({ pixel: false })`, and the pixel script itself skips any URL with `token=`: the pixel reports full URLs to Meta. `/privacy` (`renderPrivacyPage`, linked from every footer) discloses the pixel, Google Analytics and our own stats, as Meta's terms require. `/pixel.js` (`server/metaPixel.js`) loads the Meta Pixel on public pages when `META_PIXEL_ID` is set and is an empty script otherwise; it skips the same admin/preview/social-kit visits as `track.js`. It reports `PageView`, and `track.js` reports `Lead` when a newsletter signup succeeds. Ad links should end in `?utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.name}}`: a tap on an ad has the same facebook.com/instagram.com referrer as a free post, so `utm_medium=paid` is what puts it under **Meta ads** in the Traffic tab (`paidSource` in `server/analytics.js`; other paid sources show as **Other ads**).

## Newsletter

`server/newsletter.js`: double opt-in signup (`POST /api/subscribe` → confirmation email → `/subscribe/confirm`), unsubscribe (`GET` shows a button, `POST /unsubscribe` also serves RFC 8058 one-click), the weekly issue rendered from the published events, and Resend batch sends with one send per week (`newsletter_sends`). Admin Newsletter tab: status, preview, test send, send, import. Subscribers live in the `subscribers` table. `GET /subscribe` is the signup page every Subscribe button (header, footers, page CTAs) points at, and where ads should land: the pitch, the form, and the next seven days of events as proof; the subscriber count shows only from 100. Each form sends a `source` (`footer`, `list-card`, `subscribe-page`; `signupSource` whitelists them), with `:ad` added when the visit began from a `utm_medium=paid` link (`docs/track.js` remembers it for the session); it's stored on the subscriber and shown in the Slack ping. The weekly email's footer invites forwarded readers to `/subscribe`. `/api/subscribe` answers `new: true` only for a first signup or a comeback (not "already on the list", a pending re-submit, or the honeypot); the forms report `subscribe_click` (and the Meta Pixel `Lead`) only then. A comeback's `source` is updated to where they came back from.

## Sponsor checkout

`server/sponsors.js`: `/advertise` → `/advertise/checkout?package=weekly|featured` (one form) → Stripe Checkout → `POST /api/stripe/webhook` (signature-verified over the raw body, so it's registered before `express.json`). Weekly sponsor books one Mon–Sun week (held 35 min while someone pays) and replaces the sponsor slot; venue partner (a monthly subscription that featured every event at a venue) is no longer sold, but subscriptions bought earlier keep featuring their venue until cancelled in Stripe; featured event (Vic’s Pick: $49 Mon–Thu, $89 Fri–Sun via `pickPackage`, its own Stripe catalog price; capped per day at 3 Mon–Thu and 4 Fri–Sun by `VICS_PICK`, counting paid/settling orders and live checkout holds, so a full day can't be bought; `GET /api/vics-pick/availability?date=`) adds a `paid-feature` submission to the review queue and features the matching live event. Every checkout form shows a live preview of the placement drawn with the site's own markup (`renderPreview`, refreshed from `POST /advertise/preview` as they type) above the pay button; `/advertise` shows each package's placement, limits and an example (`samplePreviews`). The free submit form says free submissions aren't guaranteed and links to a Vic’s Pick, prefilled with the event just sent (checkout GET reads those query fields). Placements are applied in `getPublicPayload` at read time, never written into the published payload. Orders live in `sponsor_orders`; prices in `AD_PACKAGES` (`server/seo.js`). Admin Sponsors tab: orders, week calendar, hide/restore. Paid orders ping Slack. Off until both Stripe vars are set. Stripe calls pin `Stripe-Version: 2026-09-30.endive` (`STRIPE_API_VERSION`); each package uses a catalog Product/Price found by `lookup_key` (created on first use, inline `price_data` as a fallback); sessions carry `integration_identifier` and no `payment_method_types` (dynamic payment methods). Slow payment methods hold the order as `processing` (a weekly week stays taken) until `checkout.session.async_payment_succeeded`/`_failed`. Webhook events to subscribe: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`, `radar.early_fraud_warning.created`. Use a restricted key (`rk_`) with Checkout Sessions, Products and Prices write access as `STRIPE_SECRET_KEY`.

## Traffic features

- Search landing pages in `HUB_PAGES` with `hidden: true` (`/tonight`, `/date-night`, `/this-weekend-with-kids`) stay out of the top nav but are in the footer and sitemap.
- Hidden landing pages for specific searches: `/tonight`, `/date-night`, `/this-weekend-with-kids`, `/free-this-weekend`, `/nightlife`, `/arts-and-culture`, `/outdoor-events` (footer and sitemap, not the top nav).
- Hub pages and the homepage hero have a "Share this list" button (handled by `docs/track.js`); `/this-weekend` and the homepage use the social-kit cover slides as link-preview images.
- `docs/app.js` inserts a "Get this list every Monday" signup card after the day following today (hidden once subscribed on that device, via localStorage).

## Auto-publish

`server/autopublish.js`: each collector run commits `candidates.json`, which redeploys the site; on boot in production (`RAILWAY_ENVIRONMENT_NAME=production`, unless `AUTO_PUBLISH=0`) the upcoming candidates plus approved submissions are published to the store. Upcoming events already published are kept; events it added that the admin later removed are remembered (`auto_publish` in the published payload, hidden from `/events.json`) and not re-added. `POST /api/admin/auto-publish` forces a run. The collector drops non-events (`non_event_reason`: job/internship posts, booking ads, awareness-day posts) and decodes HTML entities; with `OPENAI_API_KEY`, the AI review also returns `keep: false` for non-events. `weekly-collect.yml` runs Sunday and Wednesday.

## Event check

`scripts/sweep_events.py` (`.github/workflows/event-check.yml`) looks over the live `/events.json` for the next 14 days after each successful Weekly Collect (once auto-publish has updated the site) and Monday 11:43 UTC, an hour before the newsletter. Rules first, free: the collector's `is_same_event`, `out_of_area_reason` and `non_event_reason` run again over the published list (hand-added events and ones published before a rule existed), plus a weekday in the name that doesn't match the date and starts before 6 AM. Then one OpenAI call (`OPENAI_MODEL`, default gpt-5-mini) over the whole list for what per-event checks can't see, like the same event at two venues; skipped without `OPENAI_API_KEY`. Rule findings it's sure about (church/worship events, non-events, exact duplicates; `AUTO_HIDE`) it hides through `POST /api/event-check/hide` (`server/eventcheck.js`, `X-Cron-Secret` = `EVENT_CHECK_SECRET`, falling back to `NEWSLETTER_CRON_SECRET`; at most 10 per run, only live upcoming events). Duplicates are only hidden when exact (same normalized name, venue and start) and neither copy is featured; the copy with less detail goes, fuzzy matches are only reported. Hiding never deletes: the published payload gains a `hidden` entry, matched by the event's original key (date|name|venue before the edits overlay), not its page URL, so slug renumbering and admin renames can't move or undo it; entries are kept 400 days so past pages stay hidden, and `getPublicPayload` (and the bundled fallback) leave those events out (site, `/events.json`, newsletter, social kit, sitemap, event pages); auto-publish and Save & Publish carry it forward. The admin Home tab lists hidden events with Restore, which also records the original key in `hidden_restored` so the check never hides it again; the Events tab labels them "Hidden by check". Wrong days, odd times and every AI finding are only reported. One Slack message to the activity channel: what it hid, then what to look at. Without the secret it only reports. Tests: `test_sweep_events.py`, `tests/eventcheck.test.js`.

## Slack notifications

The public site publishes no email address: `/contact` (`server/contact.js`) sends messages to Slack, falling back to the server log if Slack is unavailable.


`server/slack.js` posts to a Slack incoming webhook (`SLACK_WEBHOOK_URL`, same setup as austincommercialsites.com). No-op when unset. Server pings: new event submission, sponsor paid, venue partner cancelled or payment failing, newsletter sent (or partly failed / skipped because nothing was published), and alerts for 500s, Stripe checkout or webhook failures, crashes and boot failures. Alerts are de-duplicated per key for 15 minutes. Three channels, each optional and falling back to `SLACK_WEBHOOK_URL`: `SLACK_SALES_WEBHOOK_URL` (sponsor orders, refunds, disputes, failed payments), `SLACK_ACTIVITY_WEBHOOK_URL` (submissions, contact messages, subscribers, auto-publish, newsletter sent) and `SLACK_ALERTS_WEBHOOK_URL` (every `alert()`). Pass `channel` to `slack.notify` for new pings. GitHub Actions use `scripts/slack_notify.py`; failure steps read `SLACK_ALERTS_WEBHOOK_URL`, the collect-done and outreach steps read `SLACK_ACTIVITY_WEBHOOK_URL`, both falling back to `SLACK_WEBHOOK_URL`: weekly collect done (candidate count) or failed, social kit / newsletter / digest failures, tests failing on main, and `uptime.yml` (hourly site check, daily stale-feed check).

## Conventions

- **Python:** stdlib + `requests` + `beautifulsoup4` + `pyyaml` + `sentry-sdk`. No Django, no FastAPI, no async — keep `collect_events.py` blocking and simple.
- **JavaScript:** ES modules (`"type": "module"` in `package.json`). No TypeScript. No bundler — `docs/*.js` is loaded as-is by the browser.
- **No new dependencies without strong justification.** This is a Sunday-night cron job + a small Express app. Every dependency is a Sunday-night failure mode.
- **Comments explain *why*, not *what*.** The existing code does this consistently — match it. Documenting the rationale is half the value of every PR.
- **Errors include `.status` when they wrap an HTTP response** (see `server/github.js`) so route handlers can branch on it.
- **Secrets only via env vars.** Never commit `.env`. `requirements.txt` has no upper bounds — be aware that pip can pull in major-version-breaking releases on a fresh CI run.

---

## Don't-touch list

These files / behaviors are load-bearing and **must not change** in a normal PR. If you genuinely need to change one, call it out explicitly in the PR description and assume it needs human review.

1. **`docs/events.json` outside the admin Save & Publish flow.** The weekly workflow uses `--candidates-only` for a reason. `test_collect_events_safety.py` pins this.
2. **`candidates.json`** in a feature PR — it's a runtime artifact written by the weekly workflow.
3. **`collection_metadata.json`** in a feature PR — same, runtime artifact.
4. **`.last-published-digest-*` files** — markers from the decommissioned reply-to-email approval flow. Leave alone.
5. **The `weekly-collect.yml` cron expressions `23 20 * * 0` and `23 20 * * 3`.** The 1-hour DST drift is intentional and documented in the workflow header. Do not "fix" it. (Moved from `0 23` in Oct 2026 at the owner's request, because GitHub started the on-the-hour evening slot 45–90 min late; keep `server/sources.js` in sync if it ever changes.)
6. **Step / job timeouts in `weekly-collect.yml`.** Each value is justified by a specific run ID in the comments. Don't lower without strong reason.
7. **The `--candidates-only` flag default behavior.** Default is *off* (so local runs still write `events.json`); CI explicitly sets it.
8. **`server/auth.js` — the HMAC-SHA256 token format.** Single algorithm, no `alg` header. Do not switch to a JWT lib.
9. **The legacy `ADMIN_TOKEN` fallback path.** Documented in `index.js`. Keep working.
10. **The browser-side GitHub PAT path in `docs/admin.js`.** Intentional bypass for when server-side `GITHUB_TOKEN` isn't configured.

---

## Environment variables

Full reference is in [`RAILWAY.md`](./RAILWAY.md). Quick list:

### Required for prod

| Var | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | server | Railway Postgres connection string |
| `ADMIN_USERNAME` | server (auth.js) | Admin login |
| `ADMIN_PASSWORD` | server (auth.js) | Admin login |
| `ADMIN_SESSION_SECRET` | server (auth.js) | HMAC key for session tokens. Rotate with `openssl rand -hex 32`. |

### Required for the weekly collector

| Var | Used by |
|---|---|
| `OPENAI_API_KEY` | `collect_events.py` AI review + FB/IG post extraction |
| `APIFY_TOKEN` | `collect_events.py` Facebook events + posts, Instagram posts |
| `GEMINI_API_KEY` | `collect_events.py` Gemini + Google Search event discovery (`fetch_gemini_events`; optional `GEMINI_MODEL`, `GEMINI_ENABLED=0` to turn off). Events are kept only with their own link on a site Gemini cited, inside the window. |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT` | Both collector and server |

### Optional

| Var | Default | Purpose |
|---|---|---|
| `ADMIN_TOKEN` | — | Legacy bearer token; kept working alongside login |
| `ADMIN_SESSION_TTL_HOURS` | `12` | Session length |
| `GITHUB_TOKEN` / `GITHUB_PAT` | — | Enables `/api/admin/publish-events` to commit `docs/events.json` and `/api/admin/trigger-collect` to `workflow_dispatch`. Currently unset on production. |
| `GITHUB_OWNER` | `Tmpalori` | |
| `GITHUB_REPO` | `thevic361` | |
| `GITHUB_BRANCH` | `main` | |
| `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY` | — | When set, `/api/submissions` requires a Turnstile token |
| `FB_POSTS_ENABLED`, `IG_POSTS_ENABLED` | — | Repo Variables (not secrets); `=1` to enable post-scrape pipelines in CI |
| `FB_POSTS_MAX_VENUES`, `IG_POSTS_MAX_VENUES` | (collector defaults) | Caps to keep Apify costs bounded |
| `AUTO_PUBLISH` | on in production | `0` turns off publishing collector candidates on boot (server/autopublish.js) |
| `RESEND_API_KEY` | — | Turns on the email newsletter (server/newsletter.js); until set, signups are saved but nothing is emailed |
| `NEWSLETTER_FROM` | `The Vic 361 <news@thevic361.com>` | Sender; the domain must be verified in Resend |
| `NEWSLETTER_ADDRESS` | — | Mailing address shown in every email (CAN-SPAM) |
| `NEWSLETTER_REPLY_TO`, `NEWSLETTER_TEST_TO` | — | Reply-to address; default test recipient |
| `NEWSLETTER_CRON_SECRET` | — | Shared secret for `POST /api/newsletter/cron` (Monday auto-send via `newsletter.yml`, gated by the `NEWSLETTER_AUTOSEND` repo variable) |
| `OPENAI_MODEL` | `gpt-5-mini` | Repo Variable; overrides the collector's OpenAI model |
| `SITE_URL` | `https://www.thevic361.com` | Canonical origin. Requests to the bare domain 301 here |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | — | Turn on self-serve sponsor checkout (server/sponsors.js). Webhook endpoint: `https://www.thevic361.com/api/stripe/webhook` with events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`, `customer.subscription.updated`, `customer.subscription.deleted` |
| `SLACK_WEBHOOK_URL` | — | Slack incoming webhook for owner pings (server/slack.js). Set it in Railway (production) and as a GitHub Actions secret for workflow alerts |
| `SLACK_SALES_WEBHOOK_URL`, `SLACK_ACTIVITY_WEBHOOK_URL`, `SLACK_ALERTS_WEBHOOK_URL` | `SLACK_WEBHOOK_URL` | Optional per-channel webhooks (sales: Railway; activity and alerts: Railway and GitHub secrets) |
| `META_PIXEL_ID` | — | Meta Pixel ID (digits, from Meta Events Manager). Turns on `/pixel.js` for ads (server/metaPixel.js) |
| `EVENT_CHECK_SECRET` | `NEWSLETTER_CRON_SECRET` | Shared secret (Railway + GitHub) that lets the event check hide church events, non-events and exact duplicates (server/eventcheck.js). Unset: the check only reports |
| `PORT` | `3000` | Express listen port |

PR/staging Railway environments do **not** automatically inherit `ADMIN_*` vars — set them per-environment or use Railway's shared variables feature.

---

## PR checklist

Before you open a PR:

- [ ] `npm test` passes locally
- [ ] `pytest -q` passes locally
- [ ] No new files committed under `data/`, `__pycache__/`, or `node_modules/`
- [ ] No secrets in code or test fixtures
- [ ] If you changed `collect_events.py`: `test_collect_events_safety.py` still passes (the `--candidates-only` invariant is intact)
- [ ] If you changed `server/`: no change to the `ADMIN_TOKEN` legacy fallback or the `auth.js` token format unless explicitly intended
- [ ] If you changed `docs/`: no new `innerHTML` write of an unescaped value, no third-party script added without thinking about CSP
- [ ] If you changed a workflow: timeouts and the `--candidates-only` flag are intact
- [ ] PR description explains *why*, not just *what*

PR previews: only `docs/**` changes auto-deploy a static preview. Server / collector changes need a Railway PR Environment to test (auto-created on PR open).

---

## Where the audit lives

A full audit was done on 2026-04-29 (`AUDIT_2026_04_29.md` in Tristen's workspace). The prioritized backlog is there — ask Tristen for it before starting any larger refactor work so you don't re-litigate already-considered tradeoffs. Highlights:

- **P1 (done Oct 2026):** `sponsor.url` / event URLs are scheme-checked and escaped in `app.js`; `tests.yml` gates PRs; the legacy `?preview=<json>` path is removed.
- **P2:** Split `collect_events.py` into a `collector/` package (do this on the next scraper-add PR rather than as a standalone refactor); move `test_*.py` to `tests/python/`; pin upper bounds in `requirements.txt`; delete `facebook_venues.backup.json`, `pending_venues.json`, `.last-published-digest-*`, `approve_events.py` (or move under `legacy/`).
- **P3:** Tighten `trust proxy` config; add request logging; hoist `escapeHtml` into `docs/util.js`; add an end-to-end submit→approve→publish vitest; extend the starter CSP (currently framing/object/base only) to scripts.

---

## Useful one-liners

```bash
# Trigger the weekly collector manually:
gh workflow run "Weekly Collect"
gh run list --workflow=weekly-collect.yml --limit 1

# Check live health:
curl -s https://thevic361.com/api/health
# expected: {"ok":true,"storage":"postgres"}

# Check live event count:
curl -s https://thevic361.com/events.json | jq '.events | length'

# Tail the latest weekly-collect log:
gh run view --log $(gh run list --workflow=weekly-collect.yml --limit 1 --json databaseId -q '.[0].databaseId')
```

## Security notes

- `trust proxy` is `1` (Railway's edge is the single hop). Don't set it to `true`: Express would then take the client-supplied left-most X-Forwarded-For entry as `req.ip`, and every per-IP rate limit could be bypassed.
- Anything rendered into HTML attributes must escape quotes (`escHtml` in both `server/seo.js` and `docs/app.js` does). `safeUrl` / `safeHref` reject URLs containing whitespace, quotes or angle brackets.
- Use function replacements (`.replace(x, () => html)`) when inserting rendered content: event text can contain `$'` / `$&`.
- Weekly sponsor holds are saved before the Stripe call, under an in-process lock; a payment for an already-sold week is marked `conflict` and flagged in Slack for a refund.
- Cloudflare Turnstile (`TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`) protects `/api/submissions`, `/contact`, `/api/subscribe` and `/advertise/checkout`. `docs/turnstile.js` mounts an interaction-only widget on forms marked `data-turnstile` (loaded on first focus; `data-turnstile="fetch"` forms call `vicTurnstile.token(form)`); the server checks `cf-turnstile-response` or `turnstile_token` via `verifyHuman` in `server/index.js`. Both off until the keys are set.
