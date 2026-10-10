"""town.py and the scripts that read it (MULTI_CITY_PLAN.md 1.4): TOWN unset
is Victoria exactly (the Python goldens pin its output); another town's
social posts, AI prompts and alerts name it, never Victoria."""
import importlib
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "scripts"))
import town as town_mod  # noqa: E402

BAY = {"siteName": "The Bay 979", "siteNameHtml": "The Bay <span>979</span>", "domain": "thebay979.com",
       "city": "Bay City", "state": "TX", "stateName": "Texas", "timezone": "America/Los_Angeles", "pickName": "Bay’s Best",
       "county": "Matagorda County", "areaZips": ["77414", "77404"], "otherTowns": ["wharton", "palacios", "victoria", "el campo"]}
LEAK = ("Victoria", "Vic 361", "The Vic", "thevic361", "Vic's Pick", "Vic’s Pick", "#361")


def test_victoria_is_today():
    t = town_mod.town_config({})
    assert t == town_mod.VICTORIA
    assert t["hashtags"] == "#VictoriaTX #ThingsToDoVictoria #VictoriaTexas #361 #TheVic361"
    assert town_mod.site_url(t, {}) == "https://www.thevic361.com"
    assert town_mod.site_url(t, {"SITE_URL": "https://x.example/"}) == "https://x.example"


def test_another_town_from_file(tmp_path):
    (tmp_path / "bay").mkdir()
    (tmp_path / "bay" / "town.json").write_text(json.dumps(BAY))
    t = town_mod.town_config({"TOWN": "bay", "TOWNS_DIR": str(tmp_path)})
    assert t["id"] == "bay" and t["site_name"] == "The Bay 979" and t["site_url"] == "https://www.thebay979.com"
    assert t["city_state"] == "Bay City, TX" and t["city_state_long"] == "Bay City, Texas" and t["county"] == "Matagorda County"
    assert t["pick_name_plain"] == "Bay's Best" and t["short_name"] == "Bay 979"
    assert t["hashtags"] == "#BayCityTX #BayCityTexas #TheBay979"
    assert t["area_zips"] == ["77414", "77404"] and t["area_name"] == "Matagorda County"
    assert t["nearby_examples"] == "Wharton, Palacios, Victoria, El Campo" and t["allevents_slug"] == "bay-city-tx"


@pytest.mark.parametrize("patch,err", [
    ({"domain": None}, "missing domain"), ({"siteName": "Bay <b>"}, "site_name"), ({"timezone": "Mars/Base"}, "timezone"),
    ({"areaCode": "97"}, "area_code"), ({"domain": "not a domain"}, "domain"),
])
def test_bad_town_stops(patch, err):
    # (A town with no county reads "Bay City, Texas" / "(nearby towns)": see test_no_county.)
    with pytest.raises(ValueError, match=err):
        town_mod.town_config(town={**BAY, **patch})
    with pytest.raises(ValueError, match="isn't a town slug"):
        town_mod.town_config({"TOWN": "../x"})
    with pytest.raises(ValueError, match="area_zips"):
        town_mod.town_config(town={**BAY, "areaZips": ["7741"]})
    with pytest.raises(ValueError, match="can't read"):
        town_mod.town_config({"TOWN": "nowhere", "TOWNS_DIR": "/nonexistent"})


@pytest.fixture
def bay(tmp_path, monkeypatch):
    """Reload town.py and the scripts with TOWN=bay; put Victoria back after."""
    (tmp_path / "bay").mkdir()
    (tmp_path / "bay" / "town.json").write_text(json.dumps(BAY))
    monkeypatch.setenv("TOWN", "bay")
    monkeypatch.setenv("TOWNS_DIR", str(tmp_path))
    monkeypatch.delenv("SITE_URL", raising=False)
    names = ["town", "collect_events", "social_kit", "social_slides", "sweep_events", "review_submissions", "uptime_check"]
    mods = {n: importlib.reload(importlib.import_module(n)) for n in names}
    yield mods
    monkeypatch.delenv("TOWN")
    monkeypatch.delenv("TOWNS_DIR")
    for n in names:
        importlib.reload(importlib.import_module(n))


def no_leak(text):
    return [w for w in LEAK if w in text]


def test_social_posts_name_the_town(bay):
    from datetime import date
    sk = bay["social_kit"]
    assert sk.SITE == "https://www.thebay979.com"
    assert sk.HASHTAGS == "#BayCityTX #BayCityTexas #TheBay979"
    assert sk.TITLES["week"][:2] == ("This week in Bay City, TX", "This Week in Bay City")
    assert "bay city" in sk.GENERIC_VENUES and "victoria" not in sk.GENERIC_VENUES
    events = [{"date": "2026-10-09", "name": "Fish Fry", "venue": "Hall", "time": "6:00 PM", "featured": True}]
    start, end = sk.week_bounds(date(2026, 10, 5))
    caps = sk.captions(sk.select_events(events, start, end), start, end, "week", {}, None)
    for which in ("facebook", "instagram"):
        assert no_leak(caps[which]) == [], which
    assert "thebay979.com" in caps["instagram"]
    assert bay["social_slides"]._wordmark() == 'The Bay <b class="pill361" style="color:#1F1A3D">979</b>'
    assert sk.zone_label() == "PT"


def test_prompts_and_alerts_name_the_town(bay):
    assert bay["sweep_events"].PROMPT.startswith("You check the published event list for The Bay 979, a community events site for Bay City, Texas (Matagorda County).")
    assert "clearly not in or near Bay City, Texas." in bay["sweep_events"].PROMPT
    assert bay["sweep_events"].LABEL["out_of_area"] == "outside Bay City?"
    rp = bay["review_submissions"].PROMPT
    assert rp.startswith("You review event submissions for The Bay 979, a community events website for Bay City, Texas (Matagorda County and nearby towns).")
    assert "in or near Bay City TX," in rp and "thebay979.com" in bay["review_submissions"].KNOWN_LINK_DOMAINS
    for text in (bay["sweep_events"].PROMPT, rp):
        assert no_leak(text) == []
    from datetime import datetime, timezone
    msg, _ = bay["uptime_check"].decide({}, ["/ returned HTTP 500"], datetime(2026, 10, 9, tzinfo=timezone.utc))
    assert msg == "🚨 thebay979.com is DOWN: / returned HTTP 500"


def test_collector_for_another_town(bay):
    from datetime import date
    ce = bay["collect_events"]
    assert ce.VICTORIA_AREA_ZIPS == {"77414", "77404"}
    assert ce.ALLEVENTS_PAGES[0] == "https://allevents.in/bay-city-tx/all"
    assert ce.EVENTBRITE_SEARCH == {"searchQuery": "events in Bay City, TX", "location": "Bay City, TX"}
    assert ce.FB_SEARCH_QUERIES == {"primary": ["Bay City Texas"], "alt": ["Bay City, Texas"]}
    assert ce.GOOGLE_SHEET_ID == "" and ce.fetch_google_sheet_events() == []
    # Its own area: its ZIPs and town names count, Victoria's don't.
    assert ce.out_of_area_reason({"name": "Fair", "venue": "Hall", "address": "1 Main St, Bay City, TX 77414"}) is None
    assert ce.out_of_area_reason({"name": "Fair", "venue": "Hall", "address": "1 Main St, Victoria, TX 77901"}) == "zip 77901"
    assert ce.out_of_area_reason({"name": "Fish Fry", "venue": "Hall", "address": "Palacios, TX"}) == "town palacios"
    assert ce._fb_location_is_victoria_tx({}, "Hall", "1 Main St, Bay City, TX 77414", "Bay City") is True
    assert ce._fb_location_is_victoria_tx({}, "Hall", "1 Main St, Victoria, TX 77901", "Victoria") is False
    assert ce._PLACEHOLDER_PLACE_RE.match("Bay City, Texas") and ce._PLACEHOLDER_PLACE_RE.match("Matagorda County")
    assert not ce._PLACEHOLDER_PLACE_RE.match("Victoria")
    assert ce.fill_gaps([{"date": "2026-10-09", "name": "Show", "venue": "Hall"}])[0]["description"] == "Event at Hall in Bay City, TX."
    assert "victoria" not in ce._CITY_TOKENS and "bay" in ce._CITY_TOKENS
    prompts = [ce._AI_REVIEW_SYSTEM_PROMPT, ce._gemini_prompt("music", date(2026, 10, 5), date(2026, 10, 18)),
               ce._notable_prompt(date(2026, 10, 7)), ce._post_events_prompt("Hall", "[1] hi", "2026-10-09", "2026-10-23")]
    for p in prompts:
        assert "Bay City" in p
        assert [w for w in ("Vic 361", "Victoria, TX", "Victoria, Texas", "Victoria County") if w in p] == [], p[:80]
    assert "Bay City, Texas (Matagorda County)" in prompts[1]
    assert "Skip events in other towns (Wharton, Palacios, Victoria, El Campo, etc.)" in prompts[3]
    assert not any("Victoria" in c for c in ce.GEMINI_CATEGORIES)


def test_no_county(tmp_path, monkeypatch):
    t = town_mod.town_config(town={**BAY, "county": None})
    assert t["county"] == "" and t["area_name"] == "the Bay City area"


def test_web_sources_victoria_runs_all_in_order():
    import collect_events as ce
    assert [(n, e) for n, _, e in ce.enabled_web_sources(town_mod.VICTORIA)] == [
        ("city_calendar", True), ("chamber", True), ("library", True), ("moonshine", False),
        ("vtx_artwalk", False), ("jwelch", False), ("theatre_victoria", False), ("generals", False),
        ("allevents", True), ("gemini_search", False), ("apify_facebook", False), ("apify_eventbrite", False),
        ("apify_facebook_posts", False), ("apify_instagram_posts", False)]
    assert all(callable(getattr(ce, fn)) for _, fn, _ in ce.WEB_SOURCES)


def test_web_sources_another_town():
    import collect_events as ce
    bay = town_mod.town_config(town=BAY)
    assert [n for n, _, _ in ce.enabled_web_sources(bay)] == [
        "allevents", "gemini_search", "apify_facebook", "apify_eventbrite", "apify_facebook_posts", "apify_instagram_posts"]
    picked = town_mod.town_config(town={**BAY, "enabledSources": ["gemini_search", "allevents"]})
    assert [n for n, _, _ in ce.enabled_web_sources(picked)] == ["allevents", "gemini_search"]  # run order, not list order
    with pytest.raises(ValueError, match="unknown sources in enabled_sources: nope"):
        ce.enabled_web_sources({**bay, "enabled_sources": ["allevents", "nope"]})


def test_venue_list_comes_from_local_dir(tmp_path, monkeypatch):
    import collect_events as ce
    (tmp_path / "venues.json").write_text(json.dumps([{"name": "Bay Hall"}]))
    monkeypatch.setattr(ce, "_VENUE_DIR", str(tmp_path))
    assert ce._load_venue_list() == ([{"name": "Bay Hall"}], str(tmp_path / "venues.json"))
    monkeypatch.setattr(ce, "_VENUE_DIR", None)
    venues, path = ce._load_venue_list()
    assert venues and os.path.abspath(os.path.dirname(path)) == os.path.dirname(os.path.abspath(ce.__file__))


def test_paths_victoria_where_they_always_were():
    assert town_mod.town_paths(town_mod.VICTORIA) == {
        "dir": ".", "candidates": "candidates.json", "collection_metadata": "collection_metadata.json",
        "enrichment_cache": "enrichment_cache.json", "venues": "venues.json", "local_events": "local_events.yaml",
        "extras": "extras.yaml", "events": "docs/events.json", "social": "docs/social/latest/"}


def test_paths_cli_for_the_workflows():
    import subprocess
    out = subprocess.run([sys.executable, os.path.join(HERE, "town.py"), "paths"], capture_output=True, text=True,
                         env={k: v for k, v in os.environ.items() if k not in ("TOWN", "TOWNS_DIR")}, check=True).stdout
    assert out.splitlines()[:3] == ["TOWN_DIR=.", "TOWN_CANDIDATES=candidates.json", "TOWN_COLLECTION_METADATA=collection_metadata.json"]
    assert "TOWN_SOCIAL=docs/social/latest/" in out.splitlines()


def test_paths_another_town(bay):
    p = bay["town"].town_paths()
    assert p["dir"] == "towns/bay" and p["candidates"] == "towns/bay/candidates.json"
    assert p["events"] == "towns/bay/public/events.json" and p["social"] == "towns/bay/public/social/latest/"
    kit = bay["social_kit"]
    assert os.path.normpath(kit.OUT_DIR) == os.path.join(HERE, "towns", "bay", "public", "social", "latest")
    assert os.path.normpath(kit.VENUES_FILE) == os.path.join(HERE, "towns", "bay", "venues.json")


def test_victoria_has_no_budget_ceiling(monkeypatch):
    import collect_events as ce
    assert "limits" not in town_mod.VICTORIA
    monkeypatch.setenv("EVENTBRITE_MAX", "100")
    assert ce._resolve_int_env("EVENTBRITE_MAX", 60) == 100   # the repo variable, as before
    monkeypatch.delenv("EVENTBRITE_MAX")
    assert ce._resolve_int_env("EVENTBRITE_MAX", 60) == 60


def test_another_town_is_capped_below_shared_variables(bay, monkeypatch):
    # MULTI_CITY_PLAN.md 3.6: repo variables are Victoria's and the Apify
    # month is shared, so another town gets ceilings.
    ce = bay["collect_events"]
    assert ce.TOWN["limits"] == town_mod.DEFAULT_LIMITS
    monkeypatch.setenv("EVENTBRITE_MAX", "100")
    assert ce._resolve_int_env("EVENTBRITE_MAX", 60) == 20
    monkeypatch.setenv("EVENTBRITE_MAX", "5")
    assert ce._resolve_int_env("EVENTBRITE_MAX", 60) == 5
    monkeypatch.delenv("FB_POSTS_MAX_VENUES", raising=False)
    assert ce._resolve_int_env("FB_POSTS_MAX_VENUES", 40) == 10


def test_town_limits_override_the_defaults_and_are_checked():
    t = town_mod.town_config(town={**BAY, "limits": {"EVENTBRITE_MAX": 5}})
    assert t["limits"] == {**town_mod.DEFAULT_LIMITS, "EVENTBRITE_MAX": 5}
    for bad in ({"EVENTBRITE_MAX": 0}, {"EVENTBRITE_MAX": "20"}, {"EVENTBRITE_MAX": True}, ["x"]):
        with pytest.raises(ValueError, match="limits"):
            town_mod.town_config(town={**BAY, "limits": bad})


def test_another_town_refuses_victorias_site_url():
    bay = town_mod.town_config(town=BAY)
    with pytest.raises(ValueError, match="SITE_URL is Victoria's"):
        town_mod.site_url(bay, {"SITE_URL": "https://www.thevic361.com"})
    assert town_mod.site_url(bay, {}) == "https://www.thebay979.com"
    assert town_mod.site_url(town_mod.VICTORIA, {"SITE_URL": "https://www.thevic361.com/"}) == "https://www.thevic361.com"


def test_paths_refuses_a_slug_typed_in_the_wrong_case():
    import subprocess
    env = {k: v for k, v in os.environ.items() if k != "TOWNS_DIR"}
    r = subprocess.run([sys.executable, os.path.join(HERE, "town.py"), "paths"], env={**env, "TOWN": "Victoria"},
                       capture_output=True, text=True)
    assert r.returncode != 0 and 'use the lowercase slug, e.g. "victoria"' in r.stderr
    r = subprocess.run([sys.executable, os.path.join(HERE, "town.py"), "paths"], env={**env, "TOWN": "victoria"},
                       capture_output=True, text=True)
    assert r.returncode == 0 and "TOWN_CANDIDATES=candidates.json" in r.stdout
