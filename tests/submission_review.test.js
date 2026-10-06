// @vitest-environment node
//
// AI review of free submissions (server/submissionReview.js): the secret
// endpoints, what the AI may change, publishing approved ones without the
// submitter's contact details, and leaving admin-touched rows alone.

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { applyCleanup, awaitingReview } from '../server/submissionReview.js';
import { applyPlacements } from '../server/sponsors.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = new Date('2026-10-05T17:00:00Z');
let tmpDir, server, baseUrl, store, sent;

const PAYLOAD = {
  name: 'FALL CRAFT FAIR!!!', date: '2026-10-10', time: '9:00 AM', end_time: '', venue: 'Community Center',
  address: '2905 E North St, Victoria, TX', url: '', description: 'COME OUT!!! crafts vendors food 🎉🎉',
  icons: ['shopping'], free: false,
  submitter_first_name: 'Pat', submitter_last_name: 'Doe', submitter_phone: '(361) 555-1234'
};

function row(id, extra = {}) {
  return {
    id, created_at: NOW.toISOString(), updated_at: NOW.toISOString(), status: 'pending', source: 'submission',
    submitter_kind: 'organizer', submitter_name: 'Pat Doe', submitter_email: 'pat@example.com', submitter_ip: '1.2.3.4',
    user_agent: 'x', payload: { ...PAYLOAD }, admin_notes: '',
    review_history: [{ at: NOW.toISOString(), action: 'submitted', note: 'Public submission' }], ...extra
  };
}

async function startApp(extra = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-review-'));
  store = new FileStore(path.join(tmpDir, 's.json'));
  await store.setPublished({ last_updated: 'x', events: [] });
  const candidatesFile = path.join(tmpDir, 'candidates.json');
  await fs.writeFile(candidatesFile, JSON.stringify({ last_updated: 'c1', events: [
    { date: '2026-10-12', name: 'Collector Candidate', time: '7:00 PM', venue: 'Somewhere' }] }));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  sent = [];
  const resend = { send: async (msg, key) => { sent.push({ ...msg, key }); return { id: 'e' }; }, batch: async () => ({ data: [] }) };
  const { app } = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, candidatesFile, trustProxy: false, now: () => NOW,
    siteUrl: 'https://www.thevic361.com', submissionReviewSecret: 'review-secret', autoPublish: false,
    resendApiKey: 're_test', resend, adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c', ...extra
  });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

const H = (secret = 'review-secret') => ({ 'Content-Type': 'application/json', 'X-Cron-Secret': secret });
const pending = (secret) => fetch(baseUrl + '/api/submission-review/pending', { headers: H(secret) });
const review = (reviews, secret) => fetch(baseUrl + '/api/submission-review', { method: 'POST', headers: H(secret), body: JSON.stringify({ reviews }) });
const CLEAN = { name: 'Fall Craft Fair', description: 'Local crafters and food vendors.', icons: ['shopping', 'food'] };

describe('submission review: what the AI may change', () => {
  it('applies only name, description and icons, validated like an admin edit', () => {
    const out = applyCleanup(PAYLOAD, { ...CLEAN, date: '2030-01-01', venue: 'Elsewhere', icons: ['food', 'bogus'], submitter_phone: 'x' });
    expect(out.payload).toMatchObject({ name: 'Fall Craft Fair', description: 'Local crafters and food vendors.', icons: ['food'],
      date: '2026-10-10', venue: 'Community Center', submitter_phone: '(361) 555-1234' });
    expect(out.changes).toEqual(['name', 'description', 'icons']);
    expect(applyCleanup(PAYLOAD, {}).changes).toEqual([]);
    expect(applyCleanup(PAYLOAD, { name: 'x' }).error).toMatch(/too short/);
  });

  it('only rows nobody has touched are waiting', () => {
    expect(awaitingReview(row('a'))).toBe(true);
    expect(awaitingReview(row('a', { ai_review: { decision: 'flag' } }))).toBe(false);
    expect(awaitingReview(row('a', { source: 'paid-feature' }))).toBe(true);
    expect(awaitingReview(row('a', { source: 'admin' }))).toBe(false);
    expect(awaitingReview(row('a', { review_history: [{ action: 'submitted' }, { action: 'reminder' }] }))).toBe(true);
    expect(awaitingReview(row('a', { review_history: [{ action: 'submitted' }, { action: 'edit' }] }))).toBe(false);
    expect(awaitingReview(row('a', { status: 'approved' }))).toBe(false);
  });
});

describe('submission review: endpoints', () => {
  it('need the secret, and list waiting submissions without contact details', async () => {
    await startApp();
    await store.insert(row('s1'));
    await store.insert(row('s2', { source: 'paid-feature' }));
    await store.insert(row('s3', { source: 'admin' }));
    expect((await pending('nope')).status).toBe(401);
    expect((await review([], '')).status).toBe(401);
    const body = await (await pending()).json();
    expect(body.submissions.map(s => [s.id, s.paid]).sort()).toEqual([['s1', false], ['s2', true]]);
    const text = JSON.stringify(body);
    for (const secret of ['pat@example.com', '555-1234', 'Doe', '1.2.3.4']) expect(text).not.toContain(secret);
  });

  it('is closed when no secret is configured', async () => {
    await startApp({ submissionReviewSecret: '' });
    expect((await pending('')).status).toBe(401);
  });

  it('approve: tidies, publishes without the submitter, emails "you\'re live", and only once', async () => {
    await startApp();
    await store.insert(row('s1'));
    const r = await review([{ id: 's1', decision: 'approve', reason: '', cleaned: CLEAN }]);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ done: [{ id: 's1', decision: 'approve', changes: ['name', 'description', 'icons'] }], published: true });

    const saved = await store.get('s1');
    expect(saved.status).toBe('approved');
    expect(saved.payload.name).toBe('Fall Craft Fair');
    expect(saved.ai_review.original.name).toBe('FALL CRAFT FAIR!!!');
    expect(saved.admin_notes).toMatch(/AI review \(approved\)/);

    const feed = await (await fetch(baseUrl + '/events.json')).json();
    const ev = feed.events.find(e => e.name === 'Fall Craft Fair');
    expect(ev).toBeTruthy();
    expect(JSON.stringify(feed)).not.toMatch(/submitter_|555-1234|Pat/);
    expect((await store.getPublished()).events[0]).not.toHaveProperty('submitter_phone');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ['pat@example.com'], subject: "You're live: Fall Craft Fair", key: 'vic361-submission-live-s1' });
    expect(sent[0].html).toContain(`https://www.thevic361.com${ev.page}`);

    const again = await (await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }])).json();
    expect(again.skipped).toEqual([{ id: 's1', why: 'not-awaiting-review' }]);
    expect(sent).toHaveLength(1);
  });

  it('flag: stays pending with the reason and the suggestion; the submitter\'s words are kept', async () => {
    await startApp();
    await store.insert(row('s1'));
    await review([{ id: 's1', decision: 'flag', reason: 'looks like a private party', cleaned: CLEAN }]);
    const saved = await store.get('s1');
    expect(saved.status).toBe('pending');
    expect(saved.payload.name).toBe('FALL CRAFT FAIR!!!');
    expect(saved.admin_notes).toMatch(/looks like a private party.*Suggested: name “Fall Craft Fair”/);
    expect((await pending()).ok && (await (await pending()).json()).submissions).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('reject and duplicate set the status; nothing is published or emailed', async () => {
    await startApp();
    await store.insert(row('s1'));
    await store.insert(row('s2', { payload: { ...PAYLOAD, name: 'Something Else' } }));
    await review([{ id: 's1', decision: 'reject', reason: 'spam' }, { id: 's2', decision: 'duplicate', reason: 'already live' }]);
    expect((await store.get('s1')).status).toBe('rejected');
    expect((await store.get('s2')).status).toBe('duplicate');
    expect((await store.getPublished()).events).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('SUBMISSION_AUTOAPPROVE=0 turns approvals into flags', async () => {
    await startApp({ submissionAutoApprove: false });
    await store.insert(row('s1'));
    const body = await (await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }])).json();
    expect(body.done[0].decision).toBe('flag');
    expect((await store.get('s1')).status).toBe('pending');
  });

  it('an invalid cleanup is flagged instead of approved', async () => {
    await startApp();
    await store.insert(row('s1'));
    const body = await (await review([{ id: 's1', decision: 'approve', cleaned: { name: 'x' } }])).json();
    expect(body.done[0].decision).toBe('flag');
    expect((await store.get('s1')).status).toBe('pending');
  });

  it('refuses too many at once', async () => {
    await startApp();
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `x${i}`, decision: 'flag' }));
    expect((await review(many)).status).toBe(400);
  });
});

describe('submission review: publishing safely', () => {
  async function auth() {
    const r = await fetch(baseUrl + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'a', password: 'b' }) });
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${(await r.json()).token}` };
  }

  it('an approval publishes only the submission, never the collector candidates', async () => {
    await startApp();
    await store.insert(row('s1'));
    await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }]);
    expect((await store.getPublished()).events.map(e => e.name)).toEqual(['Fall Craft Fair']);
  });

  it('a past date is flagged, not approved', async () => {
    await startApp();
    await store.insert(row('s1', { payload: { ...PAYLOAD, date: '2026-10-01' } }));
    const body = await (await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }])).json();
    expect(body.done[0]).toMatchObject({ decision: 'flag' });
    expect(body.done[0].reason).toMatch(/already passed/);
  });

  it('no "you\'re live" email when it didn\'t go live (the admin removed it before)', async () => {
    await startApp();
    await store.setPublished({ last_updated: 'x', events: [], auto_publish: { rejected: ['2026-10-10|Fall Craft Fair|Community Center'] } });
    await store.insert(row('s1'));
    const body = await (await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }])).json();
    expect(body.done[0]).toMatchObject({ decision: 'approve', live: false });
    expect(sent).toHaveLength(0);
  });

  it('rejecting an approved submission in admin takes it off the site, for good', async () => {
    await startApp();
    await store.insert(row('s1'));
    await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }]);
    const r = await fetch(baseUrl + '/api/admin/submissions/s1', { method: 'POST', headers: await auth(), body: JSON.stringify({ status: 'rejected' }) });
    expect((await r.json()).unpublished).toBe(true);
    const pub = await store.getPublished();
    expect(pub.events).toEqual([]);
    expect(pub.auto_publish.rejected).toContain('2026-10-10|Fall Craft Fair|Community Center');
  });

  it('Save & Publish from a stale page is refused instead of dropping what went live meanwhile', async () => {
    await startApp();
    const h = await auth();
    const before = await (await fetch(baseUrl + '/api/admin/published-events', { headers: h })).json();
    await store.insert(row('s1'));
    await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }]);
    const stale = await fetch(baseUrl + '/api/admin/publish-events', { method: 'POST', headers: h,
      body: JSON.stringify({ events: [], based_on: before.last_updated }) });
    expect(stale.status).toBe(409);
    expect((await store.getPublished()).events.map(e => e.name)).toEqual(['Fall Craft Fair']);
    const now = await (await fetch(baseUrl + '/api/admin/published-events', { headers: h })).json();
    const ok = await fetch(baseUrl + '/api/admin/publish-events', { method: 'POST', headers: h,
      body: JSON.stringify({ events: now.events, based_on: now.last_updated }) });
    expect(ok.status).toBe(200);
  });
});

async function adminAuth() {
  const r = await fetch(baseUrl + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'a', password: 'b' }) });
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${(await r.json()).token}` };
}
const admin = async (id, body) => (await fetch(baseUrl + `/api/admin/submissions/${id}`, {
  method: 'POST', headers: await adminAuth(), body: JSON.stringify(body) })).json();

describe('admin approve and edit keep the site in step', () => {
  const edit = (p) => ({ ...p, submitter_email: 'pat@example.com' });

  it('approving a flagged submission by hand publishes it now and emails "you\'re live"', async () => {
    await startApp();
    await store.insert(row('s1'));
    await review([{ id: 's1', decision: 'flag', reason: 'check it' }]);
    const body = await admin('s1', { status: 'approved' });
    expect(body).toMatchObject({ ok: true, published: true, live: true });
    expect((await store.getPublished()).events.map(e => e.name)).toEqual(['FALL CRAFT FAIR!!!']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ['pat@example.com'], subject: "You're live: FALL CRAFT FAIR!!!" });
  });

  it('re-approving one rejected by mistake puts it back on the site', async () => {
    await startApp();
    await store.insert(row('s1'));
    await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }]);
    expect((await admin('s1', { status: 'rejected' })).unpublished).toBe(true);
    const back = await admin('s1', { status: 'approved' });
    expect(back).toMatchObject({ published: true, live: true });
    expect((await store.getPublished()).events.map(e => e.name)).toEqual(['Fall Craft Fair']);
  });

  it('a hand approval of a past event says it isn\'t live and sends nothing', async () => {
    await startApp();
    await store.insert(row('s1', { payload: { ...PAYLOAD, date: '2026-10-01' } }));
    const body = await admin('s1', { status: 'approved' });
    expect(body).toMatchObject({ published: true, live: false });
    expect(sent).toHaveLength(0);
  });

  it('editing an approved submission updates the live event, and a reject afterwards still takes it down', async () => {
    await startApp();
    await store.insert(row('s1'));
    await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }]);
    const saved = await store.get('s1');
    const body = await admin('s1', { payload: edit({ ...saved.payload, name: 'Victoria Fall Craft Fair', date: '2026-10-11' }) });
    expect(body.updated_live).toBe(true);
    const pub = await store.getPublished();
    expect(pub.events.map(e => [e.name, e.date])).toEqual([['Victoria Fall Craft Fair', '2026-10-11']]);
    expect(pub.auto_publish.keys).toEqual(['2026-10-11|Victoria Fall Craft Fair|Community Center']);
    expect(pub.events[0]).not.toHaveProperty('submitter_phone');

    const off = await admin('s1', { status: 'rejected' });
    expect(off.unpublished).toBe(true);
    expect((await store.getPublished()).events).toEqual([]);
  });

  it('a reject still finds the live event under a key it had before an edit', async () => {
    await startApp();
    await store.insert(row('s1'));
    await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }]);
    // The live list kept the old version (e.g. the in-place update failed).
    const before = await store.getPublished();
    const saved = await store.get('s1');
    await admin('s1', { payload: edit({ ...saved.payload, name: 'Renamed Craft Fair' }) });
    await store.setPublished(before);
    const off = await admin('s1', { status: 'rejected' });
    expect(off.unpublished).toBe(true);
    expect((await store.getPublished()).events).toEqual([]);
  });
});

describe('paid Vic\'s Picks in the review', () => {
  const ORDER = (extra = {}) => ({
    id: 'ord1', kind: 'featured', status: 'paid', email: 'pat@example.com', business: 'Pat Co', amount: 4900,
    created_at: NOW.toISOString(), paid_at: NOW.toISOString(), submission_id: 'p1',
    event: { date: '2026-10-10', name: 'FALL CRAFT FAIR!!!', time: '9:00 AM', venue: 'Community Center' }, ...extra
  });
  let notes;
  const paidRow = (extra = {}) => row('p1', { source: 'paid-feature', submitter_name: 'Pat Co', ...extra });
  async function startPaid(extra = {}) {
    notes = [];
    await startApp({
      slack: { notify: m => notes.push(m), alert: () => {} },
      stripeSecretKey: 'sk_test', stripeWebhookSecret: 'whsec_test',
      stripe: { createCheckoutSession: async () => ({}), expireCheckoutSession: async () => ({}) }, ...extra
    });
  }

  it('a clean paid pick goes live with the buyer\'s own words, pinned, and a Vic\'s Pick email', async () => {
    await startPaid();
    await store.saveSponsorOrder(ORDER());
    await store.insert(paidRow());
    const body = await (await review([{ id: 'p1', decision: 'approve', cleaned: CLEAN }])).json();
    expect(body.done[0]).toMatchObject({ decision: 'approve', changes: [], live: true });
    const feed = await (await fetch(baseUrl + '/events.json')).json();
    expect(feed.events).toEqual([expect.objectContaining({ name: 'FALL CRAFT FAIR!!!', featured: true })]);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Your Vic's Pick is live: FALL CRAFT FAIR!!!");
    expect(sent[0].html).not.toContain('Make it a Vic’s Pick');
    expect(notes.at(-1).text).toMatch(/paid Vic’s Pick/);
  });

  it('nothing paid for is turned away automatically; an exact copy of a live event is approved', async () => {
    await startPaid();
    await store.insert(paidRow());
    await store.insert(row('p2', { source: 'paid-feature', payload: { ...PAYLOAD, name: 'Other Fair' } }));
    const body = await (await review([{ id: 'p1', decision: 'reject', reason: 'spam: looks like an ad' },
      { id: 'p2', decision: 'duplicate', reason: 'already live' }])).json();
    expect(body.done.map(d => d.decision)).toEqual(['flag', 'approve']);
    expect((await store.get('p1')).status).toBe('pending');
    expect((await store.get('p1')).ai_review.reason).toMatch(/paid Vic’s Pick.*looks like an ad/);
  });

  it('reminds the owner in Slack when a paid pick close to its date is still unpublished, at most every few hours', async () => {
    await startPaid();
    const earlier = new Date(NOW.getTime() - 3600 * 1000).toISOString();
    await store.insert(paidRow({ created_at: earlier, payload: { ...PAYLOAD, date: '2026-10-06' } }));
    await store.insert(row('p2', { source: 'paid-feature', created_at: earlier, payload: { ...PAYLOAD, date: '2026-10-20' } }));
    await store.insert(row('f1', { created_at: earlier, payload: { ...PAYLOAD, date: '2026-10-06' } }));
    const first = await (await pending()).json();
    const reminders = () => notes.filter(n => /Vic’s Pick isn’t on the site/.test(n.title));
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]).toMatchObject({ channel: 'sales' });
    expect(reminders()[0].text).toMatch(/FALL CRAFT FAIR!!! · 2026-10-06/);
    // Still waiting for the AI: the reminder doesn't count as the admin touching it.
    expect(first.submissions.map(s => s.id)).toContain('p1');
    await pending();
    expect(reminders()).toHaveLength(1);
  });

  it('rejecting a paid pick in admin pings sales to refund it', async () => {
    await startPaid();
    await store.insert(paidRow());
    await admin('p1', { status: 'rejected' });
    expect(notes.at(-1)).toMatchObject({ channel: 'sales' });
    expect(notes.at(-1).title).toMatch(/Paid Vic’s Pick marked rejected/);
  });

  it('the pin follows the submission when its date is fixed, and the Sponsors tab shows picks not on the site', async () => {
    await startPaid();
    await store.saveSponsorOrder(ORDER());
    await store.insert(paidRow());
    const h = await adminAuth();
    let d = await (await fetch(baseUrl + '/api/admin/sponsors', { headers: h })).json();
    expect(d.orders.find(o => o.id === 'ord1').on_site).toBe(false);

    // Approved with the date fixed: the bought event can't match any more,
    // but the pin follows the submission.
    await admin('p1', { status: 'approved', payload: { ...PAYLOAD, date: '2026-10-11', submitter_email: 'pat@example.com' } });
    d = await (await fetch(baseUrl + '/api/admin/sponsors', { headers: h })).json();
    expect(d.orders.find(o => o.id === 'ord1').on_site).toBe(true);
    const feed = await (await fetch(baseUrl + '/events.json')).json();
    expect(feed.events).toEqual([expect.objectContaining({ date: '2026-10-11', featured: true })]);
  });

  it('applyPlacements pins by the submission shapes when the bought event no longer matches', () => {
    const order = ORDER();
    const ev = { date: '2026-10-11', name: 'Totally New Name', venue: 'Elsewhere' };
    const payload = { events: [ev] };
    expect(applyPlacements(payload, [order], { now: NOW }).events[0].featured).toBeUndefined();
    const pins = new Map([['ord1', [ev]]]);
    expect(applyPlacements(payload, [order], { now: NOW, pins }).events[0].featured).toBe(true);
  });
});

