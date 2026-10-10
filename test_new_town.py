"""scripts/new_town.py (MULTI_CITY_PLAN.md 5.1): a new town's files from a
few answers, checked like the server checks them, never Victoria's."""
import importlib
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "scripts"))
import new_town  # noqa: E402
import town as town_mod  # noqa: E402

BAY = ["--slug", "bay", "--name", "The Bay 979", "--domain", "thebay979.com", "--city", "Bay City", "--state", "TX",
       "--state-name", "Texas", "--timezone", "America/Chicago", "--county", "Matagorda County", "--area-code", "979",
       "--zips", "77414, 77404", "--other-towns", "Wharton, Palacios", "--yes"]


def run(tmp_path, *args):
    return new_town.main([*args, "--towns-dir", str(tmp_path)])


def test_creates_the_town(tmp_path, capsys):
    assert run(tmp_path, *BAY) == 0
    out = capsys.readouterr().out
    assert json.loads((tmp_path / "bay" / "town.json").read_text()) == {
        "siteName": "The Bay 979", "domain": "thebay979.com", "city": "Bay City", "state": "TX", "stateName": "Texas",
        "timezone": "America/Chicago", "county": "Matagorda County", "areaCode": "979",
        "areaZips": ["77414", "77404"], "otherTowns": ["wharton", "palacios"]}
    assert (tmp_path / "bay" / "local_events.yaml").read_text().endswith("events: []\n")
    assert (tmp_path / "bay" / "public").is_dir()
    assert json.loads((tmp_path / "index.json").read_text()) == {"towns": ["victoria", "bay"]}
    # town.py reads it back as the server would at boot.
    t = town_mod.town_config({"TOWN": "bay"}, towns_dir=str(tmp_path))
    assert t["site_url"] == "https://www.thebay979.com" and t["area_zips"] == ["77414", "77404"]
    assert "TOWN=bay python3 discover_venues.py --repo-root towns/bay" in out
    assert "SITE_URL=https://www.thebay979.com" in out and "NEWSLETTER_FROM=\"The Bay 979 <news@thebay979.com>\"" in out
    assert "thevic361" not in out


def test_index_stays_sorted_with_victoria_first(tmp_path):
    assert run(tmp_path, *BAY) == 0
    tulsa = ["--slug", "abilene", "--name", "Abilene Now", "--domain", "abilenenow.com", "--city", "Abilene", "--state", "TX",
             "--state-name", "Texas", "--timezone", "America/Chicago", "--yes"]
    assert run(tmp_path, *tulsa) == 0
    assert json.loads((tmp_path / "index.json").read_text())["towns"] == ["victoria", "abilene", "bay"]
    assert "county" not in json.loads((tmp_path / "abilene" / "town.json").read_text())


@pytest.mark.parametrize("change, error", [
    ({"--slug": "victoria"}, "victoria is The Vic 361"),
    ({"--slug": "Bay City"}, "slug must be"),
    ({"--domain": "thevic361.com"}, "Victoria's domain"),
    ({"--domain": "not a domain"}, "doesn't look like a domain"),
    ({"--timezone": "Mars/Base"}, "unknown timezone"),
    ({"--area-code": "97"}, "area_code"),
    ({"--zips": "7741"}, "5-digit"),
])
def test_refuses_bad_settings(tmp_path, capsys, change, error):
    args = list(BAY)
    for k, v in change.items():
        args[args.index(k) + 1] = v
    assert run(tmp_path, *args) == 1
    assert error in capsys.readouterr().err
    assert not (tmp_path / "index.json").exists()


def test_refuses_an_existing_town_and_missing_answers(tmp_path, capsys):
    assert run(tmp_path, *BAY) == 0
    before = (tmp_path / "bay" / "town.json").read_text()
    assert run(tmp_path, *BAY) == 1
    assert "already exists" in capsys.readouterr().err
    assert (tmp_path / "bay" / "town.json").read_text() == before
    with pytest.raises(SystemExit):
        run(tmp_path, "--slug", "x", "--yes")


def test_discover_venues_searches_the_town(tmp_path, monkeypatch):
    import discover_venues
    assert discover_venues.LOCATION_QUERY == "Victoria, TX"
    assert run(tmp_path, *BAY) == 0
    monkeypatch.setenv("TOWN", "bay")
    monkeypatch.setenv("TOWNS_DIR", str(tmp_path))
    try:
        importlib.reload(town_mod)
        assert importlib.reload(discover_venues).LOCATION_QUERY == "Bay City, TX"
    finally:
        monkeypatch.delenv("TOWN")
        monkeypatch.delenv("TOWNS_DIR")
        importlib.reload(town_mod)
        importlib.reload(discover_venues)
    assert discover_venues.LOCATION_QUERY == "Victoria, TX"
