"""town_feeds.py: the iCalendar, The Events Calendar and Localist readers
behind the "town_feeds" collector source, and the source itself."""
import glob
import json
import os
from datetime import date
from zoneinfo import ZoneInfo

import pytest

import collect_events
import town
import town_feeds

ROOT = os.path.dirname(os.path.abspath(__file__))
CT = ZoneInfo("America/Chicago")
START, END = date(2026, 10, 12), date(2026, 10, 25)

ICS = (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"
    # A TZID start and end, a folded description with escapes, a URL.
    "BEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Fall Fest on Fairpark\r\n"
    "DTSTART;TZID=America/Chicago:20261016T190000\r\nDTEND;TZID=America/Chicago:20261016T210000\r\n"
    "LOCATION:Fairpark\\, 100 Main St\\, Tupelo\\, MS\r\n"
    "DESCRIPTION:Live music\\, food trucks\\nand a kids' zone. Bring a\r\n  chair.\r\n"
    "URL:https://example.org/fest\r\nEND:VEVENT\r\n"
    # UTC: 01:30Z on the 18th is 8:30 PM on the 17th in Central.
    "BEGIN:VEVENT\r\nUID:2\r\nSUMMARY:Late Show\r\nDTSTART:20261018T013000Z\r\nEND:VEVENT\r\n"
    # All day.
    "BEGIN:VEVENT\r\nUID:3\r\nSUMMARY:Craft Fair\r\nDTSTART;VALUE=DATE:20261024\r\nDTEND;VALUE=DATE:20261025\r\nEND:VEVENT\r\n"
    # Cancelled, outside the window, no summary: all left out.
    "BEGIN:VEVENT\r\nUID:4\r\nSUMMARY:Called Off\r\nSTATUS:CANCELLED\r\nDTSTART:20261020T180000\r\nEND:VEVENT\r\n"
    "BEGIN:VEVENT\r\nUID:5\r\nSUMMARY:Too Late\r\nDTSTART:20261130T180000\r\nEND:VEVENT\r\n"
    "BEGIN:VEVENT\r\nUID:6\r\nDTSTART:20261020T180000\r\nEND:VEVENT\r\n"
    "END:VCALENDAR\r\n"
)


def test_ics_reads_times_in_the_towns_zone():
    evs = town_feeds.parse_ics(ICS, CT, START, END)
    assert [e["name"] for e in evs] == ["Fall Fest on Fairpark", "Late Show", "Craft Fair"]
    fest, late, fair = evs
    assert fest["date"] == "2026-10-16" and fest["time"] == "7:00 PM – 9:00 PM"
    assert fest["venue"] == "Fairpark" and fest["address"] == "100 Main St, Tupelo, MS"
    assert fest["description"] == "Live music, food trucks and a kids' zone. Bring a chair."
    assert fest["url"] == "https://example.org/fest"
    assert late["date"] == "2026-10-17" and late["time"] == "8:30 PM"
    assert fair["date"] == "2026-10-24" and fair["time"] == ""


def test_ics_floating_time_is_the_towns():
    text = "BEGIN:VEVENT\nSUMMARY:Trivia\nDTSTART:20261014T190000\nEND:VEVENT\n"
    assert town_feeds.parse_ics(text, ZoneInfo("America/Los_Angeles"), START, END)[0]["time"] == "7:00 PM"


TRIBE_PAGE_1 = {
    "events": [
        {"title": "Brews on the Bricks", "start_date": "2026-10-17 18:00:00", "end_date": "2026-10-17 21:00:00",
         "all_day": False, "url": "https://visit.example/event/brews/", "description": "<p>Local breweries pour.</p>",
         "cost": "Free", "venue": {"venue": "Downtown Kearney", "address": "2100 Central Ave", "city": "Kearney"}},
        {"title": "Crane Count", "start_date": "2026-10-20 00:00:00", "end_date": "2026-10-20 23:59:59",
         "all_day": True, "url": "https://visit.example/event/cranes/", "venue": []},
        {"title": "Out of window", "start_date": "2026-11-20 10:00:00", "end_date": "2026-11-20 11:00:00"},
    ],
    "next_rest_url": "https://visit.example/wp-json/tribe/events/v1/events?page=2",
}


def test_tribe_page():
    evs, nxt = town_feeds.parse_tribe(TRIBE_PAGE_1, CT, START, END)
    assert nxt.endswith("page=2")
    brews, cranes = evs
    assert brews["time"] == "6:00 PM – 9:00 PM" and brews["free"] is True
    assert brews["venue"] == "Downtown Kearney" and brews["address"] == "2100 Central Ave, Kearney"
    assert brews["description"] == "Local breweries pour."
    assert cranes["time"] == "" and cranes["venue"] == "" and "free" not in cranes


LOCALIST = {
    "events": [{"event": {
        "title": "Harvest Concert", "localist_url": "https://cal.example/event/harvest", "location_name": "Craterian",
        "address": "23 S Central Ave, Medford", "description_text": "Bluegrass to close the season.", "free": False,
        "event_instances": [
            {"event_instance": {"start": "2026-10-17T19:30:00-07:00", "end": "2026-10-17T21:30:00-07:00"}},
            {"event_instance": {"start": "2026-10-24T19:30:00-07:00", "end": None}},
            {"event_instance": {"start": "2026-12-01T19:30:00-08:00"}},
        ]}}],
    "page": {"current": 1, "size": 100, "total": 3},
}


def test_localist_instances_inside_the_window():
    evs, total = town_feeds.parse_localist(LOCALIST, ZoneInfo("America/Los_Angeles"), START, END)
    assert total == 3
    assert [(e["date"], e["time"]) for e in evs] == [("2026-10-17", "7:30 PM – 9:30 PM"), ("2026-10-24", "7:30 PM")]
    assert evs[0]["venue"] == "Craterian" and evs[0]["url"] == "https://cal.example/event/harvest"


class _Resp:
    def __init__(self, body):
        self.body = body
        self.text = body if isinstance(body, str) else json.dumps(body)

    def json(self):
        return self.body


def test_fetch_feed_follows_pages_and_stops_at_the_cap():
    calls = []

    def get(url):
        calls.append(url)
        return _Resp(TRIBE_PAGE_1)          # every page says there's another

    evs = town_feeds.fetch_feed({"name": "v", "type": "tribe", "url": "https://visit.example/"}, get, CT, START, END)
    assert len(calls) == town_feeds.MAX_PAGES and len(evs) == 2 * town_feeds.MAX_PAGES
    assert calls[0] == "https://visit.example/wp-json/tribe/events/v1/events?start_date=2026-10-12&end_date=2026-10-25%2023:59:59&per_page=50"

    calls.clear()
    town_feeds.fetch_feed({"name": "c", "type": "localist", "url": "https://cal.example"},
                          lambda u: calls.append(u) or _Resp(LOCALIST), CT, START, END)
    assert [c.rsplit("page=", 1)[1] for c in calls] == ["1", "2", "3"]
    assert "start=2026-10-12&days=14" in calls[0]


@pytest.mark.parametrize("feeds,msg", [
    ("x", "must be a list"),
    ([{"name": "Bad Name", "type": "ics", "url": "https://a"}], "snake_case"),
    ([{"name": "a", "type": "rss", "url": "https://a"}], "type must be"),
    ([{"name": "a", "type": "ics", "url": "http://a"}], "https://"),
    ([{"name": "a", "type": "ics", "url": "https://a"}, {"name": "a", "type": "ics", "url": "https://b"}], "unique"),
])
def test_check_feeds_rejects(feeds, msg):
    with pytest.raises(ValueError, match=msg):
        town_feeds.check_feeds(feeds)


@pytest.mark.parametrize("path", sorted(glob.glob(os.path.join(ROOT, "towns", "*", "town.json"))))
def test_every_towns_feeds_are_valid(path):
    town_feeds.check_feeds(json.load(open(path)).get("feeds"))


def test_victoria_does_not_run_feeds():
    assert "town_feeds" not in [n for n, _, _ in collect_events.enabled_web_sources(town.VICTORIA)]


def test_source_keeps_going_when_one_feed_fails(monkeypatch):
    t = town.town_config(town={"id": "bay", "siteName": "The Bay 979", "domain": "thebay979.com", "city": "Bay City",
                               "state": "TX", "stateName": "Texas", "timezone": "America/Chicago",
                               "feeds": [{"name": "broken", "type": "ics", "url": "https://broken.example/c.ics"},
                                         {"name": "good", "type": "ics", "url": "https://good.example/c.ics"}]})
    monkeypatch.setattr(collect_events, "TOWN", t)
    monkeypatch.setattr(collect_events, "_WINDOW_START", START)
    monkeypatch.setattr(collect_events, "_WINDOW_END", END)

    def get(url, **_):
        if "broken" in url:
            raise RuntimeError("HTTP 500")
        return _Resp(ICS)

    monkeypatch.setattr(collect_events, "http_get", get)
    evs = collect_events.safe_fetch("town_feeds", collect_events.fetch_town_feeds, args=(14,), expect_events=False)
    assert [e["name"] for e in evs] == ["Fall Fest on Fairpark", "Late Show", "Craft Fair"]
    assert all(e["_source"] == "town_feeds" and e["_feed"] == "good" and e["icons"] for e in evs)
    stat = [s for s in collect_events._SOURCE_STATS if s["name"] == "town_feeds"][-1]
    assert stat["status"] == "partial" and "broken failed" in stat["message"] and "good 3" in stat["message"]
