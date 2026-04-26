"""Tests for _is_address_like, _clean_address_like_venue, and the merge_events
trailing-generic-word dedupe.

Run: python3 -m pytest test_venue_cleanup.py -v
or:  python3 test_venue_cleanup.py
"""
import sys
import os
import unittest

# Add repo root to path so we can import collect_events
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from collect_events import (
    _is_address_like,
    _clean_address_like_venue,
    merge_events,
)


class TestIsAddressLike(unittest.TestCase):
    def test_real_address_with_comma(self):
        self.assertTrue(_is_address_like("1301 Tristan St, Victoria, TX 77901"))

    def test_real_address_with_state_zip_country(self):
        self.assertTrue(_is_address_like(
            "2002 E Mockingbird Ln, Victoria, TX, United States, Texas 77904"
        ))

    def test_real_address_pkwy(self):
        self.assertTrue(_is_address_like("7608 NE Zac Lentz Pkwy"))

    def test_real_address_dr(self):
        self.assertTrue(_is_address_like("309 E. Crestwood Dr."))

    def test_address_with_letter_after_number(self):
        self.assertTrue(_is_address_like("205B N Star Dr"))

    def test_real_venue_name_passes_through(self):
        # Real venues — should NOT be treated as address-like
        self.assertFalse(_is_address_like("Riverside Park"))
        self.assertFalse(_is_address_like("Aero Crafters"))
        self.assertFalse(_is_address_like("Theatre Victoria"))
        self.assertFalse(_is_address_like("Victoria Public Library"))
        self.assertFalse(_is_address_like("Palace Bingo"))
        self.assertFalse(_is_address_like("DeLeon Plaza"))
        self.assertFalse(_is_address_like("La Cantina Tacos & Tequila"))

    def test_venue_with_address_in_parens_not_demoted(self):
        # Real venue, with a parenthetical address — should stay as venue.
        # No leading digit, so address-like check returns False.
        self.assertFalse(_is_address_like(
            "Target Store Victoria (7608 NE Zac Lentz Pkwy, Victoria, TX)"
        ))

    def test_empty_and_whitespace(self):
        self.assertFalse(_is_address_like(""))
        self.assertFalse(_is_address_like("   "))
        self.assertFalse(_is_address_like(None))

    def test_single_word_with_number(self):
        # "5D Tavern" — number-letter prefix but a venue, not an address.
        # It has no street suffix and no comma, so it's not address-like.
        self.assertFalse(_is_address_like("5D Tavern"))


class TestCleanAddressLikeVenue(unittest.TestCase):
    def test_loko_wrestling_case(self):
        # Real bug: AllEvents stuffed the address into the venue slot.
        v, a = _clean_address_like_venue(
            "1301 Tristan St, Victoria, TX 77901",
            "1301 Tristan St",
        )
        self.assertEqual(v, "")
        self.assertEqual(a, "1301 Tristan St")

    def test_pretty_pretty_princess_case(self):
        v, a = _clean_address_like_venue(
            "2002 E Mockingbird Ln, Victoria, TX, United States, Texas 77904",
            "2002 E Mockingbird Ln",
        )
        self.assertEqual(v, "")
        self.assertEqual(a, "2002 E Mockingbird Ln")

    def test_address_in_venue_no_address_set(self):
        # Venue holds the full address, address slot is empty: promote.
        v, a = _clean_address_like_venue("1301 Tristan St, Victoria, TX 77901", "")
        self.assertEqual(v, "")
        self.assertEqual(a, "1301 Tristan St")

    def test_real_venue_passes_through_unchanged(self):
        v, a = _clean_address_like_venue("Riverside Park", "405 Memorial Drive")
        self.assertEqual(v, "Riverside Park")
        self.assertEqual(a, "405 Memorial Drive")

    def test_empty_inputs(self):
        v, a = _clean_address_like_venue("", "")
        self.assertEqual(v, "")
        self.assertEqual(a, "")

    def test_none_inputs(self):
        v, a = _clean_address_like_venue(None, None)
        self.assertEqual(v, "")
        self.assertEqual(a, "")


class TestMergeEventsDedupe(unittest.TestCase):
    """Verify the trailing-generic-word + dash-normalization dedupe."""

    def setUp(self):
        # Patch the global window so the test events are in range.
        import collect_events as ce
        from datetime import date
        ce._WINDOW_START = date(2026, 4, 20)
        ce._WINDOW_END = date(2026, 5, 14)

    def _ev(self, name, date_str="2026-04-30", venue="", address="", description=""):
        return {
            "name": name,
            "date": date_str,
            "time": "5:30 PM",
            "venue": venue,
            "address": address,
            "description": description,
            "icons": [],
            "free": False,
            "url": "",
        }

    def test_story_strolls_group_vs_series_dedup(self):
        # The exact bug from production: two sources, em-dash vs en-dash, and
        # the trailing "Group" vs "series" was the only differentiator.
        events = [
            self._ev(
                "Story Strolls \u2014 Audiobook Walking Group",
                venue="Riverside Park",
                address="405 Memorial Drive",
            ),
            self._ev(
                "Story Strolls \u2013 Audiobook Walking series",
                venue="Victoria Public Library",
                address="302 N. Main St.",
            ),
        ]
        merged = merge_events(events)
        self.assertEqual(len(merged), 1, f"Expected 1 deduped event, got {len(merged)}: {[e['name'] for e in merged]}")

    def test_short_names_not_collapsed(self):
        # "Chess Club" and "Book Club" should NOT dedupe just because they
        # both end in "club" — the name has only 2 sig words, below the
        # >3-words threshold.
        events = [
            self._ev("Chess Club", venue="Library"),
            self._ev("Book Club", venue="Library"),
        ]
        merged = merge_events(events)
        self.assertEqual(len(merged), 2)

    def test_distinct_events_not_collapsed(self):
        # Make sure we didn't make dedupe TOO aggressive.
        events = [
            self._ev("Live Music at Aero Crafters", venue="Aero Crafters"),
            self._ev("Karaoke at La Cantina", venue="La Cantina"),
        ]
        merged = merge_events(events)
        self.assertEqual(len(merged), 2)

    def test_merge_applies_address_like_cleanup(self):
        # An event whose venue is actually a street address should come out
        # with venue="" and address populated, even from sources that don't
        # individually call _clean_address_like_venue.
        events = [
            self._ev(
                "Some Event",
                venue="1301 Tristan St, Victoria, TX 77901",
                address="",
            ),
        ]
        merged = merge_events(events)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["venue"], "")
        self.assertEqual(merged[0]["address"], "1301 Tristan St")


if __name__ == "__main__":
    unittest.main(verbosity=2)
