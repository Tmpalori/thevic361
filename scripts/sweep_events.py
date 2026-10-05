#!/usr/bin/env python3
"""One look over the published events, after they go live, for anything off.

Runs from .github/workflows/event-check.yml after each collect (once
auto-publish has updated the site) and on Monday morning before the
newsletter. Reads the live /events.json, so it checks what people actually
see, hand edits included, and posts one Slack message: what to look at, or
that everything looks fine. It never changes anything; fixes happen in the
admin.

Two passes:
  - Rules (free): the collector's own duplicate, out-of-area and non-event
    checks run again over the published list (it can hold hand-added
    events, or ones published before a rule existed), plus a weekday in the
    name that doesn't match the date ("Monday Bingo" on a Tuesday) and
    start times in the middle of the night.
  - AI (one call, a few cents): the whole list at once, so it can see what
    per-event checks can't, like the same event at two venues. Skipped
    without OPENAI_API_KEY; the rules still run.

    python3 scripts/sweep_events.py [--days 14] [--dry-run]
"""
import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, HERE)

import requests  # noqa: E402

import collect_events as ce  # noqa: E402
import slack_notify  # noqa: E402

SITE = os.environ.get("SITE_URL", "").strip().rstrip("/") or "https://www.thevic361.com"
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
AI_KINDS = {"duplicate", "wrong_date", "not_an_event", "out_of_area", "religious", "odd_time", "other"}
MAX_LINES = 12  # in Slack; the job summary lists everything
RELIGIOUS_REASONS = {"religious event", "church event", "worship service"}  # collect_events.non_event_reason


def upcoming(events, today, days):
    end = (today + timedelta(days=days - 1)).isoformat()
    out = [e for e in events if today.isoformat() <= str(e.get("date") or "") <= end]
    out.sort(key=lambda e: (e["date"], ce._start_minutes(e.get("time")) or 0, e.get("name") or ""))
    return out


def _weekday(d):
    return WEEKDAYS[date.fromisoformat(d).weekday()]


def rule_findings(events):
    """Cheap, certain checks. Returns [(index, kind, why)]."""
    found = []
    for i, e in enumerate(events):
        name = (e.get("name") or "").lower()
        # Exactly one weekday in the name, and it isn't the event's day.
        named = {d for d in WEEKDAYS if d in name}
        if len(named) == 1:
            want = named.pop()
            if want != _weekday(e["date"]):
                found.append((i, "wrong_date", f"name says {want.title()} but it's listed on a {_weekday(e['date']).title()}"))
        start = ce._start_minutes(e.get("time"))
        if start is not None and start < 6 * 60:
            found.append((i, "odd_time", f"starts at {e.get('time')}"))
        reason = ce.out_of_area_reason(dict(e))
        if reason:
            found.append((i, "out_of_area", reason))
        reason = ce.non_event_reason(dict(e))
        if reason:
            found.append((i, "religious" if reason in RELIGIOUS_REASONS else "not_an_event", reason))
        for j in range(i):
            if ce.is_same_event(events[j], e):
                found.append((i, "duplicate", f"same as “{events[j]['name']}” at {events[j].get('venue') or 'no venue'}"))
                break
    return found


def _line(i, e):
    desc = (e.get("description") or "").replace("\n", " ")[:140]
    return (f"{i} | {e['date']} ({_weekday(e['date'])[:3]}) | {e.get('time') or 'no time'} | "
            f"{e.get('name')} | {e.get('venue') or 'no venue'} | {desc}")


PROMPT = """You check the published event list for The Vic 361, a community events site for Victoria, Texas (Victoria County).
Each line is: index | date (weekday) | time | name | venue | description.

Flag only clear problems a careful editor would fix before the list goes out:
- duplicate: the same real event listed more than once (same day, same event, even if the venue or wording differs). Set "dup_of" to the other index.
- wrong_date: the name or description says a different day or date than the one listed.
- not_an_event: not something the public can attend (job posts, ads, closures, sales, awareness days, private events).
- out_of_area: clearly not in or near Victoria, Texas.
- religious: worship, church services or church-hosted events (the owner doesn't list these).
- odd_time: a time that can't be right for this kind of event.
- other: anything else clearly wrong (garbled name, wrong venue for the event, etc.).

Do not flag the same recurring event on different days (weekly karaoke, story time). Do not flag generic names at different venues ("Live Music" at two bars is two events). When unsure, leave it out.
Answer with only a JSON array, at most 20 items: [{"i": <index>, "kind": "<kind>", "why": "<under 15 words>", "dup_of": <index or null>}]. Answer [] if nothing is off."""


def ai_findings(events, api_key):
    """[(index, kind, why)] from one model pass, or None if it failed."""
    lines = "\n".join(_line(i, e) for i, e in enumerate(events))
    try:
        content = ce._openai_chat(api_key, [
            {"role": "system", "content": PROMPT},
            {"role": "user", "content": lines},
        ], max_tokens=6000, timeout=120)
    except Exception as e:  # noqa: BLE001 - the rules still report
        print(f"AI check failed: {e}")
        return None
    parsed = ce._parse_ai_json_array(content)
    if parsed is None:
        print(f"AI check: unreadable answer: {content[:300]!r}")
        return None
    out = []
    for item in parsed:
        try:
            i = int(item.get("i"))
        except (TypeError, ValueError, AttributeError):
            continue
        kind = str(item.get("kind") or "other")
        if not 0 <= i < len(events) or kind not in AI_KINDS:
            continue
        why = str(item.get("why") or "").strip()[:160]
        dup = item.get("dup_of")
        if kind == "duplicate" and isinstance(dup, int) and 0 <= dup < len(events) and dup != i:
            other = events[dup]
            why = f"same as “{other['name']}” at {other.get('venue') or 'no venue'}" + (f" ({why})" if why else "")
        out.append((i, kind, why))
    return out


def combine(rule, ai):
    """One entry per event; rules first (they're certain), AI adds the rest."""
    seen, out = set(), []
    for i, kind, why in rule + (ai or []):
        if (i, kind) in seen:
            continue
        seen.add((i, kind))
        out.append((i, kind, why))
    out.sort()
    return out


LABEL = {"duplicate": "possible duplicate", "wrong_date": "wrong day?", "not_an_event": "not an event?",
         "out_of_area": "outside Victoria?", "religious": "religious / church event", "odd_time": "odd time",
         "other": "check"}


def describe(e):
    when = datetime.strptime(e["date"], "%Y-%m-%d").strftime("%a %b %-d")
    where = f" ({e['venue']})" if e.get("venue") else ""
    link = f"{SITE}{e['page']}" if e.get("page") else ""
    name = f"<{link}|{e['name']}>" if link else e["name"]
    return f"{when} · {name}{where}"


def report(events, findings, ai_ran, days):
    scope = f"{len(events)} events in the next {days} days"
    if not findings:
        head = f"🔎 Event check: {scope}, nothing looks off."
        if not ai_ran:
            head += " (Rules only; the AI check didn't run.)"
        return head, []
    n = len({i for i, _, _ in findings})
    head = f"🔎 Event check: {n} event{'s' if n != 1 else ''} to look at ({scope})"
    if not ai_ran:
        head += ". Rules only; the AI check didn't run"
    lines = [f"• {describe(events[i])}: *{LABEL.get(kind, kind)}*, {why}" for i, kind, why in findings]
    return head, lines


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--dry-run", action="store_true", help="print instead of posting to Slack")
    args = ap.parse_args(argv)

    resp = requests.get(f"{SITE}/events.json", timeout=30, headers={"User-Agent": "vic361-event-check"})
    resp.raise_for_status()
    events = upcoming(resp.json().get("events") or [], ce.now_central().date(), args.days)

    rules = rule_findings(events)
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    ai = ai_findings(events, key) if key and events else None
    findings = combine(rules, ai)
    head, lines = report(events, findings, ai is not None, args.days)

    text = "\n".join([head] + lines[:MAX_LINES] +
                     ([f"…and {len(lines) - MAX_LINES} more in the run summary."] if len(lines) > MAX_LINES else []))
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write("\n".join([f"### {head}", ""] + [f"- {x}" for x in lines]) + "\n")
    if not args.dry_run:
        slack_notify.main([text, "--link", f"{SITE}/admin.html"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
