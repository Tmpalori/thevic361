// @vitest-environment node
//
// Sponsor checkout (server/sponsors.js). Stripe is a recording fake and
// webhooks are signed locally with the test secret; nothing is charged.

import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { sameEvent, verifyStripeSignature, formEncode, bookableWeeks } from '../server/sponsors.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = new Date('2026-10-07T15:00:00Z'); // Wed Oct 7; this week starts Mon Oct 5
const WHSEC = 'whsec_test';

const EVENTS = [
  { date: '2026-10-09', name: 'Friday Live Music', time: '8:00 PM', venue: 'Aero Crafters' },
  { date: '2026-10-10', name: 'Fall Festival at De Leon Plaza', time: '10:00 AM', venue: 'De Leon Plaza' },
  { date: '2026-10-10', name: 'Trivia Night', time: '7:00 PM', venue: 'Somewhere Else' }
];
const VENUES = [
  { name: 'Aero Crafters', category: 'Bar / Live Music' },
  { name: 'De Leon Plaza', category: 'Park' }
];

let tmpDir, server, baseUrl, store, sessions;

function fakeStripe() {
  sessions = [];
  return {
    createCheckoutSession: async (params, key) => {
      const id = `cs_test_${sessions.length + 1}`;
      sessions.push({ params, key, id });
      return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
    }
  };
}

async function startApp(extra = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-sp-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  const venuesFile = path.join(tmpDir, 'venues.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: EVENTS, sponsor: { name: 'Manual Sponsor', text: 'Set by hand.' } }));
  await fs.writeFile(venuesFile, JSON.stringify(VENUES));
  store = new FileStore(path.join(tmpDir, 's.json'));
  const { app } = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, venuesFile, trustProxy: false, now: () => NOW,
    siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c',
    stripeSecretKey: 'sk_test', stripeWebhookSecret: WHSEC, stripe: fakeStripe(), resendApiKey: '', ...extra
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

const form = (fields) => fetch(baseUrl + '/advertise/checkout', {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString()
});

function webhook(event, secret = WHSEC) {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return fetch(baseUrl + '/api/stripe/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body: raw
  });
}

const completed = (s, extra = {}) => webhook({
  type: 'checkout.session.completed',
  data: { object: { id: s.id, client_reference_id: s.params.client_reference_id, payment_status: 'paid', amount_total: s.params.line_items[0].price_data.unit_amount, ...extra } }
});

async function auth() {
  const r = await fetch(baseUrl + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'b' })
  });
  return { Authorization: `Bearer ${(await r.json()).token}`, 'Content-Type': 'application/json' };
}

const publicEvents = async () => (await fetch(baseUrl + '/events.json')).json();

describe('helpers', () => {
  it('matches the same event by date and name', () => {
    expect(sameEvent({ date: '2026-10-10', name: 'Fall Festival' }, { date: '2026-10-10', name: 'Fall Festival at De Leon Plaza' })).toBe(true);
    expect(sameEvent({ date: '2026-10-10', name: 'Fall Festival' }, { date: '2026-10-11', name: 'Fall Festival' })).toBe(false);
    expect(sameEvent({ date: '2026-10-10', name: 'Fall Festival' }, { date: '2026-10-10', name: 'Trivia Night' })).toBe(false);
  });

  it('verifies Stripe signatures and rejects stale or forged ones', () => {
    const raw = '{"a":1}';
    const t = 1000;
    const sig = crypto.createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex');
    expect(verifyStripeSignature(raw, `t=${t},v1=${sig}`, WHSEC, t + 10)).toBe(true);
    expect(verifyStripeSignature(raw, `t=${t},v1=${sig}`, WHSEC, t + 1000)).toBe(false);
    expect(verifyStripeSignature(raw, `t=${t},v1=${sig}`, 'other', t)).toBe(false);
    expect(verifyStripeSignature('{"a":2}', `t=${t},v1=${sig}`, WHSEC, t)).toBe(false);
  });

  it('form-encodes nested params the way Stripe expects', () => {
    const s = formEncode({ line_items: [{ quantity: 1, price_data: { unit_amount: 4900 } }], skip: undefined }).toString();
    expect(decodeURIComponent(s)).toBe('line_items[0][quantity]=1&line_items[0][price_data][unit_amount]=4900');
  });

  it('offers the next 8 weeks, starting next Monday', () => {
    const w = bookableWeeks(NOW, []);
    expect(w).toHaveLength(8);
    expect(w[0].start).toBe('2026-10-12');
  });
});

describe('advertise page', () => {
  it('shows Buy now only when Stripe is configured', async () => {
    await startApp();
    expect(await (await fetch(baseUrl + '/advertise')).text()).toContain('/advertise/checkout?package=weekly');
    await new Promise(r => server.close(r)); server = null;
    await fs.rm(tmpDir, { recursive: true, force: true });
    await startApp({ stripeWebhookSecret: '' });
    expect(await (await fetch(baseUrl + '/advertise')).text()).not.toContain('Buy now');
    const r = await fetch(baseUrl + '/advertise/checkout?package=weekly', { redirect: 'manual' });
    expect(r.status).toBe(302);
  });
});

describe('weekly sponsor', () => {
  it('checkout → Stripe → webhook puts the block live for that week, and holds the week', async () => {
    await startApp();
    const page = await (await fetch(baseUrl + '/advertise/checkout?package=weekly')).text();
    expect(page).toContain('value="2026-10-12"');

    const bad = await form({ package: 'weekly', email: 'x', week: '2026-10-12' });
    expect(bad.status).toBe(400);
    expect(sessions).toHaveLength(0);

    const r = await form({
      package: 'weekly', week: '2026-10-12', business: 'Acme Tacos', text: 'Best tacos in town.',
      url: 'acme.example', cta: 'Order', email: 'Owner@Acme.example'
    });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    const s = sessions[0];
    expect(s.params).toMatchObject({ mode: 'payment', customer_email: 'owner@acme.example' });
    expect(s.params.line_items[0].price_data.unit_amount).toBe(30000);
    expect(s.key).toBe(`vic361-order-${s.params.client_reference_id}`);

    // While that buyer is paying, the week can't be sold again.
    const dup = await form({ package: 'weekly', week: '2026-10-12', business: 'B', text: 'x', url: 'b.example', email: 'b@b.example' });
    expect(dup.status).toBe(400);
    expect(await dup.text()).toContain('just booked');

    expect((await webhook({ type: 'checkout.session.completed', data: { object: {} } }, 'wrong')).status).toBe(400);
    expect((await completed(s)).status).toBe(200);
    const [order] = await store.listSponsorOrders();
    expect(order.status).toBe('paid');

    // Not this week (it's booked for next week), so the manual sponsor stays.
    expect((await publicEvents()).sponsor.name).toBe('Manual Sponsor');
    const thanks = await (await fetch(`${baseUrl}/advertise/thanks?order=${order.id}`)).text();
    expect(thanks).toContain('October 12');
  });

  it('a paid sponsor for the current week replaces the sponsor everywhere', async () => {
    await startApp();
    await store.saveSponsorOrder({
      id: 'o1', kind: 'weekly', status: 'paid', week_start: '2026-10-05', created_at: '2026-10-01T00:00:00Z',
      sponsor: { name: 'Acme Tacos', text: 'Best tacos.', cta: 'Order', url: 'https://acme.example' }
    });
    expect((await publicEvents()).sponsor.name).toBe('Acme Tacos');
    expect(await (await fetch(baseUrl + '/this-weekend')).text()).toContain('Acme Tacos');

    const h = await auth();
    const hide = await fetch(baseUrl + '/api/admin/sponsors/o1', { method: 'POST', headers: h, body: JSON.stringify({ action: 'hide' }) });
    expect(hide.status).toBe(200);
    expect((await publicEvents()).sponsor.name).toBe('Manual Sponsor');
    await fetch(baseUrl + '/api/admin/sponsors/o1', { method: 'POST', headers: h, body: JSON.stringify({ action: 'restore' }) });
    expect((await publicEvents()).sponsor.name).toBe('Acme Tacos');
  });
});

describe('featured event', () => {
  it('paid order lands in the review queue and features the matching live event', async () => {
    await startApp();
    const r = await form({
      package: 'featured', event_name: 'Fall Festival', date: '2026-10-10', time: '10 AM', venue: 'De Leon Plaza',
      address: '101 N Main St', description: 'Food, music, rides.', business: 'Main Street', email: 'ms@example.com'
    });
    expect(r.status).toBe(303);
    expect(sessions[0].params.line_items[0].price_data.unit_amount).toBe(4900);
    await completed(sessions[0]);

    const subs = await store.list({});
    const sub = subs.find(x => x.source === 'paid-feature');
    expect(sub).toBeTruthy();
    expect(sub.payload.name).toBe('Fall Festival');

    const ev = (await publicEvents()).events.find(e => e.name.startsWith('Fall Festival'));
    expect(ev.featured).toBe(true);
    expect((await publicEvents()).events.find(e => e.name === 'Trivia Night').featured).toBeFalsy();

    // Replayed webhook doesn't create a second submission.
    await completed(sessions[0]);
    expect((await store.list({})).filter(x => x.source === 'paid-feature')).toHaveLength(1);
  });

  it('rejects past dates', async () => {
    await startApp();
    const r = await form({
      package: 'featured', event_name: 'Old Show', date: '2026-10-01', time: '7 PM', venue: 'X',
      address: 'Y', description: 'Z', business: 'B', email: 'b@example.com'
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('That date has passed');
  });
});

describe('venue partner', () => {
  it('subscription features every event at the venue until it is cancelled', async () => {
    await startApp();
    const r = await form({ package: 'partner', venue: 'aero-crafters', business: 'Aero Crafters', email: 'aero@example.com' });
    expect(r.status).toBe(303);
    const s = sessions[0];
    expect(s.params.mode).toBe('subscription');
    expect(s.params.line_items[0].price_data.recurring).toEqual({ interval: 'month' });
    await completed(s, { subscription: 'sub_123' });

    const featuredNames = async () => (await publicEvents()).events.filter(e => e.featured).map(e => e.name);
    expect(await featuredNames()).toEqual(['Friday Live Music']);

    // A second purchase for the same venue is refused.
    expect((await form({ package: 'partner', venue: 'aero-crafters', business: 'Aero', email: 'a@example.com' })).status).toBe(400);

    await webhook({ type: 'customer.subscription.updated', data: { object: { id: 'sub_123', status: 'past_due' } } });
    expect(await featuredNames()).toEqual([]);
    await webhook({ type: 'customer.subscription.updated', data: { object: { id: 'sub_123', status: 'active' } } });
    expect(await featuredNames()).toEqual(['Friday Live Music']);
    await webhook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_123', status: 'canceled' } } });
    expect(await featuredNames()).toEqual([]);
    expect((await store.listSponsorOrders())[0].status).toBe('cancelled');
  });
});

describe('admin', () => {
  it('lists orders and the week calendar', async () => {
    await startApp();
    await form({ package: 'weekly', week: '2026-10-19', business: 'Acme', text: 'Hi.', url: 'acme.example', email: 'a@acme.example' });
    await completed(sessions[0]);
    const d = await (await fetch(baseUrl + '/api/admin/sponsors', { headers: await auth() })).json();
    expect(d).toMatchObject({ ok: true, configured: true });
    expect(d.orders).toHaveLength(1);
    expect(d.weeks.find(w => w.start === '2026-10-19').available).toBe(false);
    expect((await fetch(baseUrl + '/api/admin/sponsors')).status).toBe(401);
  });
});

describe('booking safety', () => {
  const weekly = (who) => ({ package: 'weekly', week: '2026-10-19', business: who, text: 'x', url: `${who}.example`, email: `${who}@x.example` });

  it('two buyers hitting the same week at once: only one gets a checkout', async () => {
    await startApp();
    const [a, b] = await Promise.all([form(weekly('alpha')), form(weekly('beta'))]);
    expect([a.status, b.status].sort()).toEqual([303, 400]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].params.payment_method_types).toEqual(['card']);
  });

  it('a second payment for a sold week is flagged for refund, not put live', async () => {
    await startApp();
    await form(weekly('alpha'));
    const first = sessions[0];
    await completed(first);
    // Second buyer's order sneaks in (e.g. an old hold) and pays too.
    const id = 'late-order';
    await store.saveSponsorOrder({ id, kind: 'weekly', week_start: '2026-10-19', business: 'Late', email: 'l@x.example', status: 'pending', created_at: NOW.toISOString(), amount: 30000 });
    expect((await completed({ id: 'cs_late', params: { client_reference_id: id, line_items: [{ price_data: { unit_amount: 30000 } }] } })).status).toBe(200);
    const late = (await store.listSponsorOrders()).find(o => o.id === id);
    expect(late.status).toBe('conflict');
  });

  it('a refund takes the placement down', async () => {
    await startApp();
    await form(weekly('alpha'));
    await completed(sessions[0], { payment_intent: 'pi_123' });
    await webhook({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_123', refunded: true } } });
    const [order] = await store.listSponsorOrders();
    expect(order.status).toBe('refunded');
  });

  it('a Stripe failure releases the hold', async () => {
    await startApp({ stripe: { createCheckoutSession: async () => { throw new Error('down'); } } });
    expect((await form(weekly('alpha'))).status).toBe(502);
    const [order] = await store.listSponsorOrders();
    expect(order.status).toBe('failed');
    const page = await (await fetch(baseUrl + '/advertise/checkout?package=weekly')).text();
    expect(page).toContain('value="2026-10-19"');
    expect(page).not.toMatch(/value="2026-10-19"[^>]*disabled/);
  });
});

describe('same event matching', () => {
  it('same name at two different venues is two events', () => {
    expect(sameEvent({ date: '2026-10-10', name: 'Live Music', venue: 'Moonshine Drinkery' },
      { date: '2026-10-10', name: 'Live Music', venue: 'Aero Crafters' })).toBe(false);
    expect(sameEvent({ date: '2026-10-10', name: 'Live Music', venue: 'Moonshine Drinkery' },
      { date: '2026-10-10', name: 'Live Music', venue: 'Moonshine Drinkery Victoria' })).toBe(true);
    expect(sameEvent({ date: '2026-10-10', name: 'Live Music', venue: '' },
      { date: '2026-10-10', name: 'Live Music', venue: 'Aero Crafters' })).toBe(true);
  });
});
