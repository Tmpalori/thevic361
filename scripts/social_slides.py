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
PER_SLIDE = 5  # rows are up to ~180px with a two-line name; 5 always fit the card

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
  <div style="text-align:right;margin-top:30px"><span class="pill" style="background:{SUN};font-size:36px;box-shadow:8px 8px 0 {INK}">Swipe for the full list →</span></div>
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


def _event_row(e, first):
    """Time in a fixed left column (like the site's lists); name (up to two
    lines), then venue, icons and Vic's Pick / Free tags on one line."""
    time = _short_time(e.get("time"))
    tags = ""
    if e.get("featured"):
        tags += '<span class="tag" style="background:#FF7A3D">★ Vic’s Pick</span>'
    if e.get("free"):
        tags += '<span class="tag" style="background:#3DBE8B">Free</span>'
    time_pill = (f'<span class="pill" style="font-size:26px;padding:2px 14px;border-width:4px">{esc(time)}</span>'
                 if time else "")
    venue = f'<span class="one" style="min-width:0">{esc(e["venue"])}</span>' if e.get("venue") else ""
    sep = "" if first else "border-top:4px dashed #E8D9AE;"
    return (f'<div class="row" style="display:grid;grid-template-columns:150px 1fr;gap:18px;padding:18px 34px;{sep}">'
            f'<div style="padding-top:4px">{time_pill}</div>'
            f'<div style="min-width:0"><div class="disp clamp2" style="font-size:40px">{esc(e["name"])}</div>'
            f'<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:27px;font-weight:800;color:#554E7A">'
            f'{_icons(e, 34)}{venue}{tags}</div></div></div>')


def day_html(day, evs, kind, part=None):
    """One day, styled like the site's day cards: weekday color band, date
    pill, then the events (time, icons, Vic's Pick / Free tags, venue)."""
    color = DAY_COLORS[day.weekday()]
    rows = "".join(_event_row(e, i == 0) for i, e in enumerate(evs))
    more = f' <span style="font-size:30px;opacity:.7">(part {part})</span>' if part else ""
    return f"""<section class="slide"><div class="dots"></div>
<div style="position:absolute;left:64px;right:64px;top:48px;display:flex;justify-content:space-between;align-items:center">
  {_brand(small=True)}<div class="pill" style="font-size:28px">{esc(KICKER[kind])}</div>
</div>
<div class="card" style="position:absolute;left:64px;right:78px;top:160px;max-height:1050px">
  <div style="background:{color};border-bottom:6px solid {INK};padding:26px 40px;display:flex;align-items:center;gap:22px">
    <span class="disp" style="font-size:76px">{esc(day.strftime('%A'))}</span>
    <span class="pill" style="font-size:32px">{esc(day.strftime('%B ') + str(day.day))}</span>{more}
  </div>
  {rows}
</div>
<div class="foot"><span style="color:{PURPLE}">thevic361.com</span><span style="font-size:28px;color:#554E7A">Details &amp; more every day →</span></div>
</section>"""


def cta_html():
    return f"""<section class="slide" style="background:{PURPLE}"><div class="sky" style="opacity:.95"></div>
<div style="position:absolute;left:72px;right:72px;top:80px;color:#fff">
  {_brand(color="#fff")}
  <div class="disp" style="font-size:118px;margin-top:70px">Get the list<br><span style="color:{SUN}">free</span> every<br>Monday.</div>
  <div style="font-size:44px;font-weight:800;margin-top:30px;opacity:.95">Victoria’s best events, in your inbox.</div>
  <div class="pill" style="margin-top:56px;font-size:52px;background:{SUN};color:{INK};box-shadow:10px 10px 0 {INK}">thevic361.com/subscribe</div>
  <div style="font-size:34px;font-weight:800;margin-top:54px;opacity:.9">Hosting something? Submit it free at thevic361.com/submit</div>
</div>
</section>"""


def slides_html(groups, start, end, kind):
    """(file names, full HTML document) for one kit: cover, day slides, CTA."""
    parts, names = [cover_html(groups, start, end, kind)], [f"{kind}-1.png"]
    for day, evs in groups.items():
        # Even split (12 events: 4/4/4, not 5/5/2), at most PER_SLIDE each.
        n_chunks = max(1, -(-len(evs) // PER_SLIDE))
        size = -(-len(evs) // n_chunks) if evs else 0
        chunks = [evs[i:i + size] for i in range(0, len(evs), size)] if evs else [[]]
        for n, chunk in enumerate(chunks, 1):
            if not chunk:
                continue
            parts.append(day_html(day, chunk, kind, part=n if len(chunks) > 1 else None))
            names.append(f"{kind}-{len(names) + 1}.png")
    parts.append(cta_html())
    names.append(f"{kind}-{len(names) + 1}.png")
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
