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
    assert "⭐ 9 PM Paid Show @ B" in fb   # featured (paid) events are starred
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
    assert "@" not in caps["facebook"].split("See all")[1]


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


def test_branded_slides_markup():
    import social_slides as ss
    from datetime import date as _d
    ev = lambda name, day, **kw: {"name": name, "date": day, "time": "7:00 PM", "venue": "Weber <Brewing>", "icons": ["music", "nope"], **kw}
    groups = {_d(2026, 10, 9): [ev(f"Show <{i}>", "2026-10-09") for i in range(12)],
              _d(2026, 10, 10): [ev("Pumpkin Patch", "2026-10-10", featured=True, free=True)]}
    names, doc = ss.slides_html(groups, _d(2026, 10, 9), _d(2026, 10, 11), "weekend")
    assert names == ["weekend-1.png", "weekend-2.png", "weekend-3.png"]
    assert "Show &lt;0&gt;" in doc and "<0>" not in doc               # escaped
    assert '#i-music' in doc and '#i-nope' not in doc                  # only known icons
    assert "#FF7A3D" in doc and "#B9A6FF" in doc                       # Friday sunset, Saturday lilac (site colors)
    assert "+ 10 more" in doc                                          # 12 Friday events: 2 shown
    assert "thevic361.com/subscribe" in doc and "13 things to do" in doc


def test_branded_render_falls_back_without_chrome(tmp_path, monkeypatch):
    import social_slides as ss
    from datetime import date as _d
    monkeypatch.setattr(ss, "find_chrome", lambda: None)
    assert ss.render({}, _d(2026, 10, 9), _d(2026, 10, 9), "today", str(tmp_path)) is None


def test_caption_points_to_the_signup_page():
    from datetime import date as _d
    caps = sk.captions({_d(2026, 10, 9): [{"name": "Live Music", "date": "2026-10-09", "time": "7 PM"}]},
                       _d(2026, 10, 9), _d(2026, 10, 9), "today")
    assert "Don't miss a thing: get every event free in your inbox each Monday 👉 https://www.thevic361.com/subscribe" in caps["facebook"]
    assert "subscribe at the link in bio" in caps["instagram"]


def test_outreach_slack_is_short_and_actionable(tmp_path):
    import json as _json
    vf = tmp_path / "venues.json"
    vf.write_text(_json.dumps([{"name": f"Bar {i}", "instagram_url": f"https://www.instagram.com/bar{i}/"} for i in range(12)]))
    groups = {date(2026, 10, 9): [{"name": f"Show | {i}", "venue": f"Bar {i}", "page": f"/events/2026-10-09-show-{i}"}
                                  for i in range(12)] + [{"name": "Fish Fry", "venue": "No Socials Hall"}]}
    msg = sk.outreach_slack(groups, venues_path=str(vf))
    lines = msg.splitlines()
    assert lines[0].startswith("📣 *12 venues on this week's list you can tag.*")
    assert len(lines) == 1 + 8 + 1                       # headline, 8 venues, "and 4 more"
    assert lines[1] == "• <https://www.instagram.com/bar0/|Bar 0> → <https://www.thevic361.com/events/2026-10-09-show-0|Show / 0>"
    assert "No Socials Hall" not in msg                  # nothing to tag, so not listed
    assert lines[-1] == "…and 4 more: <https://www.thevic361.com/social/latest/outreach.txt|full list>"
    assert sk.outreach_slack({date(2026, 10, 9): [{"name": "x", "venue": "No Socials Hall"}]}, venues_path=str(vf)) == ""


def test_captions_tease_two_per_day_sponsored_first():
    d = date(2026, 10, 9)
    evs = [{"date": "2026-10-09", "name": f"Show {i}", "time": f"{i + 1} PM", "venue": "Bar"} for i in range(6)]
    evs.append({"date": "2026-10-09", "name": "Sponsored Gala", "time": "9 PM", "venue": "Hall", "featured": True})
    caps = sk.captions(sk.select_events(evs, d, d), d, d, "today")
    fb = caps["facebook"]
    assert "⭐ 9 PM Sponsored Gala @ Hall" in fb          # sponsored first, marked
    assert "• 1 PM Show 0 @ Bar" in fb and "Show 1" not in fb
    assert "+ 5 more" in fb
    assert "👉 See all 7: https://www.thevic361.com/today" in fb
    assert "👉 See all 7: link in bio" in caps["instagram"]


def test_posts_have_at_most_three_slides():
    import social_slides as ss
    groups = {date(2026, 10, d): [{"name": f"E{d}{i}", "date": f"2026-10-{d:02d}", "time": "7 PM"} for i in range(9)]
              for d in range(5, 12)}
    names, doc = ss.slides_html(groups, date(2026, 10, 5), date(2026, 10, 11), "week")
    assert names == ["week-1.png", "week-2.png", "week-3.png"]
    assert doc.count("+ 7 more") == 7                      # every day: 2 shown, the rest teased
    assert "See all 63 events" in doc and "Subscribe free →" in doc and "thevic361.com/subscribe" in doc



def test_captions_with_one_event_use_the_singular():
    d = date(2026, 10, 9)
    caps = sk.captions({d: [{"name": "Live Music", "date": "2026-10-09", "time": "7 PM", "venue": "Bar"}]}, d, d, "today")
    assert caps["facebook"].startswith("Today in Victoria, TX (Oct 9): 1 event\n")
    assert "👉 Details: https://www.thevic361.com/today" in caps["facebook"]
    assert "👉 Details: link in bio" in caps["instagram"]
    assert "1 events" not in caps["facebook"] + caps["instagram"] and "See all 1" not in caps["facebook"]
