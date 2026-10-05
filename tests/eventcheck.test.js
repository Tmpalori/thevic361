// @vitest-environment node
//
// Events hidden by the event check (server/eventcheck.js): the secret-only
// hide endpoint, filtering everywhere public, and restoring from admin.

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = new Date('2026-10-05T17:00:00Z'); // Mon Oct 5, noon CDT
const EVENTS = [
  { date: '2026-10-06', name: 'Taco Tuesday', time: '5:00 PM', venue: 'Weber Brewing' },
  { date: '2026-10-07', name: 'Parish Fall Festival', time: '6:00 PM', venue: "St. Mary's Church" },
  { date: '2026-10-08', name: 'Open Mic Night', time: '7:00 PM', venue: 'Aero Crafters' },
  { date: '2026-10-01', name: 'Last Week Thing', time: '7:00 PM', venue: 'Somewhere' }
];
const CHURCH = '/events/2026-10-07-parish-fall-festival';

let tmpDir, server, baseUrl, store;

async function startApp(extra = {}, { events = EVENTS, now = NOW, keepStore = false, bundled = { events: [] } } = {}) {
  if (!keepStore) {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-check-'));
    store = new FileStore(path.join(tmpDir, 's.json'));
    await store.setPublished({ last_updated: 'x', events, sponsor: null });
  }
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify(bundled));
  const { app } = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => now,
    siteUrl: 'https://www.thevic361.com', eventCheckSecret: 'check-secret', autoPublish: false,
    adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c', ...extra
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

const post = (p, body, headers = {}) => fetch(baseUrl + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
});
const hide = (list, secret = 'check-secret') => post('/api/event-check/hide', { hide: list }, { 'X-Cron-Secret': secret });
const names = async () => (await (await fetch(baseUrl + '/events.json')).json()).events.map(e => e.name);
async function auth() {
  const r = await post('/api/admin/login', { username: 'a', password: 'b' });
  return { Authorization: `Bearer ${(await r.json()).token}` };
}

describe('event check: hiding', () => {
  it('needs the secret', async () => {
    await startApp();
    expect((await hide([{ page: CHURCH }], 'wrong')).status).toBe(401);
    expect((await hide([{ page: CHURCH }], '')).status).toBe(401);
    expect(await names()).toContain('Parish Fall Festival');
  });

  it('is closed when no secret is configured', async () => {
    await startApp({ eventCheckSecret: '' });
    expect((await hide([{ page: CHURCH }], '')).status).toBe(401);
  });

  it('takes a hidden event off every public surface, without deleting it', async () => {
    await startApp();
    const r = await hide([{ page: CHURCH, reason: 'religious / church event: church event' }]);
    expect(r.status).toBe(200);
    expect((await r.json()).hidden.map(h => h.page)).toEqual([CHURCH]);

    const feed = await (await fetch(baseUrl + '/events.json')).json();
    expect(feed.events.map(e => e.name)).not.toContain('Parish Fall Festival');
    expect(feed).not.toHaveProperty('hidden');
    expect(feed.events.map(e => e.name)).toContain('Taco Tuesday');
    expect((await fetch(baseUrl + CHURCH)).status).toBe(404);
    expect(await (await fetch(baseUrl + '/')).text()).not.toContain('Parish Fall Festival');
    expect(await (await fetch(baseUrl + '/sitemap.xml')).text()).not.toContain('parish-fall-festival');
    // Still published, so a restore brings it straight back.
    expect((await store.getPublished()).events.map(e => e.name)).toContain('Parish Fall Festival');
  });

  it('only hides live upcoming events, and refuses a suspiciously big batch', async () => {
    await startApp();
    const out = await (await hide([
      { page: '/events/2026-10-01-last-week-thing' }, { page: '/events/nope' }, { page: 'javascript:alert(1)' }
    ])).json();
    expect(out.hidden).toEqual([]);
    expect(out.skipped.map(s => s.why)).toEqual(['not-live', 'not-live', 'not-live']);

    // Repeats of one event are one hide, not eleven.
    const same = await hide(Array.from({ length: 11 }, () => ({ page: CHURCH })));
    expect(same.status).toBe(200);
  });

  it('refuses a suspiciously big batch, counting only what it would hide', async () => {
    const many = Array.from({ length: 11 }, (_, n) => ({ date: '2026-10-09', name: `Thing ${n}`, venue: 'Hall' }));
    await startApp({}, { events: many });
    const pages = (await (await fetch(baseUrl + '/events.json')).json()).events.map(e => ({ page: e.page }));
    const r = await hide(pages);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('too-many');
    expect((await names())).toHaveLength(11);
  });

  it('survives the admin Save & Publish', async () => {
    await startApp();
    await hide([{ page: CHURCH }]);
    const h = await auth();
    const pub = await post('/api/admin/publish-events', { events: EVENTS }, h);
    expect(pub.status).toBe(200);
    expect(await names()).not.toContain('Parish Fall Festival');
  });
});

describe('event check: restoring', () => {
  it('admin lists hidden events, restores one, and the check leaves it alone after', async () => {
    await startApp();
    await hide([{ page: CHURCH, reason: 'church event' }]);
    const h = await auth();
    const list = await (await fetch(baseUrl + '/api/admin/hidden', { headers: h })).json();
    expect(list.hidden).toMatchObject([{ page: CHURCH, name: 'Parish Fall Festival', date: '2026-10-07', reason: 'church event' }]);
    expect(list.hidden[0].key).toBe("2026-10-07|Parish Fall Festival|St. Mary's Church");

    expect((await fetch(baseUrl + '/api/admin/hidden')).status).toBe(401);
    const r = await post('/api/admin/hidden/restore', { key: list.hidden[0].key }, h);
    expect(r.status).toBe(200);
    expect(await names()).toContain('Parish Fall Festival');

    const again = await (await hide([{ page: CHURCH }])).json();
    expect(again.hidden).toEqual([]);
    expect(again.skipped).toEqual([{ page: CHURCH, why: 'restored-by-admin' }]);
    expect(await names()).toContain('Parish Fall Festival');
  });

  it('restoring something that is not hidden is a 404', async () => {
    await startApp();
    const r = await post('/api/admin/hidden/restore', { key: "2026-10-07|Parish Fall Festival|St. Mary's Church" }, await auth());
    expect(r.status).toBe(404);
  });
});

describe('event check: identity, not page URL', () => {
  const BINGO = [
    { date: '2026-10-09', name: 'Bingo', time: '5:00 PM', venue: 'VFW Post 4146' },
    { date: '2026-10-09', name: 'Bingo', time: '7:00 PM', venue: "St. Mary's Church" }
  ];
  const visible = async () => (await (await fetch(baseUrl + '/events.json')).json()).events.map(e => `${e.venue}@${e.page}`);

  it('hiding one same-named event never moves to another when the list changes', async () => {
    await startApp({}, { events: BINGO });
    expect(await visible()).toEqual(['VFW Post 4146@/events/2026-10-09-bingo', "St. Mary's Church@/events/2026-10-09-bingo-2"]);
    await hide([{ page: '/events/2026-10-09-bingo-2' }]);
    expect(await visible()).toEqual(['VFW Post 4146@/events/2026-10-09-bingo']);
    // An earlier Bingo is published: slugs renumber, the church one stays hidden.
    await store.setPublished({ ...(await store.getPublished()),
      events: [{ date: '2026-10-09', name: 'Bingo', time: '3:00 PM', venue: 'Elks Lodge' }, ...BINGO] });
    const now = await visible();
    expect(now.map(v => v.split('@')[0])).toEqual(['Elks Lodge', 'VFW Post 4146']);
  });

  it('renaming a hidden event in the admin keeps it hidden', async () => {
    await startApp();
    await hide([{ page: CHURCH }]);
    const h = await auth();
    const r = await post('/api/admin/event-edits', {
      original_key: "2026-10-07|Parish Fall Festival|St. Mary's Church",
      payload: { ...EVENTS[1], name: 'Parish Fall Festival Night', description: 'Games, food and a cake walk.' }
    }, h);
    expect(r.status).toBeLessThan(300);
    expect(await names()).not.toContain('Parish Fall Festival Night');
    expect(await names()).not.toContain('Parish Fall Festival');
  });

  it('a hidden event stays hidden after its date passes, archive included', async () => {
    await startApp();
    await hide([{ page: CHURCH }]);
    await new Promise(r => server.close(r)); server = null;
    // Two days later, another hide runs (it used to prune past entries).
    await startApp({}, { keepStore: true, now: new Date('2026-10-09T17:00:00Z') });
    await hide([{ page: '/events/2026-10-12-nothing' }]);
    expect((await fetch(baseUrl + CHURCH)).status).toBe(404);
    expect((await store.getPublished()).hidden.map(h => h.page)).toContain(CHURCH);
  });

  it('the bundled backup copy honors the hidden list too', async () => {
    await startApp({}, { bundled: { events: EVENTS, hidden: [{ key: "2026-10-07|Parish Fall Festival|St. Mary's Church", date: '2026-10-07' }] } });
    await store.setPublished(null);
    expect(await names()).not.toContain('Parish Fall Festival');
    expect(await names()).toContain('Taco Tuesday');
  });
});

