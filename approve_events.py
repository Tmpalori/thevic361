#!/usr/bin/env python3
"""
The Vic 361 — Approve Events
Takes Tristen's picks from the digest email and publishes them to events.json.

Usage:
  python approve_events.py 1 3 5 8 11          # approve specific numbers
  python approve_events.py ALL                  # approve everything
  python approve_events.py 1-5 8 10-12          # ranges work too
  python approve_events.py NONE                 # publish nothing (clears events)
  python approve_events.py EXCEPT:7,12          # everything except #7 and #12
  python approve_events.py --list               # show current candidates

The script reads candidates.json, keeps only the selected events,
merges with extras.yaml, and writes the final events.json.

If SMTP_EMAIL/SMTP_PASSWORD are set and --notify is passed, also sends a
one-line confirmation email to NOTIFY_TO (defaults to SMTP_EMAIL).
"""

import argparse
import json
import os
import smtplib
import sys
from datetime import datetime
from email.mime.text import MIMEText

import yaml


def load_candidates(path):
    """Load candidates.json."""
    with open(path) as f:
        data = json.load(f)
    return data.get("events", [])


def parse_picks(args_picks):
    """Parse pick arguments into a set of 1-based indices.

    Supports: individual numbers (1 3 5), ranges (1-5), comma-separated (1,3,5),
    keywords ALL / NONE, and EXCEPT:<list> for "all minus these".

    Returns:
        "ALL"                              — keep all candidates
        "NONE"                             — publish empty list
        ("EXCEPT", set)                    — keep all minus the indices in the set
        set[int]                           — specific indices to keep
    """
    # Treat the joined args as one string so 'EXCEPT:7,12' (or 'EXCEPT' '7,12')
    # both work.
    joined = " ".join(a.strip() for a in args_picks if a is not None).strip()
    upper = joined.upper()

    if upper == "ALL":
        return "ALL"
    if upper in ("NONE", "NOTHING"):
        return "NONE"
    if upper.startswith("EXCEPT:") or upper.startswith("EXCEPT "):
        # Strip the EXCEPT prefix and parse the rest as a number list
        body = joined.split(":", 1)[-1] if ":" in joined else joined.split(None, 1)[-1]
        excl = _parse_number_list([body])
        return ("EXCEPT", excl)

    return _parse_number_list(args_picks)


def _parse_number_list(args_picks):
    """Parse a list of strings containing comma- or space-separated numbers/ranges."""
    picks = set()
    for arg in args_picks:
        arg = (arg or "").strip().upper()
        if not arg or arg in ("ALL", "NONE", "NOTHING"):
            continue
        # Handle comma- and whitespace-separated values
        for part in arg.replace(",", " ").split():
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


def send_confirmation(subject, body, to_addr=None):
    """Send a 1-line confirmation email after publishing. Silent on missing creds."""
    smtp_email = os.environ.get("SMTP_EMAIL")
    smtp_password = os.environ.get("SMTP_PASSWORD")
    if not smtp_email or not smtp_password:
        print("  [confirm] SMTP creds missing — skipping confirmation email")
        return
    smtp_host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.environ.get("SMTP_PORT", "587"))
    to_addr = to_addr or os.environ.get("NOTIFY_TO") or smtp_email

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = f"The Vic 361 <{smtp_email}>"
    msg["To"] = to_addr
    try:
        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.starttls()
            server.login(smtp_email, smtp_password)
            server.send_message(msg)
        print(f"  [confirm] Confirmation sent to {to_addr}")
    except Exception as e:
        print(f"  [confirm] Email error: {e}")


def main():
    parser = argparse.ArgumentParser(description="The Vic 361 — Approve Events")
    parser.add_argument("picks", nargs="*", help="Event numbers to approve (e.g., 1 3 5 or ALL or EXCEPT:7,12)")
    parser.add_argument("--candidates", default="./candidates.json", help="Path to candidates.json")
    parser.add_argument("--output", default="./docs/events.json", help="Output events.json path")
    parser.add_argument("--extras", default="./extras.yaml", help="Path to extras.yaml")
    parser.add_argument("--list", action="store_true", help="List candidates and exit")
    parser.add_argument("--notify", action="store_true", help="Send confirmation email after publish")
    parser.add_argument("--source", default="manual", help="Source label for confirmation email (e.g. 'reply', 'fallback')")
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
        action_label = "ALL"
        print(f"  Approving ALL {len(events)} events")
    elif picks == "NONE":
        approved = []
        action_label = "NONE"
        print("  NONE selected — publishing empty events list")
    elif isinstance(picks, tuple) and picks[0] == "EXCEPT":
        excl = picks[1]
        approved = [ev for i, ev in enumerate(events, 1) if i not in excl]
        action_label = f"ALL except {sorted(excl)}"
        print(f"  Approving {len(approved)} of {len(events)} (excluded {sorted(excl)})")
    else:
        approved = []
        for i, ev in enumerate(events, 1):
            if i in picks:
                approved.append(ev)
        action_label = f"{sorted(picks)}"
        print(f"  Approving {len(approved)} of {len(events)} candidates")

    # NONE is a valid result — the rest of the publish path proceeds normally
    # so the site clears (or stays empty) with a fresh last_updated.
    if not approved and picks != "NONE":
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
    summary_lines = []
    for d in sorted(day_counts):
        dt = datetime.strptime(d, "%Y-%m-%d")
        line = f"   {dt.strftime('%a %b %d')}: {day_counts[d]} events"
        print(line)
        summary_lines.append(line.strip())

    if args.notify:
        today = datetime.now().strftime("%a %b %d, %Y")
        source_note = {
            "reply": "based on your email reply",
            "fallback": "automatic fallback (no reply received)",
            "manual": "manually triggered",
        }.get(args.source, args.source)
        subj = f"The Vic 361 — Published {len(approved)} events for {today}"
        body = (
            f"Published {len(approved)} of {len(events)} candidates ({source_note}).\n"
            f"Picks: {action_label}\n\n"
            + "\n".join(summary_lines)
            + "\n\nLive site: https://thevic361.com"
        )
        send_confirmation(subj, body)


if __name__ == "__main__":
    main()
