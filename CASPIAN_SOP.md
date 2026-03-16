# The Vic 361 — Caspian Daily SOP

## Overview
You (Caspian) run the daily event collection for **The Vic 361**, Victoria TX's community events board. Your job is to keep `events.json` updated so the website always shows fresh events.

**Daily time: ~5 minutes**
**When: Every morning before 7:00 AM Central**

---

## Daily Workflow

### Step 1: Run the Event Collector (2 minutes)
```bash
cd ~/vic361-collector
python collect_events.py --output ./docs/events.json --local-dir . --days 7
```

This fetches events from:
- Your `local_events.yaml` (recurring events you've curated)
- City of Victoria calendar (victoriatx.gov)
- Victoria Chamber of Commerce (business.victoriachamber.org)
- OpenAI API for cleanup (if `OPENAI_API_KEY` is set)

### Step 2: Quick Facebook Scan (3 minutes)
Check these Facebook groups for events NOT already in the output:

1. **"Victoria, Tx - Events and Nightlife"** (~10K members)
   - URL: https://www.facebook.com/groups/victoriatxevents
2. **"Victoria Texas Community & Events"** (~2.8K members)
   - URL: https://www.facebook.com/groups/victoriatxcommunity

**What to look for:**
- Live music at local bars/restaurants (The Hideaway, Moonshine Drinkery, The Alamo BBQ, Siesta, etc.)
- Food truck events
- Fundraisers and benefits
- Community gatherings, block parties
- New restaurant openings / soft openings
- Pop-up markets

**When you find an event**, add it to `local_events.yaml` under `events:`:

```yaml
events:
  - date: "2026-03-22"
    name: "Live Music: Artist Name"
    time: "7:00 PM – 10:00 PM"
    venue: "The Hideaway"
    address: "1807 Stolz St."
    description: "Friday night live music with cold drinks on the patio."
    icons: [music, drinks]
    free: false
    url: ""
```

### Step 3: Push to GitHub
```bash
cd ~/vic361-collector
git add docs/events.json local_events.yaml extras.yaml
git commit -m "🏙️ Update events $(date +'%Y-%m-%d')"
git push
```

GitHub Pages will automatically deploy the updated `events.json` to the live site.

---

## Weekly Tasks (Every Monday)

### Update New & Notable
Edit `extras.yaml` to refresh the "New & Notable" section:
- New restaurant/business openings
- Construction updates (what's coming to Victoria)
- Closings or relocations

Sources:
- **Fox Sports 1510** Victoria (tracks new businesses)
- **Crossroads Today (KAVU TV)** local news
- **Victoria Advocate** (newspaper)
- Facebook groups (people post about new spots)

### Clean Up Old Events
Remove past one-time events from `local_events.yaml` under `events:` (recurring events stay).

### Check Recurring Events
Verify recurring events in `local_events.yaml` are still accurate:
- Did the Farmers' Market change hours?
- Did Chess Club move to a new day?
- Any new recurring weekly events to add?

---

## File Reference

| File | What It Does |
|---|---|
| `collect_events.py` | Main collector script — fetches web + YAML, merges, deduplicates |
| `local_events.yaml` | Your curated events (recurring + one-time). This is the backbone. |
| `extras.yaml` | "New & Notable" items + weekly sponsor |
| `docs/events.json` | The output file that powers the website |
| `requirements.txt` | Python dependencies |

---

## Icon Reference

Use these tags in the `icons` array:

| Icon | Tag | Use For |
|---|---|---|
| 🍔 | `food` | Restaurants, food trucks, tastings, farmers market |
| 🎵 | `music` | Live music, concerts, DJ nights, karaoke |
| 👨‍👩‍👧‍👦 | `family` | Kids events, family-friendly activities |
| 🍺 | `drinks` | Bars, breweries, wine tastings, happy hours |
| 🎨 | `arts` | Art shows, museums, galleries, theater |
| 🛍️ | `shopping` | Markets, vendor fairs, pop-up shops |
| 🏃 | `outdoors` | Walks, runs, park events, nature |
| 📅 | `community` | Meetings, clubs, workshops, fundraisers |
| 🆓 | `free` | Free events (also set `free: true`) |

---

## Common Victoria TX Venues

| Venue | Address |
|---|---|
| Victoria Public Library | 302 N. Main St. |
| Museum of the Coastal Bend | 2200 E. Red River St. |
| The Nave Museum | 306 W. Commercial St. |
| Victoria Farmers Market | 2805 N. Navarro St. |
| Riverside Park | 405 Memorial Drive |
| The Hideaway | 1807 Stolz St. |
| Moonshine Drinkery | 103 W. Santa Rosa St. |
| The Alamo Texas BBQ & Tequila Bar | (confirm address) |
| Leo J. Welder Center | 214 N. Main St. |
| Victoria Community Center | 2905 E. North St. |
| Fossati's Delicatessen | 302 S. Main St. |
| DeLeon Civic Center | 203 N. Glass St. |
| Victoria Fine Arts Center | 1002 Sam Houston Dr. |

---

## Troubleshooting

**"No OPENAI_API_KEY — skipping AI cleanup"**
→ Set the key: `export OPENAI_API_KEY=sk-...` (or add to `~/.zshrc`)
→ Without AI, events still work — they just won't have polished descriptions.

**City Calendar returns 0 events**
→ The site may be temporarily down. Run with `--skip-web` to use just YAML:
```bash
python collect_events.py --output ./docs/events.json --local-dir . --skip-web
```

**Events showing on wrong dates**
→ Check that dates in `local_events.yaml` are formatted exactly as `YYYY-MM-DD`

**Website not updating after push**
→ GitHub Pages can take 1-2 minutes to deploy. Hard refresh the browser (Cmd+Shift+R).
→ Check GitHub Actions tab for any failed builds.

---

## Emergency: Manual events.json Update

If the script breaks and you need to update the site immediately:

1. Open `docs/events.json` directly
2. Edit the events array (follow the existing format)
3. Update `last_updated` timestamp
4. Push to GitHub

The website reads `events.json` directly — no build step needed.
