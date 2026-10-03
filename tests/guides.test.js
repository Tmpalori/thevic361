// @vitest-environment node
//
// Venue pages, seasonal guides, and add-to-calendar files (server/guides.js).

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { withPages } from '../server/seo.js';
import { buildVenues, eventAtVenue, renderIcs, googleCalendarUrl, SEASONS, seasonMatches } from '../server/guides.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = new Date('2026-10-07T17:00:00Z'); // Wed Oct 7, noon CDT

const VENUES = [
  { name: 'Aero Crafters', category: 'Bar / Live Music', event_potential: 'Live music Fri/Sat',
    website: 'https://aerocrafters.pub', instagrams: ['aerocrafters'] },
  { name: 'Discover Victoria Texas', category: 'Tourism / Events Aggregator' },
  { name: 'Empty Hall', category: 'Event / Wedding Venue' }
];

const EVENTS = [
  { date: '2026-10-09', name: 'Friday Live Music', time: '8pm - 11pm', venue: 'Aero Crafters',
    address: '309 E Crestwood Dr', icons: ['music'], url: 'https://example.com/a' },
  { date: '2026-10-31', name: 'Downtown Trunk or Treat', time: '6:00 PM', venue: 'De Leon Plaza',
    icons: ['family'], free: true },
  { date: '2026-10-24', name: 'Tejas Fest', venue: 'De Leon Plaza', icons: ['music'], free: true }
];

let tmpDir, server, baseUrl;

async function startApp({ archive = [] } = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-guides-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  const venuesFile = path.join(tmpDir, 'venues.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: EVENTS }));
  await fs.writeFile(venuesFile, JSON.stringify(VENUES));
  const store = new FileStore(path.join(tmpDir, 's.json'));
  if (archive.length) await store.archiveEvents(withPages(archive));
  const { app } = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, venuesFile,
    trustProxy: false, now: () => NOW, siteUrl: 'https://www.thevic361.com'
  });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  server = null; tmpDir = null;
});

const get = async p => {
  const r = await fetch(baseUrl + p);
  return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() };
};

describe('venue matching', () => {
  it('skips organizer accounts and matches venue names loosely', () => {
    const venues = buildVenues(VENUES);
    expect(venues.map(v => v.slug)).toEqual(['aero-crafters', 'empty-hall']);
    const aero = venues[0];
    expect(eventAtVenue({ venue: 'Aero Crafters' }, aero)).toBe(true);
    expect(eventAtVenue({ venue: 'The Aero Crafters Brewing' }, aero)).toBe(true);
    expect(eventAtVenue({ venue: 'Aero' }, aero)).toBe(false);
  });
});

describe('venue pages', () => {
  it('lists upcoming and archived events with Place schema and links', async () => {
    await startApp({ archive: [{ date: '2026-09-12', name: 'Old Show', venue: 'Aero Crafters' }] });
    const r = await get('/venues/aero-crafters');
    expect(r.status).toBe(200);
    expect(r.text).toContain('<h1 class="page-title">Aero Crafters</h1>');
    expect(r.text).toContain('Friday Live Music');
    expect(r.text).toContain('Old Show');
    expect(r.text).toContain('https://www.instagram.com/aerocrafters/');
    expect(r.text).toContain('309 E Crestwood Dr, Victoria, TX');
    expect(r.text).toContain('"@type":"Place"');
    expect(r.text).not.toContain('noindex');
  });

  it('noindexes venues with nothing listed and 404s unknown or organizer slugs', async () => {
    await startApp();
    expect((await get('/venues/empty-hall')).text).toContain('noindex');
    expect((await get('/venues/discover-victoria-texas')).status).toBe(404);
    expect((await get('/venues/nope')).status).toBe(404);
  });

  it('venue index sorts by upcoming events', async () => {
    await startApp();
    const r = await get('/venues');
    expect(r.text.indexOf('Aero Crafters')).toBeLessThan(r.text.indexOf('Empty Hall'));
    expect(r.text).toContain('1 upcoming');
  });

  it('event pages link to their venue page and offer calendar + share', async () => {
    await startApp();
    const r = await get('/events/2026-10-09-friday-live-music');
    expect(r.text).toContain('href="/venues/aero-crafters"');
    expect(r.text).toContain('href="/events/2026-10-09-friday-live-music.ics"');
    expect(r.text).toContain('calendar.google.com/calendar/render');
    expect(r.text).toContain('data-share-url="https://www.thevic361.com/events/2026-10-09-friday-live-music"');
  });
});

describe('seasonal guides', () => {
  it('matches keywords', () => {
    const halloween = SEASONS.find(s => s.path === '/halloween-events');
    expect(seasonMatches(halloween, { name: 'Downtown Trunk or Treat' })).toBe(true);
    expect(seasonMatches(halloween, { name: 'Jazz Night' })).toBe(false);
  });

  it('in-season guide lists matching events and shows in the nav', async () => {
    await startApp();
    const r = await get('/halloween-events');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Downtown Trunk or Treat');
    expect(r.text).not.toContain('Friday Live Music');
    expect(r.text).not.toContain('noindex');
    expect(r.text).toContain('href="/halloween-events"');
    expect(r.text).toContain('href="/tejas-fest"');
    expect(r.text).not.toContain('href="/christmas-events"'); // not in season, nothing upcoming
  });

  it('out-of-season empty guide is noindexed', async () => {
    await startApp();
    expect((await get('/fourth-of-july')).text).toContain('noindex');
  });

  it('sitemap includes venues with events and active guides only', async () => {
    await startApp();
    const r = await get('/sitemap.xml');
    expect(r.text).toContain('<loc>https://www.thevic361.com/venues</loc>');
    expect(r.text).toContain('<loc>https://www.thevic361.com/venues/aero-crafters</loc>');
    expect(r.text).not.toContain('/venues/empty-hall');
    expect(r.text).toContain('<loc>https://www.thevic361.com/halloween-events</loc>');
    expect(r.text).not.toContain('/fourth-of-july');
  });
});

describe('calendar files', () => {
  const [ev] = withPages([EVENTS[0]]);

  it('renders a valid ICS with Central times and a default end', async () => {
    const ics = renderIcs(ev, { siteUrl: 'https://www.thevic361.com', now: NOW });
    expect(ics).toContain('BEGIN:VCALENDAR\r\n');
    expect(ics).toContain('DTSTART;TZID=America/Chicago:20261009T200000');
    expect(ics).toContain('DTEND;TZID=America/Chicago:20261009T230000');
    expect(ics).toContain('SUMMARY:Friday Live Music');
    expect(ics).toContain('LOCATION:Aero Crafters\\, 309 E Crestwood Dr\\, Victoria\\, TX');
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    const untimed = renderIcs(withPages([EVENTS[2]])[0], { siteUrl: 'https://www.thevic361.com', now: NOW });
    expect(untimed).toContain('DTSTART;VALUE=DATE:20261024');
    expect(untimed).toContain('DTEND;VALUE=DATE:20261025');
  });

  it('serves the ICS file', async () => {
    await startApp();
    const r = await get('/events/2026-10-09-friday-live-music.ics');
    expect(r.status).toBe(200);
    expect(r.type).toContain('text/calendar');
    expect((await get('/events/nope.ics')).status).toBe(404);
  });

  it('builds a Google Calendar link', () => {
    const u = new URL(googleCalendarUrl(ev, 'https://www.thevic361.com'));
    expect(u.searchParams.get('dates')).toBe('20261009T200000/20261009T230000');
    expect(u.searchParams.get('ctz')).toBe('America/Chicago');
  });
});
