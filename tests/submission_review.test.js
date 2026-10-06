// @vitest-environment node
//
// AI review of free submissions (server/submissionReview.js): the secret
// endpoints, what the AI may change, publishing approved ones without the
// submitter's contact details, and leaving admin-touched rows alone.

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { applyCleanup, awaitingReview } from '../server/submissionReview.js';
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
  await fs.writeFile(candidatesFile, JSON.stringify({ last_updated: 'c1', events: [] }));
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
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
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
    expect(awaitingReview(row('a', { source: 'paid-feature' }))).toBe(false);
    expect(awaitingReview(row('a', { review_history: [{ action: 'submitted' }, { action: 'edit' }] }))).toBe(false);
    expect(awaitingReview(row('a', { status: 'approved' }))).toBe(false);
  });
});

describe('submission review: endpoints', () => {
  it('need the secret, and list waiting submissions without contact details', async () => {
    await startApp();
    await store.insert(row('s1'));
    await store.insert(row('s2', { source: 'paid-feature' }));
    expect((await pending('nope')).status).toBe(401);
    expect((await review([], '')).status).toBe(401);
    const body = await (await pending()).json();
    expect(body.submissions.map(s => s.id)).toEqual(['s1']);
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
