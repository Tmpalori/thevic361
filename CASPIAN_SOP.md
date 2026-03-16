# The Vic 361 — Caspian Daily SOP

## Overview
You (Caspian) run the daily event pipeline for **The Vic 361**, Victoria TX's community events board. Your job is to collect events, email them to Tristen for screening, and publish his picks.

**Daily time: ~2 minutes of automated tasks**
**When: Two runs — 6:00 AM and after Tristen replies (~7:30 AM)**

---

## Morning Run #1: Collect & Email (6:00 AM)

### Step 1: Pull latest code
```bash
cd ~/vic361-collector
git pull
```

### Step 2: Run the Event Collector
```bash
python3 collect_events.py --output ./docs/events.json --candidates ./candidates.json --local-dir . --days 7 --skip-ai
```

This fetches events from:
- `local_events.yaml` (recurring events — Farmers' Market, Aero Crafters live music, etc.)
- City of Victoria calendar (victoriatx.gov)
- Victoria Chamber of Commerce (business.victoriachamber.org)
- Victoria Public Library calendar (victoriapl.librarycalendar.com)
- Google Sheet (manual event submissions from Tristen)

It outputs:
- `candidates.json` — ALL events found (for Tristen to screen)
- `docs/events.json` — the live site file (updated after Tristen approves)

### Step 3: Send the Digest Email
```bash
python3 send_digest.py --dry-run
```

This prints the email Tristen would receive — a numbered list of every event candidate grouped by day. Review that it looks reasonable, then send for real:

```bash
python3 send_digest.py
```

**Note:** Requires SMTP credentials. Set these in `~/.zshrc` or `~/.bashrc`:
```bash
export SMTP_EMAIL="youremail@gmail.com"
export SMTP_PASSWORD="your-app-password"    # Gmail App Password, NOT regular password
```

For Gmail App Passwords: https://myaccount.google.com/apppasswords

---

## Morning Run #2: Publish Picks (after Tristen replies)

When Tristen replies with his picks (e.g., "1, 3, 5, 8, 11"), run:

### Step 1: Approve the events
```bash
cd ~/vic361-collector
python3 approve_events.py 1 3 5 8 11
```

Or if he says keep everything:
```bash
python3 approve_events.py ALL
```

**Tip:** You can list current candidates anytime:
```bash
python3 approve_events.py --list
```

### Step 2: Push to GitHub
```bash
git add docs/events.json candidates.json local_events.yaml
git commit -m "Update events $(date +'%Y-%m-%d')"
git push
```

GitHub Pages deploys the updated `events.json` to the live site within 1-2 minutes.

---

## Weekly Tasks (Every Monday)

### Quick Facebook Scan (if Tristen asks)
Check these Facebook groups for events not in the system:

1. **"Victoria, Tx - Events and Nightlife"** (~10K members)
   - URL: https://www.facebook.com/groups/victoriatxevents
2. **"Victoria Texas Community & Events"** (~2.8K members)
   - URL: https://www.facebook.com/groups/victoriatxcommunity

Add any new events to `local_events.yaml` under `events:`.

### Update New & Notable (Monthly)
Edit `extras.yaml` to refresh the "New & Notable" section:
- New restaurant/business openings
- Construction updates
- Closings or relocations

### Clean Up Old Events
Remove past one-time events from `local_events.yaml` under `events:` (recurring events stay).

---

## File Reference

| File | What It Does |
|---|---|
| `collect_events.py` | Main collector — fetches web + YAML, merges, deduplicates |
| `send_digest.py` | Sends numbered email digest to Tristen for screening |
| `approve_events.py` | Takes Tristen's picks and publishes to events.json |
| `local_events.yaml` | Curated events (recurring + one-time). The backbone. |
| `extras.yaml` | "New & Notable" items + weekly sponsor |
| `candidates.json` | All raw events (input for screening) |
| `docs/events.json` | The output file that powers the website |

---

## Icon Reference

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
| Aero Crafters | 309 E. Crestwood Dr. |
| Moonshine Drinkery | 103 W. Santa Rosa St. |
| The Hideaway | 1807 Stolz St. |
| Froggy's Grub & Pub | 5902 N. Navarro St. |
| Victoria Public Library | 302 N. Main St. |
| Victoria Farmers Market | 2805 N. Navarro St. |
| Riverside Park | 405 Memorial Drive |
| DeLeon Plaza | 101 N. Main St. |
| Leo J. Welder Center | 214 N. Main St. |
| Victoria Fine Arts Center | 1002 Sam Houston Dr. |
| Museum of the Coastal Bend | 2200 E. Red River St. |
| The Nave Museum | 306 W. Commercial St. |

---

## Troubleshooting

**"No SMTP_EMAIL — email not sent"**
→ Set SMTP_EMAIL and SMTP_PASSWORD env vars. Use `--dry-run` to test without sending.

**"candidates.json not found"**
→ Run `collect_events.py` first. The digest and approval scripts depend on it.

**City Calendar returns 0 events**
→ Site may be down. Run with `--skip-web` to use just YAML + Google Sheet.

**Website not updating after push**
→ GitHub Pages takes 1-2 minutes. Hard refresh browser (Cmd+Shift+R).
