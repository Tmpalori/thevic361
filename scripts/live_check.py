#!/usr/bin/env python3
"""Did a deploy change what Victoria serves? (MULTI_CITY_PLAN.md, Phase 0.4.)

Fetches the public pages of the live site, normalizes the parts that change
on their own (asset ?v= hashes, clock timestamps, sitemap dates, the
.ics DTSTAMP; event start times are kept), saves them under
DIR/<UTC time>/ and diffs them against the previous run in DIR. Run it right
before a deploy and right after: an empty diff means visitors see the same
site.

    python3 scripts/live_check.py [--site https://www.thevic361.com] [--dir .live-check]

Pages: a fixed list (home, about, privacy, advertise and its checkout form,
subscribe, contact, submit, venues, a 404, events.json, sitemap, llms.txt,
robots, pixel.js, /api/config, /api/health?deep=1), every other page in
/sitemap.xml except events and venues (the hubs and seasonal guides), the
first 4 event pages in /events.json with their .ics, and the first venue.
GET only; nothing is posted, nothing needs a key.

Exits 1 when something differs or a page doesn't answer, 0 otherwise (the
first run has nothing to compare with). Event pages come and go with the
calendar, so compare runs from the same day.
"""
import argparse
import datetime as dt
import difflib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

SITE = "https://www.thevic361.com"
UA = "thevic361-live-check/1.0 (+https://github.com/Tmpalori/thevic361)"
TIMEOUT = 30
MAX_DIFF_LINES = 40     # per page, in the printed report

FIXED = ["/", "/about", "/privacy", "/advertise", "/advertise/checkout?package=weekly",
         "/advertise/checkout?package=featured", "/subscribe", "/referral-rules", "/contact",
         "/submit", "/venues", "/live-check-no-such-page", "/events.json", "/events.json?all=1",
         "/sitemap.xml", "/llms.txt", "/robots.txt", "/pixel.js", "/api/config", "/api/health?deep=1"]


def fetch(url, timeout=TIMEOUT, headers=None):
    """(status, content type, redirect location, text). Status 0 when there's no answer."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Cache-Control": "no-cache", **(headers or {})})
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, r.headers.get("Content-Type", ""), "", r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        return e.code, e.headers.get("Content-Type", ""), e.headers.get("Location", ""), body
    except Exception as e:  # noqa: BLE001 - any failure is "didn't answer"
        return 0, "", "", f"no answer: {e}"


def normalize(text):
    """Remove what changes without a deploy changing anything."""
    text = re.sub(r"\?v=[0-9a-f]{6,}", "?v=HASH", text)
    # Clock stamps (UTC "Z", or with fractional seconds: when the feed was
    # published, when the page was built). Event times carry the town's
    # offset ("2026-10-09T18:00:00-05:00") and are kept: a timezone slip
    # must show up here.
    text = re.sub(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+Z?|Z)", "TIMESTAMP", text)
    text = re.sub(r"<lastmod>[^<]*</lastmod>", "<lastmod>DATE</lastmod>", text)
    text = re.sub(r"DTSTAMP:\d{8}T\d{6}Z", "DTSTAMP:TIMESTAMP", text)   # .ics: the time of the request
    return text


def file_name(path):
    return ("home" if path == "/" else re.sub(r"[/?=&.]+", "_", path.lstrip("/"))) + ".txt"


def discover(site, fetch=fetch):
    """Hubs and guides from the sitemap, 4 events (+ .ics) and a venue."""
    paths = []
    _, _, _, sitemap = fetch(site + "/sitemap.xml")
    for loc in re.findall(r"<loc>([^<]+)</loc>", sitemap):
        p = urllib.parse.urlsplit(loc).path or "/"
        if not p.startswith(("/events/", "/venues/")) and p not in FIXED:
            paths.append(p)
    _, _, _, feed = fetch(site + "/events.json")
    try:
        events = json.loads(feed).get("events", [])
    except ValueError:
        events = []
    for page in [e["page"] for e in events if isinstance(e, dict) and e.get("page")][:4]:
        paths += [page, page + ".ics"]
    _, _, _, venues = fetch(site + "/venues")
    m = re.search(r'href="(/venues/[a-z0-9-]+)"', venues)
    if m:
        paths.append(m.group(1))
    return paths


def snapshot(site, out_dir, fetch=fetch):
    """Save every page; return {file: text} and the paths that didn't answer."""
    site = site.rstrip("/")
    pages, down = {}, []
    for path in dict.fromkeys(FIXED + discover(site, fetch)):
        status, ctype, location, body = fetch(site + path)
        if status == 0:
            down.append(path)
        pages[file_name(path)] = f"{path}\n{status} {ctype}{f' -> {location}' if location else ''}\n\n{normalize(body)}"
    os.makedirs(out_dir, exist_ok=True)
    for name, text in pages.items():
        with open(os.path.join(out_dir, name), "w", newline="") as f:
            f.write(text)
    return pages, down


def load(run_dir):
    out = {}
    for name in sorted(os.listdir(run_dir)):
        with open(os.path.join(run_dir, name), newline="") as f:
            out[name] = f.read()
    return out


def compare(before, after):
    """Report lines for every page that was added, removed or changed."""
    lines = []
    for name in sorted(set(before) | set(after)):
        if name not in after:
            lines.append(f"− gone: {before[name].splitlines()[0]}")
        elif name not in before:
            lines.append(f"+ new: {after[name].splitlines()[0]}")
        elif before[name] != after[name]:
            lines.append(f"~ changed: {after[name].splitlines()[0]}")
            diff = list(difflib.unified_diff(before[name].splitlines(), after[name].splitlines(), "before", "after", n=1, lineterm=""))[2:]
            lines += ["    " + d[:200] for d in diff[:MAX_DIFF_LINES]]
            if len(diff) > MAX_DIFF_LINES:
                lines.append(f"    … {len(diff) - MAX_DIFF_LINES} more lines")
    return lines


def main(argv=None, fetch=fetch, now=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--site", default=SITE)
    ap.add_argument("--dir", default=".live-check", help="where runs are kept (default .live-check)")
    args = ap.parse_args(argv)
    stamp = (now or dt.datetime.now(dt.timezone.utc)).strftime("%Y%m%dT%H%M%SZ")
    runs = sorted(d for d in os.listdir(args.dir) if os.path.isdir(os.path.join(args.dir, d))) if os.path.isdir(args.dir) else []
    out_dir = os.path.join(args.dir, stamp)
    pages, down = snapshot(args.site, out_dir, fetch)
    print(f"Saved {len(pages)} pages from {args.site} to {out_dir}")
    for p in down:
        print(f"! no answer: {p}")
    if not runs:
        print("First run: nothing to compare with. Run it again after the deploy.")
        return 1 if down else 0
    report = compare(load(os.path.join(args.dir, runs[-1])), pages)
    if report:
        print(f"Differences from {runs[-1]}:")
        print("\n".join(report))
    else:
        print(f"Same as {runs[-1]}: no differences.")
    return 1 if report or down else 0


if __name__ == "__main__":
    sys.exit(main())
