// @vitest-environment node
//
// Regression tests for the audit fix: POST /api/admin/publish-events must
// NOT drop top-level non-events fields (`new_and_notable`, `sponsor`, …)
// when the admin only edits the events list. Before this fix, an
// events-only publish replaced the entire payload and silently wiped the
// New & Notable section + sponsor block.
//
// Carry-forward priority:
//   1. body.extras (caller explicitly provided new values)
//   2. last published payload from the local store
//   3. bundled docs/events.json on disk

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

let tmpDir, appBundle, server, baseUrl;

async function startApp(opts = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-extras-'));
  const file = path.join(tmpDir, 'submissions.json');
  const storeBundle = { kind: 'file', store: new FileStore(file), file };
  appBundle = await createApp(Object.assign({
    storeBundle,
    adminUsername: 'tristen',
    adminPassword: 'pw',
    adminSessionSecret: 'test-secret',
    trustProxy: false
  }, opts));
  server = http.createServer(appBundle.app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return appBundle;
}

async function stopApp() {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
  server = null; tmpDir = null; appBundle = null; baseUrl = null;
}

function fetchJson(method, p, body, headers) {
  const init = { method, headers: Object.assign({}, headers || {}) };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  return fetch(baseUrl + p, init).then(async r => {
    let json = null;
    try { json = await r.json(); } catch (_) {}
    return { status: r.status, json };
  });
}

async function loginToken() {
  const r = await fetchJson('POST', '/api/admin/login',
    { username: 'tristen', password: 'pw' });
  return r.json.token;
}

describe('POST /api/admin/publish-events — extras carry-forward', () => {
  afterEach(stopApp);

  it('preserves new_and_notable + sponsor across an events-only republish', async () => {
    await startApp({ githubToken: null });
    const tok = await loginToken();

    // Seed a published payload that includes extras.
    await appBundle.store.setPublished({
      last_updated: '2026-04-20T00:00:00.000Z',
      events: [{ date: '2026-04-22', name: 'Old Event', venue: 'Hall' }],
      new_and_notable: [{ name: 'Newly Opened Cafe', tag: 'new' }],
      sponsor: { name: 'Sponsor Co', text: 'Best sponsor in Victoria' }
    });

    // Admin republishes a fresh events list, with NO extras in the body.
    const r = await fetchJson('POST', '/api/admin/publish-events',
      { events: [{ date: '2026-04-29', name: 'New Pick', venue: 'Hall' }] },
      { Authorization: 'Bearer ' + tok });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);

    // The public-facing payload must still have new_and_notable + sponsor.
    const ev = await fetch(baseUrl + '/events.json').then(x => x.json());
    expect(ev.events).toHaveLength(1);
    expect(ev.events[0].name).toBe('New Pick');
    expect(ev.new_and_notable).toEqual([{ name: 'Newly Opened Cafe', tag: 'new' }]);
    expect(ev.sponsor).toEqual({ name: 'Sponsor Co', text: 'Best sponsor in Victoria' });
  });

  it('preserves arbitrary unknown top-level fields too (forward compat)', async () => {
    await startApp({ githubToken: null });
    const tok = await loginToken();
    await appBundle.store.setPublished({
      last_updated: '2026-04-20T00:00:00.000Z',
      events: [{ date: '2026-04-22', name: 'Old Event', venue: 'Hall' }],
      // hypothetical future field — must not be dropped on republish.
      banner: { text: 'Welcome', url: 'https://example.com' }
    });
    await fetchJson('POST', '/api/admin/publish-events',
      { events: [{ date: '2026-04-29', name: 'New Pick' }] },
      { Authorization: 'Bearer ' + tok });
    const ev = await fetch(baseUrl + '/events.json').then(x => x.json());
    expect(ev.banner).toEqual({ text: 'Welcome', url: 'https://example.com' });
  });

  it('lets the caller explicitly update extras via body.extras', async () => {
    await startApp({ githubToken: null });
    const tok = await loginToken();
    await appBundle.store.setPublished({
      last_updated: '2026-04-20T00:00:00.000Z',
      events: [],
      new_and_notable: [{ name: 'Old Item' }],
      sponsor: { name: 'Old Sponsor' }
    });

    const r = await fetchJson('POST', '/api/admin/publish-events', {
      events: [{ date: '2026-05-01', name: 'P', venue: 'H' }],
      extras: {
        new_and_notable: [{ name: 'Fresh Item' }],
        sponsor: null
      }
    }, { Authorization: 'Bearer ' + tok });
    expect(r.status).toBe(200);

    const ev = await fetch(baseUrl + '/events.json').then(x => x.json());
    expect(ev.new_and_notable).toEqual([{ name: 'Fresh Item' }]);
    expect(ev.sponsor).toBeNull();
  });

  it('falls back to docs/events.json extras when nothing is in the store yet', async () => {
    // Fresh deploy: store has no published row, but docs/events.json on
    // disk has extras. (In practice the bundled docs/events.json may not
    // have these fields — the test verifies the fallback path even works.)
    await startApp({ githubToken: null });
    const tok = await loginToken();

    const published = await appBundle.store.getPublished();
    expect(published).toBeNull();

    // First publish with no extras in body and no prior store row.
    const r = await fetchJson('POST', '/api/admin/publish-events',
      { events: [{ date: '2026-05-01', name: 'First', venue: 'H' }] },
      { Authorization: 'Bearer ' + tok });
    expect(r.status).toBe(200);

    const ev = await fetch(baseUrl + '/events.json').then(x => x.json());
    expect(ev.events[0].name).toBe('First');
    // We don't assert specific extras content here — the bundled
    // docs/events.json may or may not have new_and_notable/sponsor — but
    // the request must succeed without crashing.
  });

  it('still strips events from extras on the wire (defense in depth)', async () => {
    // If a buggy admin client somehow includes `events` inside extras,
    // the protected-keys filter must drop it so the request body's events
    // list is the source of truth.
    await startApp({ githubToken: null });
    const tok = await loginToken();
    const r = await fetchJson('POST', '/api/admin/publish-events', {
      events: [{ date: '2026-05-01', name: 'Real', venue: 'H' }],
      extras: {
        events: [{ date: '1900-01-01', name: 'Bogus' }],
        last_updated: '1900-01-01T00:00:00Z',
        new_and_notable: [{ name: 'Keep me' }]
      }
    }, { Authorization: 'Bearer ' + tok });
    expect(r.status).toBe(200);
    const ev = await fetch(baseUrl + '/events.json').then(x => x.json());
    expect(ev.events).toHaveLength(1);
    expect(ev.events[0].name).toBe('Real');
    expect(ev.new_and_notable).toEqual([{ name: 'Keep me' }]);
    // last_updated should be the server-set fresh timestamp, not the
    // 1900-01-01 the client tried to smuggle in.
    expect(ev.last_updated).not.toBe('1900-01-01T00:00:00Z');
    expect(typeof ev.last_updated).toBe('string');
  });
});
