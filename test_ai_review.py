"""Offline tests for ai_review sanitization & fallback paths.

These tests don't hit the OpenAI API \u2014 they monkey-patch _ai_review_batch
to return synthetic responses so we can verify:
  1. Description gets clamped + emoji-stripped
  2. Icons are validated, deduped, and capped at 3
  3. free flag stays in sync with the `free` icon
  4. Bad batches preserve original event values
  5. Missing OPENAI_API_KEY skips cleanly
  6. The OpenAI request payload is shaped for current chat models
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

        with patch.dict(os.environ, {"OPENAI_API_KEY": "x"}):
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

        with patch.dict(os.environ, {"OPENAI_API_KEY": "x"}):
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

        with patch.dict(os.environ, {"OPENAI_API_KEY": "x"}):
            with patch.object(ce, "_ai_review_batch", side_effect=fake_batch):
                result = ce.ai_review(events)

        self.assertEqual(result[0]["description"], original_desc)

    def test_long_description_clamped(self):
        events = [dict(SAMPLE_EVENTS[0])]
        long = "A" * 400

        def fake_batch(api_key, batch):
            return [{"description": long, "icons": ["community"], "free": False}]

        with patch.dict(os.environ, {"OPENAI_API_KEY": "x"}):
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

        with patch.dict(os.environ, {"OPENAI_API_KEY": "x"}):
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

        with patch.dict(os.environ, {"OPENAI_API_KEY": "x"}):
            with patch.object(ce, "_ai_review_batch", side_effect=fake_batch):
                ce.ai_review(events, batch_size=5)

        self.assertEqual(call_count["n"], 4)


class _FakeResp:
    def __init__(self, content):
        self._content = content
    def raise_for_status(self):
        pass
    def json(self):
        return {"choices": [{"message": {"content": self._content}}]}


class TestOpenAIChat(unittest.TestCase):

    def _capture(self, env, content="[]"):
        calls = []

        def fake_post(url, headers=None, json=None, timeout=None):
            calls.append({"url": url, "headers": headers, "json": json})
            return _FakeResp(content)

        with patch.dict(os.environ, env, clear=True):
            with patch.object(ce.requests, "post", side_effect=fake_post):
                out = ce._openai_chat("sk-test", [{"role": "user", "content": "hi"}], max_tokens=100)
        return out, calls[0]

    def test_default_model_and_payload(self):
        out, call = self._capture({}, content="  [1]  ")
        self.assertEqual(out, "[1]")
        self.assertEqual(call["url"], "https://api.openai.com/v1/chat/completions")
        self.assertEqual(call["headers"]["Authorization"], "Bearer sk-test")
        body = call["json"]
        self.assertEqual(body["model"], ce._OPENAI_DEFAULT_MODEL)
        self.assertEqual(body["max_completion_tokens"], 100)
        self.assertEqual(body["reasoning_effort"], "low")
        # gpt-5-family models reject non-default temperature and max_tokens.
        self.assertNotIn("temperature", body)
        self.assertNotIn("max_tokens", body)

    def test_model_override_without_reasoning(self):
        _, call = self._capture({"OPENAI_MODEL": "gpt-4.1-mini"})
        self.assertEqual(call["json"]["model"], "gpt-4.1-mini")
        self.assertNotIn("reasoning_effort", call["json"])

    def test_null_content_returns_empty_string(self):
        out, _ = self._capture({}, content=None)
        self.assertEqual(out, "")

    def test_review_batch_routes_through_openai(self):
        events = [dict(SAMPLE_EVENTS[0])]
        reply = '[{"description": "Songs for babies.", "icons": ["family"], "free": true}]'
        seen = []

        def fake_post(url, headers=None, json=None, timeout=None):
            seen.append(url)
            return _FakeResp(reply)

        with patch.dict(os.environ, {"OPENAI_API_KEY": "x"}, clear=True):
            with patch.object(ce.requests, "post", side_effect=fake_post):
                result = ce.ai_review(events)

        self.assertEqual(seen, [ce.OPENAI_CHAT_URL])
        self.assertEqual(result[0]["description"], "Songs for babies.")
        self.assertTrue(result[0]["free"])


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestAiKeep(unittest.TestCase):
    def test_keep_false_drops_event_and_missing_keep_keeps_it(self):
        events = [dict(e) for e in SAMPLE_EVENTS]

        def fake_batch(api_key, batch):
            return [{"keep": True}, {"keep": False}, {}][:len(batch)]

        with patch.dict(os.environ, {"OPENAI_API_KEY": "x"}):
            with patch.object(ce, "_ai_review_batch", side_effect=fake_batch):
                result = ce.ai_review(events, batch_size=8)

        self.assertEqual([e["name"] for e in result], ["Baby Hour: Pages to Play", "Victoria Farmers' Market"])
        self.assertTrue(all("_ai_drop" not in e for e in result))


class TestAiReviewKeepsHandEnteredFacts(unittest.TestCase):
    """local_events.yaml / Google Sheet events: the owner's price and words win."""

    def _run(self, events, answers):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "x"}):
            with patch.object(ce, "_ai_review_batch", side_effect=lambda k, b: answers[:len(b)]):
                return ce.ai_review(events, batch_size=8)

    def test_never_flips_free_on_a_curated_event(self):
        # Cuero Turkeyfest is `free: false` in the YAML; the model said free.
        turkey = {"date": "2026-10-09", "name": "Cuero Turkeyfest", "venue": "Downtown Cuero",
                  "description": "Details on the Turkeyfest page.", "icons": ["family"], "free": False,
                  "curated": True, "_source": "local_events"}
        out = self._run([turkey], [{"description": "Plan for parades and live entertainment.",
                                    "icons": ["family", "free", "music"], "free": True, "appeal": 5}])
        self.assertIs(out[0]["free"], False)
        self.assertNotIn("free", out[0]["icons"])
        # The owner's description stays; the invented details don't appear.
        self.assertEqual(out[0]["description"], "Details on the Turkeyfest page.")
        # Icons and appeal are still the model's to set.
        self.assertEqual(out[0]["icons"], ["family", "music"])
        self.assertEqual(out[0]["appeal"], 5)

    def test_never_demotes_a_curated_free_event(self):
        ev = {"date": "2026-10-10", "name": "Trunk or Treat", "venue": "Mercy House",
              "description": "Trunk or treat at Mercy House.", "icons": ["family"], "free": True, "curated": True}
        out = self._run([ev], [{"icons": ["family", "community"], "free": False}])
        self.assertIs(out[0]["free"], True)
        self.assertIn("free", out[0]["icons"])

    def test_merged_copy_with_a_hand_source_is_protected(self):
        ev = {"date": "2026-10-10", "name": "Fall Fest", "venue": "Riverside Park", "description": "A fall festival in the park.",
              "icons": [], "free": False, "_source": "allevents", "_sources": ["allevents", "google_sheet"]}
        out = self._run([ev], [{"description": "Free fun for all!", "free": True}])
        self.assertIs(out[0]["free"], False)
        self.assertEqual(out[0]["description"], "A fall festival in the park.")

    def test_writes_a_curated_description_only_when_empty_or_nearly(self):
        empty = {"date": "2026-10-10", "name": "Pumpkin Fest", "venue": "Farm", "description": "", "icons": [], "free": False, "curated": True}
        tiny = {"date": "2026-10-10", "name": "Fall Fest", "venue": "Farm", "description": "Fall fest.", "icons": [], "free": False, "curated": True}
        short = {"date": "2026-10-10", "name": "Trick or Treat", "venue": "Mall", "description": "Trick or treating at the mall.",
                 "icons": [], "free": False, "curated": True}
        out = self._run([empty, tiny, short], [{"description": "Pumpkins and hayrides."},
                                               {"description": "Games and food trucks."},
                                               {"description": "Costumed kids visit every store."}])
        self.assertEqual([e["description"] for e in out],
                         ["Pumpkins and hayrides.", "Games and food trucks.", "Trick or treating at the mall."])

    def test_scraped_events_are_still_reviewed(self):
        ev = {"date": "2026-10-10", "name": "Fall Fest", "venue": "Park", "description": "Long scraped text " * 5,
              "icons": [], "free": False, "_source": "allevents"}
        out = self._run([ev], [{"description": "A tidy line.", "free": True, "icons": ["family"]}])
        self.assertIs(out[0]["free"], True)
        self.assertEqual(out[0]["description"], "A tidy line.")
