// Smoke test for the public submit-an-event page (docs/submit.html +
// submit.js). Verifies the form structure, honeypot wiring, and the data
// shape collectForm() will POST to /api/submissions.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(__dirname, '..', 'docs');
const HTML = readFileSync(resolve(DOCS, 'submit.html'), 'utf8');
const JS = readFileSync(resolve(DOCS, 'submit.js'), 'utf8');

function bootDom() {
  const bodyMatch = HTML.match(/<body>([\s\S]*?)<\/body>/);
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : '';
  document.querySelectorAll('script[src*="submit.js"]').forEach(s => s.remove());

  delete window.__vic361Submit;
  // Stub fetch so init() doesn't try to talk to a real /api/config.
  window.fetch = async () => ({ ok: false, json: async () => null });
  // eslint-disable-next-line no-eval
  (0, eval)(JS);
  return window.__vic361Submit;
}

describe('submit.html structure', () => {
  beforeEach(() => bootDom());

  it('exposes the form, honeypot, and turnstile mount', () => {
    const ids = [
      'submit-form', 'f-name', 'f-date', 'f-time', 'f-end', 'f-venue',
      'f-address', 'f-url', 'f-desc', 'f-icons', 'f-company', 'f-turnstile',
      'submit-btn', 'thanks-card', 'submit-another', 'form-error'
    ];
    for (const id of ids) {
      expect(document.getElementById(id), `missing #${id}`).not.toBeNull();
    }
  });

  it('honeypot field is in DOM but visually hidden', () => {
    const hp = document.getElementById('f-company');
    expect(hp).not.toBeNull();
    const wrap = hp.closest('.hp-field');
    expect(wrap).not.toBeNull();
  });

  it('renders a fieldset for submitter type with three options', () => {
    const opts = document.querySelectorAll('input[name="submitter_kind"]');
    expect(opts.length).toBe(3);
    expect(Array.from(opts).map(o => o.value).sort()).toEqual(['found_online', 'organizer', 'other']);
  });

  it('exposes category checkboxes from the allow-list', () => {
    const cats = Array.from(document.querySelectorAll('input[name="icons"]')).map(c => c.value);
    expect(cats).toEqual(expect.arrayContaining(['music', 'food', 'family', 'community']));
  });

  it('marks description as required and exposes a field-error slot for it', () => {
    const desc = document.getElementById('f-desc');
    expect(desc).not.toBeNull();
    expect(desc.required).toBe(true);
    const err = document.querySelector('[data-error-for="description"]');
    expect(err).not.toBeNull();
  });
});

describe('submit.js — collectForm()', () => {
  let api;
  beforeEach(() => { api = bootDom(); });

  function fill(values) {
    for (const [name, val] of Object.entries(values)) {
      const el = document.querySelector(`[name="${name}"]`);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = Boolean(val);
      else el.value = val;
    }
  }

  it('returns the canonical event shape with bot-signal extras', () => {
    // Time is a select now — populate it first so it has options to pick.
    api.populateTimeSelects();
    fill({
      name: 'Test', date: '2026-05-12', time: '7:00 PM',
      venue: 'V', address: 'A', url: 'https://x.test',
      description: 'd',
      submitter_first_name: 'Jane', submitter_last_name: 'Doe',
      submitter_email: 'j@x.com', submitter_phone: '(361) 555-0000'
    });
    document.querySelector('input[name="icons"][value="music"]').checked = true;
    api.setTurnstileToken('cf-token');
    const out = api.collectForm();
    expect(out.name).toBe('Test');
    expect(out.icons).toContain('music');
    expect(out.turnstile_token).toBe('cf-token');
    expect(typeof out.elapsed_ms).toBe('number');
    expect(out.company).toBe('');
    expect(out.submitter_kind).toBe('organizer');
    expect(out.submitter_first_name).toBe('Jane');
    expect(out.submitter_last_name).toBe('Doe');
    expect(out.submitter_name).toBe('Jane Doe');
    expect(out.submitter_phone).toBe('(361) 555-0000');
  });

  it('honeypot value is included in the payload (server detects it)', () => {
    fill({ name: 'X', date: '2026-05-12', time: '7 PM', venue: 'V', company: 'AcmeBots' });
    const out = api.collectForm();
    expect(out.company).toBe('AcmeBots');
  });
});

describe('submit form: errors you can see, phone formatting', () => {
  let api;
  beforeEach(() => { api = bootDom(); });

  it('formats US phone numbers as you type and leaves international ones alone', () => {
    expect(['3', '361', '3615', '361555', '3615550', '3615550100', '13615550100', '(361)5550100', '361-555-0100']
      .map(api.formatPhone)).toEqual(['(3', '(361', '(361) 5', '(361) 555', '(361) 555-0', '(361) 555-0100',
      '(361) 555-0100', '(361) 555-0100', '(361) 555-0100']);
    expect(api.formatPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(api.formatPhone('')).toBe('');
  });

  it('catches missing and bad fields before sending, with the server’s wording', () => {
    const errs = api.checkForm({ name: 'Show', date: '2026-10-17', time: '7:00 PM', venue: 'V', address: 'A',
      description: 'D', submitter_first_name: 'Pat', submitter_last_name: '', submitter_email: 'nope', submitter_phone: '555-01' });
    expect(errs).toEqual({ submitter_last_name: 'Last name is required.', submitter_email: 'Email looks invalid.',
      submitter_phone: 'Phone number looks incomplete.' });
  });

  it('outlines each problem field, names the problems by the button, and focuses the first', () => {
    api.showErrors({ submitter_phone: 'Phone number is required.', time: 'Start time is required.' });
    expect(document.querySelector('[name="submitter_phone"]').getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('[name="time"]').getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('[data-error-for="submitter_phone"]').textContent).toBe('Phone number is required.');
    const fe = document.getElementById('form-error');
    expect(fe.hidden).toBe(false);
    expect(fe.textContent).toBe('Please fix: Phone number is required. Start time is required.');
    expect(document.activeElement.name).toBe('submitter_phone');
  });
});

describe('submit form: live preview and site icons', () => {
  let api;
  beforeEach(() => { api = bootDom(); });

  it('uses the site’s drawn icons instead of emoji', () => {
    const chips = [...document.querySelectorAll('#f-icons .chip')];
    expect(chips).toHaveLength(8);
    chips.forEach(c => expect(c.querySelector('use').getAttribute('href')).toMatch(/^\/icons\.svg#i-/));
    expect(document.getElementById('f-icons').textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('shows the listing as they type it', () => {
    const set = (n, v) => { document.querySelector(`#submit-form [name="${n}"]`).value = v; };
    set('name', '<b>Fall Fest</b>'); set('date', '2026-10-17'); set('venue', 'De Leon Plaza');
    set('description', 'Music and food.');
    const time = document.querySelector('#submit-form [name="time"]');
    time.value = time.options[2].value;
    document.querySelector('input[name="icons"][value="music"]').checked = true;
    api.updatePreview();
    expect(document.getElementById('sp-day').textContent).toBe('Saturday');
    expect(document.getElementById('sp-date').textContent).toBe('October 17');
    expect(document.getElementById('sp-name').textContent).toBe('<b>Fall Fest</b>');   // text, not HTML
    expect(document.getElementById('sp-name').innerHTML).toContain('&lt;b&gt;');
    expect(document.getElementById('sp-time').textContent).toBe(time.options[2].value);
    expect([...document.querySelectorAll('#sp-icons use')].map(u => u.getAttribute('href')))
      .toEqual(['/icons.svg#i-music', '/icons.svg#i-free']);                          // Free is on by default
  });
});

