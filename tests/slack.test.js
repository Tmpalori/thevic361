// @vitest-environment node
//
// Slack owner notifications (server/slack.js). Slack is a recording fake;
// nothing is posted.

import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { createSlack, slackConfig, slackEscape } from '../server/slack.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

describe('createSlack', () => {
  it('is a no-op without a Slack webhook URL', async () => {
    let calls = 0;
    const s = createSlack(slackConfig({}), { fetchImpl: async () => { calls++; return { ok: true }; } });
    expect(s.enabled).toBe(false);
    expect(await s.notify({ title: 'x' })).toBe(false);
    expect(calls).toBe(0);
    expect(slackConfig({ SLACK_WEBHOOK_URL: 'https://evil.example/x' }).enabled).toBe(false);
  });

  it('escapes user text and de-duplicates alerts per window', async () => {
    const bodies = [];
    let now = 0;
    const s = createSlack(slackConfig({ SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x', RAILWAY_ENVIRONMENT_NAME: 'production' }),
      { fetchImpl: async (_u, o) => { bodies.push(JSON.parse(o.body)); return { ok: true }; }, nowFn: () => now });
    await s.notify({ title: 'New', fields: [['From', '<!channel> & co']] });
    expect(JSON.stringify(bodies[0])).toContain('&lt;!channel&gt; &amp; co');
    await s.alert('k', 'Broke', 'detail');
    await s.alert('k', 'Broke', 'detail');
    expect(bodies).toHaveLength(2);
    now = 16 * 60 * 1000;
    await s.alert('k', 'Broke', 'detail');
    expect(bodies).toHaveLength(3);
    expect(slackEscape('<a>')).toBe('&lt;a&gt;');
  });

  it('never throws when Slack is down', async () => {
    const s = createSlack(slackConfig({ SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x' }), { fetchImpl: async () => { throw new Error('down'); } });
    expect(await s.notify({ title: 'x' })).toBe(false);
  });
});

describe('server wiring', () => {
  let tmpDir, server, baseUrl, sent;
  const fakeSlack = () => {
    sent = [];
    return { enabled: true, notify: async (m) => { sent.push({ kind: 'notify', ...m }); }, alert: async (key, title, detail) => { sent.push({ kind: 'alert', key, title, detail }); } };
  };

  async function start(extra = {}) {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-slack-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    const store = new FileStore(path.join(tmpDir, 's.json'));
    const { app } = await createApp({
      storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, slack: fakeSlack(),
      siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c', ...extra
    });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    return store;
  }

  afterEach(async () => {
    if (server) await new Promise(r => server.close(r));
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    server = null; tmpDir = null;
  });

  it('pings on a new event submission', async () => {
    await start();
    const r = await fetch(baseUrl + '/api/submissions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Live Music at the Dive', date: '2026-05-12', time: '7:00 PM', venue: 'The Dive Bar', address: '123 Main St',
        description: 'A test event.', submitter_kind: 'organizer', submitter_first_name: 'Jane', submitter_last_name: 'Tester',
        submitter_name: 'Jane Tester', submitter_email: 'jane@example.com', submitter_phone: '(361) 555-0123', elapsed_ms: 5000
      })
    });
    expect(r.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'notify', title: '📝 New event submitted' });
    expect(sent[0].fields.find(f => f[0] === 'Event')[1]).toBe('Live Music at the Dive');
  });

  it('pings when a sponsor pays and alerts when Stripe checkout fails', async () => {
    const store = await start({
      stripeSecretKey: 'sk_test', stripeWebhookSecret: 'whsec_test', now: () => new Date('2026-10-07T15:00:00Z'),
      stripe: { createCheckoutSession: async () => { throw new Error('card network down'); } }
    });
    const form = new URLSearchParams({ package: 'weekly', week: '2026-10-12', business: 'Acme', text: 'Hi.', url: 'acme.example', email: 'a@acme.example' });
    const bad = await fetch(baseUrl + '/advertise/checkout', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    expect(bad.status).toBe(502);
    expect(sent.find(m => m.kind === 'alert').key).toBe('stripe-checkout');

    await store.saveSponsorOrder({ id: 'o1', kind: 'weekly', status: 'pending', week_start: '2026-10-12', business: 'Acme', email: 'a@acme.example', amount: 30000, created_at: '2026-10-07T15:00:00Z', sponsor: { name: 'Acme' } });
    const raw = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', client_reference_id: 'o1', payment_status: 'paid', amount_total: 30000 } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${raw}`).digest('hex');
    await fetch(baseUrl + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body: raw });
    const paid = sent.find(m => m.kind === 'notify' && m.title.startsWith('💰'));
    expect(paid.title).toBe('💰 New sponsor: Acme');
    expect(paid.fields.find(f => f[0] === 'Paid')[1]).toBe('$300');
  });
});

describe('contact form', () => {
  let tmpDir, server, baseUrl, sent;
  afterEach(async () => {
    if (server) await new Promise(r => server.close(r));
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    server = null; tmpDir = null;
  });

  it('sends messages to Slack and publishes no email address', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-contact-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    sent = [];
    const { app } = await createApp({
      storeBundle: { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) }, eventsFile, trustProxy: false,
      siteUrl: 'https://www.thevic361.com', slack: { enabled: true, notify: async (m) => { sent.push(m); return true; }, alert: async () => {} }
    });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const ad = await (await fetch(baseUrl + '/advertise')).text();
    expect(ad).toContain('/contact?topic=advertising');
    expect(ad).not.toMatch(/mailto:|@gmail\.com/);
    expect(await (await fetch(baseUrl + '/contact?topic=advertising')).text()).toContain('value="advertising" selected');

    const post = (f) => fetch(baseUrl + '/contact', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f).toString() });
    const bad = await post({ name: 'Ann', email: 'nope', message: 'hello there' });
    expect(bad.status).toBe(400);
    expect(sent).toHaveLength(0);

    const ok = await post({ topic: 'advertising', name: 'Ann', email: 'Ann@Shop.example', business: 'Ann’s Shop', message: 'How much is a sponsor week?' });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Message sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('✉️ Website message: Advertising or sponsorship');
    expect(sent[0].fields).toContainEqual(['Email', 'ann@shop.example']);

    await post({ name: 'Bot', email: 'b@b.example', message: 'spam spam', company: 'x' });
    expect(sent).toHaveLength(1);
  });
});
