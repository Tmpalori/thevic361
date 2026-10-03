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
  { date: '2026-10-12', name: 'Aero Open Mic', time: '7:00 PM', venue: 'Aero Crafters', icons: ['music'] }
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
