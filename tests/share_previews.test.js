// @vitest-environment jsdom
//
// Sharing: each event's own link-preview card (server/ogImage.js, served at
// /events/<slug>.png and named in the page's og:image) and the share icon on
// every event in a list (server/seo.js, docs/app.js, docs/track.js).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { renderEventItem } from '../server/seo.js';
import { eventCardSvg, eventCardVersion, renderEventCard } from '../server/ogImage.js';

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const NOW = new Date('2026-10-07T17:00:00Z');
const EVENTS = [
  { date: '2026-10-09', name: 'Friday Live Music', time: '8pm - 11pm', venue: 'Moonshine',
    description: 'Local bands.', icons: ['music'], free: false, url: 'https://example.com/music' },
  { date: '2026-10-08', name: '<script>alert(1)</script> "Bad" & Co', time: '6 PM', venue: 'X',
    icons: [], free: true, url: '' }
];

function pngSize(buf) {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe('event preview card', () => {
  it('renders a 1200x630 PNG', () => {
    const png = renderEventCard({ ...EVENTS[0], page: '/events/2026-10-09-friday-live-music' });
    expect(pngSize(png)).toEqual([1200, 630]);
  });

  it('escapes the event text in the SVG', () => {
    const svg = eventCardSvg(EVENTS[1]);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('&quot;Bad&quot; &amp; Co');
  });

  it('shows the Vic’s Pick badge and day, and the version follows what is drawn', () => {
    const ev = { ...EVENTS[0], page: '/x' };
    expect(eventCardSvg(ev)).not.toContain('VIC’S PICK');
    expect(eventCardSvg({ ...ev, featured: true })).toContain('VIC’S PICK');
    expect(eventCardSvg(ev)).toContain('FRI, OCT 9');
    expect(eventCardVersion(ev)).toBe(eventCardVersion({ ...ev, description: 'changed' }));
    expect(eventCardVersion(ev)).not.toBe(eventCardVersion({ ...ev, featured: true }));
    expect(eventCardVersion(ev)).not.toBe(eventCardVersion({ ...ev, time: '9pm' }));
  });

  it('keeps a very long name to three lines', () => {
    const svg = eventCardSvg({ ...EVENTS[0], name: 'Word '.repeat(60).trim() });
    const nameLines = svg.match(/font-size="52" fill="#1F1A3D"/g) || [];
    expect(nameLines).toHaveLength(3);
    expect(svg).toContain('…');
  });
});

describe('event page and image routes', () => {
  let tmpDir, server, baseUrl;

  async function startApp() {
    tmpDir = await fs.mkdtemp(join(os.tmpdir(), 'vic361-share-'));
    const eventsFile = join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({
      last_updated: '2026-10-05T03:00:00-05:00', events: EVENTS, new_and_notable: [], sponsor: null
    }));
    const storeBundle = { kind: 'file', store: new FileStore(join(tmpDir, 's.json')) };
    const { app } = await createApp({
      storeBundle, eventsFile, trustProxy: false, now: () => NOW, siteUrl: 'https://www.thevic361.com'
    });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }

  afterEach(async () => {
    if (server) await new Promise(r => server.close(r));
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    server = null; tmpDir = null;
  });

  it('the event page names its own card, and the card is served', async () => {
    await startApp();
    const page = await (await fetch(`${baseUrl}/events/2026-10-09-friday-live-music`)).text();
    const v = eventCardVersion(EVENTS[0]);
    expect(page).toContain(`<meta property="og:image" content="https://www.thevic361.com/events/2026-10-09-friday-live-music.png?v=${v}">`);
    expect(page).toContain('<meta property="og:image:width" content="1200">');
    expect(page).toContain(`<meta name="twitter:image" content="https://www.thevic361.com/events/2026-10-09-friday-live-music.png?v=${v}">`);

    const r = await fetch(`${baseUrl}/events/2026-10-09-friday-live-music.png?v=${v}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('cache-control')).toContain('max-age');
    expect(pngSize(Buffer.from(await r.arrayBuffer()))).toEqual([1200, 630]);

    expect((await fetch(`${baseUrl}/events/2026-01-01-gone.png`)).status).toBe(404);
  });

  it('other pages keep the site-wide image', async () => {
    await startApp();
    const home = await (await fetch(`${baseUrl}/`)).text();
    expect(home).toContain('og-image.png');
    expect(home).not.toMatch(/og:image" content="[^"]*\/events\//);
  });
});

describe('share icon on each list item', () => {
  const ev = { ...EVENTS[1], page: '/events/2026-10-08-bad' };

  it('is in the server-rendered list, escaped', () => {
    const html = renderEventItem(ev);
    expect(html).toContain('<button type="button" class="event-share" data-share-url="/events/2026-10-08-bad"');
    expect(html).toContain('aria-label="Share &lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(renderEventItem({ ...ev, page: undefined })).not.toContain('event-share');
  });

  it('docs/app.js renders the same button', () => {
    document.body.innerHTML = '<header id="site-header"></header><main><div id="events-container"></div><section id="sponsor-section"></section></main>';
    delete window.__vic361App;
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    window.fetch = () => new Promise(() => {});
    (0, eval)(readFileSync(join(DOCS, 'app.js'), 'utf8'));
    const button = html => html.slice(html.indexOf('<button'), html.indexOf('</button>') + 9);
    const client = window.__vic361App.renderEvent(ev);
    expect(button(client)).toBe(button(renderEventItem(ev)));
    expect(window.__vic361App.renderEvent({ ...ev, page: undefined })).not.toContain('event-share');
  });

  it('tapping it copies the full link and counts a list share', async () => {
    const sent = [];
    vi.stubGlobal('fetch', (url, opts) => { sent.push(JSON.parse(opts.body)); return Promise.resolve({}); });
    const writes = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: u => { writes.push(u); return Promise.resolve(); } } });
    document.body.innerHTML = renderEventItem(ev);
    new Function(readFileSync(join(DOCS, 'track.js'), 'utf8'))();
    const btn = document.querySelector('.event-share');
    btn.click();
    await Promise.resolve();
    expect(writes).toEqual([`${location.origin}/events/2026-10-08-bad`]);
    expect(btn.classList.contains('is-copied')).toBe(true);
    expect(btn.querySelector('svg')).not.toBeNull(); // the icon stays
    expect(sent.some(b => b.kind === 'click' && b.type === 'share_from_list')).toBe(true);
    vi.unstubAllGlobals();
  });
});
