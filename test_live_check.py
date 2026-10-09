"""scripts/live_check.py: snapshots a (fake) site and diffs it with the last run."""
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts"))
import live_check as lc  # noqa: E402

SITE = "https://www.thevic361.com"


def fake_site(overrides=None, missing=()):
    pages = {
        "/sitemap.xml": "<urlset><url><loc>https://www.thevic361.com/</loc><lastmod>2026-10-09</lastmod></url>"
                        "<url><loc>https://www.thevic361.com/this-weekend</loc></url>"
                        "<url><loc>https://www.thevic361.com/events/2026-10-09-a</loc></url></urlset>",
        "/events.json": json.dumps({"last_updated": "2026-10-09T12:00:00Z", "events": [{"page": "/events/2026-10-09-a"}, {"name": "no page"}]}),
        "/venues": '<a href="/venues/aero-crafters">Aero</a>',
        "/": '<link href="/style.css?v=abc1234">Home',
        "/events/2026-10-09-a.ics": "BEGIN:VCALENDAR\r\nDTSTAMP:20261009T120000Z\r\nEND:VCALENDAR\r\n",
        **(overrides or {}),
    }

    def fetch(url):
        path = url[len(SITE):]
        if path in missing:
            return 0, "", "", "no answer"
        if path == "/live-check-no-such-page":
            return 404, "text/html", "", "Not found"
        return 200, "text/html", "", pages.get(path, f"page {path}")
    return fetch


def run(tmp_path, fetch, minute):
    return lc.main(["--dir", str(tmp_path)], fetch=fetch, now=dt.datetime(2026, 10, 9, 12, minute, tzinfo=dt.timezone.utc))


def test_discovers_hubs_events_and_a_venue():
    paths = lc.discover(SITE, fake_site())
    assert paths == ["/this-weekend", "/events/2026-10-09-a", "/events/2026-10-09-a.ics", "/venues/aero-crafters"]


def test_normalizes_hashes_and_timestamps():
    assert lc.normalize('a.css?v=0f3e9a1 "2026-10-09T12:00:00.123Z" <lastmod>2026-10-09</lastmod>\nDTSTAMP:20261009T210036Z') == \
        'a.css?v=HASH "TIMESTAMP" <lastmod>DATE</lastmod>\nDTSTAMP:TIMESTAMP'


def test_first_run_then_same_then_changed(tmp_path, capsys):
    assert run(tmp_path, fake_site(), 0) == 0
    assert "First run" in capsys.readouterr().out
    # A new asset hash and a new feed time aren't differences.
    assert run(tmp_path, fake_site({"/": '<link href="/style.css?v=fff9999">Home',
                                    "/events.json": json.dumps({"last_updated": "2026-10-09T13:00:00Z", "events": [{"page": "/events/2026-10-09-a"}, {"name": "no page"}]})}), 1) == 0
    assert "no differences" in capsys.readouterr().out
    assert run(tmp_path, fake_site({"/about": "page /about, now different"}), 2) == 1
    out = capsys.readouterr().out
    assert "~ changed: /about" in out and "+page /about, now different" in out
    assert len(os.listdir(tmp_path)) == 3


def test_a_page_that_does_not_answer_fails(tmp_path, capsys):
    assert run(tmp_path, fake_site(missing={"/privacy"}), 0) == 1
    assert "! no answer: /privacy" in capsys.readouterr().out
