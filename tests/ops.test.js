// @vitest-environment node
//
// Keeping the site honest when something breaks: database health and the
// fallback-feed alert, async routes answering 500 instead of hanging, the
// pg pool error listener, contact messages kept in the database,
// auto-publish problems as alerts, the newsletter's one autosend switch,
// collected_at on /events.json, and the setup checklist. Slack, email and
// GitHub are fakes.

import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createApp } from '../server/index.js';
import { FileStore, watchPool } from '../server/db.js';
import { createAutoPublish } from '../server/autopublish.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = new Date('2026-10-05T15:00:00Z');
let tmpDir, server, base, store, slack;

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
  const proxy = new Proxy(inner, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== 'function') return v;
      return (...args) => {
        if (st.down && ['getPublished', 'list', 'insert', 'findDuplicate', 'get'].includes(prop)) {
          return Promise.reject(new Error('connect ECONNREFUSED'));
        }
        return v.apply(target, args);
      };
    }
  });
  return { store: proxy, st };
}

async function start(extra = {}, { candidates = null } = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-ops-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ last_updated: '2026-05-11T00:00:00Z', events: [{ date: '2026-05-17', name: 'Old', venue: 'V' }] }));
  const candidatesFile = path.join(tmpDir, 'candidates.json');
  if (candidates) await fs.writeFile(candidatesFile, JSON.stringify(candidates));
  const flaky = flakyStore(path.join(tmpDir, 's.json'));
  store = flaky.store;
  slack = fakeSlack();
  const out = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, candidatesFile, trustProxy: false, now: () => NOW,
    siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c',
    slack, startScheduler: false, ...extra
  });
  server = http.createServer(out.app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  return flaky.st;
}

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

async function auth() {
  const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'b' }) });
  return { Authorization: `Bearer ${(await r.json()).token}`, 'Content-Type': 'application/json' };
}

describe('database down', () => {
  it('plain health stays up (deploys never fail on a db blip), the fallback feed alerts, and async routes answer 500 instead of hanging', async () => {
    const db = await start();
    expect((await fetch(base + '/api/health')).status).toBe(200);
    const h = await auth();
    db.down = true;
    // Process-only by design; /api/health?deep=1 (Postgres) is what the
    // uptime check uses to see the database (tests/health.test.js).
    expect((await fetch(base + '/api/health')).status).toBe(200);

    const feed = await (await fetch(base + '/events.json')).json();
    expect(feed.events[0].name).toBe('Old'); // still serves something
    expect(slack.alerts.some(a => a.k === 'db-read')).toBe(true);

    const timed = (p, init) => fetch(base + p, { ...init, signal: AbortSignal.timeout(3000) });
    expect((await timed('/api/admin/submissions', { headers: h })).status).toBe(500);
    expect((await timed('/api/admin/submissions/x', { headers: h })).status).toBe(500);
    expect((await timed('/api/admin/submissions/x', { method: 'POST', headers: h, body: '{}' })).status).toBe(500);
    expect((await timed('/api/admin/approved-events', { headers: h })).status).toBe(500);
    const sub = await timed('/api/submissions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Fall Fest', date: '2026-10-10', time: '10:00 AM', venue: 'Plaza', address: '101 Main St, Victoria, TX',
        description: 'A fall festival downtown.', submitter_first_name: 'A', submitter_last_name: 'B', submitter_email: 'a@b.example',
        submitter_phone: '361-555-0100', _t: String(Date.now() - 60000) })
    });
    expect([400, 500]).toContain(sub.status); // validation may stop it first; never a hang
  });

  it('a dropped idle Postgres connection is logged, not a crash', () => {
    const pool = watchPool(new EventEmitter());
    expect(() => pool.emit('error', new Error('terminating connection'))).not.toThrow();
  });
});

describe('contact messages', () => {
  it('are saved, listed in admin, and advertising goes to the sales channel', async () => {
    await start();
    const post = f => fetch(base + '/contact', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f).toString() });
    await post({ topic: 'advertising', name: 'Ann', email: 'ann@shop.example', business: 'Shop', message: 'How much is a week?' });
    await post({ topic: 'event', name: 'Bob', email: 'bob@x.example', message: 'Is the market on?' });
    expect(slack.notes.map(n => n.channel)).toEqual(['sales', 'activity']);
    expect((await fetch(base + '/api/admin/messages')).status).toBe(401);
    const r = await (await fetch(base + '/api/admin/messages', { headers: await auth() })).json();
    expect(r.messages.map(m => m.name)).toEqual(expect.arrayContaining(['Ann', 'Bob']));
    expect(r.messages.find(m => m.name === 'Ann')).toMatchObject({ email: 'ann@shop.example', topic: 'advertising', delivered: true });
  });

  it('are kept when Slack is down', async () => {
    await start();
    slack.notify = async () => false;
    await fetch(base + '/contact', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ topic: 'other', name: 'Cy', email: 'cy@x.example', message: 'Hello there' }).toString() });
    const [m] = await store.listContactMessages();
    expect(m).toMatchObject({ name: 'Cy', delivered: false });
  });
});

describe('auto-publish problems are alerts', () => {
  const read = async f => JSON.parse(await fs.readFile(f, 'utf8'));

  it('a run with far fewer events, or none upcoming, alerts', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-ops-'));
    const s = new FileStore(path.join(tmpDir, 's.json'));
    const ours = Array.from({ length: 10 }, (_, i) => ({ date: '2026-10-09', name: `E${i}`, venue: 'V' }));
    await s.setPublished({ events: ours, auto_publish: { keys: ours.map(e => `${e.date}|${e.name}|${e.venue}`) } });
    const file = path.join(tmpDir, 'c.json');
    await fs.writeFile(file, JSON.stringify({ last_updated: 'x', events: [ours[0]] }));
    const sl = fakeSlack();
    await createAutoPublish({ store: s, candidatesFile: file, readJsonFile: read, nowFn: () => NOW, slack: sl, siteUrl: 'https://x' }).run();
    expect(sl.alerts.map(a => a.k)).toContain('collector-unhealthy');

    const empty = new FileStore(path.join(tmpDir, 'e.json'));
    await fs.writeFile(file, JSON.stringify({ last_updated: 'y', events: [] }));
    const sl2 = fakeSlack();
    await createAutoPublish({ store: empty, candidatesFile: file, readJsonFile: read, nowFn: () => NOW, slack: sl2, siteUrl: 'https://x' }).run();
    expect(sl2.alerts.map(a => a.k)).toEqual(['auto-publish-empty']);
    expect(sl2.notes).toHaveLength(0);
  });

  it('an unreadable candidates.json on boot alerts', async () => {
    await start({ autoPublish: true, autoPublishDelayMs: 0 });
    await new Promise(r => setTimeout(r, 50));
    expect(slack.alerts.find(a => a.k === 'auto-publish').t).toBe('Auto-publish could not run');
  });
});

describe('newsletter switch', () => {
  const nl = { resendApiKey: 're_test', newsletterAddress: '1 Main St', newsletterCronSecret: 'cron-secret',
    resend: { send: async () => ({}), batch: async msgs => ({ data: msgs.map(() => ({ id: 'x' })) }) } };

  it('NEWSLETTER_AUTOSEND=0 stops the scheduled GitHub run but not a hand-started one', async () => {
    await start({ ...nl, newsletterAutosend: '0' });
    await store.importSubscribers(['a@example.com'], 'import');
    const cron = (sched) => fetch(base + '/api/newsletter/cron', { method: 'POST', headers: { 'X-Cron-Secret': 'cron-secret', 'X-Cron-Scheduled': sched } });
    const off = await (await cron('1')).json();
    expect(off.error).toBe('autosend-off');
    const r = await (await fetch(base + '/api/admin/newsletter', { headers: await auth() })).json();
    expect(r.autosend).toBe(false);
    expect((await cron('0')).status).toBe(200);
  });

  it('is on by default, and the setup checklist says so', async () => {
    await start(nl);
    const r = await (await fetch(base + '/api/admin/newsletter', { headers: await auth() })).json();
    expect(r.autosend).toBe(true);
    const setup = await (await fetch(base + '/api/admin/setup', { headers: await auth() })).json();
    const byKey = Object.fromEntries(setup.checks.map(c => [c.key, c]));
    expect(byKey.newsletter_auto.ok).toBe(true);
    expect(byKey.reply_to.ok).toBe(false);
    expect(byKey.scheduler.ok).toBe(false);
    expect(byKey.meta_pixel.ok).toBe(false);
    expect(byKey.submission_review.ok).toBe(false);
    expect(byKey.meta_ads.ok).toBeNull();
    expect(byKey.instagram.ok).toBeNull();
  });
});

describe('/events.json collected_at', () => {
  it('says which collect is live, and approvals don\'t move it', async () => {
    await start();
    await store.setPublished({ last_updated: '2026-10-05T14:00:00Z', events: [{ date: '2026-10-09', name: 'A', venue: 'V' }],
      auto_publish: { from: '2026-10-04T20:27:09-05:00', keys: [] } });
    const feed = await (await fetch(base + '/events.json')).json();
    expect(feed.collected_at).toBe('2026-10-04T20:27:09-05:00');
    expect(feed.auto_publish).toBeUndefined();
  });
});
