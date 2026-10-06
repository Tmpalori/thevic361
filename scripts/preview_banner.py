#!/usr/bin/env python3
"""Mark a static docs/ preview as such (pr-preview.yml, staging-deploy.yml).

The live site is Express with server-rendered pages, /api routes and events
from Postgres. A GitHub Pages copy of docs/ has none of that: it shows the
old bundled events.json and forms that can't submit. A banner on every page
says so, so nobody mistakes the preview for what the PR will look like live.

    python3 scripts/preview_banner.py <dir> [label]
"""
import pathlib
import re
import sys

BANNER = (
    '<div style="position:sticky;top:0;z-index:9999;background:#7a2e00;color:#fff;'
    'font:600 14px/1.4 system-ui,sans-serif;padding:8px 12px;text-align:center">'
    "{label}: a static copy of docs/ only. Events are the old bundled list, and "
    "server pages, forms and /api calls don't work here. Use the Railway PR "
    "environment for a real preview.</div>"
)


def mark(root, label="Static preview"):
    count = 0
    for page in pathlib.Path(root).rglob("*.html"):
        html = page.read_text(encoding="utf-8")
        if "a static copy of docs/ only" in html:
            continue
        new, n = re.subn(r"(<body[^>]*>)", lambda m: m.group(1) + BANNER.format(label=label), html, count=1, flags=re.I)
        if n:
            page.write_text(new, encoding="utf-8")
            count += 1
    return count


if __name__ == "__main__":
    print(f"Marked {mark(sys.argv[1], *(sys.argv[2:3]))} pages")
