// @vitest-environment node
//
// Tests the new GET /api/admin/published-events endpoint, which the admin
// uses to pre-check candidates that are already live on thevic361.com.
//
// Coverage:
//   - 401 without a session token
//   - empty payload when nothing has ever been published
//   - returns the published payload shape after publish
//   - shape stays in sync after a republish (overwrites prior payload)

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

let tmpDir, appBundle, server, baseUrl;

async function startApp(opts = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-published-'));
  const file = path.join(tmpDir, 'submissions.json');
  const storeBundle = { kind: 'file', store: new FileStore(file), file };
  // Optional: seed an isolated docs/events.json alternative so tests of the
  // file-fallback path don't depend on the real repo's bundled events.
  let extraOpts = {};
  if (opts.seedDocsEvents !== undefined) {
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile,
      JSON.stringify(opts.seedDocsEvents), 'utf8');
    extraOpts.eventsFile = eventsFile;
  } else if (opts.eventsFile !== undefined) {
    extraOpts.eventsFile = opts.eventsFile;
  }
  appBundle = await createApp(Object.assign({
    storeBundle,
    adminUsername: 'tristen',
    adminPassword: 'pw',
    adminSessionSecret: 'test-secret',
    trustProxy: false
  }, extraOpts, opts));
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

describe('GET /api/admin/published-events', () => {
  afterEach(stopApp);

  it('requires admin auth', async () => {
    await startApp({ githubToken: null });
    const r = await fetchJson('GET', '/api/admin/published-events');
    expect(r.status).toBe(401);
  });

  it('falls back to bundled docs/events.json when the local store is empty', async () => {
    // Before PR #47 deployed, publishing wrote docs/events.json directly via
    // GitHub. After PR #47, Save & Publish writes to the Railway store. If the
    // admin lands on the picker without having published since the cutover,
    // store.getPublished() is null but docs/events.json still represents what
    // the public site is serving — so the admin checkboxes should be seeded
    // from the file. Without this fallback, every live event renders unchecked
    // even though it's still on the site.
    const seeded = {
      last_updated: '2026-04-29T20:11:08.345Z',
      events: [
        { date: '2026-04-27', name: 'JP Music Night', venue: 'The Barn' },
        { date: '2026-04-28', name: 'Pool Shark Tuesdays', venue: 'Dodge City' }
      ]
    };
    await startApp({ githubToken: null, seedDocsEvents: seeded });
    const tok = await loginToken();
    const r = await fetchJson('GET', '/api/admin/published-events', undefined, {
      Authorization: 'Bearer ' + tok
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(Array.isArray(r.json.events)).toBe(true);
    expect(r.json.events).toHaveLength(2);
    expect(r.json.events.map(e => e.name).sort()).toEqual(
      ['JP Music Night', 'Pool Shark Tuesdays']
    );
    expect(r.json.last_updated).toBe('2026-04-29T20:11:08.345Z');
    expect(r.json.source).toBe('docs-file');
  });

  it('returns an empty list when neither the store nor docs/events.json has events', async () => {
    await startApp({
      githubToken: null,
      seedDocsEvents: { events: [] }
    });
    const tok = await loginToken();
    const r = await fetchJson('GET', '/api/admin/published-events', undefined, {
      Authorization: 'Bearer ' + tok
    });
    expect(r.status).toBe(200);
    // events: [] is a valid shape — the fallback uses it, but reports empty.
    expect(r.json.events).toEqual([]);
  });

  it('store-published payload always wins over the docs/events.json fallback', async () => {
    // After Save & Publish writes a payload to the Railway store, that
    // payload — not the bundled file — is the source of truth. Otherwise
    // a stale docs/events.json (e.g. before the latest GitHub commit) would
    // mask freshly-published events.
    const seeded = {
      events: [{ date: '2026-04-27', name: 'Stale Bundle Event', venue: 'X' }]
    };
    await startApp({ githubToken: null, seedDocsEvents: seeded });
    const tok = await loginToken();
    await fetchJson('POST', '/api/admin/publish-events', {
      events: [{ date: '2026-05-30', name: 'Fresh Store Event', venue: 'Y' }]
    }, { Authorization: 'Bearer ' + tok });
    const r = await fetchJson('GET', '/api/admin/published-events', undefined, {
      Authorization: 'Bearer ' + tok
    });
    expect(r.json.events).toHaveLength(1);
    expect(r.json.events[0].name).toBe('Fresh Store Event');
    expect(r.json.source).toBe('store');
  });

  it('returns the latest published payload after a publish', async () => {
    await startApp({ githubToken: null });
    const tok = await loginToken();
    const events = [
      { date: '2026-05-12', name: 'Bingo Night', venue: 'Palace Bingo' },
      { date: '2026-05-13', name: 'Open Mic',    venue: 'Moonshine Drinkery' }
    ];
    const pub = await fetchJson('POST', '/api/admin/publish-events',
      { events }, { Authorization: 'Bearer ' + tok });
    expect(pub.status).toBe(200);
    expect(pub.json.ok).toBe(true);

    const r = await fetchJson('GET', '/api/admin/published-events', undefined, {
      Authorization: 'Bearer ' + tok
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.events).toHaveLength(2);
    expect(r.json.events[0].name).toBe('Bingo Night');
    expect(r.json.events[1].name).toBe('Open Mic');
    expect(typeof r.json.last_updated).toBe('string');
  });

  it('reflects the latest publish (overwrites prior payload)', async () => {
    await startApp({ githubToken: null });
    const tok = await loginToken();

    // First publish: 2 events.
    await fetchJson('POST', '/api/admin/publish-events', {
      events: [
        { date: '2026-05-12', name: 'Old Event', venue: 'Old Hall' }
      ]
    }, { Authorization: 'Bearer ' + tok });

    // Second publish: completely different event.
    await fetchJson('POST', '/api/admin/publish-events', {
      events: [
        { date: '2026-05-20', name: 'Fresh Event', venue: 'New Hall' }
      ]
    }, { Authorization: 'Bearer ' + tok });

    const r = await fetchJson('GET', '/api/admin/published-events', undefined, {
      Authorization: 'Bearer ' + tok
    });
    expect(r.status).toBe(200);
    expect(r.json.events).toHaveLength(1);
    expect(r.json.events[0].name).toBe('Fresh Event');
    // Old Event should be gone — published payload is fully overwritten.
    expect(r.json.events.find(e => e.name === 'Old Event')).toBeUndefined();
  });
});
