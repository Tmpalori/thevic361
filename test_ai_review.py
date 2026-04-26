"""Offline tests for ai_review sanitization & fallback paths.

These tests don't hit the Perplexity API \u2014 they monkey-patch _ai_review_batch
to return synthetic responses so we can verify:
  1. Description gets clamped + emoji-stripped
  2. Icons are validated, deduped, and capped at 3
  3. free flag stays in sync with the `free` icon
  4. Bad batches preserve original event values
  5. Missing PERPLEXITY_API_KEY skips cleanly
"""
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce


SAMPLE_EVENTS = [
    {
        "date": "2026-04-27",
        "name": "Baby Hour: Pages to Play",
        "time": "10:00AM \u2013 11:00AM",
        "venue": "Victoria Public Library",
        "address": "302 N. Main St.",
        "description": "Baby Time \ud83d\udc76\ud83c\udf7c Songs, books, and play for our littlest learners! \u2728\ud83d\udcd6",
        "icons": ["community"],
        "free": False,
        "url": "",
    },
    {
        "date": "2026-04-27",
        "name": "VAMA Rock & Blues Open Mic",
        "time": "7:00 PM \u2013 10:00 PM",
        "venue": "Aero Crafters",
        "address": "309 N. Main St.",
        "description": "",
        "icons": [],
        "free": False,
        "url": "",
    },
    {
        "date": "2026-04-28",
        "name": "Victoria Farmers' Market",
        "time": "9:00 AM \u2013 1:00 PM",
        "venue": "Victoria Farmers Market",
        "address": "2805 N. Navarro St.",
        "description": "Fresh local produce, pastured meats, honey, baked goods, and more from Victoria's best vendors.",
        "icons": ["food", "community", "shopping", "outdoors"],  # 4, should be capped
        "free": True,
        "url": "",
    },
]


class TestStripEmojis(unittest.TestCase):
    def test_removes_emoji(self):
        self.assertEqual(ce._strip_emojis("Hello \U0001F44B world \U0001F389"), "Hello  world")

    def test_handles_empty(self):
        self.assertEqual(ce._strip_emojis(""), "")
        self.assertIsNone(ce._strip_emojis(None))


class TestAIReviewSanitization(unittest.TestCase):

    def test_no_key_skips_cleanly(self):
        events = [dict(e) for e in SAMPLE_EVENTS]
        with patch.dict(os.environ, {}, clear=True):
            result = ce.ai_review(events)
        # Original events are returned untouched
        self.assertEqual(result[0]["description"], SAMPLE_EVENTS[0]["description"])

    def test_polishes_when_ai_responds_well(self):
        events = [dict(e) for e in SAMPLE_EVENTS]

        def fake_batch(api_key, batch):
            return [
                {
                    "description": "Songs, books, and play designed for babies and toddlers learning early literacy.",
                    "icons": ["family", "community", "free"],
                    "free": True,
                },
                {
                    "description": "Bring an instrument or just listen \u2014 weekly open mic night for local musicians of all skill levels.",
                    "icons": ["music", "community"],
                    "free": True,
                },
                {
                    "description": "Local farmers and makers selling produce, meats, honey, and baked goods every Saturday morning.",
                    "icons": ["food", "shopping", "outdoors"],
                    "free": True,
                },
            ][:len(batch)]

        with patch.dict(os.environ, {"PERPLEXITY_API_KEY": "x"}):
            with patch.object(ce, "_ai_review_batch", side_effect=fake_batch):
                result = ce.ai_review(events, batch_size=8)

        # Description rewritten, no emojis
        self.assertNotIn("\ud83d\udc76", result[0]["description"])
        self.assertNotIn("\u2728", result[0]["description"])
        self.assertTrue(result[0]["description"].startswith("Songs"))

        # Free flag set + free icon present (within cap)
        self.assertTrue(result[0]["free"])
        self.assertIn("free", result[0]["icons"])
        self.assertLessEqual(len(result[0]["icons"]), 3)

        # Open mic gets music icon (was empty before)
        self.assertIn("music", result[1]["icons"])

        # Farmers market: AI returned 3 icons; free wasn't included by AI but
        # free=True so we add it. But icons already has 3 \u2014 cap stays at 3.
        self.assertEqual(len(result[2]["icons"]), 3)

    def test_invalid_icons_filtered(self):
        events = [dict(SAMPLE_EVENTS[0])]

        def fake_batch(api_key, batch):
            return [{
                "description": "Clean sentence.",
                "icons": ["family", "INVALID_ICON", "community", "music", "food", "drinks"],
                "free": False,
            }]

        with patch.dict(os.environ, {"PERPLEXITY_API_KEY": "x"}):
            with patch.object(ce, "_ai_review_batch", side_effect=fake_batch):
                result = ce.ai_review(events)

        icons = result[0]["icons"]
        self.assertNotIn("INVALID_ICON", icons)
        self.assertLessEqual(len(icons), 3)
        self.assertEqual(icons[0], "family")  # ranking preserved

    def test_failed_batch_keeps_originals(self):
        events = [dict(e) for e in SAMPLE_EVENTS]
        original_desc = events[0]["description"]

        def fake_batch(api_key, batch):
            return None  # simulate parse failure

        with patch.dict(os.environ, {"PERPLEXITY_API_KEY": "x"}):
            with patch.object(ce, "_ai_review_batch", side_effect=fake_batch):
                result = ce.ai_review(events)

        self.assertEqual(result[0]["description"], original_desc)

    def test_long_description_clamped(self):
        events = [dict(SAMPLE_EVENTS[0])]
        long = "A" * 400

        def fake_batch(api_key, batch):
            return [{"description": long, "icons": ["community"], "free": False}]

        with patch.dict(os.environ, {"PERPLEXITY_API_KEY": "x"}):
            with patch.object(ce, "_ai_review_batch", side_effect=fake_batch):
                result = ce.ai_review(events)

        self.assertLessEqual(len(result[0]["description"]), 200)
        self.assertTrue(result[0]["description"].endswith("\u2026"))

    def test_free_demoted_removes_free_icon(self):
        events = [dict(e) for e in SAMPLE_EVENTS[2:3]]  # farmers market, free=True
        events[0]["icons"] = ["food", "free"]

        def fake_batch(api_key, batch):
            return [{
                "description": "Local makers selling goods.",
                "icons": ["food", "shopping"],
                "free": False,
            }]

        with patch.dict(os.environ, {"PERPLEXITY_API_KEY": "x"}):
            with patch.object(ce, "_ai_review_batch", side_effect=fake_batch):
                result = ce.ai_review(events)

        self.assertFalse(result[0]["free"])
        self.assertNotIn("free", result[0]["icons"])

    def test_batching_processes_all_events(self):
        # 17 events with batch_size=5 \u2192 4 batches (5,5,5,2)
        events = [dict(SAMPLE_EVENTS[0]) for _ in range(17)]

        call_count = {"n": 0}

        def fake_batch(api_key, batch):
            call_count["n"] += 1
            return [{"description": f"Polished {i}", "icons": ["community"], "free": False}
                    for i in range(len(batch))]

        with patch.dict(os.environ, {"PERPLEXITY_API_KEY": "x"}):
            with patch.object(ce, "_ai_review_batch", side_effect=fake_batch):
                ce.ai_review(events, batch_size=5)

        self.assertEqual(call_count["n"], 4)


if __name__ == "__main__":
    unittest.main(verbosity=2)
