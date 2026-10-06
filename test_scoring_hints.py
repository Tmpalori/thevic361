"""The collector's hints for the site's event score (server/scoring.js):
appeal from the AI review, recurring, favorite, and how many sources listed
an event."""
import json
import os
import sys
from datetime import date, timedelta

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce


@pytest.fixture(autouse=True)
def window(monkeypatch):
    monkeypatch.setattr(ce, "_WINDOW_START", date.today())
    monkeypatch.setattr(ce, "_WINDOW_END", date.today() + timedelta(days=14))


def d(n):
    return (date.today() + timedelta(days=n)).strftime("%Y-%m-%d")


def test_ai_review_keeps_appeal_in_range(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    evs = [{"date": d(1), "name": n, "venue": "X", "description": "", "icons": []} for n in ("Fest", "Club", "Odd", "Bool")]
    reply = [{"description": "A festival.", "icons": ["music"], "free": False, "appeal": 5, "keep": True},
             {"description": "A club.", "icons": ["community"], "free": True, "appeal": 2, "keep": True},
             {"description": "Odd.", "icons": [], "free": False, "appeal": 9, "keep": True},
             {"description": "Bool.", "icons": [], "free": False, "appeal": True, "keep": True}]
    monkeypatch.setattr(ce, "_openai_chat", lambda *a, **k: json.dumps(reply))
    out = ce.ai_review(evs, batch_size=8)
    assert [e.get("appeal") for e in out] == [5, 2, None, None]
    assert "appeal: integer 1–5" in ce._AI_REVIEW_SYSTEM_PROMPT


def test_recurring_and_favorite_come_from_the_yaml(tmp_path):
    p = tmp_path / "local_events.yaml"
    p.write_text(f"""
recurring:
  - name: "Victoria Farmers' Market"
    day: {['monday','tuesday','wednesday','thursday','friday','saturday','sunday'][date.today().weekday()]}
    venue: "Market"
    favorite: true
events:
  - date: "{d(2)}"
    name: "Pumpkin Fest"
    venue: "Park"
""")
    out = ce.load_local_events(str(p))
    market = [e for e in out if e["name"].startswith("Victoria")]
    assert market and all(e["recurring"] is True and e["favorite"] is True for e in market)
    fest = [e for e in out if e["name"] == "Pumpkin Fest"][0]
    assert "recurring" not in fest and "favorite" not in fest


def test_merge_counts_sources_and_keeps_flags():
    events = [
        {"date": d(3), "name": "Fall Festival", "venue": "DeLeon Plaza", "time": "5:00 PM", "_source": "allevents"},
        {"date": d(3), "name": "Fall Festival", "venue": "DeLeon Plaza", "time": "5:00 PM", "_source": "city_calendar"},
        {"date": d(3), "name": "Trivia Night", "venue": "Froggy's Grub & Pub", "time": "7:00 PM",
         "_source": "apify_facebook_posts", "recurring": True},
    ]
    out = {e["name"]: e for e in ce.merge_events(events, venues=[])}
    assert out["Fall Festival"]["sources"] == 2
    assert out["Trivia Night"]["sources"] == 1
    assert out["Trivia Night"]["recurring"] is True
    assert "recurring" not in out["Fall Festival"]
