# The Vic 361 — Tristen's Weekly SOP

## What's Already Automated
The system handles ~70% of event collection automatically:
- **Recurring weekly events** (20+ events/week) — Froggy's specials, Farmers' Market, Aero Crafters live music, Library story times, Chess Club, Story Strolls, etc.
- **City of Victoria calendar** — scraped weekly (library programs, city events, meetings)
- **Chamber of Commerce events** — scraped weekly (business events, community gatherings)
- **Google Sheet submissions** — anything you add to the sheet gets pulled in automatically
- **Deduplication** — the system merges everything and removes duplicates

**Your job: Fill in what the bots can't find, then pick which events to publish.** That's mainly bar/restaurant live music, Facebook-only events, and one-time community stuff, plus the Sunday night admin review. Takes ~15 minutes per week.

---

## Weekly Cadence (Sunday → Monday)

| Time (Central) | What happens | Who does it |
|---|---|---|
| Sun 6 PM | `weekly-collect.yml` runs venue discovery (Google Maps via Apify), then the collector. Updates `venues.json`, `pending_venues.json`, `candidates.json`, and `docs/events.json` | Automated |
| Sun 9 PM | `weekly-digest.yml` emails an **informational** summary of what was collected, with a link to the admin review page | Automated |
| Sun 10 PM | Open `/admin.html`, pick the events you want to publish, save your selection. Admin commits go directly to `main`. | **You** |
| Mon morning | Send the Beehiiv newsletter manually | **You** |

The Sunday digest email is for awareness only — there is **no reply-to-email approval anymore**. Picking events happens on `/admin.html` (landing in a follow-up PR; until then publish via direct edits to `docs/events.json`).

---

## Weekly Checklist (Every Sunday — 15 min)

### Step 1: Quick Facebook Scan (5 min)
Open these two groups and scroll through this week's posts:

1. **[Victoria, Tx - Events and Nightlife](https://www.facebook.com/groups/victoriatxevents)** (~10K members)
2. **[Victoria Texas Community & Events](https://www.facebook.com/groups/victoriatxcommunity)** (~2.8K members)

**What to look for:**
- 🎵 Live music at bars (Moonshine, The Hideaway, Siesta, etc.)
- 🍔 Food truck rallies, pop-up restaurants
- 🎨 Art shows, gallery openings
- 🛍️ Pop-up markets, vendor fairs
- 👨‍👩‍👧‍👦 Fundraisers, benefits, community events
- 🆕 New restaurant openings / soft openings

### Step 2: Quick Venue Check (3 min)
Scan these pages for this week's lineup:

| Venue | Where to Check | What They Post |
|---|---|---|
| **Aero Crafters** | [Facebook](https://www.facebook.com/aerocrafters/) or [Eventbrite](https://www.eventbrite.com/o/aero-crafters-18361431565) | Specific artist names for Fri/Sat live music |
| **Moonshine Drinkery** | [Facebook](https://www.facebook.com/moonshinedrinkery/) | Live music, First Friday art shows |
| **The Hideaway** | Facebook | Weekend live music |
| **Froggy's Grub & Pub** | [Website Events](https://froggysgrub.com/froggys-events/) or [Facebook](https://www.facebook.com/froggysgrubandpub/) | Special events beyond daily specials |

**You're looking for:** The specific artist name playing this Friday/Saturday at Aero Crafters and Moonshine. The recurring "Live Music at Aero Crafters" is already in the system — you're just updating the artist name if you find it.

### Step 3: Add Events to Google Sheet (2 min)
**Sheet URL:** [The Vic 361 Events Sheet](https://docs.google.com/spreadsheets/d/1S42hYlrPM516LDTcy3W_8afCkCqc-ZrUfN2J-SmP23I/edit)

For each new event, add a row:

| Column | What to Enter | Example |
|---|---|---|
| **Date** | YYYY-MM-DD | 2026-03-22 |
| **Event Name** | Keep it short & clear | Jake Castillo LIVE |
| **Time** | Start – End | 7:00 PM – 10:00 PM |
| **Venue** | Venue name | Moonshine Drinkery |
| **Address** | Street address | 103 W. Santa Rosa St. |
| **Notes** | One-line description | Country acoustic set on the patio. |
| **Added By** | Your name | Tristen |
| **Status** | Leave blank or "new" | new |

That's it. The collector script picks up new rows automatically during the Sunday 6 PM run. Add new rows by Sunday 5:45 PM Central so they're included in that week's collection.

---

## Monthly Tasks (First Monday of Each Month — 5 min)

### Update "New & Notable"
Edit the **extras.yaml** file directly in the repo. Swap in fresh items:
- New restaurant/bar openings
- Construction updates (what's coming)
- Closings or relocations

**Where to find this info:**
- Victoria Advocate headlines
- Fox Sports 1510 Victoria (tracks new businesses)
- Crossroads Today (KAVU TV)
- Facebook groups (people post about new spots)

### Schedule Monthly Library Events
Check [Victoria Public Library Calendar](https://victoriapl.librarycalendar.com/events/week) for:
- VPL Jams (monthly live music — usually a Friday)
- VPL Talks (monthly speaker series)
- VPL Rec Night (monthly game night — usually a Tuesday)
- True Crime Book Club (monthly)
- Tiny Hearts Club / Book'nic (monthly)

Add these to the Google Sheet as one-time events.

---

## Quick Reference

### Common Venues & Addresses

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
| Victoria Community Center | 2905 E. North St. |
| DeLeon Civic Center | 203 N. Glass St. |

### Icon Tags (for reference)
🍔 food · 🎵 music · 👨‍👩‍👧‍👦 family · 🍺 drinks · 🎨 arts · 🛍️ shopping · 🏃 outdoors · 📅 community · 🆓 free

---

## Troubleshooting

**"The site doesn't show my event"**
→ Events are pulled from the Google Sheet during the Sunday 6 PM run. If you add something later in the week, it won't show up until the next Sunday's run unless you manually trigger the **Weekly Collect** workflow:

```bash
gh workflow run "Weekly Collect"
```

**"There are duplicate events"**
→ The system deduplicates automatically. If you see a duplicate, it may have slightly different names from two sources. It'll usually resolve on the next run with AI cleanup.

**"Weekend events are thin"**
→ This is the main area where your weekly scan helps. Saturday & Sunday rely heavily on what you find on Facebook and venue pages.

---

## Venue Discovery (Background Process)

A second automated step runs at Sunday 6 PM **before** the collector:
`discover_venues.py` queries Google Maps (via the Apify
`compass/google-maps-extractor` actor) for 8 categories — bars, restaurants,
live music venues, theaters, museums, bowling alleys, event venues, and
community centers in Victoria, TX. Each result is scored:

- **HIGH-tier matches** (rating ≥ 4.2, ≥ 50 reviews, event-likely category,
  Facebook or Instagram present) are auto-merged into `venues.json`.
- **MEDIUM-tier matches** (lower rating or fewer reviews, but with social
  presence) land in `pending_venues.json` for you to review when convenient.
- **SKIP** means closed, fast-food chain, < 3.5 stars, or no social — they
  never surface.

To stop a venue from being re-suggested, add it to `rejected_venues.json`
(name field at minimum). The existing `facebook_venues.json` list is kept as
a safety floor — venues already in it are never dropped, even if Google
Maps disagrees. If the Apify monthly cap is hit or the token is missing,
discovery quietly skips and the collector keeps using whatever venue list
was last good.
