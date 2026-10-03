"""Social kit captions and event selection (scripts/social_kit.py).

Rendering needs Pillow and runs in the workflow; these tests cover the pure
helpers that decide what gets posted.
"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
import social_kit as sk

EVENTS = [
    {"date": "2026-10-09", "name": "Early Show", "time": "6:00 PM", "venue": "A"},
    {"date": "2026-10-09", "name": "Paid Show", "time": "9:00 PM", "venue": "B", "featured": True},
    {"date": "2026-10-10", "name": "Market", "time": "8am - 1pm", "venue": "Square", "free": True},
    {"date": "2026-10-05", "name": "Monday Trivia", "time": "7 PM", "venue": "Bar"},
    {"date": "2026-10-20", "name": "Next Week", "time": "7 PM"},
]


def test_bounds():
    assert sk.week_bounds(date(2026, 10, 7)) == (date(2026, 10, 5), date(2026, 10, 11))
    assert sk.weekend_bounds(date(2026, 10, 7)) == (date(2026, 10, 9), date(2026, 10, 11))
    assert sk.weekend_bounds(date(2026, 10, 10)) == (date(2026, 10, 10), date(2026, 10, 11))


def test_select_groups_by_day_featured_first():
    g = sk.select_events(EVENTS, date(2026, 10, 9), date(2026, 10, 11))
    assert list(g) == [date(2026, 10, 9), date(2026, 10, 10)]
    assert [e["name"] for e in g[date(2026, 10, 9)]] == ["Paid Show", "Early Show"]


def test_captions():
    start, end = date(2026, 10, 9), date(2026, 10, 11)
    caps = sk.captions(sk.select_events(EVENTS, start, end), start, end, "weekend")
    fb = caps["facebook"]
    assert fb.startswith("This weekend in Victoria, TX (Oct 9–11): 3 events")
    assert "• 9 PM Paid Show @ B" in fb
    assert "• 8 AM Market @ Square (free)" in fb
    assert "https://www.thevic361.com/this-weekend" in fb
    assert "link in bio" in caps["instagram"]


def test_empty_week_caption():
    start, end = date(2026, 12, 1), date(2026, 12, 7)
    caps = sk.captions({}, start, end, "week")
    assert "Nothing listed yet" in caps["facebook"]


def test_short_time():
    assert sk._short_time("7:00 PM – 10:00 PM") == "7 PM"
    assert sk._short_time("10:30am") == "10:30 AM"
    assert sk._short_time("") == ""
