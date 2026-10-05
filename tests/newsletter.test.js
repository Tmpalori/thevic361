// @vitest-environment node
//
// Resend newsletter (server/newsletter.js). Resend is replaced with a
// recording fake; nothing is emailed.

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore, } from '../server/db.js';
import { withPages } from '../server/seo.js';
import { renderWeekly, renderWelcomeEmail, normalizeEmail, signupSource, renderSubscribePage } from '../server/newsletter.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = new Date('2026-10-05T13:00:00Z'); // Monday Oct 5, 8 AM CDT

const EVENTS = [
  { date: '2026-10-09', name: 'Friday <Live> Music', time: '8:00 PM', venue: 'Aero Crafters', icons: ['music'] },
  { date: '2026-10-10', name: 'Farmers Market', time: '8:00 AM', venue: 'Market Square', free: true, featured: true },
  { date: '2026-10-03', name: 'Last Week', time: '7 PM' }
];

let tmpDir, server, baseUrl, store, sent;

function fakeResend() {
  sent = { single: [], batches: [] };
  return {
    send: async (msg) => { sent.single.push(msg); return { id: 'e1' }; },
    batch: async (msgs, key) => { sent.batches.push({ msgs, key }); return { data: msgs.map((_, i) => ({ id: `b${i}` })) }; }
  };
}

async function startApp(extra = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-nl-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: EVENTS, sponsor: { name: 'Acme Tacos', text: 'Best tacos.', cta: 'Order', url: 'https://acme.example' } }));
  store = new FileStore(path.join(tmpDir, 's.json'));
  const { app } = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
    siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c',
    resendApiKey: 're_test', newsletterAddress: '123 Main St, Victoria, TX 77901',
    newsletterCronSecret: 'cron-secret', resend: fakeResend(), ...extra
  });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  server = null; tmpDir = null;
});

const post = (p, body, headers = {}) => fetch(baseUrl + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {})
});
async function auth() {
  const r = await post('/api/admin/login', { username: 'a', password: 'b' });
  return { Authorization: `Bearer ${(await r.json()).token}` };
}

describe('newsletter content', () => {
  it('renders the rest of the week, featured first, escaped, with unsubscribe and address', () => {
    const issue = renderWeekly(withPages(EVENTS), {
      siteUrl: 'https://www.thevic361.com', now: NOW, sponsor: null,
      unsubscribeUrl: 'https://www.thevic361.com/unsubscribe?token=t', address: '123 Main St'
    });
    expect(issue.total).toBe(2);
    expect(issue.subject).toBe('This week in Victoria: 2 things to do (Oct 5–Oct 11)');
    expect(issue.html).toContain('Friday &lt;Live&gt; Music');
    expect(issue.html).not.toContain('Last Week');
    expect(issue.html).toContain('https://www.thevic361.com/events/2026-10-09-friday-live-music');
    expect(issue.html).toContain('unsubscribe?token=t');
    expect(issue.html).toContain('123 Main St');
    expect(issue.text).toContain('Unsubscribe: https://www.thevic361.com/unsubscribe?token=t');
  });

  it('normalizes emails', () => {
    expect(normalizeEmail('  Me@Example.COM ')).toBe('me@example.com');
    expect(normalizeEmail('nope')).toBeNull();
    expect(normalizeEmail('a@b.co"><script>')).toBeNull();
  });
});

describe('welcome email', () => {
  it('lists the coming week with Vic\'s Picks first and escapes event names', () => {
    const mail = renderWelcomeEmail(withPages(EVENTS), { siteUrl: 'https://www.thevic361.com', now: NOW, sponsor: null,
      unsubscribeUrl: 'https://www.thevic361.com/unsubscribe?token=t', address: 'PO Box 1, Victoria, TX' });
    expect(mail.subject).toBe('Welcome to The Vic 361');
    expect(mail.html.indexOf('Farmers Market')).toBeLessThan(mail.html.indexOf('Friday &lt;Live&gt; Music'));
    expect(mail.html).not.toContain('<Live>');
    expect(mail.html).not.toContain('Last Week'); // already past
    expect(mail.text).toContain('Saturday 8:00 AM: Farmers Market');
    expect(mail.text).toContain('Unsubscribe: https://www.thevic361.com/unsubscribe?token=t');
  });
});

describe('signup flow', () => {
  it('double opt-in: pending, confirmation email, confirm link activates', async () => {
    await startApp();
    expect((await post('/api/subscribe', { email: 'bad' })).status).toBe(400);
    const r = await post('/api/subscribe', { email: 'Fan@Example.com' });
    expect(r.status).toBe(200);
    expect(sent.single).toHaveLength(1);
    expect(sent.single[0].to).toEqual(['fan@example.com']);
    const link = sent.single[0].html.match(/https:\/\/www\.thevic361\.com\/subscribe\/confirm\?token=([^"&]+)/);
    expect(link).toBeTruthy();
    expect((await store.countSubscribers()).pending).toBe(1);

    const c = await fetch(`${baseUrl}/subscribe/confirm?token=${link[1]}`);
    expect(c.status).toBe(200);
    expect(await c.text()).toContain('You&#39;re subscribed');
    expect((await store.countSubscribers()).active).toBe(1);
    await new Promise(r => setTimeout(r, 50)); // the welcome email goes out after the page
    expect(sent.single).toHaveLength(2);

    // Signing up again while active sends nothing.
    await post('/api/subscribe', { email: 'fan@example.com' });
    expect(sent.single).toHaveLength(2);
  });

  it('sends one welcome email and one Slack ping on the first confirm only', async () => {
    const pings = [];
    await startApp({ slack: { enabled: true, notify: async (m) => { pings.push(m); return true; }, alert: async () => {} } });
    await post('/api/subscribe', { email: 'new@example.com' });
    const token = sent.single[0].html.match(/confirm\?token=([^"&]+)/)[1];
    await fetch(`${baseUrl}/subscribe/confirm?token=${token}`);
    await fetch(`${baseUrl}/subscribe/confirm?token=${token}`); // second click, or a mail scanner
    await new Promise(r => setTimeout(r, 50));
    const welcomes = sent.single.filter(m => m.subject === 'Welcome to The Vic 361');
    expect(welcomes).toHaveLength(1);
    expect(welcomes[0].to).toEqual(['new@example.com']);
    expect(welcomes[0].headers['List-Unsubscribe']).toContain('/unsubscribe?token=');
    expect(welcomes[0].html).toContain('Farmers Market');
    expect(welcomes[0].html).toContain('Acme Tacos');
    expect(welcomes[0].html).toContain('123 Main St, Victoria, TX 77901');
    expect(pings.filter(p => p.title.includes('New newsletter subscriber'))).toHaveLength(1);
  });

  it('holds the welcome email when no mailing address is set', async () => {
    await startApp({ newsletterAddress: '' });
    await post('/api/subscribe', { email: 'new@example.com' });
    const token = sent.single[0].html.match(/confirm\?token=([^"&]+)/)[1];
    await fetch(`${baseUrl}/subscribe/confirm?token=${token}`);
    await new Promise(r => setTimeout(r, 50));
    expect(sent.single.filter(m => m.subject === 'Welcome to The Vic 361')).toHaveLength(0);
  });

  it('honeypot submissions are dropped silently', async () => {
    await startApp();
    expect((await post('/api/subscribe', { email: 'bot@example.com', company: 'x' })).status).toBe(200);
    expect(sent.single).toHaveLength(0);
    expect((await store.countSubscribers()).pending).toBe(0);
  });

  it('unsubscribe: GET shows a button, POST removes', async () => {
    await startApp();
    await store.importSubscribers(['fan@example.com'], 'import');
    const [sub] = await store.listSubscribers({ status: 'active' });
    const g = await fetch(`${baseUrl}/unsubscribe?token=${sub.token}`);
    expect(await g.text()).toContain('<form method="post"');
    expect((await store.countSubscribers()).active).toBe(1);
    const p = await fetch(`${baseUrl}/unsubscribe?token=${sub.token}`, { method: 'POST' });
    expect(p.status).toBe(200);
    expect((await store.countSubscribers()).unsubscribed).toBe(1);
    // An unsubscribed address isn't re-added by an import.
    const res = await store.importSubscribers(['fan@example.com'], 'import');
    expect(res.skipped_unsubscribed).toBe(1);
  });

  it('homepage always shows our form; without Resend, signups are saved directly', async () => {
    await startApp({ resendApiKey: '' });
    const html = await (await fetch(baseUrl + '/')).text();
    expect(html).toContain('id="signup-form"');
    expect(html).not.toContain('beehiiv');
    const r = await post('/api/subscribe', { email: 'x@example.com' });
    expect(r.status).toBe(200);
    expect((await r.json()).message).toContain('on the list');
    expect(sent.single).toHaveLength(0);
    expect((await store.countSubscribers()).active).toBe(1);
  });
});

describe('signup page', () => {
  it('/subscribe has the pitch, a form tagged subscribe-page, and the next week of events', async () => {
    await startApp();
    const r = await fetch(baseUrl + '/subscribe');
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('in your inbox every Monday');
    expect(html).toContain('id="signup-form"');
    expect(html).toContain('data-source="subscribe-page"');
    expect(html).toContain('Subscribe free');
    // Proof: upcoming events, Vic's Pick first, last week's left out.
    expect(html).toContain('2 things to do in Victoria in the next seven days');
    expect(html.indexOf('Farmers Market')).toBeLessThan(html.indexOf('Friday &lt;Live&gt; Music'));
    expect(html).not.toContain('Last Week');
    expect(html).toContain('<link rel="canonical" href="https://www.thevic361.com/subscribe">');
    expect(html).not.toContain('noindex');
    expect(html).not.toContain('Victoria locals who already get it'); // no count until there's a crowd
  });

  it('shows the subscriber count only once it is a real crowd', () => {
    const page = n => renderSubscribePage([], { siteUrl: 'https://x', now: NOW, subscriberCount: n });
    expect(page(99)).not.toContain('locals who already get it');
    expect(page(137)).toContain('Join 130+ Victoria locals');
  });

  it('every Subscribe button on the site points at /subscribe', async () => {
    await startApp();
    for (const p of ['/', '/this-weekend', '/about']) {
      const html = await (await fetch(baseUrl + p)).text();
      expect(html).toContain('href="/subscribe"');
      expect(html).not.toContain('href="/#subscribe"');
      expect(html).not.toContain('href="#subscribe"');
    }
    expect(await (await fetch(baseUrl + '/sitemap.xml')).text()).toContain('<loc>https://www.thevic361.com/subscribe</loc>');
  });

  it('records where a signup came from, ad visits included', async () => {
    expect(signupSource('subscribe-page')).toBe('subscribe-page');
    expect(signupSource('list-card:ad')).toBe('list-card:ad');
    expect(signupSource('footer:bogus')).toBe('footer');
    expect(signupSource('<script>')).toBe('site');
    expect(signupSource(undefined)).toBe('site');
    await startApp({ resendApiKey: '' });
    await post('/api/subscribe', { email: 'ad@example.com', source: 'subscribe-page:ad' });
    await post('/api/subscribe', { email: 'old@example.com' });
    const subs = await store.listSubscribers({ status: 'active' });
    expect(Object.fromEntries(subs.map(x => [x.email, x.source]))).toEqual({
      'ad@example.com': 'subscribe-page:ad', 'old@example.com': 'site'
    });
  });

  it('newsletter footer invites forwarded readers to subscribe', () => {
    const issue = renderWeekly(withPages(EVENTS), {
      siteUrl: 'https://www.thevic361.com', now: NOW, sponsor: null, unsubscribeUrl: 'u', address: 'a'
    });
    expect(issue.html).toContain('Forwarded this? <a href="https://www.thevic361.com/subscribe"');
  });
});

describe('sending', () => {
  it('admin import, status, test and send; one send per week', async () => {
    await startApp();
    const h = await auth();
    const imp = await (await post('/api/admin/newsletter/import', { emails: 'a@example.com, b@example.com\nnot-an-email' }, h)).json();
    expect(imp).toMatchObject({ ok: true, added: 2 });

    const st = await (await fetch(baseUrl + '/api/admin/newsletter', { headers: h })).json();
    expect(st).toMatchObject({ configured: true, address_set: true, counts: { active: 2 } });
    expect(st.next.events).toBe(2);

    const t = await (await post('/api/admin/newsletter/test', { email: 'me@example.com' }, h)).json();
    expect(t).toMatchObject({ ok: true, to: 'me@example.com' });
    expect(sent.single.at(-1).subject.startsWith('[Test] ')).toBe(true);

    const s = await post('/api/admin/newsletter/send', {}, h);
    expect(s.status).toBe(200);
    expect(sent.batches).toHaveLength(1);
    const msgs = sent.batches[0].msgs;
    expect(msgs.map(m => m.to[0]).sort()).toEqual(['a@example.com', 'b@example.com']);
    expect(msgs[0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(msgs[0].headers['List-Unsubscribe']).not.toBe(msgs[1].headers['List-Unsubscribe']);
    expect(msgs[0].html).toContain('Acme Tacos');
    expect(sent.batches[0].key).toBe('vic361-2026-10-05-0');

    const again = await post('/api/admin/newsletter/send', {}, h);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe('already-sent');
    expect(sent.batches).toHaveLength(1);
  });

  it('cron endpoint needs the secret and skips a week already sent', async () => {
    await startApp();
    await store.importSubscribers(['a@example.com'], 'import');
    expect((await post('/api/newsletter/cron', {})).status).toBe(401);
    expect((await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'wrong-secret' })).status).toBe(401);
    const ok = await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' });
    expect(ok.status).toBe(200);
    expect(sent.batches).toHaveLength(1);
    const dup = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(dup.error).toBe('already-sent');
    expect(sent.batches).toHaveLength(1);
  });

  it('cron is closed when no secret is configured', async () => {
    await startApp({ newsletterCronSecret: '' });
    expect((await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': '' })).status).toBe(401);
  });
});

describe('send failures', () => {
  it('a failed batch is retried by the next cron, only for the people who missed it', async () => {
    let fail = true;
    const calls = [];
    const resend = {
      send: async () => ({ id: 'x' }),
      batch: async (msgs, key) => {
        calls.push({ to: msgs.map(m => m.to[0]), key });
        if (fail && msgs.some(m => m.to[0] === 'b@example.com')) throw new Error('Resend down');
        return { data: msgs.map((_, i) => ({ id: `b${i}` })) };
      }
    };
    await startApp({ resend });
    await store.importSubscribers(['a@example.com', 'b@example.com'], 'import');
    const first = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(first.ok).toBe(false);
    expect(first.failed).toBe(2); // one batch holds both

    fail = false;
    const retry = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(retry.ok).toBe(true);
    expect(calls[calls.length - 1].to.sort()).toEqual(['a@example.com', 'b@example.com']);
    expect(calls[calls.length - 1].key).not.toBe(calls[0].key);

    const again = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(again.error).toBe('already-sent');
  });

  it('refuses to send without a mailing address', async () => {
    await startApp({ newsletterAddress: '' });
    await store.importSubscribers(['a@example.com'], 'import');
    const r = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(r.error).toBe('no-address');
    expect(sent.batches).toHaveLength(0);
  });

  it('a non-ASCII cron header is rejected, not a crash', async () => {
    await startApp();
    const r = await fetch(baseUrl + '/api/newsletter/cron', { method: 'POST', headers: { 'X-Cron-Secret': Buffer.from('crön-secret1', 'latin1').toString('latin1') } });
    expect(r.status).toBe(401);
  });
});
