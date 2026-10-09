// @vitest-environment node
//
// Public site fixes: analytics never sees token URLs, branded 404s, the
// bare-domain double-slash redirect, cache headers, event page wording,
// times, JSON-LD past midnight, link previews and the sponsor link.

import { describe, it, expect, afterEach } from 'vitest';
import vm from 'node:vm';
import { readFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import {
  GA_SNIPPET, THEME_SCRIPT, formatTime, eventJsonLd, withPages, layout, sponsorHtml, sponsorLinkUrl,
  renderNotFoundPage
} from '../server/seo.js';
import { streetAddress } from '../server/guides.js';

const DOCS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'docs');
// Wednesday, Oct 7 2026, noon in Victoria.
const NOW = new Date('2026-10-07T17:00:00Z');
const SITE = 'https://www.thevic361.com';

const EVENTS = [
  { date: '2026-10-05', name: 'Monday Market', time: '09:00 AM', venue: 'Market Square', icons: ['food'], free: true },
  { date: '2026-10-07', name: 'Wednesday Night Karaoke', time: '9:30PM-2:00AM', venue: 'Pumphouse', icons: ['music'] },
  { date: '2026-10-09', name: 'Next Stop Comedy', time: '8:00 PM', venue: 'La Cantina', icons: ['arts'], url: '' },
  { date: '2026-10-10', name: 'Live Music', time: '7 PM', venue: 'J Welch Farms', icons: ['music'], url: 'https://example.com/m' }
];

let tmpDir, server, baseUrl;

async function startApp({ sponsor = null, events = EVENTS, ...extra } = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-site-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ last_updated: '2026-10-05T03:00:00-05:00', events, sponsor }));
  const storeBundle = { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) };
  const { app } = await createApp({ storeBundle, eventsFile, trustProxy: false, now: () => NOW, siteUrl: SITE, ...extra });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

const get = async (p, headers = {}) => {
  const r = await fetch(baseUrl + p, { headers, redirect: 'manual' });
  return { status: r.status, headers: r.headers, text: await r.text() };
};

// Runs the inline GA snippet against a fake page and returns what it sent.
function gaConfig(search) {
  const inline = GA_SNIPPET.match(/<script>([\s\S]*?)<\/script>/)[1];
  const window = {};
  const ctx = { window, location: { origin: SITE, pathname: '/unsubscribe', search }, URLSearchParams, Date };
  ctx.dataLayer = window.dataLayer = [];
  vm.runInNewContext(inline.replace(/window\.dataLayer=window\.dataLayer\|\|\[\];/, ''), ctx);
  return [...ctx.dataLayer].find(a => a[0] === 'config');
}

describe('Google Analytics never sees a token URL', () => {
  it('sends only origin + path (plus campaign tags) as page_location', () => {
    expect(gaConfig('?token=secret123')[2]).toEqual({ page_location: `${SITE}/unsubscribe` });
    expect(gaConfig('?token=secret&utm_source=fb&utm_medium=paid')[2].page_location)
      .toBe(`${SITE}/unsubscribe?utm_source=fb&utm_medium=paid`);
  });

  it('every page with GA uses the same sanitized snippet', () => {
    for (const f of ['index.html', 'submit.html']) {
      const html = readFileSync(path.join(DOCS, f), 'utf8');
      expect(html, f).toContain(GA_SNIPPET);
      expect(html, f).not.toMatch(/gtag\('config',\s*'G-[A-Z0-9]+'\)/);
    }
    expect(layout({ siteUrl: SITE, path: '/x', title: 't', description: 'd', body: '' })).toContain(GA_SNIPPET);
  });

  it('pages without the pixel (token links) load no analytics at all', () => {
    const html = layout({ siteUrl: SITE, path: '/unsubscribe', title: 't', description: 'd', body: '', pixel: false });
    expect(html).not.toContain('googletagmanager');
    expect(html).not.toContain('/pixel.js');
  });

  it('confirm and unsubscribe pages carry neither GA nor the pixel', async () => {
    await startApp();
    for (const p of ['/unsubscribe?token=abc', '/subscribe/confirm?token=abc']) {
      const r = await get(p);
      expect(r.text, p).toContain('<!DOCTYPE html>');
      expect(r.text, p).not.toContain('googletagmanager');
      expect(r.text, p).not.toContain('/pixel.js');
    }
  });
});

describe('not found pages', () => {
  it('unknown URLs get the branded page; files and the API keep short answers', async () => {
    await startApp();
    const page = await get('/does-not-exist', { Accept: 'text/html' });
    expect(page.status).toBe(404);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.text).toContain('We couldn&#39;t find that page');
    expect(page.text).toContain('noindex');
    expect(page.text).toContain('href="/this-weekend"');
    const img = await get('/missing.png', { Accept: 'image/avif,image/webp,*/*;q=0.8' });
    expect(img.status).toBe(404);
    expect(img.headers.get('content-type')).toContain('text/plain');
    expect((await get('/api/nope')).headers.get('content-type')).toContain('json');
  });

  it('venue and event 404s say the right thing', async () => {
    await startApp();
    const venue = await get('/venues/some-typo');
    expect(venue.status).toBe(404);
    expect(venue.text).toContain('We don&#39;t have a page for that venue');
    expect(venue.text).not.toContain('event isn&#39;t listed');
    expect(venue.text).toContain('href="/venues"');
    const ev = await get('/events/2026-01-01-gone');
    expect(ev.text).toContain('That event isn&#39;t listed anymore');
    expect(renderNotFoundPage({ siteUrl: SITE })).toContain('We couldn&#39;t find that page');
  });

  it('short seasonal URLs redirect to their guide', async () => {
    await startApp();
    const r = await get('/halloween');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/halloween-events');
    expect((await get('/christmas?x=1')).headers.get('location')).toBe('/christmas-events?x=1');
  });
});

describe('bare-domain forwarding', () => {
  it('collapses a leading double slash with a 301 and stays on this site', async () => {
    await startApp();
    for (const [from, to] of [['//about', '/about'], ['///admin.html', '/admin.html'],
      ['//this-weekend?x=1', '/this-weekend?x=1'], ['//evil.example/x', '/evil.example/x']]) {
      const r = await get(from);
      expect(r.status, from).toBe(301);
      expect(r.headers.get('location'), from).toBe(to);
    }
    expect((await get('/about')).status).toBe(200);
  });
});

describe('static cache headers', () => {
  it('caches images for a day, css/js briefly, and keeps text files fresh', async () => {
    await startApp();
    expect((await get('/og-image.png')).headers.get('cache-control')).toBe('public, max-age=86400');
    expect((await get('/icons.svg')).headers.get('cache-control')).toBe('public, max-age=86400');
    expect((await get('/style.css')).headers.get('cache-control')).toBe('public, max-age=600');
    expect((await get('/app.js')).headers.get('cache-control')).toBe('public, max-age=600');
    expect((await get('/robots.txt')).headers.get('cache-control')).toBe('public, max-age=0');
  });
});

describe('times', () => {
  it('formats every source style one way', () => {
    expect(formatTime('04:00 PM')).toBe('4:00 PM');
    expect(formatTime('5:30PM – 7:00PM')).toBe('5:30 PM – 7:00 PM');
    expect(formatTime('4:00 PM - 6:00 PM')).toBe('4:00 PM – 6:00 PM');
    expect(formatTime('10am - 3pm')).toBe('10 AM – 3 PM');
    expect(formatTime('7:00 p.m.')).toBe('7:00 PM');
    expect(formatTime('10:05 AM')).toBe('10:05 AM');
    expect(formatTime('06:00PM-09:00PM')).toBe('6:00 PM – 9:00 PM');
    expect(formatTime('All day')).toBe('All day');
    expect(formatTime(undefined)).toBe('');
  });

  it('lists show the formatted time but keep the stored one (slugs, keys)', async () => {
    await startApp();
    const home = (await get('/')).text;
    expect(home).toContain('<span class="event-time">9:30 PM – 2:00 AM</span>');
    const feed = await fetch(baseUrl + '/events.json').then(r => r.json());
    expect(feed.events.find(e => e.name === 'Wednesday Night Karaoke').time).toBe('9:30PM-2:00AM');
  });
});

describe('Event JSON-LD', () => {
  it('ends the next day when an event runs past midnight', () => {
    const [ev] = withPages([{ date: '2026-10-07', name: 'Karaoke', time: '9:30 PM – 2:00 AM' }]);
    const ld = eventJsonLd(ev, SITE);
    expect(ld.startDate).toBe('2026-10-07T21:30:00-05:00');
    expect(ld.endDate).toBe('2026-10-08T02:00:00-05:00');
    const [same] = withPages([{ date: '2026-10-07', name: 'Show', time: '7 PM - 9 PM' }]);
    expect(eventJsonLd(same, SITE).endDate).toBe('2026-10-07T21:00:00-05:00');
  });

  it('uses the next day’s offset across the DST change', () => {
    const [ev] = withPages([{ date: '2026-10-31', name: 'Late Party', time: '10 PM - 2 AM' }]);
    expect(eventJsonLd(ev, SITE).endDate).toBe('2026-11-01T02:00:00-06:00');
  });
});

describe('event pages', () => {
  it('says to check with the venue when there is no details link', async () => {
    await startApp();
    const r = (await get('/events/2026-10-09-next-stop-comedy')).text;
    expect(r).toMatch(/<dt>Cost<\/dt><dd>(<a href="\/venues\/[a-z-]+">)?Check with the venue/);
    expect(r).toContain('is on Friday, October 9, 2026, 8:00 PM, at La Cantina in Victoria, TX.');
    const linked = (await get('/events/2026-10-10-live-music')).text;
    expect(linked).toContain('<dt>Cost</dt><dd>See event details</dd>');
    expect(linked).toContain('<title>Live Music at J Welch Farms · Oct 10 | The Vic 361</title>');
  });

  it('keeps long titles to the name and date', async () => {
    await startApp();
    const r = (await get('/events/2026-10-07-wednesday-night-karaoke')).text;
    expect(r).toContain('<title>Wednesday Night Karaoke at Pumphouse · Oct 7 | The Vic 361</title>');
    expect(r).toContain('from 9:30 PM to 2:00 AM at Pumphouse');
  });
});

describe('homepage', () => {
  it('folds every day but today, which opens (and can fold too)', async () => {
    await startApp();
    const home = (await get('/')).text;
    const days = [...home.matchAll(/<section class="day-section day-section--fold( day-section--past)?" id="day-(\d)"><details( open)?>/g)]
      .map(m => ({ day: m[2], past: Boolean(m[1]), open: Boolean(m[3]) }));
    expect(days).toHaveLength(7);
    // Today is Wednesday (day-2): the only open one; Mon/Tue look past.
    expect(days.filter(d => d.open).map(d => d.day)).toEqual(['2']);
    expect(days.filter(d => d.past).map(d => d.day)).toEqual(['0', '1']);
    expect(home).toContain('Monday Market'); // folded days are still in the markup for crawlers
    expect(home).toMatch(/<summary class="day-header">.*Monday.*<span class="day-count">1 event<\/span><\/summary>/);
    expect(home).toMatch(/<summary class="day-header">.*Today.*<span class="day-count">/);
  });

  it('has a skip link, a phone-size submit button and the theme toggle on every page', async () => {
    await startApp();
    for (const p of ['/', '/this-weekend', '/about']) {
      const html = (await get(p)).text;
      expect(html, p).toMatch(/<body>\s*<a class="skip-link" href="#main">Skip to content<\/a>/);
      expect(html, p).toMatch(/<main class="main-content" id="main">/);
      expect(html, p).toContain('class="btn btn--outline mobile-submit"');
      expect(html, p).toContain('data-theme-toggle');
      expect(html, p).toContain(THEME_SCRIPT);
    }
  });
});

describe('about and llms.txt', () => {
  it('describe how events are really checked', async () => {
    await startApp();
    const about = (await get('/about')).text;
    expect(about).not.toContain('reviews every event');
    expect(about).toContain('gather events automatically');
    expect(about).toContain('a local editor reviews anything they flag');
    expect(about).toContain('href="/contact"');
    const llms = (await get('/llms.txt')).text;
    expect(llms).not.toContain('reviewed by a local editor and');
    expect(llms).toContain('Collected automatically, checked by automated rules and AI');
  });
});

describe('sponsor link', () => {
  it('is marked sponsored, keeps the referrer and carries utm tags', () => {
    const html = sponsorHtml({ name: 'Acme', cta: 'Visit', url: 'https://acme.example/menu' });
    expect(html).toContain('rel="sponsored noopener"');
    expect(html).not.toContain('noreferrer');
    expect(html).toContain('href="https://acme.example/menu?utm_source=thevic361&amp;utm_medium=sponsor&amp;utm_campaign=weekly-sponsor"');
    expect(sponsorLinkUrl('https://acme.example/?utm_source=mine')).toBe('https://acme.example/?utm_source=mine');
    expect(sponsorLinkUrl('https://acme.example/', 'newsletter')).toContain('utm_medium=newsletter');
    expect(sponsorLinkUrl('javascript:alert(1)')).toBe('');
  });
});

describe('venue addresses', () => {
  it('drops the city the page adds itself', () => {
    expect(streetAddress('203 E. Constitution St, Victoria, TX')).toBe('203 E. Constitution St');
    expect(streetAddress('101 W Juan Linn St, Victoria, TX 77901')).toBe('101 W Juan Linn St');
    expect(streetAddress('309 E Crestwood Dr')).toBe('309 E Crestwood Dr');
    expect(streetAddress('123 N Victoria')).toBe('123 N Victoria');
  });
});

describe('PR preview sample events', () => {
  it('moves the bundled sample into this week by whole weeks', async () => {
    const { shiftToWeek } = await import('../server/seo.js');
    const evs = [{ date: '2026-05-11', name: 'Mon' }, { date: '2026-05-16', name: 'Sat' }, { date: '2026-05-19', name: 'Next Tue' }];
    // Wednesday Oct 7 2026: the sample's first week becomes Oct 5–11.
    expect(shiftToWeek(evs, '2026-10-07').map(e => e.date)).toEqual(['2026-10-05', '2026-10-10', '2026-10-13']);
    expect(shiftToWeek([], '2026-10-07')).toEqual([]);
  });

  it('only a PR preview environment shows them this week; production never does', async () => {
    // The sample's dates 21 weeks back: May 11–16, 2026 is Mon–Sat, like Oct 5–10.
    const may = EVENTS.map(e => ({ ...e, date: { '2026-10-05': '2026-05-11', '2026-10-07': '2026-05-13', '2026-10-09': '2026-05-15', '2026-10-10': '2026-05-16' }[e.date] }));
    await startApp({ events: may, railwayEnvironment: 'thevic361-pr-134' });
    expect((await get('/')).text).toContain('Monday Market');
    expect((await get('/')).text).toMatch(/Monday[\s\S]*?<span class="day-count">1 event</);
    await new Promise(r => server.close(r)); server = null;
    await fs.rm(tmpDir, { recursive: true, force: true }); tmpDir = null;
    await startApp({ events: may, railwayEnvironment: 'production' });
    expect((await get('/')).text).not.toContain('Monday Market');
  });
});

describe('asset versions', () => {
  it('pages link the site CSS and JS with a version, so a deploy never pairs new pages with cached old styles', async () => {
    await startApp();
    for (const p of ['/', '/about']) {
      const html = (await get(p)).text;
      expect(html).toMatch(/href="\/?\.?\/?style\.css\?v=[0-9a-f]{10}"/);
      expect(html).toMatch(/href="\/?\.?\/?base\.css\?v=[0-9a-f]{10}"/);
      expect(html).not.toMatch(/style\.css"/);
    }
    expect((await get('/')).text).toMatch(/src="\.\/app\.js\?v=[0-9a-f]{10}"/);
    // The versioned file is the same file.
    const v = (await get('/')).text.match(/style\.css\?v=([0-9a-f]+)/)[1];
    expect((await get(`/style.css?v=${v}`)).status).toBe(200);
  });
});
