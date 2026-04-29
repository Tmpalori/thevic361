"""Sanity tests for the shipped venues.json seed list.

Guards against future bad merges that would silently leave the IG scraper
with no usable handles (the symptom that motivated the curated seed: see
``[Apify IG Posts] No tiered venues with IG handles`` log line).
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce


def _load_venues():
    path = os.path.join(os.path.dirname(__file__), "venues.json")
    with open(path) as f:
        return json.load(f)


def test_venues_json_is_a_nonempty_list():
    venues = _load_venues()
    assert isinstance(venues, list)
    assert len(venues) >= 50


def test_every_venue_has_a_name():
    for v in _load_venues():
        assert isinstance(v.get("name"), str) and v["name"].strip()


def test_no_duplicate_venue_names():
    """Normalize aggressively — slight variants like 'The X' vs 'X' or
    smart vs straight quotes are still duplicates for our purposes."""
    def norm(s: str) -> str:
        s = s.lower().replace("’", "'")
        s = re.sub(r"[^\w\s]", " ", s)
        s = re.sub(r"\s+", " ", s).strip()
        return s.removeprefix("the ")

    seen: dict[str, str] = {}
    for v in _load_venues():
        k = norm(v["name"])
        assert k not in seen, f"Duplicate venue: {v['name']} vs {seen[k]}"
        seen[k] = v["name"]


def test_ig_capable_high_medium_count_is_meaningful():
    """At least 15 HIGH/MEDIUM venues must carry an IG username the scraper
    can actually use. This is the regression we're protecting against —
    Instagram scraping went live but had zero usable targets."""
    venues = _load_venues()
    capable = [
        v for v in venues
        if ce._venue_tier(v) in ("HIGH", "MEDIUM")
        and ce._venue_instagram_username(v) is not None
    ]
    assert len(capable) >= 15, (
        f"Only {len(capable)} HIGH/MEDIUM venues have usable IG handles; "
        "expected ≥15 to keep the IG scraper productive."
    )


def test_ig_handles_normalize_cleanly():
    """Every ``instagrams[]`` entry must round-trip through the scraper's
    own normalizer — otherwise the scraper would silently drop it."""
    for v in _load_venues():
        igs = v.get("instagrams")
        if not igs:
            continue
        assert isinstance(igs, list), v["name"]
        for handle in igs:
            assert ce._normalize_ig_username(handle) == handle, (
                f"{v['name']}: handle {handle!r} did not normalize cleanly"
            )


def test_tier_field_uses_canonical_values():
    for v in _load_venues():
        tier = v.get("tier")
        if tier is not None:
            assert tier in ("HIGH", "MEDIUM", "LOW"), (v["name"], tier)


def test_confidence_field_uses_canonical_values():
    for v in _load_venues():
        conf = v.get("confidence")
        if conf is not None:
            assert conf in ("high", "medium", "low"), (v["name"], conf)
