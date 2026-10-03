#!/usr/bin/env python3
"""
The Vic 361 — Event Collector
Fetches events from public Victoria, TX sources and outputs candidates.json
(raw/unscreened) plus, optionally, docs/events.json (the bundled fallback
the static site reads when the Railway Postgres store has nothing).

Source of truth for the live site:
  - In production, the Express app on Railway serves /events.json from
    Postgres (the `published_events` table written by the admin's
    Save & Publish flow). This is the live, curated source.
  - docs/events.json is a static bundled SNAPSHOT used as a fallback when
    Railway has not yet published anything (fresh deploy) or when the site
    is served directly from GitHub Pages without the Express layer.
  - candidates.json is the full collector output — every raw event the
    scrapers found this run, ready for the admin to screen and pick from.

Because docs/events.json is committed to the repo and serves as a fallback,
the weekly CI run uses --candidates-only so it does NOT overwrite the
curated fallback with un-screened, un-published events. Local/manual runs
without that flag keep the old behavior for backward compatibility.

Data sources (in priority order):
  1. local_events.yaml — manually curated + recurring events (BACKBONE)
  2. City of Victoria calendar — individual event pages scraped
  3. Victoria Chamber of Commerce — event detail pages
  4. OpenAI API — extracts events from FB/IG posts and polishes
     descriptions + icons on the merged data (optional)

Usage:
  pip install -r requirements.txt
  python collect_events.py                          # writes candidates.json + ./events.json
  python collect_events.py --candidates-only        # CI-safe: only writes candidates.json
  python collect_events.py --output /path/to.json   # custom output path
  python collect_events.py --days 14                # 14 days ahead (default: 7)
  python collect_events.py --skip-web               # local YAML only
  python collect_events.py --skip-ai                # skip AI cleanup
"""

import argparse
import html
import json
import os
import re
import sys
from collections import Counter
from difflib import SequenceMatcher
from datetime import datetime, timedelta
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup
import yaml


# ─── SENTRY (silent failure observability) ──────────────────────────────────
# We instrument scrapers for two failure modes:
#   1. Hard exceptions (network errors, parse crashes) → capture_exception
#   2. Silent zero-event returns when we'd normally expect events →
#      capture_message at warning level
# Sentry stays disabled gracefully if SENTRY_DSN is not set or the SDK
# isn't installed.

_SENTRY_ENABLED = False
try:
    import sentry_sdk  # type: ignore
    _dsn = os.environ.get("SENTRY_DSN", "").strip()
    if _dsn:
        sentry_sdk.init(
            dsn=_dsn,
            traces_sample_rate=0.0,
            environment=os.environ.get("SENTRY_ENVIRONMENT", "thevic361-collector"),
            release=os.environ.get("GITHUB_SHA", "local")[:12],
        )
        _SENTRY_ENABLED = True
except Exception:
    _SENTRY_ENABLED = False


def _sentry_warn(message, **tags):
    if _SENTRY_ENABLED:
        try:
            with sentry_sdk.push_scope() as scope:
                for k, v in tags.items():
                    scope.set_tag(k, v)
                sentry_sdk.capture_message(message, level="warning")
        except Exception:
            pass


def _sentry_exception(scraper):
    if _SENTRY_ENABLED:
        try:
            with sentry_sdk.push_scope() as scope:
                scope.set_tag("scraper", scraper)
                sentry_sdk.capture_exception()
        except Exception:
            pass


# ─── PER-SOURCE COLLECTION STATS ────────────────────────────────────────────
# Every scraper invocation through safe_fetch (and load_local_events) records
# one entry here so collect_events.py can write a small metadata file the
# admin "Sources" tab consumes. Counts here are pre-merge/dedup — they reflect
# what each source returned this run, not how many made it past dedup.
_SOURCE_STATS = []


def _record_source_stat(name, count, status, started_at, finished_at, message=None):
    """Append a stats entry. Idempotent within a run; one entry per call."""
    entry = {
        "name": name,
        "count": int(count or 0),
        "status": status,  # "ok" | "empty" | "error" | "skipped"
        "started_at": started_at,
        "finished_at": finished_at,
    }
    if message:
        entry["message"] = str(message)[:300]
    _SOURCE_STATS.append(entry)


def reset_source_stats():
    """Clear per-run stats. Called at the top of main() and useful in tests."""
    _SOURCE_STATS.clear()


def get_source_stats():
    """Return a copy of the per-run stats list."""
    return list(_SOURCE_STATS)


def safe_fetch(name, fn, args=(), expect_events=True):
    """Wrap a scraper call so exceptions are captured + zero-event runs reported.

    `name` is a short scraper id (e.g. 'library', 'chamber').
    `fn` is the fetch function. `args` is a tuple of positional args.
    If `expect_events` and the scraper returns 0 results, we send a Sentry
    warning so we know about silent breakage without crashing the run.
    Always returns a list (empty on failure).

    Side effect: records a per-source stats entry consumed by the admin
    "Sources" tab via collection_metadata.json.
    """
    started = datetime.now().isoformat(timespec="seconds")
    try:
        result = fn(*args)
        if not isinstance(result, list):
            result = list(result or [])
        # Tag every event with the scraper it came from, so dedupe can prefer
        # official sources and the admin can see where a candidate came from.
        for ev in result:
            if isinstance(ev, dict):
                ev.setdefault("_source", name)
        finished = datetime.now().isoformat(timespec="seconds")
        if len(result) == 0:
            if expect_events:
                _sentry_warn(
                    f"[scraper] {name} returned 0 events",
                    scraper=name,
                )
            _record_source_stat(name, 0, "empty", started, finished)
        else:
            _record_source_stat(name, len(result), "ok", started, finished)
        return result
    except Exception as e:
        _sentry_exception(name)
        import traceback
        print(f"  [{name}] CRASHED: ", end="")
        traceback.print_exc()
        finished = datetime.now().isoformat(timespec="seconds")
        _record_source_stat(name, 0, "error", started, finished, message=str(e))
        return []


# ─── DATE WINDOW HELPERS ─────────────────────────────────────────────────────
# The site renders Mon–Sun of the current week + lookahead. We must collect
# events starting from THIS Monday, not just "today", or earlier days of the
# week render as "Nothing listed yet."

def week_start_date(today=None):
    """Return the Monday of the current calendar week (in local time)."""
    today = today or datetime.now().date()
    return today - timedelta(days=today.weekday())  # weekday(): Mon=0


def date_window(days_ahead=14, backfill_to_monday=True):
    """Return (start_date, end_date) for collection.

    If backfill_to_monday is True, start = Monday of this week (so the site's
    Mon–Sun grid never shows empty days). Otherwise start = today.
    """
    today = datetime.now().date()
    start = week_start_date(today) if backfill_to_monday else today
    end = today + timedelta(days=days_ahead)
    return start, end


# Module-level window — set once in main() and read by every scraper.
# Defaults handle ad-hoc invocations (tests, --list, etc).
_WINDOW_START, _WINDOW_END = date_window(14, True)


def in_window(d):
    """Check if a date object is inside the active collection window."""
    return _WINDOW_START <= d <= _WINDOW_END


# ─── CONFIG ──────────────────────────────────────────────────────────────────

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# Some sites (Cloudflare-protected) reject the standard Chrome UA. Use Safari
# as a fallback — lower bot-detection score on most CDNs.
HEADERS_SAFARI = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
TIMEOUT = 15


def http_get(url, headers=None, timeout=TIMEOUT, fallback_safari=True):
    """GET with the standard browser UA. If we hit a 403 (Cloudflare-style
    challenge) and fallback_safari is True, retry with Safari UA.
    Returns the requests.Response (already raise_for_status()-ed)."""
    h = dict(headers) if headers else dict(HEADERS)
    resp = requests.get(url, headers=h, timeout=timeout)
    if resp.status_code == 403 and fallback_safari:
        resp = requests.get(url, headers=HEADERS_SAFARI, timeout=timeout)
    resp.raise_for_status()
    return resp

# Icon categories — keywords in event name/desc/venue trigger auto-tagging
# Known venue URLs — fallback when an event has no specific URL
VENUE_URLS = {
    "aero crafters": "https://aerocrafters.pub",
    "moonshine drinkery": "https://www.moonshinedrinkery.com",
    "victoria public library": "https://www.victoriapubliclibrary.org",
    "victoria farmers market": "https://www.facebook.com/VictoriaFarmersMarket",
    "riverside park": "https://www.victoriatx.gov/1330/Parks-Recreation",
    "deleon plaza": "https://www.victoriatx.gov",
    "victoria fine arts center": "https://victoriafinearts.org",
    "museum of the coastal bend": "https://museumofthecoastalbend.org",
    "nave museum": "https://navemuseum.org",
    "leo j. welder center": "https://www.weldercenter.org",
    "the hideaway": "https://www.facebook.com/TheHideawayVictoriaTX",
    "j welch farms": "https://jwelchfarms.com/events/",
    "theatre victoria": "https://theatrevictoria.org",
    "riverside stadium": "https://victoriagenerals.com",
    "froggy's grub & pub": "https://froggysgrubandpub.com",
    "detar hospital": "https://www.detar.com",
    "victoria country club": "https://victoriacc.com",
}

# Description templates by icon category — used when no description available
DESC_TEMPLATES = {
    "music":    "Live music in Victoria. Check the venue for lineup details.",
    "family":   "Family-friendly event at {venue}. Free and open to all ages.",
    "food":     "Food and community at {venue}. Come hungry.",
    "drinks":   "Drinks and good times at {venue}.",
    "arts":     "Arts event at {venue}. Open to the public.",
    "outdoors": "Outdoor activity in Victoria. Bring the family.",
    "community":"Community event open to the public.",
    "shopping": "Local vendors and shopping at {venue}.",
}

CATEGORY_KEYWORDS = {
    "music":     ["music", "concert", "band", "live music", "jazz", "acoustic",
                  "dj", "karaoke", "open mic", "k-pop", "kpop", "symphony", "trivia"],
    "food":      ["food", "restaurant", "bbq", "taco", "dinner", "lunch",
                  "brunch", "cook", "chef", "farmers market", "taste", "delicatessen"],
    "drinks":    ["beer", "wine", "cocktail", "brew", "drinkery", "bar ",
                  " pub ", "tasting", "happy hour", "moonshine"],
    "family":    ["kids", "children", "family", "youth", "teen", "lego",
                  "story time", "storytime", "puppet", "camp", "spring break",
                  "balloon", "learning lab", "fun friday", "discoveru"],
    "arts":      ["art", "gallery", "museum", "painting", "exhibit",
                  "exhibition", "theater", "theatre", "dance", "ballet",
                  "pottery", "yarn", "artworks", "sculpture"],
    "shopping":  ["market", "vendor", "shop", "sale", "bazaar", "fair", "flea"],
    "outdoors":  ["walk", "run", "hike", "park", "outdoor", "nature", "trail",
                  "garden", "fishing", "kayak", "bike", "stroll", "strolls"],
    "community": ["meeting", "club", "volunteer", "chamber", "council",
                  "workshop", "class", "seminar", "fundraiser", "benefit",
                  "gala", "rec night", "social", "book club"],
}


def classify_icons(name, description="", venue=""):
    """Auto-assign icon tags based on text content."""
    text = f"{name} {description} {venue}".lower()
    icons = []
    for cat, keywords in CATEGORY_KEYWORDS.items():
        if any(kw in text for kw in keywords):
            icons.append(cat)
    return icons or ["community"]


def guess_free(name, description="", venue=""):
    """Heuristic: is the event free?"""
    text = f"{name} {description} {venue}".lower()
    if any(kw in text for kw in ["free", "no cost", "complimentary", "free admission"]):
        return True
    if any(kw in text for kw in ["ticket", "cover charge", "admission $"]):
        return False
    if any(kw in text for kw in ["library", "museum", "public"]):
        return True
    return False


# ─── SOURCE: LOCAL YAML (backbone) ──────────────────────────────────────────

def load_local_events(yaml_path, days_ahead=7):
    """Load recurring + one-time events from the YAML file.

    Wrapped in defensive error handling: a malformed local_events.yaml
    (bad indentation, an editor mid-save, etc.) must NOT crash the whole
    collector run. We log a Sentry warning so the breakage is visible,
    print a console message for the GitHub Actions log, and return an
    empty list so the rest of the pipeline (web scrapers, AI review,
    candidates.json) still gets to run.
    """
    events = []
    today = _WINDOW_START
    end_date = _WINDOW_END

    if not os.path.exists(yaml_path):
        print(f"  [Local] File not found: {yaml_path}")
        _sentry_warn(
            f"[local_events] YAML file not found: {yaml_path}",
            scraper="local_events",
        )
        return events

    try:
        with open(yaml_path, "r") as f:
            data = yaml.safe_load(f) or {}
    except (yaml.YAMLError, OSError, UnicodeDecodeError) as e:
        # YAML parse error or I/O error — surface to Sentry but keep the run alive.
        print(f"  [Local] Failed to read/parse {yaml_path}: {e}")
        _sentry_exception("local_events")
        return events
    except Exception as e:  # pragma: no cover - last-resort safety net
        print(f"  [Local] Unexpected error reading {yaml_path}: {e}")
        _sentry_exception("local_events")
        return events

    if not isinstance(data, dict):
        # YAML loaded but isn't a mapping (e.g. someone replaced the file
        # with a stray list). Treat as empty rather than crashing later.
        print(f"  [Local] {yaml_path} did not contain a mapping; skipping.")
        _sentry_warn(
            f"[local_events] YAML root is not a mapping in {yaml_path}",
            scraper="local_events",
        )
        return events

    DAY_MAP = {
        "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
        "friday": 4, "saturday": 5, "sunday": 6,
    }

    # Recurring events — per-entry try/except so one bad row doesn't take down the whole list.
    for ev in data.get("recurring", []) or []:
        try:
            if not isinstance(ev, dict):
                continue
            dow = DAY_MAP.get(ev.get("day", "").lower())
            if dow is None:
                continue
            start = datetime.strptime(ev["start_date"], "%Y-%m-%d").date() if ev.get("start_date") else today - timedelta(days=1)
            end = datetime.strptime(ev["end_date"], "%Y-%m-%d").date() if ev.get("end_date") else end_date + timedelta(days=365)

            d = today
            while d <= end_date:
                if d.weekday() == dow and start <= d <= end:
                    events.append({
                        "date": d.strftime("%Y-%m-%d"),
                        "name": ev["name"],
                        "time": ev.get("time", ""),
                        "venue": ev.get("venue", ""),
                        "address": ev.get("address", ""),
                        "description": ev.get("description", ""),
                        "icons": ev.get("icons", []),
                        "free": ev.get("free", False),
                        "url": ev.get("url", ""),
                    })
                d += timedelta(days=1)
        except (ValueError, KeyError, TypeError) as e:
            print(f"  [Local] Skipping malformed recurring entry: {e}")
            _sentry_warn(
                "[local_events] malformed recurring entry skipped",
                scraper="local_events",
            )
            continue

    # One-time events
    for ev in data.get("events", []) or []:
        if not ev or not ev.get("date"):
            continue
        try:
            ev_date = datetime.strptime(ev["date"], "%Y-%m-%d").date()
            if today <= ev_date <= end_date:
                events.append({
                    "date": ev["date"],
                    "name": ev["name"],
                    "time": ev.get("time", ""),
                    "venue": ev.get("venue", ""),
                    "address": ev.get("address", ""),
                    "description": ev.get("description", ""),
                    "icons": ev.get("icons", []),
                    "free": ev.get("free", False),
                    "url": ev.get("url", ""),
                })
        except (ValueError, KeyError):
            continue

    print(f"  [Local] {len(events)} events from YAML")
    return events


# ─── SOURCE: CITY OF VICTORIA CALENDAR ───────────────────────────────────────

def fetch_city_calendar(days_ahead=7):
    """Scrape event detail pages from victoriatx.gov CivicPlus calendar."""
    events = []
    today = datetime.combine(_WINDOW_START, datetime.min.time())
    end_date = datetime.combine(_WINDOW_END, datetime.min.time())

    try:
        # Get the calendar page to find event detail links
        url = "https://www.victoriatx.gov/Calendar.aspx"
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")

        # Collect unique event IDs from links like Calendar.aspx?EID=XXXX
        eids = set()
        for link in soup.select("a[href*='EID=']"):
            href = link.get("href", "")
            match = re.search(r'EID=(\d+)', href)
            if match:
                eids.add(match.group(1))

        print(f"  [City Calendar] Found {len(eids)} event IDs, fetching details...")

        # Fetch each event detail page (limit to avoid hammering)
        for eid in sorted(eids)[:30]:
            try:
                detail_url = f"https://www.victoriatx.gov/Calendar.aspx?EID={eid}"
                detail_resp = requests.get(detail_url, headers=HEADERS, timeout=TIMEOUT)
                if detail_resp.status_code != 200:
                    continue
                detail_soup = BeautifulSoup(detail_resp.text, "html.parser")

                # CivicPlus: event name is the <title> after "Calendar • "
                page_title = detail_soup.find("title")
                title = page_title.get_text(strip=True) if page_title else ""
                title = re.sub(r'^Calendar\s*[•·\-]\s*', '', title)
                title = re.sub(r'\s*[-–]\s*Victoria,?\s*TX$', '', title)
                title = title.strip()

                # Also try h2 elements (CivicPlus puts event name in h2 after "Event Details")
                if not title or title.lower() in ["calendar", "event details", ""]:
                    for h2 in detail_soup.select("h2"):
                        h2_text = h2.get_text(strip=True)
                        if h2_text and h2_text.lower() not in ["event details", "search calendars by:", "calendar"]:
                            title = h2_text
                            break

                if not title or title.lower() in ["calendar", "event details"]:
                    continue

                page_text = detail_soup.get_text()

                # CivicPlus format: "Date: March 16, 2026" in page text
                event_date = None
                date_match = re.search(
                    r'Date:\s*(\w+day,?\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})',
                    page_text
                )
                if date_match:
                    try:
                        dt = datetime.strptime(
                            f"{date_match.group(2)} {date_match.group(3)} {date_match.group(4)}",
                            "%B %d %Y"
                        )
                        if today.date() <= dt.date() <= end_date.date():
                            event_date = dt.strftime("%Y-%m-%d")
                    except ValueError:
                        pass

                # Fallback: ISO date in page source (2026-03-16T15:30:00)
                if not event_date:
                    iso_match = re.search(r'(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}', page_text)
                    if iso_match:
                        try:
                            dt = datetime.strptime(iso_match.group(1), "%Y-%m-%d")
                            if today.date() <= dt.date() <= end_date.date():
                                event_date = dt.strftime("%Y-%m-%d")
                        except ValueError:
                            pass

                if not event_date:
                    continue

                # CivicPlus format: "Time: 3:30 PM - 4:30 PM"
                time_str = ""
                time_match = re.search(
                    r'(?:Time:\s*)?(\d{1,2}:\d{2}\s*(?:AM|PM))\s*[-–]\s*(\d{1,2}:\d{2}\s*(?:AM|PM))',
                    page_text
                )
                if time_match:
                    time_str = f"{time_match.group(1).strip()} \u2013 {time_match.group(2).strip()}"

                # Location: extract venue name and address from CivicPlus format
                # Pattern in page: "Victoria Public Library Address: 302 N. Main StreetVictoria, TX 77901"
                venue = ""
                address = ""
                loc_match = re.search(
                    r'Location:\s*(?:View\s+(?:Map|Facility))?\s*(.+?)\s*(?:Address:|Contact:|Email:|Link:|Map|$)',
                    page_text
                )
                if loc_match:
                    venue = re.sub(r'\s+', ' ', loc_match.group(1)).strip()
                    # Remove boilerplate
                    venue = re.sub(r'(?:View|Find)\s+(?:a\s+)?(?:Facility|Map)', '', venue, flags=re.IGNORECASE).strip()

                # Try to extract address separately
                addr_match = re.search(
                    r'Address:\s*(\d+[^\n]{5,50}?)(?:Victoria|Contact|Email)',
                    page_text
                )
                if addr_match:
                    address = re.sub(r'\s+', ' ', addr_match.group(1)).strip().rstrip(',')

                # Fallback: infer common Victoria venues from event title
                if not venue or venue.lower() in ['find a facility', 'view facility', '']:
                    if any(kw in title.lower() for kw in [
                        'story time', 'lego', 'chess', 'yarn', 'k-pop',
                        'book club', 'rec night', 'inbetween', 'discoveru',
                        'fun friday', 'learning lab', 'craft club', 'teen tech'
                    ]):
                        venue = 'Victoria Public Library'
                        address = address or '302 N. Main St.'

                # Get description from fr-view or main content
                desc = ""
                desc_el = detail_soup.select_one(".fr-view, .moduleContent")
                if desc_el:
                    # Get first meaningful paragraph
                    for p in desc_el.select("p"):
                        p_text = p.get_text(strip=True)
                        if p_text and len(p_text) > 15:
                            desc = p_text[:150]
                            break

                events.append({
                    "date": event_date,
                    "name": title,
                    "time": time_str,
                    "venue": venue,
                    "address": address,
                    "description": desc,
                    "icons": classify_icons(title, desc, venue),
                    "free": guess_free(title, desc, venue),
                    "url": detail_url,
                })

            except Exception:
                continue

        print(f"  [City Calendar] Extracted {len(events)} dated events")

    except Exception as e:
        print(f"  [City Calendar] Error: {e}")

    return events


# ─── SOURCE: CHAMBER OF COMMERCE ─────────────────────────────────────────────

def fetch_chamber_events(days_ahead=7):
    """Scrape events from Victoria Chamber of Commerce."""
    events = []
    today = datetime.combine(_WINDOW_START, datetime.min.time())
    end_date = datetime.combine(_WINDOW_END, datetime.min.time())

    try:
        url = "https://business.victoriachamber.org/events"
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")

        # GrowthZone event cards — find detail page links
        detail_links = set()
        for a in soup.select("a[href*='/events/details/']"):
            href = a.get("href", "")
            if href:
                full_url = urljoin(url, href)
                detail_links.add(full_url)

        print(f"  [Chamber] Found {len(detail_links)} detail links, fetching...")

        for detail_url in sorted(detail_links)[:20]:
            try:
                detail_resp = requests.get(detail_url, headers=HEADERS, timeout=TIMEOUT)
                if detail_resp.status_code != 200:
                    continue
                ds = BeautifulSoup(detail_resp.text, "html.parser")

                # Parse event title
                title_el = ds.select_one("h1, .gz-pagetitle, .event-name")
                title = title_el.get_text(strip=True) if title_el else ""
                if not title:
                    continue

                # Parse date from page content
                page_text = ds.get_text()
                event_date = None

                # Look for date in URL slug (e.g., "03-18-2026")
                slug_match = re.search(r'(\d{2})-(\d{2})-(\d{4})', detail_url)
                if slug_match:
                    try:
                        dt = datetime.strptime(
                            f"{slug_match.group(1)}/{slug_match.group(2)}/{slug_match.group(3)}",
                            "%m/%d/%Y"
                        )
                        if today.date() <= dt.date() <= end_date.date():
                            event_date = dt.strftime("%Y-%m-%d")
                    except ValueError:
                        pass

                # Fallback: look for date in page text
                if not event_date:
                    date_match = re.search(
                        r'(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})',
                        page_text
                    )
                    if date_match:
                        try:
                            dt = datetime.strptime(
                                f"{date_match.group(1)} {date_match.group(2)} {date_match.group(3)}",
                                "%B %d %Y"
                            )
                            if today.date() <= dt.date() <= end_date.date():
                                event_date = dt.strftime("%Y-%m-%d")
                        except ValueError:
                            pass

                if not event_date:
                    continue

                # Parse time
                time_str = ""
                time_match = re.search(
                    r'(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))\s*(?:[-–to]+)\s*(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))',
                    page_text
                )
                if time_match:
                    time_str = f"{time_match.group(1)} – {time_match.group(2)}"

                # Parse venue / location
                venue = ""
                address = ""
                loc_el = ds.select_one("[class*='location'], [class*='venue'], [class*='address']")
                if loc_el:
                    loc_text = loc_el.get_text(" ", strip=True)
                    # Clean up multi-line location text
                    loc_text = re.sub(r'\s+', ' ', loc_text).strip()
                    # Try to split venue name from address
                    # Common pattern: "Venue Name 123 Street Victoria, TX 77901"
                    addr_match = re.search(r'(\d+\s+[\w\s.]+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Blvd|Hwy|Way))', loc_text, re.IGNORECASE)
                    if addr_match:
                        address = addr_match.group(1).strip()
                        venue = loc_text[:addr_match.start()].strip().rstrip(',')
                        if not venue:
                            venue = loc_text
                    else:
                        venue = loc_text
                    # Remove "Location" prefix
                    venue = re.sub(r'^Location\s*', '', venue, flags=re.IGNORECASE).strip()

                # Description
                desc = ""
                desc_el = ds.select_one("[class*='description'], .gz-details-description, .event-description")
                if desc_el:
                    desc = desc_el.get_text(strip=True)[:150]

                events.append({
                    "date": event_date,
                    "name": title,
                    "time": time_str,
                    "venue": venue,
                    "address": address,
                    "description": desc,
                    "icons": classify_icons(title, desc, venue),
                    "free": guess_free(title, desc, venue),
                    "url": detail_url,
                })

            except Exception:
                continue

        print(f"  [Chamber] Extracted {len(events)} dated events")

    except Exception as e:
        print(f"  [Chamber] Error: {e}")

    return events


# ─── SOURCE: VICTORIA PUBLIC LIBRARY CALENDAR ────────────────────────────────

def fetch_library_events(days_ahead=7):
    """Scrape events from the Victoria Public Library calendar.

    Site uses LibraryCalendar (Drupal). Each event is an <article class="event-card">
    containing:
      - <h3 class="lc-event__title"><a aria-label="View Details - 'TITLE' on DAY, MONTH D, YYYY @ TIME" href="/event/...">TITLE</a></h3>
      - <div class="lc-event-info-item--time">9:30am–10:00am</div>
      - <div class="lc-date-icon">
          <span class="lc-date-icon__item--month">Apr</span>
          <span class="lc-date-icon__item--day">23</span>
          <span class="lc-date-icon__item--year">2026</span>
        </div>

    We iterate week-by-week across the collection window so we don't miss
    events past the first visible page.
    """
    events = []
    seen = set()  # de-dupe by (date, title, time)

    MONTH_MAP = {
        "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
        "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
    }

    def fmt_time(t):
        # Normalize "9:30am–10:00am" -> "9:30 AM – 10:00 AM"
        if not t:
            return ""
        t = t.strip().replace("\u2013", "–").replace("-", "–")
        m = re.search(r'(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*–\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))', t, re.IGNORECASE)
        if m:
            return f"{m.group(1).upper()} – {m.group(2).upper()}"
        m = re.search(r'(\d{1,2}(?::\d{2})?\s*(?:am|pm))', t, re.IGNORECASE)
        return m.group(1).upper() if m else ""

    # Walk forward one week at a time so we cover the full window.
    cur = _WINDOW_START
    week_count = 0
    while cur <= _WINDOW_END and week_count < 4:  # safety cap
        week_count += 1
        url = f"https://victoriapl.librarycalendar.com/events/week/{cur.strftime('%Y/%m/%d')}"
        try:
            resp = http_get(url)
            resp.raise_for_status()
        except Exception as e:
            print(f"  [Library] Week {cur} fetch error: {e}")
            cur = cur + timedelta(days=7)
            continue

        soup = BeautifulSoup(resp.text, "html.parser")

        for art in soup.select("article.event-card, article.node--type-lc-event"):
            # Title + URL
            link_el = art.select_one("h3.lc-event__title a, a.lc-event__link")
            if not link_el:
                continue
            title = link_el.get_text(strip=True)
            if not title or len(title) < 3:
                continue
            href = link_el.get("href", "")
            event_url = urljoin("https://victoriapl.librarycalendar.com", href) if href else ""

            # Date — prefer the lc-date-icon (canonical, with year)
            event_date = None
            month_el = art.select_one(".lc-date-icon__item--month")
            day_el = art.select_one(".lc-date-icon__item--day")
            year_el = art.select_one(".lc-date-icon__item--year")
            if month_el and day_el and year_el:
                try:
                    mon = MONTH_MAP.get(month_el.get_text(strip=True).lower()[:4].rstrip("."))
                    if mon is None:
                        mon = MONTH_MAP.get(month_el.get_text(strip=True).lower()[:3])
                    day = int(day_el.get_text(strip=True))
                    year = int(year_el.get_text(strip=True))
                    dt = datetime(year, mon, day).date()
                    event_date = dt.strftime("%Y-%m-%d")
                except (ValueError, TypeError, AttributeError):
                    pass

            # Fallback: parse aria-label like 'View Details - "X" on Thursday, April 23, 2026 @ 9:30am'
            if not event_date:
                aria = link_el.get("aria-label", "") or ""
                m = re.search(
                    r'on\s+\w+,\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})',
                    aria
                )
                if m:
                    try:
                        dt = datetime.strptime(f"{m.group(1)} {m.group(2)} {m.group(3)}", "%B %d %Y").date()
                        event_date = dt.strftime("%Y-%m-%d")
                    except ValueError:
                        pass

            if not event_date:
                continue

            # Filter to our window
            try:
                d_obj = datetime.strptime(event_date, "%Y-%m-%d").date()
                if not in_window(d_obj):
                    continue
            except ValueError:
                continue

            # Time
            time_el = art.select_one(".lc-event-info-item--time, .lc-event__date .lc-event-info-item--time")
            time_raw = time_el.get_text(strip=True) if time_el else ""
            time_str = fmt_time(time_raw)

            # Categories → description hint
            cat_el = art.select_one(".lc-event-info__item--categories")
            description = cat_el.get_text(" ", strip=True) if cat_el else ""

            key = (event_date, title.lower(), time_str)
            if key in seen:
                continue
            seen.add(key)

            events.append({
                "date": event_date,
                "name": title,
                "time": time_str,
                "venue": "Victoria Public Library",
                "address": "302 N. Main St.",
                "description": description,
                "icons": classify_icons(title, description, "Victoria Public Library"),
                "free": True,
                "url": event_url,
            })

        cur = cur + timedelta(days=7)

    print(f"  [Library] Extracted {len(events)} events")
    return events


# ─── SOURCE: VTX ART WALK ────────────────────────────────────────────────────

def fetch_vtx_artwalk(days_ahead=8):
    """Scrape next event date from vtxartwalk.com."""
    events = []
    today = _WINDOW_START
    end_date = _WINDOW_END

    try:
        url = "https://vtxartwalk.com/"
        # Cloudflare-fronted — needs Safari UA fallback
        resp = http_get(url)
        text = resp.text

        # Look for "Next Art Walk Event Month D, YYYY" pattern
        match = re.search(
            r'Next Art Walk Event\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})',
            text, re.IGNORECASE
        )
        if match:
            try:
                ev_date = datetime.strptime(
                    f"{match.group(1)} {match.group(2)} {match.group(3)}", "%B %d %Y"
                ).date()
                if today <= ev_date <= end_date:
                    events.append({
                        "date": ev_date.strftime("%Y-%m-%d"),
                        "name": "VTX Art & Music Walk",
                        "time": "4:00 PM – 8:00 PM",
                        "venue": "Downtown Victoria",
                        "address": "Main St, Victoria, TX",
                        "description": "Quarterly art walk through downtown Victoria — local galleries, live music, artists, and food.",
                        "icons": classify_icons("art music walk", "galleries artists", "downtown"),
                        "free": True,
                        "url": url,
                    })
                    print(f"  [VTX Art Walk] Next event: {ev_date}")
                else:
                    print(f"  [VTX Art Walk] Next event {ev_date} outside window")
            except ValueError:
                pass
        else:
            print(f"  [VTX Art Walk] No upcoming date found")

    except Exception as e:
        print(f"  [VTX Art Walk] Error: {e}")

    return events


# ─── SOURCE: MOONSHINE DRINKERY ─────────────────────────────────────────────

def fetch_moonshine_events(days_ahead=8):
    """Scrape upcoming events from Moonshine Drinkery homepage."""
    events = []
    today = _WINDOW_START
    end_date = _WINDOW_END

    try:
        url = "https://www.moonshinedrinkery.com"
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        text = soup.get_text()

        # Pattern: "March 21 2026: Live Band Karaoke"
        matches = re.findall(
            r'(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s+(\d{4})\s*[:\-]\s*(.+)',
            text
        )
        for month, day, year, name in matches:
            name = name.strip().rstrip('\n').split('\n')[0].strip()
            if not name or len(name) < 3:
                continue
            try:
                ev_date = datetime.strptime(f"{month} {day} {year}", "%B %d %Y").date()
                if ev_date < today or ev_date > end_date:
                    continue
            except ValueError:
                continue

            events.append({
                "date": ev_date.strftime("%Y-%m-%d"),
                "name": name,
                "time": "",
                "venue": "Moonshine Drinkery",
                "address": "103 W. Santa Rosa St.",
                "description": "",
                "icons": classify_icons(name, "", "Moonshine Drinkery"),
                "free": guess_free(name, "", "Moonshine Drinkery"),
                "url": url,
            })

        print(f"  [Moonshine] {len(events)} events")

    except Exception as e:
        print(f"  [Moonshine] Error: {e}")

    return events


# ─── OPENAI (shared LLM helper) ─────────────────────────────────────────────
#
# Every LLM call in the collector (AI review + FB/IG post extraction) goes
# through _openai_chat. Perplexity Sonar was removed in Oct 2026, and its
# web-search discovery source went with it: OpenAI chat completions don't
# search the web, and the scrapers + Apify already cover the same venues.
#
# The payload sticks to fields every current chat model accepts: no
# temperature (gpt-5-family models reject non-default values) and
# max_completion_tokens instead of the deprecated max_tokens. Reasoning
# models spend part of that budget thinking before they answer, so the
# callers' limits are generous and reasoning_effort is pinned low to keep
# the ~80 weekly calls inside the workflow step timeout.
#
# Set OPENAI_MODEL to try another model without a code change.

OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
_OPENAI_DEFAULT_MODEL = "gpt-5-mini"


def _openai_model():
    return os.environ.get("OPENAI_MODEL", "").strip() or _OPENAI_DEFAULT_MODEL


def _openai_chat(api_key, messages, max_tokens, timeout=60):
    """POST a chat completion and return the reply text.

    Raises requests.HTTPError on a non-2xx so callers can log the status.
    """
    model = _openai_model()
    payload = {
        "model": model,
        "messages": messages,
        "max_completion_tokens": max_tokens,
    }
    # reasoning_effort is rejected by non-reasoning models (gpt-4o, gpt-4.1),
    # so only send it to the families that accept it.
    if model.startswith(("gpt-5", "o")):
        payload["reasoning_effort"] = "low"
    resp = requests.post(
        OPENAI_CHAT_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=timeout,
    )
    resp.raise_for_status()
    return (resp.json()["choices"][0]["message"].get("content") or "").strip()


def _parse_ai_json_array(content):
    """Parse LLM output that should contain a JSON array.

    Tries multiple strategies in order. Returns the first list-of-dicts that
    parses cleanly, or None on total failure.

    Why this exists: models sometimes prepend a footnote like "[1]" or wrap
    the answer in prose like "Here are the events: [...]". A single greedy
    regex couldn't handle either case and silently dropped the entire
    response, costing us ~10 events per run back when Sonar was the model.
    """
    if not content:
        return None
    content = content.strip()

    # Strategy 1: direct json.loads (cleanest case — model followed instructions)
    try:
        parsed = json.loads(content)
        if isinstance(parsed, list):
            return parsed
        if isinstance(parsed, dict) and isinstance(parsed.get("events"), list):
            return parsed["events"]
    except (json.JSONDecodeError, ValueError):
        pass

    # Strategy 2: find balanced top-level arrays in the text and try the
    # largest first (small ones are usually citation refs like [1]).
    candidates = []
    depth = 0
    start = -1
    for i, ch in enumerate(content):
        if ch == '[':
            if depth == 0:
                start = i
            depth += 1
        elif ch == ']':
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    candidates.append(content[start:i+1])
                    start = -1
    for cand in sorted(candidates, key=len, reverse=True):
        try:
            parsed = json.loads(cand)
            if isinstance(parsed, list) and parsed and isinstance(parsed[0], dict):
                return parsed
        except (json.JSONDecodeError, ValueError):
            continue

    return None


# ─── AI REVIEW (description + icons polish) ─────────────────────────────────
#
# What this does:
#   For every collected event, ask OpenAI to:
#     1. Rewrite the description as ≤160 chars, max 2 short sentences,
#        no emojis, no venue/date repetition, neutral local-newsletter tone.
#     2. Pick 1–3 icons from the canonical set, ranked by relevance.
#     3. Re-evaluate the `free` flag (true / false).
#
# It does NOT change name, date, time, venue, address, or url — those come
# from the source of truth (yaml/scrapers) and shouldn't be invented by AI.
#
# Calls are batched (default 8 events per request) so we only make ~10–15
# API calls per daily run instead of one giant prompt or one-call-per-event.
#
# Degrades gracefully:
#   - No OPENAI_API_KEY → skip, return events untouched.
#   - The model returns malformed JSON for a batch → keep that batch's originals.
#   - Per-event response missing fields → keep that event's original values.

VALID_ICONS = {"food", "music", "family", "drinks", "arts",
               "shopping", "outdoors", "community", "free"}

_AI_REVIEW_SYSTEM_PROMPT = """You are an editor for The Vic 361, a weekly community events website for Victoria, TX. Your job is to polish event descriptions and assign icons so the site reads consistently and professionally.

For each event you receive, return:
  - description: ≤160 characters, max 2 short sentences. Neutral, friendly local-newsletter tone. NO emojis. Do NOT repeat the event name, venue name, address, date, or time (the site already shows those). If the input description has no useful info beyond what's already in the name/venue, write a brief 1-line description of what attendees can expect based on the event type.
  - icons: 1–3 strings from this exact set: food, music, family, drinks, arts, shopping, outdoors, community, free. Order by relevance (most representative first). Use "free" only when the event is genuinely free to attend.
  - free: boolean, true if the event is free to attend.
  - keep: boolean. false when this is NOT a real event someone can attend at a set time and place, for example a job or internship posting, "now booking" field trips or parties, a menu or daily special with nothing happening, a "National ___ Day" post, a giveaway, a closure or holiday-hours notice, or registration for something that isn't on this date. When unsure, keep: true.

Icon guidance:
  - food: meals, food trucks, tastings, farmers markets, BBQ, restaurants
  - music: live music, concerts, DJs, open mics, karaoke
  - family: kid-friendly, story time, baby/toddler events, all-ages
  - drinks: bars, breweries, wineries, beer/wine/cocktail events (21+)
  - arts: art shows, theatre, gallery, crafts, dance, painting
  - shopping: markets with vendors, pop-ups, retail events, craft fairs
  - outdoors: parks, hiking, sports, festivals held outside, gardening
  - community: meetings, fundraisers, civic, volunteer, library programs
  - free: zero cost to attend (also set free=true)

Return ONLY a JSON array, one object per input event in the same order, each: {"description": "...", "icons": [...], "free": true|false, "keep": true|false}. No prose, no markdown fences."""


_EMOJI_RE = re.compile(
    "["
    "\U0001F300-\U0001F5FF"   # symbols & pictographs
    "\U0001F600-\U0001F64F"   # emoticons
    "\U0001F680-\U0001F6FF"   # transport & map symbols
    "\U0001F700-\U0001F77F"   # alchemical symbols
    "\U0001F780-\U0001F7FF"   # geometric shapes extended
    "\U0001F800-\U0001F8FF"   # supplemental arrows-c
    "\U0001F900-\U0001F9FF"   # supplemental symbols & pictographs
    "\U0001FA00-\U0001FA6F"   # chess symbols
    "\U0001FA70-\U0001FAFF"   # symbols & pictographs extended-a
    "\U00002600-\U000027BF"   # miscellaneous symbols + dingbats
    "\U0001F000-\U0001F2FF"   # mahjong, domino, playing cards, enclosed alphanumeric
    "\U0001F100-\U0001F1FF"   # enclosed alphanumeric supplement (regional flags)
    "\U0001F200-\U0001F2FF"   # enclosed ideographic supplement
    "\U0001F300-\U0001F3FF"   # weather, plants, food, sports
    "]",
    flags=re.UNICODE,
)


def _strip_emojis(text):
    """Remove emoji + symbol characters from a string."""
    if not text:
        return text
    return _EMOJI_RE.sub("", text).strip()


def _ai_review_batch(api_key, batch):
    """Send a single batch of events to OpenAI; return list of {description, icons, free} dicts (same length as batch) or None on failure."""
    # Build a slim payload — only the fields the AI needs to make decisions.
    payload = [
        {
            "name": ev.get("name", ""),
            "date": ev.get("date", ""),
            "time": ev.get("time", ""),
            "venue": ev.get("venue", ""),
            "raw_description": ev.get("description", "")[:600],
            "current_icons": ev.get("icons", []),
        }
        for ev in batch
    ]

    user_msg = (
        f"Review and polish these {len(batch)} events. "
        f"Return a JSON array of {len(batch)} objects in the same order.\n\n"
        f"{json.dumps(payload, ensure_ascii=False)}"
    )

    try:
        content = _openai_chat(
            api_key,
            [
                {"role": "system", "content": _AI_REVIEW_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            # 8 events × ~60 output tokens is small, but reasoning tokens
            # count against this limit too. Too low returns an empty reply.
            max_tokens=8000,
            timeout=60,
        )
    except Exception as e:
        print(f"  [AI Review] Batch request failed: {e}")
        _sentry_warn("ai_review_request_failed", error=str(e)[:200])
        return None

    # Strip markdown fences if the model added them.
    if content.startswith("```"):
        content = re.sub(r"^```\w*\n?", "", content)
        content = re.sub(r"\n?```$", "", content)

    # Some responses include prose before the JSON — extract the array.
    match = re.search(r"\[\s*\{.*\}\s*\]", content, re.DOTALL)
    if match:
        content = match.group(0)

    try:
        parsed = json.loads(content)
    except Exception as e:
        print(f"  [AI Review] JSON parse failed: {e}")
        _sentry_warn("ai_review_parse_failed", error=str(e)[:200])
        return None

    if not isinstance(parsed, list) or len(parsed) != len(batch):
        print(f"  [AI Review] Bad shape: got {type(parsed).__name__} "
              f"len={len(parsed) if isinstance(parsed, list) else 'n/a'}, "
              f"expected list len={len(batch)}")
        return None

    return parsed


def ai_review(events, batch_size=8):
    """Polish descriptions + reassign icons via OpenAI.

    Mutates events in place AND returns the list. Each event:
      - description: rewritten to ≤160 chars, no emojis
      - icons: filtered to 1–3 valid values, ordered by relevance
      - free: re-evaluated boolean

    Falls back to the original event values when AI is unavailable or
    a batch fails.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("  [AI Review] No OPENAI_API_KEY — skipping")
        return events
    if not events:
        return events

    print(f"  [AI Review] Reviewing {len(events)} events in batches of {batch_size}…")
    polished = 0
    failed_batches = 0

    for i in range(0, len(events), batch_size):
        batch = events[i:i + batch_size]
        result = _ai_review_batch(api_key, batch)
        if result is None:
            failed_batches += 1
            continue

        for ev, ai in zip(batch, result):
            if not isinstance(ai, dict):
                continue

            # Description: trust AI; clamp + strip emojis as belt-and-suspenders.
            new_desc = ai.get("description")
            if isinstance(new_desc, str) and new_desc.strip():
                cleaned = _strip_emojis(new_desc).strip()
                if len(cleaned) > 200:  # hard ceiling, AI was told 160
                    cleaned = cleaned[:197].rstrip() + "…"
                ev["description"] = cleaned

            # Icons: keep only valid values, dedupe, cap at 3.
            new_icons = ai.get("icons")
            if isinstance(new_icons, list):
                seen = set()
                cleaned_icons = []
                for ic in new_icons:
                    if not isinstance(ic, str):
                        continue
                    ic = ic.strip().lower()
                    if ic in VALID_ICONS and ic not in seen:
                        seen.add(ic)
                        cleaned_icons.append(ic)
                    if len(cleaned_icons) == 3:
                        break
                if cleaned_icons:
                    ev["icons"] = cleaned_icons

            # Free flag: trust AI bool, keep `free` icon in sync.
            new_free = ai.get("free")
            if isinstance(new_free, bool):
                ev["free"] = new_free
                if new_free and "free" not in ev.get("icons", []):
                    if len(ev.get("icons", [])) < 3:
                        ev["icons"] = ev.get("icons", []) + ["free"]
                elif not new_free and "free" in ev.get("icons", []):
                    ev["icons"] = [ic for ic in ev["icons"] if ic != "free"]

            # Not a real event (job post, booking ad, menu...): drop it.
            if ai.get("keep") is False:
                ev["_ai_drop"] = True

            polished += 1

    dropped = [ev for ev in events if ev.pop("_ai_drop", False)]
    if dropped:
        events[:] = [ev for ev in events if ev not in dropped]
        print(f"  [AI Review] Dropped {len(dropped)} non-events:")
        for ev in dropped[:15]:
            print(f"     – {ev.get('date')} {ev.get('name', '')[:60]}")

    print(f"  [AI Review] Polished {polished}/{len(events)} events "
          f"({failed_batches} batches fell back to originals)")
    if failed_batches:
        _sentry_warn("ai_review_partial_failure",
                     failed_batches=failed_batches, total_events=len(events))
    return events


_LISTING_URL_RES = [
    re.compile(r"eventbrite\.[a-z.]+/(b|d)/", re.I),
    re.compile(r"allevents\.in/[^/]+/?(all|this-weekend|today|tomorrow|[a-z-]+-events)?/?([?#]|$)", re.I),
    re.compile(r"facebook\.com/events/?(explore|search|discover)?/?([?#]|$)", re.I),
]


def is_listing_url(url):
    """True for search/category pages that don't point at one event."""
    return bool(url) and any(r.search(url.strip()) for r in _LISTING_URL_RES)


_LINK_CHECK_SKIP = re.compile(r"(facebook|instagram|fb)\.com", re.I)


def drop_dead_links(events, get=None, timeout=10):
    """Blank links that answer 404/410 so nobody lands on a dead page.

    Each unique URL is checked once. Network errors and bot blocks (403,
    429...) keep the link; only a definite "not found" removes it. Facebook
    and Instagram are skipped since they answer every bot with a login page.
    """
    get = get or (lambda u: requests.get(u, headers=HEADERS, timeout=timeout, allow_redirects=True, stream=True))
    status = {}
    dead = 0
    for ev in events:
        url = (ev.get("url") or "").strip()
        if not url or _LINK_CHECK_SKIP.search(url):
            continue
        if url not in status:
            try:
                resp = get(url)
                status[url] = resp.status_code
                close = getattr(resp, "close", None)
                if close:
                    close()
            except Exception:
                status[url] = None
        if status[url] in (404, 410):
            ev["url"] = ""
            dead += 1
    if dead:
        print(f"  [Links] Removed {dead} dead link(s): "
              + ", ".join(u for u, c in status.items() if c in (404, 410)))
    return events


# ─── FILL GAPS (description + url) ──────────────────────────────────────────

def fill_gaps(events):
    """Fill missing descriptions and URLs using venue lookups and templates."""
    for ev in events:
        if is_listing_url(ev.get("url")):
            ev["url"] = ""
        # Fill URL from venue lookup if missing
        if not ev.get("url"):
            venue_lower = ev.get("venue", "").lower()
            for key, url in VENUE_URLS.items():
                if key in venue_lower:
                    ev["url"] = url
                    break

        # Fill description from template if missing
        if not ev.get("description"):
            icons = ev.get("icons", [])
            venue = ev.get("venue", "this venue")
            # Use first matching template
            for icon in icons:
                if icon in DESC_TEMPLATES:
                    ev["description"] = DESC_TEMPLATES[icon].format(venue=venue)
                    break
            if not ev.get("description"):
                ev["description"] = f"Event at {venue} in Victoria, TX."

    return events


# ─── QUALITY: location, venue cleanup, fuzzy dedupe ───────────────────────────
#
# Why this exists (from the 2026-09-28 run): the same event arrived from two
# or three sources under slightly different names ("Tejas Fest" vs "Tejas
# Fest 2026", "Disney Pixar's Finding Nemo JR." vs "Disney's Finding Nemo
# JR") and slipped past the exact/prefix dedupe; AllEvents put the full
# street address in the venue field; and nothing checked that a scraped
# event was actually in Victoria.

# Victoria County ZIP codes. Victoria proper is 77901/77904/77905; the rest
# are county towns we're happy to list (Inez, Nursery, Bloomington,
# Placedo, Telferner, McFaddin).
VICTORIA_AREA_ZIPS = {"77901", "77902", "77903", "77904", "77905",
                      "77968", "77976", "77951", "77977", "77988", "77960"}

# Towns near enough to show up in regional feeds but not ours. Street names
# like "Houston Hwy" or "Port Lavaca Dr" are real Victoria addresses, so a
# match followed by a street suffix doesn't count.
_OTHER_TOWNS = [
    "cuero", "port lavaca", "goliad", "edna", "yoakum", "hallettsville",
    "shiner", "corpus christi", "houston", "san antonio", "austin",
    "refugio", "ganado", "seadrift", "el campo", "wharton", "beeville",
    "kenedy", "yorktown", "point comfort", "palacios", "rockport",
    "port o'connor", "port oconnor", "gonzales", "bay city",
]
_STREET_SUFFIX = r"(?:hwy|highway|st|street|ave|avenue|rd|road|dr|drive|blvd|ln|lane|hwy\.|loop|pkwy)\b"
_OTHER_TOWN_RE = re.compile(
    r"\b(" + "|".join(re.escape(t) for t in _OTHER_TOWNS) + r")\b(?!\s+" + _STREET_SUFFIX + r")",
    re.IGNORECASE,
)


def out_of_area_reason(ev):
    """Return why an event looks like it's outside Victoria County, or None.

    Only the location fields are checked (venue + address), plus an explicit
    ", <Town>, TX" in the description, so an event *about* Houston held in
    Victoria still passes.
    """
    loc = " ".join(str(ev.get(k) or "") for k in ("venue", "address"))
    for z in re.findall(r"\b(7\d{4})\b", loc):
        if z not in VICTORIA_AREA_ZIPS:
            return f"zip {z}"
    m = _OTHER_TOWN_RE.search(loc)
    if m and not re.search(r"\bvictoria\b", loc, re.IGNORECASE):
        return f"town {m.group(1).lower()}"
    m = re.search(r",\s*(" + "|".join(re.escape(t) for t in _OTHER_TOWNS) + r"),?\s*(?:tx|texas)\b",
                  str(ev.get("description") or ""), re.IGNORECASE)
    if m:
        return f"town {m.group(1).lower()}"
    return None


_ADDRESSY = re.compile(r"^\d+\s+\w|,\s*(?:victoria|tx|texas)\b|\b7\d{4}\b", re.IGNORECASE)


def clean_venue(ev, venues=None):
    """Fix venue/address mix-ups in place.

    AllEvents often puts "101 N. Main St, Victoria, TX, United States, Texas
    77901" in the venue field. Move it to address and, when the street
    matches a venue in venues.json, use that venue's name.
    """
    venue = (ev.get("venue") or "").strip()
    if not venue or not _ADDRESSY.search(venue):
        return ev
    street = venue.split(",")[0].strip()
    if not (ev.get("address") or "").strip():
        ev["address"] = street
    ev["venue"] = street
    key = _street_key(street)
    for v in venues or []:
        if key and _street_key(v.get("address") or "") == key and v.get("name"):
            ev["venue"] = v["name"]
            break
    return ev


def _street_key(addr):
    """'101 N. Main St' and '101 North Main Street' → '101 main'."""
    a = re.sub(r"[^a-z0-9 ]", " ", (addr or "").lower())
    words = [w for w in a.split() if w not in {
        "n", "s", "e", "w", "north", "south", "east", "west",
        "st", "street", "ave", "avenue", "rd", "road", "dr", "drive", "blvd", "ln", "lane",
        "suite", "ste", "victoria", "tx", "texas", "united", "states"}]
    words = [w for w in words if not re.fullmatch(r"7\d{4}", w)]
    return " ".join(words[:2])


_NAME_STOP = {"the", "a", "an", "at", "in", "of", "and", "with", "for", "on", "annual", "presents"}
_MONTHS = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*"


def _name_tokens(name):
    n = (name or "").lower().replace("&", " and ")
    n = re.sub(r"[\u2019']s\b", "", n)                       # "Disney's" → "disney"
    n = re.sub(r"\b20\d{2}\b", " ", n)                      # years
    n = re.sub(r"\b" + _MONTHS + r"\s+\d{1,2}(?:st|nd|rd|th)?\b", " ", n)  # "October 10th"
    n = re.sub(r"\$\d+(?:\.\d+)?", " ", n)                   # prices
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    return [w for w in n.split() if w not in _NAME_STOP]


def _same_place(a, b):
    """True when two events share a venue or street address (or one is blank)."""
    va, vb = (a.get("venue") or "").lower(), (b.get("venue") or "").lower()
    if not va or not vb:
        return True
    if va in vb or vb in va:
        return True
    ka, kb = _street_key(a.get("address") or a.get("venue")), _street_key(b.get("address") or b.get("venue"))
    return bool(ka) and ka == kb


def is_same_event(a, b):
    """Fuzzy match for two events on the same date."""
    if a.get("date") != b.get("date"):
        return False
    ta, tb = _name_tokens(a.get("name")), _name_tokens(b.get("name"))
    if not ta or not tb:
        return False
    sa, sb = " ".join(ta), " ".join(tb)
    if sa == sb:
        return True
    if SequenceMatcher(None, sa, sb).ratio() >= 0.85:
        return True
    # One name contains the other ("6th Realm Night Market" vs "6th Realm
    # Night Market Street spots"): only a match at the same place, so
    # "Tejas Fest" doesn't swallow "Chihuahua Races at Tejas Fest".
    small, big = (set(ta), set(tb)) if len(ta) <= len(tb) else (set(tb), set(ta))
    if len(small) >= 2 and small <= big and _same_place(a, b):
        return True
    return False


# Higher wins when two sources describe the same event: an official
# calendar beats an aggregator beats a social post.
SOURCE_RANK = {
    "local_events": 10, "google_sheet": 9, "city_calendar": 8, "library": 8,
    "chamber": 7, "theatre_victoria": 7, "jwelch": 7, "generals": 7,
    "apify_eventbrite": 5,
    "moonshine": 6, "vtx_artwalk": 6, "allevents": 4, "apify_facebook": 4,
    "apify_facebook_posts": 3, "apify_instagram_posts": 3,
}


# venues.json entries that are organizers rather than places ("Discover
# Victoria Texas", promoters, festivals). Their posts name the account, not
# where the event happens, so a real venue from another source wins.
# Exact organizer words only: "Public Library / Community Programs" is a
# place, so a bare "program" match is wrong.
_NON_PLACE_CATEGORY = re.compile(r"aggregator|promoter|\bfestival\b|\bmedia\b|events hub|online", re.IGNORECASE)
_NON_PLACE_NAMES = set()


def _set_non_place_names(venues):
    _NON_PLACE_NAMES.clear()
    for v in venues or []:
        if v.get("name") and _NON_PLACE_CATEGORY.search(v.get("category") or ""):
            _NON_PLACE_NAMES.add(v["name"].lower())


def _merge_pair(old, new):
    """Combine two records of the same event into the best single record."""
    def completeness(e):
        return sum(1 for k in ("time", "venue", "address", "description", "url") if e.get(k))

    def rank(e):
        return (SOURCE_RANK.get(e.get("_source"), 0), completeness(e))

    base, other = (new, old) if rank(new) > rank(old) else (old, new)
    merged = dict(base)
    for k in ("time", "venue", "address", "description", "url"):
        if not merged.get(k) and other.get(k):
            merged[k] = other[k]
    if (merged.get("venue") or "").lower() in _NON_PLACE_NAMES and other.get("venue") \
            and other["venue"].lower() not in _NON_PLACE_NAMES:
        merged["venue"] = other["venue"]
        merged["address"] = other.get("address") or ""
    # The shorter name is usually the clean one ("Tejas Fest" over "Tejas
    # Fest 2026 - Presented by ...").
    if other.get("name") and len(other["name"]) < len(merged.get("name") or ""):
        merged["name"] = other["name"]
    merged["icons"] = list(dict.fromkeys((base.get("icons") or []) + (other.get("icons") or [])))[:4]
    merged["free"] = bool(base.get("free") or other.get("free"))
    merged["_sources"] = sorted(set((old.get("_sources") or [old.get("_source")]) +
                                    (new.get("_sources") or [new.get("_source")])) - {None})
    return merged


# ─── MERGE + DEDUPLICATE ─────────────────────────────────────────────────────

# Posts and listings that aren't events someone can attend. Kept narrow on
# purpose (the AI review catches subtler cases when OPENAI_API_KEY is set):
# from the 2026-09-28 run, "Internship Program", "Field Trip Booking" and
# "National Drink Beer Day" all reached the admin as events.
_NON_EVENT_RE = re.compile(
    r"\b(internships?|now hiring|we'?re hiring|hiring now|job opening|apply now|applications? (?:open|due)"
    r"|field trips? book(?:ing)?|book(?:ing)? (?:now|your|a) (?:field trip|party|event)|now booking"
    r"|gift cards?|giveaway|closed (?:for|today|on)|holiday hours|new hours|our hours)\b",
    re.IGNORECASE,
)
_NATIONAL_DAY_RE = re.compile(r"^\s*national\b.*\bday\b", re.IGNORECASE)


def non_event_reason(ev):
    """Return why a scraped item isn't an attendable event, or None."""
    name = ev.get("name") or ""
    if _NON_EVENT_RE.search(name):
        return "not an event"
    # "National Drink Beer Day" with no time is a social post, not a party.
    if _NATIONAL_DAY_RE.search(name) and not (ev.get("time") or "").strip():
        return "awareness day"
    return None


def _clean_text(value):
    """Decode HTML entities ("Texas A&amp;M") and collapse whitespace."""
    return re.sub(r"\s+", " ", html.unescape(value or "")).strip()


def merge_events(all_events, days_ahead=7, venues=None):
    """Filter to the window and Victoria County, clean venues, dedupe, sort."""
    today = _WINDOW_START
    end_date = _WINDOW_END
    if venues is None:
        try:
            venues, _ = _load_venue_list()
        except Exception:
            venues = []

    _set_non_place_names(venues)
    by_date = {}
    dropped_area = []
    dropped_junk = []
    merged_count = 0
    for ev in all_events:
        date_str = ev.get("date", "")
        if not date_str:
            continue
        try:
            ev_date = datetime.strptime(date_str, "%Y-%m-%d").date()
            if ev_date < today or ev_date > end_date:
                continue
        except ValueError:
            continue

        new_entry = {
            "date": date_str,
            "name": _clean_text(ev.get("name")),
            "time": (ev.get("time") or "").strip(),
            "venue": _clean_text(ev.get("venue")),
            "address": _clean_text(ev.get("address")),
            "description": _clean_text(ev.get("description")),
            "icons": list(ev.get("icons") or []),
            "free": bool(ev.get("free", False)),
            "url": "" if is_listing_url(ev.get("url")) else (ev.get("url") or "").strip(),
        }
        if ev.get("_source"):
            new_entry["_source"] = ev["_source"]
        if not new_entry["name"]:
            continue
        clean_venue(new_entry, venues)

        # Hand-curated YAML is trusted; everything scraped must be local
        # and an actual event.
        if new_entry.get("_source") != "local_events":
            reason = out_of_area_reason(new_entry)
            if reason:
                dropped_area.append(f"{new_entry['name'][:50]} ({reason})")
                continue
            reason = non_event_reason(new_entry)
            if reason:
                dropped_junk.append(f"{new_entry['name'][:50]} ({reason})")
                continue

        if not new_entry["icons"]:
            new_entry["icons"] = classify_icons(new_entry["name"], new_entry["description"], new_entry["venue"])
        if new_entry["free"] and "free" not in new_entry["icons"]:
            new_entry["icons"].append("free")

        day = by_date.setdefault(date_str, [])
        for i, existing in enumerate(day):
            if is_same_event(existing, new_entry):
                day[i] = _merge_pair(existing, new_entry)
                merged_count += 1
                break
        else:
            day.append(new_entry)

    final = [e for d in by_date.values() for e in d]
    for e in final:
        # Keep a single public-facing source string for the admin pill.
        srcs = e.pop("_sources", None)
        if srcs and len(srcs) > 1:
            e["_also_from"] = [s for s in srcs if s != e.get("_source")]
    final.sort(key=lambda e: (e["date"], e.get("time") or "ZZ"))
    print(f"   [Quality] merged {merged_count} duplicates, dropped {len(dropped_area)} outside Victoria County, "
          f"{len(dropped_junk)} non-events")
    for d in (dropped_area + dropped_junk)[:20]:
        print(f"     – {d}")
    return final


# ─── LIBRARY CAP ───────────────────────────────────────────────────────────────────────────
#
# The Victoria Public Library publishes ~30+ events per 14-day window — mostly
# recurring weekly kid programs (Toddler Story Time, Baby Hour, Fun Friday).
# Without a cap, the library single-handedly dominates the feed and crowds out
# more interesting bar/restaurant/community content.
#
# Rules:
#   - Hard cap of 2 library events per day, 8 per rolling 7-day window.
#   - Recurring kid programs (toddler/baby/preschool story time) are limited to
#     ONE appearance per 7-day window each — the most recent one wins.
#   - Adult/specialty events (book clubs, lectures, AgriLife, makerspace) take
#     priority and are kept until the daily cap fills up.
# ─────────────────────────────────────────────────────────────────────────────────────────────

_LIBRARY_KID_PATTERNS = re.compile(
    r"\b(toddler|baby hour|baby story|preschool|story time|storytime|fun friday|lego lab|maker'?s? meetup|learning lab|mixed media monday)\b",
    re.IGNORECASE,
)


def _is_library_event(ev):
    url = (ev.get("url") or "").lower()
    venue = (ev.get("venue") or "").lower()
    return "librarycalendar" in url or "victoriapubliclibrary" in url or "victoria public library" in venue


def _is_recurring_kid_program(ev):
    return bool(_LIBRARY_KID_PATTERNS.search(ev.get("name", "")))


def cap_library_events(events, per_day=2, per_week=8):
    """Apply a hard cap on Victoria Public Library events.

    The library calendar dumps 30+ items into our 14-day window. This trims it
    to a sensible volume while preferring adult/specialty programs over
    recurring kid story-time sessions.
    """
    if not events:
        return events

    library_events = [e for e in events if _is_library_event(e)]
    other_events = [e for e in events if not _is_library_event(e)]

    if not library_events:
        return events

    # Step 1: Collapse recurring kid programs to one-per-week each (per program name).
    # "Toddler Story Time" 4x in 14 days → keep the soonest one of each pattern
    # within each rolling 7-day window.
    kid_programs = [e for e in library_events if _is_recurring_kid_program(e)]
    adult_programs = [e for e in library_events if not _is_recurring_kid_program(e)]

    # Bucket kid programs by (normalized name, week-bucket-of-year)
    kid_seen = {}
    for ev in sorted(kid_programs, key=lambda e: e["date"]):
        try:
            d = datetime.strptime(ev["date"], "%Y-%m-%d").date()
        except ValueError:
            continue
        # Anchor on Monday of that week
        week_anchor = (d - timedelta(days=d.weekday())).strftime("%Y-%m-%d")
        name_key = re.sub(r"[^a-z0-9]+", "", ev["name"].lower())[:30]
        bucket = (name_key, week_anchor)
        if bucket not in kid_seen:
            kid_seen[bucket] = ev
    deduped_kid = list(kid_seen.values())

    pruned_library = adult_programs + deduped_kid

    # Step 2: Apply per-day and per-week caps.
    # Sort so adult programs win ties (they are arguably more interesting / less noisy).
    def priority(e):
        # Lower = kept first
        return (0 if not _is_recurring_kid_program(e) else 1, e["date"], e.get("time", "ZZ"))

    pruned_library.sort(key=priority)

    by_day = Counter()
    by_week = Counter()  # week-anchored Monday
    kept = []
    dropped = []
    for ev in pruned_library:
        try:
            d = datetime.strptime(ev["date"], "%Y-%m-%d").date()
        except ValueError:
            kept.append(ev)
            continue
        week_anchor = (d - timedelta(days=d.weekday())).strftime("%Y-%m-%d")
        if by_day[ev["date"]] >= per_day or by_week[week_anchor] >= per_week:
            dropped.append(ev)
            continue
        kept.append(ev)
        by_day[ev["date"]] += 1
        by_week[week_anchor] += 1

    print(f"  [LibraryCap] {len(library_events)} library events → {len(kept)} kept, {len(dropped)} dropped "
          f"({len(kid_programs) - len(deduped_kid)} duplicate kid programs collapsed, "
          f"{len(dropped)} over cap)")

    return sorted(other_events + kept, key=lambda e: (e["date"], e.get("time", "ZZ")))


# ─── LOAD EXTRAS (new_and_notable + sponsor) ─────────────────────────────────

def load_extras(yaml_path):
    if not os.path.exists(yaml_path):
        return {"new_and_notable": [], "sponsor": None}
    try:
        with open(yaml_path, "r") as f:
            data = yaml.safe_load(f) or {}
        return {
            "new_and_notable": data.get("new_and_notable", []),
            "sponsor": data.get("sponsor"),
        }
    except Exception:
        return {"new_and_notable": [], "sponsor": None}


# ─── SOURCE: GOOGLE SHEET (manual submissions) ───────────────────────────────

GOOGLE_SHEET_ID = "1S42hYlrPM516LDTcy3W_8afCkCqc-ZrUfN2J-SmP23I"


def fetch_google_sheet_events(days_ahead=7):
    """Fetch manually submitted events from the Google Sheet."""
    events = []
    today = _WINDOW_START
    end_date = _WINDOW_END

    try:
        # Google Sheets public CSV export URL
        url = f"https://docs.google.com/spreadsheets/d/{GOOGLE_SHEET_ID}/export?format=csv"
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()

        import csv
        import io
        reader = csv.DictReader(io.StringIO(resp.text))

        for row in reader:
            date_str = row.get("Date", "").strip()
            name = row.get("Event Name", "").strip()
            status = row.get("Status", "").strip().lower()

            if not date_str or not name:
                continue

            # Skip events marked as "done" or "skip"
            if status in ["done", "skip", "duplicate"]:
                continue

            # Normalize date — accept YYYY-MM-DD, M/D/YYYY, etc.
            ev_date = None
            for fmt in ["%Y-%m-%d", "%m/%d/%Y", "%m-%d-%Y", "%B %d, %Y", "%b %d, %Y"]:
                try:
                    ev_date = datetime.strptime(date_str, fmt).date()
                    break
                except ValueError:
                    continue

            if not ev_date or ev_date < today or ev_date > end_date:
                continue

            notes = row.get("Notes", "").strip()
            venue = row.get("Venue", "").strip()
            address = row.get("Address", "").strip()
            time_str = row.get("Time", "").strip()

            events.append({
                "date": ev_date.strftime("%Y-%m-%d"),
                "name": name,
                "time": time_str,
                "venue": venue,
                "address": address,
                "description": notes[:150] if notes else "",
                "icons": classify_icons(name, notes, venue),
                "free": guess_free(name, notes, venue),
                "url": "",
            })

        print(f"  [Google Sheet] {len(events)} events from submissions")

    except Exception as e:
        print(f"  [Google Sheet] Error: {e}")

    return events


# ─── SOURCE: J WELCH FARMS ───────────────────────────────────────────────────

def fetch_jwelch_events(days_ahead=7):
    """Scrape events from J Welch Farms WordPress event calendar.
    Their CMS publishes recurring events with stale base dates but correct
    recurrence, so we check each week in the window via tribe-bar-date param.
    """
    events = []
    today = _WINDOW_START
    end_date = _WINDOW_END
    seen_keys = set()

    # Check multiple week windows to catch all events in range
    check_dates = []
    cur = today
    while cur <= end_date:
        check_dates.append(cur.strftime("%Y-%m-%d"))
        cur += timedelta(days=7)

    for check_date in check_dates:
        try:
            url = f"https://jwelchfarms.com/events/list/?tribe-bar-date={check_date}"
            resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
            resp.raise_for_status()
            soup = BeautifulSoup(resp.text, "html.parser")

            for article in soup.select(".tribe-events-calendar-list__event"):
                title_el = article.select_one(".tribe-events-calendar-list__event-title a, h2 a, h3 a")
                if not title_el:
                    continue
                title = title_el.get_text(strip=True)
                event_url = title_el.get("href", "https://jwelchfarms.com/events/")

                time_el = article.select_one("time[datetime]")
                if not time_el:
                    continue
                raw_date = time_el.get("datetime", "")
                if not raw_date:
                    continue
                try:
                    dt = datetime.strptime(raw_date[:10], "%Y-%m-%d").date()
                except ValueError:
                    continue

                if not (today <= dt <= end_date):
                    continue

                event_date = dt.strftime("%Y-%m-%d")
                key = (title, event_date)
                if key in seen_keys:
                    continue
                seen_keys.add(key)

                # Time string
                start_el = article.select_one(".tribe-event-date-start")
                end_el = article.select_one(".tribe-event-time")
                time_str = ""
                if start_el:
                    m = re.search(r'(\d{1,2}:\d{2}\s*(?:am|pm))', start_el.get_text(), re.I)
                    if m:
                        time_str = m.group(1).upper()
                if end_el and time_str:
                    m2 = re.search(r'(\d{1,2}:\d{2}\s*(?:am|pm))', end_el.get_text(), re.I)
                    if m2:
                        time_str += " – " + m2.group(1).upper()

                desc_el = article.select_one(".tribe-events-calendar-list__event-description, .tribe-excerpt")
                desc = desc_el.get_text(strip=True)[:150] if desc_el else "Live music, food, and good times at J Welch Farms."

                events.append({
                    "date": event_date,
                    "name": title,
                    "time": time_str,
                    "venue": "J Welch Farms",
                    "address": "111 Ripple Rd, Victoria, TX",
                    "description": desc,
                    "icons": classify_icons(title, desc, "J Welch Farms"),
                    "free": guess_free(title, desc, ""),
                    "url": event_url,
                })

        except Exception as e:
            print(f"  [J Welch Farms] Error on {check_date}: {e}")

    print(f"  [J Welch Farms] {len(events)} events")
    return events


# ─── SOURCE: THEATRE VICTORIA ─────────────────────────────────────────────────

def fetch_theatre_victoria_events(days_ahead=7):
    """Scrape show listings from Theatre Victoria."""
    events = []
    today = _WINDOW_START
    end_date = _WINDOW_END

    try:
        url = "https://theatrevictoria.org"
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        page_text = soup.get_text(" ", strip=True)

        # Find all date ranges like "April 23-26, 2026" or "July 24-26, ..."
        pattern = re.compile(
            r'(January|February|March|April|May|June|July|August|September|October|November|December)'
            r'\s+(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?,?\s+(\d{4})'
        )

        # Also grab show titles nearby
        show_blocks = soup.select("section, article, .show, .production, [class*='season'], h2, h3, h4, p")

        text_blocks = soup.get_text("\n").split("\n")
        text_blocks = [b.strip() for b in text_blocks if b.strip()]

        skip_words = ["season", "directed", "screenplay", "songs by", "based on",
                      "by william", "betty", "nacio", "arthur", "newsletter", "donate",
                      "volunteer", "contact", "tickets", "audition", "about", "box office"]

        i = 0
        while i < len(text_blocks):
            block = text_blocks[i]
            m = pattern.search(block)
            if m:
                month, day_start, day_end, year = m.group(1), m.group(2), m.group(3), m.group(4)
                # Look backwards for title — skip author/credit lines, find a clean show name
                title = ""
                for j in range(max(0, i-8), i):
                    candidate = text_blocks[j]
                    if (candidate and len(candidate) > 3
                            and not re.search(r'\d{4}', candidate)
                            and not any(w in candidate.lower() for w in skip_words)
                            and not candidate.startswith("By ")
                            and not candidate.startswith("Directed")
                            and not candidate.startswith("Screenplay")
                            and not candidate.startswith("Songs")):
                        title = candidate

                # Also check lines immediately after the date for the title
                if not title or any(w in title.lower() for w in ["sign up", "newsletter", "our"]):
                    for j in range(i+1, min(len(text_blocks), i+5)):
                        candidate = text_blocks[j]
                        if (candidate and len(candidate) > 3
                                and not re.search(r'\d{4}', candidate)
                                and not any(w in candidate.lower() for w in skip_words)
                                and not candidate.startswith("By ")
                                and not candidate.startswith("Directed")):
                            title = candidate
                            break

                if not title or len(title) < 3:
                    i += 1
                    continue

                # Expand date range — add each date in range
                try:
                    start_dt = datetime.strptime(f"{month} {day_start} {year}", "%B %d %Y").date()
                    end_dt = datetime.strptime(f"{month} {day_end or day_start} {year}", "%B %d %Y").date()
                    cur = start_dt
                    while cur <= end_dt:
                        if today <= cur <= end_date:
                            events.append({
                                "date": cur.strftime("%Y-%m-%d"),
                                "name": title,
                                "time": "7:30 PM",
                                "venue": "Theatre Victoria",
                                "address": "203 E. Constitution St, Victoria, TX",
                                "description": f"Live theatre performance. {title} — presented by Theatre Victoria.",
                                "icons": classify_icons(title, "", "Theatre Victoria"),
                                "free": False,
                                "url": "https://theatrevictoria.org",
                            })
                        cur += timedelta(days=1)
                except ValueError:
                    pass
            i += 1

        # Deduplicate by name+date
        seen = {}
        for ev in events:
            k = (ev["name"], ev["date"])
            if k not in seen:
                seen[k] = ev
        events = list(seen.values())
        print(f"  [Theatre Victoria] {len(events)} events")

    except Exception as e:
        print(f"  [Theatre Victoria] Error: {e}")

    return events


# ─── SOURCE: VICTORIA GENERALS ────────────────────────────────────────────────

def fetch_generals_events(days_ahead=7):
    """Scrape home game schedule from Victoria Generals website."""
    events = []
    today = _WINDOW_START
    end_date = _WINDOW_END

    try:
        # Schedule moved from /schedule/games/ → /game-schedule/ in 2026.
        url = "https://victoriagenerals.com/game-schedule/"
        resp = http_get(url)
        soup = BeautifulSoup(resp.text, "html.parser")
        page_text = soup.get_text(" ", strip=True)

        # Look for date patterns + home game indicator
        # Schedule page uses patterns like "June 3" with team names
        month_pattern = re.compile(
            r'(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})'
        )
        year = today.year

        lines = soup.get_text("\n").split("\n")
        lines = [l.strip() for l in lines if l.strip()]

        i = 0
        while i < len(lines):
            line = lines[i]
            m = month_pattern.search(line)
            if m:
                month, day = m.group(1), m.group(2)
                try:
                    dt = datetime.strptime(f"{month} {day} {year}", "%B %d %Y").date()
                    if dt < today:
                        dt = datetime.strptime(f"{month} {day} {year+1}", "%B %d %Y").date()

                    if today <= dt <= end_date:
                        # Check if it's a home game (no "@" before team name)
                        context = " ".join(lines[max(0,i-1):i+3])
                        is_home = "@ " not in context[:20] and "@\n" not in context[:20]
                        # Extract opponent
                        opponent = ""
                        for l in lines[i:i+3]:
                            if any(team in l for team in ["Bombers","Cane Cutters","Rougarou","Ducks","Generals","Oilers","Bats","Lizards"]):
                                opponent = l.strip()
                                break
                        # Time
                        time_m = re.search(r'(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))', context)
                        time_str = time_m.group(1) if time_m else "7:05 PM"

                        if is_home or not opponent:
                            events.append({
                                "date": dt.strftime("%Y-%m-%d"),
                                "name": f"Victoria Generals Baseball" + (f" vs {opponent}" if opponent else " — Home Game"),
                                "time": time_str,
                                "venue": "Riverside Stadium",
                                "address": "1307 E. Rio Grande St, Victoria, TX",
                                "description": "Summer collegiate baseball. Family-friendly, affordable tickets. Theme nights and giveaways.",
                                "icons": classify_icons("baseball game family", "", "Riverside Stadium"),
                                "free": False,
                                "url": "https://victoriagenerals.com",
                            })
                except ValueError:
                    pass
            i += 1

        # Deduplicate
        seen = {}
        for ev in events:
            k = (ev["date"], ev["name"])
            if k not in seen:
                seen[k] = ev
        events = list(seen.values())
        print(f"  [Victoria Generals] {len(events)} home games")

    except Exception as e:
        print(f"  [Victoria Generals] Error: {e}")

    return events


# ─── SOURCE: ALLEVENTS.IN (Victoria, TX aggregator) ──────────────────────────────

# The "all" page only lists the first ~20 events. Category pages surface
# different ones; a page that 404s or changes layout just adds nothing.
ALLEVENTS_PAGES = [
    "https://allevents.in/victoria-tx/all",
    "https://allevents.in/victoria-tx/this-weekend",
    "https://allevents.in/victoria-tx/music",
    "https://allevents.in/victoria-tx/festivals",
    "https://allevents.in/victoria-tx/kids",
    "https://allevents.in/victoria-tx/food-drinks",
    "https://allevents.in/victoria-tx/performances",
    "https://allevents.in/victoria-tx/arts",
    "https://allevents.in/victoria-tx/sports",
]


def fetch_allevents_events(days_ahead=14):
    """Pull events from allevents.in for Victoria, TX across several pages.

    Each page exposes structured Event objects via JSON-LD <script> blocks
    (date, name, url, location). Times appear in the HTML cards (`.date`).
    Events are deduped by URL across pages.
    """
    events = []
    seen_urls = set()
    per_page = []
    for url in ALLEVENTS_PAGES:
        before = len(events)
        try:
            resp = http_get(url)
            resp.raise_for_status()
        except Exception as e:
            per_page.append(f"{url.rsplit('/', 1)[-1]}: error {str(e)[:40]}")
            continue
        _parse_allevents_page(resp.text, events, seen_urls)
        per_page.append(f"{url.rsplit('/', 1)[-1]}: +{len(events) - before}")
    print(f"  [AllEvents] Extracted {len(events)} events ({', '.join(per_page)})")
    return events


def _parse_allevents_page(html_text, events, seen_urls):
    """Append in-window Victoria events from one AllEvents page."""
    soup = BeautifulSoup(html_text, "html.parser")

    # Build eid → time map from HTML cards
    eid_to_time = {}
    for card in soup.select("li.event-card[data-eid]"):
        eid = card.get("data-eid", "")
        date_el = card.select_one(".date")
        if not eid or not date_el:
            continue
        date_text = date_el.get_text(" ", strip=True)
        m = re.search(r'-\s*(\d{1,2}:\d{2}\s*[AP]M)', date_text, re.IGNORECASE)
        if m:
            eid_to_time[eid] = m.group(1).upper()

    spam_terms = (
        "certification training", "classroom training",
        "agile training", "scrum training",
        "project management techniques training",
        "conflict management certification",
        "business case writing",
    )

    for blk in soup.find_all("script", type="application/ld+json"):
        if not blk.string:
            continue
        try:
            data = json.loads(blk.string)
        except Exception:
            continue
        candidates = []
        if isinstance(data, list):
            candidates = data
        elif isinstance(data, dict):
            if data.get("@type") == "Event":
                candidates = [data]
            elif isinstance(data.get("@graph"), list):
                candidates = data["@graph"]
        for ev in candidates:
            if not isinstance(ev, dict) or ev.get("@type") != "Event":
                continue
            name = (ev.get("name") or "").strip()
            start = ev.get("startDate") or ""
            ev_url = (ev.get("url") or "").strip()
            if not name or not start or ev_url in seen_urls:
                continue
            try:
                d_obj = datetime.strptime(start[:10], "%Y-%m-%d").date()
            except ValueError:
                continue
            if not in_window(d_obj):
                continue
            if any(t in name.lower() for t in spam_terms):
                continue

            loc = ev.get("location") or {}
            if isinstance(loc, list):
                loc = loc[0] if loc else {}
            locality = venue = address = ""
            if isinstance(loc, dict):
                venue = (loc.get("name") or "").strip()
                addr = loc.get("address") or {}
                if isinstance(addr, dict):
                    locality = (addr.get("addressLocality") or "").strip()
                    address = (addr.get("streetAddress") or "").strip()
                    if address and "," in address:
                        address = address.split(",")[0].strip()
                elif isinstance(addr, str):
                    address = addr
            # Only Victoria-area events
            if locality and locality.lower() not in ("victoria", ""):
                continue

            time_str = ""
            eid_match = re.search(r'/(\d{10,})(?:/|$)', ev_url)
            if eid_match:
                eid = eid_match.group(1)
                if eid in eid_to_time:
                    time_str = eid_to_time[eid]
                    # Drop midnight-area placeholder times (12–04 AM → "unknown")
                    if re.match(r'^(12|01|02|03|04):\d{2}\s*AM$', time_str):
                        time_str = ""

            import html as _html
            name = _html.unescape(name)

            description = ""
            free = guess_free(name, description, venue)

            events.append({
                "date": d_obj.strftime("%Y-%m-%d"),
                "name": name,
                "time": time_str,
                "venue": venue,
                "address": address,
                "description": description,
                "icons": classify_icons(name, description, venue),
                "free": free,
                "url": ev_url,
            })
            seen_urls.add(ev_url)





# ─── SOURCE: APIFY (Facebook events + posts) ────────────────────────────────────────
#
# We hit two Apify actors:
#
#   1. apify/facebook-events-scraper  → formal Event pages (Theatre Victoria,
#      Nave Museum, big festivals). Reliable when venues bother to create them.
#
#   2. apify/facebook-posts-scraper   → posts from our high-confidence venue
#      list. This is the gap-filler for bars/restaurants that announce events
#      as posts ("Live music tonight 7pm") rather than formal Events. Posts
#      are funneled through an OpenAI prompt that extracts dated events.
#
# Both actors share APIFY_TOKEN and the same hard-limit detection. If the
# monthly cap is hit, we set a tombstone in the workspace so subsequent calls
# in the same run skip immediately rather than wasting 30s per actor.

APIFY_FB_ACTOR = "apify~facebook-events-scraper"
APIFY_FB_POSTS_ACTOR = "apify~facebook-posts-scraper"
APIFY_FB_ALT_ACTOR = "alfalfa~facebook-events-scraper"
APIFY_IG_POSTS_ACTOR = "apify~instagram-post-scraper"
# Eventbrite by city. Picked from the Oct 2026 Apify probe: 40 items for
# Victoria with ISO dates, venue address, isFree and descriptions, ~$0.20
# per 40 results. Lighter alternatives only returned title/date text.
APIFY_EVENTBRITE_ACTOR = "khadinakbar~eventbrite-events-scraper"
APIFY_RUN_TIMEOUT = 240  # seconds we'll wait for the run to finish

# Process-local tombstone: once we see a 403 hard-limit, all later Apify calls
# in this run skip immediately. Reset on each main() invocation.
_APIFY_LIMIT_TRIPPED = False


def _load_venue_list():
    """Return the active venue list, with venues.json as the primary source.

    PR #16 introduced ``venues.json`` (Google Maps-enriched) as the primary
    venue config. We still support the legacy ``facebook_venues.json`` and
    its one-cycle backup ``facebook_venues.backup.json`` to keep the
    Sunday collector running through the transition.
    """
    here = os.path.dirname(__file__) or "."
    for fname in ("venues.json", "facebook_venues.json", "facebook_venues.backup.json"):
        path = os.path.join(here, fname)
        if not os.path.exists(path):
            continue
        try:
            with open(path, "r") as f:
                data = json.load(f)
        except Exception as e:
            print(f"  [venues] Failed to load {fname}: {e}")
            continue
        if isinstance(data, list) and data:
            return data, path
    return [], None


def _apify_hard_limit_tripped(resp_text):
    """Detect Apify's monthly hard-limit response so we can short-circuit."""
    if not resp_text:
        return False
    t = resp_text.lower()
    return "monthly usage hard limit" in t or "usage hard limit exceeded" in t

def _to_central(dt):
    """Convert an aware datetime to America/Chicago (naive ones pass through)."""
    if dt.tzinfo is None:
        return dt
    try:
        from zoneinfo import ZoneInfo
        return dt.astimezone(ZoneInfo("America/Chicago"))
    except Exception:
        return dt


def fetch_apify_eventbrite_events(days_ahead=14):
    """Eventbrite events in Victoria, TX via Apify.

    On by default whenever APIFY_TOKEN is set; EVENTBRITE_ENABLED=0 turns it
    off. EVENTBRITE_MAX caps results (default 60).
    """
    global _APIFY_LIMIT_TRIPPED
    events = []
    if os.environ.get("EVENTBRITE_ENABLED", "1").strip() in ("0", "false", "no"):
        print("  [Eventbrite] Disabled (EVENTBRITE_ENABLED=0)")
        return events
    token = os.environ.get("APIFY_TOKEN", "").strip()
    if not token:
        print("  [Eventbrite] No APIFY_TOKEN — skipping")
        return events
    if _APIFY_LIMIT_TRIPPED:
        print("  [Eventbrite] Apify monthly limit already tripped this run — skipping")
        return events

    payload = {
        "searchQuery": "events in Victoria, TX",
        "location": "Victoria, TX",
        "onlineOnly": False,
        "includeDetails": True,
        "maxResults": _resolve_int_env("EVENTBRITE_MAX", 60),
        "proxyConfiguration": {"useApifyProxy": True, "apifyProxyGroups": ["RESIDENTIAL"]},
    }
    url = f"https://api.apify.com/v2/acts/{APIFY_EVENTBRITE_ACTOR}/run-sync-get-dataset-items?token={token}"
    try:
        resp = requests.post(url, json=payload, timeout=APIFY_RUN_TIMEOUT,
                             headers={"Content-Type": "application/json"})
        if resp.status_code >= 400:
            print(f"  [Eventbrite] HTTP {resp.status_code}: {resp.text[:300]}")
            if resp.status_code == 403 and _apify_hard_limit_tripped(resp.text):
                _APIFY_LIMIT_TRIPPED = True
                _sentry_warn("Apify monthly hard limit tripped", actor=APIFY_EVENTBRITE_ACTOR, status=403)
            return events
        items = resp.json()
    except Exception as e:
        print(f"  [Eventbrite] Run failed: {e}")
        return events
    if not isinstance(items, list):
        print(f"  [Eventbrite] Unexpected response type: {type(items).__name__}")
        return events

    skipped = {"window": 0, "online_or_cancelled": 0, "not_victoria": 0, "no_data": 0}
    for item in items:
        if not isinstance(item, dict) or item.get("error"):
            continue
        if item.get("isOnline") or item.get("isCancelled"):
            skipped["online_or_cancelled"] += 1
            continue
        name = (item.get("name") or "").strip()
        start = str(item.get("startDate") or "")
        try:
            # startDate is local time ("2026-10-03T10:00") with a separate
            # timezone field; take it as-is.
            dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
            if dt.tzinfo is not None:
                dt = _to_central(dt)
        except ValueError:
            dt = None
        if not name or dt is None:
            skipped["no_data"] += 1
            continue
        if not in_window(dt.date()):
            skipped["window"] += 1
            continue

        venue = (item.get("venueName") or "").strip()
        address = (item.get("venueAddressLine1") or "").strip()
        city = (item.get("venueCity") or "").strip()
        region = (item.get("venueRegion") or item.get("venueState") or "").strip()
        loc_text = " ".join([venue, address, city, region, str(item.get("venueAddress") or "")]).lower()
        if "victoria" not in loc_text:
            skipped["not_victoria"] += 1
            continue

        description = (item.get("summary") or item.get("description") or "").strip()[:280]
        time_str = dt.strftime("%-I:%M %p") if (dt.hour or dt.minute) else ""
        free = item.get("isFree")
        events.append({
            "date": dt.strftime("%Y-%m-%d"),
            "name": name,
            "time": time_str,
            "venue": venue,
            "address": address,
            "description": description,
            "icons": classify_icons(name, description, venue),
            "free": bool(free) if free is not None else guess_free(name, description, venue),
            "url": (item.get("url") or "").split("?")[0],
        })

    print(f"  [Eventbrite] Extracted {len(events)} Victoria events ({len(items)} raw, "
          + ", ".join(f"{v} {k}" for k, v in skipped.items()) + ")")
    return events


def _run_apify_search(actor, payload, token):
    """Run an Apify actor synchronously; return its items, or None on failure."""
    global _APIFY_LIMIT_TRIPPED
    url = f"https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items?token={token}"
    try:
        resp = requests.post(url, json=payload, timeout=APIFY_RUN_TIMEOUT,
                             headers={"Content-Type": "application/json"})
        if resp.status_code >= 400:
            print(f"  [Apify FB] {actor} HTTP {resp.status_code}: {resp.text[:300]}")
            if resp.status_code == 403 and _apify_hard_limit_tripped(resp.text):
                _APIFY_LIMIT_TRIPPED = True
                _sentry_warn("Apify monthly hard limit tripped", actor=actor, status=403)
            return None
        items = resp.json()
    except Exception as e:
        print(f"  [Apify FB] {actor} run failed: {e}")
        return None
    if not isinstance(items, list):
        print(f"  [Apify FB] {actor} unexpected response type: {type(items).__name__}")
        return None
    return items


def fetch_apify_facebook_events(days_ahead=14):
    """Run the Apify Facebook Events Scraper actor against our high-value venue
    list (facebook_venues.json) and parse the dataset.

    Requires APIFY_TOKEN env var. Skips silently if not set so local runs
    without the secret still succeed. Also skips if a previous Apify call in
    this run hit the monthly hard limit — no point burning the timeout.
    """
    global _APIFY_LIMIT_TRIPPED
    events = []
    token = os.environ.get("APIFY_TOKEN", "").strip()
    if not token:
        print("  [Apify FB] No APIFY_TOKEN — skipping")
        return events
    if _APIFY_LIMIT_TRIPPED:
        print("  [Apify FB] Monthly hard limit already tripped this run — skipping")
        return events

    venues, venues_path = _load_venue_list()
    if not venues:
        print("  [Apify FB] No venue list found (venues.json / facebook_venues.json)")
        return events
    print(f"  [Apify FB] Using venue list: {os.path.basename(venues_path)}")

    # Apify's facebook-events-scraper does NOT support page-tab URLs like
    # /aerocrafters/events (returns "Invalid events page response"). It DOES
    # support search queries — which is more useful for us anyway since it
    # discovers events from venues we haven't even cataloged yet. We post-filter
    # for Victoria-area events using the address/location text.
    print(f"  [Apify FB] Searching Facebook events for Victoria TX...")

    # Two search actors with the same output schema return different
    # events for the same query (Oct 2026 probe: 39 and 31 Victoria events,
    # little overlap), so run both and dedupe by event id.
    searches = [
        (APIFY_FB_ACTOR, {
            "searchQueries": ["Victoria Texas"],
            # The Oct 2026 probe got 39 Victoria events out of 40 (~$0.39); the
            # old cap of 25 left most of the next two weeks on the table because
            # search results skew toward events months out.
            "maxEvents": _resolve_int_env("FB_EVENTS_MAX", 50),
        }),
    ]
    if os.environ.get("FB_EVENTS_ALT_ENABLED", "1").strip() not in ("0", "false", "no"):
        searches.append((APIFY_FB_ALT_ACTOR, {
            "searchQueries": ["Victoria, Texas"],
            "maxEvents": _resolve_int_env("FB_EVENTS_MAX", 50),
            "scrapeOrganizerContacts": False,
            "maxConcurrency": 10,
            "proxyConfiguration": {"useApifyProxy": True, "apifyProxyGroups": ["RESIDENTIAL"]},
        }))

    items, seen_ids = [], set()
    for actor, payload in searches:
        got = _run_apify_search(actor, payload, token)
        if got is None:
            if _APIFY_LIMIT_TRIPPED:
                break
            continue
        for it in got:
            key = isinstance(it, dict) and (it.get("id") or it.get("url"))
            if key and key in seen_ids:
                continue
            if key:
                seen_ids.add(key)
            items.append(it)
    if not items:
        return events

    skipped_off_window = 0
    skipped_off_locality = 0
    skipped_no_data = 0

    for item in items:
        if not isinstance(item, dict):
            continue
        # Some search results come back as error stubs — skip those
        if item.get("error"):
            continue

        name = (item.get("name") or item.get("title") or "").strip()
        start_iso = (
            item.get("utcStartDate")
            or item.get("startDate")
            or item.get("startTime")
            or item.get("start_time")
            or ""
        )
        if not name or not start_iso:
            skipped_no_data += 1
            continue

        # Parse start date. utcStartDate is UTC: a 7 PM CDT event is 00:00Z
        # the next day, so convert to Victoria time before taking the date.
        try:
            dt = datetime.fromisoformat(str(start_iso).replace("Z", "+00:00"))
            dt = _to_central(dt)
            d_obj = dt.date()
        except Exception:
            try:
                d_obj = datetime.strptime(str(start_iso)[:10], "%Y-%m-%d").date()
                dt = None
            except Exception:
                skipped_no_data += 1
                continue

        if not in_window(d_obj):
            skipped_off_window += 1
            continue

        # Location object: {city, streetAddress, name, contextualName, ...}
        loc = item.get("location") or {}
        if not isinstance(loc, dict):
            loc = {}
        venue = (loc.get("name") or loc.get("contextualName") or "").strip()
        address = (loc.get("streetAddress") or "").strip()
        city = (loc.get("city") or "").strip()

        # Locality filter — only keep events that are clearly in Victoria, TX.
        # Search returns events from anywhere matching the keyword, so we have
        # to gate on city / address / venue text.
        haystack = " ".join([venue, address, city]).lower()
        if "victoria" not in haystack:
            skipped_off_locality += 1
            continue
        # Reject "Victoria, BC" and other non-TX Victorias
        if "victoria" in haystack and "tx" not in haystack and "texas" not in haystack and "77" not in haystack:
            skipped_off_locality += 1
            continue

        # Time string
        time_str = ""
        if dt is not None:
            try:
                time_str = dt.strftime("%-I:%M %p")
            except Exception:
                pass
        if not time_str:
            time_str = (item.get("startTime") or "").split(" at ")[-1].strip()

        description = (item.get("description") or "").strip()[:280]
        ev_url = item.get("url") or item.get("eventUrl") or ""

        events.append({
            "date": d_obj.strftime("%Y-%m-%d"),
            "name": name,
            "time": time_str,
            "venue": venue,
            "address": address,
            "description": description,
            "icons": classify_icons(name, description, venue),
            "free": guess_free(name, description, venue),
            "url": ev_url,
        })

    print(
        f"  [Apify FB] Extracted {len(events)} Victoria events "
        f"({len(items)} raw, {skipped_off_locality} non-Victoria, "
        f"{skipped_off_window} out-of-window, {skipped_no_data} missing data)"
    )
    return events


# ─── SOURCE: APIFY (Facebook posts → OpenAI event extraction) ───────────────
#
# Why this exists: many Victoria bars/restaurants announce events as Facebook
# *posts* ("Live music tonight 8pm with Donny Edwards") rather than formal
# Event pages. The events-scraper actor never sees those, so weeknight density
# at venues like Aero Crafters / Moonshine / The Hideaway / Lone Star is
# systematically thin. This scraper pulls recent posts from each
# high-confidence venue, then asks OpenAI to extract any
# specific-dated events from the post text.
#
# Cost shape (rough): Apify $2/1000 posts × ~9 venues × 25 posts each
#   ≈ 225 posts ≈ $0.45 per run. Plus 1 OpenAI call per venue with posts
#   (≈10 calls, ~$0.005 each) ≈ $0.05. Total ≤ $0.50/run, ~$15/mo daily.
#
# Toggle with FB_POSTS_ENABLED=1 (default off until Apify cap resets).


# Apify resultsLimit per venue page. Bumped 25 → 50 because most low-volume
# venues only had ~1 post in a 14-day window during the first production run
# — a wider net catches recurring-event mentions buried in older posts
# ("Live music every Friday" remains useful even when 20 days old).
_POSTS_PER_VENUE = 50

# Lookback for posts. Bumped 14 → 30 days for the same reason. The extraction
# prompt still constrains *event dates* to the collection window, so older
# posts are only kept when they describe a future-dated or recurring event.
_POSTS_LOOKBACK_DAYS = 30

# Hard ceiling on the number of FB venues we'll scrape in a single run.
# Mirrors _IG_POSTS_MAX_VENUES — added after run 25127431431 where the
# combined FB+IG scrape (36 + 30 venues) consumed ~13 minutes and pushed
# AI Review past the step timeout. ``None`` = no cap (legacy behavior),
# which is what FB has shipped with historically. Override at runtime by
# setting FB_POSTS_MAX_VENUES (env var); a positive integer is treated as
# the cap and applied in venues.json order (which already has high-value
# venues first).
_FB_POSTS_MAX_VENUES = None


def _resolve_int_env(name, default):
    """Read a positive-int env override, falling back to ``default``.

    Empty / unset / unparseable / ``≤ 0`` all fall back to ``default``,
    so a misconfigured workflow variable can never widen the cap into
    runaway territory. Used by the IG/FB venue caps so the weekly job
    can be re-tuned via Settings → Variables → Actions without a code
    change.
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    raw = raw.strip()
    if not raw:
        return default
    try:
        n = int(raw)
    except ValueError:
        return default
    if n <= 0:
        return default
    return n


def _venue_high_confidence(venues):
    """Return venues marked confidence=high in facebook_venues.json."""
    return [v for v in venues if (v.get("confidence") or "").lower() == "high"]


def _extract_events_from_posts_via_ai(venue_name, posts):
    """Send a venue's recent posts to OpenAI and parse out events.

    Returns a list of event dicts (date/name/time/description/url) — venue is
    filled in by the caller.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key or not posts:
        return []

    today = _WINDOW_START
    end_date = _WINDOW_END
    today_str = today.strftime("%Y-%m-%d")
    end_str = end_date.strftime("%Y-%m-%d")

    # Build a compact post digest — trimming each post to ~400 chars to keep
    # the prompt under 4k tokens even with 25 posts.
    lines = []
    for i, p in enumerate(posts, start=1):
        text = (p.get("text") or p.get("caption") or "").strip()
        if not text:
            continue
        text = re.sub(r"\s+", " ", text)[:400]
        post_date = (p.get("time") or p.get("timestamp") or p.get("date") or "")[:10]
        lines.append(f"[{i}] (posted {post_date}) {text}")
    if not lines:
        return []
    posts_blob = "\n".join(lines)

    prompt = f"""You are extracting future events from recent Facebook posts by {venue_name} in Victoria, TX.

Posts:
{posts_blob}

Return ONLY a JSON array of upcoming events mentioned in these posts. Each object:
{{"date":"YYYY-MM-DD","name":"Event Name","time":"7:00 PM or empty string","venue":"Where it happens if NOT at {venue_name} itself, else empty string","description":"One short sentence or empty string","free":true_or_false,"source_post_index":N}}

Rules:
- Only emit events whose ACTUAL DATE falls between {today_str} and {end_str}, regardless of when the post was made. A 20-day-old post announcing "Live music every Friday at 8pm" should produce one entry per upcoming Friday in that window.
- For relative dates ("this Friday", "tomorrow", "next Saturday"), resolve them against the post's own posted-on date — then check the resolved date is in the window.
- Recurring events ("every Wednesday", "Trivia Tuesdays", "weekly karaoke") MUST be expanded into one entry per upcoming occurrence in the window. Do not emit a single placeholder.
- Skip posts that are pure promo, photo dumps, customer thank-yous, or undated announcements.
- Skip events that already happened (post-date BEFORE today's date with no recurring signal).
- Only include events held in Victoria, TX or elsewhere in Victoria County. Skip events in other towns (Cuero, Port Lavaca, Goliad, Edna, Yoakum, Corpus Christi, Houston, etc.).
- Return [] if no events found. No prose, no markdown fences."""

    try:
        content = _openai_chat(
            api_key,
            [{"role": "user", "content": prompt}],
            # Recurring expansion ("every Wednesday" × 3 weeks) can produce
            # 4–8 entries per post × ~50 posts, and reasoning tokens share
            # this budget, so leave plenty of headroom.
            max_tokens=12000,
            timeout=60,
        )
        content = re.sub(r"^```\w*\s*", "", content)
        content = re.sub(r"\s*```\s*$", "", content)
        raw = _parse_ai_json_array(content)
        if raw is None:
            _sentry_warn(
                "FB posts AI parse failed",
                venue=venue_name,
                sample=content[:200],
            )
            return []
        return raw
    except requests.HTTPError as e:
        status = e.response.status_code if e.response else "?"
        _sentry_warn("FB posts AI HTTP error", venue=venue_name, status=str(status))
        return []
    except Exception as e:
        _sentry_warn("FB posts AI exception", venue=venue_name, error=str(e)[:200])
        return []


def _post_event_venue(r, account_name, account_address):
    """Venue + address for an event extracted from an account's post.

    Uses the venue the model named when the event isn't at the account's own
    place; otherwise the account itself (with its known address).
    """
    named = (r.get("venue") or "").strip() if isinstance(r, dict) else ""
    if named and named.lower() not in account_name.lower() and account_name.lower() not in named.lower():
        return named, ""
    return account_name, account_address


def fetch_apify_facebook_posts(days_ahead=14):
    """Pull recent posts from each high-confidence venue page and ask OpenAI to
    extract dated events. Off by default — set FB_POSTS_ENABLED=1 to turn on.

    Pipeline per venue:
      Apify posts-scraper → last 25 posts (≤ 14 days old) → OpenAI event
      extraction → normalized event dicts.
    """
    global _APIFY_LIMIT_TRIPPED
    events = []

    if os.environ.get("FB_POSTS_ENABLED", "").strip() not in ("1", "true", "yes"):
        print("  [Apify FB Posts] Disabled (set FB_POSTS_ENABLED=1 to enable)")
        return events

    token = os.environ.get("APIFY_TOKEN", "").strip()
    if not token:
        print("  [Apify FB Posts] No APIFY_TOKEN — skipping")
        return events
    if _APIFY_LIMIT_TRIPPED:
        print("  [Apify FB Posts] Monthly hard limit already tripped this run — skipping")
        return events
    if not os.environ.get("OPENAI_API_KEY"):
        print("  [Apify FB Posts] No OPENAI_API_KEY — cannot extract events from posts")
        return events

    all_venues, venues_path = _load_venue_list()
    if not all_venues:
        print("  [Apify FB Posts] No venue list found (venues.json / facebook_venues.json)")
        return events
    print(f"  [Apify FB Posts] Using venue list: {os.path.basename(venues_path)}")

    high_conf = _venue_high_confidence(all_venues)
    if not high_conf:
        print("  [Apify FB Posts] No high-confidence venues to scrape")
        return events

    # Optional env-tunable cap (FB_POSTS_MAX_VENUES). Default ``None`` keeps
    # the legacy behavior (no cap) — the weekly job can opt into a step-
    # timeout-safe ceiling via Actions Variables when venues.json grows or
    # IG_POSTS_ENABLED is also on. venues.json order is preserved (the seed
    # already lists high-value pages first), matching how IG drops the
    # lowest-priority targets first.
    fb_cap = _resolve_int_env("FB_POSTS_MAX_VENUES", _FB_POSTS_MAX_VENUES)
    if fb_cap is not None and len(high_conf) > fb_cap:
        dropped = len(high_conf) - fb_cap
        print(
            f"  [Apify FB Posts] Capping {len(high_conf)} → {fb_cap} "
            f"venues for this run (dropped {dropped} lowest-priority)"
        )
        high_conf = high_conf[:fb_cap]

    newer_than = (datetime.now().date() - timedelta(days=_POSTS_LOOKBACK_DAYS)).strftime("%Y-%m-%d")
    print(f"  [Apify FB Posts] Pulling posts from {len(high_conf)} venues (since {newer_than})")

    actor_run_url = (
        f"https://api.apify.com/v2/acts/{APIFY_FB_POSTS_ACTOR}"
        f"/run-sync-get-dataset-items?token={token}"
    )

    venue_stats = []
    for venue in high_conf:
        if _APIFY_LIMIT_TRIPPED:
            venue_stats.append(f"{venue.get('name','?')}: SKIP (limit tripped)")
            break

        venue_name = venue.get("name", "?")
        page_url = venue.get("facebook_page")
        if not page_url:
            venue_stats.append(f"{venue_name}: SKIP (no facebook_page)")
            continue

        payload = {
            "startUrls": [{"url": page_url}],
            "resultsLimit": _POSTS_PER_VENUE,
            "onlyPostsNewerThan": newer_than,
            "captionText": False,
        }

        try:
            resp = requests.post(
                actor_run_url,
                json=payload,
                timeout=APIFY_RUN_TIMEOUT,
                headers={"Content-Type": "application/json"},
            )
        except Exception as e:
            venue_stats.append(f"{venue_name}: ERROR ({type(e).__name__})")
            _sentry_warn("FB posts actor exception", venue=venue_name, error=str(e)[:200])
            continue

        if resp.status_code >= 400:
            venue_stats.append(f"{venue_name}: HTTP {resp.status_code}")
            if resp.status_code == 403 and _apify_hard_limit_tripped(resp.text):
                _APIFY_LIMIT_TRIPPED = True
                _sentry_warn(
                    "Apify monthly hard limit tripped",
                    actor=APIFY_FB_POSTS_ACTOR,
                    status=403,
                )
            else:
                _sentry_warn(
                    "FB posts actor HTTP error",
                    venue=venue_name,
                    status=resp.status_code,
                    body=resp.text[:200],
                )
            continue

        try:
            posts = resp.json()
        except Exception:
            venue_stats.append(f"{venue_name}: bad JSON")
            continue
        if not isinstance(posts, list):
            venue_stats.append(f"{venue_name}: unexpected type {type(posts).__name__}")
            continue

        # The actor returns a single {"error": ...} placeholder item when a
        # page has no reachable posts (renamed page, private, login wall).
        # Counting that as "1 post" hid ~25 dead page URLs for months.
        page_errors = [p for p in posts if isinstance(p, dict) and p.get("error")]
        posts = [p for p in posts if isinstance(p, dict) and not p.get("error")
                 and (p.get("text") or p.get("caption"))]
        if not posts:
            reason = (page_errors[0].get("error") if page_errors else "no posts with text")
            venue_stats.append(f"{venue_name}: 0 posts ({str(reason)[:60]}) — check facebook_page in venues.json")
            continue

        # Hand the posts to OpenAI for event extraction
        raw = _extract_events_from_posts_via_ai(venue_name, posts)
        kept = 0
        for r in raw:
            if not isinstance(r, dict):
                continue
            date_str = (r.get("date") or "").strip()
            name = (r.get("name") or "").strip()
            if not date_str or not name:
                continue
            try:
                d_obj = datetime.strptime(date_str, "%Y-%m-%d").date()
            except ValueError:
                continue
            if not in_window(d_obj):
                continue

            # Try to attach a source URL: prefer the post's URL when the model
            # tagged source_post_index, otherwise fall back to the venue page.
            source_url = page_url
            idx = r.get("source_post_index")
            if isinstance(idx, int) and 1 <= idx <= len(posts):
                post = posts[idx - 1]
                if isinstance(post, dict):
                    source_url = (
                        post.get("url")
                        or post.get("postUrl")
                        or post.get("link")
                        or page_url
                    )

            description = (r.get("description") or "").strip()[:280]
            time_str = (r.get("time") or "").strip()
            # Accounts like "Discover Victoria Texas" post about events held
            # elsewhere; the model names the real venue when it isn't theirs.
            ev_venue, address = _post_event_venue(r, venue_name, (venue.get("address") or "").strip())

            events.append({
                "date": d_obj.strftime("%Y-%m-%d"),
                "name": name,
                "time": time_str,
                "venue": ev_venue,
                "address": address,
                "description": description,
                "icons": classify_icons(name, description, venue_name),
                "free": bool(r.get("free", False)) or guess_free(name, description, venue_name),
                "url": source_url,
            })
            kept += 1
        venue_stats.append(f"{venue_name}: {len(posts)} posts → {kept} events")

    print(f"  [Apify FB Posts] Extracted {len(events)} events across {len(high_conf)} venues")
    for s in venue_stats:
        print(f"    • {s}")
    return events


# ─── INSTAGRAM POSTS → OPENAI ────────────────────────────────────────────────
#
# Mirror of fetch_apify_facebook_posts but against Instagram. Same OpenAI prompt
# is reused (captions and FB post text look similar enough — many Victoria
# venues just cross-post). Tier-aware so we burn fewer credits on lower-tier
# discoveries:
#
#   HIGH   tier → 25 posts each, 14-day lookback
#   MEDIUM tier → 15 posts each, 14-day lookback
#
# Cost shape (rough): Apify $2/1000 posts × ~9 HIGH × 25 + ~10 MEDIUM × 15
#   ≈ 375 posts ≈ $0.75 per run. Plus ~1 OpenAI call per venue with posts
#   (≈15 calls, ~$0.005 each) ≈ $0.08. Total ≤ $0.85/run.
#
# Toggle with IG_POSTS_ENABLED=1 (default off until production-validated).

_IG_POSTS_PER_HIGH = 25
_IG_POSTS_PER_MEDIUM = 15
_IG_POSTS_LOOKBACK_DAYS = 14
# Hard ceiling on the number of IG venues we'll scrape in a single run, even
# if venues.json grows. HIGH venues are processed first, then MEDIUM, so the
# cap drops the lowest-value targets when the list gets long. Set so the
# worst-case bill stays at most ~$1.50 per run while we're still validating
# IG_POSTS_ENABLED in production.
#
# Lowered 30 → 20 after run 25127431431: with the PR #45 venues.json seed
# (26 HIGH + 4 MEDIUM = 30 IG-capable venues) the IG scrape consumed ~7m17s
# at ~14.5s/venue and crowded the AI Review tail past the 15-min step
# timeout. 20 venues × 14.5s ≈ 4m50s leaves headroom for FB Posts + AI
# Review under the bumped 25-min step ceiling. Override at runtime by
# setting IG_POSTS_MAX_VENUES (env var) — useful for backfill runs or
# venue-list growth without re-deploying the workflow.
_IG_POSTS_MAX_VENUES = 20


def _venue_tier(venue):
    """Best-effort tier classification for a venue dict.

    Discovered venues from PR #16 carry an explicit ``tier`` field
    (``HIGH``/``MEDIUM``). Legacy seed venues only carry ``confidence``
    (``high``/``medium``/``low``). We bridge so the IG scraper can tier
    either source without redesign:

      tier=HIGH   or confidence=high   → "HIGH"
      tier=MEDIUM or confidence=medium → "MEDIUM"
      everything else                  → "LOW" (skipped)
    """
    if not isinstance(venue, dict):
        return "LOW"
    tier = (venue.get("tier") or "").strip().upper()
    if tier in ("HIGH", "MEDIUM"):
        return tier
    conf = (venue.get("confidence") or "").strip().lower()
    if conf == "high":
        return "HIGH"
    if conf == "medium":
        return "MEDIUM"
    return "LOW"


def _normalize_ig_username(value):
    """Normalize one Instagram identifier to a bare username.

    Accepts URLs (``https://www.instagram.com/aerocrafters/``), @handles
    (``@aerocrafters``), or plain usernames. Returns ``None`` if nothing
    usable can be recovered. The Apify ``instagram-post-scraper`` actor
    expects bare usernames in its ``username`` array.
    """
    if not value or not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    # Drop a leading @
    if s.startswith("@"):
        s = s[1:]
    # If it looks like a URL, pull the first path segment after /
    if "instagram.com" in s.lower() or s.startswith("http"):
        # Strip protocol + query/fragment
        s = re.sub(r"^https?://", "", s, flags=re.I)
        s = s.split("?", 1)[0].split("#", 1)[0]
        # Drop host
        parts = s.split("/")
        # Find the segment after the host
        host_seen = False
        username = None
        for seg in parts:
            if not seg:
                continue
            if not host_seen:
                # First non-empty segment is the host (instagram.com / www…)
                host_seen = True
                if "instagram.com" not in seg.lower():
                    # Not an instagram URL — give up
                    return None
                continue
            username = seg
            break
        if not username:
            return None
        s = username
    # Strip any trailing slash, querystring, or whitespace just in case
    s = s.rstrip("/").strip()
    # Reject obvious junk: only allow IG-legal chars (letters, digits, ., _)
    if not s or not re.match(r"^[A-Za-z0-9._]+$", s):
        return None
    return s


def _venue_instagram_username(venue):
    """Extract a single Instagram username from a venue dict, or None.

    Tries ``instagrams[]`` first (PR #16 schema), then ``instagram`` /
    ``instagram_url`` for backwards compatibility. Returns the first
    candidate that normalizes successfully.
    """
    if not isinstance(venue, dict):
        return None
    candidates = []
    igs = venue.get("instagrams")
    if isinstance(igs, list):
        candidates.extend(igs)
    elif isinstance(igs, str):
        candidates.append(igs)
    for k in ("instagram", "instagram_url", "instagramUrl"):
        v = venue.get(k)
        if v:
            candidates.append(v)
    for c in candidates:
        u = _normalize_ig_username(c)
        if u:
            return u
    return None


def fetch_apify_instagram_posts(days_ahead=14):
    """Pull recent Instagram posts from each tiered venue and ask OpenAI to
    extract dated events. Off by default — set IG_POSTS_ENABLED=1 to turn on.

    Tier-aware:
      HIGH   → 25 posts, 14-day lookback
      MEDIUM → 15 posts, 14-day lookback

    Pipeline per venue:
      Apify instagram-post-scraper → recent posts → OpenAI event extraction →
      normalized event dicts. The extraction prompt is shared with the Facebook
      pipeline (``_extract_events_from_posts_via_ai``); IG captions are
      close enough to FB post text that the same prompt extracts cleanly.
    """
    global _APIFY_LIMIT_TRIPPED
    events = []

    if os.environ.get("IG_POSTS_ENABLED", "").strip() not in ("1", "true", "yes"):
        print("  [Apify IG Posts] Disabled (set IG_POSTS_ENABLED=1 to enable)")
        return events

    token = os.environ.get("APIFY_TOKEN", "").strip()
    if not token:
        print("  [Apify IG Posts] No APIFY_TOKEN — skipping")
        return events
    if _APIFY_LIMIT_TRIPPED:
        print("  [Apify IG Posts] Monthly hard limit already tripped this run — skipping")
        return events
    if not os.environ.get("OPENAI_API_KEY"):
        print("  [Apify IG Posts] No OPENAI_API_KEY — cannot extract events from posts")
        return events

    all_venues, venues_path = _load_venue_list()
    if not all_venues:
        print("  [Apify IG Posts] No venue list found (venues.json / facebook_venues.json)")
        return events
    print(f"  [Apify IG Posts] Using venue list: {os.path.basename(venues_path)}")

    # Build (venue, username, tier, posts_limit) tuples for everything we'll
    # actually scrape, dropping LOW tier and venues without usable IG handles.
    targets = []
    skipped_no_ig = 0
    skipped_low_tier = 0
    for v in all_venues:
        tier = _venue_tier(v)
        if tier == "LOW":
            skipped_low_tier += 1
            continue
        username = _venue_instagram_username(v)
        if not username:
            skipped_no_ig += 1
            continue
        limit = _IG_POSTS_PER_HIGH if tier == "HIGH" else _IG_POSTS_PER_MEDIUM
        targets.append((v, username, tier, limit))

    if not targets:
        print(f"  [Apify IG Posts] No tiered venues with IG handles (low_tier={skipped_low_tier}, no_ig={skipped_no_ig})")
        return events

    # Cost cap: HIGH tier first, then MEDIUM. Prevents a future venues.json
    # explosion (or schema bug that mass-promotes everything to HIGH) from
    # silently 10× our Apify bill. Stable sort preserves discovery order
    # within each tier so consecutive runs scrape the same set.
    targets.sort(key=lambda t: 0 if t[2] == "HIGH" else 1)
    # Cap is env-tunable (IG_POSTS_MAX_VENUES) so the weekly workflow can be
    # re-tuned via Actions Variables without a code change. Default 20 is
    # a step-timeout-safe value picked from production timing in run
    # 25127431431 (~14.5s/venue × 20 ≈ 4m50s).
    cap = _resolve_int_env("IG_POSTS_MAX_VENUES", _IG_POSTS_MAX_VENUES)
    if len(targets) > cap:
        dropped = len(targets) - cap
        print(
            f"  [Apify IG Posts] Capping {len(targets)} → {cap} "
            f"venues for this run (dropped {dropped} lowest-priority)"
        )
        targets = targets[:cap]

    newer_than = (datetime.now().date() - timedelta(days=_IG_POSTS_LOOKBACK_DAYS)).strftime("%Y-%m-%d")
    n_high = sum(1 for t in targets if t[2] == "HIGH")
    n_med = sum(1 for t in targets if t[2] == "MEDIUM")
    print(
        f"  [Apify IG Posts] Pulling posts from {len(targets)} venues "
        f"(HIGH={n_high}, MEDIUM={n_med}, since {newer_than}, "
        f"skipped low_tier={skipped_low_tier}, no_ig={skipped_no_ig})"
    )

    actor_run_url = (
        f"https://api.apify.com/v2/acts/{APIFY_IG_POSTS_ACTOR}"
        f"/run-sync-get-dataset-items?token={token}"
    )

    venue_stats = []
    n_http_errors = 0
    n_request_errors = 0
    n_zero_post_venues = 0
    total_posts_pulled = 0
    for venue, username, tier, posts_limit in targets:
        if _APIFY_LIMIT_TRIPPED:
            venue_stats.append(f"{venue.get('name','?')}: SKIP (limit tripped)")
            break

        venue_name = venue.get("name", "?")

        # Defensive actor input shape. The instagram-post-scraper actor
        # documents ``username`` (array), ``resultsLimit`` (int), and
        # ``onlyPostsNewerThan`` (YYYY-MM-DD). Keep it explicit so a future
        # actor schema bump fails loudly rather than silently mis-scraping.
        payload = {
            "username": [username],
            "resultsLimit": posts_limit,
            "onlyPostsNewerThan": newer_than,
        }

        try:
            resp = requests.post(
                actor_run_url,
                json=payload,
                timeout=APIFY_RUN_TIMEOUT,
                headers={"Content-Type": "application/json"},
            )
        except Exception as e:
            n_request_errors += 1
            venue_stats.append(f"{venue_name}: ERROR ({type(e).__name__})")
            _sentry_warn("IG posts actor exception", venue=venue_name, error=str(e)[:200])
            continue

        if resp.status_code >= 400:
            n_http_errors += 1
            venue_stats.append(f"{venue_name}: HTTP {resp.status_code}")
            if resp.status_code == 403 and _apify_hard_limit_tripped(resp.text):
                _APIFY_LIMIT_TRIPPED = True
                _sentry_warn(
                    "Apify monthly hard limit tripped",
                    actor=APIFY_IG_POSTS_ACTOR,
                    status=403,
                )
            else:
                _sentry_warn(
                    "IG posts actor HTTP error",
                    venue=venue_name,
                    status=resp.status_code,
                    body=resp.text[:200],
                )
            continue

        try:
            posts = resp.json()
        except Exception:
            venue_stats.append(f"{venue_name}: bad JSON")
            continue
        if not isinstance(posts, list):
            venue_stats.append(f"{venue_name}: unexpected type {type(posts).__name__}")
            continue

        # IG actor field names: caption, url, timestamp. Normalize into the
        # shape the shared extraction helper expects (text/url/time).
        normalized = []
        for p in posts:
            if not isinstance(p, dict):
                continue
            normalized.append({
                "text": p.get("caption") or p.get("text") or "",
                "url": p.get("url") or p.get("postUrl") or p.get("link") or "",
                "time": p.get("timestamp") or p.get("time") or p.get("date") or "",
            })
        total_posts_pulled += len(normalized)
        if not normalized:
            n_zero_post_venues += 1

        raw = _extract_events_from_posts_via_ai(venue_name, normalized)
        kept = 0
        ig_profile_url = f"https://www.instagram.com/{username}/"
        for r in raw:
            if not isinstance(r, dict):
                continue
            date_str = (r.get("date") or "").strip()
            name = (r.get("name") or "").strip()
            if not date_str or not name:
                continue
            try:
                d_obj = datetime.strptime(date_str, "%Y-%m-%d").date()
            except ValueError:
                continue
            if not in_window(d_obj):
                continue

            source_url = ig_profile_url
            idx = r.get("source_post_index")
            if isinstance(idx, int) and 1 <= idx <= len(normalized):
                post = normalized[idx - 1]
                if post.get("url"):
                    source_url = post["url"]

            description = (r.get("description") or "").strip()[:280]
            time_str = (r.get("time") or "").strip()
            # Accounts like "Discover Victoria Texas" post about events held
            # elsewhere; the model names the real venue when it isn't theirs.
            ev_venue, address = _post_event_venue(r, venue_name, (venue.get("address") or "").strip())

            events.append({
                "date": d_obj.strftime("%Y-%m-%d"),
                "name": name,
                "time": time_str,
                "venue": ev_venue,
                "address": address,
                "description": description,
                "icons": classify_icons(name, description, venue_name),
                "free": bool(r.get("free", False)) or guess_free(name, description, venue_name),
                "url": source_url,
            })
            kept += 1
        venue_stats.append(f"{venue_name} [{tier}]: {len(normalized)} posts → {kept} events")

    print(
        f"  [Apify IG Posts] Extracted {len(events)} events across {len(targets)} venues "
        f"(posts_pulled={total_posts_pulled}, zero_post_venues={n_zero_post_venues}, "
        f"http_errors={n_http_errors}, request_errors={n_request_errors})"
    )
    for s in venue_stats:
        print(f"    • {s}")

    # Surface "ran but extracted nothing" the same way discover_venues does.
    # If we burned Apify credits for posts and OpenAI reads but ended up with
    # zero events, that's almost always a regression — a prompt drift,
    # an actor schema bump, or every venue handle going stale at once. Easier
    # to spot a Sentry ping than to diff weekly digests for missing events.
    actor_succeeded = n_http_errors + n_request_errors < len(targets)
    if actor_succeeded and total_posts_pulled > 0 and not events:
        _sentry_warn(
            "[Apify IG Posts] Actor returned posts but produced 0 events",
            actor=APIFY_IG_POSTS_ACTOR,
            venues=str(len(targets)),
            posts_pulled=str(total_posts_pulled),
            zero_post_venues=str(n_zero_post_venues),
        )

    return events


# ─── MAIN ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="The Vic 361 — Event Collector")
    parser.add_argument("--output", default="./events.json", help="Output JSON path")
    parser.add_argument("--candidates", default="./candidates.json", help="Candidates JSON path (all raw events for screening)")
    parser.add_argument("--days", type=int, default=14, help="Days ahead to collect (default 14)")
    parser.add_argument("--local-dir", default=".", help="Dir with local_events.yaml + extras.yaml")
    parser.add_argument("--skip-web", action="store_true", help="Local YAML only")
    parser.add_argument("--skip-ai", action="store_true", help="Skip AI cleanup")
    parser.add_argument("--no-backfill", action="store_true",
                        help="Don't backfill to Monday of this week (default backfills)")
    parser.add_argument(
        "--candidates-only",
        action="store_true",
        help=(
            "Only write candidates.json; do NOT overwrite docs/events.json. "
            "Used by the weekly CI workflow so it can populate candidates "
            "for admin review without clobbering the curated fallback. "
            "The live source of truth is the Railway Postgres "
            "`published_events` row written by the admin Save & Publish flow."
        ),
    )
    args = parser.parse_args()

    # Reset the per-run Apify tombstone so a successful run after a 403 day
    # actually retries instead of inheriting the previous in-process state.
    # (No-op for the daily workflow since each run is a fresh process, but
    # matters for tests / local repeated runs.)
    global _APIFY_LIMIT_TRIPPED
    _APIFY_LIMIT_TRIPPED = False

    # Set the global collection window. Every scraper reads _WINDOW_START/_END.
    global _WINDOW_START, _WINDOW_END
    _WINDOW_START, _WINDOW_END = date_window(
        days_ahead=args.days,
        backfill_to_monday=not args.no_backfill,
    )
    print(f"   Window: {_WINDOW_START} → {_WINDOW_END} "
          f"({(_WINDOW_END - _WINDOW_START).days + 1} days)")

    print(f"\n🏙️  The Vic 361 — Event Collector")
    print(f"   {datetime.now().strftime('%A, %B %d %Y at %I:%M %p')}")
    print(f"   Collecting next {args.days} days...\n")

    reset_source_stats()
    all_events = []

    # 1. Local YAML (backbone)
    print("📂 Local events...")
    yaml_path = os.path.join(args.local_dir, "local_events.yaml")
    _local_started = datetime.now().isoformat(timespec="seconds")
    _local = load_local_events(yaml_path, args.days)
    for _ev in _local:
        _ev.setdefault("_source", "local_events")
    _local_finished = datetime.now().isoformat(timespec="seconds")
    _record_source_stat(
        "local_events", len(_local),
        "ok" if _local else "empty",
        _local_started, _local_finished,
        message=None if _local else "no events from local_events.yaml",
    )
    all_events.extend(_local)

    # 2. Google Sheet (manual submissions) — zero is normal here, don't alert
    print("\n📋 Google Sheet submissions...")
    all_events.extend(safe_fetch("google_sheet", fetch_google_sheet_events,
                                 args=(args.days,), expect_events=False))

    # 3. Web sources — each wrapped so a crash or zero-return doesn't kill the run
    if not args.skip_web:
        print("\n📡 Web sources...")
        all_events.extend(safe_fetch("city_calendar", fetch_city_calendar, args=(args.days,)))
        all_events.extend(safe_fetch("chamber", fetch_chamber_events, args=(args.days,)))
        all_events.extend(safe_fetch("library", fetch_library_events, args=(args.days,)))
        all_events.extend(safe_fetch("moonshine", fetch_moonshine_events, args=(args.days,)))
        # VTX Art Walk and Generals can legitimately have 0 (between events / off-season)
        all_events.extend(safe_fetch("vtx_artwalk", fetch_vtx_artwalk,
                                     args=(args.days,), expect_events=False))
        all_events.extend(safe_fetch("jwelch", fetch_jwelch_events,
                                     args=(args.days,), expect_events=False))
        all_events.extend(safe_fetch("theatre_victoria", fetch_theatre_victoria_events,
                                     args=(args.days,)))
        all_events.extend(safe_fetch("generals", fetch_generals_events,
                                     args=(args.days,), expect_events=False))
        all_events.extend(safe_fetch("allevents", fetch_allevents_events,
                                     args=(args.days,)))

        # Apify Facebook events — only runs if APIFY_TOKEN is set
        all_events.extend(safe_fetch("apify_facebook", fetch_apify_facebook_events,
                                     args=(args.days,), expect_events=False))

        # Eventbrite (Apify) — on whenever APIFY_TOKEN is set.
        all_events.extend(safe_fetch("apify_eventbrite", fetch_apify_eventbrite_events,
                                     args=(args.days,), expect_events=False))

        # Apify Facebook *posts* → OpenAI event extraction. Off by default;
        # set FB_POSTS_ENABLED=1 to enable. Pulls from each high-confidence
        # venue page so we catch events announced as posts ("live music
        # tonight 7pm") that never become formal Event pages.
        all_events.extend(safe_fetch("apify_facebook_posts", fetch_apify_facebook_posts,
                                     args=(args.days,), expect_events=False))

        # Apify Instagram *posts* → OpenAI event extraction. Off by default;
        # set IG_POSTS_ENABLED=1 to enable. Mirrors the FB-posts pipeline but
        # tier-aware (HIGH=25 posts, MEDIUM=15 posts) and pulls from each
        # tiered venue's Instagram handle when one is known.
        all_events.extend(safe_fetch("apify_instagram_posts", fetch_apify_instagram_posts,
                                     args=(args.days,), expect_events=False))

    # 5. Merge + deduplicate
    print(f"\n🔀 Merging {len(all_events)} raw entries...")
    merged = merge_events(all_events, args.days)
    print(f"   After dedup: {len(merged)} events")

    # 5b. Cap library events to 2/day, 8/week
    merged = cap_library_events(merged)

    # 6. Fill missing descriptions + URLs
    merged = drop_dead_links(merged)
    merged = fill_gaps(merged)

    # 7. AI review — polish descriptions + assign icons via OpenAI
    if not args.skip_ai and merged:
        print("\n🤖 AI review (descriptions + icons)…")
        merged = ai_review(merged)

    # 5. Load extras
    extras = load_extras(os.path.join(args.local_dir, "extras.yaml"))

    # 6. Build output
    output = {
        "last_updated": datetime.now().strftime("%Y-%m-%dT%H:%M:%S-05:00"),
        "events": merged,
        "new_and_notable": extras["new_and_notable"],
        "sponsor": extras["sponsor"],
    }

    # 7. Write events.json (curated/live snapshot)
    #
    # In --candidates-only mode (the weekly CI workflow uses this), we skip
    # this write entirely. Only the admin Save & Publish flow should be
    # updating the curated event list — letting CI silently overwrite this
    # file with un-screened scraper output is the bug the source-of-truth
    # audit flagged.
    out_path = os.path.abspath(args.output)
    if args.candidates_only:
        print(f"\n⏭  --candidates-only: skipping write to {out_path} "
              f"(curated fallback preserved; admin Save & Publish owns this file).")
    else:
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        with open(out_path, "w") as f:
            json.dump(output, f, indent=2)

    # 8. Write candidates.json (all events for screening)
    candidates_path = os.path.abspath(args.candidates)
    candidates_output = {
        "last_updated": datetime.now().strftime("%Y-%m-%dT%H:%M:%S-05:00"),
        "events": merged,
    }
    with open(candidates_path, "w") as f:
        json.dump(candidates_output, f, indent=2)
    print(f"  Candidates: {candidates_path}")

    # 8b. Write collection_metadata.json (per-source stats for the admin
    # "Sources" tab). Lives next to candidates.json. Pre-merge/dedup counts —
    # this is what each source actually pulled, not what survived dedup.
    # The admin server reads this to render last-pulled timestamps and counts;
    # if the file is missing the UI degrades to "unknown" rather than failing.
    metadata_path = os.path.join(
        os.path.dirname(candidates_path) or ".",
        "collection_metadata.json",
    )
    try:
        metadata_output = {
            "last_run_at": datetime.now().isoformat(timespec="seconds"),
            "window_start": str(_WINDOW_START),
            "window_end": str(_WINDOW_END),
            "days_ahead": args.days,
            "candidates_only": bool(args.candidates_only),
            "merged_count": len(merged),
            "raw_count": sum(s.get("count", 0) for s in get_source_stats()),
            "sources": get_source_stats(),
        }
        with open(metadata_path, "w") as f:
            json.dump(metadata_output, f, indent=2)
        print(f"  Metadata:   {metadata_path}")
    except OSError as e:
        # Metadata is observability — never let a write failure kill the run.
        print(f"  [metadata] write failed: {e}")

    if args.candidates_only:
        print(f"\n✅ candidates.json updated ({len(merged)} events). "
              f"docs/events.json left untouched.")
    else:
        print(f"\n✅ {out_path}")
    print(f"   {len(merged)} events across {args.days} days")

    day_counts = Counter(e["date"] for e in merged)
    for d in sorted(day_counts):
        dt = datetime.strptime(d, "%Y-%m-%d")
        print(f"   {dt.strftime('%a %b %d')}: {day_counts[d]} events")
    print()


if __name__ == "__main__":
    main()
