"""Which town this run is for (MULTI_CITY_PLAN.md, Phase 1.4).

The Python twin of server/town.js, reading the same settings: TOWN unset
(or "victoria") is The Vic 361 with exactly today's values; any other slug
reads towns/<slug>/town.json, derives what follows from its own domain and
name (never Victoria's), and stops with an error when the file or a field
is missing, rather than posting Victoria's name for another town.

    from town import TOWN            # the town for this process
    TOWN["city"], TOWN["site_url"], TOWN["hashtags"], ...

Scripts in scripts/ import it after putting the repo root on sys.path.
Fields arrive with the step that moves their literals; the collector's
(area ZIPs, other towns, sources, queries) come in a later step.
"""
import json
import os
import re

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python < 3.9
    ZoneInfo = None

ROOT = os.path.dirname(os.path.abspath(__file__))

VICTORIA = {
    "id": "victoria",
    # Identity
    "site_name": "The Vic 361",
    "site_name_html": "The Vic <span>361</span>",   # the two-tone wordmark: text, then the badge
    "short_name": "Vic 361",
    "domain": "thevic361.com",
    "site_url": "https://www.thevic361.com",
    "pick_name": "Vic’s Pick",
    "pick_name_plain": "Vic's Pick",
    # Geography
    "city": "Victoria",
    "state": "TX",
    "state_name": "Texas",
    "city_state": "Victoria, TX",
    "city_state_long": "Victoria, Texas",
    "county": "Victoria County",
    "area_code": "361",
    "timezone": "America/Chicago",
    # Social posts
    "hashtags": "#VictoriaTX #ThingsToDoVictoria #VictoriaTexas #361 #TheVic361",
}

REQUIRED = ("site_name", "domain", "city", "state", "state_name", "timezone")
_SAFE = re.compile(r'^[^<>&"]+$')

# town.json uses server/town.js's names (siteName, cityState…); these map
# them to this module's. Unknown keys are kept as they are.
_FROM_JSON = {
    "siteName": "site_name", "siteNameHtml": "site_name_html", "shortName": "short_name", "siteUrl": "site_url",
    "pickName": "pick_name", "pickNamePlain": "pick_name_plain", "stateName": "state_name",
    "cityState": "city_state", "cityStateLong": "city_state_long", "areaCode": "area_code",
}


def _complete(town_id, raw):
    raw = {_FROM_JSON.get(k, k): v for k, v in raw.items() if v is not None}
    missing = [k for k in REQUIRED if not raw.get(k)]
    if missing:
        raise ValueError(f"TOWN={town_id}: town.json is missing {', '.join(missing)}")
    name, domain, city = str(raw["site_name"]), str(raw["domain"]), str(raw["city"])
    pick = str(raw.get("pick_name") or "Local Pick")
    town = {
        "site_name_html": name,
        "short_name": re.sub(r"^the\s+", "", name, flags=re.I),
        "site_url": f"https://www.{domain}",
        "pick_name": pick,
        "pick_name_plain": pick.replace("’", "'").replace("‘", "'"),
        "city_state": f"{city}, {raw['state']}",
        "city_state_long": f"{city}, {raw['state_name']}",
        "county": "",
        "area_code": "",
        # Two place tags plus the site's own name, e.g. "#BayCityTX #BayCityTexas #TheBay979".
        "hashtags": " ".join("#" + re.sub(r"[^A-Za-z0-9]", "", s) for s in (f"{city}{raw['state']}", f"{city}{raw['state_name']}", name)),
        **raw,
        "id": town_id,
    }
    return _check(town)


def _check(town):
    tid = town["id"]
    for k in ("site_name", "short_name", "pick_name", "pick_name_plain", "city", "state", "state_name", "city_state", "city_state_long"):
        if not _SAFE.match(str(town.get(k) or "")):
            raise ValueError(f"TOWN={tid}: {k} can't be empty or contain < > & \"")
    if not re.match(r"^[a-z0-9.-]+\.[a-z]{2,}$", str(town["domain"])):
        raise ValueError(f'TOWN={tid}: domain "{town["domain"]}" doesn\'t look like a domain')
    if not re.match(r"^https://[a-z0-9.-]+$", str(town["site_url"])):
        raise ValueError(f"TOWN={tid}: site_url must be https://host with no path")
    if town.get("area_code") and not re.match(r"^\d{3}$", str(town["area_code"])):
        raise ValueError(f"TOWN={tid}: area_code must be 3 digits or empty")
    if ZoneInfo:
        try:
            ZoneInfo(town["timezone"])
        except Exception:
            raise ValueError(f'TOWN={tid}: unknown timezone "{town["timezone"]}"')
    return town


def town_config(env=None, towns_dir=None, town=None):
    """The town for these settings. town (a town.json-shaped dict) wins, for tests."""
    if town is not None:
        return _complete(town.get("id") or "test", dict(town))
    env = os.environ if env is None else env
    tid = str(env.get("TOWN") or "victoria").strip().lower()
    if tid == "victoria":
        return dict(VICTORIA)
    if not re.match(r"^[a-z0-9-]+$", tid):
        raise ValueError(f'TOWN="{env.get("TOWN")}" isn\'t a town slug (lowercase letters, digits, dashes)')
    path = os.path.join(towns_dir or env.get("TOWNS_DIR") or os.path.join(ROOT, "towns"), tid, "town.json")
    try:
        with open(path) as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        raise ValueError(f"TOWN={tid}: can't read {os.path.relpath(path, ROOT)} ({e})")
    return _complete(tid, raw)


def site_url(town=None, env=None):
    """SITE_URL when set (workflows pass it), else the town's own."""
    env = os.environ if env is None else env
    town = town or TOWN
    return (env.get("SITE_URL", "").strip() or town["site_url"]).rstrip("/")


def tz(town=None):
    """The town's timezone (None without zoneinfo)."""
    return ZoneInfo((town or TOWN)["timezone"]) if ZoneInfo else None


# The process's town.
TOWN = town_config()
