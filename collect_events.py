#!/usr/bin/env python3
"""
The Vic 361 — Event Collector
Fetches events from public Victoria, TX sources and outputs events.json
for the website.

Data sources (in priority order):
  1. local_events.yaml — manually curated + recurring events (BACKBONE)
  2. City of Victoria calendar — individual event pages scraped
  3. Victoria Chamber of Commerce — event detail pages
  4. OpenAI API — cleans/deduplicates the merged data (optional)

Usage:
  pip install -r requirements.txt
  python collect_events.py                        # output to ./events.json
  python collect_events.py --output /path/to.json  # custom output path
  python collect_events.py --days 14               # 14 days ahead (default: 7)
  python collect_events.py --skip-web              # local YAML only
  python collect_events.py --skip-ai               # skip AI cleanup
"""

import argparse
import json
import os
import re
import sys
from collections import Counter
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


def safe_fetch(name, fn, args=(), expect_events=True):
    """Wrap a scraper call so exceptions are captured + zero-event runs reported.

    `name` is a short scraper id (e.g. 'library', 'chamber').
    `fn` is the fetch function. `args` is a tuple of positional args.
    If `expect_events` and the scraper returns 0 results, we send a Sentry
    warning so we know about silent breakage without crashing the run.
    Always returns a list (empty on failure).
    """
    try:
        result = fn(*args)
        if not isinstance(result, list):
            result = list(result or [])
        if expect_events and len(result) == 0:
            _sentry_warn(
                f"[scraper] {name} returned 0 events",
                scraper=name,
            )
        return result
    except Exception:
        _sentry_exception(name)
        import traceback
        print(f"  [{name}] CRASHED: ", end="")
        traceback.print_exc()
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
    "riverside park": "https://www.victoriatx.gov/government/departments/parks-recreation",
    "deleon plaza": "https://www.victoriatx.gov",
    "victoria fine arts center": "https://www.victoriafineartscentre.org",
    "museum of the coastal bend": "https://museumofthecoastalbend.org",
    "nave museum": "https://www.navemuseum.com",
    "leo j. welder center": "https://www.victoriapubliclibrary.org",
    "the hideaway": "https://www.facebook.com/TheHideawayVictoriaTX",
    "j welch farms": "https://jwelchfarms.com/events/",
    "theatre victoria": "https://theatrevictoria.org",
    "riverside stadium": "https://victoriagenerals.com",
    "froggy's grub & pub": "https://froggysgrubandpub.com",
    "weaver house concert": "https://www.weaverhouseconcerts.com",
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


# ─── ADDRESS-LIKE-VENUE NORMALIZATION ─────────────────────────────────────
#
# Some sources (notably AllEvents.in, when the FB organizer leaves the venue
# blank) use the street address itself as the `location.name`. The site then
# renders "5:00 PM Pretty Pretty Princess — 2002 E Mockingbird Ln, Victoria,
# TX, ..., 2002 E Mockingbird Ln" (address echoed twice). _is_address_like()
# detects this; _clean_address_like_venue() normalizes (venue, address) so
# the address is shown once and the venue field stays empty ("") rather than
# duplicating data.
#
# Pattern matched: leading 1–6 digits + optional letter + space + word, e.g.
#   "1301 Tristan St", "2002 E Mockingbird Ln", "7608 NE Zac Lentz Pkwy"
# We also catch the AllEvents 'with parenthetical city' form:
#   "Tropical Smoothie Cafe parking lot in Victoria, TX" — left alone (no
#   leading digits), as that's a real venue name.
# ─────────────────────────────────────────────────────────────────────────────

_ADDRESS_LEAD_RE = re.compile(r"^\s*\d{1,6}[A-Za-z]?\s+[A-Za-z]")


def _is_address_like(s):
    """Return True if the string looks like a street address rather than a venue name."""
    if not s:
        return False
    s = s.strip()
    # Leading digits + word (street number + name) is the strongest signal.
    if not _ADDRESS_LEAD_RE.match(s):
        return False
    # Must contain a comma OR a state/zip/street-suffix to be confident.
    suffixes = (
        " st", " st.", " street", " rd", " rd.", " road",
        " ave", " ave.", " avenue", " blvd", " blvd.", " boulevard",
        " dr", " dr.", " drive", " ln", " ln.", " lane",
        " pkwy", " parkway", " hwy", " highway", " pl", " plaza",
        " ct", " court", " way", " cir", " circle", " trl", " trail",
    )
    low = s.lower()
    if "," in s:
        return True
    if any(low.endswith(sfx) or sfx + " " in (low + " ") for sfx in suffixes):
        return True
    return False


def _clean_address_like_venue(venue, address):
    """If `venue` is actually an address string, demote it.

    Returns (clean_venue, clean_address). The clean_venue is "" when the
    source-supplied venue is just an address — the site renderer falls back
    gracefully to address-only when venue is empty. clean_address keeps the
    first comma-separated piece (e.g. '1301 Tristan St'), matching how the
    AllEvents scraper already trims streetAddress.
    """
    venue = (venue or "").strip()
    address = (address or "").strip()
    if not _is_address_like(venue):
        return venue, address
    # Promote the address-like venue text to the address slot if no address
    # is set, taking only the first comma-separated piece (street + number).
    venue_first = venue.split(",")[0].strip()
    if not address:
        address = venue_first
    return "", address


# ─── SOURCE: LOCAL YAML (backbone) ──────────────────────────────────────────

def load_local_events(yaml_path, days_ahead=7):
    """Load recurring + one-time events from the YAML file."""
    events = []
    today = _WINDOW_START
    end_date = _WINDOW_END

    if not os.path.exists(yaml_path):
        print(f"  [Local] File not found: {yaml_path}")
        return events

    with open(yaml_path, "r") as f:
        data = yaml.safe_load(f) or {}

    DAY_MAP = {
        "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
        "friday": 4, "saturday": 5, "sunday": 6,
    }

    # Recurring events
    for ev in data.get("recurring", []) or []:
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


# ─── SOURCE: PERPLEXITY EVENT DISCOVERY ─────────────────────────────────────

def _parse_sonar_json(content):
    """Parse Perplexity sonar output that should contain a JSON array.

    Tries multiple strategies in order. Returns the first list-of-dicts that
    parses cleanly, or None on total failure.

    Why this exists: sonar sometimes prepends a citation footnote like "[1]"
    or wraps the answer in prose like "Here are the events: [...]". The old
    single greedy regex couldn't handle either case and silently dropped the
    entire query's results, costing us ~10 events per run.
    """
    if not content:
        return None
    content = content.strip()

    # Strategy 1: direct json.loads (cleanest case — sonar followed instructions)
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


def fetch_perplexity_events(days_ahead=8):
    """Use Perplexity sonar to search the web for Victoria TX events.
    Runs multiple targeted queries — one per major venue/source — to maximize coverage."""
    api_key = os.environ.get("PERPLEXITY_API_KEY")
    if not api_key:
        print("  [Perplexity] No PERPLEXITY_API_KEY — skipping")
        return []

    today = _WINDOW_START
    end_date = _WINDOW_END
    date_range_str = f"{today.strftime('%B %d')} through {end_date.strftime('%B %d, %Y')}"
    today_str = today.strftime('%Y-%m-%d')
    end_str = end_date.strftime('%Y-%m-%d')

    # Targeted queries — each forces Perplexity to dig into a specific source
    queries = [
        f'What events are happening at Aero Crafters (aerocrafters.pub) in Victoria TX from {date_range_str}? Include live music, open mics, special events, and anything posted on their Facebook or Instagram.',
        f'What events are at Moonshine Drinkery, The Hideaway, and Froggy\'s Grub & Pub in Victoria TX from {date_range_str}? Check their websites, Facebook pages, and Instagram accounts.',
        f'Search Eventbrite for events in Victoria Texas 77901 from {date_range_str}. Include all categories.',
        f'What community events, festivals, fundraisers, galas, and public gatherings are happening in Victoria Texas from {date_range_str}? Check the Victoria Advocate (victoriaadvocate.com), local nonprofits, churches, and civic groups.',
        f'What fitness, sports, outdoor, or recreation events are happening in Victoria TX from {date_range_str}? Include yoga classes, 5K runs, park events, CrossFit competitions, and Victoria Parks & Rec activities.',
        f'What trivia nights, karaoke nights, open mic nights, and weekly bar events are happening at bars and restaurants in Victoria TX from {date_range_str}? Check Facebook events and venue Instagram pages.',
        f'What live music concerts and shows are happening in Victoria TX from {date_range_str}? Search Weaver House Concerts, Aero Crafters, local venues, and any ticketed music events.',
        f'What family events, kids activities, school events, and youth activities are happening in Victoria TX from {date_range_str}? Include VISD events, church activities, and family-friendly outings.',
        f'What arts, theater, gallery openings, and cultural events are happening in Victoria TX from {date_range_str}? Check Victoria Fine Arts Center, Nave Museum, Museum of the Coastal Bend, and local galleries.',
        f'What new restaurant openings, food events, pop-up markets, food truck rallies, and local dining specials are happening in Victoria TX from {date_range_str}?',
    ]

    json_instruction = f"""
Return ONLY a valid JSON array. No markdown fences, no explanation, just the array.
Each object:
{{"date":"YYYY-MM-DD","name":"Event Name","time":"7:00 PM or empty string","venue":"Venue Name or empty string","description":"One sentence or empty string","free":true_or_false,"url":"source URL or empty string"}}

Rules:
- Only include events with a confirmed specific date between {today_str} and {end_str}
- Victoria, TX (77901) only — exclude events in other cities
- If you cannot confirm a date, omit the event
- Return [] if nothing found"""

    # Per-query topics for log clarity
    query_labels = [
        "aero crafters", "bars (moonshine/hideaway/froggy)", "eventbrite",
        "community/civic", "fitness/sports", "trivia/karaoke/open mic",
        "live music", "family/kids", "arts/theater/galleries", "food/restaurants",
    ]

    all_raw = []
    query_stats = []  # for the summary log
    for i, query in enumerate(queries):
        label = query_labels[i] if i < len(query_labels) else f"q{i+1}"
        try:
            resp = requests.post(
                "https://api.perplexity.ai/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "sonar-pro",
                    "messages": [{"role": "user", "content": query + json_instruction}],
                    "temperature": 0.1,
                    "max_tokens": 4000,
                },
                timeout=45,
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"].strip()
            # Strip markdown fences (```json ... ```)
            content = re.sub(r'^```\w*\s*', '', content)
            content = re.sub(r'\s*```\s*$', '', content)
            raw = _parse_sonar_json(content)
            if raw is None:
                query_stats.append(f"q{i+1} {label}: PARSE_FAIL ({len(content)}c)")
                _sentry_warn(
                    "Perplexity sonar JSON parse failed",
                    query_index=i, query_label=label,
                    sample=content[:200],
                )
                continue
            n = len(raw)
            query_stats.append(f"q{i+1} {label}: {n}")
            all_raw.extend(raw)
        except requests.HTTPError as e:
            query_stats.append(f"q{i+1} {label}: HTTP_{e.response.status_code if e.response else '?'}")
            _sentry_warn("Perplexity sonar HTTP error", query_index=i, query_label=label, status=str(e))
        except Exception as e:
            query_stats.append(f"q{i+1} {label}: ERROR ({type(e).__name__})")
            _sentry_warn("Perplexity sonar exception", query_index=i, query_label=label, error=str(e)[:200])

    # Parse and validate
    events = []
    for ev in all_raw:
        if not ev.get("date") or not ev.get("name"):
            continue
        try:
            ev_date = datetime.strptime(ev["date"], "%Y-%m-%d").date()
            if ev_date < today or ev_date > end_date:
                continue
        except ValueError:
            continue

        events.append({
            "date": ev["date"],
            "name": ev.get("name", "").strip(),
            "time": ev.get("time", "").strip(),
            "venue": ev.get("venue", "").strip(),
            "address": "",
            "description": ev.get("description", "").strip()[:150],
            "icons": classify_icons(ev.get("name", ""), ev.get("description", ""), ev.get("venue", "")),
            "free": bool(ev.get("free", False)),
            "url": ev.get("url", "").strip(),
        })

    print(f"  [Perplexity] {len(queries)} queries → {len(all_raw)} raw, {len(events)} in-window")
    for stat in query_stats:
        print(f"    • {stat}")
    return events


# ─── AI REVIEW (description + icons polish) ─────────────────────────────────
#
# What this does:
#   For every collected event, ask Perplexity sonar to:
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
#   - No PERPLEXITY_API_KEY → skip, return events untouched.
#   - Sonar returns malformed JSON for a batch → keep that batch's originals.
#   - Per-event response missing fields → keep that event's original values.

VALID_ICONS = {"food", "music", "family", "drinks", "arts",
               "shopping", "outdoors", "community", "free"}

_AI_REVIEW_SYSTEM_PROMPT = """You are an editor for The Vic 361, a weekly community events website for Victoria, TX. Your job is to polish event descriptions and assign icons so the site reads consistently and professionally.

For each event you receive, return:
  - description: ≤160 characters, max 2 short sentences. Neutral, friendly local-newsletter tone. NO emojis. Do NOT repeat the event name, venue name, address, date, or time (the site already shows those). If the input description has no useful info beyond what's already in the name/venue, write a brief 1-line description of what attendees can expect based on the event type.
  - icons: 1–3 strings from this exact set: food, music, family, drinks, arts, shopping, outdoors, community, free. Order by relevance (most representative first). Use "free" only when the event is genuinely free to attend.
  - free: boolean, true if the event is free to attend.

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

Return ONLY a JSON array, one object per input event in the same order, each: {"description": "...", "icons": [...], "free": true|false}. No prose, no markdown fences."""


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
    """Send a single batch of events to sonar; return list of {description, icons, free} dicts (same length as batch) or None on failure."""
    # Build a slim payload — only the fields the AI needs to make decisions.
    payload = [
        {
            "name": ev.get("name", ""),
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
        resp = requests.post(
            "https://api.perplexity.ai/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "sonar",
                "messages": [
                    {"role": "system", "content": _AI_REVIEW_SYSTEM_PROMPT},
                    {"role": "user", "content": user_msg},
                ],
                "temperature": 0.2,
                "max_tokens": 2000,
            },
            timeout=60,
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"  [AI Review] Batch request failed: {e}")
        _sentry_warn("ai_review_request_failed", error=str(e)[:200])
        return None

    # Strip markdown fences if the model added them.
    if content.startswith("```"):
        content = re.sub(r"^```\w*\n?", "", content)
        content = re.sub(r"\n?```$", "", content)

    # Some sonar responses include reasoning before the JSON — extract array.
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
    """Polish descriptions + reassign icons via Perplexity sonar.

    Mutates events in place AND returns the list. Each event:
      - description: rewritten to ≤160 chars, no emojis
      - icons: filtered to 1–3 valid values, ordered by relevance
      - free: re-evaluated boolean

    Falls back to the original event values when AI is unavailable or
    a batch fails.
    """
    api_key = os.environ.get("PERPLEXITY_API_KEY")
    if not api_key:
        print("  [AI Review] No PERPLEXITY_API_KEY — skipping")
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

            polished += 1

    print(f"  [AI Review] Polished {polished}/{len(events)} events "
          f"({failed_batches} batches fell back to originals)")
    if failed_batches:
        _sentry_warn("ai_review_partial_failure",
                     failed_batches=failed_batches, total_events=len(events))
    return events


# ─── FILL GAPS (description + url) ──────────────────────────────────────────

def fill_gaps(events):
    """Fill missing descriptions and URLs using venue lookups and templates."""
    for ev in events:
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


# ─── MERGE + DEDUPLICATE ─────────────────────────────────────────────────────

def merge_events(all_events, days_ahead=7):
    """Merge, deduplicate, auto-tag, sort."""
    today = _WINDOW_START
    end_date = _WINDOW_END

    seen = {}  # key → event (keep the one with more info)
    prefix_index = {}  # prefix_key → key (so we can find existing entries by prefix)
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

        # Normalize key — strip punctuation differences for fuzzy dedup.
        # Also drop generic trailing words that vary across sources for the
        # same event (e.g. "Story Strolls Audiobook Walking Group" vs
        # "... Walking series" — the last word is the only difference).
        name_norm = re.sub(r'[\s\-\u2013\u2014:,]+', ' ', ev.get("name", "").lower()).strip()
        words = [w for w in name_norm.split() if len(w) > 1]
        # Trailing generics that get tacked onto the same recurring event by
        # different sources. Stripped only when there's enough context
        # (≥3 preceding significant words) so we don't collapse short names.
        _GENERIC_TRAIL = {"group", "series", "club", "meetup", "event", "events",
                          "program", "workshop", "session", "sessions", "night"}
        trimmed = list(words)
        while len(trimmed) > 3 and trimmed[-1] in _GENERIC_TRAIL:
            trimmed.pop()
        # Two prefix keys: a 6-word for ordinary cases, and a tighter 4-word
        # for cases where the trailing words differ (e.g. group vs series).
        prefix_norm = " ".join(trimmed[:6])
        prefix_norm_short = " ".join(trimmed[:4]) if len(trimmed) >= 4 else ""
        key = (name_norm, date_str)
        prefix_key = (prefix_norm, date_str)
        prefix_key_short = (prefix_norm_short, date_str) if prefix_norm_short else None

        # Auto-tag if needed
        if not ev.get("icons"):
            ev["icons"] = classify_icons(ev.get("name", ""), ev.get("description", ""), ev.get("venue", ""))
        if ev.get("free") and "free" not in ev["icons"]:
            ev["icons"].append("free")

        # Keep the entry with more filled fields
        def completeness(e):
            return sum(1 for v in [e.get("time"), e.get("venue"), e.get("address"), e.get("description")] if v)

        new_entry = {
            "date": date_str,
            "name": ev.get("name", "").strip(),
            "time": ev.get("time", "").strip(),
            "venue": ev.get("venue", "").strip(),
            "address": ev.get("address", "").strip(),
            "description": ev.get("description", "").strip(),
            "icons": ev.get("icons", []),
            "free": bool(ev.get("free", False)),
            "url": ev.get("url", "").strip(),
        }

        # Apply the same address-like-venue cleanup here too — belt-and-
        # suspenders for sources other than AllEvents (e.g. Perplexity sonar
        # sometimes returns a street-address string in the venue slot).
        new_entry["venue"], new_entry["address"] = _clean_address_like_venue(
            new_entry["venue"], new_entry["address"]
        )

        # Resolve dupe via exact key, then 6-word prefix, then 4-word prefix
        # (the last catches "... Walking Group" vs "... Walking series").
        existing_key = key if key in seen else prefix_index.get(prefix_key)
        if existing_key is None and prefix_key_short is not None:
            existing_key = prefix_index.get(prefix_key_short)
        if existing_key is None:
            seen[key] = new_entry
            prefix_index[prefix_key] = key
            if prefix_key_short is not None and prefix_key_short not in prefix_index:
                prefix_index[prefix_key_short] = key
        else:
            old = seen[existing_key]
            # Pick the more complete entry, but always keep the shorter, cleaner name
            # (longer names are usually a source's verbose variant of the same event).
            chosen = new_entry if completeness(new_entry) > completeness(old) else old
            chosen["name"] = old["name"] if len(old["name"]) <= len(new_entry["name"]) else new_entry["name"]
            seen[existing_key] = chosen

    final = sorted(seen.values(), key=lambda e: (e["date"], e.get("time", "ZZ")))
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

def fetch_allevents_events(days_ahead=14):
    """Pull events from allevents.in/victoria-tx.

    The page exposes structured Event objects via JSON-LD <script> blocks
    (date, name, url, location). Times appear in the HTML cards (`.date`).
    We index time by event id, then merge into the JSON-LD entries.
    """
    events = []
    url = "https://allevents.in/victoria-tx/all"

    try:
        resp = http_get(url)
        resp.raise_for_status()
    except Exception as e:
        print(f"  [AllEvents] Fetch error: {e}")
        return events

    soup = BeautifulSoup(resp.text, "html.parser")

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

    seen_urls = set()
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

            # AllEvents often uses the street address itself as `location.name`
            # when the FB organizer left the venue blank (e.g. Loko Wrestling →
            # "1301 Tristan St, Victoria, TX 77901"). Demote it so the site
            # doesn't render the address twice.
            venue, address = _clean_address_like_venue(venue, address)

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

    print(f"  [AllEvents] Extracted {len(events)} events")
    return events


# ─── SOURCE: APIFY (Facebook events) ────────────────────────────────────────────────

APIFY_FB_ACTOR = "apify~facebook-events-scraper"
APIFY_RUN_TIMEOUT = 240  # seconds we'll wait for the run to finish

def fetch_apify_facebook_events(days_ahead=14):
    """Run the Apify Facebook Events Scraper actor against our high-value venue
    list (facebook_venues.json) and parse the dataset.

    Requires APIFY_TOKEN env var. Skips silently if not set so local runs
    without the secret still succeed.
    """
    events = []
    token = os.environ.get("APIFY_TOKEN", "").strip()
    if not token:
        print("  [Apify FB] No APIFY_TOKEN — skipping")
        return events

    venues_path = os.path.join(os.path.dirname(__file__) or ".", "facebook_venues.json")
    if not os.path.exists(venues_path):
        print(f"  [Apify FB] No facebook_venues.json at {venues_path}")
        return events

    try:
        with open(venues_path, "r") as f:
            venues = json.load(f)
    except Exception as e:
        print(f"  [Apify FB] Failed to load venues: {e}")
        return events

    # Apify's facebook-events-scraper does NOT support page-tab URLs like
    # /aerocrafters/events (returns "Invalid events page response"). It DOES
    # support search queries — which is more useful for us anyway since it
    # discovers events from venues we haven't even cataloged yet. We post-filter
    # for Victoria-area events using the address/location text.
    print(f"  [Apify FB] Searching Facebook events for Victoria TX...")

    actor_run_url = f"https://api.apify.com/v2/acts/{APIFY_FB_ACTOR}/run-sync-get-dataset-items?token={token}"
    payload = {
        "searchQueries": ["Victoria Texas"],
        "maxEvents": 60,
    }
    try:
        resp = requests.post(
            actor_run_url,
            json=payload,
            timeout=APIFY_RUN_TIMEOUT,
            headers={"Content-Type": "application/json"},
        )
        if resp.status_code >= 400:
            print(f"  [Apify FB] HTTP {resp.status_code}: {resp.text[:300]}")
            return events
        items = resp.json()
    except Exception as e:
        print(f"  [Apify FB] Run failed: {e}")
        return events

    if not isinstance(items, list):
        print(f"  [Apify FB] Unexpected response type: {type(items).__name__}")
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

        # Parse start date
        try:
            dt = datetime.fromisoformat(str(start_iso).replace("Z", "+00:00"))
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
    args = parser.parse_args()

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

    all_events = []

    # 1. Local YAML (backbone)
    print("📂 Local events...")
    yaml_path = os.path.join(args.local_dir, "local_events.yaml")
    all_events.extend(load_local_events(yaml_path, args.days))

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

    # 4. Perplexity AI discovery
    if not args.skip_ai:
        print("\n🤖 Perplexity event discovery...")
        all_events.extend(safe_fetch("perplexity", fetch_perplexity_events,
                                     args=(args.days,), expect_events=False))

    # 5. Merge + deduplicate
    print(f"\n🔀 Merging {len(all_events)} raw entries...")
    merged = merge_events(all_events, args.days)
    print(f"   After dedup: {len(merged)} events")

    # 5b. Cap library events to 2/day, 8/week
    merged = cap_library_events(merged)

    # 6. Fill missing descriptions + URLs
    merged = fill_gaps(merged)

    # 7. AI review — polish descriptions + assign icons via Perplexity sonar
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

    # 7. Write events.json (approved / live events)
    out_path = os.path.abspath(args.output)
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

    print(f"\n✅ {out_path}")
    print(f"   {len(merged)} events across {args.days} days")

    day_counts = Counter(e["date"] for e in merged)
    for d in sorted(day_counts):
        dt = datetime.strptime(d, "%Y-%m-%d")
        print(f"   {dt.strftime('%a %b %d')}: {day_counts[d]} events")
    print()


if __name__ == "__main__":
    main()
