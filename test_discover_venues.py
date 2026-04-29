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


@pytest.fixture(autouse=True)
def _noop_sleep(monkeypatch):
    """Discovery now retries failed Apify calls with exponential backoff.
    Tests don't need real sleeps — patch out time.sleep so retry-heavy
    cases (network down, 503 storms) don't add ~12s each."""
    monkeypatch.setattr(dv.time, "sleep", lambda *_a, **_kw: None)


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


# ─── Observability (Sentry hooks) ───────────────────────────────────────────


def test_missing_apify_token_fires_sentry_warn(tmp_path, monkeypatch):
    """When APIFY_TOKEN is empty, the script must:
       - skip discovery (no exception)
       - emit a Sentry warning (not silently)
    """
    monkeypatch.setenv("APIFY_TOKEN", "")
    monkeypatch.delenv("APIFY_TOKEN", raising=False)

    warns = []
    monkeypatch.setattr(dv, "_sentry_warn",
                        lambda msg, **tags: warns.append((msg, tags)))

    summary = dv.discover_and_update(repo_root=str(tmp_path))
    assert summary["ran_apify"] is False
    # A Sentry warning was fired with a meaningful tag.
    assert any("APIFY_TOKEN" in m for m, _t in warns), warns


def test_apify_http_error_fires_sentry_warn(monkeypatch):
    """Apify HTTP 4xx/5xx must surface to Sentry, not just stdout."""
    warns = []
    monkeypatch.setattr(dv, "_sentry_warn",
                        lambda msg, **tags: warns.append((msg, tags)))

    class FakeResp:
        status_code = 503
        text = "service unavailable"

    items = dv.run_apify_discovery("any-token",
                                    http_post=lambda *a, **kw: FakeResp())
    assert items == []
    assert any("Apify HTTP" in m for m, _t in warns), warns


def test_apify_request_exception_fires_sentry_exception(monkeypatch):
    excs = []
    monkeypatch.setattr(dv, "_sentry_exception",
                        lambda stage, **tags: excs.append((stage, tags)))

    def boom(*a, **kw):
        raise RuntimeError("network down")

    items = dv.run_apify_discovery("tok", http_post=boom, sleep=lambda *_a, **_k: None)
    assert items == []
    assert any(stage == "apify_request" for stage, _t in excs)


# ─── Per-category split + retry behavior ────────────────────────────────────


def test_run_apify_discovery_calls_one_request_per_category(monkeypatch):
    """The combined-call timeout that produced 0 venues on Apr-29 was the
    motivation for splitting per category. Each category gets its own
    Apify request with its own timeout/retry budget."""
    calls = []

    def fake_post(url, **kwargs):
        calls.append(kwargs.get("json"))
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = []
        return resp

    items = dv.run_apify_discovery("tok", http_post=fake_post,
                                    sleep=lambda *_a, **_k: None)
    assert items == []
    assert len(calls) == len(dv.CATEGORY_SEARCHES)
    # Each call carries exactly one search term, not the combined list.
    for payload, term in zip(calls, dv.CATEGORY_SEARCHES):
        assert payload["searchStringsArray"] == [term]


def test_run_apify_discovery_per_call_timeout_is_capped(monkeypatch):
    """Per-call timeout must be the tighter PER_CALL ceiling, not the legacy
    240s combined timeout. A 6-minute step budget can't survive 8 categories
    × 240s if the network is sick."""
    timeouts = []

    def fake_post(url, **kwargs):
        timeouts.append(kwargs.get("timeout"))
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = []
        return resp

    dv.run_apify_discovery("tok", http_post=fake_post,
                           sleep=lambda *_a, **_k: None)
    assert timeouts, "expected at least one Apify call"
    assert all(t == dv.APIFY_PER_CALL_TIMEOUT for t in timeouts)
    assert dv.APIFY_PER_CALL_TIMEOUT <= 180


def test_run_apify_discovery_retries_on_network_failure(monkeypatch):
    """Transient network exceptions should be retried (with backoff) before
    we give up on a category."""
    n_categories = len(dv.CATEGORY_SEARCHES)
    expected_attempts = n_categories * (1 + dv.APIFY_MAX_RETRIES)
    attempts = {"n": 0}

    def fake_post(url, **kwargs):
        attempts["n"] += 1
        raise ConnectionError("blip")

    items = dv.run_apify_discovery("tok", http_post=fake_post,
                                    sleep=lambda *_a, **_k: None)
    assert items == []
    assert attempts["n"] == expected_attempts


def test_run_apify_discovery_retries_on_5xx(monkeypatch):
    """5xx responses are transient; retry up to APIFY_MAX_RETRIES times."""
    state = {"calls": 0}

    def fake_post(url, **kwargs):
        state["calls"] += 1
        resp = MagicMock()
        resp.status_code = 503
        resp.text = "service unavailable"
        return resp

    dv.run_apify_discovery("tok", http_post=fake_post,
                           sleep=lambda *_a, **_k: None)
    expected_calls = len(dv.CATEGORY_SEARCHES) * (1 + dv.APIFY_MAX_RETRIES)
    assert state["calls"] == expected_calls


def test_run_apify_discovery_does_not_retry_4xx_permanent(monkeypatch):
    """A permanent 4xx (e.g. 401 invalid token) should fail fast — retrying
    burns the step budget without changing the outcome."""
    state = {"calls": 0}

    def fake_post(url, **kwargs):
        state["calls"] += 1
        resp = MagicMock()
        resp.status_code = 401
        resp.text = "invalid token"
        return resp

    dv.run_apify_discovery("tok", http_post=fake_post,
                           sleep=lambda *_a, **_k: None)
    # 1 attempt per category, no retries on permanent 4xx.
    assert state["calls"] == len(dv.CATEGORY_SEARCHES)


def test_run_apify_discovery_recovers_on_retry(monkeypatch):
    """First attempt blows up, retry succeeds → items flow through."""
    state = {"calls": 0}

    def fake_post(url, **kwargs):
        state["calls"] += 1
        if state["calls"] == 1:
            raise ConnectionError("transient")
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = [{"title": "Recovered Bar"}]
        return resp

    items = dv.run_apify_discovery("tok", http_post=fake_post,
                                    sleep=lambda *_a, **_k: None)
    # First category needed a retry; remaining 7 succeeded on first try.
    assert state["calls"] == len(dv.CATEGORY_SEARCHES) + 1
    titles = [it.get("title") for it in items]
    assert titles.count("Recovered Bar") == len(dv.CATEGORY_SEARCHES)


def test_run_apify_discovery_per_category_failure_is_isolated(monkeypatch):
    """One category's failure must not lose the others' results — that's
    the whole point of the per-category split."""
    failing_term = dv.CATEGORY_SEARCHES[0]

    def fake_post(url, **kwargs):
        payload = kwargs.get("json", {})
        terms = payload.get("searchStringsArray", [])
        resp = MagicMock()
        if failing_term in terms:
            resp.status_code = 503
            resp.text = "boom"
            return resp
        resp.status_code = 200
        resp.json.return_value = [
            {"title": f"Place from {terms[0]}", "categories": [terms[0]],
             "totalScore": 4.6, "reviewsCount": 200,
             "facebooks": ["https://facebook.com/x"]}
        ]
        return resp

    items = dv.run_apify_discovery("tok", http_post=fake_post,
                                    sleep=lambda *_a, **_k: None)
    # 7 successful categories × 1 item each; failing category contributes 0.
    assert len(items) == len(dv.CATEGORY_SEARCHES) - 1


def test_all_categories_failing_fires_sentry_warn(monkeypatch):
    warns = []
    monkeypatch.setattr(dv, "_sentry_warn",
                        lambda msg, **tags: warns.append((msg, tags)))

    def fake_post(url, **kwargs):
        raise RuntimeError("everything is on fire")

    dv.run_apify_discovery("tok", http_post=fake_post,
                           sleep=lambda *_a, **_k: None)
    assert any("All Apify categories failed" in m for m, _ in warns), warns


def test_run_apify_discovery_honors_total_budget(monkeypatch):
    """Per-category loop must exit early when the internal time budget is
    exhausted, returning whatever it has gathered so far. Simulates the
    Apr-29 production failure (run 25123919466) where 5/8 categories
    completed before the GitHub step timeout killed the process — under
    the new contract, those 5 categories' results survive and the script
    exits cleanly with a Sentry warning instead of being SIGKILLed."""
    n_terms = len(dv.CATEGORY_SEARCHES)
    # Each call "takes" 70s (the Apr-29 average). Budget is 220s, so the
    # 4th iteration's pre-call check (elapsed=210s) still fits, but the
    # 5th (elapsed=280s) exceeds the budget and bails. We expect 4
    # categories to have completed.
    fake_now = {"t": 0.0}

    def fake_monotonic():
        return fake_now["t"]

    def fake_post(url, **kwargs):
        fake_now["t"] += 70.0
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = [
            {"title": f"Place from call {fake_now['t']}",
             "facebooks": ["https://facebook.com/x"]}
        ]
        return resp

    warns = []
    monkeypatch.setattr(dv, "_sentry_warn",
                        lambda msg, **tags: warns.append((msg, tags)))

    items = dv.run_apify_discovery(
        "tok",
        http_post=fake_post,
        sleep=lambda *_a, **_k: None,
        monotonic=fake_monotonic,
        total_budget_seconds=220,
    )

    # Some categories ran (partial results survive)…
    assert 0 < len(items) < n_terms
    # …but not all of them: 4 admitted under the budget, 4 skipped.
    assert len(items) == 4, (
        f"Expected 4 categories under a 220s budget at 70s/call, "
        f"got {len(items)}"
    )
    # And a Sentry warning fired about the budget.
    assert any("time budget exhausted" in m.lower() for m, _t in warns), warns


def test_run_apify_discovery_no_budget_breach_no_warning(monkeypatch):
    """When all categories finish under the budget, no budget-exhausted
    warning should be emitted (otherwise the operator gets noise on every
    healthy run)."""
    fake_now = {"t": 0.0}

    def fake_monotonic():
        return fake_now["t"]

    def fake_post(url, **kwargs):
        fake_now["t"] += 5.0  # 5s per call → well under any sane budget
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = []
        return resp

    warns = []
    monkeypatch.setattr(dv, "_sentry_warn",
                        lambda msg, **tags: warns.append((msg, tags)))

    dv.run_apify_discovery(
        "tok", http_post=fake_post,
        sleep=lambda *_a, **_k: None,
        monotonic=fake_monotonic,
        total_budget_seconds=220,
    )
    assert not any("time budget exhausted" in m.lower() for m, _t in warns), warns


def test_discover_and_update_keeps_partial_budget_results(monkeypatch, tmp_path):
    """End-to-end: when the budget trips mid-loop, the categories that did
    run still get classified and written to venues.json / pending_venues.json,
    so the operator gets a partial refresh instead of an empty pass."""
    monkeypatch.setenv("APIFY_TOKEN", "fake-token")
    _seed_repo(tmp_path)

    fake_now = {"t": 0.0}

    def fake_monotonic():
        return fake_now["t"]

    def fake_post(url, **kwargs):
        # Each category "takes" 70s, so a 220s budget admits 3 categories.
        fake_now["t"] += 70.0
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = [
            {"title": f"Place {fake_now['t']:.0f}",
             "categories": ["Bar"], "totalScore": 4.5,
             "reviewsCount": 200,
             "facebooks": [f"https://facebook.com/p{fake_now['t']:.0f}"]},
        ]
        return resp

    summary = dv.discover_and_update(
        repo_root=str(tmp_path),
        http_post=fake_post,
        monotonic=fake_monotonic,
    )

    assert summary["ran_apify"] is True
    # Four categories admitted under the budget = four HIGH places
    # (5th iteration's pre-call check at 280s exceeds the 220s budget).
    assert summary["discovered_high"] == 4
    venues = json.loads((tmp_path / "venues.json").read_text())
    # Seed survives + 4 new HIGH = 5 venues.
    assert len(venues) == 5


def test_apify_per_call_timeout_fits_in_step_budget():
    """Sanity bound: the per-call timeout must be small enough that even a
    couple of stuck categories can't blow through the 6-minute step ceiling
    before the internal budget kicks in. 120s × 2 = 240s ≤ 360s (step cap)."""
    assert dv.APIFY_PER_CALL_TIMEOUT <= 130
    assert dv.APIFY_TOTAL_BUDGET_SECONDS + dv.APIFY_PER_CALL_TIMEOUT < 360


def test_apify_zero_results_fires_sentry_warn(tmp_path, monkeypatch):
    """Token set + actor ran but no HIGH/MEDIUM venues → warn (silent breakage)."""
    monkeypatch.setenv("APIFY_TOKEN", "fake-token")

    warns = []
    monkeypatch.setattr(dv, "_sentry_warn",
                        lambda msg, **tags: warns.append((msg, tags)))

    # Apify returns one place that classifies as SKIP (no social) so the
    # zero-HIGH-zero-MEDIUM Sentry warning is what we want to assert.
    monkeypatch.setattr(dv, "run_apify_discovery",
                        lambda token, http_post=None, sleep=None,
                        monotonic=None, **kw: [
                            {"title": "Something", "totalScore": 4.0,
                             "reviewsCount": 100, "categories": ["Bar"]}
                        ])
    summary = dv.discover_and_update(repo_root=str(tmp_path))
    assert summary["ran_apify"] is True
    assert any("0 HIGH and 0 MEDIUM" in m for m, _t in warns), warns
