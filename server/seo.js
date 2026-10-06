/* server/seo.js — Server-rendered pages for search engines and AI crawlers.
 *
 * Why this exists: the public site renders events in the browser from
 * /events.json. Google renders JS late and unreliably, and AI crawlers
 * (GPTBot, ClaudeBot, PerplexityBot) don't run JS at all, so they saw a
 * page that said "Loading events..." and nothing else. Everything here
 * turns the same published payload into plain HTML that any crawler can
 * read without executing a script:
 *
 *   - the homepage with this week's events baked into the markup
 *   - intent pages that match how people search ("this weekend",
 *     "free things to do", "live music") with an answer-first intro
 *   - one page per event, with schema.org Event JSON-LD so the event is
 *     eligible for Google's event results
 *   - /about, /sitemap.xml and /llms.txt built from the same data
 *
 * All functions are pure over (payload, now) so tests can pin dates.
 * Dates are computed in America/Chicago because that's where Victoria is;
 * the server itself runs in UTC on Railway.
 */

export const SITE_NAME = 'The Vic 361';
const GA_ID = 'G-52YHD3X3C2';
const TZ = 'America/Chicago';
const UPCOMING_DAYS = 60;

// Cartoon category icons: one <symbol> per key in docs/icons.svg.
const ICON_KEYS = new Set(['food', 'music', 'family', 'drinks', 'arts', 'shopping', 'outdoors', 'community', 'free']);
const iconSvg = k => `<svg class="ico" aria-hidden="true" focusable="false"><use href="/icons.svg#i-${k}"></use></svg>`;

// Start hour (0-23) of an event, or null when it has no clock time.
function startHour(ev) {
  const m = /(\d{1,2})(?::\d{2})?\s*([ap])\.?m/i.exec(ev.time || '');
  if (!m) return null;
  return (Number(m[1]) % 12) + (m[2].toLowerCase() === 'p' ? 12 : 0);
}
const isEvening = ev => { const h = startHour(ev); return h !== null && h >= 16; };

// Intent pages. `filter` picks events from the upcoming window; `range`
// picks the date window. Order here is the nav order. `hidden` pages answer
// specific searches ("things to do tonight", "date night") and stay out of
// the top nav to keep it short; they're still in the footer and sitemap.
// `image` is the link-preview image (the matching social-kit slide).
export const HUB_PAGES = [
  {
    path: '/today',
    nav: 'Today',
    title: 'Things To Do in Victoria, TX Today',
    h1: 'Things to do in Victoria, TX today',
    description: 'Events happening today in Victoria, Texas: live music, family activities, markets, and more.',
    range: 'today',
    lead: (n, label) => n
      ? `There ${n === 1 ? 'is 1 event' : `are ${n} events`} in Victoria, TX today (${label})`
      : `Nothing is listed in Victoria, TX for today (${label}) yet`
  },
  {
    path: '/this-weekend',
    nav: 'This Weekend',
    title: 'Things To Do in Victoria, TX This Weekend',
    h1: 'Things to do in Victoria, TX this weekend',
    description: 'Events in Victoria, Texas this weekend: concerts, festivals, family events, markets, and free things to do Friday through Sunday.',
    range: 'weekend',
    image: '/social/latest/weekend-1.png',
    lead: (n, label) => n
      ? `There ${n === 1 ? 'is 1 event' : `are ${n} events`} in Victoria, TX this weekend (${label})`
      : `Nothing is listed in Victoria, TX for this weekend (${label}) yet`
  },
  {
    path: '/free-things-to-do',
    nav: 'Free',
    title: 'Free Things To Do in Victoria, TX',
    h1: 'Free things to do in Victoria, TX',
    description: 'Upcoming free events in Victoria, Texas: library programs, community events, outdoor activities, and more.',
    range: 'upcoming',
    filter: ev => ev.free === true || (ev.icons || []).includes('free'),
    lead: (n) => n
      ? `There ${n === 1 ? 'is 1 free event' : `are ${n} free events`} coming up in Victoria, TX`
      : 'No free events are listed in Victoria, TX right now'
  },
  {
    path: '/kids-and-family',
    nav: 'Kids & Family',
    title: 'Kids & Family Events in Victoria, TX',
    h1: 'Kids and family events in Victoria, TX',
    description: 'Family-friendly things to do in Victoria, Texas: story times, kids activities, all-ages shows, and outdoor fun.',
    range: 'upcoming',
    filter: ev => (ev.icons || []).includes('family'),
    lead: (n) => n
      ? `There ${n === 1 ? 'is 1 family-friendly event' : `are ${n} family-friendly events`} coming up in Victoria, TX`
      : 'No family events are listed in Victoria, TX right now'
  },
  {
    path: '/live-music',
    nav: 'Live Music',
    title: 'Live Music in Victoria, TX This Week',
    h1: 'Live music in Victoria, TX',
    description: 'Live music in Victoria, Texas: concerts, bands, open mics, and karaoke at local bars and venues.',
    range: 'upcoming',
    filter: ev => (ev.icons || []).includes('music'),
    lead: (n) => n
      ? `There ${n === 1 ? 'is 1 live music event' : `are ${n} live music events`} coming up in Victoria, TX`
      : 'No live music is listed in Victoria, TX right now'
  },
  {
    path: '/food-and-drink',
    nav: 'Food & Drink',
    title: 'Food & Drink Events in Victoria, TX',
    h1: 'Food and drink events in Victoria, TX',
    description: 'Food and drink events in Victoria, Texas: farmers markets, food trucks, tastings, brunches, and happy hours.',
    range: 'upcoming',
    filter: ev => (ev.icons || []).some(i => i === 'food' || i === 'drinks'),
    lead: (n) => n
      ? `There ${n === 1 ? 'is 1 food and drink event' : `are ${n} food and drink events`} coming up in Victoria, TX`
      : 'No food and drink events are listed in Victoria, TX right now'
  },
  {
    path: '/tonight',
    nav: 'Tonight',
    hidden: true,
    title: 'Things To Do in Victoria, TX Tonight',
    h1: 'Things to do in Victoria, TX tonight',
    description: 'What\'s happening tonight in Victoria, Texas: live music, trivia, karaoke, shows, and late events starting this evening.',
    range: 'today',
    filter: isEvening,
    lead: (n, label) => n
      ? `There ${n === 1 ? 'is 1 event' : `are ${n} events`} tonight in Victoria, TX (${label})`
      : `Nothing is listed for tonight in Victoria, TX (${label}) yet`
  },
  {
    path: '/date-night',
    nav: 'Date Night',
    hidden: true,
    title: 'Date Night Ideas in Victoria, TX',
    h1: 'Date night ideas in Victoria, TX',
    description: 'Date night in Victoria, Texas: live music, theatre, art nights, wine and beer, and dinner events this week.',
    range: 'upcoming',
    filter: ev => isEvening(ev) && (ev.icons || []).some(i => ['music', 'arts', 'drinks', 'food'].includes(i)) &&
      !(ev.icons || []).includes('family'),
    lead: (n) => n
      ? `There ${n === 1 ? 'is 1 date-night pick' : `are ${n} date-night picks`} coming up in Victoria, TX`
      : 'No date-night events are listed in Victoria, TX right now'
  },
  {
    path: '/next-week',
    nav: 'Next Week',
    hidden: true,
    title: 'Things To Do in Victoria, TX Next Week',
    h1: 'Things to do in Victoria, TX next week',
    description: 'Events in Victoria, Texas next week, Monday through Sunday: live music, festivals, family events, markets, and more.',
    range: 'next-week',
    weekLink: { href: '/', label: '← This week' },
    lead: (n, label) => n
      ? `There ${n === 1 ? 'is 1 event' : `are ${n} events`} in Victoria, TX next week (${label})`
      : `Nothing is listed in Victoria, TX for next week (${label}) yet. New events are added every Sunday and Wednesday`
  },
  {
    path: '/this-weekend-with-kids',
    nav: 'Weekend with Kids',
    hidden: true,
    title: 'Things To Do With Kids in Victoria, TX This Weekend',
    h1: 'Things to do with kids in Victoria, TX this weekend',
    description: 'Kid-friendly events in Victoria, Texas this weekend: story times, festivals, the zoo, crafts, and family fun.',
    range: 'weekend',
    filter: ev => (ev.icons || []).includes('family'),
    lead: (n, label) => n
      ? `There ${n === 1 ? 'is 1 kid-friendly event' : `are ${n} kid-friendly events`} in Victoria, TX this weekend (${label})`
      : `No kid-friendly events are listed for this weekend (${label}) yet`
  },
  {
    path: '/free-this-weekend',
    nav: 'Free This Weekend',
    hidden: true,
    title: 'Free Things To Do in Victoria, TX This Weekend',
    h1: 'Free things to do in Victoria, TX this weekend',
    description: 'Free events in Victoria, Texas this weekend: markets, library programs, festivals, outdoor fun, and community events.',
    range: 'weekend',
    filter: ev => ev.free === true || (ev.icons || []).includes('free'),
    lead: (n, label) => n
      ? `There ${n === 1 ? 'is 1 free event' : `are ${n} free events`} in Victoria, TX this weekend (${label})`
      : `No free events are listed for this weekend (${label}) yet`
  },
  {
    path: '/nightlife',
    nav: 'Nightlife',
    hidden: true,
    title: 'Nightlife in Victoria, TX: Bars, Live Music & Karaoke',
    h1: 'Nightlife in Victoria, TX',
    description: 'Nightlife in Victoria, Texas this week: bar shows, live bands, karaoke, trivia, and late events.',
    range: 'upcoming',
    filter: ev => isEvening(ev) && (ev.icons || []).some(i => ['music', 'drinks'].includes(i)) &&
      !(ev.icons || []).includes('family'),
    lead: (n) => n
      ? `There ${n === 1 ? 'is 1 nightlife event' : `are ${n} nightlife events`} coming up in Victoria, TX`
      : 'No nightlife events are listed in Victoria, TX right now'
  },
  {
    path: '/arts-and-culture',
    nav: 'Arts & Culture',
    hidden: true,
    title: 'Arts & Culture Events in Victoria, TX',
    h1: 'Arts and culture events in Victoria, TX',
    description: 'Art, theatre, museums, and culture in Victoria, Texas: gallery nights, plays, concerts, and exhibits coming up.',
    range: 'upcoming',
    filter: ev => (ev.icons || []).includes('arts'),
    lead: (n) => n
      ? `There ${n === 1 ? 'is 1 arts event' : `are ${n} arts and culture events`} coming up in Victoria, TX`
      : 'No arts events are listed in Victoria, TX right now'
  },
  {
    path: '/outdoor-events',
    nav: 'Outdoors',
    hidden: true,
    title: 'Outdoor Events in Victoria, TX',
    h1: 'Outdoor events in Victoria, TX',
    description: 'Outdoor things to do in Victoria, Texas: parks, runs, markets, festivals, and events at Riverside Park and around town.',
    range: 'upcoming',
    filter: ev => (ev.icons || []).includes('outdoors'),
    lead: (n) => n
      ? `There ${n === 1 ? 'is 1 outdoor event' : `are ${n} outdoor events`} coming up in Victoria, TX`
      : 'No outdoor events are listed in Victoria, TX right now'
  }
];

// ─── Escaping ────────────────────────────────────────────────────────────

export function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Event URLs come from scrapers and public submissions; only http(s) is
// ever rendered as a link so a `javascript:` URL can't ride along.
export function safeUrl(url) {
  if (typeof url !== 'string') return '';
  const u = url.trim();
  // No whitespace, quotes or angle brackets: a URL that needs them is
  // either broken or trying to break out of an attribute.
  return /^https?:\/\/[^\s"'<>`]+$/i.test(u) ? u : '';
}

// JSON-LD lives inside a <script> tag, so "</script>" in an event name
// would end it early. Escaping "<" keeps the JSON valid and inert.
function jsonLd(obj) {
  return '<script type="application/ld+json">' +
    JSON.stringify(obj).replace(/</g, '\\u003c') +
    '</script>';
}

// ─── Dates (America/Chicago) ─────────────────────────────────────────────

// YYYY-MM-DD for `now` as seen in Victoria.
export function localDateStr(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  return parts; // en-CA formats as YYYY-MM-DD
}

function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)); // noon UTC dodges DST edges
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(s, n) {
  const d = parseYmd(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

function weekday(s) {
  return parseYmd(s).getUTCDay(); // 0 = Sunday
}

export function formatDay(s, opts) {
  return parseYmd(s).toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC' }, opts));
}

function formatRange(start, end) {
  const a = formatDay(start, { month: 'short', day: 'numeric' });
  if (start === end) return formatDay(start, { weekday: 'long', month: 'long', day: 'numeric' });
  const b = formatDay(end, { month: 'short', day: 'numeric' });
  return `${a} to ${b}`;
}

// Monday–Sunday of the current week, matching what docs/app.js renders.
export function currentWeek(today) {
  const dow = weekday(today);
  const monday = addDays(today, dow === 0 ? -6 : 1 - dow);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

export function dateRange(kind, today) {
  if (kind === 'today') return [today, today];
  if (kind === 'next-week') {
    const monday = addDays(currentWeek(today)[0], 7);
    return [monday, addDays(monday, 6)];
  }
  if (kind === 'weekend') {
    // Mon–Thu: the coming Fri–Sun. Fri–Sun: from today through Sunday.
    const dow = weekday(today);
    if (dow === 0) return [today, today];
    if (dow >= 5) return [today, addDays(today, 7 - dow)];
    return [addDays(today, 5 - dow), addDays(today, 7 - dow)];
  }
  // Everything published from today on. The payload is curated and
  // usually covers ~2 weeks, but a festival added early should still show.
  return [today, addDays(today, UPCOMING_DAYS)];
}

// Chicago UTC offset ("-05:00" / "-06:00") for a given date, so JSON-LD
// startDate carries an explicit offset as Google recommends.
export function chicagoOffset(dateStr) {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, timeZoneName: 'shortOffset'
  }).formatToParts(parseYmd(dateStr)).find(p => p.type === 'timeZoneName');
  const m = name && name.value.match(/GMT([+-]\d+)/);
  const h = m ? Number(m[1]) : -6;
  return (h < 0 ? '-' : '+') + String(Math.abs(h)).padStart(2, '0') + ':00';
}

// Pull "7:00 PM" / "10am" style times out of free-form strings like
// "10:00AM – 11:00AM" or "10am - 3pm". Returns ["HH:MM", ...] (24h).
export function parseTimes(time) {
  if (!time) return [];
  const out = [];
  const re = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/gi;
  let m;
  while ((m = re.exec(time)) && out.length < 2) {
    let h = Number(m[1]) % 12;
    if (m[3].toLowerCase() === 'p') h += 12;
    out.push(String(h).padStart(2, '0') + ':' + (m[2] || '00'));
  }
  return out;
}

// Sort key in minutes; untimed events sort last, like the client.
function timeKey(ev) {
  const t = parseTimes(ev.time)[0];
  if (!t) return 9999;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// ─── Events ──────────────────────────────────────────────────────────────

export function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

// Attach a stable `page` path to each event: /events/<date>-<name-slug>.
// Same date + name twice gets -2, -3 in payload order so links stay unique.
// Some sources hand us text that's already HTML-encoded ("Texas A&amp;M");
// decode it once so escaping on render doesn't show "&amp;" on the page.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(str) {
  if (typeof str !== 'string' || !str.includes('&')) return str;
  return str.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

// Venue line under an event name: "Venue · street address", without
// repeating the address when the venue field already is one.
export function placeText(ev) {
  let venue = (ev.venue || '').trim();
  const addr = (ev.address || '').trim();
  if (/^\d/.test(venue)) venue = venue.split(',')[0].trim();
  if (!venue) return addr;
  const v = venue.toLowerCase(), a = addr.toLowerCase();
  if (!addr || v.includes(a) || a.includes(v)) return venue;
  return `${venue} · ${addr}`;
}

// Search and category pages ("music in Victoria") aren't a link to the event.
const LISTING_URL = [
  /eventbrite\.[a-z.]+\/(b|d)\//i,
  /allevents\.in\/[^/]+\/?(all|this-weekend|today|tomorrow|[a-z-]+-events)?\/?(\?|#|$)/i,
  /facebook\.com\/events\/?(explore|search|discover)?\/?(\?|#|$)/i
];
export function isListingUrl(url) {
  return typeof url === 'string' && LISTING_URL.some(re => re.test(url.trim()));
}

// Event-specific URLs carry the event's name in a slug
// (facebook.com/events/<slug>/<id>, allevents.in/<city>/<slug>/<id>,
// eventbrite.com/e/<slug>-tickets-<id>). If that slug shares no word with the
// event's name, the link belongs to some other event.
const SLUG_HOSTS = /(^|\.)(facebook\.com|allevents\.in|eventbrite\.[a-z.]+|victoriachamber\.org)$/i;
const STOP = new Set('the and at in of for with on to tx victoria texas united states event events tickets night live free'.split(' '));
function words(text) {
  return new Set(String(text || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // "Música" -> "musica", like the slug
    .replace(/['’.]/g, '').split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w))
    .map(w => w.slice(0, 5)));
}
export function isMismatchedUrl(url, name) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!SLUG_HOSTS.test(u.hostname)) return false;
  // A Facebook post can be a roundup of several events; only event links count.
  if (/facebook\.com$/i.test(u.hostname) && !u.pathname.startsWith('/events/')) return false;
  const slug = u.pathname.split('/').filter(seg => /[a-z]/i.test(seg) && seg.includes('-')).pop();
  if (!slug) return false;
  const a = words(slug), b = words(name);
  if (!a.size || !b.size) return false;
  for (const w of a) if (b.has(w)) return false;
  return true;
}

// What the event page's button should say for a link.
export function linkLabel(url) {
  let u;
  try { u = new URL(url); } catch { return 'Event details'; }
  const host = u.hostname.replace(/^www\./, '');
  const segs = u.pathname.split('/').filter(Boolean);
  if (/instagram\.com$/.test(host)) return segs[0] === 'p' || segs[0] === 'reel' ? 'See the post' : 'Venue page';
  if (/facebook\.com$/.test(host)) {
    if (segs[0] === 'events' && segs.length > 1) return 'Event details';
    return segs.includes('posts') ? 'See the post' : 'Venue page';
  }
  const last = (segs[segs.length - 1] || '').toLowerCase();
  if (!segs.length || (segs.length === 1 && /^(events?|calendar|index\.php)$/.test(last)) || /search/.test(u.search)) return 'Venue website';
  return 'Event details';
}

// Links found dead or wrong in the Oct 2026 audit, fixed on events that are
// already published. The collector's venue table carries the same fixes.
const FIXED_URLS = {
  'https://www.victoriatx.gov/government/departments/parks-recreation': 'https://www.victoriatx.gov/1330/Parks-Recreation',
  'https://www.navemuseum.com': 'https://navemuseum.org',
  'https://www.victoriafineartscentre.org': 'https://victoriafinearts.org',
  'https://www.weaverhouseconcerts.com': ''
};

export function withPages(events) {
  const seen = new Map();
  return (Array.isArray(events) ? events : [])
    .filter(ev => ev && ev.date && ev.name)
    .map(ev => {
      // Slug from the stored name so existing event URLs don't move.
      const base = `${ev.date}-${slugify(ev.name) || 'event'}`;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      const clean = {};
      for (const k of ['name', 'venue', 'address', 'description', 'time']) {
        if (typeof ev[k] === 'string') clean[k] = decodeEntities(ev[k]);
      }
      const fixed = typeof ev.url === 'string' ? FIXED_URLS[ev.url.trim().replace(/\/$/, '')] : undefined;
      if (fixed !== undefined) clean.url = fixed;
      if (isListingUrl(ev.url) || isMismatchedUrl(ev.url, ev.name)) clean.url = '';
      return Object.assign({}, ev, clean, { page: `/events/${n === 1 ? base : `${base}-${n}`}` });
    });
}

// By date, then featured (paid) events first within a day, then by time.
export function sortEvents(list) {
  return list.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (Boolean(a.featured) !== Boolean(b.featured)) return a.featured ? -1 : 1;
    return timeKey(a) - timeKey(b);
  });
}

export function eventsBetween(events, start, end, filter) {
  return sortEvents(events.filter(ev =>
    ev.date >= start && ev.date <= end && (!filter || filter(ev))));
}

export function eventJsonLd(ev, siteUrl) {
  const times = parseTimes(ev.time);
  const offset = chicagoOffset(ev.date);
  const startDate = times[0] ? `${ev.date}T${times[0]}:00${offset}` : ev.date;
  const obj = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: ev.name,
    startDate,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: ev.venue || 'Victoria, TX',
      address: {
        '@type': 'PostalAddress',
        ...(ev.address ? { streetAddress: ev.address } : {}),
        addressLocality: 'Victoria',
        addressRegion: 'TX',
        addressCountry: 'US'
      }
    },
    image: [`${siteUrl}/og-image.png`],
    url: `${siteUrl}${ev.page}`
  };
  if (times[1]) obj.endDate = `${ev.date}T${times[1]}:00${offset}`;
  if (ev.description) obj.description = ev.description;
  if (ev.free === true) {
    obj.isAccessibleForFree = true;
    obj.offers = {
      '@type': 'Offer', price: 0, priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      url: safeUrl(ev.url) || `${siteUrl}${ev.page}`
    };
  }
  return obj;
}

// ─── HTML pieces ─────────────────────────────────────────────────────────

function icons(ev) {
  return (ev.icons || []).filter(k => ICON_KEYS.has(k)).map(iconSvg).join('');
}

// Mirrors renderEvent() in docs/app.js so the server markup and the
// client re-render look identical. The name links to our event page (the
// crawlable, internal link); the venue keeps the external source link.
export function renderEventItem(ev) {
  const place = placeText(ev);
  return `<li class="event-entry${ev.featured ? ' event-entry--featured' : ''}" data-icons="${escHtml((ev.icons || []).join(' ') + (ev.free === true ? ' free' : ''))}">` +
    `<span class="event-icons" aria-hidden="true">${icons(ev)}</span>` +
    '<div class="event-details">' +
      (ev.featured ? '<span class="badge badge--featured">Vic’s Pick</span> ' : '') +
      (ev.time ? `<span class="event-time">${escHtml(ev.time)}</span> ` : '') +
      `<span class="event-name"><a href="${escHtml(ev.page)}">${escHtml(ev.name)}</a></span>` +
      (place ? `<span class="event-venue">${escHtml(place)}</span>` : '') +
      (ev.description ? `<div class="event-desc">${escHtml(ev.description)}</div>` : '') +
    '</div>' +
  '</li>';
}

function renderDay(dateStr, list, idx, today) {
  const badge = dateStr === today ? ' <span class="today-badge">Today</span>' : '';
  const body = list.length
    ? `<ul class="event-list" role="list">${list.map(renderEventItem).join('')}</ul>`
    : '<div class="empty-state">Nothing listed yet — know something happening? <a href="/submit">Submit an event.</a></div>';
  return `<section class="day-section" id="day-${idx}">` +
    '<div class="day-header">' +
      `<h2 class="day-name">${formatDay(dateStr, { weekday: 'long' })}${badge}</h2>` +
      `<span class="day-date">${formatDay(dateStr, { month: 'long', day: 'numeric' })}</span>` +
    '</div>' + body +
  '</section>';
}

// Day sections for an arbitrary list of dates (homepage = Mon–Sun).
export function renderDays(dates, events, today) {
  return dates.map((d, i) => renderDay(d, sortEvents(events.filter(ev => ev.date === d)), i, today)).join('');
}

// Day sections only for dates that have events (intent pages).
export function renderGrouped(list, today) {
  const dates = [...new Set(list.map(ev => ev.date))];
  return dates.map((d, i) => renderDay(d, list.filter(ev => ev.date === d), i, today)).join('');
}

// In-season guides are request-specific, so pages carry a placeholder the
// server fills per response (fillSeasonalNav) instead of sharing state
// between concurrent requests.
export const SEASONAL_NAV_SLOT = '<!--SEASONAL_NAV-->';

export function seasonalNavLinks(seasons, current) {
  return (seasons || []).map(p =>
    `<a href="${p.path}"${p.path === current ? ' aria-current="page"' : ''}>${escHtml(p.nav)}</a>`).join('');
}

export function fillSeasonalNav(html, seasons, current) {
  return html.split(SEASONAL_NAV_SLOT).join(seasonalNavLinks(seasons, current));
}

export function navHtml(current) {
  const links = HUB_PAGES.filter(p => !p.hidden).map(p =>
    `<a href="${p.path}"${p.path === current ? ' aria-current="page"' : ''}>${escHtml(p.nav)}</a>`);
  return `<nav class="browse-nav" aria-label="Browse events"><div class="container browse-inner">${SEASONAL_NAV_SLOT}${links.join('')}</div></nav>`;
}

function headerHtml() {
  return `<header class="site-header" id="site-header">
    <div class="container header-inner">
      <a class="logo-group" href="/">
        <img src="/logo.png" width="48" height="48" alt="The Vic 361 logo" class="site-logo site-logo--light" />
        <img src="/logo-dark.png" width="48" height="48" alt="" aria-hidden="true" class="site-logo site-logo--dark" />
        <div>
          <div class="site-title">The Vic <span>361</span></div>
          <div class="tagline">Events &amp; Things To Do in <span class="tagline-accent">Victoria, TX</span></div>
        </div>
      </a>
      <div class="header-actions">
        <a href="/submit" class="btn btn--outline desktop-submit">Submit an Event</a>
        <a href="/subscribe" class="btn btn--primary">Subscribe</a>
      </div>
    </div>
  </header>`;
}

function footerHtml() {
  const year = new Date().getUTCFullYear();
  return `<footer class="site-footer">
    <div class="container">
      <div class="footer-grid">
        <div class="footer-section">
          <h2>Stay in the loop</h2>
          <p>Get Victoria's best events in your inbox every week.</p>
          <a href="/subscribe" class="btn btn--primary">Subscribe free</a>
        </div>
        <div class="footer-section">
          <h2>Browse</h2>
          <ul class="footer-links" role="list">
            <li><a href="/">This week</a></li>
            ${HUB_PAGES.map(p => `<li><a href="${p.path}">${escHtml(p.nav)}</a></li>`).join('\n            ')}
          </ul>
        </div>
        <div class="footer-section">
          <h2>About</h2>
          <ul class="footer-links" role="list">
            <li><a href="/about">About The Vic 361</a></li>
            <li><a href="/submit">Submit an event</a></li>
            <li><a href="/venues">Venues</a></li>
            <li><a href="/advertise">Advertise</a></li>
            <li><a href="/contact">Contact</a></li>
            <li><a href="/privacy">Privacy</a></li>
          </ul>
        </div>
      </div>
      <div class="footer-bottom"><span>&copy; ${year} The Vic 361 · Victoria, TX</span></div>
    </div>
  </footer>`;
}

export function breadcrumbLd(siteUrl, trail) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({
      '@type': 'ListItem', position: i + 1, name: t.name, item: siteUrl + t.path
    }))
  };
}

// pixel: false leaves the Meta Pixel off a page. Pages reached from links
// carrying a subscriber's token (confirm, unsubscribe) use it: the pixel
// reports the full URL to Meta, token included.
export function layout({ siteUrl, path, title, description, body, ld = [], noindex = false, nav = path, image = '/og-image.png', pixel = true }) {
  const url = siteUrl + path;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<!-- Google tag (gtag.js); same property as docs/index.html -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}');</script>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
<meta name="description" content="${escHtml(description)}">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${escHtml(url)}">`}
<meta property="og:type" content="website">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(description)}">
<meta property="og:url" content="${escHtml(url)}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:image" content="${siteUrl}${image}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<!-- Fonts load without blocking first paint; text shows in the fallback face until they arrive. -->
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400..700&family=Nunito:ital,wght@0,400..900;1,400..900&display=swap" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400..700&family=Nunito:ital,wght@0,400..900;1,400..900&display=swap"></noscript>
<link rel="stylesheet" href="/base.css">
<link rel="stylesheet" href="/style.css">
${ld.map(jsonLd).join('\n')}
</head>
<body>
${headerHtml()}
${navHtml(nav)}
<main class="main-content">
  <div class="container container--narrow">
${body}
  </div>
</main>
${footerHtml()}
${pixel ? '<script src="/pixel.js" defer></script>\n' : ''}<script src="/track.js" defer></script>
<script src="/turnstile.js" defer></script>
</body>
</html>`;
}

// Mirrors renderSponsor() in docs/app.js so the paid sponsor slot shows on
// every page, not just the homepage.
export function sponsorHtml(sponsor) {
  if (!sponsor || !sponsor.name) return '';
  const href = safeUrl(sponsor.url);
  const cta = sponsor.cta
    ? (href
      ? `<a href="${escHtml(href)}" class="btn btn--outline sponsor-cta" target="_blank" rel="noopener noreferrer">${escHtml(sponsor.cta)}</a>`
      : `<span class="btn btn--outline" style="cursor:default; opacity:0.6">${escHtml(sponsor.cta)}</span>`)
    : '';
  return '<section class="sponsor-section"><div class="sponsor-block">' +
    '<div class="sponsor-label">This week\'s sponsor</div>' +
    `<div class="sponsor-name">${escHtml(sponsor.name)}</div>` +
    (sponsor.text ? `<div class="sponsor-text">${escHtml(sponsor.text)}</div>` : '') +
    (sponsor.address ? `<div class="sponsor-address">📍 ${escHtml(sponsor.address)}</div>` : '') +
    cta + '</div></section>';
}

export function ctaHtml() {
  return `<p class="page-cta">Get the full list every week: <a href="/subscribe">subscribe to The Vic 361 newsletter</a>. Know something we missed? <a href="/submit">Submit an event</a>.</p>`;
}

// Short "including A, B, and C" clause from the first few names.
function including(list) {
  const names = [...new Set(list.map(ev => ev.name))].slice(0, 3);
  if (!names.length) return '';
  if (names.length === 1) return `, including ${names[0]}`;
  return `, including ${names.slice(0, -1).join(', ')}${names.length > 2 ? ',' : ''} and ${names[names.length - 1]}`;
}

export function renderHubPage(page, events, { siteUrl, now, sponsor }) {
  const today = localDateStr(now);
  const [start, end] = dateRange(page.range, today);
  const list = eventsBetween(events, start, end, page.filter);
  const label = formatRange(start, end);
  const lead = page.lead(list.length, label) + (list.length ? including(list) : '') + '.';
  const body = `
    <h1 class="page-title">${escHtml(page.h1)}</h1>
    <p class="page-lead">${escHtml(lead)}</p>
    ${page.weekLink ? `<p class="week-nav"><a href="${escHtml(page.weekLink.href)}">${escHtml(page.weekLink.label)}</a></p>` : ''}
    ${list.length ? `<p class="share-row"><button type="button" class="share-btn share-btn--list" data-share-url="${escHtml(siteUrl + page.path)}" data-share-text="${escHtml(page.h1)}" data-track="share_list">Share this list</button></p>` : ''}
    ${list.length
      ? renderGrouped(list, today)
      : `<div class="empty-state">Check <a href="/">this week's full list</a>, or <a href="/submit">submit an event</a>.</div>`}
    ${sponsorHtml(sponsor)}
    ${ctaHtml()}`;
  const ld = [
    breadcrumbLd(siteUrl, [{ name: SITE_NAME, path: '/' }, { name: page.nav, path: page.path }]),
    ...list.map(ev => eventJsonLd(ev, siteUrl))
  ];
  return layout({ siteUrl, path: page.path, title: `${page.title} | ${SITE_NAME}`, description: page.description, body, ld, image: page.image });
}

export function renderEventPage(ev, events, { siteUrl, now, sponsor, extras = '', venuePath = null }) {
  const today = localDateStr(now);
  const src = safeUrl(ev.url);
  const when = formatDay(ev.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const where = [ev.venue, ev.address].filter(Boolean).join(', ');
  const lead = `${ev.name} ${ev.date < today ? 'was' : 'is'} on ${when}${ev.time ? ` at ${ev.time}` : ''}` +
    `${where ? ` at ${where}` : ''} in Victoria, TX.` + (ev.free === true ? ' Free to attend.' : '');
  const sameDay = sortEvents(events.filter(o => o.date === ev.date && o.page !== ev.page)).slice(0, 6);
  const description = (ev.description ? ev.description + ' ' : '') +
    `${when}${where ? ` at ${where}` : ''}, Victoria, TX.`;
  const body = `
    <p class="breadcrumbs"><a href="/">This week</a> › ${escHtml(ev.name)}</p>
    <h1 class="page-title">${escHtml(ev.name)}</h1>
    ${ev.featured ? '<p class="event-pick"><span class="badge badge--featured">Vic’s Pick</span> Featured on The Vic 361</p>' : ''}
    <p class="page-lead">${escHtml(lead)}</p>
    ${ev.date < today ? `<p class="past-notice">This event has passed. <a href="/">See what's happening this week</a>.</p>` : ''}
    <dl class="event-facts">
      <dt>When</dt><dd>${escHtml(when)}${ev.time ? `, ${escHtml(ev.time)}` : ''}</dd>
      ${where ? `<dt>Where</dt><dd>${escHtml(where)}</dd>` : ''}
      <dt>Cost</dt><dd>${ev.free === true ? 'Free' : 'See event details'}</dd>
    </dl>
    ${ev.description ? `<p class="event-about">${escHtml(ev.description)}</p>` : ''}
    ${src ? `<p class="page-actions"><a class="btn btn--primary" href="${escHtml(src)}" target="_blank" rel="noopener noreferrer">${linkLabel(src)}</a></p>` : ''}
    ${extras}
    ${venuePath ? `<p class="venue-more"><a href="${escHtml(venuePath)}">More events at ${escHtml(ev.venue)} →</a></p>` : ''}
    ${sameDay.length ? `<h2 class="section-heading">Also on ${escHtml(formatDay(ev.date, { weekday: 'long' }))}</h2>
    <ul class="event-list" role="list">${sameDay.map(renderEventItem).join('')}</ul>` : ''}
    ${sponsorHtml(sponsor)}
    ${ctaHtml()}`;
  const ld = [
    eventJsonLd(ev, siteUrl),
    breadcrumbLd(siteUrl, [{ name: SITE_NAME, path: '/' }, { name: ev.name, path: ev.page }])
  ];
  return layout({
    siteUrl, path: ev.page, nav: null,
    title: `${ev.name} · ${formatDay(ev.date, { month: 'short', day: 'numeric' })} | ${SITE_NAME}`,
    description: description.slice(0, 300), body, ld
  });
}

// Plain-language privacy notice. Meta's Business Tools terms require one
// once the Pixel runs; it also covers analytics, the newsletter and forms.
export const PRIVACY_UPDATED = 'October 5, 2026';
export function renderPrivacyPage({ siteUrl }) {
  const body = `
    <h1 class="page-title">Privacy</h1>
    <p class="page-lead">The Vic 361 is a free events guide for Victoria, Texas. This page explains what we collect, why, and the choices you have. Last updated ${PRIVACY_UPDATED}.</p>
    <h2 class="section-heading">What you give us</h2>
    <ul>
      <li><strong>Newsletter:</strong> your email address, so we can send the weekly list. Every email has a one-click unsubscribe link. We don't sell or share your address.</li>
      <li><strong>Event submissions and contact messages:</strong> what you type into those forms, used to review your event or answer you.</li>
      <li><strong>Sponsor purchases:</strong> payments are handled by Stripe; we never see your card number. We keep your name, email, business and order details.</li>
    </ul>
    <h2 class="section-heading">What we measure</h2>
    <ul>
      <li><strong>Our own visit counts:</strong> which pages are viewed and which links are clicked, so we know what's useful. We don't use cookies for this and don't store IP addresses; a visitor is a one-way code that changes every day.</li>
      <li><strong>Google Analytics</strong> measures visits to the site and uses cookies. See <a href="https://policies.google.com/technologies/partner-sites" rel="noopener">how Google uses this data</a>.</li>
      <li><strong>Meta Pixel:</strong> when we advertise on Facebook and Instagram, the Meta Pixel tells Meta that someone visited from an ad or signed up for the newsletter, so we can see whether our ads work and show them to people likely to be interested. Meta may combine this with what it knows about your Meta account. It's never loaded on the newsletter confirm or unsubscribe pages. You can control this in your <a href="https://www.facebook.com/adpreferences/ad_settings" rel="noopener">Meta ad settings</a>.</li>
    </ul>
    <h2 class="section-heading">Services we use</h2>
    <p>Railway hosts the site and its database; Resend delivers our emails; Cloudflare Turnstile checks that forms are sent by people, not bots; Stripe takes sponsor payments. Each only gets what it needs to do that job.</p>
    <h2 class="section-heading">Your choices</h2>
    <ul>
      <li>Unsubscribe from any newsletter with the link at the bottom, any time.</li>
      <li>Block or delete cookies in your browser settings; the site works without them.</li>
      <li>Ask us to see or delete what we have about you through our <a href="/contact">contact page</a>.</li>
    </ul>`;
  return layout({
    siteUrl, path: '/privacy',
    title: `Privacy | ${SITE_NAME}`,
    description: 'What The Vic 361 collects, why, and the choices you have.',
    body
  });
}

export function renderAboutPage({ siteUrl }) {
  const body = `
    <h1 class="page-title">About The Vic 361</h1>
    <p class="page-lead">The Vic 361 is a free weekly guide to events and things to do in Victoria, Texas. Every week we collect concerts, festivals, family activities, markets, and community events from across Victoria and publish them in one list, on this site and in our email newsletter.</p>
    <h2 class="section-heading">How we build the list</h2>
    <p>We gather events from the City of Victoria, the Victoria Public Library, the Chamber of Commerce, local venues, and community submissions. A local editor reviews every event before it's published.</p>
    <h2 class="section-heading">Get it every week</h2>
    <p><a href="/subscribe">Subscribe to the newsletter</a> for the week's best events, every Monday.</p>
    <h2 class="section-heading">List your event or business</h2>
    <p>Anyone can <a href="/submit">submit an event</a> for free. Venues and businesses can <a href="/advertise">sponsor the newsletter or feature an event</a>.</p>`;
  const ld = [{
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: siteUrl + '/',
    logo: siteUrl + '/logo-512.png',
    description: 'Weekly guide to events and things to do in Victoria, Texas.',
    areaServed: { '@type': 'City', name: 'Victoria, Texas' }
  }];
  return layout({
    siteUrl, path: '/about',
    title: `About | ${SITE_NAME}`,
    description: 'The Vic 361 is a free weekly guide to events and things to do in Victoria, Texas.',
    body, ld
  });
}

// Packages and prices here are the starting offer; change them in one place.
// amount is in cents and is what Stripe charges (server/sponsors.js).
export const AD_PACKAGES = [
  {
    key: 'weekly',
    name: 'Weekly sponsor',
    price: '$300 / week',
    amount: 30000,
    blurb: 'Pick a week and write your message; it goes live on its own that Monday.',
    where: 'Every page of thevic361.com for a whole week, plus the top of that Monday’s newsletter.',
    limit: 'One sponsor a week, so you’re the only one.',
    points: [
      'Your name, message and button on every page of the site, all week',
      'The sponsor spot at the top of the Monday newsletter',
      'A click report at the end of the week'
    ]
  },
  {
    key: 'partner',
    name: 'Venue partner',
    price: '$150 / month',
    amount: 15000,
    interval: 'month',
    blurb: 'Every event at your venue is a Vic’s Pick for as long as you stay subscribed.',
    where: 'Every event at your venue, every week: pinned to the top of its day with the Vic’s Pick badge.',
    limit: 'Cancel any time; it ends on its own.',
    points: [
      'Every event at your venue marked as a Vic’s Pick, every week',
      'Pinned at the top of each day on the site and its event pages',
      'Starred in the newsletter and our social posts, plus a monthly click report'
    ]
  },
  {
    key: 'featured',
    name: 'Vic’s Pick',
    price: '$49 Mon–Thu · $89 Fri–Sun',
    amount: 4900,
    blurb: 'Tell us about your event. Once it\'s listed, it\'s pinned to the top of its day.',
    where: 'Your event at the top of its day with the Vic’s Pick badge, on the site, its event page, that week’s newsletter and our social posts.',
    limit: 'Only 3 a day Mon–Thu and 4 a day Fri–Sun, so book early.',
    points: [
      'Guaranteed listing, pinned at the top of its day on the site',
      'Starred in that week’s newsletter and featured first in our social posts',
      'Best for concerts, fundraisers, openings, and festivals'
    ]
  }
];

// previews: { [package key]: html } sample placements from
// server/sponsors.js samplePreviews(), the same renderer the checkout uses.
export function renderAdvertisePage({ siteUrl, checkout = false, previews = {} }) {
  const body = `
    <h1 class="page-title">Advertise on The Vic 361</h1>
    <p class="page-lead">Reach people in Victoria, TX who are actively looking for something to do this week. Here’s exactly what each option gets you and where it shows.</p>
    <div class="ad-packages ad-packages--rows">
      ${AD_PACKAGES.map(p => `
      <section class="ad-package ad-package--row" id="${escHtml(p.key)}">
        <div class="ad-package__info">
          <h2>${escHtml(p.name)}</h2>
          <p class="ad-price">${escHtml(p.price)}</p>
          <p class="ad-where"><strong>Where it shows:</strong> ${escHtml(p.where)}</p>
          <ul>${p.points.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul>
          <p class="ad-limit">${escHtml(p.limit)}</p>
          ${checkout ? `<a class="btn btn--primary ad-buy" href="/advertise/checkout?package=${escHtml(p.key)}">Preview yours and book →</a>` : ''}
        </div>
        ${previews[p.key] ? `<div class="ad-package__preview" aria-label="Example of a ${escHtml(p.name)}"><p class="ad-preview-label">Example</p>${previews[p.key]}</div>` : ''}
      </section>`).join('')}
    </div>
    <h2 class="section-heading">${checkout ? 'Questions?' : 'Get started'}</h2>
    <p>${checkout ? 'Pick a package above to book and pay online in a couple of minutes. Questions or a custom package?' : 'Tell us your business name and what you\'d like to promote, and we\'ll reply with open dates and our latest audience numbers.'} <a href="/contact?topic=advertising">Send us a message</a>.</p>
    <p>Listing a community event is always free: <a href="/submit">submit it here</a>.</p>`;
  return layout({
    siteUrl, path: '/advertise',
    title: `Advertise | ${SITE_NAME}`,
    description: 'Sponsor The Vic 361 newsletter, become a venue partner, or feature your event to reach people looking for things to do in Victoria, TX.',
    body
  });
}

export function renderNotFoundPage({ siteUrl }) {
  const body = `
    <h1 class="page-title">That event isn't listed anymore</h1>
    <p class="page-lead">It may have already happened. Here's what's on now:</p>
    <p><a class="btn btn--primary" href="/">See this week's events</a></p>`;
  return layout({ siteUrl, path: '/404', nav: null, noindex: true, title: `Not found | ${SITE_NAME}`, description: 'Page not found.', body });
}

// Homepage: inject this week's events + JSON-LD into docs/index.html so
// the first byte already has the content. docs/app.js re-renders the same
// list on load (and still powers the admin preview), so nothing changes
// for visitors with JS.
export function renderHome(template, events, { siteUrl, now, signupHtml = null }) {
  const today = localDateStr(now);
  const week = currentWeek(today);
  const weekEvents = events.filter(ev => ev.date >= week[0] && ev.date <= week[6]);
  const ld = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: SITE_NAME,
      url: siteUrl + '/',
      description: 'Events and things to do in Victoria, TX, updated every week.'
    },
    ...sortEvents(weekEvents).map(ev => eventJsonLd(ev, siteUrl))
  ];
  let page = template;
  // The newsletter signup form (server/newsletter.js) fills the footer slot.
  if (signupHtml) page = page.replace(/<!--SIGNUP_START-->[\s\S]*?<!--SIGNUP_END-->/, () => signupHtml);
  return page
    // Link previews show this week's list (the social-kit cover slide).
    .replace(/(<meta (?:property="og:image"|name="twitter:image") content=")[^"]*"/g, `$1${siteUrl}/social/latest/week-1.png"`)
    .replace(/<meta property="og:image:(?:width|height)"[^>]*>\n?/g, '')
    // Function replacements: event text can contain "$'" or "$&", which a
    // string replacement would expand into chunks of the page.
    .replace('<p class="loading-message">Loading events...</p>', () => renderDays(week, events, today))
    .replace('<!--NAV-->', () => navHtml('/'))
    .replace('</head>', () => ld.map(jsonLd).join('\n') + '\n</head>');
}

export function renderSitemap(events, { siteUrl, now, lastmod, extraPaths = [] }) {
  const today = localDateStr(now);
  const mod = (lastmod || '').slice(0, 10) || today;
  const urls = [
    { loc: '/', freq: 'daily', pri: '1.0', mod },
    ...HUB_PAGES.map(p => ({ loc: p.path, freq: 'daily', pri: '0.8', mod })),
    { loc: '/about', freq: 'monthly', pri: '0.4' },
    { loc: '/advertise', freq: 'monthly', pri: '0.3' },
    { loc: '/contact', freq: 'yearly', pri: '0.2' },
    { loc: '/submit', freq: 'monthly', pri: '0.4' },
    ...extraPaths.map(loc => ({ loc, freq: 'weekly', pri: '0.5', mod })),
    ...events.filter(ev => ev.date >= today).map(ev => ({ loc: ev.page, freq: 'weekly', pri: '0.6', mod }))
  ];
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(u => `  <url><loc>${escHtml(siteUrl + u.loc)}</loc>` +
      (u.mod ? `<lastmod>${u.mod}</lastmod>` : '') +
      `<changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n') +
    '\n</urlset>\n';
}

// llms.txt (llmstxt.org): a plain-text map of the site for AI assistants,
// plus this week's events inline so an answer engine can cite them
// without crawling every page.
// Sponsors and Vic's Picks are spelled out (and labeled as paid) so an
// assistant that answers from this file passes them along too.
export function renderLlmsTxt(events, { siteUrl, now, extraLinks = [], sponsor = null }) {
  const today = localDateStr(now);
  const upcoming = eventsBetween(events, today, addDays(today, UPCOMING_DAYS));
  const picks = upcoming.filter(ev => ev.featured);
  const lines = [
    '# The Vic 361',
    '',
    '> Free weekly guide to events and things to do in Victoria, Texas (the 361 area code). Concerts, festivals, family activities, farmers markets, art shows, and community events, reviewed by a local editor and updated every week.',
    '',
    '## Pages',
    '',
    `- [This week in Victoria, TX](${siteUrl}/): every event Monday through Sunday`,
    ...HUB_PAGES.map(p => `- [${p.title}](${siteUrl}${p.path}): ${p.description}`),
    ...extraLinks.map(([title, path, desc]) => `- [${title}](${siteUrl}${path})${desc ? `: ${desc}` : ''}`),
    `- [About](${siteUrl}/about): who runs The Vic 361 and how events are chosen`,
    `- [Submit an event](${siteUrl}/submit)`,
    `- [Advertise](${siteUrl}/advertise): sponsorships and featured listings for local businesses`,
    '',
    ''
  ];
  const line = (ev) => {
    const when = formatDay(ev.date, { weekday: 'short', month: 'short', day: 'numeric' }) + (ev.time ? `, ${ev.time}` : '');
    const where = ev.venue ? ` at ${ev.venue}` : '';
    const free = ev.free === true ? ' (free)' : '';
    return `- ${when}: [${ev.name}](${siteUrl}${ev.page})${where}${free}`;
  };
  const sponsorUrl = sponsor && sponsor.name ? safeUrl(sponsor.url) : null;
  if (sponsor && sponsor.name) {
    lines.push("## This week's sponsor", '',
      `- ${sponsorUrl ? `[${sponsor.name}](${sponsorUrl})` : sponsor.name}${sponsor.text ? `: ${sponsor.text}` : ''}` +
        `${sponsor.address ? ` (${sponsor.address})` : ''}`,
      '', `${sponsor.name} is this week's paid sponsor of The Vic 361.`, '');
  }
  if (picks.length) {
    lines.push("## Vic's Picks", '',
      "Featured events, pinned to the top of their day on The Vic 361. Some are paid placements by the venue or organizer.", '',
      ...picks.map(line), '');
  }
  lines.push(`## Upcoming events (as of ${formatDay(today, { month: 'long', day: 'numeric', year: 'numeric' })})`, '');
  if (!upcoming.length) lines.push('- No events listed yet this week.');
  for (const ev of upcoming) {
    lines.push(line(ev) + (ev.featured ? " (Vic's Pick)" : '') + (ev.description ? ` - ${ev.description}` : ''));
  }
  return lines.join('\n') + '\n';
}
