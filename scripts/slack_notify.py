#!/usr/bin/env python3
"""Post a one-line message to Slack from a GitHub Actions step.

Reads SLACK_WEBHOOK_URL (repo secret). Unset means do nothing, and a Slack
failure never fails the job: a notification must not turn a green run red.

    python3 scripts/slack_notify.py "🚨 Weekly collect failed" [--link URL]

The text is sent as mrkdwn as given, so callers can include links; run
anything that came from outside (event names, AI text) through escape().
"""
import json
import os
import sys
import urllib.request


def escape(text):
    """Text safe to drop into Slack mrkdwn: &, < and > are control characters
    there (a name like "Fest <!channel>" would ping everyone or break a
    link), so they go as entities. Same as slackEscape in server/slack.js."""
    return str(text if text is not None else "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def main(argv):
    url = os.environ.get("SLACK_WEBHOOK_URL", "").strip()
    if not url.startswith("https://hooks.slack.com/"):
        print("SLACK_WEBHOOK_URL not set; skipping Slack notification.")
        return 0
    args = list(argv)
    link = None
    if "--link" in args:
        i = args.index("--link")
        link = args[i + 1] if i + 1 < len(args) else None
        del args[i:i + 2]
    text = " ".join(args).strip() or "(no message)"
    if link:
        text += f" <{link}|Open>"
    req = urllib.request.Request(url, data=json.dumps({"text": text}).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as e:  # noqa: BLE001 - best effort by design
        print(f"Slack notification failed: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
