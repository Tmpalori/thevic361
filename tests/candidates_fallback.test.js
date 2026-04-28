// @vitest-environment node
//
// Tests the no-GITHUB_TOKEN paths the admin needs on Railway:
//
//   - GET /api/admin/candidates falls back to the bundled candidates.json
//     when GITHUB_TOKEN is not configured, and merges approved submissions.
//   - GET /api/admin/candidates falls back to the bundled file when the
//     GitHub fetch returns 401 (typical "stale token" symptom).
//   - POST /api/admin/publish-events succeeds without GITHUB_TOKEN, saving
//     the payload to the local store; subsequent GET /events.json serves it.
//   - POST /api/admin/publish-events still commits to GitHub when the token
//     is configured, AND records the local save (so Railway's public events
//     stay in sync independently of the repo).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

let tmpDir, appBundle, server, baseUrl;

async function startApp(opts = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-fallback-'));
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
    return { status: r.status, json, headers: r.headers };
  });
}

async function loginToken() {
  const r = await fetchJson('POST', '/api/admin/login',
    { username: 'tristen', password: 'pw' });
  return r.json.token;
}

describe('candidates + publish without GITHUB_TOKEN', () => {
  afterEach(stopApp);

  it('GET /api/admin/candidates falls back to local candidates.json when no token', async () => {
    await startApp({ githubToken: null });
    const tok = await loginToken();
    const r = await fetchJson('GET', '/api/admin/candidates', undefined, {
      Authorization: 'Bearer ' + tok
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.source).toBe('local-file');
    // The bundled candidates.json in the repo is non-empty.
    expect(Array.isArray(r.json.data.events)).toBe(true);
    expect(r.json.data.events.length).toBeGreaterThan(0);
    // No GitHub sha when we read from disk.
    expect(r.json.sha).toBeNull();
  });

  it('falls back to local candidates.json on a 401 from GitHub', async () => {
    const fakeFetch = async (url) => {
      if (/api\.github\.com/.test(url)) {
        return { ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    await startApp({ githubToken: 'expired-token', fetch: fakeFetch });
    const tok = await loginToken();
    const r = await fetchJson('GET', '/api/admin/candidates', undefined, {
      Authorization: 'Bearer ' + tok
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.source).toBe('local-file');
    expect(r.json.warning).toBe('github-fetch-failed-401');
    expect(Array.isArray(r.json.data.events)).toBe(true);
  });

  it('merges approved submissions into the candidate list', async () => {
    await startApp({ githubToken: null });
    const tok = await loginToken();
    // Seed an approved row directly in the store.
    const now = new Date().toISOString();
    await appBundle.store.insert({
      id: 'approved-1',
      created_at: now, updated_at: now,
      status: 'approved',
      source: 'submission',
      submitter_kind: 'organizer',
      submitter_name: 'X',
      submitter_email: 'x@example.com',
      payload: {
        date: '2099-12-31', name: 'Future Test Event',
        venue: 'Test Hall', icons: [], free: false
      },
      review_history: []
    });
    const r = await fetchJson('GET', '/api/admin/candidates', undefined, {
      Authorization: 'Bearer ' + tok
    });
    expect(r.status).toBe(200);
    const names = r.json.data.events.map(e => e.name);
    expect(names).toContain('Future Test Event');
    const merged = r.json.data.events.find(e => e.name === 'Future Test Event');
    expect(merged._source_id).toBe('approved-1');
  });

  it('POST /api/admin/publish-events succeeds without GITHUB_TOKEN and serves the result at /events.json', async () => {
    await startApp({ githubToken: null });
    const tok = await loginToken();
    const events = [
      { date: '2026-05-12', name: 'Local Publish Test', venue: 'Stage' }
    ];
    const r = await fetchJson('POST', '/api/admin/publish-events',
      { events }, { Authorization: 'Bearer ' + tok });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.published).toBe(1);
    expect(r.json.destinations.local.ok).toBe(true);
    expect(r.json.destinations.github.ok).toBe(false);
    expect(r.json.destinations.github.error).toBe('github-not-configured');

    // The public site should now see the freshly-published events.
    const ev = await fetch(baseUrl + '/events.json').then(x => x.json());
    expect(ev.events[0].name).toBe('Local Publish Test');
    expect(typeof ev.last_updated).toBe('string');
  });

  it('still commits to GitHub when GITHUB_TOKEN is configured, and ALSO records the local save', async () => {
    let putUrl = null;
    const fakeFetch = async (url, init) => {
      const method = (init && init.method) || 'GET';
      if (method === 'GET' && /\/contents\/docs\/events\.json/.test(url)) {
        return { ok: true, status: 200, json: async () => ({ sha: 'old', encoding: 'base64', content: '' }) };
      }
      if (method === 'PUT') {
        putUrl = url;
        return { ok: true, status: 200, json: async () => ({
          commit: { sha: 'new', html_url: 'https://example/new' }
        }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    await startApp({ githubToken: 'real-token', fetch: fakeFetch });
    const tok = await loginToken();
    const r = await fetchJson('POST', '/api/admin/publish-events',
      { events: [{ name: 'Both', date: '2026-05-12' }] },
      { Authorization: 'Bearer ' + tok });
    expect(r.status).toBe(200);
    expect(r.json.destinations.local.ok).toBe(true);
    expect(r.json.destinations.github.ok).toBe(true);
    expect(r.json.destinations.github.commit.sha).toBe('new');
    expect(putUrl).toMatch(/\/contents\/docs\/events\.json/);

    // Local save still happened, so /events.json reflects the publish.
    const ev = await fetch(baseUrl + '/events.json').then(x => x.json());
    expect(ev.events[0].name).toBe('Both');
  });

  it('publish reports a warning (but still succeeds locally) when GitHub commit fails', async () => {
    const fakeFetch = async (url, init) => {
      const method = (init && init.method) || 'GET';
      if (method === 'PUT') {
        return { ok: false, status: 422, json: async () => ({ message: 'sha mismatch' }) };
      }
      // sha probe returns 404 → server attempts a create.
      return { ok: false, status: 404, json: async () => ({}) };
    };
    await startApp({ githubToken: 'token', fetch: fakeFetch });
    const tok = await loginToken();
    const r = await fetchJson('POST', '/api/admin/publish-events',
      { events: [{ name: 'OnlyLocal', date: '2026-05-12' }] },
      { Authorization: 'Bearer ' + tok });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.destinations.local.ok).toBe(true);
    expect(r.json.destinations.github.ok).toBe(false);
    expect(r.json.warning).toBe('github-publish-failed');
    const ev = await fetch(baseUrl + '/events.json').then(x => x.json());
    expect(ev.events[0].name).toBe('OnlyLocal');
  });

  it('candidates endpoint still requires admin auth', async () => {
    await startApp({ githubToken: null });
    const r = await fetchJson('GET', '/api/admin/candidates');
    expect(r.status).toBe(401);
  });
});
