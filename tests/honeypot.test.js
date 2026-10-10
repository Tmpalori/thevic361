// @vitest-environment node
//
// The spam trap on public forms (server/honeypot.js). It used to be a field
// named "company", which browsers autofill for business owners, silently
// dropping real submissions, signups and paid checkouts. Now it's a
// meaningless name, hidden with display:none; the old name still counts
// for pages cached before the rename; and a hit is logged and noted in
// Slack (at most once a day per form) instead of vanishing.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { HONEYPOT_FIELD, honeypotHit, reportHoneypot } from '../server/honeypot.js';
import { checkBotSignals } from '../server/validate.js';
import { renderContactPage } from '../server/contact.js';
import { signupFormHtml } from '../server/newsletter.js';

const NOW = new Date('2026-10-07T15:00:00Z');
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

let tmpDir, server, baseUrl, store, notes, sessions;

async function startApp() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-hp-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  store = new FileStore(path.join(tmpDir, 's.json'));
  notes = [];
  sessions = [];
  const { app } = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
    siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c',
    stripeSecretKey: 'sk_test', stripeWebhookSecret: 'whsec_test', resendApiKey: '',
    stripe: { createCheckoutSession: async (p) => { sessions.push(p); return { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }; } },
    slack: { enabled: true, notify: async (m) => { notes.push(m); return true; }, alert: async () => {} }
  });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

const json = (p, body) => fetch(baseUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const form = (p, fields) => fetch(baseUrl + p, {
  method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString()
});
const trapNotes = () => notes.filter(n => /Spam trap/.test(n.title));

describe('honeypot field', () => {
  it('has a name no autofill knows, and the old name still counts', () => {
    expect(HONEYPOT_FIELD).toBe('hp_field');
    expect(honeypotHit({ hp_field: 'x' })).toBe('hp_field');
    expect(honeypotHit({ company: 'Acme' })).toBe('company');
    expect(honeypotHit({ hp_field: '  ', company: '' })).toBe('');
    expect(honeypotHit(null)).toBe('');
    expect(checkBotSignals({ hp_field: 'x', elapsed_ms: 5000 })).toMatchObject({ ok: false, reason: 'honeypot', field: 'hp_field' });
    expect(checkBotSignals({ company: 'x', elapsed_ms: 5000 })).toMatchObject({ ok: false, reason: 'honeypot', field: 'company' });
    expect(checkBotSignals({ elapsed_ms: 5000 })).toEqual({ ok: true });
  });

  it('every public form renders the new field, hidden and out of reach, and never "company"', () => {
    const pages = {
      contact: renderContactPage({ siteUrl: 'https://www.thevic361.com' }),
      signup: signupFormHtml(),
      submit: readFileSync(path.join(ROOT, 'docs/submit.html'), 'utf8'),
      homepageCard: readFileSync(path.join(ROOT, 'docs/app.js'), 'utf8')
    };
    for (const [k, html] of Object.entries(pages)) {
      expect(html, k).toMatch(/name="hp_field"[^>]*tabindex="-1"[^>]*autocomplete="off"/);
      expect(html, k).not.toMatch(/name="company"/);
    }
    expect(pages.homepageCard).toContain('hp_field: form.hp_field.value');
    // display:none, not just off-screen (which autofill still reaches).
    for (const css of ['docs/style.css', 'docs/submit.css']) {
      expect(readFileSync(path.join(ROOT, css), 'utf8'), css).toMatch(/\.hp-field\s*\{\s*display:\s*none;?\s*\}/);
    }
    expect(readFileSync(path.join(ROOT, 'docs/submit.js'), 'utf8')).toContain("hp_field: get('hp_field')");
  });

  it('logs a hit and pings Slack at most once a day per form, with the count', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sent = [];
    const slack = { notify: async (m) => { sent.push(m); return true; } };
    let now = 0;
    const opts = { slack, nowFn: () => now };
    reportHoneypot('contact', 'hp_field', opts);
    reportHoneypot('contact', 'company', opts);
    reportHoneypot('newsletter signup', 'hp_field', opts);
    expect(sent.map(m => m.title)).toEqual(['🪤 Spam trap caught a contact form', '🪤 Spam trap caught a newsletter signup form']);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[1][0])).toContain('contact: trap field "company"');
    now = 25 * 60 * 60 * 1000;
    reportHoneypot('contact', 'hp_field', opts);
    expect(sent).toHaveLength(3);
    expect(sent[2].fields[0]).toEqual(['Caught', '2 since the last note']);
  });
});

describe('honeypot on each public form', () => {
  it.each(['hp_field', 'company'])('submit form drops a %s hit as if it worked', async (field) => {
    await startApp();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await json('/api/submissions', { name: 'X', date: '2026-10-10', venue: 'V', elapsed_ms: 9000, [field]: 'Acme' });
    expect(await r.json()).toEqual({ ok: true, queued: false });
    expect(trapNotes()).toHaveLength(1);
    expect(trapNotes()[0].fields).toContainEqual(['Field', field]);
  });

  it.each(['hp_field', 'company'])('newsletter signup drops a %s hit', async (field) => {
    await startApp();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await json('/api/subscribe', { email: 'bot@example.com', [field]: 'x' });
    expect(await r.json()).toEqual({ ok: true });
    expect((await store.countSubscribers()).pending).toBe(0);
    expect(trapNotes()).toHaveLength(1);
  });

  it.each(['hp_field', 'company'])('contact form drops a %s hit', async (field) => {
    await startApp();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await form('/contact', { name: 'Bot', email: 'b@b.example', message: 'spam spam', [field]: 'x' });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Message sent');
    expect(notes.filter(n => /Website message/.test(n.title))).toHaveLength(0);
    expect(trapNotes()).toHaveLength(1);
  });

  it.each(['hp_field', 'company'])('sponsor checkout drops a %s hit', async (field) => {
    await startApp();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const page = await (await fetch(baseUrl + '/advertise/checkout?package=weekly')).text();
    expect(page).toContain('name="hp_field"');
    const r = await form('/advertise/checkout', { package: 'weekly', [field]: 'Acme Inc' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/advertise');
    expect(sessions).toHaveLength(0);
    expect(trapNotes()).toHaveLength(1);
  });
});
