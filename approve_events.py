#!/usr/bin/env python3
"""
The Vic 361 — Approve Events
Takes Tristen's picks from the digest email and publishes them to events.json.

Usage:
  python approve_events.py 1 3 5 8 11          # approve specific numbers
  python approve_events.py ALL                  # approve everything
  python approve_events.py 1-5 8 10-12          # ranges work too
  python approve_events.py --list               # show current candidates

The script reads candidates.json, keeps only the selected events,
merges with extras.yaml, and writes the final events.json.
"""

import argparse
import json
import os
import sys
from datetime import datetime

import yaml


def load_candidates(path):
    """Load candidates.json."""
    with open(path) as f:
        data = json.load(f)
    return data.get("events", [])


def parse_picks(args_picks):
    """Parse pick arguments into a set of 1-based indices.

    Supports: individual numbers (1 3 5), ranges (1-5), comma-separated (1,3,5),
    and the keyword ALL.
    """
    picks = set()

    for arg in args_picks:
        arg = arg.strip().upper()
        if arg == "ALL":
            return "ALL"

        # Handle comma-separated values
        for part in arg.split(","):
            part = part.strip()
            if not part:
                continue

            # Handle ranges like 1-5
            if "-" in part:
                try:
                    start, end = part.split("-", 1)
                    for i in range(int(start), int(end) + 1):
                        picks.add(i)
                except ValueError:
                    print(f"  Warning: couldn't parse '{part}', skipping")
            else:
                try:
                    picks.add(int(part))
                except ValueError:
                    print(f"  Warning: couldn't parse '{part}', skipping")

    return picks


def load_extras(yaml_path):
    """Load extras.yaml for new_and_notable + sponsor."""
    if not os.path.exists(yaml_path):
        return {"new_and_notable": [], "sponsor": None}
    try:
        with open(yaml_path) as f:
            data = yaml.safe_load(f) or {}
        return {
            "new_and_notable": data.get("new_and_notable", []),
            "sponsor": data.get("sponsor"),
        }
    except Exception:
        return {"new_and_notable": [], "sponsor": None}


def main():
    parser = argparse.ArgumentParser(description="The Vic 361 — Approve Events")
    parser.add_argument("picks", nargs="*", help="Event numbers to approve (e.g., 1 3 5 or ALL)")
    parser.add_argument("--candidates", default="./candidates.json", help="Path to candidates.json")
    parser.add_argument("--output", default="./docs/events.json", help="Output events.json path")
    parser.add_argument("--extras", default="./extras.yaml", help="Path to extras.yaml")
    parser.add_argument("--list", action="store_true", help="List candidates and exit")
    args = parser.parse_args()

    if not os.path.exists(args.candidates):
        print(f"ERROR: {args.candidates} not found. Run collect_events.py first.")
        sys.exit(1)

    events = load_candidates(args.candidates)

    if args.list or not args.picks:
        print(f"\nThe Vic 361 — {len(events)} Event Candidates")
        print("=" * 55)
        current_date = ""
        for i, ev in enumerate(events, 1):
            if ev["date"] != current_date:
                current_date = ev["date"]
                dt = datetime.strptime(current_date, "%Y-%m-%d")
                print(f"\n--- {dt.strftime('%A, %B %d')} ---")
            free_tag = " [FREE]" if ev.get("free") else ""
            time_str = f" @ {ev['time']}" if ev.get("time") else ""
            venue_str = f" — {ev['venue']}" if ev.get("venue") else ""
            print(f"  [{i:2d}] {ev['name']}{free_tag}{time_str}{venue_str}")

        print(f"\n{'=' * 55}")
        print("Usage: python approve_events.py 1 3 5 8 11")
        print("       python approve_events.py ALL")
        return

    picks = parse_picks(args.picks)

    if picks == "ALL":
        approved = events
        print(f"  Approving ALL {len(events)} events")
    else:
        approved = []
        for i, ev in enumerate(events, 1):
            if i in picks:
                approved.append(ev)
        print(f"  Approving {len(approved)} of {len(events)} candidates")

    if not approved:
        print("  No events selected. Nothing to publish.")
        sys.exit(1)

    # Load extras
    extras = load_extras(args.extras)

    # Build final output
    output = {
        "last_updated": datetime.now().strftime("%Y-%m-%dT%H:%M:%S-05:00"),
        "events": approved,
        "new_and_notable": extras["new_and_notable"],
        "sponsor": extras["sponsor"],
    }

    out_path = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"  Published {len(approved)} events to {out_path}")

    # Summary
    from collections import Counter
    day_counts = Counter(e["date"] for e in approved)
    for d in sorted(day_counts):
        dt = datetime.strptime(d, "%Y-%m-%d")
        print(f"   {dt.strftime('%a %b %d')}: {day_counts[d]} events")


if __name__ == "__main__":
    main()
