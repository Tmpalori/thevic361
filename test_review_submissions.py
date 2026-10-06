"""Tests for scripts/review_submissions.py, the AI review of free submissions."""
import json
import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
import review_submissions as rs  # noqa: E402


def ev(name, date="2026-10-10", venue="Community Center", description="Crafts and food vendors.", **extra):
    return {"name": name, "date": date, "time": "9:00 AM", "venue": venue, "address": "2905 E North St, Victoria, TX",
            "description": description, "icons": [], "free": False, **extra}


def sub(i, event):
    return {"id": f"s{i}", "event": event}


def answer(**kw):
    base = {"verdict": "approve", "reason": "", "name": "Fall Craft Fair",
            "description": "Local crafters and food vendors.", "icons": ["shopping", "food"]}
    return {**base, **kw}


def test_rules_turn_away_church_events_and_exact_copies_but_only_flag_doubts():
    live = [ev("Fall Craft Fair", venue="Community Center"), ev("Trivia Night", venue="Weber Brewing")]
    assert rs.rule_decision(ev("Sunday Worship Service", venue="First Baptist Church"), live)[0] == "reject"
    assert rs.rule_decision(ev("fall craft fair!", venue="community center"), live)[0] == "duplicate"
    assert rs.rule_decision(ev("Fall Craft Fair", date="2026-10-11"), live) is None
    assert rs.rule_decision(ev("Pumpkin Patch Opening"), live) is None
    # Only the description sounds religious: flagged for a person, never
    # auto-rejected. Secular uses of the words pass.
    assert rs.rule_decision(ev("Community Night", description="An evening of praise and worship."), live)[0] == "flag"
    assert rs.rule_decision(ev("Creedence Clearwater Revival Tribute"), live) is None
    assert rs.rule_decision(ev("Blood Drive", venue="Methodist Hospital"), live) is None


def test_ai_approval_goes_through_with_only_tidied_fields():
    with patch.object(rs.ce, "_openai_chat", return_value=json.dumps([answer()])):
        reviews, _ = rs.decide([sub(1, ev("FALL CRAFT FAIR!!!"))], [], "key")
    assert reviews == [{"id": "s1", "decision": "approve", "reason": "",
                        "cleaned": {"name": "Fall Craft Fair", "description": "Local crafters and food vendors.",
                                    "icons": ["shopping", "food"]}}]


def test_spam_is_rejected_and_doubts_are_flagged():
    answers = [answer(verdict="spam", reason="crypto ad"), answer(verdict="flag", reason="looks private")]
    with patch.object(rs.ce, "_openai_chat", return_value=json.dumps(answers)):
        reviews, _ = rs.decide([sub(1, ev("Earn $$$ Fast")), sub(2, ev("Smith Family Reunion"))], [], "key")
    assert [(r["decision"], r["reason"]) for r in reviews] == [("reject", "spam: crypto ad"), ("flag", "looks private")]


def test_rule_doubt_beats_an_ai_approval():
    live = [ev("Trivia Night", venue="Weber Brewing", time="7:00 PM")]
    near = ev("Trivia Night at Weber", venue="Weber Brewing Co", time="7:00 PM")
    with patch.object(rs.ce, "is_same_event", return_value=True), \
            patch.object(rs.ce, "_openai_chat", return_value=json.dumps([answer(name="Trivia Night at Weber")])):
        reviews, _ = rs.decide([sub(1, near)], live, "key")
    assert reviews[0]["decision"] == "flag"
    assert "may already be listed" in reviews[0]["reason"]


def test_no_ai_answer_leaves_it_for_the_next_run():
    with patch.object(rs.ce, "_openai_chat", side_effect=RuntimeError("down")):
        reviews, log = rs.decide([sub(1, ev("Fall Craft Fair"))], [], "key")
    assert reviews == [] and log
    reviews, log = rs.decide([sub(1, ev("Fall Craft Fair"))], [], "")  # no key
    assert reviews == [] and "next run" in log[0]
    # Wrong number of answers: nothing decided.
    with patch.object(rs.ce, "_openai_chat", return_value=json.dumps([answer(), answer()])):
        assert rs.decide([sub(1, ev("Fall Craft Fair"))], [], "key")[0] == []


def test_cleanup_never_renames_to_something_else_and_drops_emojis():
    out = rs.cleaned_from(answer(name="Totally Different Thing", description="Fun 🎉 for all ages at the park today.",
                                 icons=["food", "bogus"]), ev("Fall Craft Fair", free=True))
    assert "name" not in out
    assert "🎉" not in out["description"]
    assert out["icons"] == ["food", "free"]
    long = rs.cleaned_from(answer(description="word " * 80), ev("Fall Craft Fair"))
    assert len(long["description"]) <= 201 and long["description"].endswith("…")


def test_main_sends_decisions_with_the_secret(monkeypatch):
    calls = []

    class R:
        def __init__(self, body, status=200):
            self.body, self.status_code, self.ok = body, status, status < 400
            self.headers = {"content-type": "application/json"}

        def json(self):
            return self.body

        def raise_for_status(self):
            pass

    def get(url, headers=None, timeout=None):
        calls.append(("GET", url, headers))
        if url.endswith("/pending"):
            return R({"submissions": [sub(1, ev("Fall Craft Fair"))]})
        return R({"events": []})

    def post(url, headers=None, json=None, timeout=None):
        calls.append(("POST", url, headers, json))
        return R({"done": json["reviews"], "skipped": [], "published": True})

    monkeypatch.setenv("SUBMISSION_REVIEW_SECRET", "s3cret")
    monkeypatch.setenv("OPENAI_API_KEY", "key")
    monkeypatch.setattr(rs.requests, "get", get)
    monkeypatch.setattr(rs.requests, "post", post)
    with patch.object(rs.ce, "_openai_chat", return_value=json.dumps([answer()])):
        assert rs.main([]) == 0
    assert calls[0][2]["X-Cron-Secret"] == "s3cret"
    assert "X-Cron-Secret" not in calls[1][2]  # the public events.json gets no secret
    assert calls[-1][0] == "POST" and calls[-1][3]["reviews"][0]["decision"] == "approve"


def test_main_skips_without_a_secret(monkeypatch):
    monkeypatch.delenv("SUBMISSION_REVIEW_SECRET", raising=False)
    assert rs.main([]) == 0
