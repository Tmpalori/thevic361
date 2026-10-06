// @vitest-environment node
//
// Server hardening: a database that restarts, hangs or throws must not take
// the site down or leave requests hanging; client errors aren't outages;
// Save & Publish fits a big week; archive and traffic reads stay bounded;
// keys with '|' in a name; the admin login and legacy token are throttled.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
// Namespace imports, so a missing helper fails its own test, not the file.
import * as db from '../server/db.js';
import { summarize } from '../server/analytics.js';
import { activeSeasons, renderIcs } from '../server/guides.js';
import { parseTimes } from '../server/seo.js';
import { visibleKeyed } from '../server/eventcheck.js';
import { createAutoPublish } from '../server/autopublish.js';
import * as rateLimit from '../server/rateLimit.js';

// Wednesday, Oct 7 2026, noon in Victoria.
const NOW = new Date('2026-10-07T17:00:00Z');
const SITE = 'https://www.thevic361.com';
const { FileStore, PgStore, createStore } = db;
const parseEventKey = (...a) => db.parseEventKey(...a);
const toJsonb = (...a) => db.toJsonb(...a);
const ipKey = (...a) => rateLimit.ipKey(...a);
const LIVE = [
  { date: '2026-10-09', name: 'Next Stop Comedy', time: '8:00 PM', venue: 'La Cantina', icons: ['arts'] }
];

let tmpDir, server, baseUrl, bundle;

function recordingSlack() {
  return { enabled: true, alert: vi.fn(async () => true), notify: vi.fn(async () => true), post: vi.fn(async () => true) };
}

async function startApp(opts = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-hard-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ last_updated: '2026-10-05T03:00:00-05:00', events: LIVE }));
  const storeBundle = opts.storeBundle || { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) };
  bundle = await createApp({
    eventsFile, trustProxy: false, now: () => NOW, siteUrl: SITE, adminToken: 'legacy-secret-token',
    autoPublish: false, ...opts, storeBundle
  });
  server = http.createServer(bundle.app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return bundle;
}

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null; bundle = null;
});

async function req(method, p, { body, raw, headers = {}, timeoutMs = 3000 } = {}) {
  const init = { method, headers: { ...headers }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) };
  if (raw !== undefined) { init.body = raw; init.headers['Content-Type'] = 'application/json'; }
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(baseUrl + p, init);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
}

const ADMIN = { Authorization: 'Bearer legacy-secret-token' };

// A pool stand-in: records every query, answers with no rows.
function fakePool() {
  const calls = [];
  return { calls, query: async (text, params) => { calls.push({ text: String(text), params: params || [] }); return { rows: [] }; } };
}

describe('Postgres pool survives a database restart or outage', () => {
  it('boots when the database is unreachable, with an error listener and timeouts on the pool', async () => {
    const onUnavailable = vi.fn();
    const b = await createStore({ databaseUrl: 'postgres://u:p@127.0.0.1:1/db?sslmode=disable', onUnavailable });
    try {
      expect(b.kind).toBe('postgres');
      expect(onUnavailable).toHaveBeenCalledTimes(1);
      expect(b.pool.listenerCount('error')).toBeGreaterThan(0);
      expect(b.pool.options.connectionTimeoutMillis).toBeGreaterThan(0);
      expect(b.pool.options.query_timeout).toBeGreaterThan(0);
      expect(b.pool.options.statement_timeout).toBeGreaterThan(0);
      // An idle client dying must not throw out of the pool.
      expect(() => b.pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
    } finally {
      await b.pool.end();
    }
  });
});

describe('async handlers answer when the store throws', () => {
  function brokenStore() {
    const store = new FileStore(path.join(os.tmpdir(), `vic361-broken-${process.pid}-${Date.now()}.json`));
    const boom = async () => { throw new Error('connection terminated'); };
    store.list = boom;
    store.findDuplicate = boom;
    return { kind: 'file', store };
  }

  it('GET /api/admin/submissions returns 500 JSON instead of hanging', async () => {
    await startApp({ storeBundle: brokenStore(), slack: recordingSlack() });
    const r = await req('GET', '/api/admin/submissions', { headers: ADMIN });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ ok: false, error: 'server-error' });
  });

  it('POST /api/submissions returns 500 JSON instead of hanging', async () => {
    await startApp({ storeBundle: brokenStore(), slack: recordingSlack() });
    const r = await req('POST', '/api/submissions', { body: {
      name: 'Live Music at the Dive', date: '2026-10-20', time: '7:00 PM', end_time: '10:00 PM', venue: 'The Dive Bar',
      address: '123 Main St', url: 'https://example.com/event', description: 'A test event description.',
      icons: ['music'], free: false, submitter_kind: 'organizer', submitter_first_name: 'Jane', submitter_last_name: 'Tester',
      submitter_name: 'Jane Tester', submitter_email: 'jane@example.com', submitter_phone: '(361) 555-0123', elapsed_ms: 5000
    } });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ ok: false, error: 'server-error' });
  });
});

describe('client errors are not site errors', () => {
  it('bad %-escapes and malformed JSON get 4xx and no Slack alert', async () => {
    const slack = recordingSlack();
    await startApp({ slack });
    expect((await req('GET', '/events/%E0%A4%A')).status).toBe(400);
    expect((await req('GET', '/venues/%zz', { headers: { Accept: 'text/html' } })).status).toBe(400);
    const sub = await req('POST', '/api/submissions', { raw: '{bad' });
    expect(sub.status).toBe(400);
    expect(sub.json).toEqual({ ok: false, error: 'bad-json' });
    expect((await req('POST', '/api/subscribe', { raw: '{bad' })).status).toBe(400);
    expect(slack.alert).not.toHaveBeenCalled();
  });
});

describe('Save & Publish fits a big week', () => {
  it('publishes 300 typical events (well over 64 KB)', async () => {
    await startApp({ slack: recordingSlack() });
    const events = Array.from({ length: 300 }, (_, i) => ({
      date: `2026-10-${String(8 + (i % 20)).padStart(2, '0')}`,
      name: `Community Event Number ${i}`, time: '7:00 PM', end_time: '9:00 PM', venue: 'Downtown Victoria Plaza',
      address: '101 N Main St, Victoria, TX 77901', url: `https://example.com/events/${i}`,
      description: 'A typical description of an event in Victoria with enough words to look like the real thing on the site.',
      icons: ['music', 'food'], free: i % 2 === 0
    }));
    const body = JSON.stringify({ events });
    expect(body.length).toBeGreaterThan(64 * 1024);
    const r = await req('POST', '/api/admin/publish-events', { raw: body, headers: ADMIN });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
  });
});

describe('JSONB writes drop U+0000', () => {
  it('strips NUL from strings before Postgres sees them', async () => {
    expect(toJsonb({ a: 'x\u0000y', b: ['\u0000'] })).toBe('{"a":"xy","b":[""]}');
    expect(toJsonb({ a: 'back\\slash' })).toBe(JSON.stringify({ a: 'back\\slash' }));
    const pool = fakePool();
    const store = new PgStore(pool);
    await store.setPublished({ events: [{ name: 'Bad\u0000Name', description: 'x\u0000' }] });
    await store.archiveEvents([{ page: '/events/2026-10-09-x', date: '2026-10-09', name: 'N\u0000' }]);
    await store.upsertEventEdit({ original_key: 'k', payload: { name: 'a\u0000' } }).catch(() => {});
    const written = pool.calls.flatMap(c => c.params).filter(p => typeof p === 'string');
    expect(written.some(p => p.includes('Bad'))).toBe(true);
    for (const p of written) {
      expect(p).not.toContain('\\u0000');
      expect(p).not.toContain('\u0000');
    }
  });
});

describe('JSONB writes replace lone UTF-16 surrogates', () => {
  it('turns a cut-off emoji into U+FFFD and keeps whole ones', async () => {
    const out = toJsonb({ hi: 'Party \ud83d', lo: ['\ude00 time'], ok: 'Fun \ud83c\udf89', mixed: 'a\u0000\ud83d' });
    expect(out).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    expect(JSON.parse(out)).toEqual({ hi: 'Party \ufffd', lo: ['\ufffd time'], ok: 'Fun \ud83c\udf89', mixed: 'a\ufffd' });
    const pool = fakePool();
    await new PgStore(pool).setPublished({ events: [{ name: 'Cut \ud83d', description: 'x' }] });
    for (const p of pool.calls.flatMap(c => c.params).filter(p => typeof p === 'string')) {
      expect(p).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    }
  });
});

describe('traffic summary stays cheap for a year', () => {
  it('weighs pre-grouped rows (n) the same as raw rows', () => {
    const raw = [];
    for (let i = 0; i < 5; i++) raw.push({ day: '2026-10-06', kind: 'view', path: '/', visitor: 'v1', ref_source: 'Google' });
    raw.push({ day: '2026-10-07', kind: 'view', path: '/today', visitor: 'v2', ref_source: 'ChatGPT' });
    for (let i = 0; i < 3; i++) raw.push({ day: '2026-10-07', kind: 'crawl', path: '/', bot: 'GPTBot' });
    raw.push({ day: '2026-10-07', kind: 'click', click_type: 'event_click', click_url: 'https://x', visitor: 'v2' });
    const grouped = [
      { day: '2026-10-06', kind: 'view', path: '/', visitor: 'v1', ref_source: 'Google', n: 5 },
      { day: '2026-10-07', kind: 'view', path: '/today', visitor: 'v2', ref_source: 'ChatGPT', n: 1 },
      { day: '2026-10-07', kind: 'crawl', path: '/', bot: 'GPTBot', n: 3 },
      { day: '2026-10-07', kind: 'click', click_type: 'event_click', click_url: 'https://x', visitor: 'v2', n: 1 }
    ];
    const a = summarize(raw, { now: NOW, days: 365 });
    const b = summarize(grouped, { now: NOW, days: 365 });
    expect({ ...b, generated_at: null }).toEqual({ ...a, generated_at: null });
    expect(b.totals.week.views).toBe(6);
  });

  it('PgStore groups traffic rows in SQL', async () => {
    const pool = fakePool();
    await new PgStore(pool).listTraffic('2025-10-01');
    const q = pool.calls[pool.calls.length - 1].text;
    expect(q).toMatch(/GROUP BY/i);
    expect(q).toMatch(/COUNT\(\*\)/i);
  });
});

describe('the event archive stays bounded', () => {
  it('activeSeasons reads only the live list', () => {
    const archive = new Proxy([], { get() { throw new Error('archive read'); } });
    const live = [{ date: '2026-10-24', name: 'Downtown Trunk or Treat', page: '/events/2026-10-24-downtown-trunk-or-treat' }];
    const seasons = activeSeasons(live, archive, NOW);
    expect(seasons.map(s => s.path)).toContain('/halloween-events');
  });

  it('PgStore reads only recent archive rows and prunes old ones on write', async () => {
    const pool = fakePool();
    const store = new PgStore(pool);
    await store.listArchivedEvents();
    expect(pool.calls[pool.calls.length - 1].text).toMatch(/WHERE[\s\S]*event_date >= CURRENT_DATE/);
    await store.archiveEvents([{ page: '/events/2026-10-09-x', date: '2026-10-09' }]);
    expect(pool.calls.some(c => /DELETE FROM event_archive/.test(c.text))).toBe(true);
  });

  it('FileStore drops archive rows past retention', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-arch-'));
    try {
      const store = new FileStore(path.join(dir, 's.json'));
      const old = new Date(Date.now() - 500 * 86400000).toISOString().slice(0, 10);
      const recent = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      await store.archiveEvents([{ page: '/events/old', date: old }, { page: '/events/recent', date: recent }]);
      expect((await store.listArchivedEvents()).map(e => e.page)).toEqual(['/events/recent']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('an upcoming event that is only in the archive is gone', () => {
  it('410s the page, card and calendar file; past archived pages still load', async () => {
    const { store } = await startApp({ slack: recordingSlack() });
    await store.setPublished({ last_updated: '2026-10-05', events: LIVE });
    await store.archiveEvents([
      { date: '2026-10-20', name: 'Spam Fest', time: '7 PM', venue: 'Nowhere', page: '/events/2026-10-20-spam-fest' },
      { date: '2026-09-20', name: 'Old Fair', time: '7 PM', venue: 'Fairgrounds', page: '/events/2026-09-20-old-fair' }
    ]);
    expect((await req('GET', '/events/2026-10-20-spam-fest', { headers: { Accept: 'text/html' } })).status).toBe(410);
    expect((await req('GET', '/events/2026-10-20-spam-fest.ics')).status).toBe(410);
    expect((await req('GET', '/events/2026-10-20-spam-fest.png')).status).toBe(410);
    const past = await req('GET', '/events/2026-09-20-old-fair', { headers: { Accept: 'text/html' } });
    expect(past.status).toBe(200);
    expect(past.text).toContain('Old Fair');
  });
});

describe("event keys whose name contains '|'", () => {
  const KEY = '2026-10-09|Foodies + New Friends: Victoria | Dinner Meetup (DUOS EDITION)|La Cantina';

  it('parses the date at the first | and the venue at the last', () => {
    expect(parseEventKey(KEY)).toEqual({ date: '2026-10-09', name: 'Foodies + New Friends: Victoria | Dinner Meetup (DUOS EDITION)', venue: 'La Cantina' });
    expect(parseEventKey('2026-10-09|only-two')).toBe(null);
    expect(parseEventKey('nope|a|b')).toBe(null);
  });

  it('edit and Show anyway accept them', async () => {
    const { store } = await startApp({ slack: recordingSlack() });
    await store.setPublished({ last_updated: '2026-10-05', events: LIVE });
    const edit = await req('POST', '/api/admin/event-edits', { headers: ADMIN, body: {
      original_key: KEY,
      payload: { date: '2026-10-09', name: 'Foodies + New Friends: Victoria | Dinner Meetup', time: '7:00 PM', venue: 'La Cantina', description: 'Dinner with new friends.' }
    } });
    expect(edit.status).toBe(200);
    const keep = await req('POST', '/api/admin/keep-event', { headers: ADMIN, body: { key: KEY, keep: true } });
    expect(keep.status).toBe(200);
    expect((await store.getPublished()).kept).toContain(KEY);
  });
});

describe('a hidden event stays hidden after its edit is published', () => {
  it('visibleKeyed matches the hidden entry by its shown key too', () => {
    const published = {
      events: [{ date: '2026-10-09', name: 'Bingo Night', venue: 'Hall' }],
      hidden: [{ key: '2026-10-09|Bingo Nite|Hall', shown_key: '2026-10-09|Bingo Night|Hall', page: '/events/2026-10-09-bingo-night', date: '2026-10-09' }]
    };
    expect(visibleKeyed(published, [])).toEqual([]);
  });

  it('restore remembers the shown key so the check does not hide it again', async () => {
    const { store } = await startApp({ slack: recordingSlack() });
    await store.setPublished({ events: [], hidden: [{ key: '2026-10-09|Bingo Nite|Hall', shown_key: '2026-10-09|Bingo Night|Hall', date: '2026-10-09' }] });
    const r = await req('POST', '/api/admin/hidden/restore', { headers: ADMIN, body: { key: '2026-10-09|Bingo Nite|Hall' } });
    expect(r.status).toBe(200);
    expect((await store.getPublished()).hidden_restored).toEqual(expect.arrayContaining(['2026-10-09|Bingo Nite|Hall', '2026-10-09|Bingo Night|Hall']));
  });
});

describe('submissions-only auto-publish on an empty store', () => {
  it('refuses instead of replacing the bundled list with the submissions', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-ap-'));
    try {
      const store = new FileStore(path.join(dir, 's.json'));
      await store.insert({ id: 'a', status: 'approved', source: 'submission', created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z',
        payload: { date: '2026-10-20', name: 'Approved Thing', time: '7 PM', venue: 'Hall' }, review_history: [] });
      const ap = createAutoPublish({ store, candidatesFile: path.join(dir, 'none.json'), readJsonFile: async () => { throw new Error('none'); }, nowFn: () => NOW, siteUrl: SITE });
      const r = await ap.run({ force: true, quiet: true, submissionsOnly: true });
      expect(r.ok).toBe(false);
      expect(await store.getPublished()).toBe(null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('impossible times', () => {
  it("parseTimes skips '7:75 PM' and the calendar file still renders", () => {
    expect(parseTimes('7:75 PM')).toEqual([]);
    expect(parseTimes('13pm - 9:00 PM')).toEqual(['21:00']);
    const ev = { date: '2026-10-09', name: 'X', time: '7:75 PM', venue: 'Hall', page: '/events/2026-10-09-x' };
    expect(() => renderIcs(ev, { siteUrl: SITE, now: NOW })).not.toThrow();
  });
});

describe('long words wrap on phones', () => {
  it('style.css lets the main content break long tokens', () => {
    const css = readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'docs', 'style.css'), 'utf8');
    const rule = css.match(/\.main-content\s*\{[^}]*\}/)[0];
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('admin sign-in throttling', () => {
  const login = (ip, password = 'wrong') => req('POST', '/api/admin/login', {
    headers: { 'X-Forwarded-For': ip }, body: { username: 'tristen', password }
  });
  const loginOpts = () => ({
    trustProxy: 1, adminUsername: 'tristen', adminPassword: 'correct horse battery staple',
    adminSessionSecret: 'test-secret-key-deadbeef', slack: recordingSlack()
  });

  it('keys IPv6 on the /64', () => {
    expect(ipKey('2001:db8:1:2::5')).toBe(ipKey('2001:0db8:0001:0002:ffff:ffff:ffff:1'));
    expect(ipKey('2001:db8:1:2::5')).not.toBe(ipKey('2001:db8:1:3::5'));
    expect(ipKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
  });

  it('one /64 shares a login budget', async () => {
    await startApp(loginOpts());
    for (let i = 1; i <= 10; i++) expect((await login(`2001:db8:1:2::${i.toString(16)}`)).status).toBe(401);
    expect((await login('2001:db8:1:2::ff')).status).toBe(429);
  });

  it('alerts Slack on failed logins from many addresses, without locking the owner out', async () => {
    const b = await startApp(loginOpts());
    for (let i = 0; i < 100; i++) await login(`10.0.${Math.floor(i / 200)}.${i % 200}`);
    expect((await login('10.9.9.9', 'correct horse battery staple')).status).toBe(200);
    const floods = b.slack.alert.mock.calls.filter(c => c[0] === 'admin-auth-flood');
    expect(floods.length).toBeGreaterThan(0);
  });

  it('throttles wrong legacy ADMIN_TOKEN guesses', async () => {
    await startApp(loginOpts());
    for (let i = 0; i < 20; i++) {
      expect((await req('GET', '/api/admin/submissions', { headers: { Authorization: `Bearer guess-${i}`, 'X-Forwarded-For': '10.1.1.1' } })).status).toBe(401);
    }
    const r = await req('GET', '/api/admin/submissions', { headers: { ...ADMIN, 'X-Forwarded-For': '10.1.1.1' } });
    expect(r.status).toBe(429);
    // Another client with the right token is fine.
    expect((await req('GET', '/api/admin/submissions', { headers: { ...ADMIN, 'X-Forwarded-For': '10.2.2.2' } })).status).toBe(200);
  });
});
