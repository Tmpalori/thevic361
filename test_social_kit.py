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
    assert sk.week_bounds(date(2026, 10, 5)) == (date(2026, 10, 5), date(2026, 10, 11))  # Monday run
    assert sk.week_bounds(date(2026, 10, 8)) == (date(2026, 10, 8), date(2026, 10, 11))  # Thursday run
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


def test_today_caption_and_venue_tags():
    d = date(2026, 10, 9)
    handles = {"aero crafters": "aerocrafters", "the nave museum": "navemuseum"}
    groups = sk.select_events([
        {"date": "2026-10-09", "name": "Open Mic", "time": "7 PM", "venue": "Aero Crafters"},
        {"date": "2026-10-09", "name": "Art Night", "time": "6 PM", "venue": "Nave Museum"},
        {"date": "2026-10-09", "name": "Fish Fry", "time": "5 PM", "venue": "St. Mary"},
    ], d, d)
    caps = sk.captions(groups, d, d, "today", handles)
    assert caps["facebook"].startswith("Today in Victoria, TX (Oct 9): 3 events")
    assert "FRIDAY" not in caps["facebook"]
    assert "https://www.thevic361.com/today" in caps["facebook"]
    assert "@navemuseum @aerocrafters" in caps["instagram"]
    assert "@" not in caps["facebook"].replace("• ", "").split("Full list")[1]


def test_outreach_lists_each_venue_once(tmp_path):
    import json as _json
    vf = tmp_path / "venues.json"
    vf.write_text(_json.dumps([{"name": "Aero Crafters", "instagram_url": "https://www.instagram.com/aerocrafters/"}]))
    groups = {date(2026, 10, 9): [
        {"name": "Open Mic", "venue": "Aero Crafters", "page": "/events/2026-10-09-open-mic"},
        {"name": "Late Show", "venue": "Aero Crafters", "page": "/events/2026-10-09-late-show"},
        {"name": "Fish Fry", "venue": "St. Mary"}]}
    lines = sk.outreach(groups, venues_path=str(vf))
    assert lines == [
        "• Aero Crafters: Open Mic https://www.thevic361.com/events/2026-10-09-open-mic (https://www.instagram.com/aerocrafters/)",
        "• St. Mary: Fish Fry https://www.thevic361.com/",
    ]


def test_kinds_rebuild_keeps_other_kits(tmp_path):
    import json as _json
    import shutil as _shutil
    import pytest
    pytest.importorskip("PIL")
    ev = tmp_path / "events.json"
    ev.write_text(_json.dumps({"events": [
        {"date": "2026-10-09", "name": "Show", "time": "8 PM", "venue": "Aero Crafters"}]}))
    out = tmp_path / "out"
    sk.main(["--events-file", str(ev), "--today", "2026-10-08", "--out", str(out)])
    m = _json.loads((out / "kit.json").read_text())
    assert set(m["kits"]) == {"week", "weekend", "today"}
    assert (out / "outreach.txt").read_text().startswith("• Aero Crafters: Show")
    if _shutil.which("ffmpeg"):
        assert m["kits"]["weekend"]["reel"] == "weekend.mp4" and (out / "weekend.mp4").exists()
    sk.main(["--events-file", str(ev), "--today", "2026-10-09", "--out", str(out), "--kinds", "today"])
    m2 = _json.loads((out / "kit.json").read_text())
    assert m2["generated_for"] == "2026-10-09"
    assert m2["kits"]["week"] == m["kits"]["week"] and (out / "week-1.png").exists()
    assert m2["kits"]["today"]["events"] == 1
