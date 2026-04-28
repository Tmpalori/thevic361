# The Vic 361 🏙️

**Your Daily Guide to Victoria, TX**

A community events board that automatically collects and displays things to do in Victoria, Texas. The website updates daily via GitHub Actions.

## How It Works

1. **`collect_events.py`** gathers events from public Victoria calendars + your curated YAML file into `candidates.json`
2. **GitHub Actions** runs the collector every Sunday evening (`weekly-collect.yml`) in **candidates-only** mode — it writes `candidates.json` but does NOT overwrite the curated fallback at `docs/events.json`
3. At 9 PM Central Sunday, an informational digest email summarizes what was collected
4. Tristen reviews and picks events at `/admin.html` around 10 PM Sunday, then manually sends the Beehiiv newsletter Monday morning. **Save & Publish** writes the curated payload to Railway Postgres (the live source of truth) and, when `GITHUB_TOKEN` is configured, also commits `docs/events.json` as a fallback.
5. **Railway** serves the live site; `events.json` is read from Postgres first, falling back to the bundled `docs/events.json` snapshot
6. The website reads `events.json` and auto-displays the next 7 days

### Source of truth (`events.json`)

- **Live, curated source:** Railway Postgres `published_events` row (`store.getPublished()`), written by the admin Save & Publish flow.
- **Fallback snapshot:** `docs/events.json` in this repo. Only updated by Save & Publish (with `GITHUB_TOKEN`). The weekly collector workflow runs with `--candidates-only` so CI never overwrites this file with un-screened scraper output.
- **`candidates.json`:** the full raw collector output for the admin to screen each week. Auto-committed by the weekly workflow.

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Run the collector (outputs to docs/events.json)
python collect_events.py --output ./docs/events.json --local-dir .

# Run with AI cleanup (needs OpenAI API key)
export OPENAI_API_KEY=sk-...
python collect_events.py --output ./docs/events.json --local-dir .

# Run with only local YAML (no web scraping)
python collect_events.py --output ./docs/events.json --local-dir . --skip-web
```

## Files

| File | Purpose |
|---|---|
| `collect_events.py` | Event collector script |
| `discover_venues.py` | Weekly Google Maps venue discovery (Apify `compass/google-maps-extractor`) |
| `venues.json` | Primary venue list — seed venues + auto-merged HIGH-tier discoveries |
| `pending_venues.json` | MEDIUM-tier discoveries waiting on admin approval |
| `rejected_venues.json` | Venues we've explicitly rejected (never re-suggested) |
| `facebook_venues.json` | Legacy venue list (kept as a one-cycle fallback) |
| `facebook_venues.backup.json` | Snapshot of the legacy list, refreshed each run |
| `local_events.yaml` | Recurring + manually curated events |
| `extras.yaml` | "New & Notable" section + sponsor |
| `docs/` | Website files (served by GitHub Pages) |
| `docs/events.json` | Curated fallback snapshot. Live data is served from Railway Postgres; this file is only used when Postgres has nothing or the site is served without the Express layer. Only the admin Save & Publish flow writes this file — the weekly collector skips it via `--candidates-only`. |
| `candidates.json` | Full raw collector output (every event found this week), for admin screening. |
| `.github/workflows/` | GitHub Actions for weekly automation |

## Venue Discovery

`discover_venues.py` runs **before** `collect_events.py` inside
`weekly-collect.yml`. It calls the Apify `compass/google-maps-extractor` actor
across 8 category searches scoped to `Victoria, TX`
(bar, restaurant, live music venue, theater, museum, bowling alley, event
venue, community center) with detail/social enrichment turned on.

Results are tiered:

- **HIGH** — rating ≥ 4.2, ≥ 50 reviews, event-likely category, IG or FB →
  auto-merged into `venues.json`.
- **MEDIUM** — rating ≥ 3.8 OR < 50 reviews, IG or FB → appended to
  `pending_venues.json` for admin review.
- **SKIP** — closed, fast-food chain, rating < 3.5, or no socials.

Anything in `rejected_venues.json` is never re-suggested. Existing
`facebook_venues.json` venues are preserved as a safety floor and never
deleted. If `APIFY_TOKEN` is missing or the actor errors out, discovery is
a no-op — the existing venue files are left untouched and the collector
runs as normal.

## Sonar Event Discovery (Venue-Grounded Prompts)

`fetch_perplexity_events` runs **8 venue-grounded query buckets** against
Perplexity Sonar each Sunday. Buckets are seeded from the current
`venues.json`, so each prompt names the actual HIGH-tier venues we care
about instead of asking generically about Victoria, TX:

| # | Bucket | Seeded from |
|---|---|---|
| q1 | Live music this week | HIGH music venues (Bar / Live Music, Theatre, etc.) |
| q2 | Trivia / karaoke / open mic | HIGH bars |
| q3 | Family events | HIGH family venues (museum, theatre, arcade, zoo, attraction) |
| q4 | Restaurant specials, pop-ups, food trucks | HIGH/MEDIUM restaurants |
| q5 | Cultural events | HIGH cultural venues (Arts, Museum, Theatre) |
| q6 | Community / civic | Churches, civic clubs, library (no venue list) |
| q7 | Markets / fairs / festivals | Farmers Market + city-wide |
| q8 | Eventbrite / AllEvents.in catch-all | n/a |

Each bucket caps named venues at 6 (HIGH first) so prompts stay concise. If
`venues.json` is missing or has no HIGH match for a category, the bucket
falls back to category-only phrasing — the collector keeps running.

This replaces the old 10-query generic set; four of those queries
(`q1 aero`, `q6 trivia`, `q7 music`, `q10 food`) had been silently returning
zero events for weeks because Sonar had nothing concrete to ground on.

## Social Posts → Events (Optional)

Two opt-in pipelines pull recent social posts and ask Perplexity Sonar to
extract any specific-dated events from them. They catch events announced
as posts ("live music tonight 8pm") that never become formal Event pages.

| Flag | Source | Tier limits | Lookback |
|---|---|---|---|
| `FB_POSTS_ENABLED=1` | Apify `apify/facebook-posts-scraper` | 50 posts × HIGH-confidence venues | 30 days |
| `IG_POSTS_ENABLED=1` | Apify `apify/instagram-post-scraper` | 25 posts × HIGH, 15 × MEDIUM | 14 days |

Both are **off by default** until cost/quality is production-validated.
They share the `_APIFY_LIMIT_TRIPPED` tombstone, so once Apify's monthly
hard limit trips on any actor, the rest of the run skips its remaining
Apify calls. Toggle each independently via repo variables
`FB_POSTS_ENABLED` / `IG_POSTS_ENABLED` (Settings → Variables → Actions);
no code change required.

Cost shape: ≤ $0.50/run for FB-posts, ≤ $0.85/run for IG-posts when both
are enabled.

## Adding Events

Edit `local_events.yaml` and add under `events:`:

```yaml
events:
  - date: "2026-03-22"
    name: "Spring Block Party"
    time: "5:00 PM – 10:00 PM"
    venue: "Downtown Victoria"
    address: "Main Street"
    description: "Live music, food trucks, and fun."
    icons: [music, food, family]
    free: true
    url: ""
```

## Public Event Submissions (v1)

A bot-resistant **Submit an Event** flow lives at `/submit.html`, served
by a small Express backend in `server/`. Submissions land in a Postgres
table (or a JSON file fallback), where the admin can approve, reject,
mark duplicate, or edit them before pulling them into the existing
weekly publish flow.

- Public form: `docs/submit.html` (mobile-first, honeypot + timing +
  Cloudflare Turnstile, server-side rate limited and dedupe-checked).
- Backend: `server/index.js` (Express). Run `npm start` locally.
- Admin login: `docs/admin.html` now signs in with username + password
  against the server (`ADMIN_USERNAME` / `ADMIN_PASSWORD` /
  `ADMIN_SESSION_SECRET`). The server holds the GitHub publish token
  (`GITHUB_TOKEN`), so the browser never needs a GitHub PAT.
- Admin Submissions tab: shares the same login session — no separate
  token needed.
- `GITHUB_TOKEN` is **optional**. Without it, the admin still loads
  candidates from the bundled `candidates.json` plus the approved-
  submissions queue, and **Save & Publish** stores the published payload
  in Railway (Postgres or JSON-file fallback) so the Railway public site
  serves it from `/events.json`. With `GITHUB_TOKEN`, **Save & Publish**
  also commits `docs/events.json` to `Tmpalori/thevic361@main` so GitHub
  Pages stays in sync.
- Public-facing `events.json` strips submitter PII and admin-only
  metadata before publish.

See `RAILWAY.md` for full Railway deployment + env var details (including
the new login + GitHub token variables).

## Setup

See `SETUP_GUIDE.md` for full setup instructions.
