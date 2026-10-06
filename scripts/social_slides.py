"""Branded social slides: the site's look (Fredoka/Nunito, cream + ink sticker
style, day colors, category icons, skyline) instead of plain Pillow text.

Each slide is laid out as HTML and all of a kit's slides are screenshotted in
one headless Chrome run (GitHub's Ubuntu runners ship Chrome; so do most
Macs), then cut apart with Pillow. If Chrome isn't there or the render fails,
render() returns None and scripts/social_kit.py falls back to its plain
Pillow slides, so the daily post never stops over a styling problem.

The HTML builders are pure functions over (groups, dates, kind) so tests
check the markup without Chrome.
"""
import html
import os
import re
import shutil
import subprocess
import tempfile

W, H = 1080, 1350
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
DOCS = os.path.join(ROOT, "docs")

# Same palette and per-weekday colors as docs/style.css and the newsletter.
INK, CREAM, PURPLE, SUN = "#1F1A3D", "#FFF4D6", "#4B3FD1", "#FFC93C"
DAY_COLORS = ["#FFC93C", "#8FD3FF", "#FF8FC0", "#3DBE8B", "#FF7A3D", "#B9A6FF", "#FF8A80"]  # Mon..Sun
ICONS = {"food", "music", "family", "drinks", "arts", "shopping", "outdoors", "community", "free"}
KICKER = {"week": "This week", "weekend": "This weekend", "today": "Today"}
HEADLINE = {"week": "This week in", "weekend": "This weekend in", "today": "Today in"}

CHROME_PATHS = [
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def esc(s):
    return html.escape(str(s or ""), quote=True)


def _symbols():
    svg = open(os.path.join(DOCS, "icons.svg")).read()
    return re.sub(r"^.*?<svg[^>]*>|</svg>\s*$", "", svg, flags=re.S)


def _icons(ev, size=46):
    keys = [k for k in (ev.get("icons") or []) if k in ICONS][:3]
    return "".join(f'<svg class="ico" width="{size}" height="{size}"><use href="#i-{k}"/></svg>' for k in keys)


def _short_time(t):
    t = (t or "").strip()
    m = re.match(r"\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m", t, re.I)
    if not m:
        return t[:14]
    mins = f":{m.group(2)}" if m.group(2) and m.group(2) != "00" else ""
    return f"{int(m.group(1))}{mins} {m.group(3).upper()}M"


def _range(start, end):
    if start == end:
        return start.strftime("%A, %b ") + str(start.day)
    return f"{start.strftime('%a %b ')}{start.day} – {end.strftime('%a %b ')}{end.day}"


def _brand(small=False, color=INK):
    size = 64 if small else 84
    return (f'<div class="brand" style="color:{color}"><img src="file://{DOCS}/logo-512.png" width="{size}" height="{size}">'
            f'<span>The Vic <b class="pill361" style="color:{INK}">361</b></span></div>')


CSS = f"""
*{{box-sizing:border-box;margin:0;padding:0}}
html,body{{width:{W}px;background:{CREAM}}}
body{{font-family:Nunito,'Helvetica Neue',Arial,sans-serif;color:{INK}}}
.slide{{width:{W}px;height:{H}px;position:relative;overflow:hidden;background:{CREAM}}}
.dots{{position:absolute;inset:0;background-image:radial-gradient(rgba(31,26,61,.09) 3px,transparent 3.5px);background-size:44px 44px}}
.sky{{position:absolute;left:-120px;right:-120px;bottom:0;height:230px;background:url(file://{DOCS}/skyline.svg) center bottom/cover no-repeat}}
.disp{{font-family:Fredoka,'Trebuchet MS',sans-serif;font-weight:700;letter-spacing:-.5px;line-height:1.04}}
.brand{{display:flex;align-items:center;gap:16px;font-family:Fredoka;font-weight:700;font-size:44px}}
.brand img{{border-radius:50%}}
.pill361{{display:inline-block;background:{SUN};border:4px solid {INK};border-radius:14px;padding:0 12px;font-size:36px;line-height:1.25}}
.pill{{display:inline-block;border:5px solid {INK};border-radius:999px;padding:6px 26px;font-family:Fredoka;font-weight:700;background:#fff}}
.hl{{background:linear-gradient(transparent 55%,{SUN} 55%,{SUN} 92%,transparent 92%);padding:0 6px}}
.card{{background:#fff;border:6px solid {INK};border-radius:40px;box-shadow:14px 14px 0 {INK};overflow:hidden}}
.ico{{vertical-align:middle;margin-right:4px}}
.tag{{display:inline-block;border:3px solid {INK};border-radius:999px;padding:1px 14px;font-family:Fredoka;font-weight:700;font-size:24px;margin-left:10px;vertical-align:middle}}
.clamp2{{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}}
.one{{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.foot{{position:absolute;left:64px;right:64px;bottom:38px;display:flex;justify-content:space-between;align-items:center;font-family:Fredoka;font-weight:700;font-size:34px}}
"""


def cover_html(groups, start, end, kind):
    events = [e for evs in groups.values() for e in evs]
    total = len(events)
    picks = ([e for e in events if e.get("featured")] + [e for e in events if not e.get("featured")])[:3]
    rows = "".join(
        f'<div class="card pick" style="padding:18px 30px;border-radius:30px;box-shadow:10px 10px 0 {INK};transform:rotate({r}deg)"><div class="one disp" style="font-size:40px">{_icons(e, 42)} {esc(e["name"])}</div>'
        f'<div class="one" style="font-size:28px;font-weight:800;color:#554E7A;margin-top:6px">'
        f'{esc(_day_label(e, kind))}{" · " + esc(e.get("venue")) if e.get("venue") else ""}</div></div>'
        for e, r in zip(picks, (-1.2, 0.8, -0.6)))
    count = f"{total} thing{'s' if total != 1 else ''} to do" if total else "Nothing listed yet"
    return f"""<section class="slide"><div class="dots"></div><div class="sky"></div>
<div style="position:absolute;left:64px;right:64px;top:56px">
  {_brand()}
  <div class="pill" style="background:#FF8FC0;font-size:34px;margin-top:40px;transform:rotate(-2deg)">{esc(KICKER[kind].upper())}</div>
  <div class="disp" style="font-size:96px;margin-top:20px">{esc(HEADLINE[kind])}<br><span class="hl">Victoria, TX</span></div>
  <div style="display:flex;gap:20px;align-items:center;margin-top:30px">
    <div class="pill" style="font-size:34px">{esc(_range(start, end))}</div>
    <div class="disp" style="font-size:46px;color:{PURPLE}">{esc(count)}</div>
  </div>
  <div class="picks" style="display:grid;gap:22px;margin-top:34px">{rows}</div>
  <div style="text-align:right;margin-top:30px"><span class="pill" style="background:{SUN};font-size:36px;box-shadow:8px 8px 0 {INK}">Swipe for a peek →</span></div>
</div>
</section>"""


def _day_label(e, kind):
    from datetime import date
    try:
        d = date.fromisoformat(e["date"])
        day = "" if kind == "today" else d.strftime("%a") + " · "
    except (KeyError, ValueError):
        day = ""
    return day + (_short_time(e.get("time")) or "")


DIGEST_PER_DAY = 2       # a sneak peek per day; the site has the rest
DIGEST_TODAY = 6         # "today" has a single day, so it can show a few more


def _digest_day(day, evs, per_day, first, compact=False):
    """One day in the sneak-peek slide: weekday chip, up to per_day events
    (Vic's Picks / sponsored first; select_events sorts them to the top),
    then "+ N more". compact shrinks it so a full week (7 days) fits."""
    color = DAY_COLORS[day.weekday()]
    name_px, time_px, more_px, pad = (29, 24, 24, 9) if compact else (33, 28, 28, 16)
    items = "".join(
        f'<div class="one" style="font-size:{name_px}px;font-weight:900;line-height:1.25">'
        f'{"<span style=color:#FF7A3D>★</span> " if e.get("featured") else ""}'
        f'<span style="font-family:Fredoka;font-weight:700;color:#554E7A;font-size:{time_px}px">{esc(_short_time(e.get("time")))}</span> '
        f'{esc(e["name"])}</div>'
        for e in evs[:per_day])
    more = (f'<div style="font-family:Fredoka;font-weight:700;font-size:{more_px}px;color:{PURPLE};line-height:1.3">'
            f'+ {len(evs) - per_day} more</div>') if len(evs) > per_day else ""
    sep = "" if first else "border-top:4px dashed #E8D9AE;"
    chip = (f'<div style="background:{color};border:4px solid {INK};border-radius:18px;text-align:center;padding:{2 if compact else 6}px 0">'
            f'<div class="disp" style="font-size:{28 if compact else 34}px">{esc(day.strftime("%a").upper())}</div>'
            f'<div style="font-family:Fredoka;font-weight:700;font-size:{20 if compact else 24}px">{esc(day.strftime("%b ") + str(day.day))}</div></div>')
    return (f'<div style="display:grid;grid-template-columns:{124 if compact else 150}px 1fr;gap:20px;align-items:start;padding:{pad}px 28px;{sep}">'
            f'{chip}<div style="min-width:0">{items}{more}</div></div>')


def digest_html(groups, start, end, kind):
    """Slide 2: the sneak peek. Every day of the kit with a couple of events
    each, so people see the range, then go to the site for the rest."""
    per_day = DIGEST_TODAY if kind == "today" else DIGEST_PER_DAY
    compact = len(groups) > 4  # a full week: 7 days must fit the card
    days = "".join(_digest_day(d, evs, per_day, i == 0, compact) for i, (d, evs) in enumerate(groups.items()))
    total = sum(len(v) for v in groups.values())
    return f"""<section class="slide"><div class="dots"></div>
<div style="position:absolute;left:64px;right:64px;top:48px;display:flex;justify-content:space-between;align-items:center">
  {_brand(small=True)}<div class="pill" style="font-size:28px">{esc(KICKER[kind])}</div>
</div>
<div class="disp" style="position:absolute;left:64px;top:140px;font-size:60px">A peek at {"today" if kind == "today" else "the list"} <span style="font-size:40px;color:{PURPLE}">({total} in all)</span></div>
<div class="card" style="position:absolute;left:64px;right:78px;top:228px;max-height:1010px">{days}</div>
<div class="foot"><span style="color:{PURPLE}">See them all at thevic361.com</span><span style="font-size:30px">→</span></div>
</section>"""


def cta_html(total=0):
    """Slide 3: send them to the site for everything, then the newsletter."""
    see_all = f"All {total} events" if total else "The full list"
    return f"""<section class="slide" style="background:{PURPLE}"><div class="sky" style="opacity:.95"></div>
<div style="position:absolute;left:72px;right:72px;top:80px;color:#fff">
  {_brand(color="#fff")}
  <div class="disp" style="font-size:104px;margin-top:64px">{esc(see_all)}<br>{"are" if total else "is"} on <span style="color:{SUN}">the site.</span></div>
  <div class="pill" style="margin-top:44px;font-size:56px;background:{SUN};color:{INK};box-shadow:10px 10px 0 {INK}">thevic361.com</div>
  <div style="font-size:44px;font-weight:800;margin-top:60px;opacity:.95">📬 Get the list <span style="color:{SUN}">free</span> every Monday:<br>thevic361.com/subscribe</div>
  <div style="font-size:32px;font-weight:800;margin-top:40px;opacity:.85">Hosting something? Submit it free at thevic361.com/submit</div>
</div>
</section>"""


def slides_html(groups, start, end, kind):
    """(file names, full HTML document) for one kit: three slides, a teaser
    not the whole list: cover with highlights, the day-by-day peek, and the
    call to see everything on the site."""
    total = sum(len(v) for v in groups.values())
    parts = [cover_html(groups, start, end, kind)]
    if groups:
        parts.append(digest_html(groups, start, end, kind))
    parts.append(cta_html(total))
    names = [f"{kind}-{n}.png" for n in range(1, len(parts) + 1)]
    doc = f"""<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@600;700&family=Nunito:wght@700;800;900&display=block" rel="stylesheet">
<style>{CSS}</style></head><body><svg style="display:none">{_symbols()}</svg>{''.join(parts)}</body></html>"""
    return names, doc


def find_chrome():
    for c in CHROME_PATHS:
        p = shutil.which(c) or (c if os.path.exists(c) else None)
        if p:
            return p
    return None


def render(groups, start, end, kind, out_dir, chrome=None, batch=10):
    """Render the kit's slides into out_dir. Returns file names, or None when
    Chrome is missing or fails (the caller then uses the plain slides)."""
    chrome = chrome or find_chrome()
    if not chrome:
        print("Branded slides skipped: Chrome not found; using plain slides.")
        return None
    from PIL import Image
    names, doc = slides_html(groups, start, end, kind)
    sections = re.findall(r'<section class="slide".*?</section>', doc, flags=re.S)
    head, tail = doc.split("<section", 1)[0], "</body></html>"
    try:
        with tempfile.TemporaryDirectory() as tmp:
            done = 0
            for b in range(0, len(sections), batch):
                chunk = sections[b:b + batch]
                page = os.path.join(tmp, f"slides{b}.html")
                shot = os.path.join(tmp, f"slides{b}.png")
                with open(page, "w") as f:
                    f.write(head + "".join(chunk) + tail)
                subprocess.run([chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
                                "--force-device-scale-factor=1", f"--window-size={W},{H * len(chunk)}",
                                "--virtual-time-budget=10000", "--allow-file-access-from-files",
                                f"--screenshot={shot}", "file://" + page],
                               check=True, capture_output=True, timeout=120)
                img = Image.open(shot).convert("RGB")
                if img.height < H * len(chunk):
                    raise RuntimeError(f"screenshot too short ({img.height}px for {len(chunk)} slides)")
                for i in range(len(chunk)):
                    img.crop((0, i * H, W, (i + 1) * H)).save(os.path.join(out_dir, names[done]), optimize=True)
                    done += 1
        return names
    except (subprocess.SubprocessError, OSError, RuntimeError) as e:
        print(f"Branded slides failed ({e}); using plain slides.")
        return None
