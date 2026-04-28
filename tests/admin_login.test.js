// @vitest-environment node
//
// Tests for the new /api/admin/login flow + session-token-gated admin
// routes + the server-side GitHub publish proxy. We never hit the real
// GitHub API — the github module is injected with a fake fetch.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { createAuth } from '../server/auth.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

let tmpDir, appBundle, server, baseUrl;

async function startApp(opts = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-login-'));
  const file = path.join(tmpDir, 'submissions.json');
  const storeBundle = { kind: 'file', store: new FileStore(file), file };
  appBundle = await createApp(Object.assign({
    storeBundle,
    adminUsername: 'tristen',
    adminPassword: 'correct horse battery staple',
    adminSessionSecret: 'test-secret-key-deadbeef',
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

describe('POST /api/admin/login', () => {
  beforeEach(async () => { await startApp(); });
  afterEach(async () => { await stopApp(); });

  it('returns 503 when login is not configured', async () => {
    await stopApp();
    await startApp({
      adminUsername: null, adminPassword: null, adminSessionSecret: null
    });
    const r = await fetchJson('POST', '/api/admin/login',
      { username: 'x', password: 'y' });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe('login-not-configured');
  });

  it('rejects bad credentials with a generic 401', async () => {
    const r = await fetchJson('POST', '/api/admin/login',
      { username: 'tristen', password: 'wrong' });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('invalid-credentials');
    // No detail about which field was wrong.
    expect(JSON.stringify(r.json)).not.toContain('password');
  });

  it('rejects unknown usernames with the same generic 401', async () => {
    const r = await fetchJson('POST', '/api/admin/login',
      { username: 'wronguser', password: 'wrong' });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('invalid-credentials');
  });

  it('returns a session token on valid credentials', async () => {
    const r = await fetchJson('POST', '/api/admin/login',
      { username: 'tristen', password: 'correct horse battery staple' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(typeof r.json.token).toBe('string');
    // base64url(payload).base64url(sig) — must contain a dot.
    expect(r.json.token.split('.').length).toBe(2);
    expect(typeof r.json.expires_at).toBe('string');
  });

  it('the issued token unlocks /api/admin/submissions', async () => {
    const login = await fetchJson('POST', '/api/admin/login',
      { username: 'tristen', password: 'correct horse battery staple' });
    const tok = login.json.token;
    const r = await fetchJson('GET', '/api/admin/submissions', undefined, {
      Authorization: 'Bearer ' + tok
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
  });

  it('a tampered token is rejected', async () => {
    const login = await fetchJson('POST', '/api/admin/login',
      { username: 'tristen', password: 'correct horse battery staple' });
    const tok = login.json.token;
    const parts = tok.split('.');
    // Flip the last char of the signature.
    const tampered = parts[0] + '.' + parts[1].slice(0, -1) + (parts[1].slice(-1) === 'A' ? 'B' : 'A');
    const r = await fetchJson('GET', '/api/admin/submissions', undefined, {
      Authorization: 'Bearer ' + tampered
    });
    expect(r.status).toBe(401);
  });

  it('legacy ADMIN_TOKEN still works alongside login', async () => {
    await stopApp();
    await startApp({ adminToken: 'legacy-tok' });
    const r = await fetchJson('GET', '/api/admin/submissions', undefined, {
      Authorization: 'Bearer legacy-tok'
    });
    expect(r.status).toBe(200);
  });
});

describe('GET /api/admin/me', () => {
  beforeEach(async () => { await startApp(); });
  afterEach(async () => { await stopApp(); });

  it('401 without a token', async () => {
    const r = await fetchJson('GET', '/api/admin/me');
    expect(r.status).toBe(401);
  });
  it('200 with a valid session token', async () => {
    const login = await fetchJson('POST', '/api/admin/login',
      { username: 'tristen', password: 'correct horse battery staple' });
    const r = await fetchJson('GET', '/api/admin/me', undefined, {
      Authorization: 'Bearer ' + login.json.token
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.kind).toBe('session');
    expect(r.json.sub).toBe('tristen');
  });
});

describe('GET /api/config exposes auth flags', () => {
  beforeEach(async () => { await startApp(); });
  afterEach(async () => { await stopApp(); });

  it('reports admin_login_enabled when ADMIN_USERNAME/PASSWORD/SECRET are set', async () => {
    const r = await fetchJson('GET', '/api/config');
    expect(r.status).toBe(200);
    expect(r.json.admin_login_enabled).toBe(true);
    expect(r.json.github_publish_enabled).toBe(false);
    // Never leak the secret value.
    expect(JSON.stringify(r.json)).not.toContain('test-secret-key-deadbeef');
    expect(JSON.stringify(r.json)).not.toContain('correct horse');
  });
});

describe('GitHub publish proxy', () => {
  let calls;
  function fakeGithubFetch() {
    calls = [];
    return async (url, init) => {
      calls.push({ url, init });
      const method = (init && init.method) || 'GET';
      // GET candidates.json
      if (method === 'GET' && /\/contents\/candidates\.json/.test(url)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sha: 'abc-sha',
            encoding: 'base64',
            content: Buffer.from(JSON.stringify({ events: [{ name: 'A' }] }), 'utf8').toString('base64')
          })
        };
      }
      // GET docs/events.json (initial sha probe)
      if (method === 'GET' && /\/contents\/docs\/events\.json/.test(url)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sha: 'events-sha',
            encoding: 'base64',
            content: Buffer.from(JSON.stringify({ events: [] }), 'utf8').toString('base64')
          })
        };
      }
      // PUT docs/events.json
      if (method === 'PUT') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            commit: { sha: 'new-sha', html_url: 'https://github.com/x/y/commit/new-sha' }
          })
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
  }

  beforeEach(async () => {
    await startApp({
      githubToken: 'fake-gh-token',
      githubOwner: 'Tmpalori',
      githubRepo: 'thevic361',
      githubBranch: 'main',
      fetch: fakeGithubFetch()
    });
  });
  afterEach(async () => { await stopApp(); });

  async function loggedInToken() {
    const login = await fetchJson('POST', '/api/admin/login',
      { username: 'tristen', password: 'correct horse battery staple' });
    return login.json.token;
  }

  it('GET /api/admin/candidates returns parsed candidates.json', async () => {
    const tok = await loggedInToken();
    const r = await fetchJson('GET', '/api/admin/candidates', undefined, {
      Authorization: 'Bearer ' + tok
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.data.events[0].name).toBe('A');
  });

  it('candidates endpoint requires admin auth', async () => {
    const r = await fetchJson('GET', '/api/admin/candidates');
    expect(r.status).toBe(401);
  });

  it('POST /api/admin/publish-events PUTs docs/events.json', async () => {
    const tok = await loggedInToken();
    const r = await fetchJson('POST', '/api/admin/publish-events',
      { events: [{ name: 'X', date: '2026-05-12' }] },
      { Authorization: 'Bearer ' + tok });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.published).toBe(1);
    // Confirm we issued a PUT to docs/events.json.
    const put = calls.find(c => c.init && c.init.method === 'PUT');
    expect(put).toBeDefined();
    expect(put.url).toContain('/contents/docs/events.json');
    // Body must be base64-encoded JSON; not raw events.
    const body = JSON.parse(put.init.body);
    expect(body.branch).toBe('main');
    const decoded = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
    expect(decoded.events[0].name).toBe('X');
    expect(typeof decoded.last_updated).toBe('string');
  });

  it('publish endpoint rejects bad payload', async () => {
    const tok = await loggedInToken();
    const r = await fetchJson('POST', '/api/admin/publish-events',
      { not_events: [] },
      { Authorization: 'Bearer ' + tok });
    expect(r.status).toBe(400);
  });

  it('returns 503 when GITHUB_TOKEN is not configured', async () => {
    await stopApp();
    await startApp({ githubToken: null });
    const tok = await (async () => {
      const login = await fetchJson('POST', '/api/admin/login',
        { username: 'tristen', password: 'correct horse battery staple' });
      return login.json.token;
    })();
    const r = await fetchJson('POST', '/api/admin/publish-events',
      { events: [] }, { Authorization: 'Bearer ' + tok });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe('github-not-configured');
  });
});

describe('createAuth unit', () => {
  it('signToken / verifyToken round-trip', () => {
    const a = createAuth({ username: 'u', password: 'p', secret: 's', ttlHours: 1 });
    const tok = a.signToken();
    const v = a.verifyToken(tok);
    expect(v.ok).toBe(true);
    expect(v.payload.sub).toBe('u');
  });

  it('verifyToken rejects expired tokens', () => {
    const a = createAuth({ username: 'u', password: 'p', secret: 's', ttlHours: 1 });
    // Sign a token that's already expired.
    const tok = a.signToken({ now: Date.now() - 2 * 3600 * 1000 });
    const v = a.verifyToken(tok);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('expired');
  });

  it('verifyToken rejects tokens signed with a different secret', () => {
    const a = createAuth({ username: 'u', password: 'p', secret: 's1' });
    const b = createAuth({ username: 'u', password: 'p', secret: 's2' });
    const tok = a.signToken();
    expect(b.verifyToken(tok).ok).toBe(false);
  });

  it('checkLogin requires both fields', () => {
    const a = createAuth({ username: 'u', password: 'p', secret: 's' });
    expect(a.checkLogin({ username: 'u', password: 'p' }).ok).toBe(true);
    expect(a.checkLogin({ username: 'u', password: 'q' }).ok).toBe(false);
    expect(a.checkLogin({ username: 'v', password: 'p' }).ok).toBe(false);
  });

  it('configured = false when any of the three is missing', () => {
    expect(createAuth({ username: '', password: 'p', secret: 's' }).configured).toBe(false);
    expect(createAuth({ username: 'u', password: '', secret: 's' }).configured).toBe(false);
    expect(createAuth({ username: 'u', password: 'p', secret: '' }).configured).toBe(false);
  });
});
