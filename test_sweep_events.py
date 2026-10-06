"""Tests for scripts/sweep_events.py, the post-publish event check."""
import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
import sweep_events as sw  # noqa: E402


def ev(name, date="2026-10-06", time="", venue="", description="", page=None, **extra):
    return {"name": name, "date": date, "time": time, "venue": venue, "description": description,
            "address": "", "page": page or f"/events/{date}-x", **extra}


def kinds(findings):
    return [(i, k) for i, k, _ in findings]


def test_rules_catch_wrong_weekday_odd_time_church_and_duplicates():
    events = [
        ev("Monday Night Bingo", date="2026-10-06", time="6:00 PM"),        # Oct 6 is a Tuesday
        ev("Taco Tuesday", date="2026-10-06", time="5:00 PM"),             # right day
        ev("Monday–Friday Camp", date="2026-10-06"),                       # several weekdays: skip
        ev("Late Show", date="2026-10-06", time="3:00 AM"),
        ev("St. Mary's Parish Fall Festival", date="2026-10-06", venue="St. Mary's Church"),
        ev("Trivia Night", date="2026-10-06", time="7:00 PM", venue="Weber Brewing"),
        ev("Trivia Night!", date="2026-10-06", time="7:00 PM", venue="Weber Brewing"),
        ev("Trivia Night", date="2026-10-06", time="7:00 PM", venue="Aero Crafters"),  # other bar: fine
    ]
    got = kinds(sw.rule_findings(events))
    assert (0, "wrong_date") in got
    assert (3, "odd_time") in got
    assert (4, "religious") in got
    assert (6, "duplicate") in got
    assert not any(i in (1, 2, 5, 7) for i, _ in got)


def test_ai_findings_parse_and_name_the_duplicate():
    events = [ev("Bookish Society Book Club", venue="Vida Cafe", time="6:00 PM"),
              ev("Bookish Society Book Club", venue="Victoria Public Library", time="6:00PM")]
    answer = ('Here you go: [{"i": 1, "kind": "duplicate", "why": "same club, same time", "dup_of": 0},'
              ' {"i": 9, "kind": "other", "why": "bad index"}, {"i": 0, "kind": "made_up", "why": "x"}]')
    with patch.object(sw.ce, "_openai_chat", return_value=answer) as chat:
        out = sw.ai_findings(events, "sk-test")
    assert out == [(1, "duplicate", "same as “Bookish Society Book Club” at Vida Cafe (same club, same time)")]
    sent = chat.call_args[0][1][1]["content"]
    assert "0 | 2026-10-06 (tue) | 6:00 PM | Bookish Society Book Club | Vida Cafe" in sent


def test_ai_failure_falls_back_to_rules():
    with patch.object(sw.ce, "_openai_chat", side_effect=RuntimeError("timeout")):
        assert sw.ai_findings([ev("X")], "sk-test") is None
    head, lines = sw.report([ev("X")], [], ai_ran=False, days=14)
    assert "nothing looks off" in head and "AI check didn't run" in head and lines == []


def test_report_lists_each_problem_once_with_links():
    events = [ev("Monday Bingo", date="2026-10-06", venue="Palace Bingo", page="/events/2026-10-06-monday-bingo")]
    found = sw.combine([(0, "wrong_date", "name says Monday")], [(0, "wrong_date", "dup from AI"), (0, "other", "x")])
    assert kinds(found) == [(0, "other"), (0, "wrong_date")]
    head, lines = sw.report(events, found, ai_ran=True, days=14)
    assert head.startswith("🔎 Event check: 1 to look at (1 events in the next 14 days)")
    assert lines[0] == "*To look at:*"
    assert "<https://www.thevic361.com/events/2026-10-06-monday-bingo|Monday Bingo>" in lines[2]
    assert "Tue Oct 6" in lines[2] and "*wrong day?*" in lines[2]


def test_window_is_today_through_n_days():
    import datetime
    events = [ev("Past", date="2026-10-03"), ev("Today", date="2026-10-04"),
              ev("Last day", date="2026-10-17"), ev("Too far", date="2026-10-18")]
    got = sw.upcoming(events, datetime.date(2026, 10, 4), 14)
    assert [e["name"] for e in got] == ["Today", "Last day"]


def test_a_lone_cut_off_name_is_flagged_not_hidden():
    events = [ev("Scenic Root — Plant a", venue="Moonshine Drinkery", page="/events/a")]
    found = sw.rule_findings(events)
    assert [(i, k) for i, k, _ in found] == [(0, "cut_off")]
    assert "cut off" in found[0][2]
    assert sw.to_hide(events, found)[0] == []   # could be the only listing: reported only


def test_cut_off_names_beside_the_whole_listing_are_hidden():
    # Live 2026-10-08 at Moonshine Drinkery: two cut-off post names next to
    # the AllEvents listing of the same night.
    events = [ev("Once Upon A Plant: Maas Edition", date="2026-10-08", time="06:30 PM", venue="Moonshine Drinkery",
                 page="/events/2026-10-08-once-upon-a-plant-maas-edition"),
              ev("Scenic Root — Once Upon...", date="2026-10-08", venue="Moonshine Drinkery",
                 page="/events/2026-10-08-scenic-root-once-upon"),
              ev("Scenic Root — Plant a", date="2026-10-08", venue="Moonshine Drinkery",
                 page="/events/2026-10-08-scenic-root-plant-a"),
              ev("Paint and Sip with the", date="2026-10-08", venue="Aero Crafters", page="/events/z")]
    picks, _ = sw.to_hide(events, sw.rule_findings(events))
    assert [(i, k) for i, k, _ in picks] == [(1, "cut_off"), (2, "cut_off")]
    assert "Once Upon A Plant: Maas Edition" in picks[0][2]


def test_library_copy_of_a_city_calendar_program_is_hidden():
    # Live 2026-10-06/07: the same program at the library (its default
    # venue) and at its real place from the city calendar.
    lib = ev("Bookish Society Book Club", time="6:00PM – 7:00PM", venue="Victoria Public Library",
             url="https://victoriapl.librarycalendar.com/event/bookish-society-book-club-8996", page="/events/a",
             description="Monthly book club.")
    city = ev("Bookish Society Book Club", time="6:00 PM – 7:00 PM", venue="Vida Cafe",
              url="https://www.victoriatx.gov/Calendar.aspx?EID=3969", page="/events/b")
    for events in ([lib, city], [city, lib]):
        rules = sw.rule_findings(events)
        assert (1, "duplicate") in kinds(rules)
        picks, _ = sw.to_hide(events, rules)
        assert [events[i]["page"] for i, _, _ in picks] == ["/events/a"]
        assert "Vida Cafe" in picks[0][2]
    # Different hours, or no city calendar link: not certain, nothing hidden.
    other = dict(city, time="7:00 PM – 8:00 PM")
    assert sw.to_hide([lib, other], sw.rule_findings([lib, other]))[0] == []
    other = dict(city, url="https://allevents.in/victoria/bookish/1")
    assert sw.to_hide([lib, other], sw.rule_findings([lib, other]))[0] == []


def test_night_events_in_the_morning_are_reported():
    events = [ev("Comedy Night in Victoria w/Crux Crawford", date="2026-10-07", time="10:00 AM",
                 venue="Moonshine Drinkery", page="/events/a"),
              ev("Farmers Market", time="8:00 AM", venue="Market Square", page="/events/b")]
    rules = sw.rule_findings(events)
    assert kinds(rules) == [(0, "odd_time")]
    assert sw.to_hide(events, rules)[0] == []


def test_description_only_religious_words_are_reported_not_hidden():
    events = [ev("Community Night", description="An evening of praise and worship.", page="/events/a"),
              ev("Live Music", description="Come hear Hope Revival play country hits", page="/events/b")]
    rules = sw.rule_findings(events)
    assert kinds(rules) == [(0, "other")]
    assert sw.to_hide(events, rules)[0] == []


class FakeResp:
    def __init__(self, data):
        self.data = data

    def raise_for_status(self):
        pass

    def json(self):
        return self.data


def test_only_certain_rule_findings_get_hidden():
    events = [ev("Monday Night Bingo", page="/events/a"), ev("St. Mary's Parish Fall Festival", page="/events/b"),
              ev("Late Show", time="3:00 AM", page="/events/c")]
    picks, _ = sw.to_hide(events, sw.rule_findings(events))
    assert [(i, k) for i, k, _ in picks] == [(1, "religious")]   # wrong day and odd time stay flags


def test_duplicates_hidden_only_when_exact_unfeatured_and_the_poorer_copy_goes():
    rich = dict(url="https://x.example", description="All the details.")
    # Exact twins: the copy with less detail is hidden, wherever it sits.
    events = [ev("Trivia Night", venue="Weber Brewing", time="7:00 PM", page="/events/a"),
              ev("Trivia Night!", venue="Weber Brewing", time="7 PM", page="/events/b", **rich)]
    picks, resolved = sw.to_hide(events, sw.rule_findings(events))
    assert [(i, k) for i, k, _ in picks] == [(0, "duplicate")]
    assert resolved == {1: 0}
    # Fuzzy matches (name contains the other) are reported, not hidden.
    events = [ev("Fall Festival", venue="DeLeon Plaza", time="10:00 AM", page="/events/a"),
              ev("Victoria Fall Festival", venue="DeLeon Plaza", time="10:00 AM", page="/events/b")]
    rules = sw.rule_findings(events)
    assert any(k == "duplicate" for _, k, _ in rules)
    assert sw.to_hide(events, rules)[0] == []
    # A featured (paid) listing is never auto-hidden, nor is its twin.
    events = [ev("Trivia Night", venue="Weber Brewing", time="7:00 PM", page="/events/a", featured=True),
              ev("Trivia Night", venue="Weber Brewing", time="7:00 PM", page="/events/b")]
    assert sw.to_hide(events, sw.rule_findings(events))[0] == []


class FakeResp:
    def __init__(self, data, status=200):
        self.data, self.status_code = data, status
        self.ok = status < 400
        self.headers = {"content-type": "application/json"}

    def json(self):
        return self.data


def test_hide_posts_pages_and_reads_back_what_happened():
    events = [ev("A", page="/events/a"), ev("B", page="/events/b"), ev("C", page="/events/c")]
    picks = [(0, "religious", "church event"), (1, "duplicate", "same as X"), (2, "not_an_event", "job post")]
    answer = {"ok": True, "hidden": [{"page": "/events/a"}],
              "skipped": [{"page": "/events/b", "why": "restored-by-admin"}, {"page": "/events/c", "why": "not-live"}]}
    with patch.object(sw.requests, "post", return_value=FakeResp(answer)) as post:
        hidden, restored, problem = sw.hide(events, picks, "s3cret")
    assert hidden == {0} and restored == {1} and problem is None
    kw = post.call_args.kwargs
    assert kw["headers"]["X-Cron-Secret"] == "s3cret"
    assert kw["json"]["hide"][0] == {"page": "/events/a", "reason": "religious / church event: church event"}


def test_hide_failures_are_reported_not_swallowed():
    events = [ev("A", page="/events/a")]
    picks = [(0, "religious", "church event")]
    with patch.object(sw.requests, "post", return_value=FakeResp({"ok": False, "error": "unauthorized"}, 401)):
        assert "rejected the secret" in sw.hide(events, picks, "wrong")[2]
    with patch.object(sw.requests, "post", return_value=FakeResp({"ok": False, "error": "too-many", "message": "Refusing to hide 11"}, 400)):
        assert "Refusing to hide 11" in sw.hide(events, picks, "s3cret")[2]
    with patch.object(sw.requests, "post", side_effect=OSError("timeout")):
        assert "timeout" in sw.hide(events, picks, "s3cret")[2]
    with patch.object(sw.requests, "post") as post:
        assert sw.hide(events, picks, "") == (set(), set(), None)   # report-only setup
    post.assert_not_called()
    head, _ = sw.report(events, [(0, "religious", "church event")], ai_ran=True, days=14,
                        problem="auto-hide failed: HTTP 500")
    assert "⚠️ auto-hide failed: HTTP 500" in head


def test_report_splits_hidden_from_flags():
    events = [ev("Church Fish Fry", venue="St. Mary's", page="/events/a"), ev("Monday Bingo", page="/events/b")]
    found = [(0, "religious", "church event"), (1, "wrong_date", "name says Monday")]
    head, lines = sw.report(events, found, ai_ran=True, days=14, hidden={0})
    assert head.startswith("🔎 Event check: hid 1, 1 to look at")
    assert lines[0].startswith("*Hidden automatically*")
    assert "Church Fish Fry" in lines[1]
    assert lines[2] == "*To look at:*" and "Monday Bingo" in lines[3]


def test_ai_reasons_name_events_instead_of_index_numbers():
    events = [ev("Victoria Texas Historic Mystery"), ev("Spooky Season: Victoria Historic Ghost Mystery")]
    answer = '[{"i": 0, "kind": "other", "why": "Same ghost tour as index 1, same plaza; not index 7"}]'
    with patch.object(sw.ce, "_openai_chat", return_value=answer) as chat:
        out = sw.ai_findings(events, "sk-test")
    assert out == [(0, "other", "Same ghost tour as “Spooky Season: Victoria Historic Ghost Mystery”, same plaza; not another listing")]
    assert "never by their index number" in chat.call_args[0][1][0]["content"]



def test_ai_reasons_name_hash_and_event_references_but_leave_names_alone():
    events = [ev("Trivia"), ev("Karaoke"), ev("Line Dancing")]
    assert sw._named("same as #1", events) == "same as “Karaoke”"
    assert sw._named("duplicate of event 2 (see #0)", events) == "duplicate of “Line Dancing” (see “Trivia”)"
    assert sw._named("same as line 1", events) == "same as “Karaoke”"
    assert sw._named("Line 2 Dance Night at the hall", events) == "Line 2 Dance Night at the hall"
    assert sw._named("#1 Fan Day is not an event", events) == "#1 Fan Day is not an event"
