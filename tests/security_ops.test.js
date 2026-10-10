// @vitest-environment node
//
// Fixes from the 2026-10-10 security and operations review: capped crawler
// rows, one open sponsor hold per client, personal-data retention and
// deletion, admin secret minimums, capped ad beacons, the subscriber CSV
// export and the Turnstile hostname check.

import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createApp } from '../server/index.js';
import { FileStore, PgStore } from '../server/db.js';
import { crawlerMiddleware, CRAWL_PER_IP_MIN } from '../server/analytics.js';
import { verifyTurnstile, turnstileHostnames } from '../server/turnstile.js';
import { purgePersonalData, retentionCutoffs, subscribersCsv } from '../server/privacy.js';
import { createScheduler, JOBS, dueSlot } from '../server/scheduler.js';
import { createMailer } from '../server/notify.js';

const NOW = new Date('2026-10-07T15:00:00Z');
const LONG = { adminUsername: 'admin', adminPassword: 'a-long-enough-pass', adminSessionSecret: 'x'.repeat(32) };

let servers = [], dirs = [];
afterEach(async () => {
  for (const s of servers) await new Promise(r => s.close(r));
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  servers = []; dirs = [];
  vi.restoreAllMocks();
});

async function listen(app) {
  const server = http.createServer(app);
  servers.push(server);
  await new Promise(r => server.listen(0, r));
  return `http://127.0.0.1:${server.address().port}`;
}

async function startApp(extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-sec-'));
  dirs.push(dir);
  const eventsFile = path.join(dir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  const store = new FileStore(path.join(dir, 's.json'));
  const slack = { enabled: true, alerts: [], notes: [],
    notify: async (n) => { slack.notes.push(n); return true; }, alert: async (key, title, text) => { slack.alerts.push({ key, title, text }); return true; } };
  const out = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, trustProxy: 1, now: () => NOW, siteUrl: 'https://www.thevic361.com',
    resendApiKey: '', slack, autoPublish: false, startScheduler: false, ...LONG, ...extra
  });
  const base = await listen(out.app);
  return { ...out, base, store, slack };
}

async function login(base, user = LONG.adminUsername, pass = LONG.adminPassword) {
  const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }) });
  const j = await r.json();
  return { Authorization: `Bearer ${j.token}`, 'Content-Type': 'application/json' };
}

describe('crawler rows are capped per client (finding 1)', () => {
  it('1,000 crawler requests from one address write at most a minute’s cap of rows; another address still counts', async () => {
    const rows = [];
    const store = { recordTraffic: async row => { rows.push(row); } };
    const app = express();
    app.set('trust proxy', 1);
    app.use(crawlerMiddleware(store, () => NOW));
    app.get('/', (req, res) => res.type('html').send('<p>hi</p>'));
    const base = await listen(app);
    const hit = ip => fetch(base + '/', { headers: { 'User-Agent': 'Googlebot/2.1', 'X-Forwarded-For': ip } }).then(r => r.text());
    for (let i = 0; i < 1000; i += 50) await Promise.all(Array.from({ length: 50 }, () => hit('203.0.113.9')));
    await new Promise(r => setTimeout(r, 20));
    expect(rows.length).toBe(CRAWL_PER_IP_MIN);
    expect(rows[0]).toMatchObject({ kind: 'crawl', bot: 'Googlebot', path: '/' });
    await hit('198.51.100.7');
    await new Promise(r => setTimeout(r, 20));
    expect(rows.length).toBe(CRAWL_PER_IP_MIN + 1);
  });

  it('IPv6 clients share one budget per /64', async () => {
    const rows = [];
    const app = express();
    app.set('trust proxy', 1);
    app.use(crawlerMiddleware({ recordTraffic: async row => { rows.push(row); } }, () => NOW));
    app.get('/', (req, res) => res.type('html').send('ok'));
    const base = await listen(app);
    for (let i = 0; i < 60; i++) {
      await fetch(base + '/', { headers: { 'User-Agent': 'GPTBot', 'X-Forwarded-For': `2001:db8:1:2::${i.toString(16)}` } }).then(r => r.text());
    }
    await new Promise(r => setTimeout(r, 20));
    expect(rows.length).toBe(CRAWL_PER_IP_MIN);
  });
});

describe('ad beacons are capped per client per ad per day (finding 8)', () => {
  it('a script posting impressions and clicks for one order counts 20 and 5 a day; another address still counts', async () => {
    const { base, store } = await startApp();
    const rows = [];
    store.recordTraffic = async row => { rows.push(row); };
    const AD = 'a1b2c3d4-0000-4000-8000-000000000001';
    const beacon = (body, ip) => fetch(base + '/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify(body) });
    for (let i = 0; i < 50; i++) await beacon({ kind: 'impression', ad: AD, path: '/' }, '203.0.113.5');
    for (let i = 0; i < 20; i++) await beacon({ kind: 'click', type: 'sponsor_click', url: 'https://acme.example/', ad: AD, path: '/' }, '203.0.113.5');
    // Clicks on the sponsor's link without the ad id count against the link.
    for (let i = 0; i < 20; i++) await beacon({ kind: 'click', type: 'sponsor_click', url: 'https://acme.example/x', path: '/' }, '203.0.113.5');
    await beacon({ kind: 'impression', ad: AD, path: '/' }, '198.51.100.1');
    // Page views aren't capped here (only /api/track's own per-minute limit).
    for (let i = 0; i < 30; i++) await beacon({ kind: 'view', path: '/' }, '203.0.113.6');
    await new Promise(r => setTimeout(r, 20));
    expect(rows.filter(r => r.kind === 'impression')).toHaveLength(21);
    expect(rows.filter(r => r.kind === 'click' && r.ad === AD)).toHaveLength(5);
    expect(rows.filter(r => r.kind === 'click' && !r.ad)).toHaveLength(5);
    expect(rows.filter(r => r.kind === 'view')).toHaveLength(30);
  });
});

describe('open sponsor holds per client are capped (finding 2)', () => {
  function fakeStripe(sessions, expired) {
    return {
      createCheckoutSession: async (params, key) => {
        const id = `cs_test_${sessions.length + 1}`;
        sessions.push({ params, key, id });
        return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
      },
      expireCheckoutSession: async (id) => { expired.push(id); return { id, status: 'expired' }; }
    };
  }
  const weekly = (week, email) => ({ package: 'weekly', week, business: 'B', text: 'x', url: 'b.example', email, agree: '1' });
  const post = (base, fields, ip) => fetch(base + '/advertise/checkout', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip }, body: new URLSearchParams(fields).toString() });

  it('one address holds at most three checkouts; a fourth releases its oldest', async () => {
    const sessions = [], expired = [];
    let t = NOW.getTime();   // a minute between checkouts, so "oldest" is well defined
    const { base, store } = await startApp({ stripeSecretKey: 'sk_test', stripeWebhookSecret: 'whsec_test', stripe: fakeStripe(sessions, expired),
      now: () => new Date(t) });
    const weeks = ['2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'];
    for (const [i, w] of weeks.entries()) {
      expect((await post(base, weekly(w, `buyer${i}@x.example`), '203.0.113.20')).status).toBe(303);
      t += 60 * 1000;
    }
    const orders = await store.listSponsorOrders();
    // Several real buyers can share an address (a mobile carrier), so three stay held.
    expect(orders.filter(o => o.status === 'pending').map(o => o.week_start).sort()).toEqual(['2026-10-19', '2026-10-26', '2026-11-02']);
    expect(orders.filter(o => o.status === 'cancelled').map(o => o.week_start)).toEqual(['2026-10-12']);
    expect(expired).toEqual([sessions[0].id]);
    // The order stores a hash, not the address.
    expect(JSON.stringify(orders)).not.toContain('203.0.113.20');
    expect(orders[0].client).toMatch(/^[0-9a-f]{16}$/);

    // The earlier weeks are free again for someone else.
    expect((await post(base, weekly('2026-10-12', 'other@y.example'), '198.51.100.30')).status).toBe(303);
    // A buyer coming back to their own held week isn't blocked.
    expect((await post(base, weekly('2026-11-02', 'buyer3@x.example'), '203.0.113.20')).status).toBe(303);
  });

  it('the same email from another address also replaces its hold', async () => {
    const sessions = [], expired = [];
    const { base, store } = await startApp({ stripeSecretKey: 'sk_test', stripeWebhookSecret: 'whsec_test', stripe: fakeStripe(sessions, expired) });
    expect((await post(base, weekly('2026-10-12', 'same@x.example'), '203.0.113.40')).status).toBe(303);
    expect((await post(base, weekly('2026-10-19', 'same@x.example'), '198.51.100.41')).status).toBe(303);
    const pending = (await store.listSponsorOrders()).filter(o => o.status === 'pending');
    expect(pending.map(o => o.week_start)).toEqual(['2026-10-19']);
    // A different buyer from a different address keeps theirs.
    expect((await post(base, weekly('2026-10-26', 'third@x.example'), '192.0.2.42')).status).toBe(303);
    expect((await store.listSponsorOrders()).filter(o => o.status === 'pending')).toHaveLength(2);
  });
});

describe('personal-data retention (finding 4)', () => {
  it('FileStore: clears IP and user agent after 12 months and deletes contact messages after 24', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-sec-'));
    dirs.push(dir);
    const store = new FileStore(path.join(dir, 's.json'));
    const sub = (id, created_at) => ({ id, created_at, updated_at: created_at, status: 'approved', submitter_email: 'a@b.example',
      submitter_ip: '1.2.3.4', user_agent: 'UA', payload: { name: 'E' } });
    await store.insert(sub('old', '2025-09-01T00:00:00.000Z'));
    await store.insert(sub('new', '2025-11-01T00:00:00.000Z'));
    await store.saveContactMessage({ id: 'c-old', created_at: '2024-09-01T00:00:00.000Z', email: 'x@y.example', message: 'old' });
    await store.saveContactMessage({ id: 'c-new', created_at: '2024-11-01T00:00:00.000Z', email: 'x@y.example', message: 'new' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await purgePersonalData(store, NOW)).toEqual({ ok: true, submissions: 1, contact_messages: 1 });
    expect(log).toHaveBeenCalled();
    expect(await store.get('old')).toMatchObject({ submitter_ip: null, user_agent: null, submitter_email: 'a@b.example' });
    expect(await store.get('new')).toMatchObject({ submitter_ip: '1.2.3.4', user_agent: 'UA' });
    expect((await store.listContactMessages()).map(m => m.id)).toEqual(['c-new']);
    expect(await purgePersonalData(store, NOW)).toEqual({ ok: true, submissions: 0, contact_messages: 0 });
  });

  it('cutoffs are 12 and 24 months back', () => {
    expect(retentionCutoffs(NOW)).toEqual({ submissionsBefore: '2025-10-07T15:00:00.000Z', contactBefore: '2024-10-07T15:00:00.000Z' });
  });

  it('PgStore runs one UPDATE and one DELETE with the cutoffs', async () => {
    const calls = [];
    const pool = { query: async (text, args) => {
      calls.push({ text, args });
      if (/information_schema/.test(text)) return { rows: [] };
      if (/UPDATE event_submissions/.test(text)) return { rows: [], rowCount: 2 };
      if (/DELETE FROM contact_messages/.test(text)) return { rows: [], rowCount: 3 };
      return { rows: [] };
    } };
    const store = new PgStore(pool);
    const cut = retentionCutoffs(NOW);
    expect(await store.purgePersonalData(cut)).toEqual({ submissions: 2, contact_messages: 3 });
    const upd = calls.find(c => /UPDATE event_submissions/.test(c.text));
    expect(upd.text).toMatch(/submitter_ip = NULL, user_agent = NULL/);
    expect(upd.args).toEqual([cut.submissionsBefore]);
    expect(calls.find(c => /DELETE FROM contact_messages/.test(c.text)).args).toEqual([cut.contactBefore]);
  });

  it('the scheduler runs it once a day, early morning', async () => {
    const job = JOBS.find(j => j.name === 'privacy-purge');
    expect(job).toMatchObject({ at: '03:17' });
    const at = new Date('2026-10-07T08:20:00Z'); // 3:20 AM Central
    expect(dueSlot(job, at)).toBe('2026-10-07');
    const runs = [];
    const claimed = new Set();
    const store = {
      claimJobRun: async (name, slot) => { const k = `${name}|${slot}`; if (claimed.has(k)) return { claimed: false }; claimed.add(k); return { claimed: true, attempts: 1 }; },
      finishJobRun: async () => {}, getJobRun: async () => null
    };
    const s = createScheduler({ store, github: null, nowFn: () => at, jobs: [job], handlers: { privacyPurge: async now => { runs.push(now); return { ok: true }; } } });
    await s.tick(at);
    await s.tick(at);
    expect(runs).toHaveLength(1);
  });
});

describe('forget one email on request (finding 4)', () => {
  it('admin-only; deletes the subscriber, contact messages and submitter fields; masks orders and rewards; logs it', async () => {
    const { base, store, slack } = await startApp();
    const email = 'bob@example.com';
    const sub = await store.addSubscriber({ email, source: 'site' });
    await store.addSubscriber({ email: 'keep@example.com', source: 'site' });
    await store.recordEmailOpen({ week_key: '2026-10-05', subscriber_id: sub.id });
    await store.insert({ id: 's1', created_at: NOW.toISOString(), updated_at: NOW.toISOString(), status: 'approved', submitter_name: 'Bob B',
      submitter_email: 'Bob@Example.com', submitter_ip: '1.2.3.4', user_agent: 'UA',
      payload: { name: 'Bob’s show', submitter_first_name: 'Bob', submitter_last_name: 'B', submitter_phone: '361-555-0100' } });
    await store.saveContactMessage({ id: 'c1', created_at: NOW.toISOString(), name: 'Bob', email, message: 'hi' });
    await store.saveContactMessage({ id: 'c2', created_at: NOW.toISOString(), name: 'Kay', email: 'keep@example.com', message: 'hi' });
    await store.saveSponsorOrder({ id: 'o1', kind: 'weekly', status: 'paid', email, business: 'Bob Co', amount: 30000, created_at: NOW.toISOString() });
    await store.addReferralReward({ key: 'tier:x:1', kind: 'tier', email, amount: 1000, status: 'held' });
    await store.addReferralReward({ key: 'tier:x:2', kind: 'tier', email, amount: 2500, status: 'sent' });
    await store.recordNewsletterSend({ week_key: '2026-10-05', subject: 's', recipients: 2, failed: 1, failed_emails: [email] });

    const body = JSON.stringify({ email: ' BOB@example.com ' });
    expect((await fetch(base + '/api/admin/privacy/forget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status).toBe(401);
    expect(await store.listSubscribers()).toHaveLength(2);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await fetch(base + '/api/admin/privacy/forget', { method: 'POST', headers: await login(base), body });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j).toMatchObject({ ok: true, masked: 'b•••@example.com',
      removed: { subscribers: 1, email_opens: 1, submissions: 1, contact_messages: 1, sponsor_orders: 1, referral_rewards: 2, newsletter_sends: 1 } });

    expect((await store.listSubscribers()).map(s => s.email)).toEqual(['keep@example.com']);
    const s1 = await store.get('s1');
    expect(s1).toMatchObject({ submitter_email: null, submitter_name: null, submitter_ip: null, user_agent: null });
    expect(s1.payload).toMatchObject({ name: 'Bob’s show', submitter_first_name: '', submitter_last_name: '', submitter_phone: '' });
    expect((await store.listContactMessages()).map(m => m.id)).toEqual(['c2']);
    const [order] = await store.listSponsorOrders();
    expect(order).toMatchObject({ id: 'o1', email: 'b•••@example.com', amount: 30000, business: 'Bob Co' });
    const rewards = await store.listReferralRewards();
    expect(rewards.every(x => x.email === 'b•••@example.com')).toBe(true);
    expect(rewards.find(x => x.key === 'tier:x:1').status).toBe('skipped');
    expect(rewards.find(x => x.key === 'tier:x:2').status).toBe('sent');
    expect((await store.getNewsletterSend('2026-10-05')).failed_emails).toEqual([]);
    const data = await fs.readFile(store.file, 'utf8');
    expect(data.toLowerCase()).not.toContain('bob@example.com');
    expect(data).not.toContain('361-555-0100');

    // Logged and posted, without the address itself.
    const line = log.mock.calls.map(c => c.join(' ')).find(l => /\[privacy\] forgot/.test(l));
    expect(line).toContain('b•••@example.com');
    expect(line).not.toContain('bob@example.com');
    expect(slack.notes.some(n => /deleted on request/.test(n.title) && !/bob@example\.com/.test(n.text))).toBe(true);

    const bad = await fetch(base + '/api/admin/privacy/forget', { method: 'POST', headers: await login(base), body: JSON.stringify({ email: 'nope' }) });
    expect(bad.status).toBe(400);
  });

  it('PgStore does it in one transaction on a pool client', async () => {
    const seen = [];
    const client = { query: async (text) => { seen.push(text.trim().split(/\s+/).slice(0, 3).join(' ')); return { rows: [], rowCount: 1 }; }, release: vi.fn() };
    const pool = { query: async () => ({ rows: [] }), connect: async () => client };
    const out = await new PgStore(pool).forgetEmail('bob@example.com', 'b•••@example.com');
    expect(seen[0]).toBe('BEGIN');
    expect(seen.at(-1)).toBe('COMMIT');
    expect(seen.some(s => s.startsWith('DELETE FROM subscribers'))).toBe(true);
    expect(seen.some(s => s.startsWith('DELETE FROM contact_messages'))).toBe(true);
    expect(seen.some(s => s.startsWith('UPDATE sponsor_orders'))).toBe(true);
    expect(out.subscribers).toBe(1);
    expect(client.release).toHaveBeenCalled();
  });

  it('the mailer never sends to a masked address', async () => {
    const sent = [];
    const mailer = createMailer({ resend: { send: async (m) => { sent.push(m); } }, config: { enabled: true, from: 'a@b.example' } });
    expect(await mailer.deliver('b•••@example.com', { subject: 's', html: '', text: '' })).toBe('refused');
    expect(await mailer.deliver('bob@example.com', { subject: 's', html: '', text: '' })).toBe('sent');
    expect(sent).toHaveLength(1);
  });
});

describe('subscriber CSV export (backups)', () => {
  it('admin-only CSV with email, status, source and dates; formulas are defused', async () => {
    const { base, store } = await startApp();
    await store.importSubscribers(['a@example.com'], 'import');
    await store.addSubscriber({ email: 'b@example.com', source: '=HYPERLINK("x")' });
    expect((await fetch(base + '/api/admin/subscribers.csv')).status).toBe(401);
    const r = await fetch(base + '/api/admin/subscribers.csv', { headers: await login(base) });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="subscribers-2026-10-07.csv"');
    const lines = (await r.text()).trim().split('\r\n');
    expect(lines[0]).toBe('email,status,source,created_at,confirmed_at,unsubscribed_at');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^a@example\.com,active,import,\d{4}-/);
    expect(lines[2]).toMatch(/^b@example\.com,pending,"'=HYPERLINK\(""x""\)",/);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('csv quoting', () => {
    expect(subscribersCsv([{ email: 'a@b.example', status: 'active', source: 'x,y' }]))
      .toBe('email,status,source,created_at,confirmed_at,unsubscribed_at\r\na@b.example,active,"x,y",,,\r\n');
  });
});

describe('admin secret minimums (finding 7)', () => {
  it('a short secret or token fails a required setup check and alerts in production, but login still works', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { base, slack } = await startApp({ adminPassword: 'pw7', adminSessionSecret: 'tiny', adminToken: 'tok', railwayEnvironment: 'production' });
    const weak = slack.alerts.filter(a => a.key === 'admin-weak-secrets');
    expect(weak).toHaveLength(1);
    expect(weak[0].text).toMatch(/ADMIN_SESSION_SECRET is shorter than 32.*ADMIN_TOKEN is shorter than 32/);
    // Lengths only, never the values.
    expect(weak[0].text).not.toMatch(/pw7|tiny|tok\b/);
    const headers = await login(base, 'admin', 'pw7');
    const setup = await (await fetch(base + '/api/admin/setup', { headers })).json();
    expect(setup.checks.find(c => c.key === 'admin_secrets')).toMatchObject({ ok: false, level: 'required' });
    expect(setup.checks.find(c => c.key === 'admin_password')).toMatchObject({ ok: false, level: 'recommended' });
  });

  it('a short password alone is the owner\'s call: a recommended setup item, no alert, no log line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { base, slack } = await startApp({ adminPassword: 'shortpw9', railwayEnvironment: 'production' });
    expect(slack.alerts.filter(a => a.key === 'admin-weak-secrets')).toHaveLength(0);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('ADMIN_PASSWORD');
    const setup = await (await fetch(base + '/api/admin/setup', { headers: await login(base, 'admin', 'shortpw9') })).json();
    expect(setup.checks.find(c => c.key === 'admin_secrets').ok).toBe(true);
    expect(setup.checks.find(c => c.key === 'admin_password')).toMatchObject({ ok: false, level: 'recommended' });
  });

  it('long enough: the check passes and nothing alerts; a PR environment never alerts', async () => {
    const { base, slack } = await startApp({ railwayEnvironment: 'production', adminToken: 'k'.repeat(40) });
    expect(slack.alerts.filter(a => a.key === 'admin-weak-secrets')).toHaveLength(0);
    const setup = await (await fetch(base + '/api/admin/setup', { headers: await login(base) })).json();
    expect(setup.checks.find(c => c.key === 'admin_secrets').ok).toBe(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pr = await startApp({ adminPassword: 'short', railwayEnvironment: 'pr-12' });
    expect(pr.slack.alerts.filter(a => a.key === 'admin-weak-secrets')).toHaveLength(0);
  });
});

describe('Turnstile hostname (finding 11)', () => {
  const reply = json => async () => ({ json: async () => json });
  const hostnames = turnstileHostnames('https://www.thevic361.com');

  it('accepts the site’s apex and www, refuses another site’s token', async () => {
    expect(hostnames).toEqual(['thevic361.com', 'www.thevic361.com']);
    for (const h of ['www.thevic361.com', 'thevic361.com', 'WWW.THEVIC361.COM']) {
      expect((await verifyTurnstile('t', { secret: 's', hostnames, fetch: reply({ success: true, hostname: h }) })).ok, h).toBe(true);
    }
    const other = await verifyTurnstile('t', { secret: 's', hostnames, fetch: reply({ success: true, hostname: 'austincommercialsites.com' }) });
    expect(other).toMatchObject({ ok: false, error: 'hostname-mismatch' });
    // No hostname in the answer: nothing to compare.
    expect((await verifyTurnstile('t', { secret: 's', hostnames, fetch: reply({ success: true }) })).ok).toBe(true);
    expect(turnstileHostnames('https://thevic361.com', 'web-pr-3.up.railway.app'))
      .toEqual(['thevic361.com', 'www.thevic361.com', 'web-pr-3.up.railway.app']);
  });

  it('the app refuses a contact-form token that was solved on another site', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = async (url, init) => {
      if (String(url).includes('turnstile')) {
        const host = new URLSearchParams(init.body).get('response');
        return { json: async () => ({ success: true, hostname: host }) };
      }
      throw new Error('unexpected fetch ' + url);
    };
    const { base } = await startApp({ turnstileSecret: 'sec', turnstileSiteKey: 'site', fetch: fetchImpl });
    const submit = token => fetch(base + '/contact', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'A', email: 'a@example.com', message: 'Hello there, a real message.', 'cf-turnstile-response': token }).toString() });
    const bad = await submit('austincommercialsites.com');
    const good = await submit('www.thevic361.com');
    expect(bad.status).not.toBe(good.status);
    expect(await bad.text()).toMatch(/not a bot/i);
  });
});
