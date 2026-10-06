#!/usr/bin/env python3
"""One look over the published events, after they go live, for anything off.

Runs from .github/workflows/event-check.yml after each collect (once
auto-publish has updated the site) and on Monday morning before the
newsletter. Reads the live /events.json, so it checks what people actually
see, hand edits included, and posts one Slack message: what to look at, or
that everything looks fine. What a rule is sure about (church events,
non-events, exact duplicates, a cut-off name with the whole listing at the
same place that day) it hides on its own through the site's
/api/event-check/hide (server/eventcheck.js; never deletes, restore on admin
Home); judgment calls, and everything the AI finds, only get reported.

Two passes:
  - Rules (free): the collector's own duplicate, out-of-area and non-event
    checks run again over the published list (it can hold hand-added
    events, or ones published before a rule existed), plus a weekday in the
    name that doesn't match the date ("Monday Bingo" on a Tuesday) and
    start times in the middle of the night, or a night event in the morning.
  - AI (one call, a few cents): the whole list at once, so it can see what
    per-event checks can't, like the same event at two venues. Skipped
    without OPENAI_API_KEY; the rules still run.

    python3 scripts/sweep_events.py [--days 14] [--dry-run]
"""
import argparse
import json
import os
import re
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
# Rule findings certain enough to hide without asking. Wrong days and odd
# times stay flags: the fix is an edit, not a removal. AI findings are never
# acted on.
AUTO_HIDE = {"religious", "not_an_event", "duplicate", "cut_off"}
# Hand-written events (curated: true, from local_events.yaml) were checked
# by a person: church trunk-or-treats and nearby-town festivals are on the
# list on purpose, and a name like "Movie Night: Friday the 13th" on a
# Monday is right. Only duplicates and odd times are still worth a look.
CURATED_SKIP = {"religious", "not_an_event", "out_of_area", "wrong_date", "cut_off", "other"}
# Duplicates are only hidden when they're exact (same name, venue and start
# once normalized), or the library's copy of a program the city calendar
# lists at its real place, and neither copy is a paid/featured listing; the
# copy with less detail goes. Fuzzy matches are only reported. A cut-off
# name ("Scenic Root — Plant a") is hidden only when another listing is at
# the same place that day (the whole event, from another source); alone it
# is only reported, since hiding it could lose the event.


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
        else:
            # "Comedy Night" at 10:00 AM: probably an AM/PM slip.
            reason = ce.morning_nightlife_reason(e) or ce.evening_venue_morning_reason(e)
            if reason:
                found.append((i, "odd_time", reason))
        reason = ce.cut_off_name_reason(e.get("name"))
        if reason:
            found.append((i, "cut_off", f"name looks cut off ({reason})"))
        reason = ce.out_of_area_reason(dict(e))
        if reason:
            found.append((i, "out_of_area", reason))
        reason = ce.non_event_reason(dict(e))
        if reason in RELIGIOUS_REASONS and ce.non_event_reason({**e, "description": ""}) not in RELIGIOUS_REASONS:
            # Only the description sounds religious: a person decides.
            found.append((i, "other", f"description sounds religious ({reason})"))
        elif reason:
            found.append((i, "religious" if reason in RELIGIOUS_REASONS else "not_an_event", reason))
        j = _dup_of(events, i)
        if j is not None:
            found.append((i, "duplicate", f"same as “{events[j]['name']}” at {events[j].get('venue') or 'no venue'}"))
    return found


def _dup_of(events, i):
    return next((j for j in range(i) if ce.is_same_event(events[j], events[i])
                 or _library_twin(events[j], events[i])), None)


def _library_twin(a, b):
    """The library's copy of a program the city calendar lists at its real
    place (2026-10-06 "Bookish Society Book Club" at the library and at Vida
    Cafe, same hours). Published lists have lost the collector's "guessed
    venue" flag, so the links tell the copies apart."""
    lib, city = (a, b) if "librarycalendar.com" in (a.get("url") or "") else (b, a)
    if "librarycalendar.com" not in (lib.get("url") or "") \
            or "victoriatx.gov/calendar.aspx?eid=" not in (city.get("url") or "").lower():
        return False
    if (lib.get("venue") or "").strip().lower() != "victoria public library" or lib.get("date") != city.get("date"):
        return False
    ta, tb = ce._time_range(lib.get("time")), ce._time_range(city.get("time"))
    return _norm(lib.get("name")) == _norm(city.get("name")) and ta[0] is not None and ta == tb


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
Refer to other events by their name, never by their index number (the reader never sees the numbers).
Answer with only a JSON array, at most 20 items: [{"i": <index>, "kind": "<kind>", "why": "<under 15 words>", "dup_of": <index or null>}]. Answer [] if nothing is off."""


def _named(why, events):
    """Swap "index 12" (the model's line numbers, meaningless in Slack) for
    the event's name; drop the reference if the number isn't valid."""
    def name(m):
        n = int(m.group(1) or m.group(2))
        return f"“{events[n]['name']}”" if 0 <= n < len(events) else "another listing"
    # "index 12" always means a line number. "#12", "event 12", "item 12" and
    # "line 12" usually do, but not when they start a quoted name ("Line 2
    # Dance Night", "#1 Fan Day"), so those skip a following capitalized word.
    # "line" only lowercase: a reason quoting a name keeps its capital.
    return re.sub(r"(?:\b(?i:index)\s*#?\s*(\d+)\b"
                  r"|(?:\b(?:[Ii]tem|[Ee]vent|line)\s*#?\s*|#\s*)(\d+)\b(?!\s+[A-Z]))",
                  name, why)


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
        why = _named(str(item.get("why") or "").strip()[:160], events)
        dup = item.get("dup_of")
        if kind == "duplicate" and isinstance(dup, int) and 0 <= dup < len(events) and dup != i:
            other = events[dup]
            why = f"same as “{other['name']}” at {other.get('venue') or 'no venue'}" + (f" ({why})" if why else "")
        out.append((i, kind, why))
    return out


def trusted(events, findings):
    """Drop findings a person already settled (curated events, CURATED_SKIP)."""
    return [f for f in findings if not (events[f[0]].get("curated") is True and f[1] in CURATED_SKIP)]


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
         "cut_off": "name cut off", "other": "check"}


def describe(e):
    when = datetime.strptime(e["date"], "%Y-%m-%d").strftime("%a %b %-d")
    where = f" ({e['venue']})" if e.get("venue") else ""
    link = f"{SITE}{e['page']}" if e.get("page") else ""
    name = f"<{link}|{e['name']}>" if link else e["name"]
    return f"{when} · {name}{where}"


def _norm(text):
    return " ".join(ce._name_tokens(text or ""))


def _exact_twins(a, b):
    return (a.get("date") == b.get("date") and _norm(a.get("name")) == _norm(b.get("name"))
            and _norm(a.get("venue")) == _norm(b.get("venue"))
            and ce._start_minutes(a.get("time")) == ce._start_minutes(b.get("time")))


def _paid(e):
    """A paid/hand-featured listing. An editor's pick (server/scoring.js) is
    featured only because it scored well; it gets no protection here."""
    return bool(e.get("featured")) and not e.get("editor_pick")


def _detail(e):
    """How much a listing tells people; the richer duplicate is kept."""
    return (_paid(e), bool(e.get("url")), len(e.get("description") or ""), bool(e.get("time")))


def to_hide(events, rules):
    """The rule findings to hide: certain kinds only, one per event. For a
    duplicate, the copy with less detail, and only for exact, unfeatured
    twins. Returns (picks, resolved): resolved maps a duplicate finding's
    event to the copy picked for hiding, so the report shows the pair once."""
    out, seen, resolved = [], set(), {}
    for i, kind, why in rules:
        if kind not in AUTO_HIDE:
            continue
        if kind == "cut_off":
            whole = _whole_listing(events, i)
            if whole is None or _paid(events[i]):
                continue
            why = f"{why}; “{events[whole]['name']}” is listed there that day"
        if kind == "duplicate":
            j = _dup_of(events, i)
            if j is None or _paid(events[i]) or _paid(events[j]):
                continue
            if _library_twin(events[i], events[j]):
                # The city calendar's copy has the real meeting place.
                loser, keeper = (i, j) if "librarycalendar.com" in (events[i].get("url") or "") else (j, i)
                why = (f"the library's copy of “{events[keeper]['name']}”, which the city lists at "
                       f"{events[keeper].get('venue') or 'another place'}")
            elif _exact_twins(events[i], events[j]):
                loser, keeper = (i, j) if _detail(events[i]) <= _detail(events[j]) else (j, i)
                why = f"same as “{events[keeper]['name']}” at {events[keeper].get('venue') or 'no venue'}, which has more detail"
            else:
                continue
            resolved[i] = loser
            i = loser
        if i not in seen and events[i].get("page"):
            seen.add(i)
            out.append((i, kind, why))
    return out, resolved


def _whole_listing(events, i):
    """Another listing, not itself cut off, at the same place on the same
    day as the cut-off one, or None."""
    e = events[i]
    if not (e.get("venue") or "").strip():
        return None
    for j, o in enumerate(events):
        if j != i and o.get("date") == e.get("date") and (o.get("venue") or "").strip() \
                and ce._same_place(e, o) and not ce.cut_off_name_reason(o.get("name")):
            return j
    return None


def hide(events, picks, secret):
    """Ask the site to hide picks. Returns (hidden indexes, indexes the admin
    restored before, a problem note for Slack or None)."""
    if not picks or not secret:  # no secret: report-only, by design
        return set(), set(), None
    body = {"hide": [{"page": events[i]["page"], "reason": f"{LABEL.get(k, k)}: {why}"[:120]} for i, k, why in picks]}
    try:
        r = requests.post(f"{SITE}/api/event-check/hide", json=body, timeout=30,
                          headers={"X-Cron-Secret": secret, "User-Agent": "vic361-event-check"})
        out = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        if r.status_code == 401:
            return set(), set(), "auto-hide failed: the site rejected the secret (check EVENT_CHECK_SECRET matches in Railway and GitHub)"
        if not r.ok:
            return set(), set(), f"auto-hide failed: {out.get('message') or out.get('error') or f'HTTP {r.status_code}'}"
    except Exception as e:  # noqa: BLE001 - still report everything
        return set(), set(), f"auto-hide failed: {e}"
    by_page = {events[i]["page"]: i for i, _, _ in picks}
    hidden = {by_page[h["page"]] for h in out.get("hidden") or [] if h.get("page") in by_page}
    restored = {by_page[x["page"]] for x in out.get("skipped") or []
                if x.get("why") == "restored-by-admin" and x.get("page") in by_page}
    return hidden, restored, None


def report(events, findings, ai_ran, days, hidden=(), problem=None):
    """Slack text: what was hidden, then what to look at."""
    scope = f"{len(events)} events in the next {days} days"
    gone = [f for f in findings if f[0] in hidden]
    look = [f for f in findings if f[0] not in hidden]
    note = ("" if ai_ran else " (Rules only; the AI check didn't run.)") + (f" ⚠️ {problem}." if problem else "")
    if not findings:
        return f"🔎 Event check: {scope}, nothing looks off.{note}", []
    nh, nl = len({f[0] for f in gone}), len({f[0] for f in look})
    parts = ([f"hid {nh}"] if nh else []) + ([f"{nl} to look at"] if nl else [])
    head = f"🔎 Event check: {', '.join(parts)} ({scope}){note}"
    lines = []
    if gone:
        lines.append("*Hidden automatically* (nothing deleted; Restore on the admin Home tab):")
        lines += [f"• {describe(events[i])}: *{LABEL.get(kind, kind)}*, {why}" for i, kind, why in gone]
    if look:
        lines.append("*To look at:*")
        lines += [f"• {describe(events[i])}: *{LABEL.get(kind, kind)}*, {why}" for i, kind, why in look]
    return head, lines


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--dry-run", action="store_true", help="print instead of posting to Slack")
    args = ap.parse_args(argv)

    # ?all=1: every public event, including ones past their day's limit
    # (server/scoring.js), which still have pages and appear in the guides.
    resp = requests.get(f"{SITE}/events.json?all=1", timeout=30, headers={"User-Agent": "vic361-event-check"})
    resp.raise_for_status()
    events = upcoming(resp.json().get("events") or [], ce.now_central().date(), args.days)

    rules = trusted(events, rule_findings(events))
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    ai = ai_findings(events, key) if key and events else None
    ai = trusted(events, ai) if ai is not None else None
    secret = "" if args.dry_run else os.environ.get("EVENT_CHECK_SECRET", "").strip()
    picks, resolved = to_hide(events, rules)
    hidden, restored, problem = hide(events, picks, secret)
    findings = combine(rules, ai)
    # A duplicate pair shows once: as the copy that was hidden.
    done = {i for i, loser in resolved.items() if loser in hidden}
    findings = [f for f in findings if not (f[1] == "duplicate" and f[0] in done)]
    findings += [p for p in picks if p[0] in hidden and (p[0], p[1]) not in {(f[0], f[1]) for f in findings}]
    # What the admin restored isn't hidden or flagged again for the same
    # reason; anything else about it (wrong day, odd time, AI) still shows.
    findings = sorted(f for f in findings if not (f[0] in restored and f[1] in AUTO_HIDE))
    head, lines = report(events, findings, ai is not None, args.days, hidden, problem)

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
