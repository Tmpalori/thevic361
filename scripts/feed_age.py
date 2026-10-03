#!/usr/bin/env python3
"""Days since events.json's last_updated (99 when missing or unreadable).

Used by uptime.yml's daily stale-feed check:  python3 scripts/feed_age.py events.json
"""
import datetime as dt
import json
import sys


def age_days(path, now=None):
    try:
        with open(path) as f:
            raw = json.load(f).get("last_updated", "")
        t = dt.datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=dt.timezone.utc)
        return ((now or dt.datetime.now(dt.timezone.utc)) - t).days
    except Exception:
        return 99


if __name__ == "__main__":
    print(age_days(sys.argv[1] if len(sys.argv) > 1 else "events.json"))
