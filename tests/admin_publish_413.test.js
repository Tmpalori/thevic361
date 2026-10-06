// Save & Publish turns a 413 (body over the server's limit) into words the
// owner can act on, not "too-large".

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const HTML = readFileSync(resolve(DOCS, 'admin.html'), 'utf8');
const JS = readFileSync(resolve(DOCS, 'admin.js'), 'utf8');

function bootDom() {
  const bodyMatch = HTML.match(/<body>([\s\S]*?)<\/body>/);
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : '';
  document.querySelectorAll('script[src*="admin.js"]').forEach(s => s.remove());
  delete window.__vic361Admin;
  window.localStorage.clear();
  window.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/api/config')) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: false, status: 401, json: async () => ({ ok: false }) };
  });
  // eslint-disable-next-line no-eval
  (0, eval)(JS);
  return window.__vic361Admin;
}

describe('Save & Publish over the size limit', () => {
  afterEach(() => { delete window.__vic361Admin; });

  it('says the list is too big instead of "too-large"', async () => {
    const api = bootDom();
    const live = [{ date: '2099-01-03', name: 'In Both', time: '8 PM', venue: 'B' }];
    window.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/api/admin/candidates')) return { ok: true, status: 200, json: async () => ({ ok: true, data: { events: live } }) };
      if (u.includes('/api/admin/published-events')) return { ok: true, status: 200, json: async () => ({ ok: true, events: live }) };
      if (u.includes('/api/admin/publish-events')) return { ok: false, status: 413, json: async () => ({ ok: false, error: 'too-large' }) };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    api._state.session = 'tok';
    await api.loadCandidates();
    window.confirm = vi.fn(() => true);
    api._state.session = 'tok';
    await api.publish();
    const msg = document.getElementById('status-message').textContent;
    expect(msg).toMatch(/too big/i);
    expect(msg).not.toMatch(/too-large/);
  });
});
