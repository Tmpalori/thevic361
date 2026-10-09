// A test order (the owner's own try-out, or one paid with Stripe's test
// keys) is marked in Admin → Sponsors and left out of the revenue goal.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { monthRevenue } from '../server/growth.js';

const NOW = new Date('2026-10-14T17:00:00Z');
let tmpDir, server, baseUrl;
afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  server = null; tmpDir = null;
});

describe('test orders', () => {
  it('don\'t count toward this month\'s revenue', () => {
    const orders = [
      { kind: 'featured', status: 'paid', amount: 4900, paid_at: '2026-10-02T17:00:00Z', test: true },
      { kind: 'featured', status: 'paid', amount: 4900, paid_at: '2026-10-03T17:00:00Z' }
    ];
    expect(monthRevenue(orders, '2026-10-14')).toMatchObject({ cents: 4900, orders: 1 });
  });

  it('are marked (and unmarked) from Admin → Sponsors', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-test-orders-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    const store = new FileStore(path.join(tmpDir, 's.json'));
    await store.saveSponsorOrder({ id: 'o1', kind: 'featured', status: 'paid', amount: 4900, paid_at: '2026-10-02T17:00:00Z',
      created_at: '2026-10-02T16:00:00Z', business: 'Me', email: 'me@example.com', event: { name: 'Try', date: '2026-10-03' } });
    const { app } = await createApp({ storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
      siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c' });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(baseUrl + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'b' }) });
    const h = { Authorization: `Bearer ${(await login.json()).token}`, 'Content-Type': 'application/json' };
    const act = action => fetch(baseUrl + '/api/admin/sponsors/o1', { method: 'POST', headers: h, body: JSON.stringify({ action }) });
    expect((await act('mark-test')).status).toBe(200);
    expect((await store.listSponsorOrders())[0]).toMatchObject({ test: true, status: 'paid' });
    const g = await (await fetch(baseUrl + '/api/admin/growth?goals=1', { headers: h })).json();
    expect(g.goals.revenue.cents).toBe(0);
    expect((await act('unmark-test')).status).toBe(200);
    expect((await store.listSponsorOrders())[0].test).toBe(false);
  });
});
