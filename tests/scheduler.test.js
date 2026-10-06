// @vitest-environment node
//
// The in-process scheduler (server/scheduler.js): Central-time slots across
// DST, one run per slot even across restarts, retries, dispatch with the
// scheduled flag, and the fallback crons' "did it already run?" endpoint.
// GitHub, Slack and email are fakes.

import { describe, it, expect, afterEach } from 'vitest';
import { createScheduler, dueSlot, lastSlot, centralParts, JOBS, schedulerEnabled } from '../server/scheduler.js';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const job = name => JOBS.find(j => j.name === name);
let tmpDir;

async function freshStore() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-sched-'));
  return new FileStore(path.join(tmpDir, 's.json'));
}

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  tmpDir = null;
});

function fakeGithub({ configured = true, fail = null } = {}) {
  const calls = [];
  return {
    calls, branch: 'main', isConfigured: () => configured,
    async dispatchWorkflow(file, ref, inputs) {
      calls.push({ file, ref, inputs });
      if (fail) { const e = new Error(`github-dispatch-failed-${fail}`); e.status = fail; e.detail = 'Resource not accessible by personal access token'; throw e; }
      return true;
    }
  };
}

function fakeSlack() {
  const alerts = [], notes = [];
  return { alerts, notes, enabled: true, alert: async (k, t, d) => { alerts.push({ k, t, d }); return true; }, notify: async m => { notes.push(m); return true; } };
}

const quiet = { warn() {}, log() {} };

describe('Central-time slots', () => {
  it('fires at 7:43 AM Central on Mondays in both CDT and CST', () => {
    // Oct 5 2026 is CDT (UTC-5), Nov 9 2026 is CST (UTC-6).
    expect(dueSlot(job('newsletter'), new Date('2026-10-05T12:42:00Z'))).toBeNull();
    expect(dueSlot(job('newsletter'), new Date('2026-10-05T12:43:00Z'))).toBe('2026-10-05');
    expect(dueSlot(job('newsletter'), new Date('2026-11-09T12:43:00Z'))).toBeNull(); // 6:43 CST
    expect(dueSlot(job('newsletter'), new Date('2026-11-09T13:43:00Z'))).toBe('2026-11-09');
    expect(dueSlot(job('newsletter'), new Date('2026-10-06T13:00:00Z'))).toBeNull(); // Tuesday
    // A late start the same day still sends; the next morning doesn't.
    expect(dueSlot(job('newsletter'), new Date('2026-10-05T22:00:00Z'))).toBe('2026-10-05');
    expect(centralParts(new Date('2026-10-06T04:30:00Z'))).toMatchObject({ date: '2026-10-05', dow: 1 });
  });

  it('runs the event check before the newsletter and the social kit daily', () => {
    expect(dueSlot(job('event-check'), new Date('2026-10-05T11:43:00Z'))).toBe('2026-10-05');
    expect(dueSlot(job('social-kit'), new Date('2026-10-07T13:47:00Z'))).toBe('2026-10-07');
    expect(dueSlot(job('social-kit'), new Date('2026-10-07T13:46:00Z'))).toBeNull();
    expect(dueSlot(job('submission-review'), new Date('2026-10-07T13:52:00Z'))).toBe('2026-10-07T08:45');
  });

  it('knows the latest slot a job should have run in', () => {
    expect(lastSlot(job('social-kit'), new Date('2026-10-07T13:00:00Z'))).toBe('2026-10-06'); // before 8:47
    expect(lastSlot(job('social-kit'), new Date('2026-10-07T21:00:00Z'))).toBe('2026-10-07');
    expect(lastSlot(job('event-check'), new Date('2026-10-08T15:00:00Z'))).toBe('2026-10-05');
  });

  it('is on in production only, with an opt-out', () => {
    expect(schedulerEnabled({ RAILWAY_ENVIRONMENT_NAME: 'production' })).toBe(true);
    expect(schedulerEnabled({ RAILWAY_ENVIRONMENT_NAME: 'production', SCHEDULER: '0' })).toBe(false);
    expect(schedulerEnabled({ RAILWAY_ENVIRONMENT_NAME: 'staging' })).toBe(false);
  });
});

describe('createScheduler', () => {
  it('sends the newsletter once per Monday, even across a restart', async () => {
    const store = await freshStore();
    let sends = 0;
    const handlers = { newsletter: async () => { sends++; return { ok: true }; } };
    const make = () => createScheduler({ store, github: fakeGithub({ configured: false }), handlers, log: quiet });
    const mon = new Date('2026-10-05T12:44:00Z');
    await make().tick(mon);
    await make().tick(new Date(mon.getTime() + 60000)); // restarted container
    await make().tick(new Date(mon.getTime() + 3 * 3600000));
    expect(sends).toBe(1);
  });

  it('retries a failed send with backoff and alerts after the last try', async () => {
    const store = await freshStore();
    const slack = fakeSlack();
    let calls = 0;
    const s = createScheduler({ store, slack, github: fakeGithub({ configured: false }), log: quiet,
      handlers: { newsletter: async () => { calls++; return { ok: false, error: 'send-failed', message: 'Resend 500' }; } } });
    let t = new Date('2026-10-05T12:44:00Z').getTime();
    await s.tick(new Date(t));
    await s.tick(new Date(t + 60000)); // not yet: next try is 5 min later
    expect(calls).toBe(1);
    for (const mins of [5, 15, 30]) { t += mins * 60000; await s.tick(new Date(t)); }
    expect(calls).toBe(4);
    expect(slack.alerts.map(a => a.t)).toEqual(['Monday newsletter send failed after 4 tries']);
    t += 60 * 60000;
    await s.tick(new Date(t));
    expect(calls).toBe(4);
  });

  it('doesn\'t retry or alert twice when setup is missing (the handler said so)', async () => {
    const store = await freshStore();
    const slack = fakeSlack();
    let calls = 0;
    const s = createScheduler({ store, slack, github: fakeGithub({ configured: false }), log: quiet,
      handlers: { newsletter: async () => { calls++; return { ok: false, final: true, error: 'no-address' }; } } });
    await s.tick(new Date('2026-10-05T12:44:00Z'));
    await s.tick(new Date('2026-10-05T13:44:00Z'));
    expect(calls).toBe(1);
    expect(slack.alerts).toHaveLength(0);
  });

  it('dispatches the daily workflows on time with scheduled=true, once', async () => {
    const store = await freshStore();
    const github = fakeGithub();
    const s = createScheduler({ store, github, log: quiet });
    await s.tick(new Date('2026-10-07T13:40:00Z')); // 8:40 CDT: ads report only
    await s.tick(new Date('2026-10-07T13:48:00Z'));
    await s.tick(new Date('2026-10-07T13:49:00Z'));
    const daily = github.calls.filter(c => c.file !== 'submission-review.yml');
    expect(daily).toEqual([
      { file: 'meta-ads.yml', ref: 'main', inputs: { scheduled: 'true' } },
      { file: 'social-kit.yml', ref: 'main', inputs: { scheduled: 'true' } }
    ]);
    expect(github.calls.filter(c => c.file === 'submission-review.yml')).toHaveLength(2); // 8:30 and 8:45 slots
    expect((await s.ran('social-kit', new Date('2026-10-07T21:00:00Z'))).ran).toBe(true);
    expect((await s.ran('social-kit', new Date('2026-10-08T21:00:00Z'))).ran).toBe(false);
    expect(await s.ran('nope')).toBeNull();
  });

  it('leaves dispatch jobs to GitHub\'s cron when no token is set', async () => {
    const store = await freshStore();
    const github = fakeGithub({ configured: false });
    const s = createScheduler({ store, github, log: quiet });
    await s.tick(new Date('2026-10-07T13:48:00Z'));
    expect(github.calls).toHaveLength(0);
    expect((await s.ran('social-kit', new Date('2026-10-07T21:00:00Z'))).ran).toBe(false);
  });

  it('alerts once a week when GitHub refuses the token, and the fallback cron still runs', async () => {
    const store = await freshStore();
    const slack = fakeSlack();
    const s = createScheduler({ store, slack, github: fakeGithub({ fail: 403 }), log: quiet });
    await s.tick(new Date('2026-10-07T13:48:00Z'));
    await createScheduler({ store, slack, github: fakeGithub({ fail: 403 }), log: quiet }).tick(new Date('2026-10-08T13:48:00Z'));
    expect(slack.alerts).toHaveLength(1);
    expect(slack.alerts[0].d).toContain('Actions: write');
    expect(s.state.dispatchBlocked.status).toBe(403);
    expect((await s.ran('social-kit', new Date('2026-10-07T21:00:00Z'))).ran).toBe(false);
  });

  it('calls the sponsor reports hook daily when it exists', async () => {
    const store = await freshStore();
    const seen = [];
    const s = createScheduler({ store, github: fakeGithub({ configured: false }), log: quiet,
      handlers: { sponsorReports: async now => { seen.push(now.toISOString()); } } });
    await s.tick(new Date('2026-10-07T14:01:00Z'));
    await s.tick(new Date('2026-10-07T15:01:00Z'));
    await s.tick(new Date('2026-10-08T14:01:00Z'));
    expect(seen).toHaveLength(2);
    // Without the hook the job is simply skipped.
    await createScheduler({ store, github: fakeGithub({ configured: false }), log: quiet }).tick(new Date('2026-10-09T14:01:00Z'));
  });
});

describe('scheduler in the app', () => {
  let server;
  afterEach(async () => { if (server) await new Promise(r => server.close(r)); server = null; });

  async function start(store, extra = {}) {
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    const slack = fakeSlack();
    const out = await createApp({
      storeBundle: { kind: 'file', store }, eventsFile, candidatesFile: path.join(tmpDir, 'none.json'), trustProxy: false,
      siteUrl: 'https://www.thevic361.com', slack, startScheduler: false, ...extra
    });
    server = http.createServer(out.app);
    await new Promise(r => server.listen(0, r));
    return { ...out, slack, base: `http://127.0.0.1:${server.address().port}` };
  }

  it('answers the fallback crons and runs the hourly site check', async () => {
    const store = await freshStore();
    let now = new Date('2026-10-07T15:05:00Z');
    const { scheduler, slack, base } = await start(store, { now: () => now });
    const r = await (await fetch(base + '/api/scheduler/ran?job=social-kit')).json();
    expect(r).toMatchObject({ ok: true, job: 'social-kit', ran: false });
    expect((await fetch(base + '/api/scheduler/ran?job=../etc')).status).toBe(404);

    // Nothing published: the hourly check says so once, not every hour.
    await scheduler.tick(now);
    now = new Date('2026-10-07T16:05:00Z');
    await scheduler.tick(now);
    expect(slack.alerts.filter(a => a.d.includes('upcoming events'))).toHaveLength(1);

    // Events back (collected yesterday): a recovery note.
    const events = Array.from({ length: 12 }, (_, i) => ({ date: '2026-10-09', name: `E${i}`, venue: 'V' }));
    await store.setPublished({ last_updated: now.toISOString(), events, auto_publish: { from: '2026-10-06T20:27:00-05:00' } });
    now = new Date('2026-10-07T17:05:00Z');
    await scheduler.tick(now);
    expect(slack.notes.some(n => n.title.includes('back to normal'))).toBe(true);

    // A collector stalled for 8+ days is flagged, even though a submission
    // just moved last_updated.
    await store.setPublished({ last_updated: now.toISOString(), events, auto_publish: { from: '2026-09-28T20:27:00-05:00' } });
    now = new Date('2026-10-07T18:05:00Z');
    await scheduler.tick(now);
    expect(slack.alerts.some(a => a.d.includes('No new events collected in 8 days'))).toBe(true);
  });
});
