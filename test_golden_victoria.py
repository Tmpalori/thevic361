"""Golden snapshots of Victoria, Python side (MULTI_CITY_PLAN.md, Phase 0.3).

Social-kit captions, the Slack message the workflows send, the event-check
report, the collector's area filter and its constants, and the AI prompts
are rendered from tests/golden/fixture.json at fixed dates and compared with
tests/golden/__golden__/victoria/python/. The multi-city refactor must leave
them untouched. When a change is intended, regenerate on purpose:

    GOLDEN_UPDATE=1 pytest -q test_golden_victoria.py

and review the snapshot diff in the PR. (Same rule as tests/golden/victoria.test.js.)
"""
import json
import os
import sys
from datetime import date
from unittest.mock import patch

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "scripts"))
import collect_events as ce  # noqa: E402
import review_submissions as rs  # noqa: E402
import slack_notify  # noqa: E402
import social_kit as sk  # noqa: E402
import sweep_events as sw  # noqa: E402

GOLDEN = os.path.join(HERE, "tests", "golden", "__golden__", "victoria", "python")
with open(os.path.join(HERE, "tests", "golden", "fixture.json")) as f:
    FIXTURE = json.load(f)
EVENTS = FIXTURE["events"]
SPONSOR = {**FIXTURE["sponsor"], "week": "2026-10-05"}

# Settings that would change the output; the snapshots are of Victoria with
# nothing extra set.
ENV_KEYS = ["SITE_URL", "TOWN", "TOWN_TAG", "SLACK_TOWN_TAG", "OPENAI_MODEL", "GEMINI_MODEL"]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for k in ENV_KEYS:
        monkeypatch.delenv(k, raising=False)


def check(name, text):
    """Compare with the stored snapshot (or write it with GOLDEN_UPDATE=1)."""
    if not isinstance(text, str):
        text = json.dumps(text, indent=2, ensure_ascii=False, sort_keys=True, default=str) + "\n"
    path = os.path.join(GOLDEN, name)
    if os.environ.get("GOLDEN_UPDATE") == "1" or not os.path.exists(path):
        if os.environ.get("CI") and not os.path.exists(path):
            pytest.fail(f"missing golden snapshot {name}; run GOLDEN_UPDATE=1 pytest locally and commit it")
        os.makedirs(GOLDEN, exist_ok=True)
        with open(path, "w") as f:
            f.write(text)
        return
    with open(path) as f:
        want = f.read()
    assert text == want, f"Victoria's output changed: {name} (see the module docstring)"


# ─── Social kit ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("kind,today", [("week", date(2026, 10, 5)), ("weekend", date(2026, 10, 8)), ("today", date(2026, 10, 9))])
def test_social_kit(kind, today):
    start, end = {"week": sk.week_bounds, "weekend": sk.weekend_bounds, "today": sk.today_bounds}[kind](today)
    groups = sk.select_events(EVENTS, start, end)
    picked = {str(d): [e["name"] for e in evs] for d, evs in sorted(groups.items(), key=lambda kv: str(kv[0]))}
    caps = sk.captions(groups, start, end, kind, {}, SPONSOR)
    check(f"social-{kind}.txt", f"bounds: {start} .. {end}\npicked: {json.dumps(picked, default=str, sort_keys=True)}\n\n"
          f"===== Facebook =====\n{caps['facebook']}\n===== Instagram =====\n{caps['instagram']}")


def test_social_kit_constants():
    check("social-constants.json", {"SITE": sk.SITE, "HASHTAGS": sk.HASHTAGS, "TITLES": sk.TITLES})


# ─── Slack (workflows) and the event check ───────────────────────────────

def test_slack_notify_payload(monkeypatch):
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T/B/x")
    sent = []

    class _Resp:
        def read(self):
            return b"ok"

    def fake_urlopen(req, timeout=None):
        sent.append({"url": req.full_url, "body": json.loads(req.data.decode())})
        return _Resp()

    with patch.object(slack_notify.urllib.request, "urlopen", fake_urlopen):
        assert slack_notify.main(["✅ Weekly collect done: 120 candidates", "--link", "https://github.com/x/actions/runs/1"]) == 0
    check("slack-notify.json", sent)


def test_event_check_report():
    events = [{"date": "2026-10-09", "name": "Friday Live Music", "venue": "Aero Crafters", "time": "8:00 PM", "page": "/events/2026-10-09-friday-live-music"},
              {"date": "2026-10-10", "name": "Sunday <Brunch>", "venue": "Cafe", "time": "3:00 AM", "page": "/events/2026-10-10-sunday-brunch"}]
    findings = [(0, "duplicate", "listed twice"), (1, "odd_time", "starts at 3 AM")]
    head, lines = sw.report(events, findings, True, 14, hidden={0})
    check("event-check-report.txt", head + "\n" + "\n".join(lines) + "\n\n" + sw.report(events, [], False, 14)[0] + "\n")


# ─── Collector: area filter and constants ────────────────────────────────

def test_area_filter():
    cases = [
        {"name": "Downtown Market", "venue": "De Leon Plaza", "address": "101 N Main St, Victoria, TX 77901"},
        {"name": "Turkeyfest", "venue": "Downtown Cuero", "address": "Cuero, TX 77954"},
        {"name": "Concert", "venue": "Toyota Center", "address": "1510 Polk St, Houston, TX 77002"},
        {"name": "Fish Fry", "venue": "Hall", "address": "Port Lavaca, TX"},
        {"name": "Bryan show", "venue": "Theater", "address": "College Station, TX 77840"},
        {"name": "No place", "venue": "", "address": ""},
    ]
    check("area-filter.json", [{"name": c["name"], "reason": ce.out_of_area_reason(c)} for c in cases])


def test_collector_constants():
    check("collector-constants.json", {
        "VICTORIA_AREA_ZIPS": sorted(ce.VICTORIA_AREA_ZIPS),
        "_OTHER_TOWNS": sorted(ce._OTHER_TOWNS) if not isinstance(ce._OTHER_TOWNS, dict) else ce._OTHER_TOWNS,
        "SOURCE_RANK": ce.SOURCE_RANK,
    })


# ─── AI prompts ──────────────────────────────────────────────────────────

def test_ai_prompts():
    batch = [{"name": "Paint & Sip", "venue": "Victoria Fine Arts Association", "date": "2026-10-08", "time": "6:30 PM", "description": ""}]
    check("prompts.txt", "\n\n===== ".join([
        "collector AI review =====\n" + ce._AI_REVIEW_SYSTEM_PROMPT,
        "collector Gemini search =====\n" + ce._gemini_prompt("live music and concerts", date(2026, 10, 5), date(2026, 10, 18)),
        "collector New & Notable =====\n" + ce._notable_prompt(date(2026, 10, 7)),
        "collector enrichment =====\n" + (ce._enrich_prompt(batch) if not isinstance(ce._enrich_prompt(batch), (list, dict)) else json.dumps(ce._enrich_prompt(batch), indent=2)),
        "submission review =====\n" + rs.PROMPT,
        "event check =====\n" + sw.PROMPT,
    ]) + "\n")


# ─── Collector: what it asks sources for, and its place checks ───────────

def test_collector_town_values():
    check("collector-town.json", {
        "ALLEVENTS_PAGES": ce.ALLEVENTS_PAGES, "GOOGLE_SHEET_ID": ce.GOOGLE_SHEET_ID, "GEMINI_CATEGORIES": ce.GEMINI_CATEGORIES,
        "EVENTBRITE_SEARCH": ce.EVENTBRITE_SEARCH, "FB_SEARCH_QUERIES": ce.FB_SEARCH_QUERIES,
        "_CITY_TOKENS": sorted(ce._CITY_TOKENS), "_VENUE_STOP": sorted(ce._VENUE_STOP), "_PAGE_STOP": sorted(ce._PAGE_STOP),
        "_ADDRESSY": ce._ADDRESSY.pattern, "_PLACEHOLDER_PLACE_RE": ce._PLACEHOLDER_PLACE_RE.pattern,
    })


def test_collector_place_checks():
    fb = [({}, "Aero Crafters", "1502 E Airline Rd, Victoria, TX 77901", "Victoria"),
          ({}, "Pub", "1770 Fort St", "Victoria"),
          ({"state": "BC"}, "Pub", "Victoria, TX", "Victoria"),
          ({}, "Hall", "Cuero, TX 77954", "Cuero"),
          ({"countryCode": "CA"}, "Hall", "Victoria Texas", "")]
    placeholders = ["Victoria", "City of Victoria, TX", "Victoria County", "TBA", "Aero Crafters", "Victoria, Texas, USA"]
    streets = ["101 N. Main St, Victoria, TX 77901", "101 North Main Street", "2 Bay City Rd, Texas"]
    gap = [{"date": "2026-10-09", "name": "Show", "venue": "Hall"}, {"date": "2026-10-09", "name": "Show", "venue": "", "address": ""}]
    check("collector-place-checks.json", {
        "fb_location": [ce._fb_location_is_victoria_tx(*c) for c in fb],
        "placeholder": {p: bool(ce._PLACEHOLDER_PLACE_RE.match(p)) for p in placeholders},
        "addressy": {p: bool(ce._ADDRESSY.search(p)) for p in placeholders + streets},
        "street_key": {s: ce._street_key(s) for s in streets},
        "fill_gaps": [e.get("description") for e in ce.fill_gaps([dict(e) for e in gap], templates=True)],
    })


def test_collector_post_prompt():
    check("post-prompt.txt", ce._post_events_prompt(
        "Aero Crafters", "[1] (posted Fri 2026-10-09 8:15 PM) Trivia tonight at 7!", "2026-10-09", "2026-10-23") + "\n")
