"""Offline tests for the venue-grounded Sonar query builder (PR #18).

The old fetch_perplexity_events ran 10 generic queries — four of which
(``q1 aero``, ``q6 trivia``, ``q7 music``, ``q10 food``) were silently
returning zero events because Sonar had nothing concrete to ground on. These
tests pin the new design: 8 buckets seeded from ``venues.json`` that name
real HIGH-tier venues, with a sane category-only fallback when venues.json
is missing or sparse.
"""
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce


DATE_RANGE = "April 26 through May 04, 2026"


def _venue(name, category, confidence="medium", event_potential="", **extra):
    v = {
        "name": name,
        "category": category,
        "confidence": confidence,
        "event_potential": event_potential,
        "facebook_page": f"https://facebook.com/{name.lower().replace(' ', '')}",
    }
    v.update(extra)
    return v


# Stubbed venues.json — small but covers every bucket with a HIGH match plus
# some MEDIUM/LOW noise the builder should deprioritize.
STUB_VENUES = [
    _venue("Aero Crafters", "Bar / Live Music", "high",
           "Live music Fri/Sat, VAMA Open Mic Wed"),
    _venue("Moonshine Drinkery", "Bar / Live Music", "high", "Live music"),
    _venue("The Hideaway Bar", "Bar / Live Music", "high",
           "Live music, trivia nights"),
    _venue("Lone Star Tavern", "Bar", "high", "Local bar events"),
    _venue("Shooters Bar", "Bar", "high", "Bar events"),
    _venue("Theatre Victoria", "Theatre", "high", "Plays, musicals"),
    _venue("The Nave Museum", "Museum / Arts", "high", "Art exhibits"),
    _venue("The Playback Venue & Arcade", "Entertainment", "high",
           "Arcade events, gaming nights, birthday parties"),
    # Restaurants — no HIGH ones in the real seed; verify we still pick MEDIUM.
    _venue("Froggy's Grub & Pub", "Restaurant / Bar", "medium",
           "Daily specials, food truck nights"),
    _venue("Mi Casita Bar & Grill", "Restaurant / Bar", "medium"),
    # Noise: should not get pulled into any bucket on its own.
    _venue("Stir Soda Shoppe", "Soda Shop", "low"),
    _venue("Gulf Breeze Winery", "Winery", "medium"),
]


class TestQueryBuilderShape(unittest.TestCase):
    """The contract: 8 buckets, in deterministic order, with non-empty text."""

    def test_eight_buckets(self):
        queries = ce._build_sonar_queries(STUB_VENUES, DATE_RANGE)
        self.assertEqual(len(queries), 8)

    def test_each_bucket_has_label_and_text(self):
        queries = ce._build_sonar_queries(STUB_VENUES, DATE_RANGE)
        for label, text in queries:
            self.assertTrue(label, "label must be non-empty")
            self.assertTrue(text.strip(), f"query text empty for bucket {label}")
            # Date range is always woven in so Sonar gets a concrete window.
            self.assertIn(DATE_RANGE, text)

    def test_bucket_order_matches_brief(self):
        # PR #18 brief lists q1..q8 in this order; we anchor it so reorderings
        # would break the test instead of silently shipping.
        queries = ce._build_sonar_queries(STUB_VENUES, DATE_RANGE)
        labels = [label for label, _ in queries]
        self.assertEqual(labels[0], "music (HIGH venues)")
        self.assertEqual(labels[1], "bar weekly (HIGH bars)")
        self.assertEqual(labels[2], "family (HIGH family venues)")
        self.assertEqual(labels[3], "restaurant specials (HIGH restaurants)")
        self.assertEqual(labels[4], "cultural (HIGH cultural venues)")
        self.assertEqual(labels[5], "community / civic")
        self.assertEqual(labels[6], "markets / fairs / festivals")
        self.assertEqual(labels[7], "eventbrite / allevents catch-all")


class TestBucketsUseHighVenues(unittest.TestCase):
    """The whole point of the rebuild: prompts must name HIGH-tier venues."""

    def setUp(self):
        self.queries = dict(ce._build_sonar_queries(STUB_VENUES, DATE_RANGE))

    def test_music_bucket_names_high_music_venues(self):
        text = self.queries["music (HIGH venues)"]
        self.assertIn("Aero Crafters", text)
        self.assertIn("Moonshine Drinkery", text)
        self.assertIn("The Hideaway Bar", text)

    def test_bar_bucket_names_high_bars(self):
        text = self.queries["bar weekly (HIGH bars)"]
        # Pure-bar HIGH venues should make it in.
        self.assertIn("Lone Star Tavern", text)
        self.assertIn("Shooters Bar", text)
        # Music/bar overlap is fine — Aero is also a HIGH bar.
        self.assertIn("Aero Crafters", text)

    def test_family_bucket_names_family_venues(self):
        text = self.queries["family (HIGH family venues)"]
        self.assertIn("The Playback Venue & Arcade", text)
        self.assertIn("Theatre Victoria", text)
        self.assertIn("The Nave Museum", text)

    def test_restaurant_bucket_names_restaurants(self):
        text = self.queries["restaurant specials (HIGH restaurants)"]
        # No HIGH restaurants exist today; we accept MEDIUM rather than
        # leaving the bucket empty (a list is still better than generic).
        self.assertIn("Froggy's Grub & Pub", text)

    def test_cultural_bucket_names_cultural_venues(self):
        text = self.queries["cultural (HIGH cultural venues)"]
        self.assertIn("Theatre Victoria", text)
        self.assertIn("The Nave Museum", text)

    def test_high_confidence_venues_preferred_over_low(self):
        # Stir Soda Shoppe is a LOW noise venue; it must not crowd out HIGH
        # venues in any bucket.
        for label, text in self.queries.items():
            self.assertNotIn(
                "Stir Soda Shoppe", text,
                f"low-tier venue leaked into bucket {label}",
            )


class TestVenueCap(unittest.TestCase):
    """Prompts must stay concise even with 50+ venues."""

    def test_each_bucket_caps_named_venues(self):
        # Build a flood of HIGH music venues; cap should kick in at 6.
        flood = [
            _venue(f"Music Venue {i}", "Bar / Live Music", "high")
            for i in range(20)
        ]
        queries = dict(ce._build_sonar_queries(flood, DATE_RANGE))
        text = queries["music (HIGH venues)"]
        named = sum(1 for i in range(20) if f"Music Venue {i}" in text)
        self.assertLessEqual(named, ce._SONAR_VENUES_PER_BUCKET)
        self.assertGreaterEqual(named, 1)


class TestFallbacks(unittest.TestCase):
    """venues.json missing or sparse — collector still produces 8 buckets."""

    def test_empty_venues_falls_back_to_category_phrasing(self):
        queries = ce._build_sonar_queries([], DATE_RANGE)
        self.assertEqual(len(queries), 8)
        for _, text in queries:
            self.assertTrue(text.strip())
            self.assertIn(DATE_RANGE, text)

    def test_no_high_venues_in_category_drops_to_fallback(self):
        # Only LOW restaurants — but cultural HIGH-required bucket should fall
        # back to the category-only phrasing rather than naming LOW venues.
        venues = [_venue("Some Low Gallery", "Arts", "low")]
        queries = dict(ce._build_sonar_queries(venues, DATE_RANGE))
        cultural = queries["cultural (HIGH cultural venues)"]
        self.assertNotIn("Some Low Gallery", cultural)
        # Fallback phrasing is still well-formed.
        self.assertIn("Victoria, TX", cultural)
        self.assertIn(DATE_RANGE, cultural)


class TestParserCompatibility(unittest.TestCase):
    """The shared JSON instruction is appended downstream; query text must not
    pre-empt or fight the parser's expected schema."""

    def test_query_text_does_not_preempt_json_instruction(self):
        # The prompt the builder emits should NOT itself contain "JSON" or a
        # bracketed array — that's added by fetch_perplexity_events. Otherwise
        # Sonar gets contradictory instructions.
        for label, text in ce._build_sonar_queries(STUB_VENUES, DATE_RANGE):
            self.assertNotIn("```", text, f"bucket {label} pre-injects code fence")
            self.assertNotIn("JSON array", text, f"bucket {label} pre-injects schema")

    def test_parser_still_handles_query_responses(self):
        # The parser is unchanged, but smoke-test that a typical Sonar reply
        # to one of our buckets parses cleanly. This guards the contract.
        sample = (
            '[{"date":"2026-04-29","name":"Jake Castillo Live",'
            '"time":"7:00 PM","venue":"Aero Crafters",'
            '"description":"Country acoustic","free":false,'
            '"url":"https://facebook.com/aerocrafters"}]'
        )
        out = ce._parse_sonar_json(sample)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["venue"], "Aero Crafters")


class TestOldQueriesAbsent(unittest.TestCase):
    """Pin the four silent-failing queries from the brief — they must not
    survive the rebuild verbatim."""

    OLD_PHRASES_THAT_MUST_BE_GONE = [
        # q1: aerocrafters.pub URL hard-coded
        "aerocrafters.pub",
        # q5 fitness/sports — dropped entirely from the new design
        "5K runs",
        "CrossFit competitions",
        "Victoria Parks & Rec",
        # q9 specifies Victoria Fine Arts Center / Museum of the Coastal Bend —
        # we replaced that with venues.json grounding
        "Museum of the Coastal Bend",
        # q4 community: hard-coded victoriaadvocate.com URL
        "victoriaadvocate.com",
    ]

    def test_old_generic_phrasing_absent(self):
        joined = "\n".join(text for _, text in
                           ce._build_sonar_queries(STUB_VENUES, DATE_RANGE))
        for phrase in self.OLD_PHRASES_THAT_MUST_BE_GONE:
            self.assertNotIn(
                phrase, joined,
                f"old generic phrase '{phrase}' leaked into the new prompt set",
            )


class TestFetchPerplexityIntegration(unittest.TestCase):
    """End-to-end of fetch_perplexity_events with the network mocked.

    Verifies the new builder is actually wired into the fetch path and that
    the existing parsing/normalization still produces in-window event dicts.
    """

    def test_fetch_runs_eight_queries_against_mocked_sonar(self):
        # Mock Perplexity to return one event per query.
        captured_prompts = []

        class _Resp:
            status_code = 200
            def raise_for_status(self): pass
            def json(self):
                return {"choices": [{"message": {"content":
                    '[{"date":"' + ce._WINDOW_START.strftime("%Y-%m-%d") +
                    '","name":"Smoke Test Event","time":"7 PM","venue":"X",'
                    '"description":"d","free":true,"url":""}]'
                }}]}

        def fake_post(url, headers=None, json=None, timeout=None):
            captured_prompts.append(json["messages"][0]["content"])
            return _Resp()

        with patch.dict(os.environ, {"PERPLEXITY_API_KEY": "stub"}):
            with patch.object(ce.requests, "post", side_effect=fake_post):
                events = ce.fetch_perplexity_events()

        # 8 queries fired, 8 events back (one per mocked response).
        self.assertEqual(len(captured_prompts), 8)
        self.assertEqual(len(events), 8)
        # Each query should still carry the JSON instruction the parser expects.
        for prompt in captured_prompts:
            self.assertIn("Return ONLY a valid JSON array", prompt)


if __name__ == "__main__":
    unittest.main(verbosity=2)
