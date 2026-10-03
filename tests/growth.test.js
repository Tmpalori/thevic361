// @vitest-environment node
//
// Traffic features: search landing pages and list share images.

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = new Date('2026-10-09T15:00:00Z'); // Fri Oct 9, 10 AM CDT

const EVENTS = [
  { date: '2026-10-09', name: 'Friday Live Music', time: '8:00 PM', venue: 'Aero Crafters', icons: ['music', 'drinks'] },
  { date: '2026-10-09', name: 'Morning Story Time', time: '10:00 AM', venue: 'Victoria Public Library', icons: ['family'] },
  { date: '2026-10-10', name: 'Zoo Boo', time: '1:00 PM', venue: 'The Texas Zoo', icons: ['family', 'outdoors'] },
  { date: '2026-10-10', name: 'Art After Dark', time: '7:00 PM', venue: 'The Nave Museum', icons: ['arts'] },
  { date: '2026-10-12', name: 'Aero Open Mic', time: '7:00 PM', venue: 'Aero Crafters', icons: ['music'] },
  { date: '2026-10-10', name: 'Texas A&amp;M Night', time: '6:00 PM', venue: '1907 N Ben Jordan St, Victoria, TX', address: '1907 N Ben Jordan St, Victoria, TX', icons: ['family'] },
  { date: '2026-10-10', name: 'Josh Abbott Acoustic', time: '8:00 PM', venue: 'Aero Crafters', url: 'https://www.eventbrite.com/b/tx--victoria/music/', icons: ['music'] },
  { date: '2026-10-10', name: 'Real Ticket Show', time: '9:00 PM', venue: 'Aero Crafters', url: 'https://www.eventbrite.com/e/real-ticket-show-tickets-123', icons: ['music'] }
];
const VENUES = [
  { name: 'Aero Crafters', category: 'Bar / Live Music' },
  { name: 'The Nave Museum', category: 'Museum' }
];

let tmpDir, server, baseUrl;

async function start() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-growth-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  const venuesFile = path.join(tmpDir, 'venues.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: EVENTS }));
  await fs.writeFile(venuesFile, JSON.stringify(VENUES));
  const { app } = await createApp({
    storeBundle: { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) },
    eventsFile, venuesFile, trustProxy: false, now: () => NOW, siteUrl: 'https://www.thevic361.com'
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

const get = async (p) => { const r = await fetch(baseUrl + p); return { r, html: await r.text() }; };

describe('search landing pages', () => {
  it('tonight, date night and weekend-with-kids filter correctly and stay out of the top nav', async () => {
    await start();
    const tonight = (await get('/tonight')).html;
    expect(tonight).toContain('Friday Live Music');
    expect(tonight).not.toContain('Morning Story Time');

    const date = (await get('/date-night')).html;
    expect(date).toContain('Art After Dark');
    expect(date).not.toContain('Zoo Boo');

    const kids = (await get('/this-weekend-with-kids')).html;
    expect(kids).toContain('Zoo Boo');
    expect(kids).not.toContain('Friday Live Music');

    const nav = (await get('/')).html.match(/<nav class="browse-nav"[\s\S]*?<\/nav>/)[0];
    expect(nav).not.toContain('/tonight');
    expect(tonight).toContain('href="/date-night"'); // footer
    expect((await get('/sitemap.xml')).html).toContain('/this-weekend-with-kids');
  });

  it('lists get a share button and the weekend page previews the weekend slide', async () => {
    await start();
    const wk = (await get('/this-weekend')).html;
    expect(wk).toContain('data-share-url="https://www.thevic361.com/this-weekend"');
    expect(wk).toContain('content="https://www.thevic361.com/social/latest/weekend-1.png"');
    const home = (await get('/')).html;
    expect(home).toContain('property="og:image" content="https://www.thevic361.com/social/latest/week-1.png"');
    expect(home).not.toContain('og:image:width');
  });
});

describe('event text', () => {
  it('decodes stored HTML entities and does not repeat the address', async () => {
    await start();
    const d = await (await fetch(baseUrl + '/events.json')).json();
    expect(d.events.find(e => e.date === '2026-10-10' && e.name.startsWith('Texas')).name).toBe('Texas A&M Night');
    const html = (await get('/')).html;
    expect(html).not.toContain('&amp;amp;');
    expect(html).toContain('Texas A&amp;M Night');
    const row = html.match(/<span class="event-venue">([^<]*)<\/span>/g).find(s => s.includes('Ben Jordan'));
    expect(row).toBe('<span class="event-venue">1907 N Ben Jordan St</span>');
  });
});

describe('event links', () => {
  it('drops search/category links but keeps real event links', async () => {
    await start();
    const d = await (await fetch(baseUrl + '/events.json')).json();
    expect(d.events.find(e => e.name === 'Josh Abbott Acoustic').url).toBe('');
    expect(d.events.find(e => e.name === 'Real Ticket Show').url).toContain('/e/real-ticket-show');
    expect((await get('/')).html).not.toContain('eventbrite.com/b/');
  });
});

describe('link audit helpers', async () => {
  const { isMismatchedUrl, linkLabel } = await import('../server/seo.js');
  it('flags an event link whose slug names another event', () => {
    expect(isMismatchedUrl('https://www.facebook.com/events/306-w-commercial-st-victoria-tx/nave-volunteer-information-session/1065577712573226/', 'Live Band Karaoke')).toBe(true);
    expect(isMismatchedUrl('https://allevents.in/victoria/walk-to-end-alzheimers/200030364373618', "Walk to End Alzheimer's")).toBe(false);
    expect(isMismatchedUrl('https://www.facebook.com/victoriamainstreet/posts/-music-on-main-street/138', 'Thursday Karaoke')).toBe(false);
    expect(isMismatchedUrl('https://victoriapl.librarycalendar.com/event/adult-program-9240', 'Sourdough Baking')).toBe(false);
  });
  it('labels venue homepages and posts honestly', () => {
    expect(linkLabel('https://palacebingo.org')).toBe('Venue website');
    expect(linkLabel('https://www.weldercenter.org/events')).toBe('Venue website');
    expect(linkLabel('https://www.instagram.com/p/DdtoAzUCJ6L/')).toBe('See the post');
    expect(linkLabel('https://www.facebook.com/VictoriaFarmersMarket')).toBe('Venue page');
    expect(linkLabel('https://allevents.in/victoria/tejas-fest-2026/200030008232138')).toBe('Event details');
  });
});
