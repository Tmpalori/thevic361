"""Official calendar feeds a town lists in its town.json (collect_events.py
source "town_feeds").

    "feeds": [
      {"name": "visit_kearney", "type": "tribe", "url": "https://visitkearney.org"},
      {"name": "library", "type": "ics", "url": "https://…/calendar.ics"},
      {"name": "unk", "type": "localist", "url": "https://calendar.unk.edu"}
    ]

Types:
  ics       an iCalendar file (VEVENTs; RRULE repeats aren't expanded, only
            the dated instance is used, since most public feeds list each
            occurrence)
  tribe     a WordPress site running The Events Calendar (its REST API,
            /wp-json/tribe/events/v1/events)
  localist  a Localist calendar (/api/2/events)

Each parser is pure: text or JSON in, events out, in the town's timezone and
inside [start, end] (dates). The collector adds icons and its own checks.
Victoria lists no feeds: its own scrapers cover its calendars.
"""
import html
import json
import re
from datetime import date, datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python < 3.9
    ZoneInfo = None

TYPES = ("ics", "tribe", "localist")
MAX_PAGES = 10          # tribe and localist pagination cap (50 or 100 a page)
_SLUG = re.compile(r"^[a-z0-9_]+$")


def check_feeds(feeds):
    """The town.json "feeds" list, checked: a list of {name, type, url} with
    a snake_case name, a known type and an https URL. Raises ValueError."""
    if feeds is None:
        return []
    if not isinstance(feeds, list):
        raise ValueError('"feeds" must be a list')
    seen = set()
    for f in feeds:
        if not isinstance(f, dict):
            raise ValueError('each feed must be {"name", "type", "url"}')
        name, kind, url = f.get("name"), f.get("type"), f.get("url")
        if not isinstance(name, str) or not _SLUG.match(name) or name in seen:
            raise ValueError(f'feed name "{name}" must be unique lowercase_snake_case')
        if kind not in TYPES:
            raise ValueError(f'feed {name}: type must be one of {", ".join(TYPES)}')
        if not isinstance(url, str) or not url.startswith("https://"):
            raise ValueError(f"feed {name}: url must start with https://")
        seen.add(name)
    return feeds


def clean(value):
    """HTML tags and entities out, whitespace collapsed."""
    text = re.sub(r"<[^>]+>", " ", str(value or ""))
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def short(text, limit=400):
    """A description cut at a sentence or word near `limit` characters."""
    text = clean(text)
    if len(text) <= limit:
        return text
    cut = text[:limit]
    stop = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    return (cut[:stop + 1] if stop > limit // 2 else cut.rsplit(" ", 1)[0] + "…").strip()


def fmt_time(dt):
    return dt.strftime("%-I:%M %p")


def time_range(start, end):
    """'7:00 PM' or '7:00 PM – 9:00 PM' (the collector's format); '' for all day."""
    if start is None:
        return ""
    if end is None or end <= start or end.date() != start.date():
        return fmt_time(start)
    return f"{fmt_time(start)} – {fmt_time(end)}"


def _event(day, name, start=None, end=None, venue="", address="", description="", url="", free=None):
    ev = {
        "date": day.isoformat(),
        "name": clean(name),
        "time": time_range(start, end),
        "venue": clean(venue),
        "address": clean(address),
        "description": short(description),
        "url": (url or "").strip(),
    }
    if free is not None:
        ev["free"] = free
    return ev


# ─── iCalendar ──────────────────────────────────────────────────────────────

def _unfold(text):
    return re.sub(r"\r?\n[ \t]", "", text or "")


def _ics_unescape(value):
    return (value.replace("\\n", "\n").replace("\\N", "\n").replace("\\,", ",")
            .replace("\\;", ";").replace("\\\\", "\\"))


def _ics_when(params, value, tz):
    """(datetime in tz or None, date) for a DTSTART/DTEND value."""
    value = value.strip()
    if "VALUE=DATE" in params.upper() or re.fullmatch(r"\d{8}", value):
        return None, datetime.strptime(value[:8], "%Y%m%d").date()
    m = re.fullmatch(r"(\d{8}T\d{4})(\d{2})?(Z?)", value)
    if not m:
        raise ValueError(f"bad date {value!r}")
    naive = datetime.strptime(m.group(1), "%Y%m%dT%H%M")
    if m.group(3):
        dt = naive.replace(tzinfo=timezone.utc).astimezone(tz)
    else:
        tzid = re.search(r"TZID=\"?([^\";:]+)", params)
        src = tz
        if tzid and ZoneInfo:
            try:
                src = ZoneInfo(tzid.group(1))
            except Exception:
                src = tz      # a Windows zone name etc.: assume the town's
        dt = naive.replace(tzinfo=src).astimezone(tz)
    return dt, dt.date()


def parse_ics(text, tz, start, end):
    """Events in [start, end] from an iCalendar file."""
    events = []
    for block in re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", _unfold(text), re.S):
        props = {}
        for line in block.splitlines():
            m = re.match(r"([A-Z-]+)((?:;[^:]*)?):(.*)", line)
            if m and m.group(1) not in props:
                props[m.group(1)] = (m.group(2), m.group(3))
        if "DTSTART" not in props or "SUMMARY" not in props:
            continue
        if props.get("STATUS", ("", ""))[1].strip().upper() == "CANCELLED":
            continue
        try:
            s_dt, s_day = _ics_when(*props["DTSTART"], tz)
            e_dt = _ics_when(*props["DTEND"], tz)[0] if "DTEND" in props else None
        except ValueError:
            continue
        if not (start <= s_day <= end):
            continue
        text_of = lambda k: _ics_unescape(props.get(k, ("", ""))[1])
        loc = text_of("LOCATION")
        venue, _, address = loc.partition(",") if re.search(r",\s*\d", loc) else (loc, "", "")
        events.append(_event(s_day, text_of("SUMMARY"), s_dt, e_dt, venue=venue, address=address.strip(),
                             description=text_of("DESCRIPTION"), url=text_of("URL")))
    return events


# ─── The Events Calendar (WordPress) ────────────────────────────────────────

def tribe_url(base, start, end):
    return (f"{base.rstrip('/')}/wp-json/tribe/events/v1/events"
            f"?start_date={start.isoformat()}&end_date={end.isoformat()}%2023:59:59&per_page=50")


def parse_tribe(data, tz, start, end):
    """(events, next page URL or None) from one page of the tribe REST API.
    Its dates are the site's local time; the town's timezone is assumed."""
    events = []
    for e in (data or {}).get("events") or []:
        try:
            s = datetime.strptime(e["start_date"][:16], "%Y-%m-%d %H:%M").replace(tzinfo=tz)
            en = datetime.strptime(e["end_date"][:16], "%Y-%m-%d %H:%M").replace(tzinfo=tz) if e.get("end_date") else None
        except (KeyError, TypeError, ValueError):
            continue
        if not (start <= s.date() <= end):
            continue
        all_day = bool(e.get("all_day"))
        v = e.get("venue") if isinstance(e.get("venue"), dict) else {}
        addr = ", ".join(x for x in (v.get("address"), v.get("city")) if x)
        cost = clean(e.get("cost"))
        events.append(_event(s.date(), e.get("title"), None if all_day else s, None if all_day else en,
                             venue=v.get("venue", ""), address=addr, description=e.get("description") or e.get("excerpt"),
                             url=e.get("url") or e.get("website") or "",
                             free=True if cost.lower() in ("free", "$0", "0") else None))
    return events, (data or {}).get("next_rest_url")


# ─── Localist ───────────────────────────────────────────────────────────────

def localist_url(base, start, end, page=1):
    days = (end - start).days + 1
    return f"{base.rstrip('/')}/api/2/events?start={start.isoformat()}&days={days}&pp=100&page={page}"


def _iso(value, tz):
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(tz)


def parse_localist(data, tz, start, end):
    """(events, total pages) from one page of the Localist API. Each
    instance of a repeating event inside the window is its own event."""
    events = []
    for wrap in (data or {}).get("events") or []:
        e = wrap.get("event") if isinstance(wrap, dict) else None
        if not isinstance(e, dict):
            continue
        for inst in e.get("event_instances") or []:
            i = (inst or {}).get("event_instance") or {}
            try:
                s = _iso(i["start"], tz)
                en = _iso(i["end"], tz) if i.get("end") else None
            except (KeyError, TypeError, ValueError):
                continue
            if not (start <= s.date() <= end):
                continue
            all_day = bool(i.get("all_day"))
            events.append(_event(s.date(), e.get("title"), None if all_day else s, None if all_day else en,
                                 venue=e.get("location_name") or e.get("location") or "", address=e.get("address") or "",
                                 description=e.get("description_text") or e.get("description"),
                                 url=e.get("localist_url") or e.get("url") or "",
                                 free=True if e.get("free") else None))
    total = ((data or {}).get("page") or {}).get("total") or 1
    return events, int(total)


# ─── Fetching ───────────────────────────────────────────────────────────────

def fetch_feed(feed, get, tz, start, end):
    """One feed's events. `get(url)` returns a response (raises on HTTP
    errors). Pagination stops at MAX_PAGES."""
    kind, url = feed["type"], feed["url"]
    if kind == "ics":
        return parse_ics(get(url).text, tz, start, end)
    events = []
    if kind == "tribe":
        page_url, pages = tribe_url(url, start, end), 0
        while page_url and pages < MAX_PAGES:
            got, page_url = parse_tribe(get(page_url).json(), tz, start, end)
            events.extend(got)
            pages += 1
        return events
    if kind == "localist":
        page, total = 1, 1
        while page <= min(total, MAX_PAGES):
            got, total = parse_localist(get(localist_url(url, start, end, page)).json(), tz, start, end)
            events.extend(got)
            page += 1
        return events
    raise ValueError(f"unknown feed type {kind}")
