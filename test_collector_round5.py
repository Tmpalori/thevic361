"""Regression tests for the fifth collector review: AllEvents' capped "all"
page marked partial, the Art Walk date read from text (and the Safari UA past
SiteGround's captcha), the Generals schedule read from the page's inline game
data, Moonshine quiet when it lists nothing ahead, Gemini arrays found past a
trailing "[1]", secular names that aren't religious, "Bingo" vs "Bingo Night"
merged, and FB events' midnight placeholder blanked."""

import json
import os
import sys
from datetime import date, datetime, time, timedelta, timezone
from unittest.mock import MagicMock
from zoneinfo import ZoneInfo

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


# ─── AllEvents: a full page is partial ──────────────────────────────────────

def _allevents_html(n, start):
    blocks = "".join(
        '<script type="application/ld+json">' + json.dumps({
            "@type": "Event", "name": f"Event {i}", "startDate": f"{start.isoformat()}T19:00",
            "url": f"https://allevents.in/victoria-tx/e{i}/{1000000000 + i}",
            "location": {"name": "Hall", "address": {"addressLocality": "Victoria"}}}) + "</script>"
        for i in range(n))
    return f"<html>{blocks}</html>"


def test_allevents_capped_page_marks_the_run_partial(monkeypatch):
    def get(url, **k):
        # The live "all" page held exactly 45 Event blocks (2026-10-06).
        return _page(_allevents_html(45 if url.endswith("/all") else 3, d(2)))
    monkeypatch.setattr(ce, "http_get", get)
    ce.safe_fetch("allevents", ce.fetch_allevents_events)
    assert ce.source_status()["allevents"] == "partial"
    assert "all returned 45 (capped)" in ce.get_source_stats()[0]["message"]


def test_allevents_short_pages_stay_ok(monkeypatch):
    monkeypatch.setattr(ce, "http_get", lambda url, **k: _page(_allevents_html(12, d(2))))
    ce.safe_fetch("allevents", ce.fetch_allevents_events)
    assert ce.source_status()["allevents"] == "ok"


def test_allevents_cap_counts_events_outside_the_window():
    # The cap is about what the page listed, not what survived the filters.
    events, seen = [], set()
    assert ce._parse_allevents_page(_allevents_html(45, d(60)), events, seen) == 45
    assert events == []


# ─── VTX Art Walk ───────────────────────────────────────────────────────────

def _vtx(when):
    # The live markup (2026-10-06): a <br> between heading and date.
    return f"<p>Catch the next one</p><h2>Next Art Walk Event <br>{when}<br>4-8pm</h2>"


def test_vtx_artwalk_reads_the_date_across_the_br(monkeypatch):
    when = d(5)
    label = f"{when:%B} {when.day}th, {when.year}"
    seen = {}

    def get(url, headers=None, **k):
        seen["headers"] = headers
        return _page(_vtx(label))
    monkeypatch.setattr(ce, "http_get", get)
    evs = ce.fetch_vtx_artwalk(14)
    assert [e["date"] for e in evs] == [when.isoformat()]
    # The standard UA gets SiteGround's 202 captcha page.
    assert seen["headers"] is ce.HEADERS_SAFARI


def test_vtx_artwalk_captcha_page_warns_and_is_partial(monkeypatch):
    captcha = ('<html><head><meta http-equiv="refresh" '
               'content="0;/.well-known/sgcaptcha/?r=%2F"></meta></head></html>')
    calls = []
    monkeypatch.setattr(ce, "VTX_RETRY_PAUSE", 0)
    monkeypatch.setattr(ce, "http_get", lambda url, **k: calls.append(url) or _page(captcha, 202))
    assert ce.safe_fetch("vtx_artwalk", ce.fetch_vtx_artwalk, expect_events=False) == []
    assert any("VTX Art Walk" in w and "captcha" in w for w in ce._WARNINGS)
    assert "partial: captcha page" in ce.get_source_stats()[0]["message"]
    assert len(calls) == 2  # one retry: the challenge is often by request rate


def test_vtx_artwalk_retries_once_past_a_captcha(monkeypatch):
    when = d(5)
    pages = [_page("<meta content='0;/.well-known/sgcaptcha/'>", 202),
             _page(_vtx(f"{when:%B} {when.day}, {when.year}"))]
    monkeypatch.setattr(ce, "VTX_RETRY_PAUSE", 0)
    monkeypatch.setattr(ce, "http_get", lambda url, **k: pages.pop(0))
    assert [e["date"] for e in ce.fetch_vtx_artwalk(14)] == [when.isoformat()]


# ─── Victoria Generals ──────────────────────────────────────────────────────

def _generals_page(games):
    # Shape of the live page's inline FullCalendar data (2026-10-06).
    return ("<div id='calendar'></div><script>document.addEventListener('DOMContentLoaded', "
            f"function () {{\n        let events = {json.dumps(games)};\n"
            '        let initialDate = "2026-10-06";\n</script>')


def test_generals_reads_home_games_from_the_inline_schedule(monkeypatch):
    day = d(3)
    games = [
        {"title": "Brazos Valley Bombers", "start": f"{day}T19:05", "time": "19:05", "game_type": "home"},
        {"title": "Sherman Shadowcats", "start": f"{d(4)}T19:00", "time": "19:00", "game_type": "away"},
        {"title": "", "start": f"{d(5)}T19:05", "time": "19:05", "game_type": "home"},
        {"title": "SA River Monsters", "start": f"{d(40)}T19:05", "time": "19:05", "game_type": "home"},
    ]
    monkeypatch.setattr(ce, "http_get", lambda url, **k: _page(_generals_page(games)))
    evs = ce.safe_fetch("generals", ce.fetch_generals_events, expect_events=False)
    assert [(e["date"], e["name"], e["time"]) for e in evs] == [
        (day.isoformat(), "Victoria Generals Baseball vs Brazos Valley Bombers", "7:05 PM")]
    assert evs[0]["address"] == "405 Memorial Dr., Victoria, TX 77901"
    assert ce.source_status()["generals"] == "ok"


def test_generals_page_without_schedule_data_warns(monkeypatch):
    monkeypatch.setattr(ce, "http_get", lambda url, **k: _page("<div id='calendar'></div>"))
    assert ce.safe_fetch("generals", ce.fetch_generals_events, expect_events=False) == []
    assert any("Victoria Generals" in w for w in ce._WARNINGS)


def test_generals_off_season_is_quiet(monkeypatch):
    games = [{"title": "Brazos Valley Bombers", "start": "2026-06-03T19:05", "game_type": "home"}]
    monkeypatch.setattr(ce, "http_get", lambda url, **k: _page(_generals_page(games)))
    ce._WINDOW_START, ce._WINDOW_END = date(2026, 10, 6), date(2026, 10, 20)
    assert ce.safe_fetch("generals", ce.fetch_generals_events, expect_events=False) == []
    assert ce._WARNINGS == []


# ─── Moonshine ──────────────────────────────────────────────────────────────

def _run_main_web_only(tmp_path, monkeypatch):
    (tmp_path / "local_events.yaml").write_text("recurring: []\nevents: []\n")
    (tmp_path / "extras.yaml").write_text("new_and_notable: []\nsponsor: null\n")
    for name in dir(ce):
        if name.startswith("fetch_") and name.endswith(("_events", "_posts", "_artwalk", "_calendar", "_notable")):
            if name != "fetch_moonshine_events":
                monkeypatch.setattr(ce, name, lambda *a, **k: [])
    monkeypatch.setattr(ce, "drop_dead_links", lambda evs, **k: evs)
    monkeypatch.setattr(sys, "argv", [
        "collect_events.py", "--output", str(tmp_path / "events.json"),
        "--candidates", str(tmp_path / "candidates.json"), "--local-dir", str(tmp_path),
        "--days", "14", "--candidates-only", "--skip-ai",
    ])
    ce.main()


def test_moonshine_with_only_past_dates_does_not_warn(tmp_path, monkeypatch):
    # The live page on 2026-10-06: every listed date was in the spring.
    page = "<p>March 21 2026: Live Band Karaoke</p><p>May 09 2026: Mason Lively</p>"
    monkeypatch.setattr(ce.requests, "get", lambda *a, **k: _page(page))
    _run_main_web_only(tmp_path, monkeypatch)
    assert not any("moonshine" in w.lower() for w in ce._WARNINGS)
    stat = [s for s in ce.get_source_stats() if s["name"] == "moonshine"][0]
    assert stat["status"] == "empty" and "none in the window" in stat["message"]


def test_moonshine_page_without_dated_lines_warns(monkeypatch):
    monkeypatch.setattr(ce.requests, "get", lambda *a, **k: _page("<p>Welcome! Follow us on Facebook.</p>"))
    assert ce.safe_fetch("moonshine", ce.fetch_moonshine_events, expect_events=False) == []
    assert any("Moonshine" in w for w in ce._WARNINGS)


def test_moonshine_lists_in_window_events(monkeypatch):
    when = d(3)
    page = f"<p>{when:%B} {when.day:02d} {when.year}: Live Band Karaoke</p>"
    monkeypatch.setattr(ce.requests, "get", lambda *a, **k: _page(page))
    evs = ce.safe_fetch("moonshine", ce.fetch_moonshine_events, expect_events=False)
    assert [(e["date"], e["name"]) for e in evs] == [(when.isoformat(), "Live Band Karaoke")]


# ─── Gemini reply parsing ───────────────────────────────────────────────────

_ITEM = {"name": "Fall Fest", "date": "2026-10-10", "url": "https://x.org/fall"}


@pytest.mark.parametrize("reply", [
    "```json\n" + json.dumps([_ITEM]) + "\n```\nI verified each date on the source pages [1].",
    "Sources [1], [2]. Here they are:\n" + json.dumps([_ITEM]),
    "Here you go: " + json.dumps([_ITEM]) + " (see [3] and [4])",
    json.dumps([_ITEM]),
])
def test_gemini_json_array_survives_brackets_in_prose(reply):
    assert ce._gemini_json_array(reply) == [_ITEM]


def test_gemini_json_array_empty_and_garbage():
    assert ce._gemini_json_array("[]") == []
    assert ce._gemini_json_array("No events found [1].") == []
    assert ce._gemini_json_array("") == []


# ─── Religious filter: secular names ────────────────────────────────────────

@pytest.mark.parametrize("name", [
    "The Lord of the Rings Trivia Night",
    "Film Society: The Lord of the Rings: The Fellowship of the Ring",
    "Evangeline Live at Moonshine",
    "Evangeline Made: A Tribute to Louisiana Music",
])
def test_secular_names_are_not_religious(name):
    assert ce.non_event_reason({"name": name, "venue": "Moonshine Drinkery"}) != "religious event"


@pytest.mark.parametrize("name", [
    "Praise the Lord Revival Night",
    "Seeking the Lord Prayer Breakfast",
    "Evangelism Training",
    "Evangelistic Crusade",
])
def test_religious_names_still_drop(name):
    assert ce.non_event_reason({"name": name, "venue": "Hall"}) == "religious event"


# ─── "Bingo" vs "Bingo Night" ───────────────────────────────────────────────

def _ev(name, t="9:00 PM", venue="Aero Crafters"):
    return {"date": d(3).isoformat(), "name": name, "time": t, "venue": venue}


@pytest.mark.parametrize("a,b", [
    ("Bingo Night", "Bingo"),
    ("Trivia Night", "Trivia Tuesday"),
    ("Karaoke Night", "Karaoke"),
])
def test_one_word_and_night_form_merge_at_one_place_and_time(a, b):
    assert ce.is_same_event(_ev(a), _ev(b))
    assert len(ce.merge_events([_ev(a), _ev(b)])) == 1


def test_night_form_stays_separate_at_another_time_or_place():
    assert not ce.is_same_event(_ev("Bingo Night", "6:00 PM"), _ev("Bingo", "9:00 PM"))
    assert not ce.is_same_event(_ev("Bingo Night"), _ev("Bingo", venue="Moonshine Drinkery"))
    assert not ce.is_same_event(_ev("Bingo Night", ""), _ev("Bingo", ""))


# ─── FB events: midnight placeholder ────────────────────────────────────────

def _central_midnight_utc(day):
    local = datetime.combine(day, time(0, 0), tzinfo=ZoneInfo("America/Chicago"))
    return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def test_fb_event_midnight_start_is_blanked(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    monkeypatch.setattr(ce, "_load_venue_list", lambda: ([{"name": "x"}], "venues.json"))
    items = [
        {"id": "1", "name": "Student Recital", "utcStartDate": _central_midnight_utc(d(3)),
         "location": {"name": "Hall", "city": "Victoria, TX"}},
        {"id": "2", "name": "Late Show", "utcStartDate": _central_midnight_utc(d(4)).replace("T05", "T03").replace("T06", "T04"),
         "location": {"name": "Hall", "city": "Victoria, TX"}},
        {"id": "3", "name": "Open Mic", "startTime": "Sat, Oct 10 at 12:00 AM",
         "utcStartDate": d(5).isoformat(), "location": {"name": "Hall", "city": "Victoria, TX"}},
    ]
    monkeypatch.setattr(ce, "_run_apify_search", lambda actor, payload, token:
                        items if actor == ce.APIFY_FB_ACTOR else [])
    evs = {e["name"]: e for e in ce.fetch_apify_facebook_events(14)}
    assert evs["Student Recital"]["time"] == ""
    assert evs["Student Recital"]["date"] == d(3).isoformat()
    assert evs["Late Show"]["time"] == "10:00 PM"
    assert evs["Open Mic"]["time"] == ""
