"""Tests for collector quality: Victoria-only filter, venue cleanup, fuzzy
dedupe, source preference, and the scraper fixes that feed them.

Cases come from the 2026-09-28 run, where duplicates like "Tejas Fest" /
"Tejas Fest 2026" and "Disney Pixar's Finding Nemo JR." / "Disney's Finding
Nemo JR" reached the admin as separate candidates.
"""
import datetime
import json
import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce


def setup_module(_):
    ce._WINDOW_START = datetime.date(2026, 9, 28)
    ce._WINDOW_END = datetime.date(2026, 10, 12)


def ev(name, date="2026-10-02", venue="", address="", source=None, **kw):
    e = {"date": date, "name": name, "venue": venue, "address": address,
         "time": kw.pop("time", ""), "description": kw.pop("description", ""),
         "url": kw.pop("url", ""), "icons": kw.pop("icons", []), "free": kw.pop("free", False)}
    if source:
        e["_source"] = source
    e.update(kw)
    return e


# ─── Location ─────────────────────────────────────────────────────────────

def test_victoria_addresses_pass():
    assert ce.out_of_area_reason(ev("Bingo", venue="Palace Bingo", address="5306 Houston Hwy")) is None
    assert ce.out_of_area_reason(ev("Fest", venue="Inez Community Center", address="2511 Garcitas Creek Rd, Inez, TX 77968")) is None
    assert ce.out_of_area_reason(ev("Show", venue="Welder Center", address="214 N Main St, Victoria, TX 77901")) is None


def test_other_towns_are_dropped():
    assert ce.out_of_area_reason(ev("Turkeyfest", venue="Cuero Municipal Park", address="")) == "town cuero"
    assert ce.out_of_area_reason(ev("Market", venue="Downtown", address="100 Main St, 77954")) == "zip 77954"
    assert ce.out_of_area_reason(ev("Gala", description="Join us at the pavilion, Port Lavaca, TX")) == "town port lavaca"


def test_merge_drops_out_of_area_but_trusts_local_yaml():
    out = ce.merge_events([
        ev("Turkeyfest", venue="Cuero Municipal Park", source="allevents"),
        ev("Shiner Music Fest", venue="Shiner", source="local_events"),
    ], venues=[])
    assert [e["name"] for e in out] == ["Shiner Music Fest"]


# ─── Venue cleanup ────────────────────────────────────────────────────────

def test_address_in_venue_field_moves_to_address_and_matches_venue_list():
    e = ev("Tejas Fest 2026", venue="101 N. Main St, Victoria, TX, United States, Texas 77901")
    ce.clean_venue(e, [{"name": "De Leon Plaza", "address": "101 North Main Street"}])
    assert e["venue"] == "De Leon Plaza"
    assert e["address"] == "101 N. Main St"


def test_address_venue_without_match_keeps_street():
    e = ev("Seminar", venue="2002 E Mockingbird Ln, Victoria, TX, United States, Texas 77904")
    ce.clean_venue(e, [])
    assert e["venue"] == "2002 E Mockingbird Ln"


def test_real_venue_names_untouched():
    e = ev("Show", venue="Aero Crafters", address="309 E Crestwood Dr")
    ce.clean_venue(e, [])
    assert e["venue"] == "Aero Crafters"


# ─── Dedupe ───────────────────────────────────────────────────────────────

def test_same_event_variants_match():
    assert ce.is_same_event(ev("Tejas Fest"), ev("Tejas Fest 2026"))
    assert ce.is_same_event(ev("Disney Pixar’s Finding Nemo JR."), ev("Disney's Finding Nemo JR"))
    assert ce.is_same_event(ev("The Life of the Party: Film Screening and Discussion", venue="Welder Center"),
                            ev("The Life of the Party", venue="Welder Center"))
    assert ce.is_same_event(
        ev("6th Realm Night Market October 10th- Street spots $45", venue="502 E Juan Linn St"),
        ev("6th Realm Night Market", venue="Around the Haus, 502 E Juan Linn St"))


def test_different_events_do_not_match():
    assert not ce.is_same_event(ev("Wednesday Night Karaoke", venue="Shooters Bar"),
                                ev("VARRA Wednesday Night Run", venue="Riverside Stadium"))
    # Contained name at a different place is a different event.
    assert not ce.is_same_event(ev("Tejas Fest", venue="Victoria Main Street Program"),
                                ev("Chihuahua Races at Tejas Fest", venue="DeLeon City Plaza"))
    assert not ce.is_same_event(ev("Tejas Fest", date="2026-10-02"), ev("Tejas Fest", date="2026-10-03"))


def test_merge_prefers_official_source_and_fills_gaps():
    out = ce.merge_events([
        ev("Tejas Fest 2026", time="05:30 PM", address="101 N Main St", source="allevents",
           url="https://allevents.in/x"),
        ev("Tejas Fest", venue="Victoria Public Library", description="Free downtown festival.",
           source="library", url="https://victoriapl.librarycalendar.com/x"),
    ], venues=[])
    assert len(out) == 1
    m = out[0]
    assert m["name"] == "Tejas Fest"
    assert m["url"].startswith("https://victoriapl")      # library outranks allevents
    assert m["time"] == "05:30 PM"                         # filled from the other record
    assert m["_source"] == "library"
    assert m["_also_from"] == ["allevents"]


def test_merge_replaces_organizer_account_with_real_venue():
    venues = [{"name": "Discover Victoria Texas", "category": "Tourism / Events Aggregator"}]
    out = ce.merge_events([
        ev("Disney Pixar’s Finding Nemo JR.", venue="Discover Victoria Texas",
           description="Musical.", url="https://instagram.com/p/1", source="apify_instagram_posts"),
        ev("Disney's Finding Nemo JR", venue="Leo J. Welder Center for the Performing Arts",
           url="https://allevents.in/y", source="apify_instagram_posts"),
    ], venues=venues)
    assert len(out) == 1
    assert out[0]["venue"] == "Leo J. Welder Center for the Performing Arts"


def test_safe_fetch_tags_source():
    out = ce.safe_fetch("library", lambda: [ev("Story Time")], expect_events=False)
    assert out[0]["_source"] == "library"


# ─── Post extraction venue ────────────────────────────────────────────────

def test_post_event_venue_uses_named_venue_when_elsewhere():
    assert ce._post_event_venue({"venue": "DeLeon Plaza"}, "Discover Victoria Texas", "") == ("DeLeon Plaza", "")
    assert ce._post_event_venue({"venue": ""}, "Aero Crafters", "309 E Crestwood") == ("Aero Crafters", "309 E Crestwood")
    assert ce._post_event_venue({"venue": "Aero Crafters patio"}, "Aero Crafters", "309 E Crestwood") == ("Aero Crafters", "309 E Crestwood")


def test_extraction_prompt_asks_for_venue_and_victoria_only():
    captured = {}

    def fake_chat(api_key, messages, max_tokens, timeout=60):
        captured["prompt"] = messages[0]["content"]
        return "[]"

    with patch.dict(os.environ, {"OPENAI_API_KEY": "x"}), patch.object(ce, "_openai_chat", side_effect=fake_chat):
        ce._extract_events_from_posts_via_ai("Discover Victoria Texas", [{"text": "Big show Friday", "time": "2026-10-01"}])
    assert '"venue"' in captured["prompt"]
    assert "Victoria County" in captured["prompt"]


# ─── AllEvents multi-page ─────────────────────────────────────────────────

def _allevents_html(events):
    blocks = "".join(
        '<script type="application/ld+json">' + json.dumps({
            "@type": "Event", "name": n, "startDate": d, "url": u,
            "location": {"name": "Venue", "address": {"addressLocality": "Victoria", "streetAddress": "1 Main St"}},
        }) + "</script>"
        for n, d, u in events
    )
    return "<html><body>" + blocks + "</body></html>"


def test_allevents_reads_several_pages_and_dedupes_by_url():
    pages = {
        "all": _allevents_html([("A", "2026-10-01", "https://allevents.in/victoria/a/1000000001")]),
        "music": _allevents_html([("A", "2026-10-01", "https://allevents.in/victoria/a/1000000001"),
                                  ("B", "2026-10-02", "https://allevents.in/victoria/b/1000000002")]),
    }

    def fake_get(url, **kw):
        key = url.rsplit("/", 1)[-1]
        if key not in pages:
            raise RuntimeError("404")
        r = MagicMock()
        r.text = pages[key]
        r.raise_for_status = lambda: None
        return r

    with patch.object(ce, "http_get", side_effect=fake_get):
        out = ce.fetch_allevents_events()
    assert sorted(e["name"] for e in out) == ["A", "B"]


# ─── FB posts placeholder items ───────────────────────────────────────────

def test_fb_posts_ignores_apify_error_placeholders(monkeypatch):
    monkeypatch.setenv("FB_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "t")
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    monkeypatch.setattr(ce, "_APIFY_LIMIT_TRIPPED", False)
    venues = [{"name": "Dead Page Bar", "confidence": "high",
               "facebook_page": "https://facebook.com/deadpage"}]
    monkeypatch.setattr(ce, "_load_venue_list", lambda: (venues, "venues.json"))
    resp = MagicMock(status_code=200, text="[]")
    resp.json.return_value = [{"url": "https://facebook.com/deadpage", "error": "no_items"}]
    resp.raise_for_status = lambda: None
    called = []
    monkeypatch.setattr(ce, "_extract_events_from_posts_via_ai", lambda *a: called.append(a) or [])
    with patch.object(ce.requests, "post", return_value=resp):
        out = ce.fetch_apify_facebook_posts()
    assert out == []
    assert called == []  # no OpenAI call for a page with zero real posts


# ─── Eventbrite + Facebook events ─────────────────────────────────────────

def _apify_resp(items):
    r = MagicMock(status_code=200)
    r.json.return_value = items
    return r


def test_eventbrite_maps_fields_and_filters(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    monkeypatch.delenv("EVENTBRITE_ENABLED", raising=False)
    monkeypatch.setattr(ce, "_APIFY_LIMIT_TRIPPED", False)
    items = [
        {"name": "Next Stop Comedy", "startDate": "2026-10-09T21:00", "venueName": "La Cantina",
         "venueAddressLine1": "123 Main St", "venueCity": "Victoria", "isFree": False,
         "summary": "Stand-up night.", "url": "https://www.eventbrite.com/e/123?aff=x"},
        {"name": "Online Webinar", "startDate": "2026-10-09T12:00", "isOnline": True},
        {"name": "Corpus Show", "startDate": "2026-10-09T19:00", "venueName": "Hall", "venueCity": "Corpus Christi"},
        {"name": "Far Future", "startDate": "2027-01-01T19:00", "venueCity": "Victoria"},
    ]
    with patch.object(ce.requests, "post", return_value=_apify_resp(items)):
        out = ce.fetch_apify_eventbrite_events()
    assert len(out) == 1
    e = out[0]
    assert (e["date"], e["time"], e["venue"], e["address"]) == ("2026-10-09", "9:00 PM", "La Cantina", "123 Main St")
    assert e["url"] == "https://www.eventbrite.com/e/123"
    assert e["free"] is False


def test_eventbrite_can_be_disabled(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    monkeypatch.setenv("EVENTBRITE_ENABLED", "0")
    with patch.object(ce.requests, "post") as post:
        assert ce.fetch_apify_eventbrite_events() == []
    post.assert_not_called()


def test_facebook_events_use_victoria_time_not_utc(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    monkeypatch.setattr(ce, "_APIFY_LIMIT_TRIPPED", False)
    monkeypatch.setattr(ce, "_load_venue_list", lambda: ([{"name": "x"}], "venues.json"))
    # 7 PM CDT on Oct 9 is 00:00Z on Oct 10.
    items = [{"name": "Late Show", "utcStartDate": "2026-10-10T00:00:00.000Z",
              "location": {"name": "Aero Crafters", "city": "Victoria, TX"}}]
    with patch.object(ce.requests, "post", return_value=_apify_resp(items)):
        out = ce.fetch_apify_facebook_events()
    assert out[0]["date"] == "2026-10-09"
    assert out[0]["time"] == "7:00 PM"


def test_facebook_events_runs_both_searches_and_dedupes(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    monkeypatch.delenv("FB_EVENTS_ALT_ENABLED", raising=False)
    monkeypatch.setattr(ce, "_APIFY_LIMIT_TRIPPED", False)
    monkeypatch.setattr(ce, "_load_venue_list", lambda: ([{"name": "x"}], "venues.json"))
    loc = {"name": "Hall", "city": "Victoria, TX"}
    by_actor = {
        ce.APIFY_FB_ACTOR: [{"id": "1", "name": "Shared", "utcStartDate": "2026-10-09T23:00:00Z", "location": loc}],
        ce.APIFY_FB_ALT_ACTOR: [{"id": "1", "name": "Shared", "utcStartDate": "2026-10-09T23:00:00Z", "location": loc},
                                {"id": "2", "name": "Only Alt", "utcStartDate": "2026-10-10T23:00:00Z", "location": loc}],
    }
    calls = []

    def fake_post(url, **kw):
        actor = url.split("/acts/")[1].split("/")[0]
        calls.append(actor)
        return _apify_resp(by_actor[actor])

    with patch.object(ce.requests, "post", side_effect=fake_post):
        out = ce.fetch_apify_facebook_events()
    assert calls == [ce.APIFY_FB_ACTOR, ce.APIFY_FB_ALT_ACTOR]
    assert sorted(e["name"] for e in out) == ["Only Alt", "Shared"]

    monkeypatch.setenv("FB_EVENTS_ALT_ENABLED", "0")
    calls.clear()
    with patch.object(ce.requests, "post", side_effect=fake_post):
        ce.fetch_apify_facebook_events()
    assert calls == [ce.APIFY_FB_ACTOR]


# ─── Non-event filter (2026-10 auto-publish) ────────────────────────────────

def test_non_event_reason_catches_listings_not_events():
    assert ce.non_event_reason(ev("Internship Program", venue="The Texas Zoo"))
    assert ce.non_event_reason(ev("Field Trip Booking", venue="J Welch Farms"))
    assert ce.non_event_reason(ev("National Drink Beer Day", venue="La Cantina"))
    assert ce.non_event_reason(ev("Now Hiring Bartenders"))
    # A real event on an awareness day, with a time, stays.
    assert ce.non_event_reason(ev("National Taco Day Party", time="6:00 PM")) is None
    assert ce.non_event_reason(ev("Job Fair", time="10:00 AM")) is None
    assert ce.non_event_reason(ev("Tejas Fest 2026")) is None


def test_merge_drops_non_events_and_decodes_entities():
    out = ce.merge_events([
        ev("Field Trip Booking", venue="J Welch Farms", source="apify_instagram_posts"),
        ev("Walk to End Alzheimer&#39;s", venue="Texas A&amp;M University-Victoria", source="allevents", time="9:00 AM"),
        ev("Field Trip Booking", venue="Somewhere", source="local_events"),  # curated YAML is trusted
    ], venues=[])
    names = [e["name"] for e in out]
    assert "Walk to End Alzheimer's" in names
    assert any(e["venue"] == "Texas A&M University-Victoria" for e in out)
    assert names.count("Field Trip Booking") == 1


def test_listing_urls_are_not_event_links():
    from collect_events import is_listing_url
    for u in ("https://www.eventbrite.com/b/tx--victoria/music/",
              "https://www.eventbrite.com/d/tx--victoria/events/",
              "https://allevents.in/victoria", "https://allevents.in/victoria/all",
              "https://www.facebook.com/events/"):
        assert is_listing_url(u), u
    for u in ("https://www.eventbrite.com/e/josh-abbott-acoustic-tickets-123456",
              "https://allevents.in/victoria/tejas-fest-2026/200030008232138",
              "https://www.facebook.com/events/1234567890/", ""):
        assert not is_listing_url(u), u
