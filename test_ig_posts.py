"""Unit tests for the Instagram posts scraper integration.

Mirrors test_fb_posts.py. Covers:
  - IG_POSTS_ENABLED feature flag
  - APIFY_TOKEN / PERPLEXITY_API_KEY guards
  - _APIFY_LIMIT_TRIPPED tombstone gating + propagation on 403 hard-limit
  - _normalize_ig_username (URLs, @handles, junk)
  - _venue_instagram_username extraction (instagrams[], instagram, missing)
  - _venue_tier (HIGH/MEDIUM/LOW from tier OR confidence)
  - tier-aware resultsLimit (HIGH=25, MEDIUM=15)
  - actor input shape (username array, resultsLimit, onlyPostsNewerThan)
  - Sonar handoff via _extract_events_from_posts_via_sonar
  - empty/no-IG venue behavior
  - error handling (HTTP 500, request exception, bad JSON)

Network is stubbed via monkey-patched requests.post.
"""
import json
import os
import sys
from datetime import date, timedelta
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce


# ─── Fixtures ───────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def reset_state(monkeypatch, tmp_path):
    """Reset module state and provide a tmp venues.json with IG handles."""
    ce._APIFY_LIMIT_TRIPPED = False
    ce._WINDOW_START = date.today()
    ce._WINDOW_END = date.today() + timedelta(days=14)

    for k in ("APIFY_TOKEN", "PERPLEXITY_API_KEY", "IG_POSTS_ENABLED"):
        monkeypatch.delenv(k, raising=False)

    venues = [
        {
            "name": "Aero Crafters",
            "tier": "HIGH",
            "instagrams": ["https://www.instagram.com/aerocrafters/"],
        },
        {
            "name": "Moonshine Drinkery",
            "confidence": "high",  # legacy seed schema
            "instagram": "@moonshinedrinkery",
        },
        {
            "name": "Froggy's Grub & Pub",
            "tier": "MEDIUM",
            "instagrams": ["froggysgrub"],
        },
        {
            # Should be skipped — LOW tier
            "name": "Skipme Bar",
            "confidence": "low",
            "instagrams": ["skipme"],
        },
        {
            # Should be skipped — no IG data
            "name": "No IG Venue",
            "tier": "HIGH",
        },
    ]
    repo_dir = os.path.dirname(ce.__file__)
    originals = {}
    for fname in ("venues.json", "facebook_venues.json"):
        path = os.path.join(repo_dir, fname)
        if os.path.exists(path):
            with open(path, "r") as f:
                originals[fname] = f.read()
    primary = os.path.join(repo_dir, "venues.json")
    with open(primary, "w") as f:
        json.dump(venues, f)

    yield

    for fname, content in originals.items():
        with open(os.path.join(repo_dir, fname), "w") as f:
            f.write(content)
    if "venues.json" not in originals and os.path.exists(primary):
        os.remove(primary)


# ─── Username normalization ─────────────────────────────────────────────────


def test_normalize_ig_username_url():
    assert ce._normalize_ig_username("https://www.instagram.com/aerocrafters/") == "aerocrafters"
    assert ce._normalize_ig_username("http://instagram.com/foo") == "foo"
    assert ce._normalize_ig_username("https://instagram.com/foo.bar/?hl=en") == "foo.bar"


def test_normalize_ig_username_handle_and_plain():
    assert ce._normalize_ig_username("@aerocrafters") == "aerocrafters"
    assert ce._normalize_ig_username("aerocrafters") == "aerocrafters"
    assert ce._normalize_ig_username("  @foo_bar.123  ") == "foo_bar.123"


def test_normalize_ig_username_rejects_junk():
    assert ce._normalize_ig_username("") is None
    assert ce._normalize_ig_username(None) is None
    assert ce._normalize_ig_username("https://facebook.com/foo") is None
    assert ce._normalize_ig_username("not a username!") is None


def test_venue_instagram_username_prefers_instagrams_list():
    v = {"instagrams": ["https://www.instagram.com/aerocrafters/"], "instagram": "fallback"}
    assert ce._venue_instagram_username(v) == "aerocrafters"


def test_venue_instagram_username_falls_back_and_returns_none():
    assert ce._venue_instagram_username({"instagram": "@foo"}) == "foo"
    assert ce._venue_instagram_username({}) is None
    assert ce._venue_instagram_username({"instagrams": []}) is None
    assert ce._venue_instagram_username({"instagrams": ["not a username!"]}) is None


# ─── Tier classification ────────────────────────────────────────────────────


def test_venue_tier_from_tier_field_and_confidence():
    assert ce._venue_tier({"tier": "HIGH"}) == "HIGH"
    assert ce._venue_tier({"tier": "medium"}) == "MEDIUM"
    assert ce._venue_tier({"confidence": "high"}) == "HIGH"
    assert ce._venue_tier({"confidence": "MEDIUM"}) == "MEDIUM"
    assert ce._venue_tier({"confidence": "low"}) == "LOW"
    assert ce._venue_tier({}) == "LOW"


# ─── Feature flag / guards ──────────────────────────────────────────────────


def test_ig_posts_disabled_by_default():
    assert ce.fetch_apify_instagram_posts(14) == []


def test_ig_posts_no_apify_token(monkeypatch):
    monkeypatch.setenv("IG_POSTS_ENABLED", "1")
    assert ce.fetch_apify_instagram_posts(14) == []


def test_ig_posts_no_perplexity_key(monkeypatch):
    monkeypatch.setenv("IG_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    assert ce.fetch_apify_instagram_posts(14) == []


def test_ig_posts_tombstone_short_circuits(monkeypatch):
    monkeypatch.setenv("IG_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    monkeypatch.setenv("PERPLEXITY_API_KEY", "fake")
    ce._APIFY_LIMIT_TRIPPED = True

    with patch("collect_events.requests.post") as mock_post:
        out = ce.fetch_apify_instagram_posts(14)
    assert out == []
    mock_post.assert_not_called()


def test_ig_posts_403_hard_limit_trips_tombstone(monkeypatch):
    monkeypatch.setenv("IG_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    monkeypatch.setenv("PERPLEXITY_API_KEY", "fake")

    fake_resp = MagicMock()
    fake_resp.status_code = 403
    fake_resp.text = '{"error":"Monthly usage hard limit exceeded"}'

    with patch("collect_events.requests.post", return_value=fake_resp):
        out = ce.fetch_apify_instagram_posts(14)

    assert out == []
    assert ce._APIFY_LIMIT_TRIPPED is True


# ─── Tier-aware actor input + Sonar handoff ─────────────────────────────────


def test_ig_posts_tier_aware_limits_and_payload_shape(monkeypatch):
    """HIGH venues request 25 posts, MEDIUM venues request 15. Payload must
    carry username (array), resultsLimit, onlyPostsNewerThan."""
    monkeypatch.setenv("IG_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    monkeypatch.setenv("PERPLEXITY_API_KEY", "fake")

    captured_payloads = []

    def fake_post(url, **kwargs):
        resp = MagicMock()
        resp.status_code = 200
        resp.raise_for_status = MagicMock()
        if "instagram-post-scraper" in url:
            captured_payloads.append(kwargs.get("json"))
            resp.json.return_value = []  # no posts → no Sonar call
        elif "perplexity.ai" in url:
            resp.json.return_value = {"choices": [{"message": {"content": "[]"}}]}
        return resp

    with patch("collect_events.requests.post", side_effect=fake_post):
        ce.fetch_apify_instagram_posts(14)

    # 2 HIGH (Aero, Moonshine) + 1 MEDIUM (Froggy's) = 3 venues. LOW + no-IG skipped.
    assert len(captured_payloads) == 3
    by_user = {p["username"][0]: p for p in captured_payloads}
    assert by_user["aerocrafters"]["resultsLimit"] == 25
    assert by_user["moonshinedrinkery"]["resultsLimit"] == 25
    assert by_user["froggysgrub"]["resultsLimit"] == 15

    for p in captured_payloads:
        assert isinstance(p["username"], list) and len(p["username"]) == 1
        assert isinstance(p["resultsLimit"], int)
        assert "onlyPostsNewerThan" in p
        # YYYY-MM-DD shape
        assert len(p["onlyPostsNewerThan"]) == 10 and p["onlyPostsNewerThan"][4] == "-"


def test_ig_posts_happy_path_sonar_handoff(monkeypatch):
    """Stub Apify + Sonar — verify caption→sonar handoff and event normalization."""
    monkeypatch.setenv("IG_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    monkeypatch.setenv("PERPLEXITY_API_KEY", "fake")

    target_date = (date.today() + timedelta(days=3)).strftime("%Y-%m-%d")

    posts_payload = [
        {
            "caption": "Live music tonight 8pm with The Rangers",
            "url": "https://instagram.com/p/abc123",
            "timestamp": "2026-04-25T15:00:00",
        },
        {
            "caption": "Photo dump from last weekend",
            "url": "https://instagram.com/p/def456",
            "timestamp": "2026-04-24T15:00:00",
        },
    ]
    sonar_payload = {
        "choices": [{
            "message": {
                "content": json.dumps([
                    {
                        "date": target_date,
                        "name": "Live Music with The Rangers",
                        "time": "8:00 PM",
                        "description": "Country band live on the patio.",
                        "free": False,
                        "source_post_index": 1,
                    }
                ])
            }
        }]
    }

    sonar_prompts = []

    def fake_post(url, **kwargs):
        resp = MagicMock()
        resp.status_code = 200
        resp.raise_for_status = MagicMock()
        if "instagram-post-scraper" in url:
            resp.json.return_value = posts_payload
        elif "perplexity.ai" in url:
            sonar_prompts.append(kwargs.get("json", {}).get("messages", [{}])[0].get("content", ""))
            resp.json.return_value = sonar_payload
        return resp

    with patch("collect_events.requests.post", side_effect=fake_post):
        out = ce.fetch_apify_instagram_posts(14)

    # 3 tiered venues with IG handles → 3 actor calls + 3 sonar calls
    assert len(sonar_prompts) == 3
    # The shared FB-posts prompt is being reused — its tell is the
    # "Facebook posts" phrase. We do not redesign the prompt for IG.
    assert all("Facebook posts" in p for p in sonar_prompts)

    # Each venue produced one event from the stub
    assert len(out) == 3
    ev = out[0]
    assert ev["date"] == target_date
    assert ev["name"] == "Live Music with The Rangers"
    assert ev["time"] == "8:00 PM"
    assert ev["url"] == "https://instagram.com/p/abc123"
    assert "music" in ev["icons"]


def test_ig_posts_filters_out_of_window_events(monkeypatch):
    """Sonar may return dates outside the collection window — drop them."""
    monkeypatch.setenv("IG_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    monkeypatch.setenv("PERPLEXITY_API_KEY", "fake")

    far_future = (date.today() + timedelta(days=400)).strftime("%Y-%m-%d")
    sonar_payload = {
        "choices": [{
            "message": {
                "content": json.dumps([
                    {"date": far_future, "name": "Way too far out", "free": False},
                    {"date": "not-a-date", "name": "Bad date", "free": False},
                    {"date": "", "name": "Missing date", "free": False},
                ])
            }
        }]
    }

    def fake_post(url, **kwargs):
        resp = MagicMock()
        resp.status_code = 200
        resp.raise_for_status = MagicMock()
        if "instagram-post-scraper" in url:
            resp.json.return_value = [{"caption": "post", "timestamp": "2026-04-25T00:00:00"}]
        else:
            resp.json.return_value = sonar_payload
        return resp

    with patch("collect_events.requests.post", side_effect=fake_post):
        out = ce.fetch_apify_instagram_posts(14)
    assert out == []


def test_ig_posts_handles_actor_500_no_tombstone(monkeypatch):
    monkeypatch.setenv("IG_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    monkeypatch.setenv("PERPLEXITY_API_KEY", "fake")

    fake_resp = MagicMock()
    fake_resp.status_code = 500
    fake_resp.text = "internal server error"

    with patch("collect_events.requests.post", return_value=fake_resp):
        out = ce.fetch_apify_instagram_posts(14)
    assert out == []
    assert ce._APIFY_LIMIT_TRIPPED is False


def test_ig_posts_handles_request_exception(monkeypatch):
    monkeypatch.setenv("IG_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    monkeypatch.setenv("PERPLEXITY_API_KEY", "fake")

    def boom(*a, **k):
        raise ConnectionError("network down")

    with patch("collect_events.requests.post", side_effect=boom):
        out = ce.fetch_apify_instagram_posts(14)
    assert out == []
    # A network error must NOT trip the hard-limit tombstone — that is reserved
    # for explicit Apify usage-cap responses.
    assert ce._APIFY_LIMIT_TRIPPED is False


def test_ig_posts_no_tiered_ig_venues_short_circuits(monkeypatch, tmp_path):
    """When venues.json has no tiered venues with IG handles, we should
    return [] without making any HTTP calls."""
    monkeypatch.setenv("IG_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    monkeypatch.setenv("PERPLEXITY_API_KEY", "fake")

    repo_dir = os.path.dirname(ce.__file__)
    primary = os.path.join(repo_dir, "venues.json")
    with open(primary, "w") as f:
        json.dump([
            {"name": "Low Tier", "confidence": "low", "instagrams": ["foo"]},
            {"name": "No IG", "tier": "HIGH"},
        ], f)

    with patch("collect_events.requests.post") as mock_post:
        out = ce.fetch_apify_instagram_posts(14)
    assert out == []
    mock_post.assert_not_called()
