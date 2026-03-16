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


# ─── CONFIG ──────────────────────────────────────────────────────────────────

HEADERS = {
    "User-Agent": "TheVic361-EventCollector/1.0 (community events board; Victoria TX)"
}
TIMEOUT = 15

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
                  "dj", "karaoke", "open mic", "k-pop", "symphony"],
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
    """Load recurring + one-time events from the YAML file."""
    events = []
    today = datetime.now().date()
    end_date = today + timedelta(days=days_ahead)

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
    today = datetime.now()
    end_date = today + timedelta(days=days_ahead)

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
    today = datetime.now()
    end_date = today + timedelta(days=days_ahead)

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
    """Scrape events from the Victoria Public Library calendar."""
    events = []
    today = datetime.now()
    end_date = today + timedelta(days=days_ahead)

    try:
        # Fetch the list view of the library calendar for the current month
        url = f"https://victoriapl.librarycalendar.com/events/week/{today.strftime('%Y/%m/%d')}"
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")

        # The library calendar uses a structured format with event entries
        # Look for event links and titles
        for item in soup.select(".views-row, .calendar-event, [class*='event']"):
            title_el = item.select_one("a, .field-title, h3, h4")
            if not title_el:
                continue
            title = title_el.get_text(strip=True)
            if not title or len(title) < 3:
                continue

            # Skip generic items
            if title.lower() in ["more details", "view details", "add to calendar"]:
                continue

            # Try to extract date from nearby text or data attributes
            page_text = item.get_text()
            event_date = None

            # Look for date patterns
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

            # Look for ISO date in data attributes
            if not event_date:
                for attr in ["data-date", "datetime", "content"]:
                    for el in item.select(f"[{attr}]"):
                        val = el.get(attr, "")
                        iso_match = re.search(r'(\d{4}-\d{2}-\d{2})', val)
                        if iso_match:
                            try:
                                dt = datetime.strptime(iso_match.group(1), "%Y-%m-%d")
                                if today.date() <= dt.date() <= end_date.date():
                                    event_date = dt.strftime("%Y-%m-%d")
                                    break
                            except ValueError:
                                pass
                    if event_date:
                        break

            if not event_date:
                continue

            # Extract time
            time_str = ""
            time_match = re.search(
                r'(\d{1,2}:\d{2}\s*(?:am|pm|AM|PM))\s*[-–]\s*(\d{1,2}:\d{2}\s*(?:am|pm|AM|PM))',
                page_text
            )
            if time_match:
                time_str = f"{time_match.group(1).upper()} – {time_match.group(2).upper()}"

            events.append({
                "date": event_date,
                "name": title,
                "time": time_str,
                "venue": "Victoria Public Library",
                "address": "302 N. Main St.",
                "description": "",
                "icons": classify_icons(title, "", "Victoria Public Library"),
                "free": True,
                "url": "",
            })

        print(f"  [Library] Extracted {len(events)} events")

    except Exception as e:
        print(f"  [Library] Error: {e}")

    return events


# ─── SOURCE: MOONSHINE DRINKERY ─────────────────────────────────────────────

def fetch_moonshine_events(days_ahead=8):
    """Scrape upcoming events from Moonshine Drinkery homepage."""
    events = []
    today = datetime.now().date()
    end_date = today + timedelta(days=days_ahead)

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

def fetch_perplexity_events(days_ahead=8):
    """Use Perplexity sonar to search the web for Victoria TX events.
    Runs multiple targeted queries — one per major venue/source — to maximize coverage."""
    api_key = os.environ.get("PERPLEXITY_API_KEY")
    if not api_key:
        print("  [Perplexity] No PERPLEXITY_API_KEY — skipping")
        return []

    today = datetime.now().date()
    end_date = today + timedelta(days=days_ahead)
    date_range_str = f"{today.strftime('%B %d')} through {end_date.strftime('%B %d, %Y')}"
    today_str = today.strftime('%Y-%m-%d')
    end_str = end_date.strftime('%Y-%m-%d')

    # Targeted queries — each forces Perplexity to dig into a specific source
    queries = [
        f'What events are happening at Aero Crafters in Victoria TX from {date_range_str}? Include live music nights, open mics, and any special events.',
        f'What events are at Moonshine Drinkery, The Hideaway, and Froggy\'s Grub & Pub in Victoria TX from {date_range_str}?',
        f'Search Eventbrite for events in Victoria Texas 77901 from {date_range_str}.',
        f'What community events, festivals, fundraisers, and public gatherings are happening in Victoria Texas from {date_range_str}? Check the Victoria Advocate, local news sites, and community Facebook groups.',
        f'What fitness, sports, outdoor, or recreation events are happening in Victoria TX from {date_range_str}? Include yoga, 5Ks, park events, and recreation center activities.',
        f'What restaurant specials, trivia nights, happy hours, karaoke, and bar events are happening in Victoria TX from {date_range_str}?',
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

    all_raw = []
    for i, query in enumerate(queries):
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
                    "max_tokens": 2000,
                },
                timeout=30,
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"].strip()
            content = re.sub(r'^```\w*\n?', '', content)
            content = re.sub(r'\n?```$', '', content)
            arr_match = re.search(r'\[.*\]', content, re.DOTALL)
            if arr_match:
                raw = json.loads(arr_match.group(0))
                all_raw.extend(raw)
        except Exception as e:
            pass  # silent — individual query failures shouldn't stop the run

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

    print(f"  [Perplexity] {len(queries)} queries → {len(events)} raw events")
    return events


# ─── AI CLEANUP (optional) ──────────────────────────────────────────────────

def ai_cleanup(events, days_ahead=7):
    """Use OpenAI to deduplicate, clean descriptions, and fill gaps."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("  [AI] No OPENAI_API_KEY — skipping AI cleanup")
        return events

    today = datetime.now()
    date_range = [
        (today + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(days_ahead)
    ]

    prompt = f"""You are editing events data for The Vic 361, a community events board for Victoria, TX.

Today is {today.strftime('%A, %B %d, %Y')}.
Date range: {date_range[0]} to {date_range[-1]}

Below is a JSON array of events collected from multiple sources. Your job:

1. DEDUPLICATE: If the same event appears twice (same name + same date), keep the one with more complete info.
2. CLEAN NAMES: Title case. Remove venue names appended to event names. Remove date text mixed into names.
3. CLEAN DESCRIPTIONS: Rewrite each as one punchy sentence, under 120 chars, casual/local tone.
4. FILL TIME: If time is missing, leave as "" (don't guess).
5. FILL VENUE: If venue is missing but you know it from the event name, fill it in.
6. VICTORIA ADDRESSES: Fill in known Victoria, TX addresses where you can. Otherwise leave "".
7. VALIDATE ICONS: Ensure icons array makes sense. Valid values: food, music, family, drinks, arts, shopping, outdoors, community, free.
8. FREE TAG: If event is free, ensure "free" is in the icons array AND free=true.
9. REMOVE events outside {date_range[0]} to {date_range[-1]}.

Return ONLY a valid JSON array of event objects. No markdown, no commentary.

Each event object:
{{"date":"YYYY-MM-DD","name":"...","time":"...","venue":"...","address":"...","description":"...","icons":[...],"free":true/false,"url":"..."}}

Input events:
{json.dumps(events, indent=2)[:14000]}"""

    try:
        resp = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "gpt-4o-mini",
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.2,
                "max_tokens": 6000,
            },
            timeout=45,
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"].strip()

        # Strip markdown fences
        if content.startswith("```"):
            content = re.sub(r'^```\w*\n?', '', content)
            content = re.sub(r'\n?```$', '', content)

        cleaned = json.loads(content)
        print(f"  [AI] Cleaned to {len(cleaned)} events")
        return cleaned

    except Exception as e:
        print(f"  [AI] Error: {e}")
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
    today = datetime.now().date()
    end_date = today + timedelta(days=days_ahead)

    seen = {}  # key → event (keep the one with more info)
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

        # Normalize key — strip punctuation differences for fuzzy dedup
        name_norm = re.sub(r'[\s\-\u2013\u2014:,]+', ' ', ev.get("name", "").lower()).strip()
        key = (name_norm, date_str)

        # Auto-tag if needed
        if not ev.get("icons"):
            ev["icons"] = classify_icons(ev.get("name", ""), ev.get("description", ""), ev.get("venue", ""))
        if ev.get("free") and "free" not in ev["icons"]:
            ev["icons"].append("free")

        # Keep the entry with more filled fields
        def completeness(e):
            return sum(1 for v in [e.get("time"), e.get("venue"), e.get("address"), e.get("description")] if v)

        if key not in seen or completeness(ev) > completeness(seen[key]):
            seen[key] = {
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

    final = sorted(seen.values(), key=lambda e: (e["date"], e.get("time", "ZZ")))
    return final


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
    today = datetime.now().date()
    end_date = today + timedelta(days=days_ahead)

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


# ─── MAIN ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="The Vic 361 — Event Collector")
    parser.add_argument("--output", default="./events.json", help="Output JSON path")
    parser.add_argument("--candidates", default="./candidates.json", help="Candidates JSON path (all raw events for screening)")
    parser.add_argument("--days", type=int, default=7, help="Days ahead to collect")
    parser.add_argument("--local-dir", default=".", help="Dir with local_events.yaml + extras.yaml")
    parser.add_argument("--skip-web", action="store_true", help="Local YAML only")
    parser.add_argument("--skip-ai", action="store_true", help="Skip AI cleanup")
    args = parser.parse_args()

    print(f"\n🏙️  The Vic 361 — Event Collector")
    print(f"   {datetime.now().strftime('%A, %B %d %Y at %I:%M %p')}")
    print(f"   Collecting next {args.days} days...\n")

    all_events = []

    # 1. Local YAML (backbone)
    print("📂 Local events...")
    yaml_path = os.path.join(args.local_dir, "local_events.yaml")
    all_events.extend(load_local_events(yaml_path, args.days))

    # 2. Google Sheet (manual submissions)
    print("\n📋 Google Sheet submissions...")
    all_events.extend(fetch_google_sheet_events(args.days))

    # 3. Web sources
    if not args.skip_web:
        print("\n📡 Web sources...")
        all_events.extend(fetch_city_calendar(args.days))
        all_events.extend(fetch_chamber_events(args.days))
        all_events.extend(fetch_library_events(args.days))
        all_events.extend(fetch_moonshine_events(args.days))

    # 4. Perplexity AI discovery
    if not args.skip_ai:
        print("\n🤖 Perplexity event discovery...")
        all_events.extend(fetch_perplexity_events(args.days))

    # 5. Merge + deduplicate
    print(f"\n🔀 Merging {len(all_events)} raw entries...")
    merged = merge_events(all_events, args.days)
    print(f"   After dedup: {len(merged)} events")

    # 6. Fill missing descriptions + URLs
    merged = fill_gaps(merged)

    # 7. AI cleanup (optional — OpenAI only, skip if no key)
    if not args.skip_ai and merged:
        print("\n🤖 AI cleanup...")
        merged = ai_cleanup(merged, args.days)

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
