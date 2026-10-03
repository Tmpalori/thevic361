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
  sortEvents, parseTimes, addDays
} from './seo.js';

// ─── Venues ──────────────────────────────────────────────────────────────

// Organizers rather than places (tourism accounts, promoters, festivals)
// don't get a venue page; their events show on the real venue's page.
const NON_PLACE = /aggregator|promoter|program|festival|media|hub|online/i;

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

// True when an event's venue string refers to this venue. Exact match on
// the normalized name, or containment for names of 5+ characters
// ("Aero Crafters" vs "Aero Crafters Brewing").
export function eventAtVenue(ev, venue) {
  const k = normName(ev.venue);
  if (!k || !venue.key) return false;
  if (k === venue.key) return true;
  const [a, b] = k.length < venue.key.length ? [k, venue.key] : [venue.key, k];
  return a.length >= 5 && (` ${b} `).includes(` ${a} `);
}

export function venueFor(ev, venues) {
  return venues.find(v => eventAtVenue(ev, v)) || null;
}

function venueEvents(venue, live, archived, today) {
  const byPage = new Map();
  for (const ev of [...archived, ...live]) {
    if (ev && ev.page && eventAtVenue(ev, venue)) byPage.set(ev.page, ev);
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

export function renderVenuePage(venue, live, archived, { siteUrl, now, sponsor }) {
  const today = localDateStr(now);
  const { upcoming, past } = venueEvents(venue, live, archived, today);
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
    <p class="page-cta">Own or manage ${escHtml(venue.name)}? <a href="/advertise">Feature your events every week</a>.</p>`;
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
  const rows = venues.map(v => ({ v, n: venueEvents(v, live, archived, today).upcoming.length }))
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

// Venues worth listing in the sitemap: the ones with something on them.
export function venuesWithEvents(venues, live, archived, now) {
  const today = localDateStr(now);
  return venues.filter(v => {
    const { upcoming, past } = venueEvents(v, live, archived, today);
    return upcoming.length || past.length;
  });
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
    match: /christmas|holiday|santa|lighted\s*parade|light(s)?\s*(display|show|tour)|nutcracker|carol|winter\s*wonderland|jingle/i
  },
  {
    path: '/new-years-eve', nav: "New Year's Eve", months: [12, 1],
    title: "New Year's Eve in Victoria, TX", h1: "New Year's Eve in Victoria, TX",
    description: "New Year's Eve parties and events in Victoria, TX.",
    intro: "Parties, countdowns, and live music to ring in the new year in Victoria.",
    match: /new\s*year|nye\b/i
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

export function seasonMatches(season, ev) {
  return season.match.test(`${ev.name || ''} ${ev.description || ''}`);
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
function foldLine(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

function compactDate(dateStr) { return dateStr.replace(/-/g, ''); }

export function renderIcs(ev, { siteUrl, now }) {
  const times = parseTimes(ev.time);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Vic 361//Events//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${compactDate(ev.date)}-${ev.page.split('/').pop()}@thevic361.com`,
    `DTSTAMP:${stamp}`
  ];
  if (times[0]) {
    const start = `${compactDate(ev.date)}T${times[0].replace(':', '')}00`;
    // Default to two hours when no end time was given.
    const [h, m] = times[0].split(':').map(Number);
    const endT = times[1] || `${String(Math.min(h + 2, 23)).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    lines.push(`DTSTART;TZID=America/Chicago:${start}`,
      `DTEND;TZID=America/Chicago:${compactDate(ev.date)}T${endT.replace(':', '')}00`);
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
  const times = parseTimes(ev.time);
  let dates;
  if (times[0]) {
    const [h, m] = times[0].split(':').map(Number);
    const endT = times[1] || `${String(Math.min(h + 2, 23)).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    dates = `${compactDate(ev.date)}T${times[0].replace(':', '')}00/${compactDate(ev.date)}T${endT.replace(':', '')}00`;
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
