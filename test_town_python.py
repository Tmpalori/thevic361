"""town.py and the scripts that read it (MULTI_CITY_PLAN.md 1.4): TOWN unset
is Victoria exactly (the Python goldens pin its output); another town's
social posts, AI prompts and alerts name it, never Victoria."""
import importlib
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "scripts"))
import town as town_mod  # noqa: E402

BAY = {"siteName": "The Bay 979", "siteNameHtml": "The Bay <span>979</span>", "domain": "thebay979.com",
       "city": "Bay City", "state": "TX", "stateName": "Texas", "timezone": "America/Los_Angeles", "pickName": "Bay’s Best"}
LEAK = ("Victoria", "Vic 361", "The Vic", "thevic361", "Vic's Pick", "Vic’s Pick", "#361")


def test_victoria_is_today():
    t = town_mod.town_config({})
    assert t == town_mod.VICTORIA
    assert t["hashtags"] == "#VictoriaTX #ThingsToDoVictoria #VictoriaTexas #361 #TheVic361"
    assert town_mod.site_url(t, {}) == "https://www.thevic361.com"
    assert town_mod.site_url(t, {"SITE_URL": "https://x.example/"}) == "https://x.example"


def test_another_town_from_file(tmp_path):
    (tmp_path / "bay").mkdir()
    (tmp_path / "bay" / "town.json").write_text(json.dumps(BAY))
    t = town_mod.town_config({"TOWN": "bay", "TOWNS_DIR": str(tmp_path)})
    assert t["id"] == "bay" and t["site_name"] == "The Bay 979" and t["site_url"] == "https://www.thebay979.com"
    assert t["city_state"] == "Bay City, TX" and t["city_state_long"] == "Bay City, Texas" and t["county"] == ""
    assert t["pick_name_plain"] == "Bay's Best" and t["short_name"] == "Bay 979"
    assert t["hashtags"] == "#BayCityTX #BayCityTexas #TheBay979"


@pytest.mark.parametrize("patch,err", [
    ({"domain": None}, "missing domain"), ({"siteName": "Bay <b>"}, "site_name"), ({"timezone": "Mars/Base"}, "timezone"),
    ({"areaCode": "97"}, "area_code"), ({"domain": "not a domain"}, "domain"),
])
def test_bad_town_stops(patch, err):
    with pytest.raises(ValueError, match=err):
        town_mod.town_config(town={**BAY, **patch})
    with pytest.raises(ValueError, match="isn't a town slug"):
        town_mod.town_config({"TOWN": "../x"})
    with pytest.raises(ValueError, match="can't read"):
        town_mod.town_config({"TOWN": "nowhere", "TOWNS_DIR": "/nonexistent"})


@pytest.fixture
def bay(tmp_path, monkeypatch):
    """Reload town.py and the scripts with TOWN=bay; put Victoria back after."""
    (tmp_path / "bay").mkdir()
    (tmp_path / "bay" / "town.json").write_text(json.dumps(BAY))
    monkeypatch.setenv("TOWN", "bay")
    monkeypatch.setenv("TOWNS_DIR", str(tmp_path))
    monkeypatch.delenv("SITE_URL", raising=False)
    names = ["town", "social_kit", "social_slides", "sweep_events", "review_submissions", "uptime_check"]
    mods = {n: importlib.reload(importlib.import_module(n)) for n in names}
    yield mods
    monkeypatch.delenv("TOWN")
    monkeypatch.delenv("TOWNS_DIR")
    for n in names:
        importlib.reload(importlib.import_module(n))


def no_leak(text):
    return [w for w in LEAK if w in text]


def test_social_posts_name_the_town(bay):
    from datetime import date
    sk = bay["social_kit"]
    assert sk.SITE == "https://www.thebay979.com"
    assert sk.HASHTAGS == "#BayCityTX #BayCityTexas #TheBay979"
    assert sk.TITLES["week"][:2] == ("This week in Bay City, TX", "This Week in Bay City")
    assert "bay city" in sk.GENERIC_VENUES and "victoria" not in sk.GENERIC_VENUES
    events = [{"date": "2026-10-09", "name": "Fish Fry", "venue": "Hall", "time": "6:00 PM", "featured": True}]
    start, end = sk.week_bounds(date(2026, 10, 5))
    caps = sk.captions(sk.select_events(events, start, end), start, end, "week", {}, None)
    for which in ("facebook", "instagram"):
        assert no_leak(caps[which]) == [], which
    assert "thebay979.com" in caps["instagram"]
    assert bay["social_slides"]._wordmark() == 'The Bay <b class="pill361" style="color:#1F1A3D">979</b>'
    assert sk.zone_label() == "PT"


def test_prompts_and_alerts_name_the_town(bay):
    assert bay["sweep_events"].PROMPT.startswith("You check the published event list for The Bay 979, a community events site for Bay City, Texas.")
    assert "clearly not in or near Bay City, Texas." in bay["sweep_events"].PROMPT
    assert bay["sweep_events"].LABEL["out_of_area"] == "outside Bay City?"
    rp = bay["review_submissions"].PROMPT
    assert rp.startswith("You review event submissions for The Bay 979, a community events website for Bay City, Texas (nearby towns).")
    assert "in or near Bay City TX," in rp and "thebay979.com" in bay["review_submissions"].KNOWN_LINK_DOMAINS
    for text in (bay["sweep_events"].PROMPT, rp):
        assert no_leak(text) == []
    from datetime import datetime, timezone
    msg, _ = bay["uptime_check"].decide({}, ["/ returned HTTP 500"], datetime(2026, 10, 9, tzinfo=timezone.utc))
    assert msg == "🚨 thebay979.com is DOWN: / returned HTTP 500"
