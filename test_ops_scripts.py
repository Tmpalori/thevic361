"""Tests for the uptime feed check (scripts/feed_age.py) and the static
preview banner (scripts/preview_banner.py)."""
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
import feed_age  # noqa: E402
import preview_banner  # noqa: E402

NOW = dt.datetime(2026, 10, 7, 15, 0, tzinfo=dt.timezone.utc)  # Wed 10 AM Central


def write(tmp_path, data):
    p = tmp_path / "events.json"
    p.write_text(json.dumps(data))
    return str(p)


def test_age_uses_the_collect_not_the_last_edit(tmp_path):
    # A submission approved today moved last_updated; the collector stalled.
    p = write(tmp_path, {"last_updated": "2026-10-07T14:00:00Z", "collected_at": "2026-09-27T20:27:00-05:00", "events": []})
    assert feed_age.age_days(p, NOW) == 9
    # Feeds from before collected_at existed fall back to last_updated.
    p = write(tmp_path, {"last_updated": "2026-10-04T14:00:00Z", "events": []})
    assert feed_age.age_days(p, NOW) == 3
    assert feed_age.age_days(str(tmp_path / "missing.json"), NOW) == 99


def test_upcoming_counts_events_from_today_in_victoria(tmp_path):
    events = [{"date": "2026-10-06"}, {"date": "2026-10-07"}, {"date": "2026-10-11"}, "junk"]
    p = write(tmp_path, {"events": events})
    assert feed_age.upcoming(p, NOW) == 2
    # 11 PM Wednesday Central is already Thursday in UTC; still Wednesday here.
    late = dt.datetime(2026, 10, 8, 4, 0, tzinfo=dt.timezone.utc)
    assert feed_age.upcoming(p, late) == 2
    # Only last May's bundled list: nothing upcoming.
    assert feed_age.upcoming(write(tmp_path, {"events": [{"date": "2026-05-17"}]}), NOW) == 0
    assert feed_age.upcoming(str(tmp_path / "missing.json"), NOW) == 0


def test_preview_banner_marks_every_page_once(tmp_path):
    (tmp_path / "index.html").write_text("<html><body class='x'><h1>Hi</h1></body></html>")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "a.html").write_text("<BODY><p>a</p></BODY>")
    (tmp_path / "app.js").write_text("// <body>")
    assert preview_banner.mark(tmp_path, "PR #5 preview") == 2
    html = (tmp_path / "index.html").read_text()
    assert html.startswith("<html><body class='x'><div") and "PR #5 preview" in html
    assert "old bundled list" in (tmp_path / "sub" / "a.html").read_text()
    assert (tmp_path / "app.js").read_text() == "// <body>"
    assert preview_banner.mark(tmp_path) == 0  # already marked
