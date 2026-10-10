// @vitest-environment node
//
// The legal pages (server/legal.js): terms, advertising terms (with the
// refund policy), accessibility and privacy, for Victoria and another town;
// the business identity they print; the checkout's terms box (required on
// the server, recorded on the order and sent to Stripe); and the promises
// the pages make that have to match the code.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';
import { FileStore, PgStore, REF_HOLD_HOURS } from '../server/db.js';
import { townConfig, useTown, VICTORIA } from '../server/town.js';
import {
  ADVERTISING_TERMS_VERSION, TERMS_VERSION, PRIVACY_VERSION, ACCESSIBILITY_VERSION, BOOKING, CANCEL_NOTICE_DAYS,
  businessConfig, useBusiness, operatorName, contactEmail, renderPrivacyPage, renderTermsPage, renderAdvertisingTermsPage,
  renderAccessibilityPage, versionDate
} from '../server/legal.js';
import { LEAD_IN_DAYS, HOLD_MS, WEEKS_AHEAD, FEATURE_DAYS_AHEAD, INSTANT_ONLY_DAYS } from '../server/sponsors.js';
import { renderReferralRules } from '../server/newsletter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, 'golden', 'fixture.json'), 'utf8'));
const NOW = new Date('2026-10-07T17:00:00Z');
const SITE = 'https://www.thevic361.com';
const BAY = { id: 'bay', siteName: 'The Bay 979', siteNameHtml: 'The Bay <span>979</span>', domain: 'thebay979.com', city: 'Bay City', state: 'TX',
  stateName: 'Texas', timezone: 'America/Chicago', pickName: 'Bay’s Best', areaCode: '979',
  business: { pickAmount: { weekday: 2950, weekend: 5900 } } };
// Victoria's identity anywhere on another town's page.
const LEAK = /.{0,40}(Victoria|Vic 361|The Vic\b|Vic(’|&rsquo;|')s Pick|thevic361|G-52YHD3X3C2|\$49|\$89|\b361\b).{0,30}/g;
const slack = { enabled: false, notify: async () => false, alert: async () => false };

// The town is a live binding a served app reads per request, so only the
// tests that switch it put Victoria back (in their own afterEach).
afterEach(() => { useBusiness(businessConfig({})); });

async function serve(opts) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-legal-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  const scrub = v => (opts.town ? JSON.parse(JSON.stringify(v).replace(/Victoria/g, 'Bay City')) : v);
  await fs.writeFile(eventsFile, JSON.stringify(scrub({ events: FIXTURE.events })));
  const store = new FileStore(path.join(tmpDir, 's.json'));
  const { app } = await createApp({ storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
    resendApiKey: '', slack, ...opts });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, store,
    get: async p => { const r = await fetch(base + p, { redirect: 'manual' }); return { status: r.status, location: r.headers.get('location'), text: await r.text() }; },
    close: async () => {
      await new Promise(r => server.close(r));
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  };
}

describe('the legal pages, served for Victoria', () => {
  let app;
  beforeAll(async () => { app = await serve({ siteUrl: SITE }); });
  afterAll(async () => { if (app) await app.close(); useTown(VICTORIA); });

  it('renders each page with its date and version, in the site layout', async () => {
    for (const [p, h1, v] of [['/terms', 'Terms of use', TERMS_VERSION], ['/advertising-terms', 'Advertising terms', ADVERTISING_TERMS_VERSION],
      ['/accessibility', 'Accessibility', ACCESSIBILITY_VERSION], ['/privacy', 'Privacy', PRIVACY_VERSION]]) {
      const r = await app.get(p);
      expect(r.status, p).toBe(200);
      expect(r.text).toContain(`<h1 class="page-title">${h1}</h1>`);
      expect(r.text).toContain(`Last updated ${versionDate(v)} · Version ${v}`);
      expect(r.text).toContain(`<link rel="canonical" href="${SITE}${p}">`);
      expect(r.text).toContain('<footer class="site-footer">');
      // Without BUSINESS_LEGAL_NAME the site itself is named; never a blank
      // or a placeholder.
      expect(r.text).not.toMatch(/undefined|null|\[LLC|\[email|run by \.|run by ,/);
      // The "not legal advice" note belongs in the docs, not on the pages.
      expect(r.text).not.toMatch(/legal advice|attorney review/i);
    }
  });

  it('/refunds goes to the refund section of the advertising terms', async () => {
    const r = await app.get('/refunds');
    expect(r.status).toBe(301);
    expect(r.location).toBe('/advertising-terms#refunds');
    expect((await app.get('/advertising-terms')).text).toContain('id="refunds"');
  });

  it('every page footer links the policies; the sitemap lists them', async () => {
    const about = (await app.get('/about')).text;
    for (const href of ['/terms', '/advertising-terms', '/privacy', '/accessibility', '/referral-rules']) {
      expect(about).toContain(`<a href="${href}">`);
    }
    const map = (await app.get('/sitemap.xml')).text;
    for (const p of ['/terms', '/advertising-terms', '/accessibility', '/referral-rules', '/privacy']) expect(map).toContain(`<loc>${SITE}${p}</loc>`);
  });

  it('names the site as the operator and news@ as the contact until they are set', async () => {
    const terms = (await app.get('/terms')).text;
    expect(terms).toContain('<p>The Vic 361 runs thevic361.com and its newsletter. "We" and "us" mean The Vic 361.');
    expect(terms).toContain('mailto:news@thevic361.com');
    const ads = (await app.get('/advertising-terms')).text;
    expect(ads).toContain('<strong>YOU WILL DEFEND, INDEMNIFY AND HOLD HARMLESS THE VIC 361');
    expect(ads).toContain('OUR TOTAL LIABILITY FOR ANY CLAIM ABOUT AN ORDER IS LIMITED TO THE AMOUNT YOU PAID');
    expect(ads).toContain('laws of the State of Texas');
  });
});

describe('business identity', () => {
  it('reads the legal name, contact email and address, with safe fallbacks', () => {
    useBusiness(businessConfig({ BUSINESS_LEGAL_NAME: '  Acme  Media & Co LLC ', BUSINESS_CONTACT_EMAIL: 'Legal <legal@acme.example>', NEWSLETTER_ADDRESS: 'PO Box 9, Somewhere, TX 77000' }));
    expect(operatorName()).toBe('Acme Media & Co LLC');
    expect(contactEmail()).toBe('legal@acme.example');
    const html = renderTermsPage({ siteUrl: SITE });
    expect(html).toContain('<p>The Vic 361 is run by Acme Media &amp; Co LLC. "We" and "us" mean Acme Media &amp; Co LLC.');
    expect(html).toContain('PO Box 9, Somewhere, TX 77000');
    expect(html).toContain('mailto:legal@acme.example');
    expect(html).not.toContain('Acme Media & Co');

    // No contact email: the reply-to inbox, then news@ the town's domain.
    useBusiness(businessConfig({ NEWSLETTER_REPLY_TO: 'Owner <owner@acme.example>', BUSINESS_CONTACT_EMAIL: 'not an email' }));
    expect(contactEmail()).toBe('owner@acme.example');
    useBusiness(businessConfig({}));
    expect(contactEmail()).toBe('news@thevic361.com');
    expect(operatorName()).toBe('The Vic 361');
    // No address: left out, not a placeholder.
    expect(renderAdvertisingTermsPage({ siteUrl: SITE })).not.toMatch(/<strong>The Vic 361<\/strong><br>\s*<br>/);
  });

  it('createApp takes them from the environment (or its options) and the setup checklist asks for them', async () => {
    const app = await serve({ siteUrl: SITE, businessLegalName: 'Acme Media LLC', businessContactEmail: 'hi@acme.example', newsletterAddress: 'PO Box 1' });
    try {
      const page = (await app.get('/privacy')).text;
      expect(page).toContain('The Vic 361 is run by Acme Media LLC. In this policy');
      expect(page).toContain('mailto:hi@acme.example?subject=Privacy%20request');
      expect(page).toContain('PO Box 1');
    } finally { await app.close(); }
    const src = readFileSync(path.join(HERE, '..', 'server', 'index.js'), 'utf8');
    for (const k of ['business_name', 'business_contact', 'business_address']) expect(src).toContain(`key: '${k}'`);
    expect(src).toMatch(/key: 'business_name'[^\n]*level: 'recommended'/);
  });
});

describe('another town’s legal pages', () => {
  let app;
  beforeAll(async () => { app = await serve({ town: BAY, siteUrl: 'https://www.thebay979.com' }); });
  afterAll(async () => { if (app) await app.close(); useTown(VICTORIA); });

  it('say nothing of Victoria', async () => {
    for (const p of ['/terms', '/advertising-terms', '/accessibility', '/privacy', '/referral-rules', '/submit', '/']) {
      const r = await app.get(p);
      expect(r.status, p).toBe(200);
      expect(r.text.match(LEAK), p).toBe(null);
    }
    const terms = (await app.get('/terms')).text;
    expect(terms).toContain('The Bay 979 runs thebay979.com and its newsletter.');
    expect(terms).toContain('mailto:news@thebay979.com');
    expect((await app.get('/advertising-terms')).text).toContain('$29.50 Mon–Thu · $59 Fri–Sun');
    expect((await app.get('/referral-rules')).text).toContain('Bay City local time');
  });

  it('don’t claim Google Analytics on a town without a GA ID', async () => {
    const privacy = (await app.get('/privacy')).text;
    expect(privacy).not.toContain('Google Analytics');
    expect(privacy).not.toContain('googletagmanager');
    expect(privacy).toContain('Meta Pixel');
    expect(privacy).toContain('Global Privacy Control');
  });

  it('the submit form has the policy links, localized', async () => {
    const form = (await app.get('/submit')).text;
    expect(form).toContain('<footer class="submit-site-footer">');
    for (const href of ['/terms', '/advertising-terms', '/privacy', '/accessibility']) expect(form).toContain(`<a href="${href}">`);
    expect(form).toContain('&copy; The Bay 979 · Bay City, TX');
  });
});

describe('the privacy page tells the truth about what is stored', () => {
  it('discloses submitter IP, browser and phone, OpenAI, Slack, Google Fonts, public collection, retention and children', () => {
    const html = renderPrivacyPage({ siteUrl: SITE });
    for (const s of ['IP address and browser details (user agent)', 'phone number', 'OpenAI reviews submitted events', 'relayed to our staff\'s Slack',
      'Google Fonts', 'public Facebook and Instagram pages', 'How long we keep it', 'deleted after 12 months', 'Contact messages: deleted after 24 months',
      'within 30 days', 'isn\'t directed to children under 13', 'don\'t load the Meta Pixel']) {
      expect(html, s).toContain(s);
    }
    // Submissions do keep IP addresses, so no blanket "we don't store IPs".
    expect(html).not.toMatch(/don't store IP addresses/);
  });
});

describe('the referral rules match the drawing code', () => {
  it('states the 24-hour count, the draw date, a free entry, age of majority, the sponsor and Texas law', () => {
    expect(REF_HOLD_HOURS).toBe(24);
    useBusiness(businessConfig({ BUSINESS_LEGAL_NAME: 'Acme Media LLC', NEWSLETTER_ADDRESS: 'PO Box 1, Town, TX' }));
    const html = renderReferralRules({ siteUrl: SITE });
    for (const s of ['The program is run by Acme Media LLC, PO Box 1, Town, TX', 'been subscribed for 24 hours',
      'first Monday on or after the 2nd of the next month', 'Free way to enter without referring anyone', 'One free entry per person per month',
      '18 or older, or the age of majority in their state if that\'s higher', 'approximate retail value $25', 'Your odds depend on how many eligible entries',
      'within 60 days after that month\'s drawing', 'responsible for any taxes', 'laws of the State of Texas', 'These rules apply from October 10, 2026 until we end the program',
      'contact us within 30 days of the drawing']) {
      expect(html, s).toContain(s);
    }
  });
});

describe('the advertising terms match the booking code', () => {
  it('uses the same numbers sponsors.js enforces', () => {
    expect(CANCEL_NOTICE_DAYS).toBe(LEAD_IN_DAYS);
    expect(BOOKING).toEqual({ weeksAhead: WEEKS_AHEAD, pickDaysAhead: FEATURE_DAYS_AHEAD, holdMinutes: HOLD_MS / 60000, cardsOnlyDays: INSTANT_ONLY_DAYS });
    const html = renderAdvertisingTermsPage({ siteUrl: SITE });
    expect(html).toContain(`cancel at least ${CANCEL_NOTICE_DAYS} days before the Monday your week starts for a full refund`);
    expect(html).toContain('Double-booked:');
    expect(html).toContain('Payment arrived too late:</strong> if a bank payment clears only after your date has passed, we refund you in full');
    expect(html).toContain('mailto:news@thevic361.com?subject=Cancellation%20or%20refund');
    expect(html).toContain('a paid Vic’s Pick with "#ad" at the end of its description');
  });
});

describe('checkout: the terms box', () => {
  let app, sessions;
  beforeAll(async () => {
    sessions = [];
    app = await serve({ siteUrl: SITE, stripeSecretKey: 'sk_test', stripeWebhookSecret: 'whsec',
      stripe: { createCheckoutSession: async (params) => { sessions.push(params); return { id: `cs_${sessions.length}`, url: 'https://checkout.stripe.com/x' }; },
        expireCheckoutSession: async () => ({}) } });
  });
  afterAll(async () => { if (app) await app.close(); useTown(VICTORIA); });
  const post = fields => fetch(app.base + '/advertise/checkout', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  const weekly = { package: 'weekly', week: '2026-10-19', business: 'Acme', text: 'Hi.', url: 'acme.example', email: 'a@acme.example' };

  it('shows an unchecked, required box linking the terms in a new tab, on both packages', async () => {
    for (const pkg of ['weekly', 'featured']) {
      const page = (await app.get(`/advertise/checkout?package=${pkg}`)).text;
      expect(page).toContain('<input type="checkbox" id="f-agree" name="agree" value="1" required>');
      expect(page).toContain('<a href="/advertising-terms" target="_blank" rel="noopener">Advertising Terms</a>');
      expect(page.indexOf('id="f-agree"')).toBeLessThan(page.indexOf('Continue to payment'));
    }
    expect((await app.get('/advertise')).text).toContain('<a href="/advertising-terms">advertising terms</a>');
  });

  it('refuses a checkout without it, keeping what was typed', async () => {
    const r = await post(weekly);
    expect(r.status).toBe(400);
    const html = await r.text();
    expect(html).toContain('Please tick the box to agree to the advertising terms.');
    expect(html).toContain('value="Acme"');
    expect(sessions).toHaveLength(0);
    expect(await app.store.listSponsorOrders()).toHaveLength(0);
    // Ticked but another field wrong: both errors, and the box stays ticked.
    const r2 = await post({ ...weekly, text: '', agree: '1' });
    const html2 = await r2.text();
    expect(html2).toContain('Add one or two sentences');
    expect(html2).toContain('name="agree" value="1" required checked');
  });

  it('records the version and time on the order and sends them to Stripe', async () => {
    const r = await post({ ...weekly, agree: '1' });
    expect(r.status).toBe(303);
    const [order] = await app.store.listSponsorOrders();
    expect(order).toMatchObject({ email: 'a@acme.example', terms_version: ADVERTISING_TERMS_VERSION, terms_accepted_at: NOW.toISOString() });
    const s = sessions.at(-1);
    expect(s.metadata).toMatchObject({ order_id: order.id, terms_version: ADVERTISING_TERMS_VERSION, terms_accepted_at: NOW.toISOString() });
    expect(s.custom_text.submit.message).toContain(`(${SITE}/advertising-terms)`);
    // Stripe's own ToS checkbox needs a Dashboard setting per account: off.
    expect(s.consent_collection).toBeUndefined();
    expect(s.custom_text.terms_of_service_acceptance).toBeUndefined();
  });
});

describe('order storage keeps the acceptance', () => {
  it('in the FileStore', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-legal-fs-'));
    try {
      const store = new FileStore(path.join(dir, 's.json'));
      await store.saveSponsorOrder({ id: 'o-1', kind: 'weekly', status: 'pending', email: 'a@b.example', created_at: NOW.toISOString(),
        terms_version: ADVERTISING_TERMS_VERSION, terms_accepted_at: NOW.toISOString() });
      const [o] = await new FileStore(path.join(dir, 's.json')).listSponsorOrders();
      expect(o).toMatchObject({ terms_version: ADVERTISING_TERMS_VERSION, terms_accepted_at: NOW.toISOString() });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('in Postgres, inside the order payload (no new column needed)', async () => {
    const seen = [];
    const pool = { query: async (text, params) => {
      seen.push({ text, params });
      if (/information_schema/.test(text)) return { rows: [{ table_name: 'subscribers' }, { table_name: 'sponsor_orders' }] };
      return { rows: [] };
    } };
    await new PgStore(pool).saveSponsorOrder({ id: 'o-1', kind: 'weekly', created_at: NOW.toISOString(), terms_version: ADVERTISING_TERMS_VERSION, terms_accepted_at: NOW.toISOString() });
    const insert = seen.find(q => /INSERT INTO sponsor_orders/.test(q.text));
    expect(JSON.parse(insert.params[1])).toMatchObject({ terms_version: ADVERTISING_TERMS_VERSION, terms_accepted_at: NOW.toISOString() });
  });
});

describe('the legal page renderers stand alone', () => {
  afterEach(() => useTown(VICTORIA));
  it('Victoria has a GA ID, so its privacy page names Google Analytics', () => {
    useTown(VICTORIA);
    expect(renderPrivacyPage({ siteUrl: SITE })).toContain('<strong>Google Analytics</strong>');
  });

  it('render for another town without a server', () => {
    useTown(townConfig({}, { town: BAY }));
    for (const html of [renderTermsPage({ siteUrl: 'https://www.thebay979.com' }), renderAdvertisingTermsPage({ siteUrl: 'https://www.thebay979.com' }),
      renderAccessibilityPage({ siteUrl: 'https://www.thebay979.com' }), renderPrivacyPage({ siteUrl: 'https://www.thebay979.com' })]) {
      expect(html.match(LEAK)).toBe(null);
      expect(html).toContain('The Bay 979');
    }
  });
});
