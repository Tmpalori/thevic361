// @vitest-environment node
//
// The HQ service (hq/server.js, MULTI_CITY_PLAN.md 4.2): its own login,
// every town's /api/hq/summary on one screen, keys never sent to the
// browser, a down town shown as a red row. Towns are a fake fetch.

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { createHqApp, hqConfig, rowOf, totalsOf } from '../hq/server.js';
import { createRateLimiter } from '../server/rateLimit.js';

const KEY_VIC = 'vic-key-0123456789abcdef';
const KEY_BAY = 'bay-key-0123456789abcdef';
const ENV = {
  HQ_TOWNS: JSON.stringify([
    { slug: 'victoria', site_url: 'https://www.thevic361.com', key: KEY_VIC },
    { slug: 'bay', site_url: 'https://www.thebay979.com/', key: KEY_BAY },
    { slug: 'tulsa', site_url: 'https://www.tulsatoday.com', key: 'tulsa-key-0123456789ab' }
  ]),
  HQ_USERNAME: 'tristen', HQ_PASSWORD: 'correct horse battery', HQ_SESSION_SECRET: 's'.repeat(40)
};
const summary = (name, extra = {}) => ({
  ok: true, town: { name, admin_url: `https://x.example/admin.html` },
  subscribers: { active: 100, net_7_days: 5 }, issues: [{ open_rate: 50 }],
  revenue: { month_to_date: { cents: 30000 } }, sponsors: { weeks_open_next_4: 2, picks_sold_this_month: 3 },
  submissions_waiting: 1, events: { upcoming: 40 }, health: { database: true }, setup: { required_missing: [] }, ...extra
});

let server, base, seen;
afterEach(async () => { if (server) await new Promise(r => server.close(r)); server = null; });

async function start(extra = {}) {
  seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization });
    if (url.startsWith('https://www.thevic361.com')) return { ok: true, status: 200, json: async () => summary('The Vic 361') };
    if (url.startsWith('https://www.thebay979.com')) {
      return { ok: true, status: 200, json: async () => summary('The Bay <979>', { subscribers: { active: 300, net_7_days: -2 }, issues: [{ open_rate: 40 }],
        health: { database: false }, setup: { required_missing: ['login'] } }) };
    }
    throw new Error('connect ECONNREFUSED');
  };
  server = http.createServer(createHqApp(hqConfig(ENV), { fetchImpl, ...extra }));
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
}
const login = (username, password) => fetch(base + '/login', { method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password }).toString() });
async function session() {
  const r = await login('tristen', 'correct horse battery');
  expect(r.status).toBe(303);
  const cookie = r.headers.get('set-cookie');
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/SameSite=Strict/i);
  return { cookie: cookie.split(';')[0] };
}

describe('hqConfig', () => {
  it('reads the towns and login, and names what is wrong', () => {
    const c = hqConfig(ENV);
    expect(c.towns.map(t => t.slug)).toEqual(['victoria', 'bay', 'tulsa']);
    expect(c.towns[1].siteUrl).toBe('https://www.thebay979.com');
    expect(() => hqConfig({ ...ENV, HQ_TOWNS: '{' })).toThrow(/must be JSON/);
    expect(() => hqConfig({ ...ENV, HQ_TOWNS: '[]' })).toThrow(/no towns/);
    expect(() => hqConfig({ ...ENV, HQ_TOWNS: JSON.stringify([{ slug: 'a', site_url: 'http://a.example', key: KEY_VIC }]) })).toThrow(/https/);
    expect(() => hqConfig({ ...ENV, HQ_TOWNS: JSON.stringify([{ slug: 'a', site_url: 'https://a.example', key: 'short' }]) })).toThrow(/16\+/);
    expect(() => hqConfig({ ...ENV, HQ_PASSWORD: 'short' })).toThrow(/HQ_PASSWORD/);
    expect(() => hqConfig({ ...ENV, HQ_SESSION_SECRET: 'x' })).toThrow(/HQ_SESSION_SECRET/);
  });
});

describe('the dashboard', () => {
  it('asks for a login first and refuses a wrong one', async () => {
    await start();
    const page = await (await fetch(base + '/')).text();
    expect(page).toContain('action="/login"');
    expect(seen).toHaveLength(0);   // no town is asked before login
    expect((await login('tristen', 'wrong')).status).toBe(401);
    expect((await fetch(base + '/api/towns')).status).toBe(401);
    expect((await fetch(base + '/', { headers: { cookie: 'hq_session=forged.sig' } })).headers.get('content-type')).toMatch(/html/);
  });

  it('shows every town, totals, red rows, and never the keys', async () => {
    await start();
    const h = { headers: await session() };
    const res = await fetch(base + '/', h);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const html = await res.text();
    expect(seen.map(s => [s.url, s.auth])).toEqual([
      ['https://www.thevic361.com/api/hq/summary', `Bearer ${KEY_VIC}`],
      ['https://www.thebay979.com/api/hq/summary', `Bearer ${KEY_BAY}`],
      ['https://www.tulsatoday.com/api/hq/summary', 'Bearer tulsa-key-0123456789ab']
    ]);
    expect(html).toContain('The Vic 361');
    expect(html).toContain('The Bay &lt;979&gt;');   // escaped
    expect(html).not.toContain('<979>');
    expect(html).toContain('database, setup: login');
    expect(html).toContain('unreachable');
    expect(html).toContain('1 not answering');
    expect(html).toContain('<b>400</b><span>subscribers</span>');
    expect(html).toContain('<b>$600</b><span>revenue this month</span>');
    for (const key of [KEY_VIC, KEY_BAY, 'tulsa-key']) expect(html).not.toContain(key);
    const json = await (await fetch(base + '/api/towns', h)).json();
    expect(json.totals).toMatchObject({ towns: 3, down: 1, subscribers: 400, net7: 3, revenueCents: 60000, openWeeks: 4, picks: 6, waiting: 2, openRate: 42.5 });
    expect(JSON.stringify(json)).not.toContain('key-0123');
  });

  it('rate limits logins and logs out', async () => {
    await start({ loginLimiter: createRateLimiter({ windowMs: 60000, max: 2 }) });
    await login('tristen', 'wrong');
    await login('tristen', 'wrong');
    expect((await login('tristen', 'correct horse battery')).status).toBe(429);
    const out = await fetch(base + '/logout', { redirect: 'manual' });
    expect(out.headers.get('set-cookie')).toMatch(/hq_session=;/);
  });

  it('expires a session after 12 hours', async () => {
    let now = new Date('2026-10-09T12:00:00Z');
    await start({ nowFn: () => now });
    const h = { headers: await session() };
    expect((await fetch(base + '/api/towns', h)).status).toBe(200);
    now = new Date('2026-10-10T00:00:01Z');
    expect((await fetch(base + '/api/towns', h)).status).toBe(401);
  });
});

describe('rows', () => {
  it('reads a summary into a row, and an error into a red one', () => {
    expect(rowOf({ slug: 'x', siteUrl: 'https://x.example', error: 'key refused' })).toEqual({ slug: 'x', siteUrl: 'https://x.example', error: 'key refused' });
    const r = rowOf({ slug: 'v', siteUrl: 'https://v.example', summary: summary('V') });
    expect(r).toMatchObject({ subscribers: 100, net7: 5, openRate: 50, revenueCents: 30000, openWeeks: 2, picks: 3, waiting: 1, upcoming: 40, problems: [] });
    expect(totalsOf([r, { error: 'x' }])).toMatchObject({ towns: 2, down: 1, subscribers: 100, openRate: 50 });
  });
});
