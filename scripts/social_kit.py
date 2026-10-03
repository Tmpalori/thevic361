#!/usr/bin/env python3
"""Build the weekly social kit from the live published events.

Runs on a schedule (.github/workflows/social-kit.yml) and writes
docs/social/latest/:
  - week-N.png / weekend-N.png   Instagram/Facebook slides (1080x1350)
  - captions.txt                 Facebook + Instagram captions
  - index.html                   phone-friendly page to save slides and copy captions

The page is served at /social/latest/ (noindex, disallowed in robots.txt),
so posting each week is: open the page, save the slides, paste a caption.

Pure helpers (select_events, captions) have no Pillow dependency so they
test without it.
"""
import argparse
import html
import json
import os
import sys
import textwrap
import urllib.request
from datetime import date, datetime, timedelta

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

SITE = os.environ.get("SITE_URL", "https://www.thevic361.com").rstrip("/")
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "docs", "social", "latest")
PER_SLIDE = 6
PER_DAY_CAPTION = 4

HASHTAGS = "#VictoriaTX #ThingsToDoVictoria #VictoriaTexas #361 #TheVic361"


def today_central():
    if ZoneInfo:
        return datetime.now(ZoneInfo("America/Chicago")).date()
    return date.today()


def week_bounds(today):
    """Rest of this week: today (or Monday) through Sunday. The Thursday
    run shouldn't post Monday–Wednesday events that already happened."""
    monday = today - timedelta(days=today.weekday())
    return max(monday, today), monday + timedelta(days=6)


def weekend_bounds(today):
    monday = today - timedelta(days=today.weekday())
    friday, sunday = monday + timedelta(days=4), monday + timedelta(days=6)
    return max(friday, today), sunday


def _time_key(t):
    import re
    m = re.search(r"(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m", t or "", re.I)
    if not m:
        return 9999
    h = int(m.group(1)) % 12 + (12 if m.group(3).lower() == "p" else 0)
    return h * 60 + int(m.group(2) or 0)


def select_events(events, start, end):
    """Events between start and end (dates), grouped by date, featured first."""
    out = {}
    for ev in events or []:
        try:
            d = date.fromisoformat(ev.get("date", ""))
        except ValueError:
            continue
        if start <= d <= end and ev.get("name"):
            out.setdefault(d, []).append(ev)
    for d in out:
        out[d].sort(key=lambda e: (not e.get("featured"), _time_key(e.get("time"))))
    return dict(sorted(out.items()))


def _short_time(t):
    """'7:00 PM – 10:00 PM' → '7 PM'; '10am - 3pm' → '10 AM'."""
    import re
    m = re.search(r"(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m", t or "", re.I)
    if not m:
        return ""
    mins = f":{m.group(2)}" if m.group(2) and m.group(2) != "00" else ""
    return f"{int(m.group(1))}{mins} {m.group(3).upper()}M"


def _line(ev):
    t = _short_time(ev.get("time"))
    venue = f" @ {ev['venue']}" if ev.get("venue") else ""
    free = " (free)" if ev.get("free") else ""
    return f"• {t + ' ' if t else ''}{ev['name']}{venue}{free}"


def _range_label(start, end):
    if start.month == end.month:
        return f"{start.strftime('%b')} {start.day}–{end.day}" if start != end else f"{start.strftime('%b')} {start.day}"
    return f"{start.strftime('%b')} {start.day}–{end.strftime('%b')} {end.day}"


def captions(groups, start, end, kind):
    """Return {'facebook': str, 'instagram': str} for a week or weekend."""
    title = "This weekend in Victoria, TX" if kind == "weekend" else "This week in Victoria, TX"
    path = "/this-weekend" if kind == "weekend" else "/"
    body = []
    total = sum(len(v) for v in groups.values())
    for d, evs in groups.items():
        body.append(d.strftime("%A").upper())
        body.extend(_line(e) for e in evs[:PER_DAY_CAPTION])
        if len(evs) > PER_DAY_CAPTION:
            body.append(f"…plus {len(evs) - PER_DAY_CAPTION} more")
        body.append("")
    if not groups:
        body = ["Nothing listed yet. Know something happening? Submit it at thevic361.com/submit", ""]
    head = f"{title} ({_range_label(start, end)}): {total} events" if total else f"{title} ({_range_label(start, end)})"
    fb = "\n".join([head, ""] + body + [f"Full list and details: {SITE}{path}", "", HASHTAGS])
    ig = "\n".join([head, ""] + body + ["Full list: link in bio (thevic361.com)", "", HASHTAGS])
    return {"facebook": fb.strip() + "\n", "instagram": ig.strip() + "\n"}


# ─── Rendering (Pillow) ──────────────────────────────────────────────────

W, H = 1080, 1350
BG = (250, 245, 228)
INK = (30, 27, 51)
MUTED = (92, 88, 120)
ACCENT = (78, 71, 184)
CARD = (255, 251, 236)

FONT_DIRS = ["/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu", "/Library/Fonts"]


def _font(bold, size):
    from PIL import ImageFont
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    for d in FONT_DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def _wrap(draw, text, font, width):
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if draw.textlength(trial, font=font) <= width:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


LOGO = os.path.join(os.path.dirname(__file__), "..", "docs", "logo.png")


def _header(draw, kicker, title):
    draw.rectangle([0, 0, W, 300], fill=ACCENT)
    try:
        from PIL import Image
        logo = Image.open(LOGO).convert("RGBA").resize((128, 128))
        draw._image.paste(logo, (W - 72 - 128, 60), logo)
    except Exception:
        pass  # slides are fine without the badge
    draw.text((72, 70), kicker.upper(), font=_font(True, 34), fill=(232, 230, 247))
    y = 120
    for line in _wrap(draw, title, _font(True, 70), W - 144 - 150)[:2]:
        draw.text((72, y), line, font=_font(True, 70), fill=(255, 251, 236))
        y += 84


def _footer(draw, text="thevic361.com"):
    draw.text((72, H - 100), text, font=_font(True, 36), fill=ACCENT)


def render_slides(groups, start, end, kind, out_dir):
    from PIL import Image, ImageDraw
    title = "This Weekend in Victoria" if kind == "weekend" else "This Week in Victoria"
    files = []

    def new():
        img = Image.new("RGB", (W, H), BG)
        return img, ImageDraw.Draw(img)

    # Cover
    img, d = new()
    _header(d, "The Vic 361", title)
    total = sum(len(v) for v in groups.values())
    d.text((72, 380), _range_label(start, end), font=_font(True, 64), fill=INK)
    d.text((72, 470), f"{total} things to do" if total else "Nothing listed yet", font=_font(False, 48), fill=MUTED)
    y = 600
    for e in [e for evs in groups.values() for e in evs if e.get("featured")][:3] or \
             [e for evs in groups.values() for e in evs][:3]:
        for line in _wrap(d, f"• {e['name']}", _font(True, 40), W - 144)[:2]:
            d.text((72, y), line, font=_font(True, 40), fill=INK)
            y += 54
        y += 10
    d.text((72, H - 200), "Swipe for the full list →", font=_font(False, 40), fill=MUTED)
    _footer(d)
    files.append(img)

    # One slide per day (split when a day has more than PER_SLIDE events)
    for day, evs in groups.items():
        for i in range(0, len(evs), PER_SLIDE):
            img, d = new()
            chunk = evs[i:i + PER_SLIDE]
            _header(d, day.strftime("%B ") + str(day.day), day.strftime("%A"))
            y = 350
            for e in chunk:
                t = _short_time(e.get("time"))
                if t:
                    d.text((72, y), t, font=_font(True, 34), fill=ACCENT)
                name_lines = _wrap(d, e["name"], _font(True, 40), W - 144 - 200)[:2]
                ny = y
                for line in name_lines:
                    d.text((272, ny), line, font=_font(True, 40), fill=INK)
                    ny += 50
                if e.get("venue"):
                    d.text((272, ny), _wrap(d, e["venue"], _font(False, 32), W - 344)[0], font=_font(False, 32), fill=MUTED)
                    ny += 42
                y = max(ny, y + 60) + 34
                if y > H - 180:
                    break
            _footer(d)
            files.append(img)

    # CTA
    img, d = new()
    _header(d, "Never miss a thing", "Get the full list every week")
    for i, line in enumerate(["Every event, every day, in one place:", "thevic361.com", "",
                              "Have an event? Submit it free.", "Own a venue? Become a Vic’s Pick."]):
        d.text((72, 400 + i * 80), line, font=_font(i in (1,), 52 if i == 1 else 44), fill=ACCENT if i == 1 else INK)
    _footer(d)
    files.append(img)

    names = []
    for n, img in enumerate(files, 1):
        name = f"{kind}-{n}.png"
        img.save(os.path.join(out_dir, name), optimize=True)
        names.append(name)
    return names


def render_page(kits, generated_at):
    sections = []
    for kind, kit in kits.items():
        imgs = "".join(f'<a href="{n}" download><img src="{n}" alt="{kind} slide {i}" loading="lazy"></a>'
                       for i, n in enumerate(kit["slides"], 1))
        caps = "".join(
            f'<h3>{label}</h3><textarea id="{kind}-{key}" readonly>{html.escape(kit["captions"][key])}</textarea>'
            f'<button type="button" data-copy="{kind}-{key}">Copy {label} caption</button>'
            for key, label in (("facebook", "Facebook"), ("instagram", "Instagram")))
        sections.append(f'<section><h2>{"This weekend" if kind == "weekend" else "This week"}</h2>'
                        f'<div class="slides">{imgs}</div>{caps}</section>')
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Social kit | The Vic 361</title>
<style>
body{{font:16px/1.5 system-ui,sans-serif;background:#FAF5E4;color:#1E1B33;margin:0;padding:16px;max-width:900px;margin-inline:auto}}
h1{{font-size:1.5rem;margin:0 0 4px}} .meta{{color:#5C5878;margin:0 0 16px}}
.slides{{display:flex;gap:8px;overflow-x:auto;padding-bottom:8px}} .slides img{{height:260px;border-radius:6px;border:1px solid #CFC9B2}}
textarea{{width:100%;min-height:180px;font:14px/1.4 ui-monospace,monospace;box-sizing:border-box;padding:8px;border:1px solid #CFC9B2;border-radius:6px}}
button{{font:inherit;margin:6px 0 16px;padding:8px 14px;border-radius:999px;border:0;background:#4E47B8;color:#fff}}
</style></head><body>
<h1>Social kit</h1><p class="meta">Generated {html.escape(generated_at)} from the published events. Tap a slide to save it, then copy a caption.</p>
{''.join(sections)}
<script>
document.addEventListener('click',function(e){{var b=e.target.closest('[data-copy]');if(!b)return;
var t=document.getElementById(b.getAttribute('data-copy'));t.select();
(navigator.clipboard?navigator.clipboard.writeText(t.value):Promise.reject()).then(function(){{b.textContent='Copied';}},function(){{document.execCommand('copy');b.textContent='Copied';}});}});
</script></body></html>
"""


def fetch_events(url):
    req = urllib.request.Request(url, headers={"User-Agent": "TheVic361-SocialKit/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8")).get("events", [])


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--events-url", default=f"{SITE}/events.json")
    ap.add_argument("--events-file", help="Read events from a local JSON file instead")
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--today", help="YYYY-MM-DD (for testing)")
    args = ap.parse_args(argv)

    if args.events_file:
        with open(args.events_file) as f:
            events = json.load(f).get("events", [])
    else:
        events = fetch_events(args.events_url)
    today = date.fromisoformat(args.today) if args.today else today_central()
    os.makedirs(args.out, exist_ok=True)
    for old in os.listdir(args.out):
        if old.endswith(".png"):
            os.remove(os.path.join(args.out, old))

    kits = {}
    for kind, (start, end) in (("week", week_bounds(today)), ("weekend", weekend_bounds(today))):
        groups = select_events(events, start, end)
        caps = captions(groups, start, end, kind)
        slides = render_slides(groups, start, end, kind, args.out)
        kits[kind] = {"captions": caps, "slides": slides, "count": sum(len(v) for v in groups.values())}
        print(f"{kind}: {sum(len(v) for v in groups.values())} events, {len(slides)} slides")

    # Manifest for scripts/social_post.py (auto-posting).
    with open(os.path.join(args.out, "kit.json"), "w") as f:
        json.dump({
            "generated_for": today.isoformat(),
            "kits": {k: {"slides": v["slides"], "captions": v["captions"],
                         "events": v["count"]} for k, v in kits.items()},
        }, f, indent=2, ensure_ascii=False)

    with open(os.path.join(args.out, "captions.txt"), "w") as f:
        for kind, kit in kits.items():
            f.write(f"===== {kind.upper()} · FACEBOOK =====\n{kit['captions']['facebook']}\n")
            f.write(f"===== {kind.upper()} · INSTAGRAM =====\n{kit['captions']['instagram']}\n")
    stamp = datetime.now(ZoneInfo("America/Chicago")).strftime("%a %b %d, %I:%M %p CT") if ZoneInfo else str(today)
    with open(os.path.join(args.out, "index.html"), "w") as f:
        f.write(render_page(kits, stamp))
    return 0


if __name__ == "__main__":
    sys.exit(main())
