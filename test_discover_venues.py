"""Unit tests for discover_venues.py.

Covers:
  - tier classification (HIGH / MEDIUM / SKIP edges)
  - normalization & dedupe of Apify items
  - seed-floor preservation across merges
  - rejected_venues filtering
  - pending_venues append behavior
  - collector fallback ordering (venues.json → facebook_venues.json → backup)
"""

from __future__ import annotations

import json
import os
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import discover_venues as dv  # noqa: E402


# ─── Tier classification ────────────────────────────────────────────────────


def _venue(**overrides):
    base = {
        "name": "Test Bar",
        "categories": ["Bar"],
        "totalScore": 4.5,
        "reviewsCount": 200,
        "facebooks": ["https://facebook.com/testbar"],
        "instagrams": [],
    }
    base.update(overrides)
    return base


def test_high_tier_requires_all_signals():
    assert dv.classify_tier(_venue()) == "HIGH"


def test_high_tier_demotes_when_few_reviews():
    # 49 reviews → fails review floor → MEDIUM (still has social)
    assert dv.classify_tier(_venue(reviewsCount=49)) == "MEDIUM"


def test_high_tier_demotes_when_rating_below_floor():
    # 4.0 ≥ 3.8 + has social → MEDIUM
    assert dv.classify_tier(_venue(totalScore=4.0)) == "MEDIUM"


def test_skip_when_rating_below_3_5():
    assert dv.classify_tier(_venue(totalScore=3.4)) == "SKIP"


def test_skip_when_no_social():
    v = _venue(facebooks=[], instagrams=[])
    assert dv.classify_tier(v) == "SKIP"


def test_skip_when_permanently_closed():
    v = _venue(permanentlyClosed=True)
    assert dv.classify_tier(v) == "SKIP"


def test_skip_when_business_status_closed():
    v = _venue(businessStatus="CLOSED_PERMANENTLY")
    assert dv.classify_tier(v) == "SKIP"


def test_skip_fast_food_chain():
    v = _venue(name="McDonald's #4567", categories=["Fast Food"])
    assert dv.classify_tier(v) == "SKIP"


def test_high_requires_event_likely_category():
    # High-rated, lots of reviews, but a barbershop → not event-likely → MEDIUM
    v = _venue(categories=["Barber Shop"])
    assert dv.classify_tier(v) == "MEDIUM"


def test_medium_when_no_rating_but_few_reviews():
    v = _venue(totalScore=None, reviewsCount=10)
    assert dv.classify_tier(v) == "MEDIUM"


# ─── Normalization ──────────────────────────────────────────────────────────


def test_normalize_actor_item_basic():
    raw = {
        "title": "Moonshine Drinkery",
        "placeId": "abc123",
        "totalScore": 4.6,
        "reviewsCount": 312,
        "categories": ["Bar", "Live music venue"],
        "instagrams": ["https://instagram.com/moonshine"],
        "facebooks": ["https://facebook.com/moonshinedrinkery"],
        "website": "https://moonshine.com",
        "location": {"lat": 28.8, "lng": -97.0},
        "address": "103 W Santa Rosa St",
    }
    v = dv.normalize_actor_item(raw)
    assert v["name"] == "Moonshine Drinkery"
    assert v["place_id"] == "abc123"
    assert v["totalScore"] == 4.6
    assert v["reviewsCount"] == 312
    assert v["instagrams"] == ["https://instagram.com/moonshine"]
    assert v["facebooks"] == ["https://facebook.com/moonshinedrinkery"]
    assert v["facebook_page"] == "https://facebook.com/moonshinedrinkery"
    assert v["lat"] == 28.8
    assert v["lng"] == -97.0
    assert v["source"] == "google_maps"


def test_normalize_handles_alternate_field_names():
    raw = {
        "name": "Alt Bar",
        "rating": 4.0,
        "userRatingsTotal": 80,
        "instagram": "https://instagram.com/alt",
        "facebookUrl": "https://facebook.com/alt",
        "lat": 28.8, "lon": -97.0,
        "categoryName": "Bar",
    }
    v = dv.normalize_actor_item(raw)
    assert v["name"] == "Alt Bar"
    assert v["totalScore"] == 4.0
    assert v["reviewsCount"] == 80
    assert v["instagrams"] == ["https://instagram.com/alt"]
    assert v["facebooks"] == ["https://facebook.com/alt"]
    assert v["categories"] == ["Bar"]
    assert v["lng"] == -97.0


def test_normalize_skips_garbage():
    assert dv.normalize_actor_item(None) == {}
    assert dv.normalize_actor_item("not a dict") == {}


# ─── Merge / seed floor / dedupe ────────────────────────────────────────────


def test_seed_venues_preserved_in_merge():
    seed = [
        {"name": "Aero Crafters", "facebook_page": "https://facebook.com/aero",
         "confidence": "high", "source": "seed"},
    ]
    discovered = []
    merged = dv.merge_venues(seed, discovered)
    assert len(merged) == 1
    assert merged[0]["name"] == "Aero Crafters"
    assert merged[0]["confidence"] == "high"  # seed metadata preserved


def test_merge_dedupes_by_name():
    seed = [{"name": "Moonshine Drinkery", "source": "seed"}]
    discovered = [
        {"name": "moonshine drinkery", "place_id": None, "totalScore": 4.7,
         "facebooks": ["https://facebook.com/moonshine"]}
    ]
    merged = dv.merge_venues(seed, discovered)
    assert len(merged) == 1
    # Discovered enrichment fills in missing fields on the seed.
    assert merged[0].get("totalScore") == 4.7


def test_merge_dedupes_by_place_id_when_present():
    seed = [{"name": "Renamed Venue", "place_id": "pid-1", "source": "seed"}]
    discovered = [{"name": "Original Venue", "place_id": "pid-1",
                   "facebooks": ["https://facebook.com/x"]}]
    merged = dv.merge_venues(seed, discovered)
    assert len(merged) == 1
    # Seed identity wins.
    assert merged[0]["name"] == "Renamed Venue"


def test_merge_adds_new_high_venues():
    seed = [{"name": "Existing", "source": "seed"}]
    discovered = [
        {"name": "Brand New Venue", "facebooks": ["https://facebook.com/new"]}
    ]
    merged = dv.merge_venues(seed, discovered)
    names = {v["name"] for v in merged}
    assert names == {"Existing", "Brand New Venue"}


# ─── Pending / rejected handling ────────────────────────────────────────────


def test_append_pending_skips_rejected_and_floor(tmp_path):
    pending_path = str(tmp_path / "pending.json")
    rejected_keys = {dv._venue_key({"name": "Rejected Joe"})}
    floor_keys = {dv._venue_key({"name": "Already Known"})}
    new_medium = [
        {"name": "Rejected Joe"},
        {"name": "Already Known"},
        {"name": "Fresh Medium", "facebooks": ["x"]},
    ]
    out = dv.append_pending(pending_path, new_medium,
                            rejected_keys=rejected_keys,
                            floor_keys=floor_keys)
    assert [v["name"] for v in out] == ["Fresh Medium"]


def test_append_pending_dedupes_against_existing(tmp_path):
    pending_path = str(tmp_path / "pending.json")
    with open(pending_path, "w") as f:
        json.dump([{"name": "Already Pending"}], f)
    out = dv.append_pending(pending_path, [{"name": "Already Pending"},
                                           {"name": "New One"}],
                            rejected_keys=set(), floor_keys=set())
    assert [v["name"] for v in out] == ["Already Pending", "New One"]


# ─── Orchestration: discover_and_update with mocked Apify ──────────────────


def _seed_repo(tmp_path):
    fb_path = tmp_path / "facebook_venues.json"
    seed = [{"name": "Aero Crafters", "category": "Bar",
             "facebook_page": "https://facebook.com/aero",
             "confidence": "high"}]
    fb_path.write_text(json.dumps(seed))
    return tmp_path


def test_discover_and_update_no_token_is_noop_but_seeds_venues(monkeypatch, tmp_path):
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    _seed_repo(tmp_path)
    summary = dv.discover_and_update(repo_root=str(tmp_path))
    assert summary["ran_apify"] is False
    venues = json.loads((tmp_path / "venues.json").read_text())
    assert any(v["name"] == "Aero Crafters" for v in venues)
    # Backup should mirror legacy file.
    assert (tmp_path / "facebook_venues.backup.json").exists()


def test_discover_and_update_sorts_and_writes(monkeypatch, tmp_path):
    monkeypatch.setenv("APIFY_TOKEN", "fake-token")
    _seed_repo(tmp_path)
    # Pre-seed a rejected venue so we can confirm it's filtered.
    (tmp_path / "rejected_venues.json").write_text(json.dumps(
        [{"name": "The Rejected Place"}]
    ))

    fake_resp = MagicMock()
    fake_resp.status_code = 200
    fake_resp.json.return_value = [
        # HIGH: bar w/ rating 4.5, 200 reviews, FB
        {"title": "Hot Bar", "categories": ["Bar"], "totalScore": 4.5,
         "reviewsCount": 200, "facebooks": ["https://facebook.com/hotbar"]},
        # MEDIUM: only 30 reviews
        {"title": "Tiny Cafe", "categories": ["Cafe"], "totalScore": 4.5,
         "reviewsCount": 30, "facebooks": ["https://facebook.com/tinycafe"]},
        # SKIP: closed
        {"title": "Closed Place", "categories": ["Bar"], "totalScore": 4.8,
         "reviewsCount": 500, "facebooks": ["https://facebook.com/closed"],
         "permanentlyClosed": True},
        # SKIP: rejected list
        {"title": "The Rejected Place", "categories": ["Bar"],
         "totalScore": 4.9, "reviewsCount": 500,
         "facebooks": ["https://facebook.com/rej"]},
    ]
    fake_post = MagicMock(return_value=fake_resp)

    summary = dv.discover_and_update(repo_root=str(tmp_path), http_post=fake_post)

    assert fake_post.called
    assert summary["ran_apify"] is True
    assert summary["discovered_high"] == 1
    assert summary["discovered_medium"] == 1
    # Closed + rejected = 2 skipped (rejected dropped before tier check, so 1)
    assert summary["skipped"] >= 1

    venues = json.loads((tmp_path / "venues.json").read_text())
    names = {v["name"] for v in venues}
    assert "Aero Crafters" in names  # seed preserved
    assert "Hot Bar" in names        # HIGH merged
    assert "Tiny Cafe" not in names  # MEDIUM stays in pending

    pending = json.loads((tmp_path / "pending_venues.json").read_text())
    assert [p["name"] for p in pending] == ["Tiny Cafe"]


def test_discover_and_update_apify_failure_is_nondestructive(monkeypatch, tmp_path):
    monkeypatch.setenv("APIFY_TOKEN", "fake-token")
    _seed_repo(tmp_path)
    fake_post = MagicMock(side_effect=RuntimeError("network down"))
    summary = dv.discover_and_update(repo_root=str(tmp_path), http_post=fake_post)
    # Failure path: ran_apify True but no items processed.
    assert summary["discovered_high"] == 0
    venues = json.loads((tmp_path / "venues.json").read_text())
    assert any(v["name"] == "Aero Crafters" for v in venues)


# ─── Collector fallback ─────────────────────────────────────────────────────


def test_collector_prefers_venues_json(tmp_path, monkeypatch):
    """_load_venue_list should pick venues.json first, then fb, then backup."""
    import collect_events as ce

    # Point the collector at a tmp dir.
    monkeypatch.setattr(ce, "__file__", str(tmp_path / "collect_events.py"))

    (tmp_path / "venues.json").write_text(json.dumps([{"name": "From Primary"}]))
    (tmp_path / "facebook_venues.json").write_text(json.dumps([{"name": "From FB"}]))
    (tmp_path / "facebook_venues.backup.json").write_text(json.dumps([{"name": "From Backup"}]))

    venues, path = ce._load_venue_list()
    assert venues[0]["name"] == "From Primary"
    assert path.endswith("venues.json")


def test_collector_falls_back_to_facebook_venues(tmp_path, monkeypatch):
    import collect_events as ce
    monkeypatch.setattr(ce, "__file__", str(tmp_path / "collect_events.py"))
    (tmp_path / "facebook_venues.json").write_text(json.dumps([{"name": "From FB"}]))
    (tmp_path / "facebook_venues.backup.json").write_text(json.dumps([{"name": "From Backup"}]))
    venues, path = ce._load_venue_list()
    assert venues[0]["name"] == "From FB"
    assert path.endswith("facebook_venues.json")


def test_collector_falls_back_to_backup(tmp_path, monkeypatch):
    import collect_events as ce
    monkeypatch.setattr(ce, "__file__", str(tmp_path / "collect_events.py"))
    (tmp_path / "facebook_venues.backup.json").write_text(json.dumps([{"name": "From Backup"}]))
    venues, path = ce._load_venue_list()
    assert venues[0]["name"] == "From Backup"
    assert path.endswith("facebook_venues.backup.json")


def test_collector_returns_empty_when_no_files(tmp_path, monkeypatch):
    import collect_events as ce
    monkeypatch.setattr(ce, "__file__", str(tmp_path / "collect_events.py"))
    venues, path = ce._load_venue_list()
    assert venues == []
    assert path is None
