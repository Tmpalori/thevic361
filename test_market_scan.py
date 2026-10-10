"""scripts/market_scan.py: counts a town's venues with a social page, with
Victoria as the baseline, and never runs past its cost ceiling."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
import market_scan as ms  # noqa: E402
import discover_venues as dv  # noqa: E402


def place(name, cat="Bar", fb=True, ig=False, score=4.5, reviews=120):
    return {"title": name, "placeId": name, "categoryName": cat, "totalScore": score, "reviewsCount": reviews,
            "facebooks": [f"https://facebook.com/{name}"] if fb else [], "instagrams": [f"https://instagram.com/{name}"] if ig else []}


def test_summary_dedupes_and_counts_tiers():
    s = ms.summarize([place("a"), place("a"), place("b", ig=True), place("c", fb=False),
                      place("d", cat="Restaurant", reviews=10)])
    assert s["places"] == 4
    assert (s["with_facebook"], s["with_instagram"], s["with_social"]) == (3, 1, 3)
    assert (s["high"], s["medium"]) == (2, 1)
    assert s["social_by_category"]["bar"] == 2
    assert [v["name"] for v in s["top_high"]] == ["a", "b"]


def test_estimate_and_ceiling(capsys, monkeypatch, tmp_path):
    monkeypatch.setattr(ms, "REPORT", str(tmp_path / "r.json"))
    assert ms.estimate_usd(8, 40) == round(8 * len(dv.CATEGORY_SEARCHES) * 40 * ms.USD_PER_PLACE, 2)
    assert ms.main(["--locations", "Tupelo, MS", "--estimate"]) == 0
    assert "2 locations" in capsys.readouterr().out          # Victoria added as the baseline
    called = []
    assert ms.main(["--locations", "A, TX; B, TX", "--max-usd", "1"], run=lambda: called.append(1) or []) == 2
    assert called == []                                       # over the ceiling: nothing runs


def test_run_writes_a_report_and_restores_nothing_on_disk(monkeypatch, tmp_path):
    monkeypatch.setattr(ms, "REPORT", str(tmp_path / "r.json"))
    seen = []

    def run():
        seen.append(dv.LOCATION_QUERY)
        return [place("x"), place("y", ig=True)]
    monkeypatch.setattr(dv, "PLACES_PER_SEARCH", dv.PLACES_PER_SEARCH)
    monkeypatch.setattr(dv, "LOCATION_QUERY", dv.LOCATION_QUERY)
    monkeypatch.setattr(dv, "APIFY_ACTOR_TIMEOUT", dv.APIFY_ACTOR_TIMEOUT)
    monkeypatch.setattr(dv, "APIFY_PER_CALL_TIMEOUT", dv.APIFY_PER_CALL_TIMEOUT)
    monkeypatch.setattr(dv, "APIFY_MAX_RETRIES", dv.APIFY_MAX_RETRIES)
    assert ms.main(["--locations", "Tupelo, MS", "--per-search", "5"], run=run, cost=lambda: 1.23) == 0
    assert seen == ["Victoria, TX", "Tupelo, MS"]
    assert dv.APIFY_MAX_RETRIES == 0                          # a retry would bill twice
    r = json.load(open(tmp_path / "r.json"))
    assert r["spent_usd"] == 1.23 and r["per_search"] == 5
    assert r["locations"]["Tupelo, MS"]["with_social"] == 2


def test_run_cost_sums_only_this_scans_runs():
    class R:
        def json(self):
            return {"data": {"items": [{"startedAt": "2026-10-10T05:00:00Z", "usageTotalUsd": 0.5},
                                       {"startedAt": "2026-10-10T06:00:00Z", "usageTotalUsd": 0.25},
                                       {"startedAt": "2026-10-09T23:00:00Z", "usageTotalUsd": 9}]}}
    assert ms.run_cost("t", "2026-10-10T04:00:00", get=lambda *a, **k: R()) == 0.75
