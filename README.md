# The Vic 361 🏙️

**Your Daily Guide to Victoria, TX**

A community events board that automatically collects and displays things to do in Victoria, Texas. The website updates daily via GitHub Actions.

## How It Works

1. **`collect_events.py`** gathers events from public Victoria calendars + your curated YAML file
2. **GitHub Actions** runs the collector every Sunday at 6 PM Central (`weekly-collect.yml`)
3. At 9 PM Central Sunday, an informational digest email summarizes what was collected
4. Tristen reviews and picks events at `/admin.html` around 10 PM Sunday, then manually sends the Beehiiv newsletter Monday morning
5. **GitHub Pages** serves the website from the `docs/` folder
6. The website reads `events.json` and auto-displays the next 7 days

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
| `docs/events.json` | Event data powering the site |
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

## Setup

See `SETUP_GUIDE.md` for full setup instructions.
