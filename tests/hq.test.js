// @vitest-environment node
//
// GET /api/hq/summary (server/hq.js, MULTI_CITY_PLAN.md 4.1): a town's
// numbers for the HQ dashboard. Off without HQ_API_KEY; only that key gets
// in, it opens no admin route, and nothing personal leaves.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { createRateLimiter } from '../server/rateLimit.js';
import { buildSummary, registerHq } from '../server/hq.js';
import { rowOf, totalsOf, renderDashboard } from '../hq/render.js';
import { VICTORIA } from '../server/town.js';

const KEY = 'hq-test-key-0123456789';
const NOW = new Date('2026-10-09T18:00:00Z');
let server, tmpDir, base, store;

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  server = null; tmpDir = null;
});

async function start(extra = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-hq-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [{ date: '2026-10-10', name: 'Fair', venue: 'Hall' }] }));
  store = new FileStore(path.join(tmpDir, 's.json'));
  await store.addSubscriber({ email: 'reader@example.com', source: 'test' });
  await store.saveSponsorOrder({ id: 'o1', kind: 'weekly', status: 'paid', amount: 30000, paid_at: '2026-10-02T12:00:00Z',
    created_at: '2026-10-01T00:00:00Z', business: 'Acme Tacos', email: 'owner@acme.example', week_start: '2026-10-12' });
  const { app } = await createApp({ storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
    siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c', ...extra });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
}
const get = (p, auth) => fetch(base + p, { headers: auth ? { Authorization: auth } : {} });

describe('/api/hq/summary', () => {
  it("doesn't exist without HQ_API_KEY", async () => {
    await start({ hqApiKey: '' });
    const missing = await get('/api/hq/no-such-thing');
    const r = await get('/api/hq/summary', `Bearer ${KEY}`);
    expect(r.status).toBe(missing.status);
    expect(r.status).toBe(404);
  });

  it('answers only the key, with counts and nothing personal', async () => {
    await start({ hqApiKey: KEY });
    expect((await get('/api/hq/summary')).status).toBe(401);
    expect((await get('/api/hq/summary', 'Bearer wrong')).status).toBe(401);
    const login = await (await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'a', password: 'b' }) })).json();
    expect((await get('/api/hq/summary', `Bearer ${login.token}`)).status).toBe(401);   // an admin session isn't the key
    const r = await get('/api/hq/summary', `Bearer ${KEY}`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({
      ok: true,
      town: { id: 'victoria', name: 'The Vic 361', site_url: 'https://www.thevic361.com', admin_url: 'https://www.thevic361.com/admin.html' },
      subscribers: { active: 0, pending: 1 },
      revenue: { month_to_date: { month: '2026-10', cents: 30000, orders: 1 }, orders_by_status: { paid: 1 } },
      sponsors: { weeks_booked_next_4: 1, weeks_open_next_4: 3, picks_sold_this_month: 0 },
      submissions_waiting: 0,
      health: { database: false, scheduler_blocked: false, slack_refused: false }
    });
    expect(body.setup.required_missing).toContain('database');
    // The trends the HQ charts draw: 31 days of active counts ending today,
    // six months of revenue ending this month, the next four sponsor weeks.
    expect(body.subscribers.daily).toHaveLength(31);
    expect(body.subscribers.daily.at(-1)).toMatchObject({ day: '2026-10-09', active: 0 });
    expect(body.revenue.months.map(m => m.month)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(body.revenue.months.at(-1).cents).toBe(30000);
    expect(body.sponsors.weeks).toEqual([
      { week_start: '2026-10-12', booked: true }, { week_start: '2026-10-19', booked: false },
      { week_start: '2026-10-26', booked: false }, { week_start: '2026-11-02', booked: false }]);
    expect(body.ads).toEqual({ spend_30_days: null, cost_per_sub_30_days: null });
    const text = JSON.stringify(body);
    for (const personal of ['@', 'reader', 'Acme', 'owner']) expect(text).not.toContain(personal);
  });

  it('opens no admin route', async () => {
    await start({ hqApiKey: KEY });
    expect((await get('/api/admin/setup', `Bearer ${KEY}`)).status).toBe(401);
    expect((await get('/api/admin/growth', `Bearer ${KEY}`)).status).toBe(401);
  });

  it('is cached for a minute and rate limited', async () => {
    await start({ hqApiKey: KEY, hqLimiter: createRateLimiter({ windowMs: 60000, max: 2 }) });
    const a = await (await get('/api/hq/summary', `Bearer ${KEY}`)).json();
    await store.addSubscriber({ email: 'second@example.com', source: 'test' });
    const b = await (await get('/api/hq/summary', `Bearer ${KEY}`)).json();
    expect(b).toEqual(a);   // the cached copy, not a second database read
    expect((await get('/api/hq/summary', `Bearer ${KEY}`)).status).toBe(429);
  });
});


describe('a town whose database is down', () => {
  const down = () => { throw Object.assign(new Error('database unavailable (circuit open)'), { code: 'CIRCUIT_OPEN' }); };
  const deadStore = {
    listSubscriberStats: down, listAdSpend: down, listNewsletterSends: down, countEmailOpens: down, listTraffic: down
  };
  const build = (store, health) => buildSummary({
    store, nowFn: () => NOW, town: VICTORIA, siteUrl: 'https://www.thevic361.com', commit: 'abc1234',
    getEvents: async () => [], getOrders: async () => down(), setup: async () => ({ checks: [], status: {} }), health
  });

  it('reports the failed parts as null and named, never as zeros', async () => {
    const body = await build(deadStore, async () => ({ database: false, database_configured: true, scheduler_blocked: false, slack_refused: false }));
    expect(body.ok).toBe(true);
    expect(body.failed).toEqual(['subscribers', 'revenue', 'ads', 'issues', 'database']);
    expect(body).toMatchObject({ subscribers: null, revenue: null, sponsors: null, issues: null, ads: null });
    expect(body.health).toEqual({ database: false, scheduler_blocked: false, slack_refused: false });   // no internal flag
    // HQ shows it as a problem, not a healthy row with 0 subscribers and $0.
    const row = rowOf({ slug: 'victoria', siteUrl: 'https://www.thevic361.com', summary: body }, 0);
    expect(row.problems).toEqual(['database', 'subscribers unavailable', 'revenue unavailable', 'ads unavailable', 'issues unavailable']);
    expect(row.subscribers).toBe(null);
    expect(row.revenueCents).toBe(null);
    const totals = totalsOf([row]);
    expect(totals).toMatchObject({ attention: 1, partial: 1, subscribers: null, revenueCents: null });
    const html = renderDashboard([row], NOW);
    expect(html).toContain('totals incomplete (1 partial)');
    expect(html).not.toContain('All towns healthy');
  });

  it('a healthy summary carries no failed list (same shape as before)', async () => {
    const store = new FileStore(path.join(os.tmpdir(), `vic361-hq-${process.pid}-${Date.now()}.json`));
    const body = await buildSummary({ store, nowFn: () => NOW, town: VICTORIA, siteUrl: 'https://www.thevic361.com',
      getEvents: async () => [], getOrders: async () => [], setup: async () => ({ checks: [], status: {} }),
      health: async () => ({ database: true, database_configured: true, scheduler_blocked: false, slack_refused: false }) });
    expect(body).not.toHaveProperty('failed');
    expect(body.health).toEqual({ database: true, scheduler_blocked: false, slack_refused: false });
    expect(body.subscribers.active).toBe(0);
  });

  it("caches a failed summary for seconds, not a minute", async () => {
    let t = NOW.getTime(), calls = 0, fail = true;
    const routes = {};
    const app = { get: (p, fn) => { routes[p] = fn; } };
    registerHq(app, { key: KEY, limiter: createRateLimiter({ windowMs: 60000, max: 100 }), nowFn: () => new Date(t),
      build: async () => { calls++; return fail ? { ok: true, failed: ['subscribers'] } : { ok: true }; } });
    const call = () => new Promise(resolve => {
      const res = { set() { return res; }, status() { return res; }, json: b => resolve(b) };
      routes['/api/hq/summary']({ get: () => `Bearer ${KEY}`, ip: '1.2.3.4' }, res, () => resolve('next'));
    });
    await call(); await call();
    expect(calls).toBe(1);            // a burst of HQ loads still reads once
    t += 6000; fail = false;
    expect(await call()).toEqual({ ok: true });
    expect(calls).toBe(2);            // the town is back within seconds
    t += 30000;
    await call();
    expect(calls).toBe(2);            // a healthy summary keeps its minute
  });

  it('health.database is a live ping, not just "Postgres is configured"', async () => {
    let up = false;
    const pool = { query: async () => { if (!up) throw new Error('connect ECONNREFUSED'); return { rows: [] }; } };
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-hq-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    store = new FileStore(path.join(tmpDir, 's.json'));
    const { app } = await createApp({ storeBundle: { kind: 'postgres', store, pool }, eventsFile, trustProxy: false, now: () => NOW,
      siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c', hqApiKey: KEY,
      hqLimiter: createRateLimiter({ windowMs: 60000, max: 100 }) });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
    const body = await (await get('/api/hq/summary', `Bearer ${KEY}`)).json();
    expect(body.health.database).toBe(false);
    expect(body.failed).toContain('database');
  });
});
