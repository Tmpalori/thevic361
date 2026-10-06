# Agent Instructions — The Vic 361

Read this file first if you are a coding agent (Codex, Claude Code, Cursor, etc.) about to make a change to this repo. It tells you how the system works, what you are and aren't allowed to touch, how to run the tests, and which invariants matter.

The companion files `CLAUDE.md` and `.cursorrules` redirect to this document so every agent flavor lands on the same source of truth.

---

## What this is

**The Vic 361** is a weekly community-events website for Victoria, TX (population ~65k). It collects events from public calendars and Apify-scraped Facebook/Instagram (OpenAI extracts events from posts and polishes descriptions) twice a week (Sunday and Wednesday afternoons); the site auto-publishes the new candidates when it redeploys, AI reviews free submissions and an event check hides obvious junk, and the owner steps in from the admin only for exceptions; the published list is served from Railway Postgres at [www.thevic361.com](https://www.thevic361.com).

- **Live site:** [www.thevic361.com](https://www.thevic361.com) — Railway (Express + Postgres)
- **Repo:** `Tmpalori/thevic361` (this repo)
- **Owner:** Tristen Palori ([tristen.m.palori@gmail.com](mailto:tristen.m.palori@gmail.com))

Production hosting:

- `www.thevic361.com` is a CNAME to `oln7ktx9.up.railway.app`. This is the canonical host (`SITE_URL`); always link to www.
- Apex `thevic361.com` resolves to Squarespace (domain forwarding), not Railway. It forwards `/path` to `www.thevic361.com//path`, which 404s, so only the bare homepage works on the apex. The Express apex → www redirect in `server/index.js` never sees apex traffic today.
- DNS is managed in Squarespace.
- Railway environments: `production`, `staging`, and PR-environments (auto-created per open PR, auto-destroyed on PR close). Each has its own forked Postgres.

---

## Architecture in one diagram

```
┌────────────────────────────────────────────────────────────────────┐
│  Sun + Wed 20:23 UTC (3:23 PM CDT) — weekly-collect.yml            │
│                                                                    │
│   collect_events.py  ──>  candidates.json (every raw event)        │
│   --candidates-only       collection_metadata.json (per-source)    │
│                           docs/events.json   ❌ NOT WRITTEN here    │
│   Commits both to main → Railway redeploys; Slack "collect done"   │
└────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  On boot in production — server/autopublish.js                     │
│   Upcoming candidates + approved submissions → published_events    │
│   (Railway Postgres, live). No manual pick needed.                 │
│                                                                    │
│  Then event-check.yml (after each successful collect + Mon 11:43   │
│  UTC) hides sure-thing junk; submission-review.yml (every 15 min)  │
│  AI-reviews free submissions and publishes the good ones.          │
└────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  Owner, only for exceptions — www.thevic361.com/admin.html         │
│   Slack pings + admin Home tab show what needs a look; edit or     │
│   remove events → Save & Publish (also commits docs/events.json    │
│   when GITHUB_TOKEN is set).                                       │
└────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  Mon 12:43 UTC — newsletter.yml sends the issue (Resend), when     │
│  NEWSLETTER_AUTOSEND=1. Daily: social-kit.yml, meta-ads.yml.       │
│  Public site renders Postgres-backed /events.json continuously.    │
└────────────────────────────────────────────────────────────────────┘
```

GitHub starts scheduled runs late, sometimes by an hour or more; nothing downstream assumes an exact time.

---

## Source of truth — read this twice

| Layer | Role |
|---|---|
| **Railway Postgres `published_events.id=1`** | The **live** published list. The Express app serves `/events.json` from here. Written by: auto-publish (`server/autopublish.js`: on boot, `POST /api/admin/auto-publish`, and in `submissionsOnly` mode after an AI review approval), admin **Save & Publish** (`/api/admin/publish-events`), the event check's hide and the admin's restore (`server/eventcheck.js`), and `unpublishEvent` when an approved submission is un-approved (`server/submissionReview.js` / the Submissions tab). |
| **`docs/events.json`** | A **curated bundled fallback**, not authoritative. Only the admin Save & Publish flow may write it (and only when `GITHUB_TOKEN` is configured). The weekly collector workflow runs with `--candidates-only` and **must not** overwrite this file. |
| **`candidates.json`** | The full raw collector output, auto-published on the next boot. Auto-committed by the weekly workflow (Sunday and Wednesday). Safe to overwrite. |

Test `test_collect_events_safety.py` pins the `--candidates-only` invariant. **Do not break it.**

---

## File layout

```
thevic361/
├── AGENTS.md                     ← you are here
├── CLAUDE.md, .cursorrules       ← thin pointers to AGENTS.md
├── README.md, RAILWAY.md, SETUP_GUIDE.md, TRISTEN_WEEKLY_SOP.md, ADMIN_ROADMAP.md
│
├── collect_events.py             # 3.3k LOC monolith — orchestrator + every scraper
├── send_digest.py                # weekly candidate-summary email (weekly-digest.yml)
├── discover_venues.py            # OPT-IN ONLY — Google Maps venue discovery, NOT in CI
├── approve_events.py             # LEGACY — decommissioned reply-to-email publisher
│
├── server/                       # Express backend (flat, no routes/ subdir)
│   ├── index.js                  # createApp factory + most routes
│   ├── auth.js                   # username/password login + HMAC session tokens
│   ├── db.js                     # FileStore + PgStore + factory; inline schema
│   ├── autopublish.js            # publishes candidates + approved submissions on boot
│   ├── eventcheck.js             # /api/event-check/hide + admin hidden/restore
│   ├── submissionReview.js       # AI review of free submissions (API side)
│   ├── newsletter.js             # signup, confirm, unsubscribe, weekly issue (Resend)
│   ├── notify.js                 # "we got it" / "you're live" / "you're booked" emails
│   ├── sponsors.js               # /advertise, Stripe Checkout + webhook, sponsor orders
│   ├── guides.js                 # /venues pages, seasonal guides, .ics
│   ├── contact.js                # /contact form → Slack
│   ├── slack.js                  # Slack webhooks (sales / activity / alerts)
│   ├── github.js                 # GitHub Contents API + workflow_dispatch
│   ├── rateLimit.js              # in-memory sliding-window limiter
│   ├── analytics.js              # first-party visitor stats for the admin Traffic tab
│   ├── metaPixel.js              # /pixel.js — Meta Pixel for ads, off until META_PIXEL_ID is set
│   ├── seo.js                    # server-rendered pages: home, intent pages, /events/:slug, /about, sitemap.xml, llms.txt
│   ├── ogImage.js                # /events/:slug.png link-preview card (resvg; bundled fonts in server/fonts/)
│   ├── sources.js                # /api/admin/sources payload builder
│   ├── turnstile.js              # Cloudflare Turnstile verify
│   └── validate.js               # submission validation + bot signals
│
├── scripts/                      # Python run by the workflows
│   ├── review_submissions.py     # submission-review.yml
│   ├── sweep_events.py           # event-check.yml
│   ├── social_kit.py, social_slides.py, social_post.py   # social-kit.yml
│   ├── meta_ads.py               # meta-ads.yml
│   ├── feed_age.py               # uptime.yml stale-feed check
│   ├── slack_notify.py           # Slack pings from every workflow
│   └── apify_probe.py, gemini_probe.py   # probe workflows
│
├── docs/                         # Static site root (Express serves from here)
│   ├── index.html, app.js, base.css, style.css   # public site
│   ├── track.js, turnstile.js    # visitor beacon; Turnstile widget loader
│   ├── admin.html, admin.js, admin-submissions.js, admin.css   # admin UI
│   ├── submit.html, submit.js, submit.css        # public submission form
│   ├── social/latest/            # social kit output (committed daily by social-kit.yml)
│   ├── events.json               # CURATED FALLBACK — see source-of-truth note above
│   ├── og-image.png, favicon.svg, robots.txt   # sitemap.xml + llms.txt are served by server/seo.js
│
├── tests/                        # vitest: one *.test.js per server module / page
│   └── setup.js                  # env cleanup + Node 25 localStorage shim
│
├── test_*.py                     # pytest, currently AT REPO ROOT (not /tests/python/)
│   ├── test_collect_events_safety.py    # ⚠️  PINS the --candidates-only invariant (code and workflow)
│   └── test_<module>.py          # one per collector feature / script
│
├── .github/workflows/            # times UTC; GitHub often starts them late
│   ├── weekly-collect.yml        # Sun + Wed 20:23 — collector → candidates.json (→ redeploy → auto-publish)
│   ├── event-check.yml           # after each successful collect + Mon 11:43 — sweep live list, hide sure junk
│   ├── submission-review.yml     # every 15 min — AI review of free submissions
│   ├── newsletter.yml            # Mon 12:43 — send the issue (NEWSLETTER_AUTOSEND=1)
│   ├── social-kit.yml            # daily 13:47 + on generator changes — build kit, commit to main, autopost
│   ├── meta-ads.yml              # daily 13:37 + manual — Meta ads report / control
│   ├── weekly-digest.yml         # Mon 02:00 — digest email to Tristen
│   ├── uptime.yml                # hourly :17 — site check; daily stale-feed check
│   ├── tests.yml                 # every PR + push to main — npm test + pytest
│   ├── apify-probe.yml, gemini-probe.yml   # claude/** pushes touching the probes
│   ├── pr-preview.yml            # static PR previews via sibling repo
│   └── staging-deploy.yml        # static staging deploy via sibling repo
│
├── venues.json                   # 47 manually-curated venues with tier (HIGH/MEDIUM/LOW)
├── local_events.yaml             # backbone: recurring + one-off curated events
├── extras.yaml                   # New & Notable + sponsor block
├── candidates.json               # weekly raw output (committed by CI)
├── collection_metadata.json      # per-source stats (committed by CI; admin reads it)
├── facebook_venues.json          # legacy one-cycle fallback
├── facebook_venues.backup.json   # currently byte-identical to facebook_venues.json
├── pending_venues.json           # legacy holding file ({}); discovery decommissioned
│
├── package.json, package-lock.json, .nvmrc, vitest.config.js
├── requirements.txt, requirements-dev.txt
├── railpack.json                 # Railpack build config (forces Node start command)
└── .gitignore                    # __pycache__, .env, node_modules, data/, etc.
```

---

## Run, test, lint

### Node (server + frontend)

Node 22 LTS (`.nvmrc`, `engines`); CI and Railway use it. `package-lock.json` is committed: install with `npm ci`, and commit the lockfile with any dependency change.

```bash
npm ci
npm start          # node server/index.js — listens on $PORT or 3000
npm run dev        # alias to start (no nodemon configured)
npm test           # vitest run — runs every tests/*.test.js
```

### Python (collector + digest)

```bash
pip install -r requirements.txt
pip install -r requirements-dev.txt   # adds pytest

# Run the collector locally (writes candidates.json + ./events.json):
python collect_events.py --output ./docs/events.json --local-dir .

# CI-safe mode (does NOT touch docs/events.json):
python collect_events.py --candidates-only --output ./docs/events.json --local-dir .

# Run the test suite (tests live AT THE REPO ROOT, not under tests/):
pytest -q
```

`.github/workflows/tests.yml` runs both suites on every PR and on pushes to `main`. Run them locally before opening a PR too.

There is no linter configured. Match the existing style (4-space Python, 2-space JS, ES modules in `server/` and `tests/`).

---

## Collector quality

`merge_events` in `collect_events.py` is the single quality gate: it drops scraped events outside Victoria County (`out_of_area_reason`; local YAML is trusted), moves street addresses out of the venue field and blanks placeholder venues like "Victoria" or "Restaurant of the Week" (`clean_venue`; a street with no `venues.json` match leaves the venue blank so the site shows the address), blanks a nightlife time that can't be right ("Comedy Night" at 10 AM), and fuzzy-dedupes per day (`is_same_event`: also ignores organiser prefixes and city words when both name one place, and treats Theatre Victoria as the Welder Center), keeping the record from the higher-ranked source in `SOURCE_RANK` and filling gaps from the other. The merged name is the whole one over a cut-off copy, an official source's over an AI-written one, else the shorter. Religious words only count in the name; descriptions need clear phrases ("worship service"). `safe_fetch` tags every event with `_source`, which the admin shows as a pill (and shows a scraper's note, like city calendar pages skipped by its cap). The city calendar reads every listing's full `eventTitle` heading; Theatre Victoria reads the season cards' posters (shows play at the Welder Center; no 7:30 PM on Sundays). Tests: `test_quality.py`, `test_event_data.py`. Hand-added one-time events in `local_events.yaml` are collected out to `LOCAL_HORIZON_DAYS` (90) instead of the 14-day window, so festivals weeks away reach the site, guides, sitemap and "Coming up"; recurring YAML entries and every scraper stay in the window, and the AI review skips events past the window (they're hand-written; reviewing them every run would add minutes). Every YAML event is published with `curated: true`: `scripts/sweep_events.py` then skips its religious/out-of-area/wrong-day/non-event checks for it (a person already decided; duplicates and odd times are still flagged), and auto-publish's "looks broken" guard counts only scraped events in the next 14 days, so far-ahead hand-added events can't make a failed scrape look healthy. The Sunday digest and the Slack "collect done" count cover the next 14 days. Optional YAML fields ride along to the site: `big: true` (a highlight for "Coming up") and `town:` (a nearby town for the few big events outside Victoria County, which only hand-added events may be). Post extraction (`_extract_events_from_posts_via_ai`, FB and IG) also sends the newest posts' first image (`FLYER_IMAGES_PER_ACCOUNT`, 4), downloaded and inlined, so monthly lineup flyers are read; caption-less image posts are kept for it. Thin events (no time or link, or a description under 70 characters) get their blanks filled by `enrich_thin_events`: Gemini with Google Search, accepting only answers whose source page is on a site Gemini cited (links must also load and name the event), never overwriting a set field; soonest first, `ENRICH_MAX_PER_RUN` (24) per run, results cached in `enrichment_cache.json` (committed by `weekly-collect.yml`; misses retried after 7 days; `ENRICH_ENABLED=0` turns it off). Time limits: flyers stop `FLYER_TIME_BUDGET_MIN` (20) into a collect, and past `COLLECT_DEADLINE_MIN` (38) gap filling and the remaining AI review batches are skipped so the 50-minute step still writes `candidates.json`; a failed flyer call retries the account with text only. Hand-written (`curated`) events are never dropped by the AI review's `keep: false`. Auto-publish removes `big`/`town`/`curated`/`favorite`/`recurring` from a live event when the fresh copy no longer has them (`TAG_FIELDS`); `appeal`/`sources` are kept when missing. Tests: `test_flyers_and_horizon.py`.

## SEO / AI search

Crawlers like GPTBot and ClaudeBot don't run JavaScript, so `server/seo.js` renders events into plain HTML from the same published payload as `/events.json`: the homepage (injected into `docs/index.html`), intent pages (`/today`, `/this-weekend`, `/free-things-to-do`, `/kids-and-family`, `/live-music`, `/food-and-drink`), one page per event at `/events/<date>-<slug>` with schema.org `Event` JSON-LD, `/about`, `/sitemap.xml`, and `/llms.txt`. `docs/app.js` still re-renders the homepage in the browser and powers admin preview. Keep the two event renderers' markup in sync. The homepage's "Coming up" (`renderComingUp`, the `<!--COMING_UP-->` slot in `docs/index.html`) lists up to 20 `big` events or Vic's Picks after this week, within 90 days, one line per multi-day event; the first 4 show and the rest fold behind a "Show more" `<details>`. An event with `town` (nearby-town events) shows a "Nearby · Cuero" badge in lists (server and `docs/app.js`) and uses that town, not Victoria, in its page lead, JSON-LD and calendar links (`townOf`). Every published event is also written to an archive (`event_archive` table / `event_archive` key in the file store) so its page keeps working after the week rotates out. `featured: true` (set from the admin edit modal) pins an event to the top of its day; `/advertise` sells it. `/llms.txt` lists the week's sponsor and the Vic's Picks in their own sections, labeled as paid, so AI answers drawn from it carry them too. Times are shown through `formatTime` (display only; the stored `ev.time` feeds slugs and keys), JSON-LD `endDate` rolls to the next day for events past midnight, and the homepage folds days already over to their header bar so it opens on today. Unknown URLs get a branded 404 (`renderNotFoundPage` with `kind` event/venue/page; files and `/api/` keep short answers), `/halloween`-style short forms 301 to the `-events` guides, and a leading `//` 301s to one slash (Squarespace forwards the bare domain to `www.thevic361.com//path`). The light/dark choice is saved per device by the inline `THEME_SCRIPT` on every page. Link previews use the 1200x630 `/og-image.png`. The sponsor button is `rel="sponsored"` with utm tags (`sponsorLinkUrl`). Static images are cached a day, CSS/JS 10 minutes.

## Venues, guides, social kit

`server/guides.js` generates `/venues` + `/venues/<slug>` from `venues.json` (organizer accounts skipped) and the live + archived events, seasonal guides (`SEASONS`: holidays and festivals in calendar order, from Crawfish season and Valentine's Day through Oktoberfest and New Year's Eve; seasonal only, year-round draws like car shows don't belong here) that appear in the nav, sitemap and `llms.txt` only while they have an upcoming matching event (an event counts only when its date falls in the guide's `months`; with nothing upcoming the page still loads for old links but is noindexed), and `/events/<slug>.ics`. Event pages carry calendar and share buttons, and every event in a list (server `renderEventItem`, client `renderEvent`) has a share icon (`.event-share`; `docs/track.js` opens the share sheet or copies the full link, counted as `share_from_list`). Each event page's `og:image` is its own 1200x630 card, `/events/<slug>.png?v=<hash>` (`server/ogImage.js`: name, day, time, place, Vic's Pick badge, drawn as SVG and rasterized with `@resvg/resvg-js`, the one native dependency, chosen because it ships prebuilt binaries and needs no Chrome or system fonts on Railway; Fredoka/Nunito TTFs under OFL live in `server/fonts/`). The `?v=` hash covers only what's drawn, so editing an event changes the URL and Facebook re-fetches; a render failure redirects to `/og-image.png`. the homepage has client-side filter chips (`docs/app.js`). `scripts/social_kit.py` runs every morning (each post is a teaser, not the whole list: at most three branded slides — cover with three highlights, a day-by-day peek with two events per day and "+ N more", and a see-all/subscribe slide — and captions with two events per day, Vic's Picks/sponsored first and marked ⭐, then "+ N more" and the link; `scripts/social_slides.py` lays slides out as HTML in Fredoka/Nunito with the day colors, icons, logo and skyline and screenshots them with headless Chrome in one run, falling back to plain Pillow slides if Chrome is missing or fails) (`social-kit.yml`, also on changes to the generator) and commits slides, captions and `kit.json` to `docs/social/latest/`: Monday rebuilds the week, weekend and today kits, Thursday the weekend (plus `weekend.mp4`, a vertical Reel made with ffmpeg) and today, other days only today. Captions and slides show a clean venue (`clean_venue`: a geocoder string like "3102 Miori Ln., Victoria, TX, United States, Texas 77901" becomes "3102 Miori Ln."), list every Vic's Pick of a day first even past the two-per-day peek, and the Instagram caption is kept under 2,200 characters (drop @tags, then shorten long names/venues, then fold plain events into "+ more at thevic361.com"; picks are never dropped). Instagram captions @mention venues that have a handle in `venues.json` (`match_venue`: exact name, or a whole-word match only when the shorter name is 2+ words and 8+ characters; generic names like "Victoria" or "Downtown" never tag anyone; outreach uses the same matcher), and Monday's run sends Slack `outreach.txt` (this week's venues with their event links, to send them for a reshare) (open `/social/latest/`, linked from the admin header). `scripts/social_post.py` then posts the kit to the Facebook Page and Instagram when the `SOCIAL_AUTOPOST` repo variable is `1` and the `META_PAGE_ID` / `META_PAGE_TOKEN` (+ `IG_USER_ID`) secrets are set: Monday posts the week, Thursday the weekend (as a Reel on Instagram when `weekend.mp4` exists) plus today when today has a Vic's Pick (`--if-featured`, using the kit's `featured` count), other days today. Every slide also gets a `.jpg` twin (`slides_jpg` in `kit.json`) because Instagram's API only takes JPEG; Facebook gets the PNGs. Without `IG_USER_ID` the post step logs a warning and posts Facebook only. `kit.json` carries a per-run `build` id the poster waits for (so it never posts an earlier same-day kit), and `posted.json` records what went out per day and kind so re-running a half-failed job skips the platform that already posted (the job always builds from the latest `main`, so a re-run sees the earlier attempt's `posted.json`). Network errors fail one platform, not both; a timeout on the final publish call (`/feed`, `media_publish`) may have posted anyway, so it records `"pending"` and re-runs skip that platform until the owner checks by hand and removes the entry. The Page token is sent in a header on GETs and masked in the Actions log.

## Traffic stats

`server/analytics.js` powers the admin **Traffic** tab. People are counted from a `docs/track.js` beacon (`POST /api/track`: page views and sponsor/event/subscribe clicks; skipped in a browser signed into the admin). A page view is sent only once the visitor engages (scroll, tap, click or key) or the page has been visible for 5 seconds, so JS-running bots and instant bounces aren't counted; counts dropped when this started on 2026-10-05. search and AI crawlers are counted server-side by user agent (HTML pages plus `/events.json` and `/llms.txt`). AI bots are tagged `ask` (an assistant fetched the page to answer someone, e.g. ChatGPT-User), `search` or `training`; the summary's `ai` block reports people sent by AI referrers (or `utm_source`, which ChatGPT adds when there's no referrer) and those three counts. Rows go to the `traffic` table (Postgres, ~400 days kept) with a daily salted visitor hash and no IPs or cookies. `GET /api/admin/traffic?days=N` returns the summary.

**Meta ads.** Pages reached from links carrying a subscriber token (`/subscribe/confirm`, `/unsubscribe`) render with `layout({ pixel: false })`, which also leaves Google Analytics off, and the pixel script itself skips any URL with `token=`: both tools report page URLs to a third party. Everywhere else GA gets `page_location` as origin + path plus only `utm_*`/`gclid` (`GA_SNIPPET` in `server/seo.js`, copied into `docs/index.html` and `docs/submit.html`; a test keeps them identical). `/privacy` (`renderPrivacyPage`, linked from every footer) discloses the pixel, Google Analytics and our own stats, as Meta's terms require. `/pixel.js` (`server/metaPixel.js`) loads the Meta Pixel on public pages when `META_PIXEL_ID` is set and is an empty script otherwise; it skips the same admin/preview/social-kit visits as `track.js`. It reports `PageView`, and `track.js` reports `Lead` when a newsletter signup succeeds. Ad links should end in `?utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.name}}`: a tap on an ad has the same facebook.com/instagram.com referrer as a free post, so `utm_medium=paid` is what puts it under **Meta ads** in the Traffic tab (`paidSource` in `server/analytics.js`; other paid sources show as **Other ads**).

## Newsletter

`server/newsletter.js`: double opt-in signup (`POST /api/subscribe` → confirmation email → `/subscribe/confirm`; its `GET` only shows a "Confirm my subscription" button and the `POST` confirms, because mail link scanners open every link), unsubscribe (`GET` shows a button naming the masked address, `j•••@gmail.com`, so a forwarded copy's reader can tell it isn't theirs; `POST /unsubscribe` also serves RFC 8058 one-click), the weekly issue rendered from the published events (sponsor block first, under the pills, and first in the text part; links back to the site carry `utm_source=newsletter&utm_medium=email&utm_campaign=weekly-<week>` via `utmTag`, never unsubscribe/confirm links; the paid weekly sponsor's button goes through `/go/s/<week>`), and Resend batch sends with one send per week (`newsletter_sends`). Admin Newsletter tab: status, preview, test send, send, import; a week whose send partly failed shows "Partly sent (N failed)" and the button retries just those (`this_week_failed`). The Monday workflow runs whenever `NEWSLETTER_CRON_SECRET` is set (no repo-variable gate), and its cron call also runs the sponsor click reports (`onCron`). Subscribers live in the `subscribers` table. `GET /subscribe` is the signup page every Subscribe button (header, footers, page CTAs) points at, and where ads should land: the pitch, the form, and the next seven days of events as proof; the subscriber count shows only from 100. Each form sends a `source` (`footer`, `list-card`, `subscribe-page`; `signupSource` whitelists them), with `:ad` added when the visit began from a `utm_medium=paid` link (`docs/track.js` remembers it for the session); it's stored on the subscriber and shown in the Slack ping. The weekly email's footer invites forwarded readers to `/subscribe`. `/api/subscribe` gives the same answer for a new, pending or already-active address (so it can't be used to check who's subscribed), sends at most 3 confirmation emails per address a day, and Slack-alerts the owner (`newsletter-subscribe-failed`) when the confirmation email can't be sent. The forms report `subscribe_click` (and the Meta Pixel `Lead`) only for the first signup from that browser (`vic361-subscribed` in localStorage). A comeback's `source` is updated to where they came back from.

## Confirmation emails

`server/notify.js` sends "we got it" emails through the newsletter's Resend client and design (`emailShell`): a free submission with an email gets what it sent, what happens next (review, not guaranteed; usually within the hour), then "you're live" when the AI review approves it, a prefilled Vic's Pick upgrade link and how to reach us; a paid weekly sponsor or Vic's Pick gets "you're booked" with when/where it runs (sent once from `fulfil`, recorded as `confirmation_sent`; double-booked `conflict` orders never get one). Replies go to `NEWSLETTER_REPLY_TO` (or the From address), and every email links /contact. Sending never blocks or fails the request. The thank-you pages say the same next steps. A Vic's Pick is only promised a newsletter star when its week's Monday issue is at least two days after the purchase (`newsletterCovers`/`pickWhere`); otherwise the copy leaves the newsletter out. Weekly sponsors get a click report (`renderSponsorReport`) the Monday after their week; see Sponsor checkout. The setup checklist flags a missing `NEWSLETTER_REPLY_TO`.

## Sponsor checkout

`server/sponsors.js`: `/advertise` → `/advertise/checkout?package=weekly|featured` (one form) → Stripe Checkout → `POST /api/stripe/webhook` (signature-verified over the raw body, so it's registered before `express.json`). Weekly sponsor books one Mon–Sun week (held 35 min while someone pays) and replaces the sponsor slot; venue partner (a monthly subscription that featured every event at a venue) is no longer sold, but subscriptions bought earlier keep featuring their venue until cancelled in Stripe; featured event (Vic’s Pick: $49 Mon–Thu, $89 Fri–Sun via `pickPackage`, its own Stripe catalog price; capped per day at 3 Mon–Thu and 4 Fri–Sun by `VICS_PICK`, counting paid/settling orders and live checkout holds, so a full day can't be bought; `GET /api/vics-pick/availability?date=`) adds a `paid-feature` submission to the review queue (the AI review publishes it when clean, see below) and features the matching live event: `pickMatches` matches the bought event, the submission as it is now, or an Events-tab edit of it, so fixing the date or name doesn't drop the pin; the admin Sponsors tab shows "Paid, not on the site yet" (`on_site: false`) for a live upcoming pick nothing matches. Every checkout form shows a live preview of the placement drawn with the site's own markup (`renderPreview`, refreshed from `POST /advertise/preview` as they type) above the pay button. The weekly sponsor can add a logo (not Vic's Picks): the browser shrinks it to at most 480×240 PNG, `parseLogo` accepts only real PNG/JPEG/WebP bytes up to 300 KB (no SVG), it's stored apart from the order (`sponsor_logos` table / `sponsor_logos` key) and served from `GET /sponsor-logo/<order id>` (1-hour cache; 404 unless the order is paid/active/processing or a current hold, so hidden, refunded and abandoned orders' logos stop resolving), and `sponsor.logo` holds that path; the site, newsletter and confirmation email show it (only paths matching `LOGO_PATH`). Unpaid logos are deleted (`store.deleteSponsorLogo`) on `checkout.session.expired`, async payment failure and a failed session create; the admin Sponsors tab shows each logo (via `GET /api/admin/sponsors/:id/logo`) with a Remove logo action. `/advertise/checkout` takes a 600 KB form body for this (the page drops a logo over ~400 KB before submit); everything else stays at 64 KB. A body over its limit is a 413 with no Slack alert (on checkout, a "logo too large" page). `cancel_url` carries `&cancelled=<order id>`: coming back marks that pending hold `cancelled`, expires its Stripe session (best effort), and refills the form; a late payment on it is still honored. A buyer's own pending hold doesn't count against them (`picksTaken`/`bookableWeeks` take the email) and is replaced by their new one. The confirmation email is retried on later webhooks for a paid order until it sends, and the thank-you page only says it was sent once `confirmation_sent` is set. Admin Restore refuses (409) when the day's Vic's Picks or the week were sold while the order was hidden. `/advertise` shows each package's placement, limits and an example (`samplePreviews`). The free submit form says free submissions aren't guaranteed and links to a Vic’s Pick, prefilled with the event just sent (checkout GET reads those query fields). Placements are applied in `getPublicPayload` at read time, never written into the published payload. Orders live in `sponsor_orders`; prices in `AD_PACKAGES` (`server/seo.js`). Admin Sponsors tab: orders, week calendar, hide/restore, and Edit for weekly orders (wording, link, button, address, logo, week; same validation as checkout; moving a double-booked `conflict` order to an open week puts it live and sends its confirmation). Click reports: `sendSponsorReports(now)` (exported from `createSponsors`, idempotent, records `report_sent`/`report` on the order, Resend key `vic361-sponsor-report-<id>`) emails each paid weekly order whose week ended (from the Monday after, catching up for 14 days) its unique people who clicked on the site (track beacon `sponsor_click` matching the sponsor URL) and in emails (`GET /go/s/<week>?src=newsletter|welcome` records a `sponsor_click` traffic row with path `/go/s/<week>`, skipping bots and HEAD, then 302s to the sponsor URL with `utm_source=thevic361`); it runs from the Monday newsletter cron, and a daily scheduler may also call it. Without Resend it Slack-alerts the numbers once. The thank-you page reloads itself while the webhook is late (first 2 minutes) and explains a double-booked `conflict`. `?from=<submission>` fills in the submitter's name and email only while that submission is pending and under 7 days old; the checkout page strips `from`/`cancelled` from the address bar, and the Pixel and GA leave `from`/`cancelled`/`order`/`token` out of reported URLs. Paid orders ping Slack. Off until both Stripe vars are set. Stripe calls pin `Stripe-Version: 2026-09-30.endive` (`STRIPE_API_VERSION`); each package uses a catalog Product/Price found by `lookup_key` (created on first use, inline `price_data` as a fallback); sessions carry `integration_identifier` and no `payment_method_types` (dynamic payment methods). Slow payment methods hold the order as `processing` (a weekly week stays taken) until `checkout.session.async_payment_succeeded`/`_failed`. Webhook events to subscribe: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`, `radar.early_fraud_warning.created`. Use a restricted key (`rk_`) with Checkout Sessions, Products and Prices write access as `STRIPE_SECRET_KEY`.

## Traffic features

- Search landing pages in `HUB_PAGES` with `hidden: true` (`/tonight`, `/date-night`, `/this-weekend-with-kids`) stay out of the top nav but are in the footer and sitemap.
- Hidden landing pages for specific searches: `/tonight`, `/date-night`, `/this-weekend-with-kids`, `/free-this-weekend`, `/nightlife`, `/arts-and-culture`, `/outdoor-events` (footer and sitemap, not the top nav).
- Hub pages and the homepage hero have a "Share this list" button (handled by `docs/track.js`). Link previews use `/og-image.png` (1200x630), not the social-kit slides (1080x1350 portraits under robots.txt's `/social/` block whose content changes weekly under one URL).
- `docs/app.js` inserts a "Get this list every Monday" signup card after the day following today (hidden once subscribed on that device, via localStorage).

## Event scoring and the daily limit

`server/scoring.js`: each day shows its best `DAY_MAX` events (15 Mon–Thu, 20 Fri–Sun). `getPublicPayload` runs `capDays`, which scores every event (0–100, `scoreEvent`) and marks the rest of a full day `overflow`. Day lists use only events that made the cut (`shownPayload` / `shown`): `/events.json` (so the homepage app and social kit; `/events.json?all=1` is every public event with `overflow` flagged, for the event check and submission review, which must see everything that's live), the server homepage, `/today`, `/tonight`, `/this-weekend`, `/next-week` and other non-`upcoming` hub pages, `llms.txt` and the newsletter. Event pages, category guides (`range: 'upcoming'`), seasonal and venue guides and the sitemap keep every event. Lists stay in time order with Vic's Picks first (`sortEvents`); the score only decides what's in. Always in: `featured` (Vic's Picks, sponsored) and events the admin chose to show anyway (`POST /api/admin/keep-event`, stored as the published payload's `kept` key list; the admin's event list shows "Dropped · score N" with a Show anyway / Undo button). Score signals: the AI review's `appeal` (1–5, `ai_review`), `big`, festival/concert/parade names, weekly repeats (`recurring`; `favorite: true` in the YAML keeps a staple's spot), niche (club, meeting, class...) and store-promo wording, family/free, missing time/place/description, a link, `sources` (how many sources listed it), hand-added (`curated`) and approved submissions (`submitted`, set by auto-publish), popular (tier HIGH) venues, and small nearby-town events. A full day also keeps variety: at most 2 per venue and 3 of a kind (trunk-or-treats, karaoke, bingo...) unless a score is 80+, then fills leftover room by score. `score`, `overflow` and `keep` are never stored on events (stripped from `/events.json` and from Save & Publish). Editor's picks (`pickDays`, after the cap): a day's can't-miss events get the Vic's Pick badge on merit, up to 2 Mon–Thu and 3 Fri–Sun counting paid picks first (a paid one takes an editor's spot; paid capacity is counted from orders in `sponsors.js`, never from these). Score 70+ to be picked; a day with none that strong still gets 1 (2 on weekends) of its best if they reach 65. Only one-time Victoria events, each picked once (first day), one per venue. They're `featured` plus `editor_pick`, computed on read: kept out of "Coming up", described as editors' picks in `llms.txt`, labeled "Vic's Pick (auto)" in the admin, and stripped (with their `featured`) from Save & Publish. Tests: `tests/scoring.test.js`, `test_scoring_hints.py`.

## Auto-publish

`server/autopublish.js`: each collector run commits `candidates.json`, which redeploys the site; on boot in production (`RAILWAY_ENVIRONMENT_NAME=production`, unless `AUTO_PUBLISH=0`) the upcoming candidates plus approved submissions are published to the store. Upcoming events already published are kept; one it added takes the collector's newer copy of itself (time, venue, address, link, description, icons; the name only when the live one was cut off), unless the admin edited it, it's an approved submission or featured, and a hidden one keeps its name and venue (its key); `auto_publish.keys` follows the new key (`AUTO_PUBLISH_RULES` 3). Events it added that the admin later removed are remembered (`auto_publish` in the published payload, hidden from `/events.json`) and not re-added. `POST /api/admin/auto-publish` forces a run. The collector drops non-events (`non_event_reason`: job/internship posts, booking ads, awareness-day posts) and decodes HTML entities; with `OPENAI_API_KEY`, the AI review also returns `keep: false` for non-events. `weekly-collect.yml` runs Sunday and Wednesday.

## Meta ads reporting

`scripts/meta_ads.py` (`.github/workflows/meta-ads.yml`) reads and manages the Meta ads through the Marketing API, so the token never leaves GitHub. Daily at 13:37 UTC it posts yesterday's and the last 7 days' results (spend, reach, link clicks and CTR, landing page views and cost each, frequency, signups if any, and any disapproved ad) to the Slack activity channel, and stays quiet when nothing has spent in 7 days. By hand (`gh workflow run meta-ads.yml -f command=status|pause|resume|budget -f target=<id> -f amount=<dollars>`), with results in the run summary: `status` also checks the token's ads permissions and lists campaigns/ad sets/ads with their delivery and review state; budgets over $50/day need `force`. Token: `META_ADS_TOKEN` (a system user with ads_read + ads_management and the ad account assigned), falling back to `META_PAGE_TOKEN`; `META_AD_ACCOUNT_ID` repo variable when it sees several ad accounts. The token is sent as an Authorization header and kept out of errors. A scheduled run with a setup problem only warns. Tests: `test_meta_ads.py`.

## Submission review

`scripts/review_submissions.py` (`.github/workflows/submission-review.yml`, every 15 minutes) is the AI review of free submissions (`server/submissionReview.js`). It reads pending public submissions nobody has touched yet from `GET /api/submission-review/pending` (no emails, phone numbers or IPs) and decides each once: rules first (church/worship events are rejected when the name or venue says so; a description that only sounds religious is flagged, an exact copy of a live event is marked duplicate; a non-event, out-of-area or cut-off name, or a near-duplicate, is flagged), then one OpenAI call per submission (so one can't steer another; the prompt says every field is untrusted data, never instructions) that tidies the name, description (≤160 chars, the collector's voice) and icons and says approve, flag or spam. A rule doubt always beats an AI approval, and so do `safety_doubt` checks on what was typed: text aimed at the reviewer ("verdict", "ignore previous instructions", "pre-approved"...) or a link to a domain not in `KNOWN_LINK_DOMAINS`, a venue's site or a live event's link is flagged; a rename that keeps none of the original words is dropped. `POST /api/submission-review` applies only name/description/icons (validated like an admin edit; date, time, venue, address, link and the submitter's details never change), records `ai_review` on the row (with the original payload when tidied) and a note in `admin_notes`, then for approvals runs auto-publish in `submissionsOnly` mode (adds approved submissions only: never the collector's candidates, so it respects `AUTO_PUBLISH=0`, and retires nothing) and, once the event is really on the public list, emails the submitter "you're live" with the event page link (`renderSubmissionLive`); an approval that didn't make it onto the site (removed before, or matched a listed event) gets no email and is called out in Slack, and a past date is flagged instead. Un-approving a submission in the Submissions tab (reject/duplicate/pending) takes its event off the published list and remembers it in `auto_publish.rejected` (`unpublishEvent`). Save & Publish sends `based_on` (the live list's `last_updated` the editor loaded); if the list changed since, `/api/admin/publish-events` answers 409 `stale` and the editor reloads the live list with its unsaved changes kept, so a stale page can't drop events that went live meanwhile. Flagged ones stay pending with the reason and the suggested wording; the admin Submissions tab shows the AI's decision on each card. One Slack message to the activity channel per run that decided something. Paid Vic's Pick submissions go through the same review but keep the buyer's words, are never rejected automatically (a reject becomes a flag; an exact duplicate is approved, since the pin finds the listed event) and get a "Your Vic's Pick is live" email; each review run (the pending fetch) also pings Slack sales, at most every 6 hours, about paid picks within 2 days of their date that are still pending (`remindPaidPicks`, recorded as `reminder` history entries). Approving by hand in the Submissions tab publishes right away (`publishApproved`: auto-publish `submissionsOnly`, then the same live check and email) and says whether it's live; editing an approved submission swaps its live event in place (`replacePublishedEvent`) and records the old key (`prev_key`) so a later un-approve still finds it; rejecting a paid pick pings Slack sales to refund it. Anything the admin has edited or decided is left alone; at most 20 per call; no AI answer means it waits for the next run. Secret: `SUBMISSION_REVIEW_SECRET`, falling back to `EVENT_CHECK_SECRET`, then `NEWSLETTER_CRON_SECRET` (same in Railway and GitHub). `SUBMISSION_AUTOAPPROVE=0` in Railway turns approvals into flags. The "we got it" receipt has a fixed subject and none of the submitter's free text beyond a shortened name, and goes to one address at most 3 times a day (the form takes any address). Upgrade links (thank-you card and emails) are `/advertise/checkout?package=featured&from=<submission id>`; the checkout fills the event and contact in on the server, so no contact details are in URLs that analytics see (the checkout ignores `email`/`business` in the query). Approved submissions never publish the submitter's name or phone: auto-publish, the admin candidate merge and the public read path all drop `submitter_*` fields. Tests: `test_review_submissions.py`, `tests/submission_review.test.js`.

## Event check

`scripts/sweep_events.py` (`.github/workflows/event-check.yml`) looks over the live `/events.json` for the next 14 days after each successful Weekly Collect (once auto-publish has updated the site) and Monday 11:43 UTC, an hour before the newsletter. Rules first, free: the collector's `is_same_event`, `out_of_area_reason` and `non_event_reason` run again over the published list (hand-added events and ones published before a rule existed), plus a weekday in the name that doesn't match the date, starts before 6 AM, and a nightlife name or bar venue at 6–11 AM (reported only). Then one OpenAI call (`OPENAI_MODEL`, default gpt-5-mini) over the whole list for what per-event checks can't see, like the same event at two venues; skipped without `OPENAI_API_KEY`. Rule findings it's sure about (church/worship events by name or venue, non-events, exact duplicates, the library's copy of a program the city calendar lists at its real place with the same hours, and a cut-off name when another listing is at the same place that day; `AUTO_HIDE`) it hides through `POST /api/event-check/hide` (`server/eventcheck.js`, `X-Cron-Secret` = `EVENT_CHECK_SECRET`, falling back to `NEWSLETTER_CRON_SECRET`; at most 10 per run, only live upcoming events). Duplicates are only hidden when exact (same normalized name, venue and start) and neither copy is featured; the copy with less detail goes, fuzzy matches are only reported. Hiding never deletes: the published payload gains a `hidden` entry, matched by the event's original key (date|name|venue before the edits overlay), not its page URL, so slug renumbering and admin renames can't move or undo it; entries are kept 400 days so past pages stay hidden, and `getPublicPayload` (and the bundled fallback) leave those events out (site, `/events.json`, newsletter, social kit, sitemap, event pages); auto-publish and Save & Publish carry it forward. The admin Home tab lists hidden events with Restore, which also records the original key in `hidden_restored` so the check never hides it again; the Events tab labels them "Hidden by check". Wrong days, odd times and every AI finding are only reported. One Slack message to the activity channel: what it hid, then what to look at. Without the secret it only reports. Tests: `test_sweep_events.py`, `tests/eventcheck.test.js`.

## Slack notifications

The public site publishes no email address: `/contact` (`server/contact.js`) sends messages to Slack, falling back to the server log if Slack is unavailable.


`server/slack.js` posts to a Slack incoming webhook (`SLACK_WEBHOOK_URL`, same setup as austincommercialsites.com). No-op when unset. Server pings: new event submission, sponsor paid, venue partner cancelled or payment failing, newsletter sent (or partly failed / skipped because nothing was published), and alerts for 500s, Stripe checkout or webhook failures, crashes and boot failures. Alerts are de-duplicated per key for 15 minutes. Three channels, each optional and falling back to `SLACK_WEBHOOK_URL`: `SLACK_SALES_WEBHOOK_URL` (sponsor orders, refunds, disputes, failed payments), `SLACK_ACTIVITY_WEBHOOK_URL` (submissions, contact messages, subscribers, auto-publish, newsletter sent) and `SLACK_ALERTS_WEBHOOK_URL` (every `alert()`). Pass `channel` to `slack.notify` for new pings. GitHub Actions use `scripts/slack_notify.py`; failure steps read `SLACK_ALERTS_WEBHOOK_URL`, the collect-done and outreach steps read `SLACK_ACTIVITY_WEBHOOK_URL`, both falling back to `SLACK_WEBHOOK_URL`: weekly collect done (candidate count) or failed, social kit / newsletter / digest failures, tests failing on main, and `uptime.yml` (hourly site check, daily stale-feed check).

## Conventions

- **Python:** stdlib + `requests` + `beautifulsoup4` + `pyyaml` + `sentry-sdk`. No Django, no FastAPI, no async — keep `collect_events.py` blocking and simple.
- **JavaScript:** ES modules (`"type": "module"` in `package.json`). No TypeScript. No bundler — `docs/*.js` is loaded as-is by the browser.
- **No new dependencies without strong justification.** This is a twice-weekly cron job + a small Express app. Every dependency is a collect-day failure mode.
- **Comments explain *why*, not *what*.** The existing code does this consistently — match it. Documenting the rationale is half the value of every PR.
- **Errors include `.status` when they wrap an HTTP response** (see `server/github.js`) so route handlers can branch on it.
- **Secrets only via env vars.** Never commit `.env`. `requirements.txt` caps each package below its next major version; raise a cap deliberately, with a test run.

---

## Don't-touch list

These files / behaviors are load-bearing and **must not change** in a normal PR. If you genuinely need to change one, call it out explicitly in the PR description and assume it needs human review.

1. **`docs/events.json` outside the admin Save & Publish flow.** The weekly workflow uses `--candidates-only` for a reason. `test_collect_events_safety.py` pins this.
2. **`candidates.json`** in a feature PR — it's a runtime artifact written by the weekly workflow.
3. **`collection_metadata.json`** in a feature PR — same, runtime artifact.
4. **`.last-published-digest-*` files** — markers from the decommissioned reply-to-email approval flow. Leave alone.
5. **The `weekly-collect.yml` cron expressions `23 20 * * 0` and `23 20 * * 3`.** The 1-hour DST drift is intentional and documented in the workflow header. Do not "fix" it. (Moved from `0 23` in Oct 2026 at the owner's request, because GitHub started the on-the-hour evening slot 45–90 min late; keep `server/sources.js` in sync if it ever changes; `tests/sources.test.js` checks they match.)
6. **Step / job timeouts in `weekly-collect.yml`.** Each value is justified by a specific run ID in the comments. Don't lower without strong reason.
7. **The `--candidates-only` flag default behavior.** Default is *off* (so local runs still write `events.json`); CI explicitly sets it.
8. **`server/auth.js` — the HMAC-SHA256 token format.** Single algorithm, no `alg` header. Do not switch to a JWT lib.
9. **The legacy `ADMIN_TOKEN` fallback path.** Documented in `index.js`. Keep working.
10. **The browser-side GitHub PAT path in `docs/admin.js`.** Intentional bypass for when server-side `GITHUB_TOKEN` isn't configured.

---

## Environment variables

These tables are the full reference (`RAILWAY.md` covers Railway setup and smoke tests). Railway variables are read by the server; GitHub secrets/variables by the workflows.

### Required for prod

| Var | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | server | Railway Postgres connection string |
| `ADMIN_USERNAME` | server (auth.js) | Admin login |
| `ADMIN_PASSWORD` | server (auth.js) | Admin login |
| `ADMIN_SESSION_SECRET` | server (auth.js) | HMAC key for session tokens. Rotate with `openssl rand -hex 32`. |

### Required for the weekly collector

| Var | Used by |
|---|---|
| `OPENAI_API_KEY` | `collect_events.py` AI review + FB/IG post extraction |
| `APIFY_TOKEN` | `collect_events.py` Facebook events + posts, Instagram posts |
| `GEMINI_API_KEY` | `collect_events.py` Gemini + Google Search event discovery (`fetch_gemini_events`; optional `GEMINI_MODEL`, `GEMINI_ENABLED=0` to turn off). Events are kept only with their own link on a site Gemini cited, inside the window; that link must still load as the same page and name the event, or it's removed (the event stays). |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT` | Collector only (the server doesn't use Sentry) |
| `EVENTBRITE_ENABLED`, `FB_EVENTS_ALT_ENABLED` | Collector toggles, on by default; `0` turns off the Eventbrite / alternate Facebook-events Apify scrape |

### Optional

| Var | Default | Purpose |
|---|---|---|
| `ADMIN_TOKEN` | — | Legacy bearer token; kept working alongside login |
| `ADMIN_SESSION_TTL_HOURS` | `12` | Session length |
| `GITHUB_TOKEN` / `GITHUB_PAT` | — | Enables `/api/admin/publish-events` to commit `docs/events.json` and `/api/admin/trigger-collect` to `workflow_dispatch`. Currently unset on production. |
| `GITHUB_OWNER` | `Tmpalori` | |
| `GITHUB_REPO` | `thevic361` | |
| `GITHUB_BRANCH` | `main` | |
| `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY` | — | When set, `/api/submissions` requires a Turnstile token |
| `FB_POSTS_ENABLED`, `IG_POSTS_ENABLED` | — | Repo Variables (not secrets); `=1` to enable post-scrape pipelines in CI |
| `FB_POSTS_MAX_VENUES`, `IG_POSTS_MAX_VENUES` | (collector defaults) | Caps to keep Apify costs bounded |
| `ENRICH_ENABLED` | on | `=0` stops the Gemini gap-filling lookups for thin events |
| `FLYER_IMAGES` | on | `=0` stops sending post images (flyers) to OpenAI with the post text |
| `AUTO_PUBLISH` | on in production | `0` turns off publishing collector candidates on boot (server/autopublish.js) |
| `RESEND_API_KEY` | — | Turns on the email newsletter (server/newsletter.js); until set, signups are saved but nothing is emailed |
| `NEWSLETTER_FROM` | `The Vic 361 <news@thevic361.com>` | Sender; the domain must be verified in Resend |
| `NEWSLETTER_ADDRESS` | — | Mailing address shown in every email (CAN-SPAM) |
| `NEWSLETTER_REPLY_TO`, `NEWSLETTER_TEST_TO` | — | Reply-to address; default test recipient |
| `NEWSLETTER_CRON_SECRET` | — | Shared secret for `POST /api/newsletter/cron` (Monday auto-send via `newsletter.yml`, which also sends last week's sponsor click reports; set it in Railway and as a GitHub secret) |
| `OPENAI_MODEL` | `gpt-5-mini` | Repo Variable; overrides the collector's OpenAI model |
| `SITE_URL` | `https://www.thevic361.com` | Canonical origin. Requests to the bare domain 301 here |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | — | Turn on self-serve sponsor checkout (server/sponsors.js). Webhook endpoint: `https://www.thevic361.com/api/stripe/webhook` with events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`, `radar.early_fraud_warning.created` (same list as Sponsor checkout) |
| `SLACK_WEBHOOK_URL` | — | Slack incoming webhook for owner pings (server/slack.js). Set it in Railway (production) and as a GitHub Actions secret for workflow alerts |
| `SLACK_SALES_WEBHOOK_URL`, `SLACK_ACTIVITY_WEBHOOK_URL`, `SLACK_ALERTS_WEBHOOK_URL` | `SLACK_WEBHOOK_URL` | Optional per-channel webhooks (sales: Railway; activity and alerts: Railway and GitHub secrets) |
| `META_PIXEL_ID` | — | Meta Pixel ID (digits, from Meta Events Manager). Turns on `/pixel.js` for ads (server/metaPixel.js) |
| `EVENT_CHECK_SECRET` | `NEWSLETTER_CRON_SECRET` | Shared secret (Railway + GitHub) that lets the event check hide church events, non-events and exact duplicates (server/eventcheck.js). Unset: the check only reports |
| `META_ADS_TOKEN` | `META_PAGE_TOKEN` | GitHub secret. System-user token with ads_read + ads_management for scripts/meta_ads.py (daily Slack ad report, status, pause/resume, budget) |
| `META_AD_ACCOUNT_ID` | — | GitHub repo variable (e.g. `act_123`), only needed when the token sees more than one ad account |
| `SUBMISSION_REVIEW_SECRET` | `EVENT_CHECK_SECRET`, then `NEWSLETTER_CRON_SECRET` | Shared secret (Railway + GitHub) for the AI submission review (server/submissionReview.js) |
| `SUBMISSION_AUTOAPPROVE` | on | Railway. `0` makes the AI submission review flag everything for you instead of publishing the good ones |
| `PORT` | `3000` | Express listen port |
| `RAILWAY_ENVIRONMENT_NAME` | set by Railway | Auto-publish on boot only runs when it is `production` |

### GitHub Actions secrets and variables

Set in Settings → Secrets and variables → Actions. The collector secrets above (`OPENAI_API_KEY`, `APIFY_TOKEN`, `GEMINI_API_KEY`, `SENTRY_DSN`), the Slack webhooks, `NEWSLETTER_CRON_SECRET`, `EVENT_CHECK_SECRET`, `SUBMISSION_REVIEW_SECRET` and `META_ADS_TOKEN` are GitHub secrets too.

| Name | Kind | Used by |
|---|---|---|
| `SMTP_EMAIL`, `SMTP_PASSWORD` | secret | `weekly-digest.yml` (`send_digest.py`; Gmail app password). Missing: the digest prints instead of sending |
| `META_PAGE_ID`, `META_PAGE_TOKEN` | secret | `social-kit.yml` posting to the Facebook Page (`scripts/social_post.py`); `META_PAGE_TOKEN` is also the `META_ADS_TOKEN` fallback |
| `IG_USER_ID` | secret | `social-kit.yml` posting to Instagram |
| `PREVIEWS_DEPLOY_KEY` | secret | `pr-preview.yml`, `staging-deploy.yml` (push to the previews repo) |
| `SOCIAL_AUTOPOST` | variable | `1` lets the scheduled social kit post; otherwise it only builds the kit |
| `NEWSLETTER_AUTOSEND` | variable | `1` lets `newsletter.yml` send on its Monday schedule |
| `SITE_URL` | variable | Site origin for workflow links and API calls; default `https://www.thevic361.com` |
| `OPENAI_MODEL`, `GEMINI_MODEL` | variable | Model overrides for the collector (and `OPENAI_MODEL` for the review/check scripts) |
| `FB_POSTS_ENABLED`, `IG_POSTS_ENABLED`, `META_AD_ACCOUNT_ID` | variable | See the tables above |

PR/staging Railway environments do **not** automatically inherit `ADMIN_*` vars — set them per-environment or use Railway's shared variables feature.

---

## PR checklist

Before you open a PR:

- [ ] `npm test` passes locally
- [ ] `pytest -q` passes locally
- [ ] No new files committed under `data/`, `__pycache__/`, or `node_modules/`
- [ ] If you changed `package.json` dependencies: `package-lock.json` is updated and committed
- [ ] No secrets in code or test fixtures
- [ ] If you changed `collect_events.py`: `test_collect_events_safety.py` still passes (the `--candidates-only` invariant is intact)
- [ ] If you changed `server/`: no change to the `ADMIN_TOKEN` legacy fallback or the `auth.js` token format unless explicitly intended
- [ ] If you changed `docs/`: no new `innerHTML` write of an unescaped value, no third-party script added without thinking about CSP
- [ ] If you changed a workflow: timeouts and the `--candidates-only` flag are intact
- [ ] PR description explains *why*, not just *what*

PR previews: only `docs/**` changes auto-deploy a static preview. Server / collector changes need a Railway PR Environment to test (auto-created on PR open).

---

## Where the audit lives

A full audit was done on 2026-04-29 (`AUDIT_2026_04_29.md` in Tristen's workspace). The prioritized backlog is there — ask Tristen for it before starting any larger refactor work so you don't re-litigate already-considered tradeoffs. Highlights:

- **P1 (done Oct 2026):** `sponsor.url` / event URLs are scheme-checked and escaped in `app.js`; `tests.yml` gates PRs; the legacy `?preview=<json>` path is removed.
- **P2:** Split `collect_events.py` into a `collector/` package (do this on the next scraper-add PR rather than as a standalone refactor); move `test_*.py` to `tests/python/`; delete `facebook_venues.backup.json`, `pending_venues.json`, `.last-published-digest-*`, `approve_events.py` (or move under `legacy/`).
- **P3:** Tighten `trust proxy` config; add request logging; hoist `escapeHtml` into `docs/util.js`; add an end-to-end submit→approve→publish vitest; extend the script CSP (admin page only today) to public pages, which first needs nonces instead of inline scripts/handlers.

---

## Useful one-liners

```bash
# Trigger the weekly collector manually:
gh workflow run "Weekly Collect"
gh run list --workflow=weekly-collect.yml --limit 1

# Check live health:
curl -s https://www.thevic361.com/api/health
# expected: {"ok":true,"storage":"postgres"}

# Check live event count:
curl -s https://www.thevic361.com/events.json | jq '.events | length'

# Tail the latest weekly-collect log:
gh run view --log $(gh run list --workflow=weekly-collect.yml --limit 1 --json databaseId -q '.[0].databaseId')
```

## Security notes

- **Cron secrets.** `NEWSLETTER_CRON_SECRET` (send the newsletter), `EVENT_CHECK_SECRET` (hide live events) and `SUBMISSION_REVIEW_SECRET` (approve and publish submissions) are meant to differ. For older setups the server and workflows fall back `SUBMISSION_REVIEW_SECRET` → `EVENT_CHECK_SECRET` → `NEWSLETTER_CRON_SECRET`, so with only one set, that one value grants all three. Keep the fallbacks (removing them would break a running setup), but the admin setup checklist flags a shared value ("Each automation has its own secret").
- **CSP.** `/admin.html` gets `script-src 'self'` plus a hash of its inline theme snippet (computed at boot from the file), because its session token lives in localStorage. Public pages have no `script-src`: they use inline scripts, inline `onload`/`onclick` handlers, GA, the Meta Pixel and Turnstile, so one would need nonces first. Don't add a third-party or inline script to `admin.html` without checking the CSP. `X-Powered-By` is off.
- `trust proxy` is `1` (Railway's edge is the single hop). Don't set it to `true`: Express would then take the client-supplied left-most X-Forwarded-For entry as `req.ip`, and every per-IP rate limit could be bypassed.
- Anything rendered into HTML attributes must escape quotes (`escHtml` in both `server/seo.js` and `docs/app.js` does). `safeUrl` / `safeHref` reject URLs containing whitespace, quotes or angle brackets.
- Use function replacements (`.replace(x, () => html)`) when inserting rendered content: event text can contain `$'` / `$&`.
- Weekly sponsor holds are saved before the Stripe call, under an in-process lock; a payment for an already-sold week is marked `conflict` and flagged in Slack for a refund.
- Cloudflare Turnstile (`TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`) protects `/api/submissions`, `/contact`, `/api/subscribe` and `/advertise/checkout`. `docs/turnstile.js` mounts an interaction-only widget on forms marked `data-turnstile` (loaded on first focus; `data-turnstile="fetch"` forms call `vicTurnstile.token(form)`); the server checks `cf-turnstile-response` or `turnstile_token` via `verifyHuman` in `server/index.js`. Both off until the keys are set.
