# Agent Instructions — The Vic 361

Read this file first if you are a coding agent (Codex, Claude Code, Cursor, etc.) about to make a change to this repo. It tells you how the system works, what you are and aren't allowed to touch, how to run the tests, and which invariants matter.

The companion files `CLAUDE.md` and `.cursorrules` redirect to this document so every agent flavor lands on the same source of truth.

---

## What this is

**The Vic 361** is a weekly community-events website for Victoria, TX (population ~65k). It collects events from public calendars, Apify-scraped Facebook/Instagram, and Perplexity Sonar venue-grounded prompts; an admin curates the candidate list each Sunday; the curated list is served from Railway Postgres at [thevic361.com](https://thevic361.com).

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
│   Pick events → Save & Publish                                     │
│                                                                    │
│   Server writes published_events row in Railway Postgres (live).   │
│   If GITHUB_TOKEN is set, also commits docs/events.json to repo.   │
└────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  Monday — Tristen sends Beehiiv newsletter manually.               │
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
│   ├── sources.js                # /api/admin/sources payload builder
│   ├── turnstile.js              # Cloudflare Turnstile verify
│   └── validate.js               # submission validation + bot signals
│
├── docs/                         # Static site root (Express serves from here)
│   ├── index.html, app.js, base.css, style.css   # public site
│   ├── admin.html, admin.js, admin-submissions.js, admin.css   # admin UI
│   ├── submit.html, submit.js, submit.css        # public submission form
│   ├── events.json               # CURATED FALLBACK — see source-of-truth note above
│   ├── og-image.png, favicon.svg, sitemap.xml, robots.txt
│
├── tests/                        # vitest (server + admin/submit pages)
│   ├── admin.test.js, admin_login.test.js, admin_submissions.test.js
│   ├── app_preview.test.js, candidates_fallback.test.js
│   ├── publish_preserves_extras.test.js, published_events.test.js
│   ├── sources.test.js, submissions_api.test.js, submit_form.test.js
│
├── test_*.py                     # pytest, currently AT REPO ROOT (not /tests/python/)
│   ├── test_ai_review.py
│   ├── test_collect_events_safety.py    # ⚠️  PINS the --candidates-only invariant
│   ├── test_discover_venues.py
│   ├── test_fb_posts.py, test_ig_posts.py
│   ├── test_library_cap.py, test_sonar_prompts.py, test_venues_seed.py
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

There is currently **no `tests.yml` workflow**. Run both suites locally before opening a PR.

There is no linter configured. Match the existing style (4-space Python, 2-space JS, ES modules in `server/` and `tests/`).

---

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
5. **The `weekly-collect.yml` cron expression `0 23 * * 0`.** The 1-hour DST drift is intentional and documented in the workflow header. Do not "fix" it.
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
| `OPENAI_API_KEY` | `collect_events.py` AI review |
| `PERPLEXITY_API_KEY` | `collect_events.py` Sonar discovery |
| `APIFY_TOKEN` | `collect_events.py` Facebook events + posts, Instagram posts |
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

- **P1:** Validate `sponsor.url` scheme in `app.js`; add a `tests.yml` PR-gating workflow; remove the legacy `?preview=<json>` URL path.
- **P2:** Split `collect_events.py` into a `collector/` package (do this on the next scraper-add PR rather than as a standalone refactor); move `test_*.py` to `tests/python/`; pin upper bounds in `requirements.txt`; delete `facebook_venues.backup.json`, `pending_venues.json`, `.last-published-digest-*`, `approve_events.py` (or move under `legacy/`).
- **P3:** Tighten `trust proxy` config; add request logging; hoist `escapeHtml` into `docs/util.js`; add an end-to-end submit→approve→publish vitest; add a starter CSP.

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
