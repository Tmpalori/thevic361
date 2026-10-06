"""Regression tests for the sixth collector review: Theatre Victoria quiet
between shows, organizer accounts never made the venue, a city-plus-ZIP
venue blanked, a word-bounded Victoria, TX gate for FB events, and one
weekly special posted on FB and IG merged."""

import os
import sys
from datetime import date, timedelta
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce  # noqa: E402


@pytest.fixture(autouse=True)
def _state():
    saved = ce._WINDOW_START, ce._WINDOW_END
    today = date.today()
    ce._WINDOW_START = today
    ce._WINDOW_END = today + timedelta(days=14)
    ce.reset_source_stats()
    yield
    ce._WINDOW_START, ce._WINDOW_END = saved


def d(n):
    return date.today() + timedelta(days=n)


def _page(text, status=200):
    r = MagicMock()
    r.status_code, r.text = status, text
    r.raise_for_status = lambda: None
    return r


# ─── Theatre Victoria ───────────────────────────────────────────────────────

def _tv_page(when):
    return (f'<div><a href="/s/show.htm"><img src="x.png" alt="Little Shop of Horrors"/></a>'
            f'<p class="showtitle">{when:%B} {when.day}, {when.year}</p></div>')


def _run_main_web_only(tmp_path, monkeypatch):
    (tmp_path / "local_events.yaml").write_text("recurring: []\nevents: []\n")
    (tmp_path / "extras.yaml").write_text("new_and_notable: []\nsponsor: null\n")
    for name in dir(ce):
        if name.startswith("fetch_") and name.endswith(("_events", "_posts", "_artwalk", "_calendar", "_notable")):
            if name != "fetch_theatre_victoria_events":
                monkeypatch.setattr(ce, name, lambda *a, **k: [])
    monkeypatch.setattr(ce, "drop_dead_links", lambda evs, **k: evs)
    monkeypatch.setattr(sys, "argv", [
        "collect_events.py", "--output", str(tmp_path / "events.json"),
        "--candidates", str(tmp_path / "candidates.json"), "--local-dir", str(tmp_path),
        "--days", "14", "--candidates-only", "--skip-ai",
    ])
    ce.main()


def test_theatre_victoria_between_shows_does_not_warn(tmp_path, monkeypatch):
    # The next show is two months out: a normal week, not a broken scraper.
    page = _tv_page(date.today().replace(day=1) + timedelta(days=70))
    monkeypatch.setattr(ce.requests, "get", lambda *a, **k: _page(page))
    _run_main_web_only(tmp_path, monkeypatch)
    assert not any("theatre" in w.lower() for w in ce._WARNINGS)
    stat = [s for s in ce.get_source_stats() if s["name"] == "theatre_victoria"][0]
    assert stat["status"] == "empty" and "no show in the window" in stat["message"]


def test_theatre_victoria_page_without_shows_warns(monkeypatch):
    monkeypatch.setattr(ce.requests, "get", lambda *a, **k: _page("<p>Season tickets on sale!</p>"))
    assert ce.safe_fetch("theatre_victoria", ce.fetch_theatre_victoria_events, expect_events=False) == []
    assert any("Theatre Victoria" in w for w in ce._WARNINGS)
    stat = ce.get_source_stats()[-1]
    assert "partial" in stat["message"]


def test_theatre_victoria_fetch_error_warns(monkeypatch):
    def boom(*a, **k):
        raise ce.requests.ConnectionError("down")
    monkeypatch.setattr(ce.requests, "get", boom)
    assert ce.safe_fetch("theatre_victoria", ce.fetch_theatre_victoria_events, expect_events=False) == []
    assert any("Theatre Victoria" in w for w in ce._WARNINGS)


def test_theatre_victoria_lists_in_window_shows(monkeypatch):
    when = d(1)
    monkeypatch.setattr(ce.requests, "get", lambda *a, **k: _page(_tv_page(when)))
    evs = ce.safe_fetch("theatre_victoria", ce.fetch_theatre_victoria_events, expect_events=False)
    assert evs and evs[0]["name"] == "Little Shop of Horrors" and not ce._WARNINGS


# ─── Organizer accounts aren't venues ───────────────────────────────────────

def test_organizer_account_with_no_named_venue_gets_no_venue():
    assert ce._post_event_venue({"venue": ""}, "Discover Victoria Texas", "", organizer=True) == ("", "")
    assert ce._post_event_venue({"venue": "DeLeon Plaza"}, "Victoria TNR", "", organizer=True) == ("DeLeon Plaza", "")
    # A real place still hosts its own posts.
    assert ce._post_event_venue({"venue": ""}, "Aero Crafters", "309 E Crestwood") == ("Aero Crafters", "309 E Crestwood")


def test_organizer_categories_come_from_venues_json():
    assert ce._is_organizer_account({"category": "Tourism / Events Aggregator"})
    assert ce._is_organizer_account({"category": "Event Promoter (film screenings at other venues)"})
    assert not ce._is_organizer_account({"category": "Brewery / Bar"})
    assert not ce._is_organizer_account({"category": "Public Library / Community Programs"})


# ─── City plus ZIP as the venue ─────────────────────────────────────────────

@pytest.mark.parametrize("venue", [
    "Victoria, TX 77901", "Victoria, Texas 77904", "Victoria, TX, United States, Texas 77901",
    "Victoria TX 77901-1234",
])
def test_city_and_zip_venue_is_blanked(venue):
    assert ce.clean_venue({"venue": venue, "address": ""})["venue"] == ""


def test_real_venues_with_a_zip_survive():
    assert ce.clean_venue({"venue": "Moonshine Drinkery, Victoria, TX 77901", "address": ""})["venue"] == "Moonshine Drinkery"
    out = ce.clean_venue({"venue": "101 N. Main St, Victoria, TX 77901", "address": ""})
    assert out["address"] == "101 N. Main St"


# ─── FB events locality gate ────────────────────────────────────────────────

@pytest.mark.parametrize("venue,address,city", [
    ("Hall", "1770 Fort St", "Victoria"),             # Victoria, BC: "77" in the street number
    ("Txoko Bar", "", "Victoria"),                    # "tx" inside a word
    ("Victoria Conference Centre", "720 Douglas St", "Victoria, BC"),
])
def test_fb_gate_rejects_other_victorias(venue, address, city):
    assert not ce._fb_location_is_victoria_tx({}, venue, address, city)


@pytest.mark.parametrize("venue,address,city", [
    ("Hall", "", "Victoria, TX"),
    ("Hall", "101 N Main St", "Victoria, Texas"),
    ("Victoria Hall", "101 N Main St 77901", ""),
])
def test_fb_gate_keeps_victoria_tx(venue, address, city):
    assert ce._fb_location_is_victoria_tx({}, venue, address, city)


def test_fb_gate_checks_state_and_country_fields():
    assert not ce._fb_location_is_victoria_tx({"countryCode": "CA"}, "Hall", "", "Victoria, TX")
    assert not ce._fb_location_is_victoria_tx({"state": "BC"}, "Hall", "", "Victoria, TX")
    assert ce._fb_location_is_victoria_tx({"state": "TX", "country": "United States"}, "Hall", "", "Victoria, TX")


def test_fb_events_drop_a_victoria_bc_event(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    monkeypatch.setattr(ce, "_load_venue_list", lambda: ([{"name": "x"}], "venues.json"))
    when = f"{d(3).isoformat()}T23:00:00Z"
    items = [
        {"id": "1", "name": "BC Show", "utcStartDate": when,
         "location": {"name": "Hall", "streetAddress": "1770 Fort St", "city": "Victoria"}},
        {"id": "2", "name": "TX Show", "utcStartDate": when,
         "location": {"name": "Hall", "city": "Victoria, TX"}},
    ]
    monkeypatch.setattr(ce, "_run_apify_search", lambda actor, payload, token:
                        items if actor == ce.APIFY_FB_ACTOR else [])
    assert [e["name"] for e in ce.fetch_apify_facebook_events(14)] == ["TX Show"]


# ─── One weekly special on FB and IG ────────────────────────────────────────

def _post(name, source, t="", venue="Weber Brewing"):
    return {"date": d(3).isoformat(), "name": name, "time": t, "venue": venue, "address": "", "_source": source}


def test_same_special_on_fb_and_ig_merges():
    # Both live on 2026-09-29.
    a = _post("Taco Tuesday - Birria Tacos", "apify_facebook_posts")
    b = _post("$2 Birria Taco Night", "apify_instagram_posts")
    assert ce.is_same_event(a, b)
    assert len(ce.merge_events([a, b])) == 1


def test_specials_stay_apart_when_they_differ():
    fb, ig = "apify_facebook_posts", "apify_instagram_posts"
    # Generic core ("Bingo"): a bar can run two.
    assert not ce.is_same_event(_post("Bingo", fb), _post("Bingo Night", ig))
    # Another place.
    assert not ce.is_same_event(_post("Birria Tacos", fb), _post("Birria Taco Night", ig, venue="Aero Crafters"))
    # Different specials at one place.
    assert not ce.is_same_event(_post("Birria Tacos", fb), _post("Brisket Taco Night", ig))
    # Not both AI-named posts: an official listing keeps the same-start rule.
    official = dict(_post("Birria Taco Night", "local_events"))
    assert not ce.is_same_event(_post("Birria Tacos", fb), official)
    # One gives a time, the other doesn't.
    assert not ce.is_same_event(_post("Birria Tacos", fb), _post("Birria Taco Night", ig, t="6:00 PM"))
