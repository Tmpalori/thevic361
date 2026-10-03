#!/usr/bin/env python3
"""Gemini probe: run the collector's Gemini source alone and print what it finds.

Runs from .github/workflows/gemini-probe.yml (manual, or a push to a claude/*
branch that edits the probe). Commits nothing and touches no site data.
Prints each kept event plus the per-category drop reasons, and for each
category the raw reply size and the sites Gemini cited, so a bad key, an
empty answer or an over-strict filter are easy to tell apart.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import collect_events as ce  # noqa: E402


def main():
    if not os.environ.get("GEMINI_API_KEY"):
        print("::error::GEMINI_API_KEY is not set for this run.")
        return 1
    import requests

    seen_replies = []

    def post(url, json=None, timeout=None, headers=None):
        r = requests.post(url, json=json, timeout=timeout, headers=headers)
        cat = json["contents"][0]["parts"][0]["text"].split("Focus on: ")[1].split(".\n")[0][:40]
        info = {"category": cat, "status": r.status_code}
        try:
            cand = (r.json().get("candidates") or [{}])[0]
            text = "".join(p.get("text", "") for p in ((cand.get("content") or {}).get("parts") or []))
            info.update(reply_chars=len(text), items=len(ce._gemini_json_array(text)),
                        cited=sorted(ce._grounded_hosts(cand))[:12])
        except Exception as e:  # noqa: BLE001
            info["error"] = str(e)[:200] or r.text[:200]
        if r.status_code != 200:
            info["body"] = r.text[:300]
        seen_replies.append(info)
        return r

    events = ce.fetch_gemini_events(14, post=post)
    print("\n=== Per category ===")
    for info in seen_replies:
        print(json.dumps(info))
    print(f"\n=== Kept {len(events)} events ===")
    for e in sorted(events, key=lambda x: (x["date"], x["time"])):
        print(f"{e['date']} {e['time'] or '--':>9}  {e['name'][:60]}  @ {e['venue'][:30]}  {e['url'][:80]}")
    with open("gemini_probe.json", "w") as f:
        json.dump({"categories": seen_replies, "events": events}, f, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
