// The "Reply as news@" box in the admin (docs/admin.js), opened from a
// Slack link: admin.html#reply?to=…&subject=…&ref=…

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const HTML = readFileSync(resolve(DOCS, 'admin.html'), 'utf8');
const JS = readFileSync(resolve(DOCS, 'admin.js'), 'utf8');

function boot(calls) {
  document.body.innerHTML = HTML.match(/<body>([\s\S]*?)<\/body>/)[1];
  document.querySelectorAll('script[src]').forEach(s => s.remove());
  delete window.__vic361Admin;
  window.localStorage.clear();
  window.localStorage.setItem('vic361_admin_session', 'test-session');
  window.fetch = vi.fn(async (url, init) => {
    const u = String(url);
    if (u.includes('/api/admin/me')) return { ok: true, status: 200, json: async () => ({ ok: true, kind: 'session' }) };
    if (u.includes('/api/config')) return { ok: true, status: 200, json: async () => ({ admin_login_enabled: true }) };
    if (u.includes('/api/admin/email/reply')) {
      calls.push({ body: JSON.parse(init.body), auth: init.headers.Authorization });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  // eslint-disable-next-line no-eval
  (0, eval)(JS);
  return window.__vic361Admin;
}

afterEach(() => { delete window.__vic361Admin; history.replaceState(null, '', '/'); });

describe('reply as news@', () => {
  it('opens prefilled from the Slack link and sends with the session', async () => {
    history.replaceState(null, '', '/admin.html#reply?to=mary%40gmail.com&subject=Re%3A+This+week&ref=%3Cabc%40mail%3E');
    const calls = [];
    const admin = boot(calls);
    expect(admin.parseReplyHash('#reply?to=a%40b.com&subject=Hi')).toEqual({ to: 'a@b.com', subject: 'Hi', ref: '' });
    expect(admin.parseReplyHash('#events')).toBeNull();
    await vi.waitFor(() => expect(document.getElementById('reply-modal').hidden).toBe(false));
    const form = document.getElementById('reply-form');
    expect(form.elements.to.value).toBe('mary@gmail.com');
    expect(form.elements.subject.value).toBe('Re: This week');
    form.elements.text.value = 'Thanks, Mary!';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ auth: 'Bearer test-session',
      body: { to: 'mary@gmail.com', subject: 'Re: This week', text: 'Thanks, Mary!', ref: '<abc@mail>' } });
    await vi.waitFor(() => expect(document.getElementById('reply-status').textContent).toBe('Sent ✓'));
  });
});
