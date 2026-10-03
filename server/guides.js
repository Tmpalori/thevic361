/* server/guides.js — Venue pages, seasonal event guides, and calendar files.
 *
 * Everything here is generated from data that already exists, so it stays
 * current with no editing:
 *   - /venues and /venues/<slug>: one page per place in venues.json, with
 *     its upcoming events (live payload) and recent past ones (archive).
 *     People search venue names, and it's the page to show a venue when
 *     selling a partner plan.
 *   - Seasonal guides (/halloween-events, /christmas-events, ...): keyword
 *     matches over upcoming + archived events. They show in the nav only
 *     while in season and are noindexed when there's nothing to list.
 *   - /events/<slug>.ics: an add-to-calendar file for any event page.
 */

import {
  SITE_NAME, escHtml, safeUrl, slugify, layout, renderEventItem, renderGrouped,
  eventJsonLd, breadcrumbLd, sponsorHtml, ctaHtml, localDateStr, formatDay,
  sortEvents, parseTimes, addDays, chicagoOffset
} from './seo.js';

// ─── Venues ──────────────────────────────────────────────────────────────

// Organizers rather than places (tourism accounts, promoters, festivals)
// don't get a venue page; their events show on the real venue's page.
// Exact organizer words only: "Public Library / Community Programs" is a place.
const NON_PLACE = /aggregator|promoter|\bfestival\b|\bmedia\b|events hub|online/i;

function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|tx|texas|victoria)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildVenues(venueList) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(venueList) ? venueList : []) {
    if (!v || !v.name || NON_PLACE.test(v.category || '')) continue;
    const slug = slugify(v.name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ ...v, slug, path: `/venues/${slug}`, key: normName(v.name) });
  }
  return out;
}

// True when an event's venue string could refer to this venue: an exact
// match on the normalized name, or one name containing the other as whole
// words when the shorter has 2+ words ("Leo J. Welder Center" inside "Leo J.
// Welder Center for the Performing Arts"). A single shared word isn't
// enough: "Theatre Victoria" and "Victoria Ballet Theatre" both normalize
// to names containing "theatre".
export function eventAtVenue(ev, venue) {
  const k = normName(ev.venue);
  if (!k || !venue.key) return false;
  if (k === venue.key) return true;
  const [a, b] = k.length < venue.key.length ? [k, venue.key] : [venue.key, k];
  return a.split(' ').length >= 2 && (` ${b} `).includes(` ${a} `);
}

// The single venue an event belongs to: an exact name match wins over a
// partial one, so each event lands on exactly one venue page.
export function venueFor(ev, venues) {
  const k = normName(ev.venue);
  if (!k) return null;
  return venues.find(v => v.key === k) || venues.find(v => eventAtVenue(ev, v)) || null;
}

function venueEvents(venue, live, archived, today, venues) {
  const candidates = venues || [venue];
  const byPage = new Map();
  for (const ev of [...archived, ...live]) {
    if (ev && ev.page && venueFor(ev, candidates) === venue) byPage.set(ev.page, ev);
  }
  const all = [...byPage.values()];
  return {
    upcoming: sortEvents(all.filter(e => e.date >= today)),
    past: sortEvents(all.filter(e => e.date < today)).reverse().slice(0, 10)
  };
}

function venueAddress(events) {
  const withAddr = events.find(e => e.address);
  return withAddr ? withAddr.address : '';
}

export function renderVenuePage(venue, live, archived, { siteUrl, now, sponsor, venues }) {
  const today = localDateStr(now);
  const { upcoming, past } = venueEvents(venue, live, archived, today, venues);
  const address = venueAddress([...upcoming, ...past]);
  const links = [
    ['Website', safeUrl(venue.website)],
    ['Facebook', safeUrl(venue.facebook_page)],
    ['Instagram', safeUrl(venue.instagram_url) || (venue.instagrams && venue.instagrams[0]
      ? `https://www.instagram.com/${encodeURIComponent(venue.instagrams[0])}/` : '')]
  ].filter(([, u]) => u);
  const lead = upcoming.length
    ? `${venue.name} has ${upcoming.length === 1 ? '1 upcoming event' : `${upcoming.length} upcoming events`} listed on The Vic 361, starting ${formatDay(upcoming[0].date, { weekday: 'long', month: 'long', day: 'numeric' })}.`
    : `No upcoming events are listed for ${venue.name} right now.`;
  const body = `
    <p class="breadcrumbs"><a href="/venues">Venues</a> › ${escHtml(venue.name)}</p>
    <h1 class="page-title">${escHtml(venue.name)}</h1>
    <p class="page-lead">${escHtml(lead)}</p>
    <dl class="event-facts">
      <dt>Type</dt><dd>${escHtml(venue.category)}</dd>
      ${address ? `<dt>Address</dt><dd>${escHtml(address)}, Victoria, TX</dd>` : ''}
      ${venue.event_potential ? `<dt>Known for</dt><dd>${escHtml(venue.event_potential)}</dd>` : ''}
    </dl>
    ${links.length ? `<p class="venue-links">${links.map(([l, u]) =>
      `<a class="btn btn--outline" href="${escHtml(u)}" target="_blank" rel="noopener noreferrer">${l}</a>`).join(' ')}</p>` : ''}
    <h2 class="section-heading">Upcoming events</h2>
    ${upcoming.length ? renderGrouped(upcoming, today)
      : `<div class="empty-state">Check <a href="/">this week's full list</a> for everything happening in Victoria.</div>`}
    ${past.length ? `<h2 class="section-heading">Recent events</h2>
    <ul class="event-list" role="list">${past.map(renderEventItem).join('')}</ul>` : ''}
    ${sponsorHtml(sponsor)}
    <p class="page-cta">Own or manage ${escHtml(venue.name)}? <a href="/for-venues?venue=${escHtml(venue.slug)}">Show these events on your website for free</a>, or <a href="/advertise">feature them every week</a>.</p>`;
  const place = {
    '@context': 'https://schema.org',
    '@type': 'Place',
    name: venue.name,
    url: siteUrl + venue.path,
    address: {
      '@type': 'PostalAddress',
      ...(address ? { streetAddress: address } : {}),
      addressLocality: 'Victoria', addressRegion: 'TX', addressCountry: 'US'
    },
    ...(links.length ? { sameAs: links.map(([, u]) => u) } : {})
  };
  return layout({
    siteUrl, path: venue.path, nav: null,
    // Thin pages (nothing listed, ever) stay out of the index.
    noindex: !upcoming.length && !past.length,
    title: `${venue.name} Events in Victoria, TX | ${SITE_NAME}`,
    description: `Upcoming events at ${venue.name} in Victoria, TX${venue.event_potential ? `: ${venue.event_potential}` : ''}.`.slice(0, 300),
    body,
    ld: [place, breadcrumbLd(siteUrl, [{ name: 'Venues', path: '/venues' }, { name: venue.name, path: venue.path }]),
      ...upcoming.slice(0, 20).map(ev => eventJsonLd(ev, siteUrl))]
  });
}

export function renderVenueIndex(venues, live, archived, { siteUrl, now }) {
  const today = localDateStr(now);
  const counts = upcomingCounts(venues, live, archived, today);
  const rows = venues.map(v => ({ v, n: counts.get(v) || 0 }))
    .sort((a, b) => b.n - a.n || a.v.name.localeCompare(b.v.name));
  const body = `
    <h1 class="page-title">Event venues in Victoria, TX</h1>
    <p class="page-lead">Bars, music venues, theaters, museums, markets, and event spaces around Victoria, with what's coming up at each.</p>
    <ul class="venue-index" role="list">
      ${rows.map(({ v, n }) => `<li><a href="${v.path}">${escHtml(v.name)}</a>
        <span class="venue-meta">${escHtml(v.category)}${n ? ` · ${n} upcoming` : ''}</span></li>`).join('\n      ')}
    </ul>
    ${ctaHtml()}`;
  return layout({
    siteUrl, path: '/venues',
    title: `Event Venues in Victoria, TX | ${SITE_NAME}`,
    description: 'Bars, music venues, theaters, museums and event spaces in Victoria, TX, with their upcoming events.',
    body,
    ld: [breadcrumbLd(siteUrl, [{ name: SITE_NAME, path: '/' }, { name: 'Venues', path: '/venues' }])]
  });
}

// One pass over the events instead of one pass per venue.
function upcomingCounts(venues, live, archived, today) {
  const counts = new Map();
  const seen = new Set();
  for (const ev of [...live, ...archived]) {
    if (!ev || !ev.page || seen.has(ev.page) || ev.date < today) continue;
    seen.add(ev.page);
    const v = venueFor(ev, venues);
    if (v) counts.set(v, (counts.get(v) || 0) + 1);
  }
  return counts;
}

// Venues worth listing in the sitemap: the ones with something on them.
export function venuesWithEvents(venues, live, archived, now) {
  const withAny = new Set();
  for (const ev of [...live, ...archived]) {
    const v = ev && ev.page ? venueFor(ev, venues) : null;
    if (v) withAny.add(v);
  }
  return venues.filter(v => withAny.has(v));
}

// ─── Seasonal guides ─────────────────────────────────────────────────────

// months: 1-12 when the page shows in the nav and gets indexed even if
// empty. match: tested against name + description.
export const SEASONS = [
  {
    path: '/tejas-fest', nav: 'Tejas Fest', months: [9, 10],
    title: 'Tejas Fest in Victoria, TX', h1: 'Tejas Fest in Victoria, TX',
    description: 'Tejas Fest schedule and related events in downtown Victoria, TX: Tejano and Texas Country music, food, vendors, and family activities.',
    intro: "Tejas Fest is Victoria's free downtown festival of Tejano and Texas Country music, food, vendors, and family activities.",
    match: /tejas\s*fest/i
  },
  {
    path: '/halloween-events', nav: 'Halloween', months: [10],
    title: 'Halloween Events in Victoria, TX', h1: 'Halloween events in Victoria, TX',
    description: 'Halloween events in Victoria, TX: trunk or treats, haunted houses, costume parties, fall festivals, and pumpkin patches.',
    intro: 'Trunk or treats, haunted houses, costume parties, fall festivals, and pumpkin patches around Victoria.',
    match: /hallowe+n|trunk[\s-]*or[\s-]*treat|haunted|costume|spooky|pumpkin|fall\s*fest|d[ií]a\s*de\s*(los\s*)?muertos|cemetery\s*tour/i
  },
  {
    path: '/thanksgiving-events', nav: 'Thanksgiving', months: [11],
    title: 'Thanksgiving Events in Victoria, TX', h1: 'Thanksgiving events in Victoria, TX',
    description: 'Thanksgiving events in Victoria, TX: turkey trots, community dinners, and holiday weekend things to do.',
    intro: 'Turkey trots, community dinners, and things to do over the holiday weekend.',
    match: /thanksgiving|turkey\s*trot|friendsgiving/i
  },
  {
    path: '/christmas-events', nav: 'Christmas', months: [11, 12],
    title: 'Christmas Events in Victoria, TX', h1: 'Christmas and holiday events in Victoria, TX',
    description: 'Christmas events in Victoria, TX: lighted parades, holiday markets, Santa visits, light displays, and holiday concerts.',
    intro: 'Lighted parades, holiday markets, Santa visits, light displays, and holiday concerts around Victoria.',
    match: /christmas|holiday\s*(market|parade|lights?|concert|bazaar|festival|party|show|open\s*house)|santa|lighted\s*parade|light(s)?\s*(display|show|tour)|nutcracker|carol(s|ing)\b|winter\s*wonderland|jingle/i
  },
  {
    path: '/new-years-eve', nav: "New Year's Eve", months: [12, 1],
    title: "New Year's Eve in Victoria, TX", h1: "New Year's Eve in Victoria, TX",
    description: "New Year's Eve parties and events in Victoria, TX.",
    intro: "Parties, countdowns, and live music to ring in the new year in Victoria.",
    match: /new\s*year|nye\b/i,
    exclude: /lunar|chinese|vietnamese|t[eế]t\b/i
  },
  {
    path: '/fourth-of-july', nav: 'July 4th', months: [6, 7],
    title: 'Fourth of July in Victoria, TX', h1: 'Fourth of July events in Victoria, TX',
    description: 'Fourth of July events in Victoria, TX: fireworks, parades, and Independence Day celebrations.',
    intro: 'Fireworks, parades, and Independence Day celebrations around Victoria.',
    match: /fourth\s*of\s*july|july\s*4|4th\s*of\s*july|independence\s*day|firework/i
  },
  {
    path: '/bach-festival', nav: 'Bach Festival', months: [5, 6],
    title: 'Victoria Bach Festival', h1: 'Victoria Bach Festival events',
    description: 'Victoria Bach Festival concerts and events in Victoria, TX.',
    intro: 'Concerts and events from the Victoria Bach Festival, one of Texas\'s longest-running classical music festivals.',
    match: /bach\s*fest/i
  }
];

// Keyword match, limited to events dated in the season's months, so a
// "Holiday weekend BBQ" in September or New Year's fireworks don't land on
// the July 4th page.
export function seasonMatches(season, ev) {
  const text = `${ev.name || ''} ${ev.description || ''}`;
  if (!season.match.test(text) || (season.exclude && season.exclude.test(text))) return false;
  const month = Number(String(ev.date || '').slice(5, 7));
  return !month || season.months.includes(month);
}

export function inSeason(season, now) {
  const month = Number(localDateStr(now).slice(5, 7));
  return season.months.includes(month);
}

function seasonEvents(season, live, archived, today) {
  const byPage = new Map();
  for (const ev of [...archived, ...live]) {
    if (ev && ev.page && seasonMatches(season, ev)) byPage.set(ev.page, ev);
  }
  const all = [...byPage.values()];
  return {
    upcoming: sortEvents(all.filter(e => e.date >= today)),
    past: sortEvents(all.filter(e => e.date < today && e.date >= addDays(today, -400))).reverse().slice(0, 12)
  };
}

// Seasonal pages that have upcoming events or are in season right now.
export function activeSeasons(live, archived, now) {
  const today = localDateStr(now);
  return SEASONS.filter(s => inSeason(s, now) || seasonEvents(s, live, archived, today).upcoming.length);
}

export function renderSeasonPage(season, live, archived, { siteUrl, now, sponsor }) {
  const today = localDateStr(now);
  const { upcoming, past } = seasonEvents(season, live, archived, today);
  const lead = upcoming.length
    ? `${season.intro} ${upcoming.length === 1 ? '1 event is' : `${upcoming.length} events are`} coming up, starting ${formatDay(upcoming[0].date, { weekday: 'long', month: 'long', day: 'numeric' })}.`
    : `${season.intro} Nothing is listed yet this year; check back as events are announced.`;
  const body = `
    <h1 class="page-title">${escHtml(season.h1)}</h1>
    <p class="page-lead">${escHtml(lead)}</p>
    ${upcoming.length ? renderGrouped(upcoming, today)
      : `<div class="empty-state">See <a href="/">this week's events</a>, or <a href="/submit">submit an event</a>.</div>`}
    ${past.length ? `<h2 class="section-heading">Past events</h2>
    <ul class="event-list" role="list">${past.map(renderEventItem).join('')}</ul>` : ''}
    ${sponsorHtml(sponsor)}
    ${ctaHtml()}`;
  return layout({
    siteUrl, path: season.path,
    noindex: !upcoming.length && !past.length && !inSeason(season, now),
    title: `${season.title} | ${SITE_NAME}`,
    description: season.description,
    body,
    ld: [breadcrumbLd(siteUrl, [{ name: SITE_NAME, path: '/' }, { name: season.nav, path: season.path }]),
      ...upcoming.slice(0, 30).map(ev => eventJsonLd(ev, siteUrl))]
  });
}

// ─── Calendar + sharing ──────────────────────────────────────────────────

function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
}

// RFC 5545 lines must be ≤75 octets; continuation lines start with a space.
// Split on whole characters so an emoji is never cut in half.
function foldLine(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 75) {
      out.push(cur);
      cur = ' ';
    }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}

function compactDate(dateStr) { return dateStr.replace(/-/g, ''); }

// Start/end as UTC instants. No end time → two hours; an end at or before
// the start ("10pm - 1am") runs past midnight.
function eventInstants(ev) {
  const times = parseTimes(ev.time);
  if (!times[0]) return null;
  const start = new Date(`${ev.date}T${times[0]}:00${chicagoOffset(ev.date)}`);
  let end = times[1] ? new Date(`${ev.date}T${times[1]}:00${chicagoOffset(ev.date)}`) : null;
  if (!end || end <= start) {
    end = times[1] ? new Date(end.getTime() + 24 * 3600 * 1000) : new Date(start.getTime() + 2 * 3600 * 1000);
  }
  return { start, end };
}

function utcStamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function renderIcs(ev, { siteUrl, now }) {
  const at = eventInstants(ev);
  const stamp = utcStamp(now);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Vic 361//Events//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${compactDate(ev.date)}-${ev.page.split('/').pop()}@thevic361.com`,
    `DTSTAMP:${stamp}`
  ];
  if (at) {
    // UTC instants need no VTIMEZONE block, which Outlook requires for TZID.
    lines.push(`DTSTART:${utcStamp(at.start)}`, `DTEND:${utcStamp(at.end)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${compactDate(ev.date)}`,
      `DTEND;VALUE=DATE:${compactDate(addDays(ev.date, 1))}`);
  }
  lines.push(
    `SUMMARY:${icsEscape(ev.name)}`,
    `LOCATION:${icsEscape([ev.venue, ev.address, 'Victoria, TX'].filter(Boolean).join(', '))}`,
    `DESCRIPTION:${icsEscape([ev.description, `${siteUrl}${ev.page}`].filter(Boolean).join('\n\n'))}`,
    `URL:${siteUrl}${ev.page}`,
    'END:VEVENT', 'END:VCALENDAR'
  );
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export function googleCalendarUrl(ev, siteUrl) {
  const at = eventInstants(ev);
  let dates;
  if (at) {
    dates = `${utcStamp(at.start)}/${utcStamp(at.end)}`;
  } else {
    dates = `${compactDate(ev.date)}/${compactDate(addDays(ev.date, 1))}`;
  }
  const params = new URLSearchParams({
    action: 'TEMPLATE', text: ev.name, dates, ctz: 'America/Chicago',
    location: [ev.venue, ev.address, 'Victoria, TX'].filter(Boolean).join(', '),
    details: `${ev.description ? ev.description + '\n\n' : ''}${siteUrl}${ev.page}`
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

export function eventActionsHtml(ev, siteUrl) {
  const url = `${siteUrl}${ev.page}`;
  const text = `${ev.name} · ${formatDay(ev.date, { weekday: 'short', month: 'short', day: 'numeric' })}`;
  const share = [
    ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`],
    ['X', `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`],
    ['Text', `sms:?&body=${encodeURIComponent(`${text} ${url}`)}`]
  ];
  return `<div class="event-actions">
      <a class="btn btn--outline" href="${escHtml(ev.page)}.ics" data-track="add_to_calendar">Add to calendar</a>
      <a class="btn btn--outline" href="${escHtml(googleCalendarUrl(ev, siteUrl))}" target="_blank" rel="noopener noreferrer" data-track="add_to_calendar">Google Calendar</a>
    </div>
    <div class="share-row" aria-label="Share this event">
      <span class="share-label">Share:</span>
      <button type="button" class="share-btn" data-share-url="${escHtml(url)}" data-share-text="${escHtml(text)}">Share or copy link</button>
      ${share.map(([l, u]) => `<a class="share-btn" href="${escHtml(u)}" target="_blank" rel="noopener noreferrer" data-track="share_${l.toLowerCase()}">${l}</a>`).join('\n      ')}
    </div>`;
}
