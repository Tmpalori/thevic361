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

// ─── Source URL: clickable link + selectable input ────────────────────────
//
// The user reported they couldn't click the source link from the admin and
// couldn't highlight the URL inside the edit modal. These tests guard the
// fixes:
//   - clicking a source link in a picker row doesn't toggle the row
//   - the URL input is NOT inside a parent <label> (which on some browsers
//     swallows mousedown drags and prevents text selection)
//   - the modal exposes an "Open ↗" link that points at the same href and
//     opens in a new tab safely (rel includes noopener+noreferrer)

describe('admin source URL — clickable + selectable', () => {
  let api;
  beforeEach(() => { api = bootDom(); });
  afterEach(() => { delete window.__vic361Admin; });

  it('the URL input is NOT wrapped by a <label> ancestor', () => {
    // The bug we are fixing: when the input is wrapped by <label>, mousedown
    // drags inside the input get treated as label clicks, so the admin can't
    // select text. The fix moved the URL field to a <div> with a sibling
    // <label for="event-edit-url"> caption.
    const input = document.getElementById('event-edit-url');
    expect(input, 'event-edit-url input is missing').toBeTruthy();
    expect(input.closest('label')).toBeNull();
    // The input is still labelled for assistive tech via for/id:
    const lbl = document.querySelector('label[for="event-edit-url"]');
    expect(lbl, 'expected an explicit label[for=event-edit-url]').toBeTruthy();
  });

  it('isHttpUrl accepts http/https only and rejects unsafe schemes', () => {
    expect(api.isHttpUrl('https://example.com/foo')).toBe(true);
    expect(api.isHttpUrl('http://example.com')).toBe(true);
    expect(api.isHttpUrl('  https://example.com  ')).toBe(true);
    expect(api.isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(api.isHttpUrl('mailto:a@b.co')).toBe(false);
    expect(api.isHttpUrl('not a url')).toBe(false);
    expect(api.isHttpUrl('')).toBe(false);
    expect(api.isHttpUrl(null)).toBe(false);
  });

  it('opening a candidate with a URL reveals the modal "Open ↗" link', () => {
    api.openEventEditModal({
      date: '2026-04-27', name: 'X', venue: 'Y',
      url: 'https://facebook.com/foo/bar'
    });
    const link = document.getElementById('event-edit-url-open');
    expect(link).toBeTruthy();
    expect(link.hidden).toBe(false);
    expect(link.getAttribute('href')).toBe('https://facebook.com/foo/bar');
    expect(link.getAttribute('target')).toBe('_blank');
    // Both noopener and noreferrer must be present.
    const rel = (link.getAttribute('rel') || '').toLowerCase();
    expect(rel).toContain('noopener');
    expect(rel).toContain('noreferrer');
  });

  it('opening a candidate with no URL hides the modal "Open ↗" link', () => {
    api.openEventEditModal({
      date: '2026-04-27', name: 'X', venue: 'Y', url: ''
    });
    const link = document.getElementById('event-edit-url-open');
    expect(link.hidden).toBe(true);
    expect(link.hasAttribute('href')).toBe(false);
  });

  it('typing a valid URL into the input live-updates the "Open ↗" link', () => {
    api.openEventEditModal({ date: '2026-04-27', name: 'X', venue: 'Y' });
    const input = document.getElementById('event-edit-url');
    input.value = 'https://example.com/event/42';
    api.syncEditUrlOpenLink();
    const link = document.getElementById('event-edit-url-open');
    expect(link.hidden).toBe(false);
    expect(link.getAttribute('href')).toBe('https://example.com/event/42');

    // Switching back to invalid (e.g. javascript:) hides + clears the href.
    input.value = 'javascript:alert(1)';
    api.syncEditUrlOpenLink();
    expect(link.hidden).toBe(true);
    expect(link.hasAttribute('href')).toBe(false);
  });

  it('the URL input is not blocked from text selection by inline CSS', () => {
    // `user-select: none` (or its vendor prefixes) on an input or any
    // ancestor would prevent the admin from drag-selecting the URL. We
    // walk up the tree from the input and verify no inline rule disables
    // selection.
    const input = document.getElementById('event-edit-url');
    let el = input;
    while (el && el !== document.body) {
      const style = el.getAttribute('style') || '';
      expect(style).not.toMatch(/user-select\s*:\s*none/i);
      el = el.parentElement;
    }
  });

  it('renders a clickable source link in the picker row', () => {
    // Seed candidates and call the picker render through the public path:
    // we set state.candidates and then read the DOM admin.js produces.
    api._state.candidates = [{
      date: '2026-04-27', name: 'JP Night', venue: 'Barn',
      url: 'https://facebook.com/jp/events/123'
    }];
    // Bypass week filter — the "this week" filter would hide our test row
    // since 2026-04-27 may not match the live clock.
    api._state.filters.week = 'upcoming';
    // Re-run the picker via a manual dispatch: admin.js wires renderPicker
    // internally on filter changes, so trigger one.
    document.getElementById('filter-week').value = 'upcoming';
    document.getElementById('filter-week').dispatchEvent(new Event('change'));

    const links = document.querySelectorAll(
      '#picker-list a[data-act="open-source"]'
    );
    expect(links.length).toBeGreaterThanOrEqual(1);
    const a = links[0];
    expect(a.getAttribute('href')).toBe('https://facebook.com/jp/events/123');
    expect(a.getAttribute('target')).toBe('_blank');
    const rel = (a.getAttribute('rel') || '').toLowerCase();
    expect(rel).toContain('noopener');
    expect(rel).toContain('noreferrer');
  });

  it('clicking the picker source link does not toggle the row checkbox', () => {
    api._state.candidates = [{
      date: '2026-04-27', name: 'JP Night', venue: 'Barn',
      url: 'https://facebook.com/jp/events/123'
    }];
    api._state.filters.week = 'upcoming';
    document.getElementById('filter-week').value = 'upcoming';
    document.getElementById('filter-week').dispatchEvent(new Event('change'));

    const before = api._state.selected.size;
    const link = document.querySelector(
      '#picker-list a[data-act="open-source"]'
    );
    expect(link).toBeTruthy();

    // jsdom would otherwise actually try to navigate. Suppress the default
    // so the test environment doesn't complain, but make sure stopPropagation
    // is what blocks the row checkbox from toggling — the click handler
    // installed by admin.js calls stopPropagation, so the surrounding
    // <label> never fires its synthetic checkbox click.
    link.addEventListener('click', (e) => e.preventDefault(), { once: true });
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(api._state.selected.size).toBe(before);
  });

  it('a non-http(s) ev.url is not rendered as a clickable source link', () => {
    api._state.candidates = [{
      date: '2026-04-27', name: 'X', venue: 'Y',
      url: 'javascript:alert(1)'
    }];
    api._state.filters.week = 'upcoming';
    document.getElementById('filter-week').value = 'upcoming';
    document.getElementById('filter-week').dispatchEvent(new Event('change'));
    const links = document.querySelectorAll(
      '#picker-list a[data-act="open-source"]'
    );
    expect(links.length).toBe(0);
  });
});
