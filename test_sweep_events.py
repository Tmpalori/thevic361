"""Tests for scripts/sweep_events.py, the post-publish event check."""
import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
import sweep_events as sw  # noqa: E402


def ev(name, date="2026-10-06", time="", venue="", description="", page=None):
    return {"name": name, "date": date, "time": time, "venue": venue, "description": description,
            "address": "", "page": page or f"/events/{date}-x"}


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
    picks = sw.to_hide(events, sw.rule_findings(events))
    assert [(i, k) for i, k, _ in picks] == [(1, "religious")]   # wrong day and odd time stay flags


def test_hide_posts_pages_and_reads_back_what_happened():
    events = [ev("A", page="/events/a"), ev("B", page="/events/b"), ev("C", page="/events/c")]
    picks = [(0, "religious", "church event"), (1, "duplicate", "same as X"), (2, "not_an_event", "job post")]
    answer = {"ok": True, "hidden": [{"page": "/events/a"}],
              "skipped": [{"page": "/events/b", "why": "restored-by-admin"}, {"page": "/events/c", "why": "not-live"}]}
    with patch.object(sw.requests, "post", return_value=FakeResp(answer)) as post:
        hidden, restored = sw.hide(events, picks, "s3cret")
    assert hidden == {0} and restored == {1}
    kw = post.call_args.kwargs
    assert kw["headers"]["X-Cron-Secret"] == "s3cret"
    assert kw["json"]["hide"][0] == {"page": "/events/a", "reason": "religious / church event: church event"}


def test_hide_does_nothing_without_a_secret_or_with_too_many():
    events = [ev(str(n), page=f"/events/{n}") for n in range(12)]
    picks = [(n, "not_an_event", "x") for n in range(12)]
    with patch.object(sw.requests, "post") as post:
        assert sw.hide(events, picks[:2], "") == (set(), set())
        assert sw.hide(events, picks, "s3cret") == (set(), set())
    post.assert_not_called()


def test_report_splits_hidden_from_flags():
    events = [ev("Church Fish Fry", venue="St. Mary's", page="/events/a"), ev("Monday Bingo", page="/events/b")]
    found = [(0, "religious", "church event"), (1, "wrong_date", "name says Monday")]
    head, lines = sw.report(events, found, ai_ran=True, days=14, hidden={0})
    assert head.startswith("🔎 Event check: hid 1, 1 to look at")
    assert lines[0].startswith("*Hidden automatically*")
    assert "Church Fish Fry" in lines[1]
    assert lines[2] == "*To look at:*" and "Monday Bingo" in lines[3]

