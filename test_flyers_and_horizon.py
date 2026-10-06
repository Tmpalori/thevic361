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
    assert ce._fetch_image_data_url("u", get=lambda *a, **k: _resp(ctype="image/gif")) is None  # API rejects animated
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
    assert sent["timeout"] == 90


def test_flyers_capped_per_account(monkeypatch):
    posts = [{"text": f"post {i}", "displayUrl": f"https://ig/{i}.jpg"} for i in range(10)]
    _, sent = _run_extract(monkeypatch, posts)
    images = [c for c in sent["messages"][0]["content"] if c["type"] == "image_url"]
    assert len(images) == ce.FLYER_IMAGES_PER_ACCOUNT


def test_newest_posts_get_the_flyer_slots_not_pinned_ones(monkeypatch):
    monkeypatch.setattr(ce, "FLYER_IMAGES_PER_ACCOUNT", 2)
    posts = [{"text": "pinned", "displayUrl": "https://ig/pinned.jpg", "time": "2026-01-01T00:00:00"},
             {"text": "a", "displayUrl": "https://ig/a.jpg", "time": "2026-10-03T00:00:00"},
             {"text": "b", "displayUrl": "https://ig/b.jpg", "time": "2026-10-05T00:00:00"}]
    got = ce._flyers_for(posts, limit=2, fetch=lambda url: "data:" + url)
    assert got == [(2, "data:https://ig/a.jpg"), (3, "data:https://ig/b.jpg")]


def test_flyers_stop_when_the_run_is_long(monkeypatch):
    monkeypatch.setattr(ce, "_RUN_STARTED", __import__("time").time() - (ce.FLYER_TIME_BUDGET_MIN + 1) * 60)
    assert ce._flyers_for([{"text": "x", "displayUrl": "https://ig/1.jpg"}], fetch=lambda u: "data:x") == []
    monkeypatch.setattr(ce, "_RUN_STARTED", __import__("time").time())
    assert ce._flyers_for([{"text": "x", "displayUrl": "https://ig/1.jpg"}], fetch=lambda u: "data:x") == [(1, "data:x")]


def test_flyer_failure_keeps_the_text(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("bad")
    monkeypatch.setattr(ce, "_flyers_for", boom)
    _, sent = _run_extract(monkeypatch, [{"text": "Trivia Wednesday 7pm", "displayUrl": "https://ig/1.jpg"}])
    assert isinstance(sent["messages"][0]["content"], str)


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
    assert all(e.get("curated") is True for e in out)  # hand-written: the event check trusts these
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


# ─── Gap filling ────────────────────────────────────────────────────────────

def _gemini_reply(items, hosts=("facebook.com",)):
    r = MagicMock()
    r.status_code = 200
    r.json.return_value = {"candidates": [{
        "content": {"parts": [{"text": json.dumps(items)}]},
        "groundingMetadata": {"groundingChunks": [{"web": {"title": h}} for h in hosts]},
    }]}
    return r


def _page(text, url):
    r = MagicMock()
    r.status_code, r.text, r.url = 200, text, url
    return r


def _thin(n=2, name="Mercy House Trunk or Treat"):
    return {"date": d(n), "name": name, "time": "", "venue": "Mercy House", "address": "",
            "description": "Trunk or treat.", "url": "", "icons": ["family"], "_source": "local_events"}


def test_enrich_fills_blanks_from_a_cited_page_and_caches(monkeypatch, tmp_path):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    cache = tmp_path / "enrichment_cache.json"
    ev = _thin()
    posts = []

    def post(url, **kw):
        posts.append(kw["json"])
        return _gemini_reply([{"id": 1, "source": "https://facebook.com/mercyhouse/posts/1",
                               "url": "https://facebook.com/events/123", "time": "4:30 PM – 6:00 PM",
                               "address": "4409 John Stockbauer Dr.",
                               "description": "Costumes welcome; candy, games and a bounce house for kids 12 and under. Free."}])

    get = lambda u: _page("Mercy House Trunk or Treat this Friday", u)
    out = ce.enrich_thin_events([ev], cache_path=str(cache), post=post, get=get)
    assert out[0]["time"] == "4:30 PM – 6:00 PM"
    assert out[0]["address"] == "4409 John Stockbauer Dr."
    assert out[0]["url"] == "https://facebook.com/events/123"
    assert out[0]["description"].startswith("Costumes welcome")
    assert "google_search" in json.dumps(posts[0]) and "Mercy House Trunk or Treat" in json.dumps(posts[0])

    # Next run: the YAML gives the thin copy again; the cache fills it with no lookup.
    again = ce.enrich_thin_events([_thin()], cache_path=str(cache), post=lambda *a, **k: pytest.fail("looked up twice"))
    assert again[0]["time"] == "4:30 PM – 6:00 PM"


def test_enrich_never_overwrites_and_needs_a_cited_source(monkeypatch, tmp_path):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    ev = _thin()
    ev["time"] = "5:00 PM"
    ev["description"] = "A long hand-written description that is plenty to go on for the reader, really."
    reply = [{"id": 1, "source": "https://randomblog.example/post", "time": "9:00 PM", "address": "1 Fake St",
              "description": "Made up details that no cited page supports at all here."}]
    out = ce.enrich_thin_events([ev], cache_path=str(tmp_path / "c.json"),
                                post=lambda *a, **k: _gemini_reply(reply, hosts=("facebook.com",)))
    assert out[0]["time"] == "5:00 PM"
    assert out[0]["address"] == ""
    assert out[0]["description"].startswith("A long hand-written")
    cached = json.loads((tmp_path / "c.json").read_text())
    assert list(cached.values())[0]["found"] == {}


def test_enrich_rejects_bad_times_addresses_and_unrelated_links(monkeypatch, tmp_path):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    reply = [{"id": 1, "source": "https://facebook.com/x", "url": "https://facebook.com/events/999",
              "time": "evening", "address": "Downtown somewhere", "description": "short"}]
    get = lambda u: _page("A completely different page about bingo", u)
    out = ce.enrich_thin_events([_thin()], cache_path=str(tmp_path / "c.json"),
                                post=lambda *a, **k: _gemini_reply(reply), get=get)
    assert out[0]["time"] == "" and out[0]["address"] == "" and out[0]["url"] == ""
    assert out[0]["description"] == "Trunk or treat."


def test_enrich_soonest_first_capped_and_retries_misses_later(monkeypatch, tmp_path):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.setattr(ce, "ENRICH_MAX_PER_RUN", 3)
    asked = []

    def post(url, **kw):
        asked.append(kw["json"]["contents"][0]["parts"][0]["text"])
        return _gemini_reply([])

    evs = [_thin(n, f"Event {n}") for n in (9, 2, 5, 1, 30)]
    evs.append({**_thin(40, "Big Far Fest"), "big": True})
    cache = tmp_path / "c.json"
    ce.enrich_thin_events(evs, cache_path=str(cache), post=post)
    text = "".join(asked)
    assert "Event 1 on" in text and "Event 2 on" in text and "Event 5 on" in text
    assert "Event 9" not in text and "Big Far Fest" not in text
    # A miss isn't asked again within ENRICH_RETRY_DAYS.
    asked.clear()
    ce.enrich_thin_events([_thin(1, "Event 1")], cache_path=str(cache), post=post)
    assert asked == []
    later = date.today() + timedelta(days=ce.ENRICH_RETRY_DAYS + 1)
    cache.write_text(json.dumps({f"{d(10)}|event 1|mercy house": {"checked": d(0), "found": {}}}))
    ce.enrich_thin_events([_thin(10, "Event 1")], cache_path=str(cache), post=post, today=later)
    assert len(asked) == 1


def test_enrich_off_without_key_and_prunes_past(monkeypatch, tmp_path):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    cache = tmp_path / "c.json"
    cache.write_text(json.dumps({f"{d(-3)}|old": {"checked": d(-10), "found": {}},
                                 f"{d(3)}|keep me|mercy house": {"checked": d(0), "found": {"time": "7:00 PM"}}}))
    out = ce.enrich_thin_events([_thin(3, "Keep Me")], cache_path=str(cache),
                                post=lambda *a, **k: pytest.fail("no key, no lookup"))
    assert out[0]["time"] == "7:00 PM"
    assert list(json.loads(cache.read_text())) == [f"{d(3)}|keep me|mercy house"]


def test_digest_reviews_only_the_next_two_weeks(tmp_path):
    import send_digest as sd
    t = date.today()
    p = tmp_path / "c.json"
    p.write_text(json.dumps({"events": [{"date": (t + timedelta(days=n)).isoformat(), "name": f"E{n}"} for n in (1, 13, 40, 80)]}))
    assert [e["name"] for e in sd.load_candidates(str(p), all_days=True)[0]] == ["E1", "E13"]
    assert [e["name"] for e in sd.load_candidates(str(p))[0]] == ["E13"]


# ─── Review fixes ───────────────────────────────────────────────────────────

def test_a_failed_flyer_call_retries_with_text_only(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "fake")
    monkeypatch.setattr(ce, "_fetch_image_data_url", lambda url, get=None: "data:image/png;base64,AAAA")
    calls = []

    def chat(api_key, messages, max_tokens, timeout=60):
        calls.append(messages[0]["content"])
        if isinstance(messages[0]["content"], list):
            raise RuntimeError("400 invalid image")
        return json.dumps([{"date": d(2), "weekday": "", "recurring": False, "name": "Trivia", "source_post_index": 1}])

    monkeypatch.setattr(ce, "_openai_chat", chat)
    out = ce._extract_events_from_posts_via_ai("Evan's", [{"text": "Trivia Wednesday", "displayUrl": "https://ig/1.jpg"}])
    assert [e["name"] for e in out] == ["Trivia"]
    assert isinstance(calls[0], list) and isinstance(calls[1], str)
    assert "Flyer images:" not in calls[1]


def test_deadline_skips_the_rest_of_the_ai_review(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    monkeypatch.setattr(ce, "_RUN_STARTED", __import__("time").time() - (ce.COLLECT_DEADLINE_MIN + 1) * 60)
    monkeypatch.setattr(ce, "_openai_chat", lambda *a, **k: pytest.fail("reviewed past the deadline"))
    evs = [{"date": d(1), "name": "Fest", "venue": "X", "description": "raw", "icons": []}]
    assert ce.ai_review(evs) == evs


def test_ai_review_never_drops_a_hand_written_event(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    reply = [{"description": "x", "icons": [], "free": True, "keep": False},
             {"description": "y", "icons": [], "free": True, "keep": False}]
    monkeypatch.setattr(ce, "_openai_chat", lambda *a, **k: json.dumps(reply))
    evs = [{"date": d(1), "name": "Kids Eat Free", "venue": "Golden Corral", "description": "", "icons": [], "curated": True},
           {"date": d(1), "name": "Now Hiring", "venue": "X", "description": "", "icons": []}]
    assert [e["name"] for e in ce.ai_review(evs)] == ["Kids Eat Free"]


def test_organizer_accounts_are_not_places():
    venues = json.load(open(os.path.join(os.path.dirname(__file__), "venues.json")))
    ce._set_non_place_names(venues)
    for name in ("victoria film society", "victoria tnr", "scenic root", "tabree nashay entertainment"):
        assert name in ce._NON_PLACE_NAMES
