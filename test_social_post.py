"""Auto-posting the social kit (scripts/social_post.py). Graph API calls are
faked with a recording session; nothing reaches Meta."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
import social_post as sp


class FakeResp:
    def __init__(self, body, status=200):
        self._body, self.status_code, self.ok, self.text = body, status, status < 400, json.dumps(body)

    def json(self):
        return self._body


class FakeSession:
    """Answers Graph calls in order of a simple router and records them."""

    def __init__(self, fail=None, page_token=None, raise_on=None):
        self.calls, self.n, self.fail, self.page_token = [], 0, fail or "", page_token
        self.raise_on = raise_on or {}  # path suffix -> exception to raise

    def request(self, method, url, data=None, params=None, timeout=None, headers=None):
        sent = dict(params or data or {})
        auth = (headers or {}).get("Authorization", "")
        if auth.startswith("Bearer "):  # GETs carry the token in a header
            sent["access_token"] = auth[len("Bearer "):]
        self.calls.append((method, url.split("/", 4)[-1], sent))
        path = url.split("/", 4)[-1]
        for suffix, exc in self.raise_on.items():
            if path.endswith(suffix):
                raise exc
        if method == "GET" and sent.get("fields") == "access_token":  # Page token lookup
            return FakeResp({"access_token": self.page_token, "id": path} if self.page_token else {"id": path})
        self.n += 1
        if self.fail and self.fail in path:
            return FakeResp({"error": {"message": "nope"}}, 400)
        if path.endswith("/photos") or path.endswith("/media"):
            return FakeResp({"id": f"id{self.n}"})
        if path.endswith("/feed") or path.endswith("/media_publish"):
            return FakeResp({"id": "post1"})
        if method == "GET":
            return FakeResp({"status_code": "FINISHED"})
        return FakeResp({})


def write_kit(tmp_path, events=3, slides=12):
    names = [f"weekend-{i}.png" for i in range(1, slides + 1)]
    (tmp_path / "kit.json").write_text(json.dumps({"generated_for": "2026-10-08", "kits": {
        "weekend": {"slides": names, "events": events,
                    "captions": {"facebook": "FB caption", "instagram": "IG caption"}},
        "week": {"slides": names[:3], "events": 0, "captions": {"facebook": "", "instagram": ""}}}}))
    return tmp_path


def test_pick_slides_keeps_cover_and_cta():
    s = [f"s{i}" for i in range(1, 13)]
    picked = sp.pick_slides(s)
    assert len(picked) == 10 and picked[0] == "s1" and picked[-1] == "s12"
    assert sp.pick_slides(["a", "b"]) == ["a", "b"]


def test_skips_without_credentials(tmp_path, monkeypatch):
    monkeypatch.delenv("META_PAGE_ID", raising=False)
    monkeypatch.delenv("META_PAGE_TOKEN", raising=False)
    sess = FakeSession()
    assert sp.main(["--kind", "weekend", "--kit-dir", str(write_kit(tmp_path)), "--no-wait"], session=sess) == 0
    assert sess.calls == []


def test_skips_empty_kit(tmp_path, monkeypatch):
    monkeypatch.setenv("META_PAGE_ID", "p")
    monkeypatch.setenv("META_PAGE_TOKEN", "t")
    sess = FakeSession()
    assert sp.main(["--kind", "week", "--kit-dir", str(write_kit(tmp_path)), "--no-wait"], session=sess) == 0
    assert sess.calls == []


def test_posts_facebook_album_and_instagram_carousel(tmp_path, monkeypatch):
    monkeypatch.setenv("META_PAGE_ID", "page9")
    monkeypatch.setenv("META_PAGE_TOKEN", "tok")
    monkeypatch.setenv("IG_USER_ID", "ig7")
    monkeypatch.setattr(sp.time, "sleep", lambda s: None)
    sess = FakeSession()
    assert sp.main(["--kind", "weekend", "--kit-dir", str(write_kit(tmp_path)), "--no-wait"], session=sess) == 0

    photos = [c for c in sess.calls if c[1] == "page9/photos"]
    assert len(photos) == 10 and all(c[2]["published"] == "false" for c in photos)
    assert photos[0][2]["url"] == "https://www.thevic361.com/social/latest/weekend-1.png"
    feed = next(c for c in sess.calls if c[1] == "page9/feed")
    assert feed[2]["message"] == "FB caption"
    assert json.loads(feed[2]["attached_media[0]"]) == {"media_fbid": "id1"}

    items = [c for c in sess.calls if c[1] == "ig7/media" and c[2].get("is_carousel_item") == "true"]
    carousel = next(c for c in sess.calls if c[1] == "ig7/media" and c[2].get("media_type") == "CAROUSEL")
    assert len(items) == 10
    assert carousel[2]["caption"] == "IG caption"
    assert any(c[1] == "ig7/media_publish" for c in sess.calls)


def test_failure_exits_nonzero_but_tries_both(tmp_path, monkeypatch):
    monkeypatch.setenv("META_PAGE_ID", "page9")
    monkeypatch.setenv("META_PAGE_TOKEN", "tok")
    monkeypatch.setenv("IG_USER_ID", "ig7")
    monkeypatch.setattr(sp.time, "sleep", lambda s: None)
    sess = FakeSession(fail="page9/feed")
    assert sp.main(["--kind", "weekend", "--kit-dir", str(write_kit(tmp_path)), "--no-wait"], session=sess) == 1
    assert any(c[1] == "ig7/media_publish" for c in sess.calls)


def test_wait_for_deploy_gives_up(monkeypatch):
    class S:
        def get(self, url, timeout=None):
            return FakeResp({"generated_for": "old"})

        def head(self, url, timeout=None):
            return FakeResp({})
    monkeypatch.setattr(sp.time, "sleep", lambda s: None)
    with pytest.raises(sp.PostError):
        sp.wait_for_deploy(["u"], "k", "2026-10-08", S(), timeout_s=0)


def test_social_kit_writes_manifest(tmp_path):
    pytest.importorskip("PIL")
    import social_kit as sk
    events = tmp_path / "events.json"
    events.write_text(json.dumps({"events": [
        {"date": "2026-10-09", "name": "Show", "time": "8 PM", "venue": "Aero Crafters"}]}))
    sk.main(["--events-file", str(events), "--today", "2026-10-08", "--out", str(tmp_path / "out")])
    m = json.loads((tmp_path / "out" / "kit.json").read_text())
    assert m["generated_for"] == "2026-10-08"
    assert m["kits"]["weekend"]["events"] == 1
    assert m["kits"]["weekend"]["slides"][0] == "weekend-1.png"


def test_weekend_reel_posts_to_instagram_and_photos_to_facebook(tmp_path, monkeypatch):
    monkeypatch.setenv("META_PAGE_ID", "page9")
    monkeypatch.setenv("META_PAGE_TOKEN", "tok")
    monkeypatch.setenv("IG_USER_ID", "ig7")
    monkeypatch.setattr(sp.time, "sleep", lambda s: None)
    kit = write_kit(tmp_path, slides=4)
    m = json.loads((kit / "kit.json").read_text())
    m["kits"]["weekend"]["reel"] = "weekend.mp4"
    (kit / "kit.json").write_text(json.dumps(m))
    sess = FakeSession()
    assert sp.main(["--kind", "weekend", "--kit-dir", str(kit), "--no-wait"], session=sess) == 0
    reel = next(c for c in sess.calls if c[1] == "ig7/media")
    assert reel[2]["media_type"] == "REELS"
    assert reel[2]["video_url"] == "https://www.thevic361.com/social/latest/weekend.mp4"
    assert not any(c[2].get("media_type") == "CAROUSEL" for c in sess.calls)
    assert len([c for c in sess.calls if c[1] == "page9/photos"]) == 4
    assert any(c[1] == "ig7/media_publish" for c in sess.calls)


def test_today_kind_posts(tmp_path, monkeypatch):
    monkeypatch.setenv("META_PAGE_ID", "page9")
    monkeypatch.setenv("META_PAGE_TOKEN", "tok")
    monkeypatch.delenv("IG_USER_ID", raising=False)
    (tmp_path / "kit.json").write_text(json.dumps({"generated_for": "2026-10-09", "kits": {
        "today": {"slides": ["today-1.png", "today-2.png"], "events": 2,
                  "captions": {"facebook": "Today FB", "instagram": "Today IG"}}}}))
    sess = FakeSession()
    assert sp.main(["--kind", "today", "--kit-dir", str(tmp_path), "--no-wait"], session=sess) == 0
    assert next(c for c in sess.calls if c[1] == "page9/feed")[2]["message"] == "Today FB"


def test_system_user_token_is_swapped_for_the_page_token(tmp_path, monkeypatch):
    # 2026-10-05: the first real run failed with "(#200) Unpublished posts
    # must be posted to a page as the page itself" (a system-user token).
    monkeypatch.setenv("META_PAGE_ID", "page9")
    monkeypatch.setenv("META_PAGE_TOKEN", "system-user-tok")
    monkeypatch.delenv("IG_USER_ID", raising=False)
    sess = FakeSession(page_token="page-tok")
    assert sp.main(["--kind", "weekend", "--kit-dir", str(write_kit(tmp_path)), "--no-wait"], session=sess) == 0
    lookup = next(c for c in sess.calls if c[0] == "GET" and c[2].get("fields") == "access_token")
    assert lookup[1] == "page9" and lookup[2]["access_token"] == "system-user-tok"
    posts = [c for c in sess.calls if c[0] == "POST"]
    assert posts and all(c[2]["access_token"] == "page-tok" for c in posts)


def test_get_calls_send_fields_in_the_query_string_and_the_token_in_a_header():
    seen = {}

    class S:
        def request(self, method, url, timeout=None, **kw):
            seen.update(kw)
            return FakeResp({"status_code": "FINISHED"})
    sp._graph("GET", "123", S(), fields="status_code", access_token="t")
    assert seen == {"params": {"fields": "status_code"}, "headers": {"Authorization": "Bearer t"}}


def test_network_errors_become_post_errors_without_the_url():
    import requests

    class S:
        def request(self, method, url, timeout=None, **kw):
            raise requests.ConnectionError(f"Max retries exceeded with url: {url}?access_token=SECRET")
    with pytest.raises(sp.PostError) as e:
        sp._graph("GET", "123", S(), fields="status_code", access_token="SECRET")
    assert "SECRET" not in str(e.value) and "ConnectionError" in str(e.value)
    assert e.value.__cause__ is None and e.value.__suppress_context__


def test_network_error_on_facebook_still_tries_instagram(tmp_path, monkeypatch):
    import requests
    monkeypatch.setenv("META_PAGE_ID", "page9")
    monkeypatch.setenv("META_PAGE_TOKEN", "tok")
    monkeypatch.setenv("IG_USER_ID", "ig7")
    monkeypatch.setattr(sp.time, "sleep", lambda s: None)
    sess = FakeSession(raise_on={"/photos": requests.ConnectionError("down")})
    kit = write_kit(tmp_path)
    assert sp.main(["--kind", "weekend", "--kit-dir", str(kit), "--no-wait"], session=sess) == 1
    assert any(c[1] == "ig7/media_publish" for c in sess.calls)
    slot = json.loads((kit / "posted.json").read_text())["2026-10-08:weekend"]
    assert slot == {"instagram": "post1"}   # a plain failure leaves Facebook free to retry


def test_timeout_publishing_marks_the_slot_pending_and_reruns_skip_it(tmp_path, monkeypatch, capsys):
    import requests
    monkeypatch.setenv("META_PAGE_ID", "page9")
    monkeypatch.setenv("META_PAGE_TOKEN", "tok")
    monkeypatch.delenv("IG_USER_ID", raising=False)
    kit = write_kit(tmp_path)
    sess = FakeSession(raise_on={"/feed": requests.ReadTimeout("slow")})
    assert sp.main(["--kind", "weekend", "--kit-dir", str(kit), "--no-wait"], session=sess) == 1
    assert json.loads((kit / "posted.json").read_text())["2026-10-08:weekend"] == {"facebook": "pending"}
    assert "may have posted" in capsys.readouterr().out

    rerun = FakeSession()
    assert sp.main(["--kind", "weekend", "--kit-dir", str(kit), "--no-wait"], session=rerun) == 0
    assert not any(c[0] == "POST" for c in rerun.calls)
    assert "check the Facebook account by hand" in capsys.readouterr().out


def test_timeout_before_the_final_call_is_a_plain_failure(tmp_path, monkeypatch):
    import requests
    monkeypatch.setenv("META_PAGE_ID", "page9")
    monkeypatch.setenv("META_PAGE_TOKEN", "tok")
    monkeypatch.delenv("IG_USER_ID", raising=False)
    kit = write_kit(tmp_path)
    sess = FakeSession(raise_on={"/photos": requests.ReadTimeout("slow")})
    assert sp.main(["--kind", "weekend", "--kit-dir", str(kit), "--no-wait"], session=sess) == 1
    assert not (kit / "posted.json").exists() or \
        "facebook" not in json.loads((kit / "posted.json").read_text()).get("2026-10-08:weekend", {})


def test_instagram_publish_timeout_marks_instagram_pending(tmp_path, monkeypatch):
    import requests
    monkeypatch.setenv("META_PAGE_ID", "page9")
    monkeypatch.setenv("META_PAGE_TOKEN", "tok")
    monkeypatch.setenv("IG_USER_ID", "ig7")
    monkeypatch.setattr(sp.time, "sleep", lambda s: None)
    kit = write_kit(tmp_path)
    sess = FakeSession(raise_on={"/media_publish": requests.ReadTimeout("slow")})
    assert sp.main(["--kind", "weekend", "--kit-dir", str(kit), "--no-wait"], session=sess) == 1
    slot = json.loads((kit / "posted.json").read_text())["2026-10-08:weekend"]
    assert slot == {"facebook": "post1", "instagram": "pending"}


def test_looked_up_page_token_is_masked_in_actions(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("META_PAGE_ID", "page9")
    monkeypatch.setenv("META_PAGE_TOKEN", "system-user-tok")
    monkeypatch.delenv("IG_USER_ID", raising=False)
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    sp.main(["--kind", "weekend", "--kit-dir", str(write_kit(tmp_path)), "--no-wait"],
            session=FakeSession(page_token="page-tok"))
    assert "::add-mask::page-tok" in capsys.readouterr().out
    # Same token back (already a Page token), or outside Actions: nothing to mask.
    sp.main(["--kind", "weekend", "--kit-dir", str(write_kit(tmp_path)), "--no-wait"], session=FakeSession())
    assert "::add-mask::" not in capsys.readouterr().out
    monkeypatch.delenv("GITHUB_ACTIONS")
    (tmp_path / "posted.json").unlink()
    sp.main(["--kind", "weekend", "--kit-dir", str(write_kit(tmp_path)), "--no-wait"],
            session=FakeSession(page_token="page-tok"))
    assert "::add-mask::" not in capsys.readouterr().out

