"""Regression tests for the third collector review: the Apify token kept out
of URLs and warnings, page failures marking a scraper partial, chamber
descriptions, recurring post events with a start or end, unquoted dates in
extras.yaml, and the deadline in gap filling and New & Notable."""

import json
import os
import sys
import time
from datetime import date, timedelta
from unittest.mock import MagicMock

import pytest
import requests
from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce  # noqa: E402
import discover_venues as dv  # noqa: E402

TOKEN = "apify_api_SECRETSECRETSECRET"


@pytest.fixture(autouse=True)
def _state(monkeypatch):
    today = date.today()
    ce._WINDOW_START = today
    ce._WINDOW_END = today + timedelta(days=14)
    ce._RUN_STARTED = None
    ce._APIFY_LIMIT_TRIPPED = False
    ce._OPENAI_DEAD = False
    ce.reset_source_stats()
    for k in ("GEMINI_API_KEY", "APIFY_TOKEN", "OPENAI_API_KEY", "FB_POSTS_ENABLED", "IG_POSTS_ENABLED"):
        monkeypatch.delenv(k, raising=False)
    yield
    ce._RUN_STARTED = None


def d(n):
    return (date.today() + timedelta(days=n)).isoformat()


def _page(status=200, text=""):
    r = MagicMock()
    r.status_code, r.text = status, text
    r.raise_for_status = lambda: None
    return r


# ─── The Apify token stays out of URLs and warnings ─────────────────────────

def _connect_error_post(seen):
    """Fails the way a DNS/connect/SSL error does: requests' text holds the URL."""
    def post(url, **kw):
        seen.append((url, kw.get("headers") or {}))
        raise requests.ConnectionError(f"Max retries exceeded with url: {url} (Caused by NameResolutionError)")
    return post


def test_apify_token_goes_in_a_header_not_the_url(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", TOKEN)
    for k in ("FB_POSTS_ENABLED", "IG_POSTS_ENABLED"):
        monkeypatch.setenv(k, "1")
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    venues = [{"name": "V", "confidence": "high", "tier": "HIGH", "facebook_page": "https://facebook.com/v",
               "instagram": "https://instagram.com/v"}]
    monkeypatch.setattr(ce, "_load_venue_list", lambda: (venues, "venues.json"))
    seen = []
    monkeypatch.setattr(ce.requests, "post", _connect_error_post(seen))

    ce._run_apify_search(ce.APIFY_FB_ACTOR, {}, TOKEN)
    ce.fetch_apify_eventbrite_events()
    ce.fetch_apify_facebook_posts()
    ce.fetch_apify_instagram_posts()

    assert len(seen) >= 4
    for url, headers in seen:
        assert TOKEN not in url and "token=" not in url, url
        assert headers.get("Authorization") == f"Bearer {TOKEN}"
    assert ce._WARNINGS
    assert not any("SECRET" in w for w in ce._WARNINGS), ce._WARNINGS


def test_warnings_redact_url_secrets(capsys):
    ce._warn("run failed", error="Max retries exceeded with url: /x?token=abc123&timeout=5 (Caused by X)")
    ce._warn("geo", error="https://maps.example/api?key=K9&q=1 and ?api_key=Z')")
    text = " ".join(ce._WARNINGS) + capsys.readouterr().out
    for secret in ("abc123", "K9", "Z'"):
        assert secret not in text
    assert "token=***&timeout=5" in text and "key=***&q=1" in text


def test_discover_venues_sends_the_token_in_a_header(monkeypatch, capsys):
    seen = []
    items = dv.run_apify_discovery(TOKEN, http_post=_connect_error_post(seen),
                                   sleep=lambda s: None, total_budget_seconds=10_000)
    assert items == [] and seen
    for url, headers in seen:
        assert TOKEN not in url and "token=" not in url
        assert headers.get("Authorization") == f"Bearer {TOKEN}"
    assert "SECRET" not in capsys.readouterr().out


def test_discover_venues_warnings_redact_url_secrets(capsys):
    dv._warn("failed", error="/v2/acts/x?token=abc123&timeout=5")
    out = capsys.readouterr().out
    assert "abc123" not in out and "token=***" in out


# ─── A failed page makes the run partial, not ok ────────────────────────────

def test_library_week_failure_marks_partial(monkeypatch):
    calls = []

    def get(url, **k):
        calls.append(url)
        if len(calls) == 1:
            raise requests.ConnectionError("reset")
        return _page(text="<html></html>")
    monkeypatch.setattr(ce, "http_get", get)
    ce.fetch_library_events()
    assert len(calls) > 1
    assert ce._SOURCE_PARTIAL.get("library")


def test_jwelch_date_failure_marks_partial(monkeypatch):
    def get(url, **k):
        if url.endswith(d(0)):
            raise requests.ConnectionError("reset")
        return _page(text="<html></html>")
    monkeypatch.setattr(ce.requests, "get", get)
    ce.fetch_jwelch_events()
    assert ce._SOURCE_PARTIAL.get("jwelch")


def test_city_calendar_detail_failures_mark_partial(monkeypatch):
    listing = '<a href="Calendar.aspx?EID=101">a</a><a href="Calendar.aspx?EID=102">b</a>'

    def get(url, **k):
        if url.endswith("EID=101"):
            return _page(503)
        if url.endswith("EID=102"):
            raise requests.ReadTimeout("slow")
        return _page(text=listing)
    monkeypatch.setattr(ce.requests, "get", get)
    ce.fetch_city_calendar()
    reasons = " ".join(ce._SOURCE_PARTIAL.get("city_calendar", []))
    assert "101" in reasons and "102" in reasons


def test_chamber_detail_failures_mark_partial(monkeypatch):
    listing = '<a href="/events/details/a-1">a</a><a href="/events/details/b-2">b</a>'

    def get(url, **k):
        if url.endswith("a-1"):
            return _page(500)
        if url.endswith("b-2"):
            raise requests.ReadTimeout("slow")
        return _page(text=listing)
    monkeypatch.setattr(ce.requests, "get", get)
    ce.fetch_chamber_events()
    assert len(ce._SOURCE_PARTIAL.get("chamber", [])) == 2


# ─── Chamber descriptions ───────────────────────────────────────────────────

def test_chamber_description_drops_the_label_and_cuts_on_a_word(monkeypatch):
    when = date.today() + timedelta(days=2)
    slug = when.strftime("%m-%d-%Y")
    long_text = ("Join Golden Crescent CASA for CASA-Tober Fest, an evening of food trucks, "
                 "live music, a silent auction and family games supporting children in foster care "
                 "across the Crossroads region of South Texas.")
    detail = (f"<h1>CASA-Tober Fest</h1><div class='gz-details-description'>"
              f"<h3>Description</h3><p>{long_text}</p></div>")
    listing = f'<a href="/events/details/casa-tober-fest-{slug}-1">x</a>'

    def get(url, **k):
        return _page(text=detail if "/details/" in url else listing)
    monkeypatch.setattr(ce.requests, "get", get)
    [ev] = ce.fetch_chamber_events()
    desc = ev["description"]
    assert desc.startswith("Join Golden Crescent CASA")
    assert len(desc) <= ce.CHAMBER_DESC_LIMIT + 1
    assert desc.endswith("…")
    assert desc[:-1] == long_text[:len(desc) - 1]
    assert long_text[len(desc) - 1] in " ,"  # cut between words


def test_chamber_description_keeps_a_word_starting_with_description():
    el = BeautifulSoup("<div>Descriptions of the day</div>", "html.parser").div
    assert ce._chamber_description(el) == "Descriptions of the day"


# ─── Recurring post events respect a stated start or end ───────────────────

def test_recurring_post_event_clips_to_its_start_and_end():
    start = date(2026, 10, 5)  # a Monday
    end = start + timedelta(days=27)
    fridays = lambda out: [x.isoformat() for x in out]
    base = {"recurring": True, "weekday": "Friday", "name": "Karaoke"}
    assert fridays(ce._post_event_dates(base, start, end)) == [
        "2026-10-09", "2026-10-16", "2026-10-23", "2026-10-30"]
    assert fridays(ce._post_event_dates({**base, "starts": "2026-10-16"}, start, end)) == [
        "2026-10-16", "2026-10-23", "2026-10-30"]
    assert fridays(ce._post_event_dates({**base, "ends": "2026-10-23"}, start, end)) == [
        "2026-10-09", "2026-10-16", "2026-10-23"]
    # A garbled bound is ignored rather than dropping the series.
    assert len(ce._post_event_dates({**base, "starts": "soon", "ends": ""}, start, end)) == 4


def test_post_prompt_asks_for_series_start_and_end(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    monkeypatch.setenv("FLYER_IMAGES", "0")
    sent = {}

    def chat(api_key, messages, max_tokens, timeout=60):
        sent["prompt"] = messages[0]["content"]
        return "[]"
    monkeypatch.setattr(ce, "_openai_chat", chat)
    ce._extract_events_from_posts_via_ai("Pour Haus", [{"text": "Karaoke every Friday", "time": "2026-10-02"}])
    assert '"starts"' in sent["prompt"] and '"ends"' in sent["prompt"]


# ─── Unquoted dates in extras.yaml ──────────────────────────────────────────

def _run_main(tmp_path, monkeypatch, extras, notable):
    (tmp_path / "local_events.yaml").write_text("recurring: []\nevents: []\n")
    (tmp_path / "extras.yaml").write_text(extras)
    for name in dir(ce):
        if name.startswith("fetch_") and name.endswith(("_events", "_posts", "_artwalk", "_calendar")):
            monkeypatch.setattr(ce, name, lambda *a, **k: [])
    monkeypatch.setattr(ce, "drop_dead_links", lambda evs, **k: evs)
    monkeypatch.setattr(ce, "fetch_gemini_notable", notable)
    monkeypatch.setattr(sys, "argv", [
        "collect_events.py", "--output", str(tmp_path / "events.json"),
        "--candidates", str(tmp_path / "candidates.json"), "--local-dir", str(tmp_path),
        "--days", "14", "--candidates-only", "--skip-ai",
    ])
    ce.main()
    return json.loads((tmp_path / "candidates.json").read_text())


def _found_notable():
    ce._NOTABLE_FETCHED = True
    return []


def test_unquoted_dates_in_extras_yaml_dont_crash_the_write(tmp_path, monkeypatch):
    extras = ("new_and_notable:\n  - name: Hand Pick\n    added: 2026-10-06\n"
              "sponsor:\n  name: S\n  ends: 2026-11-01\n")
    out = _run_main(tmp_path, monkeypatch, extras, _found_notable)
    assert out["new_and_notable"] == [{"name": "Hand Pick", "added": "2026-10-06"}]
    assert ce.load_extras(str(tmp_path / "extras.yaml"))["sponsor"]["ends"] == "2026-11-01"
    assert not (tmp_path / "candidates.json.tmp").exists()


# ─── The deadline covers gap filling's page checks and New & Notable ───────

def _gemini_reply(items, hosts=("facebook.com",)):
    r = MagicMock()
    r.status_code = 200
    r.json.return_value = {"candidates": [{
        "content": {"parts": [{"text": json.dumps(items)}]},
        "groundingMetadata": {"groundingChunks": [{"web": {"title": h}} for h in hosts]},
    }]}
    return r


def _thin(n, name):
    return {"date": d(n), "name": name, "time": "", "venue": "Mercy House", "address": "",
            "description": "Trunk or treat.", "url": "", "icons": ["family"], "_source": "local_events"}


def test_enrich_starts_no_page_checks_past_the_deadline(monkeypatch, tmp_path):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    cache = tmp_path / "enrichment_cache.json"
    evs = [_thin(2, "Trunk or Treat"), _thin(3, "Fall Fest")]
    reply = [{"id": i, "source": "https://facebook.com/mercyhouse/posts/1",
              "url": "https://facebook.com/events/123", "time": "4:30 PM"} for i in (1, 2)]
    monkeypatch.setattr(ce, "_RUN_STARTED", time.time() - (ce.COLLECT_DEADLINE_MIN + 1) * 60)
    gets = []

    def get(u):
        gets.append(u)
        return _page(text="Trunk or Treat Fall Fest")
    ce.enrich_thin_events(evs, cache_path=str(cache), post=lambda *a, **k: _gemini_reply(reply), get=get)
    assert gets == []
    # Unchecked answers aren't cached, so the next run looks them up again.
    assert json.loads(cache.read_text()) == {}


def test_enrich_still_checks_pages_before_the_deadline(monkeypatch, tmp_path):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    evs = [_thin(2, "Trunk or Treat"), _thin(3, "Fall Fest")]
    reply = [{"id": i, "source": "https://facebook.com/mercyhouse/posts/1",
              "url": "https://facebook.com/events/123", "time": "4:30 PM"} for i in (1, 2)]
    out = ce.enrich_thin_events(evs, cache_path=str(tmp_path / "c.json"),
                                post=lambda *a, **k: _gemini_reply(reply),
                                get=lambda u: _page(text="Trunk or Treat Fall Fest"))
    assert [e["time"] for e in out] == ["4:30 PM", "4:30 PM"]


def test_new_and_notable_is_skipped_past_the_deadline(tmp_path, monkeypatch):
    called = []

    def notable():
        called.append(1)
        return _found_notable()
    monkeypatch.setattr(ce, "past_deadline", lambda: True)
    out = _run_main(tmp_path, monkeypatch, "new_and_notable: []\nsponsor: null\n", notable)
    assert called == []
    assert "new_and_notable" not in out
