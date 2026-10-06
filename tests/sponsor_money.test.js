// @vitest-environment node
//
// Money-path fixes in server/sponsors.js: webhooks serialized under the
// booking lock, no regression of a failed payment to 'processing', bookings
// that fail closed on a database error, confirmation emails retried by the
// periodic run, card-only checkout while a bank debit could settle late,
// the make-good when a debit clears after its week's newsletter, and
// bounded, shared Vic's Pick pin lookups.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { createSponsors, instantOnly } from '../server/sponsors.js';

const NOW = new Date('2026-10-07T15:00:00Z'); // Wed Oct 7
let tmpDir, server, baseUrl;

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

async function newStore() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-money-'));
  return new FileStore(path.join(tmpDir, 's.json'));
}

function setup(store, { now = () => NOW, mailer = null, slack = null } = {}) {
  return createSponsors({
    store, siteUrl: 'https://www.thevic361.com', nowFn: now, getVenues: () => [],
    config: { enabled: true, webhookSecret: 'whsec' }, stripe: {}, slack, mailer, mailAddress: '1 Main St'
  });
}

const order = (extra = {}) => ({
  id: 'o1', kind: 'weekly', status: 'pending', email: 'a@acme.example', business: 'Acme', amount: 30000,
  created_at: NOW.toISOString(), session_id: 'cs_1', week_start: '2026-10-19',
  sponsor: { name: 'Acme', text: 'Tacos.', url: 'https://acme.example', cta: 'Order' }, ...extra
});
const pick = (extra = {}) => order({
  kind: 'featured', week_start: undefined, sponsor: undefined, amount: 4900,
  event: { date: '2026-10-10', name: 'Fall Fair', time: '9 AM', venue: 'Plaza', address: 'X', description: 'Fun.' }, ...extra
});
const ev = (type, o, extra = {}) => ({ type, data: { object: { id: o.session_id, client_reference_id: o.id, ...extra } } });
const paidEvent = (o, type = 'checkout.session.completed') => ev(type, o, { payment_status: 'paid', amount_total: o.amount });

const recorder = () => {
  const alerts = [];
  return { alerts, slack: { notify: () => {}, alert: (key, title, text) => alerts.push({ key, title, text }) } };
};

describe('webhooks are processed one at a time', () => {
  it('a duplicate delivery arriving at the same moment fulfils a Vic’s Pick once', async () => {
    const store = await newStore();
    const sp = setup(store);
    await store.saveSponsorOrder(pick());
    await Promise.all([sp.processEvent(paidEvent(pick())), sp.processEvent(paidEvent(pick()))]);
    expect((await store.list({})).filter(r => r.source === 'paid-feature')).toHaveLength(1);
  });

  it('two weekly orders for one week settling together: only one goes live', async () => {
    const store = await newStore();
    const sp = setup(store);
    const a = order({ id: 'a', session_id: 'cs_a', status: 'processing' });
    const b = order({ id: 'b', session_id: 'cs_b', status: 'processing', email: 'b@b.example' });
    await store.saveSponsorOrder(a);
    await store.saveSponsorOrder(b);
    await Promise.all([sp.processEvent(paidEvent(a, 'checkout.session.async_payment_succeeded')),
      sp.processEvent(paidEvent(b, 'checkout.session.async_payment_succeeded'))]);
    const statuses = (await store.listSponsorOrders()).map(o => o.status).sort();
    expect(statuses).toEqual(['conflict', 'paid']);
  });
});

describe('a failed bank payment stays failed', () => {
  it('a late or replayed unpaid "completed" event doesn’t move it back to processing', async () => {
    const store = await newStore();
    const sp = setup(store);
    await store.saveSponsorOrder(order({ status: 'failed' }));
    await sp.processEvent(ev('checkout.session.completed', order(), { payment_status: 'unpaid' }));
    expect((await store.listSponsorOrders())[0].status).toBe('failed');
    // A real payment still revives it.
    await sp.processEvent(paidEvent(order(), 'checkout.session.async_payment_succeeded'));
    expect((await store.listSponsorOrders())[0].status).toBe('paid');
  });

  it('an open checkout still moves to processing', async () => {
    const store = await newStore();
    const sp = setup(store);
    await store.saveSponsorOrder(order());
    await sp.processEvent(ev('checkout.session.completed', order(), { payment_status: 'unpaid' }));
    expect((await store.listSponsorOrders())[0].status).toBe('processing');
  });
});

describe('confirmation emails are retried until they send', () => {
  it('a card payment whose "you’re booked" failed is sent by the periodic run, then alerts after repeated failures', async () => {
    const store = await newStore();
    let up = false;
    const sent = [];
    const mailer = { enabled: true, send: async (to, mail, key) => { if (!up) return false; sent.push({ to, key }); return true; } };
    const { alerts, slack } = recorder();
    const sp = setup(store, { mailer, slack });
    await store.saveSponsorOrder(order());
    await sp.processEvent(paidEvent(order()));                     // the only webhook a card checkout gets
    expect((await store.listSponsorOrders())[0]).toMatchObject({ status: 'paid', confirmation_failures: 1 });
    await sp.sendSponsorReports(NOW);
    await sp.sendSponsorReports(NOW);
    expect(alerts.filter(a => a.key === 'sponsor-confirmation-failed:o1')).toHaveLength(1);
    up = true;
    await sp.sendSponsorReports(NOW);
    expect(sent).toEqual([{ to: 'a@acme.example', key: 'vic361-sponsor-o1' }]);
    expect((await store.listSponsorOrders())[0].confirmation_sent).toBeTruthy();
    await sp.sendSponsorReports(NOW);
    expect(sent).toHaveLength(1);
  });

  it('old orders and ones no longer paid aren’t retried', async () => {
    const store = await newStore();
    const sent = [];
    const mailer = { enabled: true, send: async (to) => { sent.push(to); return true; } };
    const sp = setup(store, { mailer });
    await store.saveSponsorOrder(order({ id: 'old', status: 'paid', paid_at: '2026-09-01T00:00:00Z' }));
    await store.saveSponsorOrder(order({ id: 'ref', status: 'refunded', paid_at: NOW.toISOString() }));
    await sp.sendSponsorReports(NOW);
    expect(sent).toEqual([]);
  });
});

describe('bank debits close to the date', () => {
  it('cards only until 10 days out, since ACH can take a week to clear', () => {
    expect(instantOnly(pick({ event: { date: '2026-10-15' } }), NOW)).toBe(true);   // 8 days
    expect(instantOnly(order({ week_start: '2026-10-12' }), NOW)).toBe(true);
    expect(instantOnly(order({ week_start: '2026-10-19' }), NOW)).toBe(false);      // 12 days
  });

  it('a weekly debit that clears after its week’s newsletter went out alerts for a make-good and doesn’t promise the issue', async () => {
    const store = await newStore();
    const sent = [];
    const mailer = { enabled: true, send: async (to, mail) => { sent.push(mail); return true; } };
    const { alerts, slack } = recorder();
    const clock = new Date('2026-10-19T18:00:00Z'); // Monday afternoon of the week
    const sp = setup(store, { mailer, slack, now: () => clock });
    await store.saveSponsorOrder(order({ status: 'processing' }));
    await store.recordNewsletterSend({ week_key: '2026-10-19', recipients: 500, subject: 'x' });
    await sp.processEvent(paidEvent(order(), 'checkout.session.async_payment_succeeded'));
    const saved = (await store.listSponsorOrders())[0];
    expect(saved.status).toBe('paid');
    expect(saved.newsletter_missed).toBeTruthy();
    expect(alerts.some(a => a.key === 'sponsor-newsletter-missed:o1')).toBe(true);
    expect(sent[0].text).not.toMatch(/top of that Monday’s newsletter/);
    expect(sent[0].text).toMatch(/wasn’t in it/);
  });
});

describe('Vic’s Pick pins on the page-view path', () => {
  it('look up only picks that can still show or be reported on, once for concurrent requests', async () => {
    const store = await newStore();
    const sp = setup(store);
    for (const [id, date] of [['past', '2026-03-01'], ['soon', '2026-10-10']]) {
      await store.insert({ id: `sub-${id}`, status: 'approved', source: 'paid-feature', created_at: NOW.toISOString(),
        payload: { date, name: 'Fair', time: '9 AM', venue: 'Plaza' } });
      await store.saveSponsorOrder(pick({ id, status: 'paid', submission_id: `sub-${id}`, event: { date, name: 'Fair' } }));
    }
    const gets = [];
    const get = store.get.bind(store);
    store.get = async id => { gets.push(id); return get(id); };
    const payload = { events: [{ date: '2026-10-10', name: 'Fair', time: '9 AM', venue: 'Plaza' }] };
    const [a, b] = await Promise.all([sp.apply(payload), sp.apply(payload)]);
    expect(a.events[0].featured).toBe(true);
    expect(b.events[0].featured).toBe(true);
    expect(gets).toEqual(['sub-soon']);
  });
});

describe('booking fails closed', () => {
  it('a database error while booking shows "try again" instead of selling a sold week', async () => {
    const store = await newStore();
    await store.saveSponsorOrder(order({ status: 'paid', paid_at: NOW.toISOString() }));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    const sessions = [];
    const { app } = await createApp({
      storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
      siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c',
      stripeSecretKey: 'sk_test', stripeWebhookSecret: 'whsec', resendApiKey: '',
      stripe: { createCheckoutSession: async (params) => { sessions.push(params); return { id: 'cs_x', url: 'https://checkout.stripe.com/x' }; } }
    });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    store.listSponsorOrders = async () => { throw new Error('statement timeout'); };
    const r = await fetch(baseUrl + '/advertise/checkout', {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ package: 'weekly', week: '2026-10-19', business: 'Beta', text: 'Hi.', url: 'b.example', email: 'b@b.example' }).toString()
    });
    expect(r.status).toBe(503);
    expect(await r.text()).toMatch(/try again/i);
    expect(sessions).toHaveLength(0);
  });
});

