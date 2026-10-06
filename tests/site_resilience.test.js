// @vitest-environment node
//
// Outages and moving URLs: auto-publish retried by the hourly check, the
// Postgres circuit breaker, a last good copy of the list when a read
// fails, renamed events 301 and removed ones stay gone, edits of edited
// events, "Mark duplicate" on a collector event, deterministic -2 pages,
// shared-meridiem time ranges, IPv6 /64 rate limits, the admin CSP on any
// spelling of its URL, publish refused when the store can't be read,
// timeouts on Turnstile and Slack, and production without a database.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore, PgStore, applyEventEdits, resolveEditKey } from '../server/db.js';
import { createAutoPublish } from '../server/autopublish.js';
import { venueFor, buildVenues } from '../server/guides.js';
import { withPages, parseTimes } from '../server/seo.js';
import { createRateLimiter } from '../server/rateLimit.js';
import { verifyTurnstile } from '../server/turnstile.js';
import { createSlack } from '../server/slack.js';

// Wednesday, Oct 7 2026, 10:05 AM in Victoria.
const NOW = new Date('2026-10-07T15:05:00Z');
const SITE = 'https://www.thevic361.com';
const ADMIN = { Authorization: 'Bearer legacy-secret-token', 'Content-Type': 'application/json' };
const key = e => `${e.date}|${e.name}|${e.venue}`;
const settle = () => new Promise(r => setTimeout(r, 300));

let tmpDir, server, base;

function fakeSlack() {
  const s = { alerts: [], notes: [], enabled: true };
  s.alert = async (k, t, d) => { s.alerts.push({ k, t, d }); return true; };
  s.notify = async m => { s.notes.push(m); return true; };
  return s;
}

// A FileStore whose database "goes down" on demand.
function flakyStore(file) {
  const inner = new FileStore(file);
  const st = { down: false };
  const store = new Proxy(inner, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== 'function') return v;
      return (...args) => (st.down ? Promise.reject(new Error('connect ETIMEDOUT')) : v.apply(target, args));
    }
  });
  return { store, st };
}

async function start(opts = {}, { candidates = null, venues = null } = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-res-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ last_updated: '2026-05-11T00:00:00Z', events: [{ date: '2026-05-17', name: 'Old May Thing', venue: 'V' }] }));
  const candidatesFile = path.join(tmpDir, 'candidates.json');
  if (candidates) await fs.writeFile(candidatesFile, JSON.stringify(candidates));
  const venuesFile = path.join(tmpDir, 'venues.json');
  await fs.writeFile(venuesFile, JSON.stringify(venues || []));
  const flaky = flakyStore(path.join(tmpDir, 's.json'));
  const slack = fakeSlack();
  const out = await createApp({
    storeBundle: { kind: 'file', store: flaky.store }, eventsFile, candidatesFile, venuesFile, trustProxy: false,
    now: () => NOW, siteUrl: SITE, adminToken: 'legacy-secret-token', slack, startScheduler: false, autoPublish: false, ...opts
  });
  server = http.createServer(out.app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  return { ...out, slack, db: flaky.st };
}

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

const get = (p, headers = {}) => fetch(base + p, { headers: { Accept: 'text/html', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
const post = (p, body) => fetch(base + p, { method: 'POST', headers: ADMIN, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });

describe('auto-publish missed on boot', () => {
  it('is retried by the hourly site check', async () => {
    const ev = { date: '2026-10-09', name: 'Fresh Collect Event', venue: 'Plaza', time: '7:00 PM' };
    const out = await start({ autoPublish: true, autoPublishDelayMs: 100 }, { candidates: { last_updated: '2026-10-04T20:30:00-05:00', events: [ev] } });
    // The boot run hits the database blip...
    out.db.down = true;
    await new Promise(r => setTimeout(r, 300));
    expect(out.slack.alerts.some(a => a.k === 'auto-publish')).toBe(true);
    // ...and the next hourly check publishes once it's back.
    out.db.down = false;
    await out.scheduler.tick(NOW);
    const pub = await out.store.getPublished();
    expect((pub && pub.events || []).map(e => e.name)).toContain('Fresh Collect Event');
    expect(out.slack.notes.some(n => /caught up/.test(n.title))).toBe(true);
  });
});

describe('Postgres circuit breaker', () => {
  function hungPool(delayMs) {
    const calls = { n: 0 };
    return {
      calls,
      query: () => { calls.n++; return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout exceeded when trying to connect')), delayMs)); }
    };
  }

  it('fails fast after a timeout, probes once per window, and closes on success', async () => {
    let t = 1000;
    const pool = hungPool(200);
    const store = new PgStore(pool, { breaker: { windowMs: 30000, now: () => t } });
    let start = Date.now();
    await expect(store.getPublished()).rejects.toThrow(/timeout/);
    expect(Date.now() - start).toBeGreaterThanOrEqual(180);
    // Within the window: no waiting, no query.
    const before = pool.calls.n;
    start = Date.now();
    await expect(store.getPublished()).rejects.toThrow(/circuit open/);
    await expect(store.listEventEdits()).rejects.toThrow(/circuit open/);
    expect(Date.now() - start).toBeLessThan(150);
    expect(pool.calls.n).toBe(before);
    // After the window one probe goes through; it succeeds and closes it.
    t += 31000;
    pool.query = async () => { pool.calls.n++; return { rows: [] }; };
    await expect(store.getPublished()).resolves.toBe(null);
    await expect(store.getPublished()).resolves.toBe(null);
  });

  it('a bad query (SQLSTATE outside 08/53/57) does not trip it', async () => {
    let n = 0;
    const pool = { query: async () => { n++; throw Object.assign(new Error('duplicate key'), { code: '23505' }); } };
    const store = new PgStore(pool);
    await expect(store.getPublished()).rejects.toThrow(/duplicate key/);
    await expect(store.getPublished()).rejects.toThrow(/duplicate key/);
    expect(n).toBe(2);
  });
});

describe('a failed read serves the last good list, not the May bundle', () => {
  it('keeps this week on the site and uncached while the database is down', async () => {
    const { store, db } = await start();
    await store.setPublished({ last_updated: '2026-10-05T10:00:00Z', events: [{ date: '2026-10-09', name: 'Live Comedy', venue: 'La Cantina', time: '8:00 PM' }] });
    expect((await (await get('/events.json')).json()).events.map(e => e.name)).toEqual(['Live Comedy']);
    db.down = true;
    const feed = await get('/events.json');
    expect((await feed.json()).events.map(e => e.name)).toEqual(['Live Comedy']);
    const home = await get('/');
    expect(home.status).toBe(200);
    expect(home.headers.get('cache-control')).toBe('no-store');
    expect(await home.text()).toContain('Live Comedy');
  });
});

describe('event URLs that move or go away', () => {
  it('a renamed event 301s from its old page (admin edit and auto-publish rename)', async () => {
    await start();
    const jazz = { date: '2026-10-10', name: 'Jazz Nite', venue: 'La Cantina', time: '7:00 PM', description: 'Live jazz.' };
    expect((await post('/api/admin/publish-events', { events: [jazz] })).status).toBe(200);
    await settle();
    expect((await post('/api/admin/event-edits', { original_key: key(jazz), payload: { ...jazz, name: 'Jazz Night' } })).status).toBe(200);
    await settle();
    let r = await get('/events/2026-10-10-jazz-nite');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/events/2026-10-10-jazz-night');
    r = await get('/events/2026-10-10-jazz-nite.ics');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/events/2026-10-10-jazz-night.ics');

    // Auto-publish completing a cut-off name: same event, new key.
    const cut = { date: '2026-10-10', name: 'Quilt Guild of Greate', venue: 'Community Center', time: '9:00 AM' };
    await post('/api/admin/publish-events', { events: [jazz, cut] });
    await settle();
    await post('/api/admin/publish-events', { events: [jazz, { ...cut, name: 'Quilt Guild of Greater Victoria Show' }] });
    await settle();
    r = await get('/events/2026-10-10-quilt-guild-of-greate');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/events/2026-10-10-quilt-guild-of-greater-victoria-show');
  });

  it('a moved event redirect is not cached forever, so moving it back cannot loop', async () => {
    await start();
    const jazz = { date: '2026-10-10', name: 'Jazz Nite', venue: 'La Cantina', time: '7:00 PM', description: 'Live jazz.' };
    await post('/api/admin/publish-events', { events: [jazz] });
    await settle();
    await post('/api/admin/event-edits', { original_key: key(jazz), payload: { ...jazz, name: 'Jazz Night' } });
    await settle();
    for (const suffix of ['', '.ics', '.png']) {
      const r = await get(`/events/2026-10-10-jazz-nite${suffix}`);
      expect(r.status, suffix).toBe(301);
      expect(r.headers.get('cache-control'), suffix).toBe('no-cache');
    }
  });

  it('a removed event stays gone after its date and off the venue page', async () => {
    let now = NOW;
    await start({ now: () => now }, { venues: [{ name: 'Riverside Library', category: 'Library' }] });
    const spam = { date: '2026-10-10', name: 'Spam Fest', venue: 'Riverside Library', time: '7:00 PM' };
    const club = { date: '2026-10-10', name: 'Book Club', venue: 'Riverside Library', time: '6:00 PM' };
    await post('/api/admin/publish-events', { events: [spam, club] });
    await settle();
    await post('/api/admin/publish-events', { events: [club] });
    await settle();
    expect((await get('/events/2026-10-10-spam-fest')).status).toBe(410);
    now = new Date('2026-10-12T17:00:00Z');
    expect((await get('/events/2026-10-10-spam-fest')).status).toBe(410);
    expect((await get('/events/2026-10-10-book-club')).status).toBe(200);
    const venue = await (await get('/venues/riverside-library')).text();
    expect(venue).toContain('Book Club');
    expect(venue).not.toContain('Spam Fest');
  });
});

describe('editing an edited event', () => {
  it('the second correction shows on the live site and in admin', async () => {
    await start();
    const jazz = { date: '2026-10-10', name: 'Jazz Nite', venue: 'La Cantina', time: '7:00 PM', description: 'Live jazz.' };
    await post('/api/admin/publish-events', { events: [jazz] });
    await post('/api/admin/event-edits', { original_key: key(jazz), payload: { ...jazz, name: 'Jazz Night' } });
    // The admin only sees the edited row, so it sends the edited key.
    const r = await post('/api/admin/event-edits', { original_key: '2026-10-10|Jazz Night|La Cantina', payload: { ...jazz, name: 'Jazz Night', time: '8:00 PM' } });
    expect(r.status).toBe(200);
    const feed = await (await get('/events.json')).json();
    expect(feed.events.map(e => `${e.name} ${e.time}`)).toEqual(['Jazz Night 8:00 PM']);
    const admin = await (await fetch(base + '/api/admin/published-events', { headers: ADMIN })).json();
    expect(JSON.stringify(admin)).toContain('8:00 PM');
    expect(JSON.stringify(admin)).not.toContain('7:00 PM');
  });

  it('the second correction shows after a Save & Publish stored the edited shape', async () => {
    await start();
    const jazz = { date: '2026-10-10', name: 'Jazz Nite', venue: 'La Cantina', time: '7:00 PM', description: 'Live jazz.' };
    await post('/api/admin/publish-events', { events: [jazz] });
    await post('/api/admin/event-edits', { original_key: key(jazz), payload: { ...jazz, name: 'Jazz Night' } });
    // Save & Publish sends what the admin sees: the edited shape.
    await post('/api/admin/publish-events', { events: [{ ...jazz, name: 'Jazz Night' }] });
    const r = await post('/api/admin/event-edits', { original_key: '2026-10-10|Jazz Night|La Cantina', payload: { ...jazz, name: 'Jazz Night', time: '8:00 PM' } });
    expect(r.status).toBe(200);
    const feed = await (await get('/events.json')).json();
    expect(feed.events.map(e => `${e.name} ${e.time}`)).toEqual(['Jazz Night 8:00 PM']);
    const edits = [{ original_key: key(jazz), payload: { ...jazz, name: 'Jazz Night' } }];
    expect(resolveEditKey(edits, '2026-10-10|Jazz Night|La Cantina', new Set(['2026-10-10|Jazz Night|La Cantina']))).toBe('2026-10-10|Jazz Night|La Cantina');
    expect(resolveEditKey(edits, '2026-10-10|Jazz Night|La Cantina', new Set([key(jazz)]))).toBe(key(jazz));
  });

  it('rows already stored under an edited key still apply (chained)', () => {
    const raw = [{ date: '2026-10-10', name: 'Jazz Nite', venue: 'V', time: '7:00 PM' }];
    const edits = [
      { original_key: '2026-10-10|Jazz Nite|V', payload: { date: '2026-10-10', name: 'Jazz Night', venue: 'V', time: '7:00 PM' } },
      { original_key: '2026-10-10|Jazz Night|V', payload: { date: '2026-10-10', name: 'Jazz Night', venue: 'V', time: '8:00 PM' } }
    ];
    expect(applyEventEdits(raw, edits)[0].time).toBe('8:00 PM');
    expect(resolveEditKey(edits.slice(0, 1), '2026-10-10|Jazz Night|V')).toBe('2026-10-10|Jazz Nite|V');
    // A cycle doesn't loop.
    const cyc = [{ original_key: 'd|A|V', payload: { date: 'd', name: 'B', venue: 'V' } }, { original_key: 'd|B|V', payload: { date: 'd', name: 'A', venue: 'V' } }];
    expect(applyEventEdits([{ date: 'd', name: 'A', venue: 'V' }], cyc)).toHaveLength(1);
  });
});

describe('"Mark duplicate" on an approved submission the collector also lists', () => {
  it('leaves the listing up and lets auto-publish keep it', async () => {
    const trivia = { date: '2026-10-10', name: 'Trivia Night', venue: 'The Dive', time: '7:00 PM' };
    const { store } = await start({}, { candidates: { last_updated: '2026-10-04T20:30:00-05:00', events: [trivia] } });
    await store.setPublished({ last_updated: '2026-10-05T10:00:00Z', events: [{ ...trivia, submitted: true }], auto_publish: { keys: [key(trivia)], rejected: [] } });
    await store.insert({ id: 's1', status: 'approved', source: 'submission', created_at: NOW.toISOString(), updated_at: NOW.toISOString(), payload: trivia });
    const r = await post('/api/admin/submissions/s1', { status: 'duplicate' });
    expect(r.status).toBe(200);
    const pub = await store.getPublished();
    expect(pub.events.map(e => e.name)).toContain('Trivia Night');
    expect(pub.auto_publish.rejected).not.toContain(key(trivia));
  });
});

describe('an approved submission merged into a listed event under another name', () => {
  it('is not re-added after the admin removes that event', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-res-'));
    const store = new FileStore(path.join(tmpDir, 's.json'));
    const fest = { date: '2026-10-10', name: 'Fall Festival', venue: 'Riverside Park', time: '10:00 AM' };
    const sub = { date: '2026-10-10', name: 'Fall Festival Downtown', venue: 'Riverside Park', time: '10:00 AM' };
    const file = path.join(tmpDir, 'c.json');
    const read = async f => JSON.parse(await fs.readFile(f, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ last_updated: 'run-1', events: [fest] }));
    const ap = createAutoPublish({ store, candidatesFile: file, readJsonFile: read, nowFn: () => NOW });
    await ap.run();
    await store.insert({ id: 's1', status: 'approved', source: 'submission', created_at: NOW.toISOString(), updated_at: NOW.toISOString(), payload: sub });
    await ap.run({ force: true, quiet: true, submissionsOnly: true });
    expect((await store.getPublished()).events.map(e => e.name)).toEqual(['Fall Festival']);
    // The admin takes it down in Save & Publish (it was cancelled).
    const prior = await store.getPublished();
    await store.setPublished({ ...prior, events: [] });
    await fs.writeFile(file, JSON.stringify({ last_updated: 'run-2', events: [] }));
    await ap.run({ force: true, quiet: true, submissionsOnly: true });
    expect((await store.getPublished()).events).toEqual([]);
  });
});

describe('same-name pages are numbered the same whatever the order', () => {
  it('ties sort by time, then venue', () => {
    const a = { date: '2026-10-10', name: 'Bookish Society Book Club', venue: 'Vida Cafe', time: '6:00 PM – 7:00 PM' };
    const b = { date: '2026-10-10', name: 'Bookish Society Book Club', venue: 'Public Library', time: '6:00PM – 7:00PM' };
    const pageOf = (list, v) => list.find(e => e.venue === v).page;
    expect(pageOf(withPages([a, b]), 'Vida Cafe')).toBe(pageOf(withPages([b, a]), 'Vida Cafe'));
    expect(pageOf(withPages([a, b]), 'Public Library')).toBe('/events/2026-10-10-bookish-society-book-club');
  });

  it('a page already handed out stays with its event when a newcomer sorts first', () => {
    const a = { date: '2026-10-07', name: 'Pickleball Games', venue: 'Youth Sports Complex', time: '6:00 PM' };
    const b = { date: '2026-10-07', name: 'Pickleball Games', venue: 'Victoria Public Library', time: '6:00 PM' };
    const c = { date: '2026-10-07', name: 'Pickleball Games', venue: 'Adult Center', time: '6:00 PM' };
    const pageOf = (list, v) => list.find(e => e.venue === v).page;
    const out = withPages([{ ...a, _page: '/events/2026-10-07-pickleball-games' }, b, { ...c, _page: '/events/2026-10-07-pickleball-games-3' }]);
    expect(pageOf(out, 'Youth Sports Complex')).toBe('/events/2026-10-07-pickleball-games');
    expect(pageOf(out, 'Victoria Public Library')).toBe('/events/2026-10-07-pickleball-games-2');
    expect(pageOf(out, 'Adult Center')).toBe('/events/2026-10-07-pickleball-games-3');
    expect(out.some(e => '_page' in e)).toBe(false);
    // A reservation for another base (renamed) is ignored.
    expect(pageOf(withPages([{ ...b, _page: '/events/2026-10-07-pickle' }, a]), 'Victoria Public Library')).toBe('/events/2026-10-07-pickleball-games');
  });

  it('keeps the first event on its URL across publishes, end to end', async () => {
    await start();
    const a = { date: '2026-10-10', name: 'Pickleball Games', venue: 'Youth Sports Complex', time: '6:00 PM' };
    const b = { date: '2026-10-10', name: 'Pickleball Games', venue: 'Victoria Public Library', time: '6:00 PM' };
    await post('/api/admin/publish-events', { events: [a] });
    await settle();
    await post('/api/admin/publish-events', { events: [a, b] });
    await settle();
    const live = (await (await get('/events.json', { Accept: 'application/json' })).json()).events;
    expect(live.find(e => e.venue === 'Youth Sports Complex').page).toBe('/events/2026-10-10-pickleball-games');
    expect(live.find(e => e.venue === 'Victoria Public Library').page).toBe('/events/2026-10-10-pickleball-games-2');
    const page = await (await get('/events/2026-10-10-pickleball-games')).text();
    expect(page).toContain('Youth Sports Complex');
  });
});

describe('a time range sharing one am/pm', () => {
  it('starts at the bare leading time', () => {
    expect(parseTimes('7-9 PM')).toEqual(['19:00', '21:00']);
    expect(parseTimes('7:30 – 9:30pm')).toEqual(['19:30', '21:30']);
    expect(parseTimes('11-1 PM')).toEqual(['11:00', '13:00']);
    expect(parseTimes('10am - 3pm')).toEqual(['10:00', '15:00']);
    expect(parseTimes('Doors 6 PM, show 7-9 PM')[0]).toBe('18:00');
  });
});

describe('venueFor', () => {
  it('scans the venue list once per venue string, not once per event', () => {
    const list = buildVenues(Array.from({ length: 80 }, (_, i) => ({ name: `Venue Number ${i} Hall`, category: 'Bar' })));
    let reads = 0;
    const venues = new Proxy(list, { get(t, p, r) { if (typeof p === 'string' && /^\d+$/.test(p)) reads++; return Reflect.get(t, p, r); } });
    for (let i = 0; i < 1000; i++) venueFor({ venue: 'Venue Number 79 Hall' }, venues);
    expect(venueFor({ venue: 'Venue Number 79 Hall' }, venues).name).toBe('Venue Number 79 Hall');
    expect(reads).toBeLessThan(500);
  });
});

describe('public rate limits key IPv6 on the /64', () => {
  it('rotating addresses inside one /64 shares one budget', () => {
    const l = createRateLimiter({ windowMs: 60000, max: 5 });
    for (let i = 1; i <= 5; i++) expect(l.check(`2001:db8:1:2::${i}`).ok).toBe(true);
    expect(l.check('2001:db8:1:2::99').ok).toBe(false);
    expect(l.check('2001:db8:1:3::1').ok).toBe(true);
    // Non-address keys are untouched.
    expect(l.check('someone@example.com').ok).toBe(true);
  });
});

describe('admin CSP', () => {
  it('applies to every spelling of the admin URL', async () => {
    await start();
    for (const p of ['/admin.html', '/admin', '/admin%2Ehtml', '/%61dmin.html']) {
      const r = await get(p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get('content-security-policy'), p).toMatch(/script-src/);
    }
  });
});

describe('Save & Publish when the store cannot be read', () => {
  it('answers 503 and writes nothing', async () => {
    const { store, db } = await start();
    await store.setPublished({ last_updated: '2026-10-05T10:00:00Z', events: [], hidden: [{ key: 'k' }] });
    db.down = true;
    const r = await post('/api/admin/publish-events', { events: [{ date: '2026-10-10', name: 'X', venue: 'V' }] });
    expect(r.status).toBe(503);
    db.down = false;
    expect((await store.getPublished()).hidden).toEqual([{ key: 'k' }]);
  });
});

describe('outbound calls have timeouts', () => {
  // Never answers; only an abort signal ends it.
  const hanging = (_u, init = {}) => new Promise((_, reject) => {
    if (init.signal) init.signal.addEventListener('abort', () => reject(init.signal.reason || new Error('aborted')));
  });
  const within = (p, ms = 1000) => Promise.race([p, new Promise(r => setTimeout(() => r('still hanging'), ms))]);

  it('Turnstile answers network-error instead of hanging', async () => {
    const r = await within(verifyTurnstile('tok', { secret: 's', fetch: hanging, timeoutMs: 50 }));
    expect(r).toMatchObject({ ok: false, error: 'network-error' });
  });

  it('a Slack post gives up', async () => {
    const s = createSlack({ enabled: true, url: 'https://hooks.slack.com/services/T/B/x' }, { fetchImpl: hanging, timeoutMs: 50 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await within(s.post('hi'))).toBe(false);
  });
});

describe('production without a database', () => {
  it('fails the deep health check and alerts', async () => {
    const out = await start({ railwayEnvironment: 'production' });
    expect((await fetch(base + '/api/health')).status).toBe(200);
    const deep = await fetch(base + '/api/health?deep=1');
    expect(deep.status).toBe(503);
    expect((await deep.json()).error).toBe('no-database');
    expect(out.slack.alerts.some(a => a.k === 'db-missing')).toBe(true);
    await out.scheduler.tick(NOW);
    expect(out.slack.alerts.some(a => /without its database/.test(a.d))).toBe(true);
  });
});
