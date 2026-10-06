"""Flyer images in post extraction, and the longer look-ahead for hand-added
one-time events (with their big/town tags).

Network and OpenAI are stubbed.
"""
import base64
import json
import os
import sys
from datetime import date, timedelta
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce


@pytest.fixture(autouse=True)
def window(monkeypatch):
    today = date.today()
    monkeypatch.setattr(ce, "_WINDOW_START", today)
    monkeypatch.setattr(ce, "_WINDOW_END", today + timedelta(days=14))
    monkeypatch.setattr(ce, "now_central", lambda: __import__("datetime").datetime.combine(today, __import__("datetime").time(12)))
    monkeypatch.delenv("FLYER_IMAGES", raising=False)
    return today


def d(n):
    return (date.today() + timedelta(days=n)).strftime("%Y-%m-%d")


# ─── Flyer images ───────────────────────────────────────────────────────────

def test_post_image_urls_instagram_and_facebook_shapes():
    ig = {"displayUrl": "https://ig/1.jpg", "childPosts": [{"displayUrl": "https://ig/2.jpg"}],
          "images": ["https://ig/1.jpg", "https://ig/3.jpg"]}
    assert ce._post_image_urls(ig) == ["https://ig/1.jpg", "https://ig/3.jpg", "https://ig/2.jpg"]
    fb = {"media": [{"photo_image": {"uri": "https://fb/a.jpg"}, "thumbnail": "https://fb/a-small.jpg"},
                    {"thumbnail": "https://fb/video-still.jpg"}, "junk"]}
    assert ce._post_image_urls(fb) == ["https://fb/a.jpg", "https://fb/a-small.jpg", "https://fb/video-still.jpg"]
    assert ce._post_image_urls({"text": "no pictures"}) == []
    assert ce._post_image_urls(None) == []


def _resp(status=200, ctype="image/jpeg", body=b"\xff\xd8jpeg"):
    r = MagicMock()
    r.status_code = status
    r.headers = {"Content-Type": ctype}
    r.content = body
    return r


def test_fetch_image_data_url_accepts_images_only():
    ok = ce._fetch_image_data_url("u", get=lambda *a, **k: _resp())
    assert ok == "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8jpeg").decode()
    assert ce._fetch_image_data_url("u", get=lambda *a, **k: _resp(ctype="text/html")) is None
    assert ce._fetch_image_data_url("u", get=lambda *a, **k: _resp(status=403)) is None
    big = b"x" * (ce.FLYER_IMAGE_MAX_BYTES + 1)
    assert ce._fetch_image_data_url("u", get=lambda *a, **k: _resp(body=big)) is None

    def boom(*a, **k):
        raise TimeoutError()
    assert ce._fetch_image_data_url("u", get=boom) is None


def _run_extract(monkeypatch, posts, fetched="data:image/png;base64,AAAA"):
    monkeypatch.setenv("OPENAI_API_KEY", "fake")
    monkeypatch.setattr(ce, "_fetch_image_data_url", lambda url, get=None: fetched)
    sent = {}

    def fake_chat(api_key, messages, max_tokens, timeout=60):
        sent["messages"] = messages
        sent["timeout"] = timeout
        return json.dumps([{"date": d(3), "weekday": "", "recurring": False, "name": "Henry Emiliano",
                            "time": "6:00 PM", "source_post_index": 1}])

    monkeypatch.setattr(ce, "_openai_chat", fake_chat)
    out = ce._extract_events_from_posts_via_ai("Evan's", posts)
    return out, sent


def test_flyer_images_go_to_the_model_with_their_post_number(monkeypatch):
    posts = [
        {"text": "", "media": [{"photo_image": {"uri": "https://fb/lineup.jpg"}}], "time": d(-2)},  # flyer, no caption
        {"text": "Pizza special today", "time": d(-1)},
    ]
    out, sent = _run_extract(monkeypatch, posts)
    assert out and out[0]["name"] == "Henry Emiliano"
    content = sent["messages"][0]["content"]
    assert isinstance(content, list)
    text = content[0]["text"]
    assert "[1] (posted" in text and "(no caption) [flyer image attached]" in text
    assert "Flyer images:" in text
    assert content[1] == {"type": "text", "text": "Flyer for post [1]:"}
    assert content[2]["type"] == "image_url"
    assert content[2]["image_url"]["url"].startswith("data:image/png;base64,")
    assert sent["timeout"] == 120


def test_flyers_capped_per_account(monkeypatch):
    posts = [{"text": f"post {i}", "displayUrl": f"https://ig/{i}.jpg"} for i in range(10)]
    _, sent = _run_extract(monkeypatch, posts)
    images = [c for c in sent["messages"][0]["content"] if c["type"] == "image_url"]
    assert len(images) == ce.FLYER_IMAGES_PER_ACCOUNT


def test_text_only_posts_unchanged(monkeypatch):
    _, sent = _run_extract(monkeypatch, [{"text": "Trivia Wednesday 7pm"}])
    assert isinstance(sent["messages"][0]["content"], str)
    assert "Flyer images:" not in sent["messages"][0]["content"]
    assert sent["timeout"] == 60


def test_flyer_images_can_be_turned_off(monkeypatch):
    monkeypatch.setenv("FLYER_IMAGES", "0")
    posts = [{"text": "Lineup!", "displayUrl": "https://ig/1.jpg"},
             {"text": "", "displayUrl": "https://ig/2.jpg"}]  # image-only: nothing to read
    _, sent = _run_extract(monkeypatch, posts)
    content = sent["messages"][0]["content"]
    assert isinstance(content, str) and "[2]" not in content


def test_unfetchable_flyer_falls_back_to_text(monkeypatch):
    _, sent = _run_extract(monkeypatch, [{"text": "Lineup!", "displayUrl": "https://ig/1.jpg"}], fetched=None)
    assert isinstance(sent["messages"][0]["content"], str)


# ─── Longer look-ahead for hand-added events ────────────────────────────────

def _yaml(tmp_path, text):
    p = tmp_path / "local_events.yaml"
    p.write_text(text)
    return str(p)


def test_one_time_events_reach_the_local_horizon_with_tags(tmp_path):
    path = _yaml(tmp_path, f"""
recurring:
  - name: "Weekly Trivia"
    day: monday
    time: "7:00 PM"
    venue: "Somewhere"
    big: true
events:
  - date: "{d(60)}"
    name: "Pickle Festival"
    venue: "Community Center"
    big: true
  - date: "{d(70)}"
    name: "Turkeyfest"
    venue: "Downtown Cuero"
    town: "Cuero"
  - date: "{d(ce.LOCAL_HORIZON_DAYS + 5)}"
    name: "Too Far"
    venue: "X"
""")
    out = ce.load_local_events(path)
    by_name = {}
    for e in out:
        by_name.setdefault(e["name"], []).append(e)
    assert by_name["Pickle Festival"][0]["big"] is True
    assert "town" not in by_name["Pickle Festival"][0]
    assert by_name["Turkeyfest"][0]["town"] == "Cuero"
    assert "big" not in by_name["Turkeyfest"][0]
    assert "Too Far" not in by_name
    # Recurring entries stay inside the 14-day window.
    assert max(e["date"] for e in by_name["Weekly Trivia"]) <= d(14)


def test_merge_keeps_far_local_events_but_not_far_scraped_ones():
    events = [
        {"date": d(45), "name": "Pickle Festival", "venue": "Community Center", "big": True,
         "_source": "local_events"},
        {"date": d(45), "name": "Some Scraped Thing", "venue": "Moonshine Drinkery", "_source": "allevents"},
        {"date": d(50), "name": "Boo-Fest", "venue": "Downtown Port Lavaca", "town": "Port Lavaca",
         "_source": "local_events"},
    ]
    out = ce.merge_events(events, venues=[])
    names = {e["name"]: e for e in out}
    assert "Some Scraped Thing" not in names
    assert names["Pickle Festival"]["big"] is True
    assert names["Boo-Fest"]["town"] == "Port Lavaca"


def test_tags_survive_a_better_ranked_scraped_copy():
    local = {"date": d(3), "name": "Merry on Main", "venue": "Downtown", "big": True, "town": "Victoria",
             "_source": "local_events"}
    scraped = {"date": d(3), "name": "Merry on Main", "venue": "Downtown", "time": "6:00 PM",
               "description": "Holiday fun", "url": "https://x", "_source": "city_calendar"}
    merged = ce._merge_pair(local, scraped)
    assert merged["big"] is True and merged["town"] == "Victoria"
