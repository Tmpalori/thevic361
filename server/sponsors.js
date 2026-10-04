/* server/sponsors.js — Self-serve sponsor checkout through Stripe.
 *
 * A business picks a package on /advertise, fills one short form, pays on
 * Stripe Checkout, and the placement goes live on its own:
 *
 *   - Weekly sponsor ($300, one-time): books one Monday–Sunday week. Their
 *     block replaces the sponsor slot on every page, in /events.json, and in
 *     that Monday's newsletter. One sponsor per week; a week someone is
 *     paying for right now is held for the life of the Checkout session.
 *   - Venue partner ($150/month, Stripe subscription): every event at their
 *     venue is a Vic’s Pick (featured) while the subscription is active. Cancelling
 *     in Stripe ends it automatically (customer.subscription.* webhooks).
 *   - Vic’s Pick event ($49, one-time): the event lands in the submissions
 *     queue (so a person still checks it before it's listed) and is pinned
 *     as Featured as soon as it, or a matching collector event, is live.
 *
 * Placements are applied when the public payload is read (see
 * applyPlacements), never written into the published events, so Save &
 * Publish can't wipe them and a hidden or cancelled order disappears on
 * the next request.
 *
 * Stripe is called with fetch (no SDK; AGENTS.md: no new dependencies).
 * The webhook verifies Stripe's HMAC signature over the raw body, so it is
 * registered before express.json (see registerStripeWebhook).
 *
 * Off until STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are both set; until
 * then /advertise keeps the email-us flow.
 */

import crypto from 'node:crypto';
import express from 'express';
import {
  AD_PACKAGES, SITE_NAME, escHtml, safeUrl, localDateStr, currentWeek, addDays, formatDay, layout
} from './seo.js';
import { normalizeUrl, validateSubmission } from './validate.js';
import { normalizePayload, newId, nowIso } from './db.js';
import { normalizeEmail } from './newsletter.js';
import { venueFor } from './guides.js';

const STRIPE_API = 'https://api.stripe.com/v1';
// Stripe's shortest Checkout expiry is 30 minutes; hold a week a little
// longer so it can't be resold while the first buyer is still paying.
const CHECKOUT_TTL_S = 31 * 60;
const HOLD_MS = 35 * 60 * 1000;
const WEEKS_AHEAD = 8;
const FEATURE_DAYS_AHEAD = 120;
const SIG_TOLERANCE_S = 300;
// Orders are read on every page view; a minute of staleness is fine and
// every write below clears it anyway.
const CACHE_MS = 60 * 1000;
const LIVE = new Set(['paid', 'active']);

export function stripeConfig(env = process.env, overrides = {}) {
  const c = {
    secretKey: overrides.stripeSecretKey ?? env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: overrides.stripeWebhookSecret ?? env.STRIPE_WEBHOOK_SECRET ?? ''
  };
  // Taking money without the webhook would mean nothing gets fulfilled.
  c.enabled = Boolean(c.secretKey && c.webhookSecret);
  return c;
}

export function packageFor(key) {
  return AD_PACKAGES.find(p => p.key === key) || null;
}

// ─── Stripe client ───────────────────────────────────────────────────────

// Stripe takes form encoding with bracketed keys: line_items[0][quantity]=1.
export function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

// Pinned so request and response shapes don't change under us when Stripe
// ships a new version. Set the webhook endpoint to the same version in the
// Dashboard so events match.
export const STRIPE_API_VERSION = '2026-09-30.endive';
// Tags our Checkout Sessions in the Dashboard (Stripe asks for an 8-letter suffix).
export const INTEGRATION_ID = 'vic361_sponsor_checkout_qvbkmxtr';

export function createStripe(secretKey, fetchImpl = globalThis.fetch) {
  async function call(method, path, params, idempotencyKey) {
    const qs = method === 'GET' && params ? `?${formEncode(params)}` : '';
    const res = await fetchImpl(`${STRIPE_API}${path}${qs}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Stripe-Version': STRIPE_API_VERSION,
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
      },
      body: method === 'GET' ? undefined : formEncode(params || {}).toString()
    });
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    if (!res.ok || !body) {
      const err = new Error((body && body.error && body.error.message) || `Stripe HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  // One Product + Price per package, found by lookup_key and created the
  // first time it's needed, so the Dashboard catalog and reports show
  // "Weekly sponsor" etc. instead of a throwaway product per checkout.
  const priceCache = new Map();
  async function ensurePrice(pkg) {
    const lookupKey = `vic361_${pkg.key}_${pkg.amount}${pkg.interval ? `_${pkg.interval}` : ''}`;
    if (priceCache.has(lookupKey)) return priceCache.get(lookupKey);
    const found = await call('GET', '/prices', { 'lookup_keys[]': lookupKey, active: 'true', limit: 1 });
    let id = found && Array.isArray(found.data) && found.data[0] && found.data[0].id;
    if (!id) {
      const product = await call('POST', '/products', {
        name: `${SITE_NAME}: ${pkg.name}`, metadata: { vic361_package: pkg.key }
      }, `vic361-product-${pkg.key}`);
      const price = await call('POST', '/prices', {
        product: product.id, currency: 'usd', unit_amount: pkg.amount, lookup_key: lookupKey,
        recurring: pkg.interval ? { interval: pkg.interval } : undefined
      }, `vic361-price-${lookupKey}`);
      id = price.id;
    }
    priceCache.set(lookupKey, id);
    return id;
  }

  return {
    ensurePrice,
    async createCheckoutSession(params, idempotencyKey) {
      const body = await call('POST', '/checkout/sessions', params, idempotencyKey);
      if (typeof body.url !== 'string' || typeof body.id !== 'string') throw new Error('Stripe returned no checkout URL');
      return { id: body.id, url: body.url };
    }
  };
}

// Stripe-Signature: t=<unix>,v1=<hex hmac of "t.rawBody">[,v1=...]
export function verifyStripeSignature(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!rawBody || !header || !secret) return false;
  let t = null;
  const sigs = [];
  for (const part of String(header).split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') t = Number(v);
    else if (k === 'v1' && v) sigs.push(v);
  }
  if (!Number.isFinite(t) || !sigs.length || Math.abs(nowSec - t) > SIG_TOLERANCE_S) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  return sigs.some(s => {
    const got = Buffer.from(s);
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

// ─── Placements ──────────────────────────────────────────────────────────

function nameKey(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

const VENUE_STOP = new Set(['the', 'and', 'victoria', 'texas', 'bar', 'grill', 'pub', 'cafe', 'park',
  'center', 'centre', 'church', 'hall', 'club', 'house', 'street']);
function venueWords(v) {
  return new Set(nameKey(v).split(' ').filter(w => w.length >= 4 && !VENUE_STOP.has(w)));
}
// Two named venues that share no distinctive word are different places.
function differentPlaces(a, b) {
  const va = nameKey(a.venue), vb = nameKey(b.venue);
  if (!va || !vb || va.includes(vb) || vb.includes(va)) return false;
  const wb = venueWords(b.venue);
  return ![...venueWords(a.venue)].some(w => wb.has(w));
}

// Same day, same place (when both name one) and a clearly matching name:
// exact, one containing the other, or most words shared ("Fall Festival" vs
// "Fall Festival at De Leon Plaza"). "Live Music" at two bars is two events.
export function sameEvent(a, b) {
  if (!a || !b || a.date !== b.date) return false;
  if (differentPlaces(a, b)) return false;
  const ka = nameKey(a.name);
  const kb = nameKey(b.name);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if ((ka.length >= 6 && kb.includes(ka)) || (kb.length >= 6 && ka.includes(kb))) return true;
  const ta = new Set(ka.split(' '));
  const tb = new Set(kb.split(' '));
  const shared = [...ta].filter(x => tb.has(x)).length;
  return shared / new Set([...ta, ...tb]).size >= 0.6;
}

export function applyPlacements(payload, orders, { now, venues = [] }) {
  const live = (orders || []).filter(o => LIVE.has(o.status));
  if (!live.length || !payload) return payload;
  const week = currentWeek(localDateStr(now))[0];
  const weekly = live.find(o => o.kind === 'weekly' && o.week_start === week);
  const featured = live.filter(o => o.kind === 'featured' && o.event);
  const partners = new Set(live.filter(o => o.kind === 'partner').map(o => o.venue_slug));
  const events = (payload.events || []).map(ev => {
    if (ev.featured) return ev;
    let hit = featured.some(o => sameEvent(o.event, ev));
    if (!hit && partners.size) {
      const v = venueFor(ev, venues);
      hit = Boolean(v && partners.has(v.slug));
    }
    return hit ? { ...ev, featured: true } : ev;
  });
  return { ...payload, events, sponsor: weekly ? weekly.sponsor : (payload.sponsor || null) };
}

export function bookableWeeks(now, orders) {
  const monday = currentWeek(localDateStr(now))[0];
  const nowMs = now.getTime();
  const taken = new Set((orders || [])
    .filter(o => o.kind === 'weekly' && (o.status === 'paid' || o.status === 'processing' ||
      (o.status === 'pending' && nowMs - Date.parse(o.created_at) < HOLD_MS)))
    .map(o => o.week_start));
  const short = { month: 'short', day: 'numeric' };
  return Array.from({ length: WEEKS_AHEAD }, (_, i) => {
    const start = addDays(monday, 7 * (i + 1));
    return { start, label: `${formatDay(start, short)} to ${formatDay(addDays(start, 6), short)}`, available: !taken.has(start) };
  });
}

// ─── Form validation ─────────────────────────────────────────────────────

function clean(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

export function validateOrder(kind, input, { now, orders, venues }) {
  const errors = {};
  const email = normalizeEmail(input.email);
  if (!email) errors.email = 'Enter a valid email for your receipt.';
  const business = clean(input.business, 80);
  if (!business) errors.business = 'Business name is required.';
  const order = { kind, email, business };

  if (kind === 'weekly') {
    const text = clean(input.text, 160);
    if (!text) errors.text = 'Add one or two sentences about your business.';
    const cta = clean(input.cta, 24) || 'Learn more';
    const url = safeUrl(normalizeUrl(clean(input.url, 300)));
    if (!url) errors.url = 'Enter your website or page (e.g. example.com).';
    const address = clean(input.address, 120);
    const week = bookableWeeks(now, orders).find(w => w.start === input.week);
    if (!week) errors.week = 'Pick a week.';
    else if (!week.available) errors.week = 'That week was just booked. Pick another.';
    order.week_start = week ? week.start : '';
    order.sponsor = { name: business, text, cta, url, address };
  } else if (kind === 'partner') {
    const venue = venues.find(v => v.slug === input.venue);
    if (!venue) errors.venue = 'Pick your venue.';
    else if ((orders || []).some(o => o.kind === 'partner' && o.venue_slug === venue.slug && LIVE.has(o.status))) {
      errors.venue = 'That venue is already a partner. Email us if this is a mistake.';
    }
    order.venue_slug = venue ? venue.slug : '';
    order.venue_name = venue ? venue.name : '';
  } else if (kind === 'featured') {
    const v = validateSubmission({
      name: input.event_name, date: input.date, time: input.time, venue: input.venue,
      address: input.address, description: input.description, url: input.url
    }, { adminEdit: true });
    if (!v.ok) Object.assign(errors, v.errors);
    const ev = v.ok ? v.data.payload : null;
    if (ev) {
      const today = localDateStr(now);
      if (ev.date < today) errors.date = 'That date has passed.';
      else if (ev.date > addDays(today, FEATURE_DAYS_AHEAD)) errors.date = `Pick a date in the next ${FEATURE_DAYS_AHEAD} days.`;
    }
    order.event = ev;
  } else {
    errors._form = 'Unknown package.';
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, order };
}

// ─── Pages ───────────────────────────────────────────────────────────────

function field({ name, label, value = '', error, type = 'text', hint = '', required = true, max, rows }) {
  const id = `f-${name}`;
  const attrs = `id="${id}" name="${name}"${required ? ' required' : ''}${max ? ` maxlength="${max}"` : ''}${error ? ' aria-invalid="true"' : ''}`;
  const input = rows
    ? `<textarea ${attrs} rows="${rows}">${escHtml(value)}</textarea>`
    : `<input type="${type}" ${attrs} value="${escHtml(value)}">`;
  return `<div class="co-field"><label for="${id}">${escHtml(label)}</label>${input}` +
    (hint ? `<small class="co-hint">${escHtml(hint)}</small>` : '') +
    (error ? `<small class="co-error">${escHtml(error)}</small>` : '') + '</div>';
}

function selectField({ name, label, options, value, error }) {
  return `<div class="co-field"><label for="f-${name}">${escHtml(label)}</label>` +
    `<select id="f-${name}" name="${name}" required${error ? ' aria-invalid="true"' : ''}>` +
    '<option value="">Choose…</option>' +
    options.map(o => `<option value="${escHtml(o.value)}"${o.value === value ? ' selected' : ''}${o.disabled ? ' disabled' : ''}>${escHtml(o.label)}</option>`).join('') +
    `</select>${error ? `<small class="co-error">${escHtml(error)}</small>` : ''}</div>`;
}

export function renderCheckoutPage(pkg, { siteUrl, now, orders, venues, values = {}, errors = {} }) {
  const e = errors;
  const v = values;
  let fields = '';
  if (pkg.key === 'weekly') {
    const weeks = bookableWeeks(now, orders).map(w => ({ value: w.start, label: w.available ? w.label : `${w.label} (booked)`, disabled: !w.available }));
    fields = selectField({ name: 'week', label: 'Week', options: weeks, value: v.week, error: e.week }) +
      field({ name: 'business', label: 'Business name', value: v.business, error: e.business, max: 80 }) +
      field({ name: 'text', label: 'Sponsor message', value: v.text, error: e.text, max: 160, rows: 3, hint: 'Up to 160 characters. Shown under your name.' }) +
      field({ name: 'url', label: 'Website or page', value: v.url, error: e.url, max: 300 }) +
      field({ name: 'cta', label: 'Button text', value: v.cta, error: e.cta, max: 24, required: false, hint: 'Optional, e.g. "Order now". Default: Learn more.' }) +
      field({ name: 'address', label: 'Address', value: v.address, error: e.address, max: 120, required: false, hint: 'Optional.' });
  } else if (pkg.key === 'partner') {
    const opts = venues.map(x => ({ value: x.slug, label: x.name })).sort((a, b) => a.label.localeCompare(b.label));
    fields = selectField({ name: 'venue', label: 'Your venue', options: opts, value: v.venue, error: e.venue }) +
      field({ name: 'business', label: 'Business name', value: v.business, error: e.business, max: 80 }) +
      '<p class="co-hint">Venue not listed? Email us and we\'ll add it.</p>';
  } else {
    fields = field({ name: 'event_name', label: 'Event name', value: v.event_name, error: e.name, max: 200 }) +
      field({ name: 'date', label: 'Date', type: 'date', value: v.date, error: e.date }) +
      field({ name: 'time', label: 'Start time', value: v.time, error: e.time, max: 60, hint: 'e.g. 7:00 PM' }) +
      field({ name: 'venue', label: 'Venue', value: v.venue, error: e.venue, max: 200 }) +
      field({ name: 'address', label: 'Address', value: v.address, error: e.address, max: 300 }) +
      field({ name: 'description', label: 'Description', value: v.description, error: e.description, max: 2000, rows: 4 }) +
      field({ name: 'url', label: 'Event link', value: v.url, error: e.url, max: 500, required: false, hint: 'Optional: tickets or Facebook event.' }) +
      field({ name: 'business', label: 'Your name or organization', value: v.business, error: e.business, max: 80 });
  }
  const body = `
    <p><a href="/advertise">← All packages</a></p>
    <h1 class="page-title">${escHtml(pkg.name)}</h1>
    <p class="page-lead">${escHtml(pkg.price)}. ${escHtml(pkg.blurb)}</p>
    ${e._form ? `<p class="co-error co-error--form">${escHtml(e._form)}</p>` : ''}
    <form class="co-form" method="post" action="/advertise/checkout" data-turnstile>
      <input type="hidden" name="package" value="${escHtml(pkg.key)}">
      <div class="hp-field" aria-hidden="true"><label>Company <input name="company" tabindex="-1" autocomplete="off"></label></div>
      ${fields}
      ${field({ name: 'email', label: 'Email for your receipt', type: 'email', value: v.email, error: e.email, max: 254 })}
      <button class="btn btn--primary" type="submit">Continue to payment</button>
      <p class="co-hint">Secure payment by Stripe. ${pkg.interval ? 'Cancel any time from your receipt email.' : ''}</p>
    </form>`;
  return layout({
    siteUrl, path: '/advertise/checkout', nav: '/advertise', noindex: true,
    title: `${pkg.name} | ${SITE_NAME}`, description: `Buy ${pkg.name} on ${SITE_NAME}.`, body
  });
}

export function renderThanksPage(order, { siteUrl }) {
  let msg = 'We\'re confirming your payment. Stripe will email your receipt in a minute or two.';
  if (order && LIVE.has(order.status)) {
    if (order.kind === 'weekly') msg = `You're booked. Your sponsor block goes live the week of ${escHtml(formatDay(order.week_start, { month: 'long', day: 'numeric' }))}, including that Monday's newsletter.`;
    else if (order.kind === 'partner') msg = `You're a venue partner. Every event at ${escHtml(order.venue_name)} is now a Vic’s Pick.`;
    else msg = 'Thanks! We\'ll review your event shortly. Once it\'s listed, it\'s pinned to the top of its day.';
  }
  const body = `<h1 class="page-title">Thank you</h1><p class="page-lead">${msg}</p>
    <p><a class="btn btn--primary" href="/">See this week's events</a></p>`;
  return layout({ siteUrl, path: '/advertise/thanks', nav: '/advertise', noindex: true, title: `Thank you | ${SITE_NAME}`, description: 'Thank you.', body });
}

// ─── Wiring ──────────────────────────────────────────────────────────────

export function createSponsors({ store, siteUrl, nowFn, config, stripe, getVenues, slack = null }) {
  const supported = typeof store.listSponsorOrders === 'function';
  let cache = null;

  async function orders() {
    if (!supported) return [];
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.list;
    try {
      const list = await store.listSponsorOrders();
      cache = { at: Date.now(), list };
      return list;
    } catch (err) {
      console.warn('[sponsors] order list failed:', err.message);
      return cache ? cache.list : [];
    }
  }

  async function save(order) {
    await store.saveSponsorOrder({ ...order, updated_at: nowIso() });
    cache = null;
  }

  // One booking at a time (single Railway instance), so two buyers can't
  // both pass the "is this week free?" check before either hold is saved.
  let bookingChain = Promise.resolve();
  function withBookingLock(fn) {
    const run = bookingChain.then(fn, fn);
    bookingChain = run.catch(() => {});
    return run;
  }

  async function apply(payload) {
    try {
      return applyPlacements(payload, await orders(), { now: nowFn(), venues: getVenues() });
    } catch (err) {
      console.warn('[sponsors] placements skipped:', err.message);
      return payload;
    }
  }

  async function fulfil(order) {
    if (order.kind === 'featured' && order.event && !order.submission_id) {
      const now = nowIso();
      const row = {
        id: newId(), created_at: now, updated_at: now, status: 'pending', source: 'paid-feature',
        submitter_kind: 'organizer', submitter_name: order.business, submitter_email: order.email,
        submitter_ip: null, user_agent: '', payload: normalizePayload(order.event),
        admin_notes: `Paid featured listing (order ${order.id}). Approve and publish it; it's pinned as a Vic’s Pick automatically.`,
        review_history: [{ at: now, action: 'submitted', note: 'Paid featured listing' }]
      };
      await store.insert(row);
      order.submission_id = row.id;
      await save(order);
    }
    if (slack) {
      const pkg = packageFor(order.kind);
      slack.notify({ channel: 'sales',
        title: `💰 New sponsor: ${order.business}`,
        fields: [['Package', pkg ? pkg.name : order.kind], ['Paid', `$${Math.round((order.amount || 0) / 100)}${order.kind === 'partner' ? '/mo' : ''}`],
          ['Contact', order.email],
          ['Details', order.kind === 'weekly' ? `Week of ${order.week_start}` : order.kind === 'partner' ? order.venue_name : `${order.event.name} (${order.event.date})`]],
        text: order.kind === 'featured' ? 'Approve the event in the Submissions tab to put it live.' : 'Live automatically.',
        link: `${siteUrl}/admin.html`
      });
    }
  }

  const findBy = (list, key, val) => (val ? list.find(o => o[key] === val) : null);

  async function processEvent(event) {
    const obj = (event && event.data && event.data.object) || {};
    if (!supported) return;
    cache = null;
    const list = await store.listSponsorOrders();
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const order = findBy(list, 'id', obj.client_reference_id) || findBy(list, 'session_id', obj.id);
        if (!order) return;
        // A retry after a failed fulfil (e.g. the submission insert threw):
        // the order is already paid, so finish the job instead of stopping.
        if (LIVE.has(order.status)) {
          if (order.kind === 'featured' && order.event && !order.submission_id) await fulfil(order);
          return;
        }
        if (!['pending', 'expired', 'failed', 'processing'].includes(order.status)) return;
        // Delayed payment methods complete the session before the money
        // arrives; async_payment_succeeded (or _failed) follows. Hold the
        // week meanwhile so nobody else can buy it.
        if (obj.payment_status !== 'paid' && obj.payment_status !== 'no_payment_required') {
          if (event.type === 'checkout.session.completed' && order.status !== 'processing') {
            await save({ ...order, status: 'processing', session_id: order.session_id || obj.id });
          }
          return;
        }
        Object.assign(order, {
          status: order.kind === 'partner' ? 'active' : 'paid',
          paid_at: nowIso(),
          amount: Number.isFinite(obj.amount_total) ? obj.amount_total : order.amount,
          subscription_id: typeof obj.subscription === 'string' ? obj.subscription : null,
          customer_id: typeof obj.customer === 'string' ? obj.customer : null,
          payment_intent: typeof obj.payment_intent === 'string' ? obj.payment_intent : null
        });
        // Someone else already paid for this week (e.g. this hold lapsed
        // first). Keep the money traceable and ask for a refund, but don't
        // put two sponsors in one slot.
        if (order.kind === 'weekly' && list.some(o => o.id !== order.id && o.kind === 'weekly' &&
            o.week_start === order.week_start && LIVE.has(o.status))) {
          order.status = 'conflict';
          await save(order);
          if (slack) {
            slack.alert(`sponsor-conflict:${order.id}`, `Week of ${order.week_start} was paid for twice`,
              `${order.business} (${order.email}) paid for a week that's already sold. Refund them in Stripe or move them to another week.`,
              `${siteUrl}/admin.html`);
          }
          return;
        }
        await save(order);
        await fulfil(order);
        return;
      }
      case 'checkout.session.async_payment_failed': {
        const order = findBy(list, 'id', obj.client_reference_id) || findBy(list, 'session_id', obj.id);
        if (!order || !['processing', 'pending'].includes(order.status)) return;
        await save({ ...order, status: 'failed' });
        if (slack) {
          slack.notify({ channel: 'sales',
            title: `⚠️ Sponsor payment didn't go through: ${order.business}`,
            fields: [['Package', order.kind], ['Contact', order.email]],
            text: order.kind === 'weekly' ? `Week of ${order.week_start} is open again.` : 'Nothing went live.'
          });
        }
        return;
      }
      case 'invoice.payment_failed': {
        // Older API versions put the subscription on the invoice; newer ones
        // under parent.subscription_details.
        const subId = (typeof obj.subscription === 'string' && obj.subscription) ||
          (obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription) || null;
        const order = findBy(list, 'subscription_id', subId);
        if (order && slack) {
          slack.notify({ channel: 'sales',
            title: `⚠️ Venue partner card declined: ${order.business}`,
            fields: [['Venue', order.venue_name], ['Contact', order.email]],
            text: 'Stripe will retry automatically. Their badges pause if the subscription goes past due.'
          });
        }
        return;
      }
      case 'radar.early_fraud_warning.created': {
        const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : null;
        const order = findBy(list, 'payment_intent', pi);
        if (slack) {
          slack.alert(`fraud-warning:${obj.id || pi}`, 'Stripe early fraud warning on a sponsor payment',
            `${order ? `${order.business} (${order.email}), ${order.kind}` : `Payment ${pi || 'unknown'}`}. Review it in Stripe and refund if it looks fraudulent.`,
            'https://dashboard.stripe.com/radar/early-fraud-warnings');
        }
        return;
      }
      case 'checkout.session.expired': {
        const order = findBy(list, 'id', obj.client_reference_id) || findBy(list, 'session_id', obj.id);
        if (order && order.status === 'pending') await save({ ...order, status: 'expired' });
        return;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const order = findBy(list, 'subscription_id', obj.id);
        if (!order) return;
        const s = event.type === 'customer.subscription.deleted' ? 'canceled' : obj.status;
        const status = (s === 'active' || s === 'trialing') ? 'active' : s === 'canceled' ? 'cancelled' : 'paused';
        // Hidden by the admin: remember what Stripe says so Restore can't
        // bring back a partner that cancelled in the meantime.
        if (order.status === 'hidden') {
          if (order.hidden_from !== status) await save({ ...order, hidden_from: status });
          return;
        }
        if (status !== order.status) {
          await save({ ...order, status });
          if (slack && status !== 'active') {
            slack.notify({ channel: 'sales',
              title: status === 'cancelled' ? `👋 Venue partner cancelled: ${order.business}` : `⚠️ Venue partner payment issue: ${order.business}`,
              fields: [['Venue', order.venue_name], ['Contact', order.email]],
              text: status === 'cancelled' ? 'Their events are no longer marked Vic’s Pick.' : 'Stripe couldn’t charge them, so their Vic’s Pick badges are paused until it does.'
            });
          }
        }
        return;
      }
      case 'charge.refunded':
      case 'charge.dispute.created': {
        const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : null;
        const order = findBy(list, 'payment_intent', pi);
        if (!order || order.status === 'refunded') return;
        if (event.type === 'charge.refunded' && obj.refunded === false) return; // partial refund: leave it live
        await save({ ...order, status: 'refunded', hidden_from: null });
        if (slack) {
          slack.notify({ channel: 'sales',
            title: event.type === 'charge.refunded' ? `↩️ Sponsor refunded: ${order.business}` : `⚠️ Sponsor disputed a charge: ${order.business}`,
            fields: [['Contact', order.email], ['Order', order.id]],
            text: 'Their placement is off the site.'
          });
        }
        return;
      }
      default:
    }
  }

  // Must be registered before express.json: the signature covers raw bytes.
  function registerWebhook(app) {
    app.post('/api/stripe/webhook', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
      if (!config.webhookSecret) return res.status(503).json({ ok: false, error: 'not-configured' });
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      if (!verifyStripeSignature(raw, req.get('stripe-signature'), config.webhookSecret)) {
        return res.status(400).json({ ok: false, error: 'bad-signature' });
      }
      let event;
      try { event = JSON.parse(raw); } catch (_) { return res.status(400).json({ ok: false, error: 'bad-json' }); }
      try {
        await processEvent(event);
      } catch (err) {
        // A 500 makes Stripe retry with backoff, which is what we want.
        console.error('[sponsors] webhook failed:', event.type, err.message);
        if (slack) slack.alert(`stripe-webhook:${event.type}`, 'Stripe webhook failed (Stripe will retry)', `${event.type}: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'webhook-failed' });
      }
      res.json({ received: true });
    });
  }

  function registerRoutes(app, { requireAdmin, createRateLimiter, sendHtml, verifyHuman = async () => true }) {
    const limiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20 });

    app.get('/advertise/checkout', async (req, res, next) => {
      try {
        const pkg = packageFor(req.query.package);
        if (!config.enabled || !pkg) return res.redirect(302, '/advertise');
        sendHtml(res, renderCheckoutPage(pkg, { siteUrl, now: nowFn(), orders: await orders(), venues: getVenues() }), 200, 'no-store');
      } catch (err) { next(err); }
    });

    app.post('/advertise/checkout', async (req, res, next) => {
      try {
        const body = req.body || {};
        const pkg = packageFor(body.package);
        if (!config.enabled || !pkg) return res.redirect(303, '/advertise');
        const ctx = { siteUrl, now: nowFn(), orders: await orders(), venues: getVenues(), values: body };
        const fail = (errors, status = 400) =>
          sendHtml(res, renderCheckoutPage(pkg, { ...ctx, errors }), status, 'no-store');
        if (typeof body.company === 'string' && body.company.trim()) return res.redirect(303, '/advertise');
        const ip = req.ip || req.socket.remoteAddress;
        if (!limiter.check(ip).ok) return fail({ _form: 'Too many attempts. Try again in an hour.' }, 429);
        if (!(await verifyHuman(req))) return fail({ _form: "We couldn't confirm you're not a bot. Please try again." });

        // Re-read and save the hold under one lock, so a week booked seconds
        // ago (or right now, by someone else) is caught.
        const booked = await withBookingLock(async () => {
          cache = null;
          ctx.orders = await orders();
          const v = validateOrder(pkg.key, body, ctx);
          if (!v.ok) return { errors: v.errors };
          // Same clock as bookableWeeks, so the hold window lines up.
          const o = { ...v.order, id: newId(), status: 'pending', amount: pkg.amount, created_at: nowFn().toISOString() };
          await save(o);
          return { order: o };
        });
        if (booked.errors) return fail(booked.errors);
        const order = booked.order;
        let lineItem = {
          quantity: 1,
          price_data: {
            currency: 'usd', unit_amount: pkg.amount,
            product_data: { name: `${SITE_NAME}: ${pkg.name}` },
            recurring: pkg.interval ? { interval: pkg.interval } : undefined
          }
        };
        // Catalog price when we can get one; inline price_data otherwise, so
        // a catalog hiccup never blocks a sale.
        if (typeof stripe.ensurePrice === 'function') {
          try {
            lineItem = { quantity: 1, price: await stripe.ensurePrice(pkg) };
          } catch (err) {
            console.warn('[sponsors] catalog price unavailable, using inline price:', err.message);
          }
        }
        let session;
        try {
          session = await stripe.createCheckoutSession({
            mode: pkg.interval ? 'subscription' : 'payment',
            // No payment_method_types: Stripe shows the methods enabled in
            // the Dashboard. Slower methods (bank debits) keep the week held
            // as "processing" until they settle; see the webhook.
            integration_identifier: INTEGRATION_ID,
            customer_email: order.email,
            client_reference_id: order.id,
            line_items: [lineItem],
            metadata: { order_id: order.id, package: pkg.key },
            subscription_data: pkg.interval ? { metadata: { order_id: order.id } } : undefined,
            expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_TTL_S,
            success_url: `${siteUrl}/advertise/thanks?order=${order.id}`,
            cancel_url: `${siteUrl}/advertise/checkout?package=${pkg.key}`
          }, `vic361-order-${order.id}`);
        } catch (err) {
          console.error('[sponsors] checkout session failed:', err.message);
          if (slack) slack.alert('stripe-checkout', 'Sponsor checkout is failing', `Stripe: ${err.message}`);
          await save({ ...order, status: 'failed' }); // release the hold
          return fail({ _form: 'The payment page is unavailable right now. Please try again in a few minutes.' }, 502);
        }
        await save({ ...order, session_id: session.id });
        res.redirect(303, session.url);
      } catch (err) { next(err); }
    });

    app.get('/advertise/thanks', async (req, res, next) => {
      try {
        cache = null;
        const order = (await orders()).find(o => o.id === req.query.order) || null;
        sendHtml(res, renderThanksPage(order, { siteUrl }), 200, 'no-store');
      } catch (err) { next(err); }
    });

    app.get('/api/admin/sponsors', requireAdmin, async (req, res) => {
      cache = null;
      const list = await orders();
      res.json({
        ok: true,
        configured: config.enabled,
        supported,
        orders: list.filter(o => o.status !== 'expired' && o.status !== 'failed' && !(o.status === 'pending' &&
          nowFn().getTime() - Date.parse(o.created_at) > 24 * 3600 * 1000)),
        weeks: bookableWeeks(nowFn(), list)
      });
    });

    // Hide pulls a placement (refund, bad copy); restore puts it back.
    app.post('/api/admin/sponsors/:id', requireAdmin, async (req, res) => {
      const action = req.body && req.body.action;
      cache = null;
      const order = (await orders()).find(o => o.id === req.params.id);
      if (!order) return res.status(404).json({ ok: false, error: 'not-found' });
      if (action === 'hide' && LIVE.has(order.status)) {
        await save({ ...order, status: 'hidden', hidden_from: order.status });
      } else if (action === 'restore' && order.status === 'hidden') {
        await save({ ...order, status: order.hidden_from || 'paid', hidden_from: null });
      } else {
        return res.status(400).json({ ok: false, error: 'bad-action' });
      }
      res.json({ ok: true });
    });
  }

  return { apply, orders, registerWebhook, registerRoutes, processEvent };
}
