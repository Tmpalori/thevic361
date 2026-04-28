// @vitest-environment node
//
// Tests for the Sources tab backend:
//   - server/sources.js pure helpers (next-run cron math + payload building)
//   - /api/admin/sources route (reads collection_metadata.json from disk)
//   - /api/admin/trigger-collect route (workflow_dispatch via github.js)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import {
  nextWeeklyRunUtc,
  buildSourcesPayload,
  KNOWN_SOURCES_FOR_TESTS
} from '../server/sources.js';

describe('nextWeeklyRunUtc', () => {
  it('returns the next Sunday 23:00 UTC after a Monday morning', () => {
    // Mon 2026-04-27 09:00 UTC -> next Sun 2026-05-03 23:00 UTC
    const now = new Date(Date.UTC(2026, 3, 27, 9, 0, 0));
    const next = nextWeeklyRunUtc(now);
    expect(next.toISOString()).toBe('2026-05-03T23:00:00.000Z');
  });

  it('returns the same Sunday 23:00 UTC if called before that on Sunday', () => {
    // Sun 2026-05-03 12:00 UTC -> Sun 2026-05-03 23:00 UTC
    const now = new Date(Date.UTC(2026, 4, 3, 12, 0, 0));
    const next = nextWeeklyRunUtc(now);
    expect(next.toISOString()).toBe('2026-05-03T23:00:00.000Z');
  });

  it('rolls forward 7 days when called after 23:00 UTC on Sunday', () => {
    // Sun 2026-05-03 23:30 UTC -> next Sun 2026-05-10 23:00 UTC
    const now = new Date(Date.UTC(2026, 4, 3, 23, 30, 0));
    const next = nextWeeklyRunUtc(now);
    expect(next.toISOString()).toBe('2026-05-10T23:00:00.000Z');
  });
});

describe('buildSourcesPayload', () => {
  it('renders placeholder rows for every known source when metadata is missing', () => {
    const payload = buildSourcesPayload({
      metadata: null,
      mtime: null,
      now: new Date(Date.UTC(2026, 3, 27, 12, 0, 0)),
      githubConfigured: false
    });
    expect(payload.ok).toBe(true);
    expect(payload.metadata_present).toBe(false);
    expect(payload.last_run_at).toBeNull();
    expect(payload.next_run_at).toBe('2026-05-03T23:00:00.000Z');
    expect(payload.trigger_enabled).toBe(false);
    // Every known source should be represented as 'unknown' status.
    const names = payload.sources.map(s => s.name).sort();
    const expected = KNOWN_SOURCES_FOR_TESTS.map(s => s.name).sort();
    expect(names).toEqual(expected);
    payload.sources.forEach(s => {
      expect(s.status).toBe('unknown');
      expect(s.count).toBe(0);
    });
  });

  it('hydrates rows from metadata, sets ok/empty/error statuses, and merges unknown known sources', () => {
    const metadata = {
      last_run_at: '2026-04-26T18:30:00',
      window_start: '2026-04-20',
      window_end: '2026-05-10',
      candidates_only: true,
      merged_count: 80,
      raw_count: 120,
      sources: [
        { name: 'library', count: 12, status: 'ok',
          started_at: '2026-04-26T18:25:00', finished_at: '2026-04-26T18:25:30' },
        { name: 'chamber', count: 0, status: 'empty',
          started_at: '2026-04-26T18:26:00', finished_at: '2026-04-26T18:26:01' },
        { name: 'apify_facebook', count: 0, status: 'error',
          message: 'APIFY_TOKEN missing',
          started_at: '2026-04-26T18:27:00', finished_at: '2026-04-26T18:27:01' }
      ]
    };
    const payload = buildSourcesPayload({
      metadata,
      mtime: '2026-04-26T18:30:05Z',
      now: new Date(Date.UTC(2026, 3, 27, 12, 0, 0)),
      githubConfigured: true
    });
    expect(payload.metadata_present).toBe(true);
    expect(payload.merged_count).toBe(80);
    expect(payload.raw_count).toBe(120);
    expect(payload.candidates_only).toBe(true);
    expect(payload.trigger_enabled).toBe(true);
    expect(payload.last_run_at).toBe('2026-04-26T18:30:00');

    const byName = Object.fromEntries(payload.sources.map(s => [s.name, s]));
    expect(byName.library.count).toBe(12);
    expect(byName.library.status).toBe('ok');
    expect(byName.library.label).toBe('Public Library');
    expect(byName.chamber.status).toBe('empty');
    expect(byName.apify_facebook.status).toBe('error');
    expect(byName.apify_facebook.message).toBe('APIFY_TOKEN missing');

    // Sources not in metadata still appear, marked unknown.
    expect(byName.perplexity.status).toBe('unknown');
    expect(byName.local_events.status).toBe('unknown');
  });
});

// ─── Server route integration ─────────────────────────────────────────────

let tmpDir, server, baseUrl, metadataPath;

async function startApp(opts = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-sources-'));
  const file = path.join(tmpDir, 'submissions.json');
  const storeBundle = { kind: 'file', store: new FileStore(file), file };
  metadataPath = path.join(tmpDir, 'collection_metadata.json');
  const appBundle = await createApp(Object.assign({
    storeBundle,
    adminUsername: 'tristen',
    adminPassword: 'pw',
    adminSessionSecret: 'shhh-test-secret',
    collectionMetadataFile: metadataPath,
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
  server = null; tmpDir = null; baseUrl = null;
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

describe('GET /api/admin/sources', () => {
  beforeEach(async () => { await startApp(); });
  afterEach(async () => { await stopApp(); });

  it('requires admin auth', async () => {
    const r = await fetchJson('GET', '/api/admin/sources');
    expect(r.status).toBe(401);
  });

  it('returns placeholder rows when collection_metadata.json is missing', async () => {
    const tok = await loginToken();
    const r = await fetchJson('GET', '/api/admin/sources', undefined,
      { Authorization: 'Bearer ' + tok });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.metadata_present).toBe(false);
    expect(r.json.trigger_enabled).toBe(false);
    expect(Array.isArray(r.json.sources)).toBe(true);
    expect(r.json.sources.length).toBeGreaterThan(0);
    expect(r.json.sources.every(s => s.status === 'unknown')).toBe(true);
  });

  it('hydrates from collection_metadata.json on disk', async () => {
    await fs.writeFile(metadataPath, JSON.stringify({
      last_run_at: '2026-04-26T18:30:00',
      sources: [
        { name: 'library', count: 7, status: 'ok',
          started_at: '2026-04-26T18:25:00', finished_at: '2026-04-26T18:25:30' }
      ]
    }), 'utf8');
    const tok = await loginToken();
    const r = await fetchJson('GET', '/api/admin/sources', undefined,
      { Authorization: 'Bearer ' + tok });
    expect(r.status).toBe(200);
    expect(r.json.metadata_present).toBe(true);
    expect(r.json.last_run_at).toBe('2026-04-26T18:30:00');
    const lib = r.json.sources.find(s => s.name === 'library');
    expect(lib.count).toBe(7);
    expect(lib.status).toBe('ok');
  });
});

describe('POST /api/admin/trigger-collect', () => {
  it('returns 503 when GITHUB_TOKEN is not configured', async () => {
    await startApp(); // no githubToken
    try {
      const tok = await loginToken();
      const r = await fetchJson('POST', '/api/admin/trigger-collect', {},
        { Authorization: 'Bearer ' + tok });
      expect(r.status).toBe(503);
      expect(r.json.error).toBe('github-not-configured');
    } finally { await stopApp(); }
  });

  it('dispatches the weekly-collect.yml workflow when configured', async () => {
    const calls = [];
    await startApp({
      githubToken: 'gh-test',
      githubOwner: 'Tmpalori',
      githubRepo: 'thevic361',
      githubBranch: 'main',
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (init && init.method === 'POST' &&
            /\/actions\/workflows\/weekly-collect\.yml\/dispatches/.test(url)) {
          return { ok: true, status: 204, json: async () => ({}) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }
    });
    try {
      const tok = await loginToken();
      const r = await fetchJson('POST', '/api/admin/trigger-collect', {},
        { Authorization: 'Bearer ' + tok });
      expect(r.status).toBe(200);
      expect(r.json.ok).toBe(true);
      expect(r.json.workflow).toBe('weekly-collect.yml');
      expect(r.json.ref).toBe('main');
      // POST body must include the ref so the dispatch lands on `main`.
      const dispatch = calls.find(c => c.init && c.init.method === 'POST');
      expect(dispatch).toBeDefined();
      expect(JSON.parse(dispatch.init.body)).toEqual({ ref: 'main' });
    } finally { await stopApp(); }
  });

  it('surfaces a 403 from GitHub as a 403 (token lacks actions:write)', async () => {
    await startApp({
      githubToken: 'gh-test',
      fetch: async (url, init) => {
        if (init && init.method === 'POST') {
          return {
            ok: false, status: 403,
            json: async () => ({ message: 'Resource not accessible by personal access token' })
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }
    });
    try {
      const tok = await loginToken();
      const r = await fetchJson('POST', '/api/admin/trigger-collect', {},
        { Authorization: 'Bearer ' + tok });
      expect(r.status).toBe(403);
      expect(r.json.error).toBe('dispatch-failed');
      expect(r.json.github_status).toBe(403);
    } finally { await stopApp(); }
  });

  it('requires admin auth', async () => {
    await startApp();
    try {
      const r = await fetchJson('POST', '/api/admin/trigger-collect');
      expect(r.status).toBe(401);
    } finally { await stopApp(); }
  });
});

describe('GET /api/config exposes sources_trigger_enabled', () => {
  beforeEach(async () => { await stopApp(); });
  afterEach(async () => { await stopApp(); });

  it('false when GITHUB_TOKEN is missing', async () => {
    await startApp();
    const r = await fetchJson('GET', '/api/config');
    expect(r.status).toBe(200);
    expect(r.json.sources_trigger_enabled).toBe(false);
  });

  it('true when GITHUB_TOKEN is present', async () => {
    await startApp({ githubToken: 'gh-test' });
    const r = await fetchJson('GET', '/api/config');
    expect(r.status).toBe(200);
    expect(r.json.sources_trigger_enabled).toBe(true);
  });
});
