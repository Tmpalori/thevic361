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
