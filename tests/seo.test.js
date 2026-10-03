// @vitest-environment node
//
// Server-rendered pages for search engines and AI crawlers (server/seo.js).
// Crawlers like GPTBot and ClaudeBot don't run JavaScript, so these tests
// read raw HTML responses and assert the events are in the markup itself.

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import {
  parseTimes, dateRange, withPages, slugify, safeUrl, eventJsonLd, localDateStr
} from '../server/seo.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Wednesday, Oct 7 2026, noon in Victoria (17:00 UTC during CDT).
const NOW = new Date('2026-10-07T17:00:00Z');

const EVENTS = [
  { date: '2026-10-07', name: 'Trivia Night', time: '7:00 PM', venue: 'Aero Crafters',
    address: '309 E. Crestwood Dr.', description: 'Weekly pub trivia.', icons: ['drinks', 'community'],
    free: true, url: 'https://example.com/trivia' },
  { date: '2026-10-09', name: 'Friday Live Music', time: '8pm - 11pm', venue: 'Moonshine',
    description: 'Local bands.', icons: ['music', 'drinks'], free: false, url: 'https://example.com/music' },
  { date: '2026-10-10', name: 'Story Time', time: '10:00AM – 11:00AM', venue: 'Victoria Public Library',
    icons: ['family', 'free'], free: true, url: '' },
  { date: '2026-10-10', name: 'Story Time', time: '2:00 PM', venue: 'Victoria Public Library',
    icons: ['family'], free: true, url: '' },
  { date: '2026-10-24', name: 'Tejas Fest', time: '', venue: 'DeLeon Plaza', icons: ['music', 'family'],
    free: true, url: 'https://example.com/tejas' },
  { date: '2026-10-05', name: 'Monday Market', time: '9 AM', venue: 'Market Square', icons: ['food'],
    free: true, url: '' },
  { date: '2026-10-08', name: '<script>alert(1)</script> Bad', time: '6 PM', venue: 'X',
    icons: [], free: false, url: 'javascript:alert(1)' }
];

let tmpDir, server, baseUrl;

async function startApp(events = EVENTS) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-seo-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({
    last_updated: '2026-10-05T03:00:00-05:00', events, new_and_notable: [], sponsor: null
  }));
  const storeBundle = { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) };
  const { app } = await createApp({
    storeBundle, eventsFile, trustProxy: false, now: () => NOW, siteUrl: 'https://www.thevic361.com'
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

function ldBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
    .map(m => JSON.parse(m[1]));
}

describe('seo helpers', () => {
  it('parses start and end times from free-form strings', () => {
    expect(parseTimes('7:00 PM')).toEqual(['19:00']);
    expect(parseTimes('10:00AM – 11:00AM')).toEqual(['10:00', '11:00']);
    expect(parseTimes('10am - 3pm')).toEqual(['10:00', '15:00']);
    expect(parseTimes('12 p.m.')).toEqual(['12:00']);
    expect(parseTimes('All day')).toEqual([]);
  });

  it('computes Victoria-local today and the weekend window', () => {
    expect(localDateStr(new Date('2026-10-08T03:00:00Z'))).toBe('2026-10-07'); // 10pm CDT
    expect(dateRange('weekend', '2026-10-07')).toEqual(['2026-10-09', '2026-10-11']); // Wed
    expect(dateRange('weekend', '2026-10-10')).toEqual(['2026-10-10', '2026-10-11']); // Sat
    expect(dateRange('weekend', '2026-10-11')).toEqual(['2026-10-11', '2026-10-11']); // Sun
  });

  it('gives duplicate names on the same day unique pages', () => {
    const pages = withPages(EVENTS).map(e => e.page);
    expect(pages).toContain('/events/2026-10-10-story-time');
    expect(pages).toContain('/events/2026-10-10-story-time-2');
    expect(new Set(pages).size).toBe(pages.length);
    expect(slugify('Rock & Blues!')).toBe('rock-and-blues');
  });

  it('only allows http(s) links', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl('https://a.com')).toBe('https://a.com');
  });

  it('builds Event JSON-LD with a Central offset', () => {
    const [ev] = withPages([EVENTS[1]]);
    const ld = eventJsonLd(ev, 'https://www.thevic361.com');
    expect(ld['@type']).toBe('Event');
    expect(ld.startDate).toBe('2026-10-09T20:00:00-05:00');
    expect(ld.endDate).toBe('2026-10-09T23:00:00-05:00');
    expect(ld.location.address.addressLocality).toBe('Victoria');
    expect(ld.url).toBe('https://www.thevic361.com/events/2026-10-09-friday-live-music');
    const [winter] = withPages([{ date: '2026-12-05', name: 'X', time: '6 PM' }]);
    expect(eventJsonLd(winter, 'https://www.thevic361.com').startDate).toBe('2026-12-05T18:00:00-06:00');
  });
});

describe('server-rendered pages', () => {
  it('homepage has this week\'s events in the raw HTML, plus JSON-LD and nav', async () => {
    await startApp();
    const r = await get('/');
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('Loading events...');
    expect(r.text).toContain('Trivia Night');
    expect(r.text).toContain('href="/events/2026-10-07-trivia-night"');
    expect(r.text).toContain('Monday Market'); // Mon of the same week
    expect(r.text).not.toContain('/events/2026-10-24-tejas-fest'); // later week
    expect(r.text).toContain('href="/tejas-fest"'); // in-season guide in the nav
    expect(r.text).toContain('href="/this-weekend"');
    const types = ldBlocks(r.text).map(b => b['@type']);
    expect(types).toContain('WebSite');
    expect(types.filter(t => t === 'Event').length).toBeGreaterThanOrEqual(5);
  });

  it('escapes event text and drops unsafe links', async () => {
    await startApp();
    const r = await get('/');
    expect(r.text).not.toContain('<script>alert(1)</script>');
    expect(r.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Bad');
    expect(r.text).not.toContain('javascript:alert');
  });

  it('admin preview gets the untouched template', async () => {
    await startApp();
    const r = await get('/?previewKey=abc');
    expect(r.text).toContain('Loading events...');
  });

  it('this-weekend page answers first and lists only Fri–Sun', async () => {
    await startApp();
    const r = await get('/this-weekend');
    expect(r.status).toBe(200);
    expect(r.text).toContain('<title>Things To Do in Victoria, TX This Weekend | The Vic 361</title>');
    expect(r.text).toMatch(/There are 3 events in Victoria, TX this weekend \(Oct 9 to Oct 11\)/);
    expect(r.text).toContain('Friday Live Music');
    expect(r.text).not.toContain('Trivia Night');
    expect(r.text).toContain('<link rel="canonical" href="https://www.thevic361.com/this-weekend">');
  });

  it('category pages filter by icon and free flag', async () => {
    await startApp();
    const music = await get('/live-music');
    expect(music.text).toContain('Friday Live Music');
    expect(music.text).toContain('Tejas Fest');
    expect(music.text).not.toContain('Story Time');
    const free = await get('/free-things-to-do');
    expect(free.text).toContain('Trivia Night');
    expect(free.text).not.toContain('Friday Live Music');
    const today = await get('/today');
    expect(today.text).toMatch(/There is 1 event in Victoria, TX today/);
  });

  it('event page has facts, source link, and Event schema; unknown slug 404s', async () => {
    await startApp();
    const r = await get('/events/2026-10-09-friday-live-music');
    expect(r.status).toBe(200);
    expect(r.text).toContain('<h1 class="page-title">Friday Live Music</h1>');
    expect(r.text).toContain('is on Friday, October 9, 2026 at 8pm - 11pm at Moonshine in Victoria, TX.');
    expect(r.text).toContain('href="https://example.com/music"');
    const ld = ldBlocks(r.text);
    expect(ld[0]['@type']).toBe('Event');
    expect(ld[1]['@type']).toBe('BreadcrumbList');
    const missing = await get('/events/2026-01-01-gone');
    expect(missing.status).toBe(404);
    expect(missing.text).toContain('noindex');
  });

  it('sitemap lists hub pages and upcoming event pages only', async () => {
    await startApp();
    const r = await get('/sitemap.xml');
    expect(r.type).toContain('xml');
    expect(r.text).toContain('<loc>https://www.thevic361.com/this-weekend</loc>');
    expect(r.text).toContain('<loc>https://www.thevic361.com/events/2026-10-24-tejas-fest</loc>');
    expect(r.text).not.toContain('2026-10-05-monday-market'); // already past
    expect(r.text).toContain('<lastmod>2026-10-05</lastmod>');
  });

  it('llms.txt summarizes the site and upcoming events', async () => {
    await startApp();
    const r = await get('/llms.txt');
    expect(r.type).toContain('text/plain');
    expect(r.text.startsWith('# The Vic 361')).toBe(true);
    expect(r.text).toContain('[Things To Do in Victoria, TX This Weekend](https://www.thevic361.com/this-weekend)');
    expect(r.text).toContain('[Tejas Fest](https://www.thevic361.com/events/2026-10-24-tejas-fest) at DeLeon Plaza (free)');
    expect(r.text).not.toContain('Monday Market');
  });

  it('about page and events.json page links', async () => {
    await startApp();
    const about = await get('/about');
    expect(about.status).toBe(200);
    expect(ldBlocks(about.text)[0]['@type']).toBe('Organization');
    const feed = await fetch(baseUrl + '/events.json').then(x => x.json());
    expect(feed.events[0].page).toBe('/events/2026-10-07-trivia-night');
  });
});

describe('site hardening', () => {
  it('301s the bare domain to www and keeps the path', async () => {
    await startApp();
    // fetch() can't override Host, so use a raw request.
    const req = (p, host) => new Promise((resolve, reject) => {
      http.get(baseUrl + p, { headers: { Host: host } }, res => {
        res.resume();
        resolve({ status: res.statusCode, location: res.headers.location });
      }).on('error', reject);
    });
    const r = await req('/this-weekend?x=1', 'thevic361.com');
    expect(r.status).toBe(301);
    expect(r.location).toBe('https://www.thevic361.com/this-weekend?x=1');
    expect((await req('/about', 'www.thevic361.com')).status).toBe(200);
  });

  it('sends security headers and compresses HTML', async () => {
    await startApp();
    const r = await fetch(baseUrl + '/', { headers: { 'Accept-Encoding': 'gzip' } });
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    expect(r.headers.get('content-encoding')).toBe('gzip');
  });

  it('serves favicon.ico', async () => {
    await startApp();
    const r = await fetch(baseUrl + '/favicon.ico');
    expect(r.status).toBe(200);
  });

  it('keeps event pages alive after they leave the live payload', async () => {
    await startApp();
    // Boot backfill archives nothing here (no published row), so publish by
    // archiving directly, then drop the event from the live list.
    const { store } = await (async () => {
      const { FileStore: FS } = await import('../server/db.js');
      return { store: new FS(path.join(tmpDir, 's.json')) };
    })();
    await store.archiveEvents(withPages([{ date: '2026-09-01', name: 'Old Fair', venue: 'Park' }]));
    const r = await get('/events/2026-09-01-old-fair');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Old Fair was on Tuesday, September 1, 2026');
    expect(r.text).toContain('This event has passed.');
    const sitemap = await get('/sitemap.xml');
    expect(sitemap.text).not.toContain('old-fair');
  });

  it('advertise page lists packages and a contact address', async () => {
    await startApp();
    const r = await get('/advertise');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Weekly sponsor');
    expect(r.text).toContain('Vic’s Pick');
    expect(r.text).toContain('/contact?topic=advertising');
    expect(r.text).not.toContain('mailto:');
    expect((await get('/')).text).toContain('href="/advertise"');
  });

  it('server-rendered pages load analytics and click tracking', async () => {
    await startApp();
    const r = await get('/live-music');
    expect(r.text).toContain('googletagmanager.com/gtag/js?id=G-52YHD3X3C2');
    expect(r.text).toContain('<script src="/track.js" defer></script>');
  });
});

describe('paid placements', () => {
  it('featured events pin to the top of their day with a badge', async () => {
    const events = [
      { date: '2026-10-09', name: 'Early Show', time: '6:00 PM', venue: 'A', icons: ['music'] },
      { date: '2026-10-09', name: 'Paid Late Show', time: '9:00 PM', venue: 'B', icons: ['music'], featured: true }
    ];
    await startApp(events);
    const r = await get('/this-weekend');
    expect(r.text.indexOf('Paid Late Show')).toBeLessThan(r.text.indexOf('Early Show'));
    expect(r.text).toContain('<span class="badge badge--featured">Vic’s Pick</span>');
  });

  it('sponsor block appears on server-rendered pages', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-seo-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({
      events: EVENTS,
      sponsor: { name: 'Acme Tacos', text: 'Best tacos.', cta: 'Order', url: 'javascript:alert(1)' }
    }));
    const { app } = await createApp({
      storeBundle: { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) },
      eventsFile, trustProxy: false, now: () => NOW
    });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const r = await get('/live-music');
    expect(r.text).toContain('Acme Tacos');
    expect(r.text).not.toContain('javascript:alert');
  });
});

describe('event edit validation', async () => {
  const { validateEventEdit } = await import('../server/validate.js');
  const base = { name: 'Jazz Night', date: '2026-10-09', time: '7 PM', venue: 'Venue', description: 'Live jazz.' };

  it('keeps the featured flag', () => {
    expect(validateEventEdit({ ...base, featured: true }).data.featured).toBe(true);
    expect(validateEventEdit(base).data.featured).toBe(false);
  });

  it('rejects URLs that could break out of an href', () => {
    expect(validateEventEdit({ ...base, url: 'https://a.com/"onmouseover=x' }).ok).toBe(false);
    expect(validateEventEdit({ ...base, url: 'https://a.com/ok?x=1' }).ok).toBe(true);
  });
});
