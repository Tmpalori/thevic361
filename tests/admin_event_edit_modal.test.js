// DOM-level tests for the admin event-edit modal (PR #22).
//
// These exercise admin.js inside jsdom to verify:
//   - The modal HTML is present in admin.html with the expected fields
//   - openEventEditModal prefills the form from a candidate event
//   - readEditFormPayload reads form state back into a clean payload
//   - showEditFormErrors renders per-field messages

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(__dirname, '..', 'docs');

const HTML = readFileSync(resolve(DOCS, 'admin.html'), 'utf8');
const JS = readFileSync(resolve(DOCS, 'admin.js'), 'utf8');

function bootDom({ session = 'test-session' } = {}) {
  const bodyMatch = HTML.match(/<body>([\s\S]*?)<\/body>/);
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : '';
  document.querySelectorAll('script[src*="admin.js"]').forEach(s => s.remove());
  delete window.__vic361Admin;
  window.localStorage.clear();
  if (session) window.localStorage.setItem('vic361_admin_session', session);

  if (!window.__originalFetch) window.__originalFetch = window.fetch;
  window.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/api/admin/me')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, kind: 'session' }) };
    }
    if (u.includes('/api/config')) {
      return { ok: true, status: 200, json: async () => ({
        admin_login_enabled: true,
        admin_legacy_token_enabled: false,
        github_publish_enabled: false
      }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

  // eslint-disable-next-line no-eval
  (0, eval)(JS);
  return window.__vic361Admin;
}

describe('admin event edit modal — static structure', () => {
  beforeEach(() => bootDom());
  afterEach(() => { delete window.__vic361Admin; });

  it('exposes the modal container, form, and core inputs', () => {
    const ids = [
      'event-edit-modal', 'event-edit-form', 'event-edit-form-error',
      'event-edit-status', 'event-edit-save-btn', 'event-edit-title'
    ];
    for (const id of ids) {
      expect(document.getElementById(id), `missing #${id}`).not.toBeNull();
    }
    const form = document.getElementById('event-edit-form');
    const required = ['name', 'date', 'time', 'end_time', 'venue', 'address',
      'description', 'url', 'free'];
    for (const f of required) {
      expect(form.elements[f], `missing form field ${f}`).toBeTruthy();
    }
    // 9 icon checkboxes match the validate.js ALLOWED_ICONS set.
    const iconBoxes = form.querySelectorAll('input[name="icons"]');
    expect(iconBoxes.length).toBe(9);
  });

  it('the modal is hidden by default', () => {
    expect(document.getElementById('event-edit-modal').hidden).toBe(true);
  });
});

describe('admin event edit modal — interactions', () => {
  let api;
  beforeEach(() => { api = bootDom(); });
  afterEach(() => { delete window.__vic361Admin; });

  it('openEventEditModal prefills every field from the candidate', () => {
    const ev = {
      date: '2026-04-27',
      name: 'JP Music Night',
      time: '7:00 PM',
      end_time: '10:00 PM',
      venue: 'The Barn',
      address: '123 Main St',
      description: 'Live music with JP.',
      url: 'https://facebook.com/foo',
      icons: ['music', 'free'],
      free: true
    };
    api.openEventEditModal(ev);
    const form = document.getElementById('event-edit-form');
    expect(document.getElementById('event-edit-modal').hidden).toBe(false);
    expect(form.elements['name'].value).toBe('JP Music Night');
    expect(form.elements['date'].value).toBe('2026-04-27');
    expect(form.elements['time'].value).toBe('7:00 PM');
    expect(form.elements['end_time'].value).toBe('10:00 PM');
    expect(form.elements['venue'].value).toBe('The Barn');
    expect(form.elements['address'].value).toBe('123 Main St');
    expect(form.elements['description'].value).toBe('Live music with JP.');
    expect(form.elements['url'].value).toBe('https://facebook.com/foo');
    expect(form.elements['free'].checked).toBe(true);
    const checked = Array.from(form.querySelectorAll('input[name="icons"]:checked'))
      .map(cb => cb.value).sort();
    expect(checked).toEqual(['free', 'music']);
  });

  it('readEditFormPayload returns the trimmed payload from the form', () => {
    api.openEventEditModal({
      date: '2026-04-27', name: '  JP  ', venue: 'Barn',
      description: 'desc', time: '7pm'
    });
    const form = document.getElementById('event-edit-form');
    form.elements['name'].value = '  JP Trimmed  ';
    form.elements['url'].value = 'example.com/foo';
    form.querySelector('input[name="icons"][value="music"]').checked = true;
    const payload = api.readEditFormPayload();
    expect(payload.name).toBe('JP Trimmed');
    expect(payload.url).toBe('example.com/foo');
    expect(payload.icons).toContain('music');
  });

  it('closeEventEditModal hides the modal and clears errors', () => {
    api.openEventEditModal({ date: '2026-04-27', name: 'A', venue: 'B' });
    api.showEditFormErrors({ name: 'bad name' });
    expect(document.querySelector('[data-error-for="name"]').textContent)
      .toBe('bad name');
    api.closeEventEditModal();
    expect(document.getElementById('event-edit-modal').hidden).toBe(true);
    expect(document.querySelector('[data-error-for="name"]').textContent).toBe('');
  });

  it('showEditFormErrors highlights fields and surfaces a top-level message', () => {
    api.openEventEditModal({ date: '2026-04-27', name: 'A', venue: 'B' });
    api.showEditFormErrors({
      name: 'Event name is required.',
      date: 'Date must look like YYYY-MM-DD.'
    });
    expect(document.querySelector('[data-error-for="name"]').textContent)
      .toContain('required');
    expect(document.querySelector('[data-error-for="date"]').textContent)
      .toContain('YYYY-MM-DD');
    expect(document.getElementById('event-edit-form-error').hidden).toBe(false);
  });
});
