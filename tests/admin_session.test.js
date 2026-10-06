// Admin session handling in docs/admin.js: only a 401 that says the admin
// session itself is bad signs the owner out (a 401 about the server's
// GitHub token must not), and an expired session never falls back to a
// leftover GitHub PAT when server login is configured.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const HTML = readFileSync(resolve(DOCS, 'admin.html'), 'utf8');
const JS = readFileSync(resolve(DOCS, 'admin.js'), 'utf8');
const SESSION_KEY = 'vic361_admin_session';
const PAT_KEY = 'vic361_admin_pat';

function boot({ session = null, pat = null, meOk = true, routes = {} } = {}) {
  const body = HTML.match(/<body>([\s\S]*?)<\/body>/);
  document.body.innerHTML = body ? body[1] : '';
  document.querySelectorAll('script[src*="admin.js"]').forEach(s => s.remove());
  delete window.__vic361Admin;
  window.localStorage.clear();
  if (session) window.localStorage.setItem(SESSION_KEY, session);
  if (pat) window.localStorage.setItem(PAT_KEY, pat);
  window.fetch = vi.fn(async (url) => {
    const u = String(url);
    for (const [path, reply] of Object.entries(routes)) {
      if (u.includes(path)) return { ok: reply.status < 300, status: reply.status, json: async () => reply.json };
    }
    if (u.includes('/api/admin/me')) return { ok: meOk, status: meOk ? 200 : 401, json: async () => ({ ok: meOk }) };
    if (u.includes('/api/config')) {
      return { ok: true, status: 200, json: async () => ({ admin_login_enabled: true, admin_legacy_token_enabled: false, github_publish_enabled: false }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  // eslint-disable-next-line no-eval
  (0, eval)(JS);
  return window.__vic361Admin;
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

afterEach(() => { vi.restoreAllMocks(); });

describe('admin session: which 401s sign you out', () => {
  it('a 401 about the server\'s GitHub token keeps the owner signed in and shows the token help', async () => {
    const api = boot({ session: 'tok', routes: {
      '/api/admin/trigger-collect': { status: 401, json: { ok: false, error: 'github-token-invalid', github_status: 401 } }
    } });
    await settle();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await api.triggerCollect();
    expect(window.localStorage.getItem(SESSION_KEY)).toBe('tok');
    expect(api._state.session).toBe('tok');
    expect(document.getElementById('auth-gate').hidden).toBe(true);
    expect(document.body.textContent).toMatch(/GitHub token is invalid or expired/);
  });

  it('a 401 saying the session is bad still signs out', async () => {
    const api = boot({ session: 'tok', routes: {
      '/api/admin/trigger-collect': { status: 401, json: { ok: false, error: 'unauthorized' } }
    } });
    await settle();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await api.triggerCollect();
    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(document.getElementById('auth-gate').hidden).toBe(false);
  });
});

describe('admin session: an expired session with a leftover PAT', () => {
  it('shows the sign-in form instead of quietly switching to PAT publishing', async () => {
    const api = boot({ session: 'expired', pat: 'ghp_old', meOk: false });
    await settle();
    expect(document.getElementById('auth-gate').hidden).toBe(false);
    expect(document.getElementById('app').hidden).toBe(true);
    expect(api.publishMode()).toBeNull();
    expect(document.getElementById('auth-error').textContent).toMatch(/sign in again/i);
  });
});
