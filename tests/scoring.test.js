// @vitest-environment node
//
// Event scoring and the daily limit (server/scoring.js): each day shows its
// best 15 (Mon–Thu) or 20 (Fri–Sun) events, Vic's Picks and "show anyway"
// events always; dropped events leave the day lists but keep their page and
// their place in the guides.

import { describe, it, expect, afterEach } from 'vitest';
import { scoreEvent, capDays, shown, dayMax, pickDays } from '../server/scoring.js';
import { comingUpEvents, withPages } from '../server/seo.js';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const base = { date: '2026-10-08', time: '7:00 PM', venue: 'Somewhere', description: 'A good long description of what is happening here.' };
const score = ev => scoreEvent({ ...base, ...ev }).score;

describe('scoreEvent', () => {
  it('ranks big one-time draws over ordinary outings over niche weekly repeats', () => {
    const fest = score({ name: 'Uniting Hearts Music Festival', big: true, appeal: 5, free: true });
    const music = score({ name: 'Henry Emiliano LIVE', appeal: 3 });
    const chess = score({ name: 'Chess Club', recurring: true, appeal: 2 });
    expect(fest).toBeGreaterThan(music);
    expect(music).toBeGreaterThan(chess);
    expect(fest).toBeGreaterThanOrEqual(85);
    expect(chess).toBeLessThanOrEqual(25);
  });

  it('weekly favorites keep their spot; other weekly repeats drop', () => {
    expect(score({ name: "Victoria Farmers' Market", recurring: true, favorite: true }))
      .toBeGreaterThan(score({ name: 'Wednesday Night Karaoke', recurring: true }));
  });

  it('store promos and missing details score low', () => {
    expect(score({ name: "Lowe's Kids Craft: Holiday Engine" })).toBeLessThan(score({ name: 'Pumpkin Fest' }));
    expect(score({ name: 'Mystery Night', time: '', venue: '', description: '' }))
      .toBeLessThan(score({ name: 'Mystery Night' }));
  });

  it('several sources, hand-added and submitted events get a bonus', () => {
    const plain = score({ name: 'Fall Fest' });
    expect(score({ name: 'Fall Fest', sources: 3 })).toBeGreaterThan(plain);
    expect(score({ name: 'Fall Fest', curated: true })).toBeGreaterThan(plain);
    expect(score({ name: 'Fall Fest', submitted: true })).toBeGreaterThan(plain);
  });

  it('popular venues count; small nearby-town events lose points', () => {
    const venues = [{ name: 'Aero Crafters', tier: 'HIGH', key: 'aero crafters', slug: 'aero-crafters', path: '/venues/aero-crafters' }];
    const at = scoreEvent({ ...base, name: 'Open Mic', venue: 'Aero Crafters' }, { venues }).score;
    const elsewhere = scoreEvent({ ...base, name: 'Open Mic', venue: 'Some Bar' }, { venues }).score;
    expect(at).toBeGreaterThan(elsewhere);
    expect(score({ name: 'Trunk or Treat', town: 'Ganado' })).toBeLessThan(score({ name: 'Trunk or Treat' }));
    expect(score({ name: 'Turkeyfest', town: 'Cuero', big: true })).toBeGreaterThan(70);
  });

  it('stays within 0–100 and explains itself', () => {
    const r = scoreEvent({ ...base, name: 'Huge Festival Parade Concert', big: true, appeal: 5, sources: 9, curated: true, free: true, icons: ['family'], url: 'https://x' });
    expect(r.score).toBe(100);
    expect(r.why.join(', ')).toMatch(/big event/);
    expect(scoreEvent({ name: 'x', date: '2026-10-08', recurring: true, appeal: 1 }).score).toBeGreaterThanOrEqual(0);
  });
});

describe('capDays', () => {
  const day = (date, n, extra = {}) => Array.from({ length: n }, (_, i) => ({
    ...base, date, name: `Event ${String(i).padStart(2, '0')}`, venue: `Venue ${i}`, appeal: 3, ...extra
  }));

  it('15 on a weekday, 20 on Fri–Sun; days under the limit are untouched', () => {
    expect(dayMax('2026-10-08')).toBe(15); // Thu
    expect(dayMax('2026-10-09')).toBe(20); // Fri
    expect(dayMax('2026-10-11')).toBe(20); // Sun
    const out = capDays([...day('2026-10-08', 18), ...day('2026-10-10', 22), ...day('2026-10-06', 5)]);
    const count = d => shown(out).filter(e => e.date === d).length;
    expect(count('2026-10-08')).toBe(15);
    expect(count('2026-10-10')).toBe(20);
    expect(count('2026-10-06')).toBe(5);
    expect(out.filter(e => e.date === '2026-10-06').some(e => e.overflow)).toBe(false);
  });

  it('drops the lowest scores; Vic’s Picks and show-anyway events always stay', () => {
    const list = [
      ...day('2026-10-08', 15, { appeal: 4 }),
      { ...base, name: 'Chess Club', recurring: true, appeal: 2 },
      { ...base, name: 'Paid Pick', appeal: 1, featured: true, time: '' },
      { ...base, name: 'Rescued Bingo', appeal: 1, recurring: true, keep: true }
    ];
    const out = capDays(list);
    const names = shown(out).map(e => e.name);
    expect(names).toContain('Paid Pick');
    expect(names).toContain('Rescued Bingo');
    expect(names).not.toContain('Chess Club');
    expect(names).toHaveLength(15);
    expect(out.find(e => e.name === 'Chess Club').overflow).toBe(true);
  });

  it('keeps a day varied: no more than 3 trunk-or-treats or 2 per venue while other events wait', () => {
    const list = [
      ...Array.from({ length: 8 }, (_, i) => ({ ...base, name: `Church ${i} Trunk or Treat`, venue: `Church ${i}`, appeal: 4 })),
      ...Array.from({ length: 4 }, (_, i) => ({ ...base, name: `Evan's Show ${i}`, venue: "Evan's", appeal: 4 })),
      ...day('2026-10-08', 10, { appeal: 3 })
    ];
    const kept = shown(capDays(list));
    expect(kept).toHaveLength(15);
    expect(kept.filter(e => /Trunk or Treat/.test(e.name))).toHaveLength(3);
    expect(kept.filter(e => e.venue === "Evan's")).toHaveLength(2);
  });

  it('fills leftover room by score when there isn’t enough variety', () => {
    const list = Array.from({ length: 20 }, (_, i) => ({ ...base, name: `Trunk or Treat ${i}`, venue: `Place ${i}`, appeal: 3 }));
    expect(shown(capDays(list))).toHaveLength(15);
  });

  it('does not change its input, and a stale overflow mark is recomputed', () => {
    const list = [{ ...base, name: 'Solo', overflow: true }];
    const out = capDays(list);
    expect(list[0].score).toBeUndefined();
    expect(out[0].overflow).toBeUndefined();
  });
});

describe('editor’s picks (pickDays)', () => {
  const ev = (date, name, score, extra = {}) => ({ date, name, venue: `${name} Hall`, score, ...extra });
  const picks = (list, date) => pickDays(list).filter(e => e.date === date && e.featured).map(e => e.name);

  it('up to 2 strong events on a weekday and 3 on Fri–Sun', () => {
    const wk = [ev('2026-10-08', 'A', 90), ev('2026-10-08', 'B', 80), ev('2026-10-08', 'C', 75), ev('2026-10-08', 'D', 40)];
    expect(picks(wk, '2026-10-08')).toEqual(['A', 'B']);
    const sat = [ev('2026-10-10', 'A', 90), ev('2026-10-10', 'B', 80), ev('2026-10-10', 'C', 75), ev('2026-10-10', 'D', 72)];
    expect(picks(sat, '2026-10-10')).toEqual(['A', 'B', 'C']);
  });

  it('a quiet day still gets its minimum if the best are decent, never weak ones', () => {
    expect(picks([ev('2026-10-08', 'A', 68), ev('2026-10-08', 'B', 66)], '2026-10-08')).toEqual(['A']);
    expect(picks([ev('2026-10-10', 'A', 68), ev('2026-10-10', 'B', 66), ev('2026-10-10', 'C', 60)], '2026-10-10')).toEqual(['A', 'B']);
    expect(picks([ev('2026-10-08', 'A', 62)], '2026-10-08')).toEqual([]);
  });

  it('only one-time Victoria events, each picked once', () => {
    const list = [
      ev('2026-10-09', 'Turkeyfest', 95, { town: 'Cuero' }),
      ev('2026-10-09', 'Corn Maze', 90, { recurring: true, favorite: true }),
      ev('2026-10-09', 'Harvest Fest', 85), ev('2026-10-10', 'Harvest Fest', 85), ev('2026-10-10', 'Zoo Boo', 80)
    ];
    const out = pickDays(list);
    expect(out.filter(e => e.featured).map(e => `${e.date} ${e.name}`)).toEqual(['2026-10-09 Harvest Fest', '2026-10-10 Zoo Boo']);
  });

  it('paid Vic’s Picks come first and take an editor’s spot', () => {
    const list = [ev('2026-10-08', 'Paid', 30, { featured: true }), ev('2026-10-08', 'A', 90), ev('2026-10-08', 'B', 85)];
    const out = pickDays(list);
    expect(out.filter(e => e.featured).map(e => e.name)).toEqual(['Paid', 'A']);
    expect(out.find(e => e.name === 'Paid').editor_pick).toBeUndefined();
    const full = [ev('2026-10-08', 'P1', 30, { featured: true }), ev('2026-10-08', 'P2', 30, { featured: true }), ev('2026-10-08', 'A', 95)];
    expect(pickDays(full).find(e => e.name === 'A').featured).toBeUndefined();
  });

  it('one pick per venue, none from dropped events, and stale marks are recomputed', () => {
    const list = [
      ev('2026-10-10', 'Show 1', 90, { venue: "Evan's" }), ev('2026-10-10', 'Show 2', 88, { venue: "Evan's" }),
      ev('2026-10-10', 'Dropped', 99, { overflow: true }), ev('2026-10-10', 'Fest', 80),
      ev('2026-10-10', 'Old Pick', 10, { featured: true, editor_pick: true })
    ];
    expect(picks(list, '2026-10-10')).toEqual(['Show 1', 'Fest']);
  });

  it('editor’s picks stay out of “Coming up”; paid ones still show', () => {
    const list = withPages([
      { date: '2026-10-20', name: 'Editor Pick', venue: 'X', featured: true, editor_pick: true },
      { date: '2026-10-21', name: 'Paid Pick', venue: 'Y', featured: true }
    ]);
    expect(comingUpEvents(list, '2026-10-07').map(e => e.name)).toEqual(['Paid Pick']);
  });
});

describe('the site with the daily limit', () => {
  let tmpDir, server, baseUrl, store;
  const NOW = new Date('2026-10-07T17:00:00Z'); // Wed

  afterEach(async () => {
    if (server) await new Promise(r => server.close(r));
    // Save & Publish archives events in the background; retry while it writes.
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    server = null; tmpDir = null;
  });

  async function start(events) {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-score-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    store = new FileStore(path.join(tmpDir, 's.json'));
    await store.setPublished({ last_updated: '2026-10-05T00:00:00Z', events });
    const { app } = await createApp({
      storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
      siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c'
    });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }
  const auth = async () => {
    const r = await fetch(baseUrl + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'b' }) });
    return { Authorization: `Bearer ${(await r.json()).token}`, 'Content-Type': 'application/json' };
  };

  const thursday = [
    ...Array.from({ length: 15 }, (_, i) => ({ ...base, name: `Good Event ${i}`, venue: `Venue ${i}`, appeal: 5, icons: ['family'] })),
    { ...base, name: 'Chess Club', venue: 'Victoria Public Library', recurring: true, appeal: 2, icons: ['family', 'free'], free: true }
  ];

  it('a dropped event leaves the day lists but keeps its page and the guides', async () => {
    await start(thursday);
    const feed = await (await fetch(baseUrl + '/events.json')).json();
    expect(feed.events).toHaveLength(15);
    expect(feed.events.map(e => e.name)).not.toContain('Chess Club');
    expect(feed.events[0]).not.toHaveProperty('score');
    const home = await (await fetch(baseUrl + '/')).text();
    expect(home).not.toContain('Chess Club');
    const page = await fetch(baseUrl + '/events/2026-10-08-chess-club');
    expect(page.status).toBe(200);
    const kids = await (await fetch(baseUrl + '/kids-and-family')).text();
    expect(kids).toContain('Chess Club');
  });

  it('?all=1 gives the event check and submission review every public event, dropped ones flagged', async () => {
    await start(thursday);
    const all = await (await fetch(baseUrl + '/events.json?all=1')).json();
    expect(all.events).toHaveLength(16);
    expect(all.events.find(e => e.name === 'Chess Club').overflow).toBe(true);
    expect(all.events.some(e => 'score' in e || 'keep' in e)).toBe(false);
  });

  it('“Show anyway” follows the event when the admin edits its name', async () => {
    await start(thursday);
    const h = await auth();
    const key = '2026-10-08|Chess Club|Victoria Public Library';
    await fetch(baseUrl + '/api/admin/keep-event', { method: 'POST', headers: h, body: JSON.stringify({ key, keep: true }) });
    const edit = { name: 'Saturday Chess Club', date: '2026-10-08', time: '7:00 PM', venue: 'Victoria Public Library', description: 'Weekly chess for all levels at the library.', icons: ['family'], free: true };
    const r = await fetch(baseUrl + '/api/admin/event-edits', { method: 'POST', headers: h, body: JSON.stringify({ original_key: key, payload: edit }) });
    expect(r.status).toBe(200);
    expect((await store.getPublished()).kept).toEqual(['2026-10-08|Saturday Chess Club|Victoria Public Library']);
    const feed = await (await fetch(baseUrl + '/events.json')).json();
    expect(feed.events.map(e => e.name)).toContain('Saturday Chess Club');
  });

  it('the admin sees it as dropped and can show it anyway, then undo', async () => {
    await start(thursday);
    const h = await auth();
    const list = await (await fetch(baseUrl + '/api/admin/published-events', { headers: h })).json();
    const chess = list.events.find(e => e.name === 'Chess Club');
    expect(chess).toMatchObject({ overflow: true, keep: false });
    expect(typeof chess.score).toBe('number');

    const key = '2026-10-08|Chess Club|Victoria Public Library';
    const r = await (await fetch(baseUrl + '/api/admin/keep-event', { method: 'POST', headers: h, body: JSON.stringify({ key, keep: true }) })).json();
    expect(r.ok).toBe(true);
    let feed = await (await fetch(baseUrl + '/events.json')).json();
    expect(feed.events.map(e => e.name)).toContain('Chess Club');
    expect(feed).not.toHaveProperty('kept');

    await fetch(baseUrl + '/api/admin/keep-event', { method: 'POST', headers: h, body: JSON.stringify({ key, keep: false }) });
    feed = await (await fetch(baseUrl + '/events.json')).json();
    expect(feed.events.map(e => e.name)).not.toContain('Chess Club');

    const bad = await fetch(baseUrl + '/api/admin/keep-event', { method: 'POST', headers: h, body: JSON.stringify({ key: 'nope', keep: true }) });
    expect(bad.status).toBe(400);
  });

  it('Save & Publish never stores a score, drop mark or keep flag on an event', async () => {
    await start(thursday);
    const h = await auth();
    const list = await (await fetch(baseUrl + '/api/admin/published-events', { headers: h })).json();
    // As if the admin page sent back an editor's pick as featured.
    list.events = list.events.map(e => e.editor_pick ? { ...e, featured: true } : e);
    expect(list.events.some(e => e.editor_pick)).toBe(true);
    const pub = await (await fetch(baseUrl + '/api/admin/publish-events', { method: 'POST', headers: h, body: JSON.stringify({ events: list.events, based_on: list.last_updated }) })).json();
    expect(pub.ok).toBe(true);
    const stored = (await store.getPublished()).events;
    expect(stored.some(e => 'score' in e || 'overflow' in e || 'keep' in e || 'editor_pick' in e)).toBe(false);
    expect(stored.some(e => e.featured)).toBe(false); // nothing pinned for good
  });
});
