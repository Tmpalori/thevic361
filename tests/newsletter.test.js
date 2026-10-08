// @vitest-environment node
//
// Resend newsletter (server/newsletter.js). Resend is replaced with a
// recording fake; nothing is emailed.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore, } from '../server/db.js';
import { withPages } from '../server/seo.js';
import { renderWeekly, renderWelcomeEmail, normalizeEmail, signupSource, renderSubscribePage, darkSafe, createResend } from '../server/newsletter.js';
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
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

  it('puts the weekly sponsor at the top, in both the HTML and the text part', () => {
    const sponsor = { name: 'Acme Tacos', text: 'Best tacos.', cta: 'Order', url: 'https://acme.example', week: '2026-10-05' };
    const issue = renderWeekly(withPages(EVENTS), {
      siteUrl: 'https://www.thevic361.com', now: NOW, sponsor, unsubscribeUrl: 'https://www.thevic361.com/unsubscribe?token=t', address: 'a'
    });
    const sponsorAt = issue.html.indexOf("THIS WEEK'S SPONSOR");
    const firstDay = issue.html.indexOf('font-size:21px'); // the first day's heading
    expect(sponsorAt).toBeGreaterThan(-1);
    expect(sponsorAt).toBeLessThan(firstDay);
    // A paid order's button is counted through /go/s/<week>, then sent on.
    expect(issue.html).toContain('href="https://www.thevic361.com/go/s/2026-10-05?src=newsletter"');
    expect(issue.html).not.toContain('href="https://acme.example"');
    const lines = issue.text.split('\n');
    expect(lines[2]).toBe("THIS WEEK'S SPONSOR: Acme Tacos - Best tacos. - https://www.thevic361.com/go/s/2026-10-05?src=newsletter");
    // A hand-set sponsor (no order) links straight to its site.
    const manual = renderWeekly(withPages(EVENTS), { siteUrl: 'https://www.thevic361.com', now: NOW, sponsor: { ...sponsor, week: undefined }, unsubscribeUrl: 'u', address: 'a' });
    expect(manual.html).toContain('href="https://acme.example"');
  });

  it('tags links back to the site for the Traffic tab, but not unsubscribe or images', () => {
    const issue = renderWeekly(withPages(EVENTS), {
      siteUrl: 'https://www.thevic361.com', now: NOW, sponsor: null,
      unsubscribeUrl: 'https://www.thevic361.com/unsubscribe?token=t', address: 'a'
    });
    const tag = 'utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=weekly-2026-10-05';
    expect(issue.html).toContain(`https://www.thevic361.com/events/2026-10-09-friday-live-music?${tag}`);
    expect(issue.html).toContain(`https://www.thevic361.com/this-weekend?${tag}`);
    expect(issue.html).toContain('href="https://www.thevic361.com/unsubscribe?token=t"');
    expect(issue.html).toContain('src="https://www.thevic361.com/email/skyline.png"');
    expect(issue.text).toContain('https://www.thevic361.com/events/2026-10-09-friday-live-music?utm_source=newsletter&utm_medium=email&utm_campaign=weekly-2026-10-05');
    expect(issue.text).toContain('Unsubscribe: https://www.thevic361.com/unsubscribe?token=t\n');
    const welcome = renderWelcomeEmail(withPages(EVENTS), { siteUrl: 'https://www.thevic361.com', now: NOW, sponsor: null, unsubscribeUrl: 'https://www.thevic361.com/unsubscribe?token=t', address: 'a' });
    expect(welcome.html).toContain('utm_campaign=welcome');
    expect(welcome.html).toContain('href="https://www.thevic361.com/unsubscribe?token=t"');
  });

  it('says "1 thing" and a single date for a one-day, one-event week, and pads the preheader', () => {
    const sunday = new Date('2026-10-11T15:00:00Z');
    const issue = renderWeekly(withPages([{ date: '2026-10-11', name: 'Sunday Brunch', time: '11 AM' }]), {
      siteUrl: 'https://www.thevic361.com', now: sunday, sponsor: null, unsubscribeUrl: 'u', address: 'a'
    });
    expect(issue.subject).toBe('This week in Victoria: 1 thing to do (Oct 11)');
    expect(issue.html).toContain('<strong>1 event</strong>');
    expect(issue.html).toMatch(/Sunday Brunch(&#847;&zwnj;&nbsp;){80}<\/span>/);
  });

  it('normalizes emails', () => {
    expect(normalizeEmail('  Me@Example.COM ')).toBe('me@example.com');
    expect(normalizeEmail('nope')).toBeNull();
    expect(normalizeEmail('a@b.co"><script>')).toBeNull();
  });

  it('rejects addresses Resend would refuse (dots in the wrong place, bad domain labels)', () => {
    for (const bad of ['bob@gmail..com', '.bob@gmail.com', 'bob.@gmail.com', 'a..b@gmail.com', 'bob@.gmail.com',
      'bob@gmail.com.', 'bob@-gmail.com', 'bob@gmail-.com', 'bob@gmail.c', 'bob@gm_ail.com', 'bob@gmail.123']) {
      expect(normalizeEmail(bad), bad).toBeNull();
    }
    for (const good of ['first.last+tag@sub.example.co.uk', 'a_b-c@my-site.example', 'x@xn--bcher-kva.example']) {
      expect(normalizeEmail(good), good).toBe(good);
    }
  });
});

describe('review fixes: signups and privacy', () => {
  it('answers the same for new, pending and already-subscribed addresses', async () => {
    await startApp({ resendApiKey: '' });
    const first = await (await post('/api/subscribe', { email: 'a@example.com', source: 'footer' })).json();
    const again = await (await post('/api/subscribe', { email: 'a@example.com' })).json();
    expect(again).toEqual(first);
    expect(JSON.stringify(again)).not.toMatch(/already/i);
    const bot = await (await post('/api/subscribe', { email: 'b@example.com', company: 'spam' })).json();
    expect(bot).toEqual({ ok: true });
  });

  it('with Resend on, too: new, pending and active get one answer', async () => {
    await startApp();
    const fresh = await (await post('/api/subscribe', { email: 'n@example.com' })).json();
    const pending = await (await post('/api/subscribe', { email: 'n@example.com' })).json();
    await store.importSubscribers(['on@example.com'], 'import');
    const active = await (await post('/api/subscribe', { email: 'on@example.com' })).json();
    expect(pending).toEqual(fresh);
    expect(active).toEqual(fresh);
  });

  it('the forms count a Lead once per browser, not from the server\'s answer', async () => {
    await startApp();
    const html = await (await fetch(baseUrl + '/subscribe')).text();
    expect(html).toContain("was=localStorage.getItem('vic361-subscribed')==='1'");
    expect(html).not.toContain('x.j.new');
    const app = await fs.readFile(path.join(process.cwd(), 'docs/app.js'), 'utf8');
    expect(app).not.toContain('x.j.new');
  });

  it('a comeback keeps its new source', async () => {
    await startApp();
    await post('/api/subscribe', { email: 'p@example.com', source: 'footer' });
    const sub = (await store.listSubscribers({ status: 'active' }))[0];
    await store.unsubscribe(sub.token);
    await post('/api/subscribe', { email: 'p@example.com', source: 'subscribe-page:ad' });
    expect((await store.listSubscribers({ status: 'pending' }))[0].source).toBe('subscribe-page:ad');
  });

  it('sends a comeback at most 3 confirmation emails a day', async () => {
    await startApp();
    await store.importSubscribers(['flood@example.com'], 'import');
    await store.unsubscribe((await store.listSubscribers({ status: 'active' }))[0].token);
    for (let i = 0; i < 5; i++) expect((await post('/api/subscribe', { email: 'flood@example.com' })).status).toBe(200);
    expect(sent.single.filter(m => m.to[0] === 'flood@example.com')).toHaveLength(3);
  });

  it('a confirmation email that fails alerts the owner in Slack', async () => {
    const alerts = [];
    const resend = { send: async () => { throw new Error('Resend HTTP 401: bad key'); }, batch: async () => ({}) };
    await startApp({ resend, slack: { enabled: true, notify: async () => true, alert: async (key, title) => { alerts.push({ key, title }); } } });
    await store.importSubscribers(['x@example.com'], 'import');
    await store.unsubscribe((await store.listSubscribers({ status: 'active' }))[0].token);
    const r = await post('/api/subscribe', { email: 'x@example.com' });
    expect(r.status).toBe(500);
    expect(alerts).toEqual([{ key: 'newsletter-subscribe-failed', title: 'Newsletter signups are failing' }]);
  });

  it('a welcome email that fails keeps the signup and alerts the owner in Slack', async () => {
    const alerts = [];
    const resend = { send: async () => { throw new Error('Resend HTTP 401: bad key'); }, batch: async () => ({}) };
    await startApp({ resend, slack: { enabled: true, notify: async () => true, alert: async (key, title) => { alerts.push({ key, title }); } } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await post('/api/subscribe', { email: 'x@example.com' })).status).toBe(200);
      expect((await store.countSubscribers()).active).toBe(1);
      await vi.waitFor(() => expect(alerts).toEqual([{ key: 'newsletter-welcome-failed', title: 'Newsletter welcome emails are failing' }]), { timeout: 2000 });
    } finally {
      warn.mockRestore();
    }
  });

  it('pages reached by token links never load the Meta Pixel', async () => {
    await startApp();
    await post('/api/subscribe', { email: 't@example.com' });
    const sub = (await store.listSubscribers({ status: 'active' }))[0];
    const confirm = await (await fetch(`${baseUrl}/subscribe/confirm?token=${sub.token}`)).text();
    const unsub = await (await fetch(`${baseUrl}/unsubscribe?token=${sub.token}`)).text();
    expect(confirm).not.toContain('/pixel.js');
    expect(unsub).not.toContain('/pixel.js');
    expect(await (await fetch(baseUrl + '/subscribe')).text()).toContain('/pixel.js');
  });

  it('/subscribe gets the seasonal tabs and shows the day on each pick', async () => {
    await startApp();
    const html = await (await fetch(baseUrl + '/subscribe')).text();
    expect(html).not.toContain('SEASONAL_NAV');
    expect(html).toMatch(/event-time">Fri · 8:00 PM</);
    expect(html).toMatch(/event-time">Sat · 8:00 AM</);
  });

  it('has a privacy page linked from every footer', async () => {
    await startApp();
    const r = await fetch(baseUrl + '/privacy');
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('Meta Pixel');
    expect(html).toContain('Google Analytics');
    for (const p of ['/', '/about']) expect(await (await fetch(baseUrl + p)).text()).toContain('href="/privacy"');
  });
});

describe('dark mode', () => {
  it('paints backgrounds as images and tags colors so Outlook can be put back', () => {
    const out = darkSafe('<html><head></head><body style="margin:0;background:#FFF4D6;">' +
      '<td class="x" style="background:#3DBE8B;padding:4px;color:#1F1A3D;">a</td>' +
      '<a href="#" style="color:#4B3FD1;">b</a><span style="font-weight:bold">c</span></body></html>');
    expect(out).toContain('<body class="b-fff4d6" bgcolor="#FFF4D6" style="margin:0;background-color:#FFF4D6;background-image:linear-gradient(#FFF4D6,#FFF4D6);">');
    expect(out).toContain('<td class="x b-3dbe8b t-1f1a3d" bgcolor="#3DBE8B" style="background-color:#3DBE8B;background-image:linear-gradient(#3DBE8B,#3DBE8B);padding:4px;color:#1F1A3D;">');
    expect(out).toContain('<a href="#" class="t-4b3fd1" style="color:#4B3FD1;">');
    expect(out).toContain('<span style="font-weight:bold">c</span>');
    expect(out).toContain('[data-ogsb].b-3dbe8b,[data-ogsb] .b-3dbe8b{background-color:#3dbe8b !important');
    expect(out).toContain('[data-ogsc].t-4b3fd1,[data-ogsc] .t-4b3fd1{color:#4b3fd1 !important}');
    expect(out).toContain(':root{color-scheme:light only;supported-color-schemes:light only}');
  });

  it('every email ships the light-only signals and no bare background colors', () => {
    const issue = renderWeekly(withPages(EVENTS), {
      siteUrl: 'https://www.thevic361.com', now: NOW, sponsor: { name: 'Acme', text: 'x', cta: 'Go', url: 'https://a.example' },
      unsubscribeUrl: 'u', address: 'a'
    });
    expect(issue.html).toContain('<meta name="supported-color-schemes" content="light only">');
    expect(issue.html).toContain('[data-ogsb]');
    expect(issue.html).not.toMatch(/style="[^"]*(^|;)background:#/i);
    const welcome = renderWelcomeEmail(withPages(EVENTS), { siteUrl: 'https://www.thevic361.com', now: NOW, sponsor: null, unsubscribeUrl: 'u', address: 'a' });
    expect(welcome.html).toContain('linear-gradient(#FFF4D6,#FFF4D6)');
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
  it('single opt-in: a new address is active at once and gets one welcome email and one Slack ping', async () => {
    const pings = [];
    await startApp({ slack: { enabled: true, notify: async (m) => { pings.push(m); return true; }, alert: async () => {} } });
    expect((await post('/api/subscribe', { email: 'bad' })).status).toBe(400);
    const r = await post('/api/subscribe', { email: 'New@Example.com' });
    expect(r.status).toBe(200);
    expect((await r.json()).message).toBe("You're on the list! Check your inbox.");
    expect((await store.countSubscribers()).active).toBe(1);
    await vi.waitFor(() => {
      expect(sent.single.some(m => m.subject === 'Welcome to The Vic 361')).toBe(true);
      expect(pings.some(p => p.title.includes('New newsletter subscriber'))).toBe(true);
    }, { timeout: 2000 });
    // Signing up again while active sends nothing more.
    await post('/api/subscribe', { email: 'new@example.com' });
    await new Promise(r => setTimeout(r, 50)); // room for a wrong second one
    expect(sent.single).toHaveLength(1);
    const [welcome] = sent.single;
    expect(welcome.subject).toBe('Welcome to The Vic 361');
    expect(welcome.to).toEqual(['new@example.com']);
    expect(welcome.headers['List-Unsubscribe']).toContain('/unsubscribe?token=');
    expect(welcome.html).toContain('Farmers Market');
    expect(welcome.html).toContain('Acme Tacos');
    expect(welcome.html).toContain('123 Main St, Victoria, TX 77901');
    expect(pings.filter(p => p.title.includes('New newsletter subscriber'))).toHaveLength(1);
  });

  it('a comeback must confirm from its own inbox: confirmation email, GET shows a button, POST activates', async () => {
    await startApp();
    await store.importSubscribers(['fan@example.com'], 'import');
    await store.unsubscribe((await store.listSubscribers({ status: 'active' }))[0].token);
    const r = await post('/api/subscribe', { email: 'Fan@Example.com' });
    expect(r.status).toBe(200);
    expect(sent.single).toHaveLength(1);
    expect(sent.single[0].to).toEqual(['fan@example.com']);
    expect(sent.single[0].subject).toBe('Confirm your Vic 361 subscription');
    const link = sent.single[0].html.match(/https:\/\/www\.thevic361\.com\/subscribe\/confirm\?token=([^"&]+)/);
    expect(link).toBeTruthy();
    expect((await store.countSubscribers()).pending).toBe(1);

    // Opening the link (or a mail scanner opening it) only shows a button.
    const g = await fetch(`${baseUrl}/subscribe/confirm?token=${link[1]}`);
    expect(g.status).toBe(200);
    const page = await g.text();
    expect(page).toContain(`<form method="post" action="/subscribe/confirm?token=${link[1]}">`);
    expect(page).toContain('Confirm my subscription');
    expect((await store.countSubscribers()).active).toBe(0);
    expect(sent.single).toHaveLength(1);

    const c = await fetch(`${baseUrl}/subscribe/confirm?token=${link[1]}`, { method: 'POST' });
    expect(c.status).toBe(200);
    expect(await c.text()).toContain('You&#39;re subscribed');
    expect((await store.countSubscribers()).active).toBe(1);
    await fetch(`${baseUrl}/subscribe/confirm?token=${link[1]}`, { method: 'POST' }); // second click
    // Opening the link again after confirming just says so.
    expect(await (await fetch(`${baseUrl}/subscribe/confirm?token=${link[1]}`)).text()).toContain('You&#39;re subscribed');
    expect((await fetch(`${baseUrl}/subscribe/confirm?token=nope`)).status).toBe(404);
    // The welcome email goes out after the page, once.
    await vi.waitFor(() => expect(sent.single).toHaveLength(2), { timeout: 2000 });
    await new Promise(r => setTimeout(r, 50));
    expect(sent.single.filter(m => m.subject === 'Welcome to The Vic 361')).toHaveLength(1);
  });

  it('a signup left pending under the old double opt-in is activated when they sign up again', async () => {
    await startApp();
    await store.addSubscriber({ email: 'old@example.com', source: 'footer' }); // pending, as before this change
    expect((await post('/api/subscribe', { email: 'old@example.com' })).status).toBe(200);
    expect((await store.countSubscribers()).active).toBe(1);
    await vi.waitFor(() => expect(sent.single.map(m => m.subject)).toEqual(['Welcome to The Vic 361']), { timeout: 2000 });
  });

  it('holds the welcome email when no mailing address is set', async () => {
    await startApp({ newsletterAddress: '' });
    await post('/api/subscribe', { email: 'new@example.com' });
    await new Promise(r => setTimeout(r, 50)); // checks an email is NOT sent, so a fixed wait
    expect((await store.countSubscribers()).active).toBe(1);
    expect(sent.single).toHaveLength(0);
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
    const html = await g.text();
    expect(html).toContain('<form method="post"');
    // Names whose subscription it is (masked), for readers of a forwarded copy.
    expect(html).toContain('f•••@example.com');
    expect(html).not.toContain('fan@example.com');
    expect(html).toContain('This email was forwarded to you');
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

describe('rejected signups are logged with their reason', () => {
  it('a bad email and a failed bot check each log why, never the address', async () => {
    const fakeFetch = async () => ({ ok: true, json: async () => ({ success: false, 'error-codes': ['timeout-or-duplicate'] }) });
    await startApp({ turnstileSecret: 'fake-secret', fetch: fakeFetch });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await post('/api/subscribe', { email: 'bad' })).status).toBe(400);
      expect((await post('/api/subscribe', { email: 'fan@example.com', turnstile_token: 't' },
        { 'User-Agent': 'Mozilla/5.0 (iPhone) [FBAN/FBIOS;FBAV/581.0]' })).status).toBe(400);
      const lines = warn.mock.calls.map(c => c.join(' '));
      expect(lines).toContain('[newsletter] signup rejected: invalid email');
      expect(lines).toContain('[turnstile] rejected: /api/subscribe verification-failed timeout-or-duplicate in-app: facebook');
      expect(lines.join('\n')).not.toContain('fan@example.com');
    } finally {
      warn.mockRestore();
    }
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
    // Proof: upcoming events in date order with their day, last week's left out.
    expect(html).toContain('2 things to do in Victoria in the next seven days');
    expect(html.indexOf('Friday &lt;Live&gt; Music')).toBeLessThan(html.indexOf('Farmers Market'));
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
    expect(issue.html).toContain('Forwarded this? <a href="https://www.thevic361.com/subscribe?utm_source=newsletter');
  });
});

describe('signups where the bot check never loaded', () => {
  const pass = async () => ({ ok: true, json: async () => ({ success: true }) });
  const fail = async () => ({ ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) });

  it('no token: not refused, but confirmed by email before they are on the list', async () => {
    await startApp({ turnstileSecret: 'fake-secret', fetch: pass });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await post('/api/subscribe', { email: 'iab@example.com' });
      expect(r.status).toBe(200);
      expect((await r.json()).message).toBe('Almost there! Check your inbox and tap Confirm to start getting it.');
      expect((await store.countSubscribers()).pending).toBe(1);
      expect(sent.single.map(m => m.subject)).toEqual(['Confirm your Vic 361 subscription']);
      // Same answer for an address already on the list (no way to probe who's subscribed).
      await store.importSubscribers(['on@example.com'], 'import');
      expect((await (await post('/api/subscribe', { email: 'on@example.com' })).json()).message)
        .toBe('Almost there! Check your inbox and tap Confirm to start getting it.');
    } finally { warn.mockRestore(); }
  });

  it('a token that fails is still refused; a good one signs up straight away', async () => {
    await startApp({ turnstileSecret: 'fake-secret', fetch: fail });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await post('/api/subscribe', { email: 'bot@example.com', turnstile_token: 'x' })).status).toBe(400);
      expect((await store.countSubscribers()).pending || 0).toBe(0);
    } finally { warn.mockRestore(); }
    if (server) await new Promise(r => server.close(r));
    await startApp({ turnstileSecret: 'fake-secret', fetch: pass });
    const r = await post('/api/subscribe', { email: 'real@example.com', turnstile_token: 'ok' });
    expect((await r.json()).message).toBe("You're on the list! Check your inbox.");
    expect((await store.countSubscribers()).active).toBe(1);
  });

  it('after a signup the form shows only the confirmation (no empty-form second tap)', async () => {
    await startApp();
    const html = await (await fetch(baseUrl + '/subscribe')).text();
    expect(html).toContain("f.classList.add('is-done')");
    const app = await fs.readFile(path.join(process.cwd(), 'docs/app.js'), 'utf8');
    expect(app).toContain("form.classList.add('is-done')");
    const css = await fs.readFile(path.join(process.cwd(), 'docs/style.css'), 'utf8');
    expect(css).toContain('.signup-form.is-done input, .signup-form.is-done button { display: none; }');
  });
});

describe('open tracking', () => {
  it('each copy carries its own tracking image; opens count once per subscriber and show in admin', async () => {
    await startApp();
    const h = await auth();
    await post('/api/admin/newsletter/import', { emails: 'a@example.com, b@example.com' }, h);
    expect((await post('/api/admin/newsletter/send', {}, h)).status).toBe(200);
    const subs = await store.listSubscribers({ status: 'active' });
    const pixels = sent.batches[0].msgs.map(m => m.html.match(/<img src="(https:\/\/www\.thevic361\.com\/email\/o\/[^"]+)"/)[1]);
    expect(pixels.sort()).toEqual(subs.map(x => `https://www.thevic361.com/email/o/2026-10-05/${x.id}.gif`).sort());
    // Not utm-tagged, and the token (which unsubscribes) isn't in it.
    for (const p of pixels) expect(p).not.toMatch(/utm_|token/);
    expect(sent.batches[0].msgs[0].text).not.toContain('/email/o/');

    const open = (url) => fetch(url.replace('https://www.thevic361.com', baseUrl));
    const r = await open(pixels[0]);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/gif');
    expect(r.headers.get('cache-control')).toBe('no-store, private');
    expect((await r.arrayBuffer()).byteLength).toBe(42);
    await open(pixels[0]); // the same person again
    // A made-up id and a bad week answer the image but count nothing.
    expect((await fetch(`${baseUrl}/email/o/2026-10-05/00000000-0000-0000-0000-000000000000.gif`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/email/o/nope/${subs[0].id}.gif`)).status).toBe(200);

    await vi.waitFor(async () => {
      const st = await (await fetch(baseUrl + '/api/admin/newsletter', { headers: h })).json();
      expect(st.sends[0]).toMatchObject({ week_key: '2026-10-05', recipients: 2, opens: 1 });
    }, { timeout: 2000 });
    expect(await store.countEmailOpens(['2026-10-05', '2026-09-28'])).toEqual({ '2026-10-05': 1 });
  });

  it('the welcome, confirmation and test emails have no tracking image', async () => {
    await startApp();
    const h = await auth();
    await post('/api/subscribe', { email: 'new@example.com' });
    await post('/api/admin/newsletter/test', { email: 'me@example.com' }, h);
    await vi.waitFor(() => expect(sent.single).toHaveLength(2), { timeout: 2000 });
    for (const m of sent.single) expect(m.html).not.toContain('/email/o/');
  });

  it('the privacy page discloses it', async () => {
    await startApp();
    expect(await (await fetch(baseUrl + '/privacy')).text()).toContain('Newsletter opens:');
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
    expect(sent.batches[0].key).toMatch(/^vic361-2026-10-05-[0-9a-f]{16}$/);

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
    // The same key as the first try: had Resend queued that chunk and only
    // answered late, this retry gets a 409 instead of sending it twice.
    expect(calls[calls.length - 1].key).toBe(calls[0].key);

    const again = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(again.error).toBe('already-sent');
  });

  it('the admin shows a partly failed week honestly and can retry it', async () => {
    let fail = true;
    const resend = {
      send: async () => ({ id: 'x' }),
      batch: async (msgs) => { if (fail) throw new Error('Resend down'); return { data: msgs.map((_, i) => ({ id: `b${i}` })) }; }
    };
    await startApp({ resend });
    const h = await auth();
    await store.importSubscribers(['a@example.com', 'b@example.com'], 'import');
    const first = await post('/api/admin/newsletter/send', {}, h);
    expect(first.status).toBe(409);
    expect((await first.json()).message).toMatch(/2 failed.*Retry/);
    const st = await (await fetch(baseUrl + '/api/admin/newsletter', { headers: h })).json();
    expect(st).toMatchObject({ this_week_sent: false, this_week_failed: 2 });

    fail = false;
    const retry = await post('/api/admin/newsletter/send', {}, h);
    expect(retry.status).toBe(200);
    const after = await (await fetch(baseUrl + '/api/admin/newsletter', { headers: h })).json();
    expect(after).toMatchObject({ this_week_sent: true, this_week_failed: 0, this_week_recipients: 2 });
  });

  it('asks Resend for permissive batch validation, and reads per-message errors', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'e0' }], errors: [{ index: 1, message: 'Invalid `to` field' }] }) };
    };
    const r = createResend('re_x', fetchImpl);
    const out = await r.batch([{ to: ['a@example.com'] }, { to: ['b@example.com'] }], 'k1');
    expect(calls[0].headers['x-batch-validation']).toBe('permissive');
    expect(calls[0].headers['Idempotency-Key']).toBe('k1');
    expect(out.errors).toEqual([{ index: 1, message: 'Invalid `to` field' }]);
    await r.send({ to: ['a@example.com'] });
    expect(calls[1].headers['x-batch-validation']).toBeUndefined();
  });

  it('an address Resend refuses fails only itself, is marked bounced, and the week reads sent', async () => {
    const calls = [];
    const alerts = [];
    const resend = {
      send: async () => ({ id: 'x' }),
      batch: async (msgs) => {
        calls.push(msgs.map(m => m.to[0]));
        const bad = msgs.findIndex(m => m.to[0] === 'b@example.com');
        return { data: msgs.filter((_, i) => i !== bad).map((_, i) => ({ id: `b${i}` })), errors: bad >= 0 ? [{ index: bad, message: 'Invalid `to` field' }] : [] };
      }
    };
    await startApp({ resend, slack: { enabled: true, notify: async () => true, alert: async (key, title, text) => { alerts.push({ key, title, text }); } } });
    const h = await auth();
    await store.importSubscribers(['a@example.com', 'b@example.com', 'c@example.com'], 'import');
    const first = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(first).toMatchObject({ ok: true, recipients: 2, failed: 0, failed_emails: [], refused: ['b@example.com'] });
    // Kept on record: the subscriber row says bounced, and the owner is told who.
    expect((await store.listSubscribers({})).find(s => s.email === 'b@example.com').status).toBe('bounced');
    expect(alerts.filter(a => a.key === 'newsletter-refused-2026-10-05')).toHaveLength(1);
    expect(alerts[0].text).toContain('b@example.com');
    expect(alerts.some(a => a.key.startsWith('newsletter-failed'))).toBe(false);
    const st = await (await fetch(baseUrl + '/api/admin/newsletter', { headers: h })).json();
    expect(st).toMatchObject({ this_week_sent: true, this_week_failed: 0 });
    // No retry of the refused address, this week or next.
    const again = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(again.error).toBe('already-sent');
    expect(calls).toHaveLength(1);
    expect((await store.listSubscribers({ status: 'active' })).map(s => s.email).sort()).toEqual(['a@example.com', 'c@example.com']);
  });

  it('a resumed send keeps the picks the first part of the week starred', async () => {
    await startApp();
    await store.importSubscribers(['a@example.com', 'b@example.com'], 'import');
    // Monday's send starred a paid pick and missed b; by the retry that
    // pick's day may be gone from the issue, so the resend's own picks lack it.
    await store.recordNewsletterSend({ week_key: '2026-10-05', subject: 'x', recipients: 1, picks: ['order-monday'],
      failed: 1, failed_emails: ['b@example.com'] });
    const r = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(r).toMatchObject({ ok: true, recipients: 2, failed: 0 });
    expect(sent.batches.at(-1).msgs.map(m => m.to[0])).toEqual(['b@example.com']);
    expect((await store.getNewsletterSend('2026-10-05')).picks).toContain('order-monday');
  });

  it('a 409 idempotency answer means that chunk already went out', async () => {
    const resend = {
      send: async () => ({ id: 'x' }),
      batch: async () => { const e = new Error('Resend /emails/batch HTTP 409: invalid_idempotent_request'); e.status = 409; throw e; }
    };
    await startApp({ resend });
    await store.importSubscribers(['a@example.com', 'b@example.com'], 'import');
    const first = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(first).toMatchObject({ ok: true, recipients: 2, failed: 0 });
  });

  it('overlapping sends go out once', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const calls = [];
    const resend = {
      send: async () => ({ id: 'x' }),
      batch: async (msgs) => { calls.push(msgs.length); await gate; return { data: msgs.map((_, i) => ({ id: `b${i}` })) }; }
    };
    await startApp({ resend });
    const h = await auth();
    await store.importSubscribers(['a@example.com', 'b@example.com'], 'import');
    const one = post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const two = await post('/api/admin/newsletter/send', {}, h);
    expect(two.status).toBe(409);
    expect((await two.json()).error).toBe('in-progress');
    release();
    expect((await (await one).json()).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('records who is still waiting before each chunk, so a crash mid-send resumes with only them', async () => {
    const emails = Array.from({ length: 150 }, (_, i) => `p${String(i).padStart(3, '0')}@example.com`);
    const seen = [];
    const resend = {
      send: async () => ({ id: 'x' }),
      batch: async (msgs) => {
        const rec = await store.getNewsletterSend('2026-10-05');
        seen.push(rec ? rec.failed_emails.length : null);
        if (seen.length === 2) throw Object.assign(new Error('process killed'), { crash: true });
        return { data: msgs.map((_, i) => ({ id: `b${i}` })) };
      }
    };
    await startApp({ resend });
    await store.importSubscribers(emails, 'import');
    await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' });
    // Before chunk 1 everyone is waiting; before chunk 2 only its 50 are.
    expect(seen).toEqual([150, 50]);
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

describe('Resend timeout', () => {
  it('a Resend that accepts the connection and never answers is given up on', async () => {
    const seen = [];
    // Hangs until its signal aborts, like a stalled HTTP response.
    const fetchImpl = (url, init) => new Promise((_, reject) => {
      seen.push(init.signal);
      if (!init.signal) return;
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
    const r = createResend('re_x', fetchImpl, { timeoutMs: 30 });
    const outcome = await Promise.race([
      r.send({ to: ['a@example.com'] }).then(() => 'answered', err => `failed: ${err.name}`),
      new Promise(res => setTimeout(() => res('still hanging'), 1000))
    ]);
    expect(outcome).toBe('failed: TimeoutError');
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('resumed chunks keep their idempotency key', () => {
  it('a chunk Resend accepted but answered too late is not sent twice on the retry', async () => {
    const accepted = new Map(); // key -> recipients Resend queued
    const delivered = [];
    let slow = true;
    const resend = {
      send: async () => ({ id: 'x' }),
      batch: async (msgs, key) => {
        if (accepted.has(key)) { const e = new Error('Resend 409 idempotent'); e.status = 409; throw e; }
        accepted.set(key, true);
        delivered.push(...msgs.map(m => m.to[0]));
        if (slow) throw new Error('The operation was aborted due to timeout');
        return { data: msgs.map((_, i) => ({ id: `b${i}` })) };
      }
    };
    await startApp({ resend });
    await store.importSubscribers(['a@example.com', 'b@example.com'], 'import');
    const first = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(first.failed).toBe(2);
    slow = false;
    const retry = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(retry).toMatchObject({ ok: true, failed: 0, recipients: 2 });
    expect(delivered.sort()).toEqual(['a@example.com', 'b@example.com']);
  });
});

describe('paid placements in the issue', () => {
  const PAID = { id: 'wk-paid-0001', kind: 'weekly', status: 'paid', amount: 30000, week_start: '2026-10-05',
    created_at: '2026-09-20T00:00:00Z', business: 'Paid Bakery', email: 'bake@example.com',
    sponsor: { name: 'Paid Bakery', text: 'Fresh bread.', cta: 'Visit', url: 'https://bakery.example' } };

  it('a failed order read is retried, and an issue is never sent without the paid sponsor', async () => {
    await startApp();
    await store.importSubscribers(['a@example.com'], 'import');
    await store.saveSponsorOrder(PAID);
    const real = store.listSponsorOrders.bind(store);
    let fails = 1;
    store.listSponsorOrders = async () => { if (fails-- > 0) throw new Error('statement timeout'); return real(); };
    const r = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(r.ok).toBe(true);
    expect(sent.batches[0].msgs[0].html).toContain('Paid Bakery');
  });

  it('when the orders stay unreadable the send fails (and is retried later) instead of going out without them', async () => {
    await startApp();
    await store.importSubscribers(['a@example.com'], 'import');
    await store.saveSponsorOrder(PAID);
    store.listSponsorOrders = async () => { throw new Error('statement timeout'); };
    const r = await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(sent.batches).toHaveLength(0);
    expect(await store.getNewsletterSend('2026-10-05')).toBeFalsy();
  });
});

describe('a returning subscriber', () => {
  it('old issues\' unsubscribe links still work, but the old token can\'t confirm the comeback', async () => {
    await startApp();
    const email = 'back@example.com';
    const first = await store.addSubscriber({ email, source: 'home' });
    await store.confirmSubscriber(first.token);
    const oldToken = first.token;
    expect((await post(`/unsubscribe?token=${oldToken}`)).status).toBe(200);
    const again = await store.addSubscriber({ email, source: 'footer' });
    expect(again.new_signup).toBe(true);
    // A new token confirms: the old one is in every issue they got,
    // forwarded copies included.
    expect(again.token).not.toBe(oldToken);
    expect(await store.confirmSubscriber(oldToken)).toBeNull();
    await store.confirmSubscriber(again.token);
    expect((await store.listSubscribers({ status: 'active' })).map(s => s.email)).toEqual([email]);
    // Gmail's Unsubscribe on an issue from before the first unsubscribe.
    expect(await (await fetch(`${baseUrl}/unsubscribe?token=${oldToken}`)).text()).toContain('example.com');
    expect((await post(`/unsubscribe?token=${oldToken}`)).status).toBe(200);
    expect(await store.listSubscribers({ status: 'active' })).toEqual([]);
  });

  it('Postgres keeps the old token for unsubscribing only', async () => {
    const { PgStore } = await import('../server/db.js');
    const calls = [];
    const pool = { query: async (text, params) => {
      calls.push({ text: String(text), params: params || [] });
      if (/SELECT \* FROM subscribers WHERE email/.test(text)) return { rows: [{ email: 'a@x.com', status: 'unsubscribed', token: 'old' }] };
      if (/^\s*UPDATE subscribers SET status = 'pending'/.test(text)) return { rows: [{ email: 'a@x.com', status: 'pending', token: params[1] }] };
      return { rows: [], rowCount: 1 };
    } };
    const st = new PgStore(pool);
    await st.addSubscriber({ email: 'a@x.com', source: 'home' });
    const up = calls.find(c => /UPDATE subscribers SET status = 'pending'/.test(c.text));
    expect(up.text).toMatch(/old_tokens = array_append\(old_tokens, token\)/);
    await st.unsubscribe('old');
    expect(calls.at(-1).text).toMatch(/\$1 = ANY\(old_tokens\)/);
    await st.confirmSubscriber('old');
    expect(calls.at(-1).text).not.toMatch(/old_tokens/);
  });
});
