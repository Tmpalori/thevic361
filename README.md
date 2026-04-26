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
| `local_events.yaml` | Recurring + manually curated events |
| `extras.yaml` | "New & Notable" section + sponsor |
| `docs/` | Website files (served by GitHub Pages) |
| `docs/events.json` | Event data powering the site |
| `.github/workflows/` | GitHub Actions for weekly automation |

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
