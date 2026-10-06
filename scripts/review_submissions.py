#!/usr/bin/env python3
"""AI review of free event submissions (server/submissionReview.js).

Runs from .github/workflows/submission-review.yml every 15 minutes. For
each submission waiting on the site:

  1. Rules first, the same ones the collector and event check use:
     church/worship events are turned away, an exact copy of a live event
     is marked duplicate, and anything the rules doubt (non-event, outside
     the area, cut-off name, a near-duplicate) is flagged for the owner.
  2. One OpenAI pass over the rest: tidy the name, description and icons
     in the site's voice, and say whether it can go live, needs a look, or
     is spam.
  3. One POST back with every decision. The site applies only the name,
     description and icon changes, publishes what's approved, emails the
     submitter, and posts one Slack summary.

Without OPENAI_API_KEY only rule-certain decisions are made; everything
else waits for the next run (or the owner). A submission the AI can't
answer for is left for the next run too.

Needs SUBMISSION_REVIEW_SECRET (or EVENT_CHECK_SECRET / NEWSLETTER_CRON_SECRET),
the same value in Railway and GitHub.
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

import requests  # noqa: E402

import collect_events as ce  # noqa: E402

SITE = os.environ.get("SITE_URL", "https://www.thevic361.com").rstrip("/")
UA = {"User-Agent": "vic361-submission-review"}
ICONS = ["food", "music", "family", "drinks", "arts", "shopping", "outdoors", "community", "free"]
RELIGIOUS_REASONS = {"religious event", "church event", "worship service"}  # collect_events.non_event_reason
VERDICTS = {"approve", "flag", "spam"}

PROMPT = """You review event submissions for The Vic 361, a community events website for Victoria, Texas (Victoria County and nearby towns). People send these through a public form.

For each submission return:
  - verdict: "approve" if it's a real event the public can attend, in or near Victoria TX, with enough detail to list as is; "spam" for ads, scams, gibberish, links with no real event, or anything abusive; "flag" for everything else a careful editor would want to check first (looks private, outside the area, a worship service or church-hosted event, the details contradict each other, the date or time looks wrong, the description is about something else, offensive content). When unsure, "flag".
  - reason: under 15 words, why (for flag and spam; may be empty for approve).
  - name: the event name, tidied: fix capitalization (no ALL CAPS) and obvious typos, drop emojis, the date, the venue and hype ("!!!", "BEST EVER"). Keep the organizer's wording otherwise. Never invent anything.
  - description: at most 160 characters, at most 2 short sentences, neutral and friendly local-newsletter tone, no emojis. Don't repeat the name, venue, address, date or time (the site shows those). Use only facts from the submission.
  - icons: 1 to 3 from this set, most representative first: food, music, family, drinks, arts, shopping, outdoors, community, free. Include "free" only when the submission says it's free.

The date, time, venue, address and link are shown for context; you can't change them.
Return ONLY a JSON array, one object per submission in the same order: [{"verdict": "...", "reason": "...", "name": "...", "description": "...", "icons": [...]}]."""


def _norm(text):
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def rule_decision(ev, live):
    """(decision, reason) the rules are sure of, ("flag", why) for doubts,
    or None to leave it to the AI."""
    reason = ce.non_event_reason(dict(ev))
    if reason in RELIGIOUS_REASONS:
        return "reject", f"{reason} (the site doesn't list these)"
    for other in live:
        if other.get("date") != ev.get("date"):
            continue
        if _norm(other.get("name")) == _norm(ev.get("name")) and _norm(other.get("venue")) == _norm(ev.get("venue")):
            return "duplicate", f"already live as “{other.get('name')}”"
        if ce.is_same_event(other, ev):
            return "flag", f"may already be listed as “{other.get('name')}” at {other.get('venue') or 'no venue'}"
    if reason:
        return "flag", f"rules say: {reason}"
    reason = ce.out_of_area_reason(dict(ev))
    if reason:
        return "flag", f"may be outside the area ({reason})"
    reason = ce.cut_off_name_reason(ev.get("name"))
    if reason:
        return "flag", f"name looks cut off ({reason})"
    return None


def _brief(ev):
    return {
        "name": ev.get("name", ""),
        "date": ev.get("date", ""),
        "time": " to ".join(x for x in [ev.get("time"), ev.get("end_time")] if x),
        "venue": ev.get("venue", ""),
        "address": ev.get("address", ""),
        "link": ev.get("url", ""),
        "free": bool(ev.get("free")),
        "description": (ev.get("description") or "")[:1200],
        "icons_picked": ev.get("icons") or [],
    }


def ai_review(events, api_key):
    """One answer dict per event (None where the model gave nothing usable),
    or None if the call failed."""
    try:
        content = ce._openai_chat(api_key, [
            {"role": "system", "content": PROMPT},
            {"role": "user", "content": json.dumps([_brief(e) for e in events], ensure_ascii=False)},
        ], max_tokens=4000, timeout=120)
    except Exception as e:  # noqa: BLE001 - nothing is decided; next run retries
        print(f"AI review failed: {e}")
        return None
    parsed = ce._parse_ai_json_array(content)
    if parsed is None or len(parsed) != len(events):
        print(f"AI review: unusable answer ({'unreadable' if parsed is None else f'{len(parsed)} for {len(events)}'})")
        return None
    return [a if isinstance(a, dict) else None for a in parsed]


def cleaned_from(answer, ev):
    name = ce._strip_emojis(str(answer.get("name") or "")).strip()[:200]
    desc = ce._strip_emojis(str(answer.get("description") or "")).strip()
    if len(desc) > 200:  # asked for 160; trim at a word if it ran long
        desc = desc[:200].rsplit(" ", 1)[0].rstrip(",;:") + "…"
    icons = [i for i in (answer.get("icons") or []) if i in ICONS][:3]
    if ev.get("free") and "free" not in icons:
        icons.append("free")
    out = {}
    # A rename that keeps none of the original words is a rewrite, not a tidy.
    if name and (set(_norm(name).split()) & set(_norm(ev.get("name")).split())):
        out["name"] = name
    if len(desc) >= 15:
        out["description"] = desc
    if icons:
        out["icons"] = icons
    return out


def decide(submissions, live, api_key):
    """[{id, decision, reason, cleaned}] for the site, plus a printable log."""
    reviews, log, for_ai = [], [], []
    for s in submissions:
        ev = s["event"]
        rule = rule_decision(ev, live)
        if rule and rule[0] in ("reject", "duplicate"):
            reviews.append({"id": s["id"], "decision": rule[0], "reason": rule[1]})
        else:
            for_ai.append((s, rule))
    answers = ai_review([s["event"] for s, _ in for_ai], api_key) if for_ai and api_key else None
    if for_ai and answers is None:
        log.append(f"{len(for_ai)} left for the next run (no AI answer).")
    if answers is not None:
        for (s, rule), a in zip(for_ai, answers):
            if a is None or str(a.get("verdict")) not in VERDICTS:
                log.append(f"{s['event'].get('name')}: no usable AI answer; next run.")
                continue
            verdict = a["verdict"]
            reason = str(a.get("reason") or "").strip()[:200]
            if verdict == "spam":
                reviews.append({"id": s["id"], "decision": "reject", "reason": f"spam: {reason or 'looks like spam'}"})
                continue
            decision = "approve" if verdict == "approve" and not rule else "flag"
            # The rules' doubt wins over an AI approval.
            if rule:
                reason = rule[1] + (f"; AI: {reason}" if reason and verdict != "approve" else "")
            reviews.append({"id": s["id"], "decision": decision, "reason": reason,
                            "cleaned": cleaned_from(a, s["event"])})
    return reviews, log


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="print decisions instead of sending them")
    args = ap.parse_args(argv)
    secret = os.environ.get("SUBMISSION_REVIEW_SECRET", "").strip()
    if not secret:
        print("SUBMISSION_REVIEW_SECRET not set; skipping.")
        return 0
    headers = {**UA, "X-Cron-Secret": secret}
    r = requests.get(f"{SITE}/api/submission-review/pending", headers=headers, timeout=30)
    if r.status_code == 401:
        print("::error::The site rejected the secret (it must match in Railway and GitHub).")
        return 1
    r.raise_for_status()
    submissions = r.json().get("submissions") or []
    if not submissions:
        print("Nothing waiting.")
        return 0
    live = requests.get(f"{SITE}/events.json", headers=UA, timeout=30).json().get("events") or []
    reviews, log = decide(submissions, live, os.environ.get("OPENAI_API_KEY", "").strip())
    for line in log:
        print(line)
    for rv in reviews:
        print(f"{rv['decision']}: {rv['id']} {rv.get('reason') or ''} {json.dumps(rv.get('cleaned') or {})}")
    if args.dry_run or not reviews:
        return 0
    r = requests.post(f"{SITE}/api/submission-review", headers=headers, json={"reviews": reviews}, timeout=120)
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if not r.ok:
        print(f"::error::Sending decisions failed: {body.get('message') or body.get('error') or r.status_code}")
        return 1
    print(f"Done: {len(body.get('done') or [])}, skipped: {len(body.get('skipped') or [])}, published: {body.get('published')}")
    if body.get("published") is False:
        print("::error::Approved, but publishing failed (see Slack).")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
