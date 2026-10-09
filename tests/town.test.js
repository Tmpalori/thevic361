// @vitest-environment node
//
// server/town.js: TOWN picks the town (unset = Victoria, exactly today's
// values), other towns load towns/<slug>/town.json, and a second town's
// pages and emails carry its own name, domain and GA ID, never Victoria's.
// (Victoria's own output is pinned by tests/golden/.)
//
// Only what Phase 1 has moved so far is checked for leaks: the site name,
// the domain and the GA ID. "Victoria, TX", "Vic's Pick" and the static
// homepage follow in later steps (MULTI_CITY_PLAN.md 1.2c–1.3b).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { townConfig, useTown, VICTORIA, town } from '../server/town.js';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { HUB_PAGES, withPages, gaSnippet } from '../server/seo.js';
import { SEASONS } from '../server/guides.js';
import { renderWeekly, renderWelcomeEmail, renderConfirmEmail, renderReferralRules, newsletterConfig } from '../server/newsletter.js';
import { renderSubmissionLive, renderSponsorConfirmed, renderSponsorReport } from '../server/notify.js';
import { renderReply } from '../server/inbound.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, 'golden', 'fixture.json'), 'utf8'));
const NOW = new Date('2026-10-07T17:00:00Z');

const OTHER = {
  siteName: 'The Bay 979', siteNameHtml: 'The Bay <span>979</span>', domain: 'thebay979.com',
  city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago', gaId: 'G-TESTBAY979'
};
// Victoria's identity: none of it may show on another town's site.
const LEAKS = ['The Vic 361', 'thevic361.com', 'G-52YHD3X3C2', 'The Vic <span>361</span>'];
const leaks = text => LEAKS.filter(s => String(text).includes(s));

async function townsDir(json) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-towns-'));
  await fs.mkdir(path.join(dir, 'bay'));
  await fs.writeFile(path.join(dir, 'bay', 'town.json'), JSON.stringify(json));
  return dir;
}

describe('townConfig', () => {
  it('is Victoria, unchanged, when TOWN is unset or "victoria"', () => {
    expect(townConfig({})).toBe(VICTORIA);
    expect(townConfig({ TOWN: ' Victoria ' })).toBe(VICTORIA);
    expect(town).toBe(VICTORIA);
    expect(VICTORIA).toMatchObject({ siteName: 'The Vic 361', domain: 'thevic361.com', siteUrl: 'https://www.thevic361.com',
      emailFrom: 'The Vic 361 <news@thevic361.com>', gaId: 'G-52YHD3X3C2', timezone: 'America/Chicago' });
    expect(Object.isFrozen(VICTORIA)).toBe(true);
    // Victoria passes the same checks another town must.
    expect(townConfig({}, { town: VICTORIA })).toEqual(VICTORIA);
  });

  it('loads another town from towns/<slug>/town.json and fills in what follows from it', async () => {
    const dir = await townsDir(OTHER);
    try {
      const t = townConfig({ TOWN: 'bay' }, { townsDir: dir });
      expect(t).toMatchObject({ ...OTHER, id: 'bay', siteUrl: 'https://www.thebay979.com',
        emailFrom: 'The Bay 979 <news@thebay979.com>', icalDomain: 'thebay979.com' });
      const plain = townConfig({ TOWN: 'bay' }, { townsDir: await townsDir({ ...OTHER, siteNameHtml: undefined, gaId: undefined }) });
      expect(plain.siteNameHtml).toBe('The Bay 979');
      expect(plain.gaId).toBe('');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('stops the boot on a missing or unsafe town rather than showing Victoria', async () => {
    const dir = await townsDir(OTHER);
    try {
      expect(() => townConfig({ TOWN: 'nowhere' }, { townsDir: dir })).toThrow(/can't read .*nowhere\/town\.json/);
      expect(() => townConfig({ TOWN: '../etc' }, { townsDir: dir })).toThrow(/isn't a town slug/);
      const bad = async (patch, re) => {
        const d = await townsDir({ ...OTHER, ...patch });
        expect(() => townConfig({ TOWN: 'bay' }, { townsDir: d })).toThrow(re);
      };
      await bad({ domain: undefined }, /missing domain/);
      await bad({ siteName: 'Bay <b>979</b>' }, /siteName can't/);
      await bad({ siteName: 'Bay "979"' }, /siteName can't/);
      await bad({ domain: 'not a domain' }, /doesn't look like a domain/);
      await bad({ siteUrl: 'http://www.thebay979.com/x' }, /siteUrl must be/);
      await bad({ gaId: "G-1');alert(1);('" }, /gaId must/);
      await bad({ timezone: 'Mars/Olympus' }, /unknown timezone/);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});

describe('a second town', () => {
  let tmpDir, server, base, other;
  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-town-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    const venuesFile = path.join(tmpDir, 'venues.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: FIXTURE.events, sponsor: FIXTURE.sponsor }));
    await fs.writeFile(venuesFile, JSON.stringify(FIXTURE.venues));
    const { app } = await createApp({
      town: OTHER, storeBundle: { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) }, eventsFile, venuesFile,
      trustProxy: false, now: () => NOW, resendApiKey: '', stripeSecretKey: 'sk_test_town', stripeWebhookSecret: 'whsec_town',
      stripe: { createCheckoutSession: async () => { throw new Error('unused'); }, expireCheckoutSession: async () => ({}) },
      slack: { enabled: false, notify: async () => false, alert: async () => false }
    });
    other = town;
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    useTown(VICTORIA);
    if (server) await new Promise(r => server.close(r));
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('createApp({ town }) switches the process to it', () => {
    expect(other).toMatchObject({ siteName: 'The Bay 979', domain: 'thebay979.com', gaId: 'G-TESTBAY979' });
    expect(newsletterConfig({}).from).toBe('The Bay 979 <news@thebay979.com>');
    expect(gaSnippet()).toContain("gtag('config','G-TESTBAY979'");
  });

  it('pages and feeds carry its name, domain and GA ID, never Victoria’s', async () => {
    const { events } = await (await fetch(base + '/events.json')).json();
    const event = events.find(e => e.page).page;
    const venues = await (await fetch(base + '/venues')).text();
    const venue = venues.match(/href="(\/venues\/[a-z0-9-]+)"/)[1];
    const paths = ['/about', '/privacy', '/advertise', '/advertise/checkout?package=weekly', '/subscribe', '/referral-rules',
      '/contact', '/venues', venue, '/no-such-page', '/llms.txt', '/sitemap.xml', event, event + '.ics',
      ...HUB_PAGES.map(p => p.path), SEASONS[0].path];
    for (const p of paths) {
      const text = await (await fetch(base + p)).text();
      expect(leaks(text), p).toEqual([]);
      if (p.endsWith('.ics')) expect(text).toContain('@thebay979.com');
      else if (!p.endsWith('.xml')) expect(text, p).toContain('The Bay 979');
    }
    const about = await (await fetch(base + '/about')).text();
    expect(about).toContain('<div class="site-title">The Bay <span>979</span></div>');
    expect(about).toContain('gtag/js?id=G-TESTBAY979');
    expect(about).toContain('https://www.thebay979.com/about'); // canonical, from the town's siteUrl
  });

  it('emails carry its name and domain', () => {
    const evs = withPages(FIXTURE.events);
    const site = 'https://www.thebay979.com';
    const order = { id: 'o1', kind: 'weekly', status: 'paid', amount: 30000, week_start: '2026-10-12', business: 'Acme', email: 'a@b.example',
      sponsor: { name: 'Acme', text: 'Hi.', cta: 'Go', url: 'https://acme.example' } };
    const mails = [
      renderWeekly(evs, { siteUrl: site, now: new Date('2026-10-05T12:43:00Z'), unsubscribeUrl: site + '/unsubscribe', address: 'PO Box 1', edition: 'weekly' }),
      renderWelcomeEmail(evs, { siteUrl: site, now: NOW, unsubscribeUrl: site + '/unsubscribe', address: 'PO Box 1' }),
      renderConfirmEmail({ siteUrl: site, confirmUrl: site + '/c', address: 'PO Box 1' }),
      renderSubmissionLive(evs[0], { siteUrl: site, address: 'PO Box 1', pageUrl: site + evs[0].page, upgradeUrl: '' }),
      renderSponsorConfirmed(order, { siteUrl: site, address: 'PO Box 1' }),
      renderSponsorReport({ ...order, week_start: '2026-09-28' }, { week_start: '2026-09-28', week_end: '2026-10-04', views: 5, site_visitors: 9 }, { siteUrl: site, address: 'PO Box 1' })
    ];
    for (const m of mails) {
      const all = `${m.subject}\n${m.text}\n${m.html}`;
      expect(leaks(all), m.subject).toEqual([]);
      expect(all).toMatch(/The Bay 979|thebay979\.com/);
    }
    expect(leaks(renderReferralRules({ siteUrl: site }))).toEqual([]);
    expect(renderReply('Thanks!', site).text).toBe('Thanks!\n\n— The Bay 979\nwww.thebay979.com');
  });
});
