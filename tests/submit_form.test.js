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
    fill({
      name: 'Test', date: '2026-05-12', time: '7 PM',
      venue: 'V', address: 'A', url: 'https://x.test',
      description: 'd', submitter_name: 'Jane', submitter_email: 'j@x.com'
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
  });

  it('honeypot value is included in the payload (server detects it)', () => {
    fill({ name: 'X', date: '2026-05-12', time: '7 PM', venue: 'V', company: 'AcmeBots' });
    const out = api.collectForm();
    expect(out.company).toBe('AcmeBots');
  });
});
