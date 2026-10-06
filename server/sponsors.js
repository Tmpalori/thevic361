/* server/sponsors.js — Self-serve sponsor checkout through Stripe.
 *
 * A business picks a package on /advertise, fills one short form, pays on
 * Stripe Checkout, and the placement goes live on its own:
 *
 *   - Weekly sponsor ($300, one-time): books one Monday–Sunday week. Their
 *     block replaces the sponsor slot on every page, in /events.json, and in
 *     that Monday's newsletter. One sponsor per week; a week someone is
 *     paying for right now is held for the life of the Checkout session.
 *   - Venue partner (retired Oct 2026, no longer sold): a $150/month Stripe
 *     subscription that made every event at the venue a Vic’s Pick. It
 *     flooded busy days past the Vic’s Pick limits and undercut the per-event
 *     price, so it's off /advertise and checkout. Subscriptions bought before
 *     then are still honored (applyPlacements) until they're cancelled in
 *     Stripe (customer.subscription.* webhooks).
 *   - Vic’s Pick event (one-time; $49 Mon–Thu, $89 Fri–Sun): the event lands
 *     in the submissions queue (so a person still checks it before it's
 *     listed) and is pinned as Featured as soon as it, or a matching
 *     collector event, is live. Limited per day (VICS_PICK caps) so the top
 *     of a day stays special; a day that's full can't be bought.
 *
 * Every checkout form shows a live preview of the placement (the same
 * markup the site uses) before anyone is sent to pay.
 *
 * Weekly sponsors get a report the Monday after their week
 * (sendSponsorReports): how often their block was seen (data-ad
 * impressions from docs/track.js) and where, site clicks from the track
 * beacon, email clicks from the /go/s/<week> redirect the newsletter's
 * sponsor button uses. Vic's Picks get one the morning after their event
 * (sendPickReports). Both run from the Monday newsletter cron and the
 * 15-minute submission review cron (they're idempotent); the Sponsors
 * tab's Report button shows the same numbers live. The admin can edit a
 * weekly order's wording, link, logo and week (Sponsors tab).
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
  AD_PACKAGES, SITE_NAME, escHtml, safeUrl, localDateStr, currentWeek, addDays, formatDay, layout,
  renderEventItem, sponsorHtml
} from './seo.js';
import { normalizeUrl, validateSubmission } from './validate.js';
import { normalizePayload, newId, nowIso, eventKeyOf } from './db.js';
import { normalizeEmail } from './newsletter.js';
import { venueFor } from './guides.js';
import { renderSponsorConfirmed, renderSponsorReport, renderPickReport, renderSponsorTooLate, newsletterCovers, pickWhere } from './notify.js';
import { botName, visitorHash, pageType, PAGE_TYPES, rowCount } from './analytics.js';

export { newsletterCovers, pickWhere };

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
// Weekly orders the admin can edit (wording, link, logo, week).
const EDITABLE = new Set(['paid', 'hidden', 'processing', 'conflict']);
// /advertise/checkout?from=<submission> fills in the submitter's contact
// details only this long after they submitted (and only while it's pending).
const PREFILL_CONTACT_MS = 7 * 24 * 3600 * 1000;
// Weekly sponsor click reports go out from the Monday after the week, and
// a run that was missed catches up for this long.
const REPORT_CATCHUP_DAYS = 14;
// Vic's Pick reports go out from 9 AM (Victoria time) the day after the event.
const PICK_REPORT_HOUR = 9;

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

// ─── Vic’s Pick pricing and capacity ─────────────────────────────────────
// "Weekend" is Fri–Sun, the site's own "This weekend". Caps are per day.
export const VICS_PICK = { weekdayAmount: 4900, weekendAmount: 8900, weekdayCap: 3, weekendCap: 4 };

export function isWeekendDate(dateStr) {
  const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat
  return dow === 5 || dow === 6 || dow === 0;
}

// The Stripe product/price for a Vic’s Pick on that date (weekend picks are
// their own catalog price, so receipts and reports tell them apart).
export function pickPackage(dateStr) {
  const base = packageFor('featured');
  if (!isWeekendDate(dateStr)) return { ...base, amount: VICS_PICK.weekdayAmount };
  return { ...base, key: 'featured_weekend', name: `${base.name} (Fri–Sun)`, amount: VICS_PICK.weekendAmount };
}

// A checkout someone is paying for right now. `email` is the buyer asking:
// their own earlier hold (they backed out of Stripe and came back) doesn't
// count against them.
function isHold(o, nowMs, email = '') {
  return o.status === 'pending' && nowMs - Date.parse(o.created_at) < HOLD_MS && !(email && o.email === email);
}

// Spots used on a date: paid or settling orders, plus checkouts still being
// paid (held like weekly sponsor weeks, so a day can't be oversold).
export function picksTaken(dateStr, orders, nowMs, email = '') {
  return (orders || []).filter(o => o.kind === 'featured' && o.event && o.event.date === dateStr &&
    (LIVE.has(o.status) || o.status === 'processing' || isHold(o, nowMs, email))).length;
}

// Admin calendar: every sponsorship slot for `weeks` weeks from this
// Monday. Each week has the weekly-sponsor slot; each day its Vic’s Pick
// spots with who holds them. state: 'booked' (paid / live), 'processing'
// (slow payment settling), 'held' (checkout open right now), 'open'.
function slotState(o, nowMs) {
  if (LIVE.has(o.status)) return 'booked';
  if (o.status === 'processing') return 'processing';
  if (o.status === 'pending' && nowMs - Date.parse(o.created_at) < HOLD_MS) return 'held';
  return null;
}

export function sponsorCalendar(now, orders, weeks = 8) {
  const nowMs = now.getTime();
  const today = localDateStr(now);
  const monday = currentWeek(today)[0];
  const short = { month: 'short', day: 'numeric' };
  const active = (orders || []).map(o => ({ o, state: slotState(o, nowMs) })).filter(x => x.state);
  return Array.from({ length: weeks }, (_, w) => {
    const start = addDays(monday, 7 * w);
    const weekly = active.find(x => x.o.kind === 'weekly' && x.o.week_start === start);
    const days = Array.from({ length: 7 }, (_, d) => {
      const date = addDays(start, d);
      const a = pickAvailability(date, orders, now);
      const picks = active.filter(x => x.o.kind === 'featured' && x.o.event && x.o.event.date === date)
        .map(x => ({ id: x.o.id, business: x.o.business || '', event: x.o.event.name || '', state: x.state }));
      return { date, past: date < today, weekend: a.weekend, cap: a.cap, taken: a.taken, left: a.left, price: a.price, picks };
    });
    return {
      start, label: `${formatDay(start, short)} – ${formatDay(addDays(start, 6), short)}`,
      weekly: weekly ? { id: weekly.o.id, business: weekly.o.business || '', state: weekly.state } : null,
      days
    };
  });
}

export function pickAvailability(dateStr, orders, now, email = '') {
  const weekend = isWeekendDate(dateStr);
  const cap = weekend ? VICS_PICK.weekendCap : VICS_PICK.weekdayCap;
  const taken = picksTaken(dateStr, orders, now.getTime(), email);
  const amount = weekend ? VICS_PICK.weekendAmount : VICS_PICK.weekdayAmount;
  return { date: dateStr, weekend, cap, taken, left: Math.max(0, cap - taken), amount, price: `$${amount / 100}` };
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
    },
    // The buyer came back from Stripe without paying: close the session so
    // it can't be paid later for a spot we've released.
    async expireCheckoutSession(id) {
      return call('POST', `/checkout/sessions/${encodeURIComponent(id)}/expire`, {});
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

// Whether a Vic's Pick order is this event. `pins` maps order id to the
// other shapes the event may be live as: its submission as it is now (the
// admin may have fixed the date, venue or name when approving) and any
// Events-tab edit of that, so an edit doesn't silently drop the pin.
export function pickMatches(order, ev, pins = new Map()) {
  if (sameEvent(order.event, ev)) return true;
  const key = eventKeyOf(ev);
  return (pins.get(order.id) || []).some(s => eventKeyOf(s) === key || sameEvent(s, ev));
}

export function applyPlacements(payload, orders, { now, venues = [], pins = new Map() }) {
  const live = (orders || []).filter(o => LIVE.has(o.status));
  if (!live.length || !payload) return payload;
  const week = currentWeek(localDateStr(now))[0];
  const weekly = live.find(o => o.kind === 'weekly' && o.week_start === week);
  const featured = live.filter(o => o.kind === 'featured' && o.event);
  const partners = new Set(live.filter(o => o.kind === 'partner').map(o => o.venue_slug));
  const events = (payload.events || []).map(ev => {
    // `sponsor_order` tags a paid pick with its order (data-ad in the
    // markup), so its views and clicks land in the buyer's report. Checked
    // before `featured`: an event the admin already starred is still theirs.
    const order = featured.find(o => pickMatches(o, ev, pins));
    if (order) return { ...ev, featured: true, sponsor_order: order.id };
    if (ev.featured) return ev;
    if (partners.size) {
      const v = venueFor(ev, venues);
      if (v && partners.has(v.slug)) return { ...ev, featured: true };
    }
    return ev;
  });
  // `week` lets the newsletter route the sponsor's button through
  // /go/s/<week>, which counts email clicks for the sponsor's report;
  // `order` tags the block (data-ad) for its view count.
  return { ...payload, events, sponsor: weekly ? { ...weekly.sponsor, week: weekly.week_start, order: weekly.id } : (payload.sponsor || null) };
}

// ─── Slow payments ───────────────────────────────────────────────────────
// Bank debits can take days to settle. Close to the date, checkout offers
// only cards (wallets included), which settle at once; a slow payment that
// still clears after the pick's day or the sponsor week is over is marked
// 'late' (never fulfilled) for the owner to refund.
const INSTANT_ONLY_DAYS = 5;

function orderDates(order) {
  if (order.kind === 'weekly' && order.week_start) return [order.week_start, addDays(order.week_start, 6)];
  if (order.kind === 'featured' && order.event && order.event.date) return [order.event.date, order.event.date];
  return null;
}

export function instantOnly(order, now) {
  const d = orderDates(order);
  return Boolean(d) && d[0] <= addDays(localDateStr(now), INSTANT_ONLY_DAYS);
}

export function paidTooLate(order, now) {
  const d = orderDates(order);
  return Boolean(d) && d[1] < localDateStr(now);
}

// ─── Sponsor click report ────────────────────────────────────────────────
// Weekly sponsors are promised how many people clicked. Site clicks come
// from the track beacon (docs/track.js sponsor_click with the button's
// link); email clicks from the /go/s/<week> redirect. People are counted
// once per day (the same visitor hash the Traffic tab uses), so a mail
// scanner or a double tap doesn't inflate the number.
// Compared by host (without www) and path only: the button's href is
// sponsorLinkUrl(url), so the beacon's click_url carries utm_* tags (and the
// browser may add a #hash) that the stored sponsor URL doesn't.
function sameLink(a, b) {
  const norm = u => {
    const raw = String(u || '').trim();
    try {
      const x = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
      return `${x.hostname.toLowerCase().replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}`;
    } catch {
      return raw.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    }
  };
  return Boolean(a) && Boolean(b) && norm(a) === norm(b);
}

// People: one per visitor per day (rows without a hash count apart).
function peopleIn(list) {
  return new Set(list.map(r => `${r.day}|${r.visitor || Math.random()}`)).size;
}

// Ad views by page type (server/analytics.js pageType), biggest first,
// leaving out types it never ran on.
function whereItRan(impressions) {
  return PAGE_TYPES.map(type => ({ type, views: rowCount(impressions.filter(r => pageType(r.path) === type)) }))
    .filter(x => x.views > 0).sort((a, b) => b.views - a.views);
}

// Counts are weighted by `n` (PgStore.listTraffic groups rows; rowCount).
export function sponsorStats(order, rows, { recipients = 0 } = {}) {
  const start = order.week_start;
  const end = addDays(start, 6);
  const inWeek = (rows || []).filter(r => r.day >= start && r.day <= end);
  const clicks = inWeek.filter(r => r.kind === 'click' && r.click_type === 'sponsor_click');
  const email = clicks.filter(r => r.path === `/go/s/${start}`);
  const site = clicks.filter(r => !String(r.path || '').startsWith('/go/') &&
    (r.ad === order.id || sameLink(r.click_url, order.sponsor && order.sponsor.url)));
  // Seen: the block was at least half on screen for a second (docs/track.js).
  const seen = inWeek.filter(r => r.kind === 'impression' && r.ad === order.id);
  return {
    week_start: start, week_end: end,
    views: rowCount(seen), view_people: peopleIn(seen), where: whereItRan(seen),
    site_clicks: rowCount(site), site_people: peopleIn(site),
    email_clicks: rowCount(email), email_people: peopleIn(email),
    site_visitors: peopleIn(inWeek.filter(r => r.kind === 'view')),
    newsletter_recipients: Number(recipients) || 0
  };
}

// ─── Vic's Pick report ───────────────────────────────────────────────────
// What a paid pick got, from the day it was bought through its (last) day:
//   shown      times it was seen in an event list as a Vic's Pick (its
//              data-ad impressions; the event's own page doesn't count)
//   page views views of its event page(s)
//   link       taps on the buyer's own link, from a list (data-ad) or its
//              page (the "event details" button); compared like sameLink
//   calendar   "Add to calendar" / Google Calendar taps on its page
//   shares     share taps on its page, or anywhere for its page's link
// `pages`: its event page paths (one per day it's listed); `urls`: the
// link(s) it carries; `starred`: whether the Monday issue starred it.
function pathOf(u) {
  try { return new URL(String(u || ''), 'https://x.invalid').pathname.replace(/\/+$/, ''); } catch { return ''; }
}

export function pickStats(order, rows, { start, end, pages = [], urls = [], recipients = 0, starred = false } = {}) {
  const inRange = (rows || []).filter(r => r.day >= start && r.day <= end);
  const onPage = r => pages.includes(r.path);
  const clicks = type => inRange.filter(r => r.kind === 'click' && (typeof type === 'function' ? type(r.click_type) : r.click_type === type));
  const seen = inRange.filter(r => r.kind === 'impression' && r.ad === order.id);
  const views = inRange.filter(r => r.kind === 'view' && onPage(r));
  const link = clicks('event_click').filter(r => (r.ad === order.id || onPage(r)) && urls.some(u => sameLink(r.click_url, u)));
  const calendar = clicks('add_to_calendar').filter(onPage);
  const shares = clicks(t => /^share_/.test(t || '')).filter(r => onPage(r) || pages.includes(pathOf(r.click_url)));
  return {
    start, end, pages,
    shown: rowCount(seen), shown_people: peopleIn(seen), where: whereItRan(seen),
    page_views: rowCount(views), page_people: peopleIn(views),
    link_clicks: rowCount(link), link_people: peopleIn(link),
    calendar_adds: rowCount(calendar), shares: rowCount(shares),
    newsletter_starred: Boolean(starred), newsletter_recipients: starred ? Number(recipients) || 0 : 0
  };
}

// The sponsor's link with our UTM tags (unless it already has its own), so
// the visit shows up as from The Vic 361 in the sponsor's own analytics.
export function sponsorLandingUrl(url, { medium = 'email', campaign = 'newsletter' } = {}) {
  const safe = safeUrl(url);
  if (!safe) return '';
  try {
    const u = new URL(safe);
    if (!u.searchParams.has('utm_source')) {
      u.searchParams.set('utm_source', 'thevic361');
      u.searchParams.set('utm_medium', medium);
      u.searchParams.set('utm_campaign', campaign);
    }
    return u.href;
  } catch {
    return safe;
  }
}

export function bookableWeeks(now, orders, email = '') {
  const monday = currentWeek(localDateStr(now))[0];
  const nowMs = now.getTime();
  const taken = new Set((orders || [])
    .filter(o => o.kind === 'weekly' && (o.status === 'paid' || o.status === 'processing' || isHold(o, nowMs, email)))
    .map(o => o.week_start));
  const short = { month: 'short', day: 'numeric' };
  return Array.from({ length: WEEKS_AHEAD }, (_, i) => {
    const start = addDays(monday, 7 * (i + 1));
    return { start, label: `${formatDay(start, short)} to ${formatDay(addDays(start, 6), short)}`, available: !taken.has(start) };
  });
}

// ─── Sponsor logo ────────────────────────────────────────────────────────
// The checkout page shrinks the logo in the browser (canvas) and sends it as
// a data URL in a hidden field, so the server needs no upload library. Only
// PNG, JPEG and WebP (checked by their first bytes, not the label): SVG can
// carry script, so it's not accepted.
const LOGO_MAX_BYTES = 300 * 1024;
// The same limit as base64 (4 chars per 3 bytes) plus the data: prefix; the
// checkout page refuses anything longer before it's sent.
const LOGO_MAX_CHARS = Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 32;
export const LOGO_PATH = /^\/sponsor-logo\/[A-Za-z0-9-]{8,64}$/;

export function parseLogo(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').trim());
  if (!m) return { error: 'Logo must be a PNG, JPG or WebP image.' };
  const data = Buffer.from(m[2], 'base64');
  if (!data.length) return { error: 'That logo file looks empty.' };
  if (data.length > LOGO_MAX_BYTES) return { error: 'Logo is too large. Try a smaller image (under 300 KB).' };
  const sig = {
    png: data[0] === 0x89 && data.slice(1, 4).toString() === 'PNG',
    jpeg: data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
    webp: data.slice(0, 4).toString() === 'RIFF' && data.slice(8, 12).toString() === 'WEBP'
  };
  if (!sig[m[1]]) return { error: 'That file isn’t a valid image.' };
  return { contentType: `image/${m[1]}`, data };
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
    const week = bookableWeeks(now, orders, email).find(w => w.start === input.week);
    if (!week) errors.week = 'Pick a week.';
    else if (!week.available) errors.week = 'That week was just booked. Pick another.';
    order.week_start = week ? week.start : '';
    order.sponsor = { name: business, text, cta, url, address };
    if (input.logo_data) {
      const logo = parseLogo(input.logo_data);
      if (logo.error) errors.logo = logo.error;
      else order.logo = logo;   // saved separately; never stored on the order
    }
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
      else if (!pickAvailability(ev.date, orders, now, email).left) {
        const a = pickAvailability(ev.date, orders, now, email);
        errors.date = `Vic’s Picks for ${formatDay(ev.date, { weekday: 'long', month: 'short', day: 'numeric' })} are sold out (${a.cap} a day). Pick another day, or submit the event free.`;
      }
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

// ─── Live preview ────────────────────────────────────────────────────────
// What the buyer gets, drawn with the site's own markup (renderEventItem,
// sponsorHtml) from what they've typed so far. Rendered into the checkout
// page and refreshed from POST /advertise/preview as they type, so there's
// one renderer and the preview can't drift from the real thing.

const SAMPLE_OTHERS = [
  { name: 'Other events that day', time: '6:00 PM', venue: 'Listed below yours' },
  { name: '…and the rest of the day’s list', time: '8:00 PM', venue: '' }
];

function dayCard(dateStr, items) {
  const head = dateStr
    ? `<h2 class="day-name">${escHtml(formatDay(dateStr, { weekday: 'long' }))}</h2><span class="day-date">${escHtml(formatDay(dateStr, { month: 'long', day: 'numeric' }))}</span>`
    : '<h2 class="day-name">Your event’s day</h2>';
  return `<section class="day-section co-preview-day"><div class="day-header">${head}</div>` +
    `<ul class="event-list" role="list">${items.join('')}</ul></section>`;
}

function previewItem(ev) {
  return renderEventItem({ ...ev, page: '#preview' }).replace(/<a href="#preview">/g, '<a href="#preview" tabindex="-1" onclick="return false">');
}

export function renderPreview(pkgKey, v = {}, { now, orders = [], venues = [] } = {}) {
  const val = k => clean(v[k], 2000);
  if (pkgKey === 'weekly') {
    const block = sponsorHtml({
      name: clean(v.business, 80) || 'Your business',
      text: clean(v.text, 160) || 'Your one or two sentences about your business go here.',
      cta: clean(v.cta, 24) || 'Learn more',
      url: safeUrl(normalizeUrl(clean(v.url, 300))) || '#',
      address: clean(v.address, 120)
    });
    return `<p class="co-preview-where">Shown on every page of thevic361.com for your week, and at the top of that Monday’s newsletter.</p>${block}`;
  }
  // Vic’s Pick: the event as it will look, pinned above the rest of its day.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(val('date')) ? val('date') : '';
  const ev = {
    name: clean(v.event_name, 200) || 'Your event name',
    time: clean(v.time, 60) || '7:00 PM',
    venue: clean(v.venue, 200) || 'Your venue',
    description: clean(v.description, 300) || 'Your description shows here.',
    featured: true
  };
  const others = SAMPLE_OTHERS.map(o => previewItem(o).replace('class="event-entry"', 'class="event-entry co-preview-dim"'));
  let price = `<strong>$${VICS_PICK.weekdayAmount / 100}</strong> Mon–Thu · <strong>$${VICS_PICK.weekendAmount / 100}</strong> Fri–Sun. Pick a date to see open spots.`;
  if (date && now) {
    const a = pickAvailability(date, orders, now);
    const day = formatDay(date, { weekday: 'long', month: 'short', day: 'numeric' });
    price = a.left
      ? `<strong>${escHtml(day)}: ${a.price}</strong> · ${a.left} of ${a.cap} Vic’s Pick spots left`
      : `<strong class="co-error">${escHtml(day)} is sold out</strong> (${a.cap} Vic’s Picks a day). Pick another day.`;
  }
  return `<p class="co-preview-price">${price}</p>` +
    `<p class="co-preview-where">Pinned at the top of its day on the site and its event page, ${escHtml(pickWhere(date, now))}:</p>` +
    dayCard(date, [previewItem(ev), ...others]);
}

// Example placements for the /advertise page.
export function samplePreviews() {
  return {
    weekly: renderPreview('weekly', { business: 'Your Business', text: 'One or two sentences about what you offer, shown all week.', cta: 'Learn more' }),
    featured: renderPreview('featured', { event_name: 'Your Event Name', time: '7:00 PM', venue: 'Your Venue', description: 'A line or two about your event.' })
  };
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
      `<div class="co-field"><label for="f-logo">Logo</label><input type="file" id="f-logo" accept="image/png,image/jpeg,image/webp">` +
      // A rejected logo isn't sent back, so resubmitting doesn't fail again.
      `<input type="hidden" name="logo_data" id="f-logo-data" value="${e.logo ? '' : escHtml(v.logo_data || '')}">` +
      `<button type="button" class="btn btn--ghost" id="f-logo-remove"${!e.logo && v.logo_data ? '' : ' hidden'}>Remove logo</button>` +
      `<small class="co-hint">Optional. PNG, JPG or WebP; a wide logo on a plain background looks best. Shown on your sponsor block.</small>` +
      (e.logo ? `<small class="co-error">${escHtml(e.logo)}</small>` : '') + '</div>' +
      field({ name: 'address', label: 'Address', value: v.address, error: e.address, max: 120, required: false, hint: 'Optional.' });
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
      <section class="co-preview" aria-labelledby="co-preview-h">
        <h2 id="co-preview-h" class="co-preview-h">Preview: exactly how it’ll look</h2>
        <div id="co-preview" aria-live="polite">${renderPreview(pkg.key, v, { now, orders, venues })}</div>
      </section>
      ${field({ name: 'email', label: 'Email for your receipt', type: 'email', value: v.email, error: e.email, max: 254 })}
      <button class="btn btn--primary" type="submit">Continue to payment</button>
      <p class="co-hint">Secure payment by Stripe. ${pkg.interval ? 'Cancel any time from your receipt email.' : ''}</p>
    </form>
    <script>
    (function () {
      // The submission or order id that filled the form isn't left in the
      // address bar (where it'd be bookmarked, shared or copied).
      try {
        if (/[?&](from|cancelled)=/.test(location.search) && history.replaceState) {
          history.replaceState(null, '', location.pathname + '?package=' + encodeURIComponent(${JSON.stringify(pkg.key)}));
        }
      } catch (e) { /* old browser: the URL just stays */ }
    })();
    (function () {
      var f = document.querySelector('.co-form'), box = document.getElementById('co-preview'), t;
      if (!f || !box || !window.fetch) return;
      var logoData = document.getElementById('f-logo-data'), logoRemove = document.getElementById('f-logo-remove');
      // The logo is shown in the preview from the browser's copy; it isn't
      // sent with every preview request.
      function showLogo() {
        if (logoRemove) logoRemove.hidden = !(logoData && logoData.value);
        var block = box.querySelector('.sponsor-block');
        if (!block) return;
        var img = block.querySelector('.sponsor-logo');
        if (!logoData || !logoData.value) { if (img) img.remove(); return; }
        if (!img) {
          img = document.createElement('img');
          img.className = 'sponsor-logo'; img.alt = 'Your logo';
          block.insertBefore(img, block.querySelector('.sponsor-name') || block.firstChild);
        }
        img.src = logoData.value;
      }
      function refresh() {
        var data = new URLSearchParams(new FormData(f));
        data.delete('logo_data');
        fetch('/advertise/preview', { method: 'POST', body: data })
          .then(function (r) { return r.ok ? r.text() : null; })
          .then(function (html) { if (html !== null) { box.innerHTML = html; showLogo(); } })
          .catch(function () { /* the server-rendered preview stays */ });
      }
      // Shrink the logo in the browser (max 480x240) so it's small to send.
      var logoInput = document.getElementById('f-logo');
      if (logoInput && logoData) {
        logoInput.addEventListener('change', function () {
          var file = logoInput.files && logoInput.files[0];
          if (!file) { logoData.value = ''; showLogo(); return; }
          var reader = new FileReader();
          reader.onload = function () {
            var im = new Image();
            im.onload = function () {
              var s = Math.min(1, 480 / im.width, 240 / im.height);
              var c = document.createElement('canvas');
              c.width = Math.max(1, Math.round(im.width * s)); c.height = Math.max(1, Math.round(im.height * s));
              c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
              logoData.value = c.toDataURL('image/png');
              showLogo();
            };
            im.onerror = function () { logoData.value = ''; alert('That file isn’t an image we can use. Try a PNG or JPG.'); };
            im.src = reader.result;
          };
          reader.readAsDataURL(file);
        });
        if (logoRemove) logoRemove.addEventListener('click', function () {
          logoData.value = ''; logoInput.value = ''; showLogo();
        });
        // Over the server's limit once encoded: drop it rather than lose the
        // whole form to a "too large" error.
        f.addEventListener('submit', function (ev) {
          if (logoData.value.length > ${LOGO_MAX_CHARS}) {
            ev.preventDefault();
            logoData.value = ''; logoInput.value = ''; showLogo();
            alert('That logo is too large. Try a smaller image, or continue without one.');
          }
        });
        showLogo();
      }
      f.addEventListener('input', function () { clearTimeout(t); t = setTimeout(refresh, 350); });
      f.addEventListener('change', refresh);
    })();
    </script>`;
  return layout({
    siteUrl, path: '/advertise/checkout', nav: '/advertise', noindex: true,
    title: `${pkg.name} | ${SITE_NAME}`, description: `Buy ${pkg.name} on ${SITE_NAME}.`, body
  });
}

// Only claims the confirmation email went out once it has (Resend can be
// down or not set up); otherwise it's on its way.
// Stripe usually sends the buyer back before its webhook arrives, so a
// pending order reloads itself for a couple of minutes until it's confirmed.
const THANKS_REFRESH_MS = 2 * 60 * 1000;

export function renderThanksPage(order, { siteUrl, now = new Date() }) {
  const emailed = Boolean(order && order.confirmation_sent);
  let msg = 'We\'re confirming your payment. Stripe will email your receipt in a minute or two.';
  let next = [];
  let refresh = false;
  if (order && order.status === 'pending') {
    const age = now.getTime() - Date.parse(order.created_at);
    if (age < THANKS_REFRESH_MS) {
      refresh = true;
      msg = 'We\'re confirming your payment with Stripe. This page updates on its own in a few seconds.';
    } else {
      msg = 'We haven\'t heard back from Stripe yet. If your payment went through, you\'ll get a confirmation email from us shortly (Stripe sends the receipt). If you didn\'t finish paying, nothing was charged.';
    }
  }
  if (order && LIVE.has(order.status)) {
    if (order.kind === 'weekly') {
      const week = formatDay(order.week_start, { weekday: 'long', month: 'long', day: 'numeric' });
      msg = `You're booked for the week of ${escHtml(week)}.`;
      next = [`Your sponsor block goes live on its own on ${escHtml(week)}, on every page of the site and at the top of that Monday’s newsletter.`,
        `${emailed ? 'We’ve emailed you' : 'We’ll email you'} a confirmation with a copy of your block. Stripe sends your receipt separately.`,
        'Want to change the wording or link before it goes live? Reply to that email.'];
    } else if (order.kind === 'partner') {
      msg = `You're a venue partner. Every event at ${escHtml(order.venue_name)} is now a Vic’s Pick.`;
    } else {
      const day = order.event ? formatDay(order.event.date, { weekday: 'long', month: 'long', day: 'numeric' }) : 'its day';
      msg = `Thanks! ${escHtml(order.event ? order.event.name : 'Your event')} is a Vic’s Pick.`;
      next = ['We check the details and publish it, usually within the hour, and email you when it’s live. If anything needs fixing, we’ll email you.',
        `Then it’s pinned to the top of ${escHtml(day)} with the Vic’s Pick badge, and ${escHtml(pickWhere(order.event && order.event.date, order.paid_at || order.created_at))}.`,
        `${emailed ? 'We’ve emailed you' : 'We’ll email you'} a confirmation. Stripe sends your receipt separately.`];
    }
  } else if (order && order.status === 'processing') {
    msg = 'Your payment is processing (bank payments can take a few days). Your spot is held, and we’ll email you as soon as it clears.';
  } else if (order && order.status === 'conflict') {
    // Two buyers paid for the same week (the first hold lapsed while the
    // other paid). The owner gets a Slack alert to refund or move them.
    msg = 'Your payment went through, but someone else booked that week moments before you. Sorry about that.';
    next = ['We’ll get in touch within 1 business day to move you to another open week or refund you in full, whichever you prefer.',
      'Nothing else is needed from you. If you already know which you’d like, contact us below.'];
  } else if (order && order.status === 'late') {
    // A bank payment that cleared after the date it paid for (webhook).
    msg = 'Your bank payment cleared only after that date had passed, so we couldn’t run it. Sorry about that.';
    next = ['We’re refunding you in full; Stripe shows it within a few business days.',
      'Want another date instead? Contact us below and we’ll set it up.'];
  }
  const steps = next.length ? `<h2 class="section-heading">What happens next</h2><ol class="thanks-steps">${next.map(x => `<li>${x}</li>`).join('')}</ol>` : '';
  const body = `<h1 class="page-title">Thank you</h1><p class="page-lead">${msg}</p>${steps}
    <p>Questions or something not right? <a href="/contact?topic=advertising">Contact us</a> and we’ll sort it out.</p>
    <p><a class="btn btn--primary" href="/">See this week's events</a></p>` +
    (refresh ? `<script>setTimeout(function () { location.reload(); }, 5000);</script>` : '');
  return layout({ siteUrl, path: '/advertise/thanks', nav: '/advertise', noindex: true, title: `Thank you | ${SITE_NAME}`, description: 'Thank you.', body });
}

// The checkout body went over its size limit (server/index.js error
// handler); in practice a logo too big to send.
export function renderLogoTooLargePage({ siteUrl }) {
  const body = `<h1 class="page-title">That logo is too large</h1>
    <p class="page-lead">Your form didn’t go through because the logo file was too big to send. Nothing was charged.</p>
    <p>Go back and pick a smaller image (under 300 KB), or continue without a logo.</p>
    <p><a class="btn btn--primary" href="/advertise/checkout?package=weekly" onclick="if (history.length > 1) { history.back(); return false; }">Back to the form</a></p>`;
  return layout({ siteUrl, path: '/advertise/checkout', nav: '/advertise', noindex: true, title: `Logo too large | ${SITE_NAME}`, description: 'Logo too large.', body });
}

// ─── Wiring ──────────────────────────────────────────────────────────────

export function createSponsors({ store, siteUrl, nowFn, config, stripe, getVenues, slack = null, mailer = null, mailAddress = '', getPayload = null }) {
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

  // Order id -> the shapes its event may be live as (see pickMatches), for
  // live Vic's Picks that came with a submission. Cached with the orders.
  async function pins(list) {
    if (cache && cache.list === list && cache.pins) return cache.pins;
    const out = new Map();
    const picks = list.filter(o => o.kind === 'featured' && o.event && o.submission_id && LIVE.has(o.status));
    if (picks.length) {
      let edits = [];
      try { edits = typeof store.listEventEdits === 'function' ? await store.listEventEdits() : []; } catch { /* none */ }
      const byKey = new Map(edits.map(e => [e.original_key, e.payload]));
      for (const o of picks) {
        try {
          const row = await store.get(o.submission_id);
          if (!row || !row.payload) continue;
          const shapes = [row.payload];
          const edit = byKey.get(eventKeyOf(row.payload));
          if (edit) shapes.push({ ...row.payload, ...edit });
          out.set(o.id, shapes);
        } catch (err) { console.warn('[sponsors] pick submission lookup failed:', err.message); }
      }
    }
    if (cache && cache.list === list) cache.pins = out;
    return out;
  }

  async function apply(payload) {
    try {
      const list = await orders();
      return applyPlacements(payload, list, { now: nowFn(), venues: getVenues(), pins: await pins(list) });
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
        admin_notes: `Paid featured listing (order ${order.id}). The AI review publishes it when it's clean and flags it here otherwise; it's pinned as a Vic’s Pick automatically.`,
        review_history: [{ at: now, action: 'submitted', note: 'Paid featured listing' }]
      };
      await store.insert(row);
      order.submission_id = row.id;
      await save(order);
    }
    await sendConfirmation(order);
    if (slack) {
      const pkg = packageFor(order.kind);
      slack.notify({ channel: 'sales',
        title: `💰 New sponsor: ${order.business}`,
        fields: [['Package', pkg ? pkg.name : order.kind], ['Paid', `$${Math.round((order.amount || 0) / 100)}${order.kind === 'partner' ? '/mo' : ''}`],
          ['Contact', order.email],
          ['Details', order.kind === 'weekly' ? `Week of ${order.week_start}` : order.kind === 'partner' ? order.venue_name : `${order.event.name} (${order.event.date})`]],
        text: order.kind === 'featured'
          ? 'The AI review puts it live when it checks out (usually within the hour); if it flags it, approve it in the Submissions tab. You’ll get a reminder if it’s still not live close to its date.'
          : 'Live automatically.',
        link: `${siteUrl}/admin.html`
      });
    }
  }

  // "You're booked" email: what happens next and how to reach us. Once
  // per order; a send that failed (Resend down) is tried again on the next
  // webhook for the order.
  async function sendConfirmation(order) {
    if (!mailer || !mailer.enabled || (order.kind !== 'weekly' && order.kind !== 'featured') || order.confirmation_sent) return;
    const sent = await mailer.send(order.email, renderSponsorConfirmed(order, { siteUrl, address: mailAddress }), `vic361-sponsor-${order.id}`);
    if (sent) {
      order.confirmation_sent = nowIso();
      await save(order);
    }
  }

  // The end-of-week click report every weekly sponsor is promised. Goes to
  // each paid weekly order whose week ended (from the Monday after), once:
  // the order records report_sent, and Resend's idempotency key covers a
  // retried request. Runs from the Monday newsletter cron (server/index.js
  // onCron) and is safe to call from any daily scheduler too: overlapping
  // or repeated calls send nothing twice. A run that's missed catches up
  // for REPORT_CATCHUP_DAYS.
  let reportRun = null;
  function sendSponsorReports(now = nowFn()) {
    if (!reportRun) reportRun = runSponsorReports(now).finally(() => { reportRun = null; });
    return reportRun;
  }

  async function runSponsorReports(now) {
    const out = { sent: 0, skipped: 0, failed: 0 };
    if (!supported) return out;
    const today = localDateStr(now);
    cache = null;
    const due = (await orders()).filter(o => o.kind === 'weekly' && LIVE.has(o.status) && o.week_start && !o.report_sent &&
      addDays(o.week_start, 7) <= today && addDays(o.week_start, 7 + REPORT_CATCHUP_DAYS) >= today);
    if (!due.length) return out;
    const since = due.map(o => o.week_start).sort()[0];
    const rows = typeof store.listTraffic === 'function' ? await store.listTraffic(since) : [];
    for (const order of due) {
      const stats = sponsorStats(order, rows, { recipients: await recipientsFor(order.week_start) });
      const summary = [['Sponsor', order.business], ['Week', order.week_start], ['Views on the site', stats.views],
        ['Clicked on the site', stats.site_people], ['Clicked in emails', stats.email_people]];
      if (!mailer || !mailer.enabled) {
        // No email service: hand the numbers to the owner once instead.
        if (!order.report_slack_sent && slack) {
          slack.alert(`sponsor-report:${order.id}`, `Send ${order.business} their click report (email is off)`,
            `${summary.map(([k, v]) => `${k}: ${v}`).join('\n')}\nEmail it to ${order.email}. Set RESEND_API_KEY so these go out on their own.`,
            `${siteUrl}/admin.html`);
          await save({ ...order, report: stats, report_slack_sent: nowIso() });
        }
        out.skipped++;
        continue;
      }
      const sent = await mailer.send(order.email, renderSponsorReport(order, stats, { siteUrl, address: mailAddress }), `vic361-sponsor-report-${order.id}`);
      if (!sent) {
        // Tried again on the next run; the owner hears once per order
        // (the 15-minute cron would repeat Slack's 15-minute dedupe).
        out.failed++;
        if (slack && !order.report_failed) {
          slack.alert(`sponsor-report-failed:${order.id}`, `Click report to ${order.business} didn't send`, 'It will be retried on the next run.', `${siteUrl}/admin.html`);
          await save({ ...order, report_failed: nowIso() });
        }
        continue;
      }
      await save({ ...order, report: stats, report_sent: nowIso() });
      out.sent++;
      if (slack) {
        slack.notify({ channel: 'sales', title: `📊 Click report sent: ${order.business}`, fields: [...summary, ['To', order.email]] });
      }
    }
    return out;
  }

  async function newsletterSend(week) {
    try {
      return typeof store.getNewsletterSend === 'function' ? await store.getNewsletterSend(week) : null;
    } catch { return null; } // the report still goes, without the newsletter line
  }

  async function recipientsFor(week) {
    const nl = await newsletterSend(week);
    return nl ? Number(nl.recipients) || 0 : 0;
  }

  // Where a paid pick ran: the live and archived events it matches (by the
  // same rule that pins it, pickMatches), for their page paths, links and
  // last date. The admin may have fixed the date when approving, so the
  // live copy's date wins over the one bought.
  async function pickPlacement(order, list) {
    const p = await pins(list);
    let events = [];
    try { events = ((getPayload && (await getPayload())) || {}).events || []; } catch { /* archive only */ }
    let archived = [];
    try { archived = typeof store.listArchivedEvents === 'function' ? await store.listArchivedEvents() : []; } catch { /* live only */ }
    const hits = [...events, ...archived].filter(ev => ev && ev.page && pickMatches(order, ev, p));
    const dates = [order.event.date, ...hits.map(ev => ev.date)].filter(Boolean).sort();
    return {
      found: hits.length > 0,
      pages: [...new Set(hits.map(ev => ev.page))],
      urls: [...new Set([order.event.url, ...hits.map(ev => ev.url)].filter(Boolean))],
      lastDate: dates[dates.length - 1]
    };
  }

  // The newsletter record notes which paid picks it starred (`picks`);
  // a send from before that was recorded falls back to the promise made
  // at purchase (newsletterCovers).
  async function pickStatsFor(order, list, rows = null) {
    const place = await pickPlacement(order, list);
    const nl = await newsletterSend(currentWeek(place.lastDate)[0]);
    const recipients = nl ? Number(nl.recipients) || 0 : 0;
    const starred = Boolean(nl && recipients) && (Array.isArray(nl.picks)
      ? nl.picks.includes(order.id)
      : newsletterCovers(order.event.date, order.paid_at || order.created_at));
    const start = localDateStr(new Date(order.paid_at || order.created_at || Date.now()));
    if (!rows) rows = typeof store.listTraffic === 'function' ? await store.listTraffic(start) : [];
    return { place, stats: pickStats(order, rows, { start, end: place.lastDate, pages: place.pages, urls: place.urls, recipients, starred }) };
  }

  // Live stats for the admin Sponsors tab's Report button: the same numbers
  // the emails send, so far.
  async function orderReport(order, list) {
    if (order.kind === 'weekly' && order.week_start) {
      const rows = typeof store.listTraffic === 'function' ? await store.listTraffic(order.week_start) : [];
      return { kind: 'weekly', stats: sponsorStats(order, rows, { recipients: await recipientsFor(order.week_start) }) };
    }
    if (order.kind === 'featured' && order.event && order.event.date) {
      const { place, stats } = await pickStatsFor(order, list);
      return { kind: 'featured', on_site: place.found, stats };
    }
    return null;
  }

  // The Vic's Pick report: emailed to each paid pick's buyer the day after
  // its (last) day, once, like sendSponsorReports (report_sent on the
  // order, Resend key vic361-pick-report-<id>, catches up for
  // REPORT_CATCHUP_DAYS). Refunded, hidden and late orders aren't LIVE, so
  // they get none. A pick that never made it onto the site gets no email;
  // the owner hears once (report_skipped). Runs from the submission review
  // cron (every 15 minutes) and the Monday newsletter cron.
  let pickRun = null;
  function sendPickReports(now = nowFn()) {
    if (!pickRun) pickRun = runPickReports(now).finally(() => { pickRun = null; });
    return pickRun;
  }

  async function runPickReports(now) {
    const out = { sent: 0, skipped: 0, failed: 0 };
    if (!supported) return out;
    // The 15-minute cron would otherwise send it just after midnight;
    // counting the day from PICK_REPORT_HOUR sends it in the morning.
    const today = localDateStr(new Date(now.getTime() - PICK_REPORT_HOUR * 3600 * 1000));
    cache = null;
    const list = await orders();
    // Cheap first cut on the date bought; the live date is checked below.
    const due = list.filter(o => o.kind === 'featured' && LIVE.has(o.status) && o.event && o.event.date &&
      !o.report_sent && !o.report_skipped && addDays(o.event.date, 1) <= today &&
      addDays(o.event.date, 1 + REPORT_CATCHUP_DAYS) >= today);
    if (!due.length) return out;
    const since = due.map(o => localDateStr(new Date(o.paid_at || o.created_at || now))).sort()[0];
    const rows = typeof store.listTraffic === 'function' ? await store.listTraffic(since) : [];
    for (const order of due) {
      const { place, stats } = await pickStatsFor(order, list, rows);
      if (addDays(place.lastDate, 1) > today) continue; // re-dated later: not over yet
      if (addDays(place.lastDate, 1 + REPORT_CATCHUP_DAYS) < today) continue;
      const name = order.event.name || 'their event';
      if (!place.found) {
        await save({ ...order, report_skipped: nowIso() });
        out.skipped++;
        if (slack) {
          slack.alert(`pick-report-skipped:${order.id}`, `No Vic's Pick report for ${order.business}: it never went live`,
            `${name} (${order.event.date}) was paid for but never matched a listed event, so there are no numbers to send. Check whether they need a refund.`,
            `${siteUrl}/admin.html`);
        }
        continue;
      }
      const summary = [['Buyer', order.business], ['Event', `${name} (${place.lastDate})`],
        ['Shown in lists', stats.shown], ['Event page views', stats.page_views], ['Clicked their link', stats.link_people],
        ['Added to calendar', stats.calendar_adds], ['Shares', stats.shares],
        ['Newsletter', stats.newsletter_starred ? `Starred, sent to ${stats.newsletter_recipients}` : 'Not in it']];
      if (!mailer || !mailer.enabled) {
        if (!order.report_slack_sent && slack) {
          slack.alert(`pick-report:${order.id}`, `Send ${order.business} their Vic's Pick report (email is off)`,
            `${summary.map(([k, v]) => `${k}: ${v}`).join('\n')}\nEmail it to ${order.email}. Set RESEND_API_KEY so these go out on their own.`,
            `${siteUrl}/admin.html`);
          await save({ ...order, report: stats, report_slack_sent: nowIso() });
        }
        out.skipped++;
        continue;
      }
      const sent = await mailer.send(order.email, renderPickReport(order, stats, { siteUrl, address: mailAddress }), `vic361-pick-report-${order.id}`);
      if (!sent) {
        out.failed++;
        if (slack && !order.report_failed) {
          slack.alert(`pick-report-failed:${order.id}`, `Vic's Pick report to ${order.business} didn't send`, 'It will be retried on the next run.', `${siteUrl}/admin.html`);
          await save({ ...order, report_failed: nowIso() });
        }
        continue;
      }
      await save({ ...order, report: stats, report_sent: nowIso() });
      out.sent++;
      if (slack) slack.notify({ channel: 'sales', title: `📊 Vic's Pick report sent: ${order.business}`, fields: [...summary, ['To', order.email]] });
    }
    return out;
  }

  // A checkout that never got paid doesn't keep its uploaded logo.
  async function dropLogo(order) {
    if (!order || !order.sponsor || !order.sponsor.logo || typeof store.deleteSponsorLogo !== 'function') return;
    try { await store.deleteSponsorLogo(order.id); } catch (err) { console.warn('[sponsors] logo delete failed:', err.message); }
  }

  // Served only while the order is live, settling or being paid for right
  // now (the confirmation email and the hold's own preview), never once
  // it's hidden, refunded, expired or abandoned.
  function logoServed(o, nowMs) {
    return Boolean(o) && (LIVE.has(o.status) || o.status === 'processing' || isHold(o, nowMs));
  }

  // Why a hidden order can't be put back: its day or week was sold while it
  // was hidden. Empty when it fits.
  function restoreConflict(order, list, now) {
    const others = list.filter(o => o.id !== order.id);
    if (order.kind === 'featured' && order.event) {
      const a = pickAvailability(order.event.date, others, now);
      if (!a.left) return `${formatDay(order.event.date, { weekday: 'long', month: 'short', day: 'numeric' })} already has its ${a.cap} Vic’s Picks (one was sold while this was hidden). Refund this one in Stripe, or hide another first.`;
    }
    if (order.kind === 'weekly') {
      const nowMs = now.getTime();
      const taken = others.some(o => o.kind === 'weekly' && o.week_start === order.week_start &&
        (o.status === 'paid' || o.status === 'processing' || isHold(o, nowMs)));
      if (taken) return `The week of ${order.week_start} was sold to someone else while this was hidden. Refund this one in Stripe, or move it to another week (Edit).`;
    }
    return '';
  }

  // Admin edit of a weekly sponsor: the same checks as the checkout form
  // (validateOrder), for the fields sent. Moving to another week must land
  // on an open one; a double-booked ('conflict') order moved to an open
  // week goes live like any paid order. Run under the booking lock.
  async function editWeekly(order, input) {
    cache = null;
    const list = await store.listSponsorOrders();
    const current = list.find(o => o.id === order.id) || order;
    const s = current.sponsor || {};
    const has = k => typeof input[k] === 'string';
    const errors = {};
    const business = has('business') ? clean(input.business, 80) : current.business;
    if (!business) errors.business = 'Business name is required.';
    const text = has('text') ? clean(input.text, 160) : s.text;
    if (!text) errors.text = 'Add one or two sentences about the business.';
    const cta = has('cta') ? (clean(input.cta, 24) || 'Learn more') : (s.cta || 'Learn more');
    const url = has('url') ? safeUrl(normalizeUrl(clean(input.url, 300))) : s.url;
    if (!url) errors.url = 'Enter a website or page (e.g. example.com).';
    const address = has('address') ? clean(input.address, 120) : (s.address || '');
    let week = current.week_start;
    if (has('week') && input.week && input.week !== current.week_start) {
      const w = bookableWeeks(nowFn(), list.filter(o => o.id !== current.id)).find(x => x.start === input.week);
      if (!w) errors.week = 'Pick one of the next 8 weeks.';
      else if (!w.available) errors.week = `The week of ${w.label} is already booked.`;
      else week = w.start;
    }
    let logo = null;
    if (has('logo_data') && input.logo_data) {
      logo = parseLogo(input.logo_data);
      if (logo.error) errors.logo = logo.error;
    }
    if (Object.keys(errors).length) return { errors };
    const sponsor = { ...s, name: business, text, cta, url, address };
    if (logo && typeof store.saveSponsorLogo === 'function') {
      await store.saveSponsorLogo(current.id, logo);
      sponsor.logo = `/sponsor-logo/${current.id}`;
    }
    const moved = current.status === 'conflict' && week !== current.week_start;
    const next = { ...current, business, sponsor, week_start: week, ...(moved ? { status: 'paid' } : {}) };
    await save(next);
    return { order: next, moved };
  }

  // Best effort: close a released hold's Stripe session so it can't be paid
  // later. If this fails it expires on its own in 30 minutes, and a late
  // payment is still honored (see the webhook).
  async function expireSession(o) {
    if (!o.session_id || typeof stripe.expireCheckoutSession !== 'function') return;
    try { await stripe.expireCheckoutSession(o.session_id); } catch (err) { console.warn('[sponsors] session expire failed:', err.message); }
  }

  // The form fields of an order, to refill the form when the buyer backs
  // out of Stripe (cancel_url).
  function orderValues(o) {
    const s = o.sponsor || {};
    const ev = o.event || {};
    return o.kind === 'weekly'
      ? { week: o.week_start, business: o.business, text: s.text, url: s.url, cta: s.cta, address: s.address, email: o.email }
      : { event_name: ev.name, date: ev.date, time: ev.time, venue: ev.venue, address: ev.address, description: ev.description,
        url: ev.url, business: o.business, email: o.email };
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
          else await sendConfirmation(order);
          return;
        }
        // 'cancelled': the buyer came back via cancel_url but paid anyway
        // (another tab) before the session could be expired.
        if (!['pending', 'expired', 'failed', 'processing', 'cancelled'].includes(order.status) ||
            (order.status === 'cancelled' && order.paid_at)) return;
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
        // Settled after the date it paid for: nothing left to run, so no
        // submission and no "you're booked". The owner refunds in Stripe
        // (the restricted key can't); the buyer is told so.
        if (paidTooLate(order, nowFn())) {
          order.status = 'late';
          await save(order);
          await dropLogo(order);
          if (slack) {
            slack.alert(`sponsor-late:${order.id}`, `Refund ${order.business}: payment cleared after its date`,
              `${order.business} (${order.email}) paid $${Math.round((order.amount || 0) / 100)} by bank for ${order.kind === 'weekly' ? `the week of ${order.week_start}` : `${order.event.name} (${order.event.date})`}, but it only cleared now. Nothing went live; they've been told they'll be refunded in full. Refund it in Stripe${order.payment_intent ? ` (${order.payment_intent})` : ''}.`,
              'https://dashboard.stripe.com/payments');
          }
          if (mailer && mailer.enabled) {
            await mailer.send(order.email, renderSponsorTooLate(order, { siteUrl, address: mailAddress }), `vic361-sponsor-late-${order.id}`);
          }
          return;
        }
        // Someone else already paid for this week (e.g. this hold lapsed
        // first). Keep the money traceable and ask for a refund, but don't
        // put two sponsors in one slot.
        if (order.kind === 'weekly' && list.some(o => o.id !== order.id && o.kind === 'weekly' &&
            o.week_start === order.week_start && LIVE.has(o.status))) {
          order.status = 'conflict';
          await save(order);
          if (slack) {
            slack.alert(`sponsor-conflict:${order.id}`, `Week of ${order.week_start} was paid for twice`,
              `${order.business} (${order.email}) paid for a week that's already sold. They've been told you'll be in touch within 1 business day: move them to an open week (Sponsors tab, Edit) or refund them in Stripe.`,
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
        await dropLogo(order);
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
        if (!order || !(order.status === 'pending' || (order.status === 'cancelled' && !order.paid_at))) return;
        if (order.status === 'pending') await save({ ...order, status: 'expired' });
        await dropLogo(order);
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

  function registerRoutes(app, { requireAdmin, createRateLimiter, sendHtml, verifyHuman = async () => true, analyticsSecret = '' }) {
    const limiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20 });

    // The weekly sponsor's button in our emails (server/newsletter.js
    // sponsorHref): count the click for the sponsor's report, then send the
    // reader to the sponsor with UTM tags. Recorded as a Traffic sponsor_click
    // (path /go/s/<week>) with the same daily visitor hash as the beacon.
    // Known bots and HEAD requests (link checkers) aren't counted.
    const goLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30 });
    app.get('/go/s/:week', async (req, res, next) => {
      try {
        const week = /^\d{4}-\d{2}-\d{2}$/.test(req.params.week) ? req.params.week : '';
        const order = week ? (await orders()).find(o => o.kind === 'weekly' && o.week_start === week && LIVE.has(o.status)) : null;
        const src = req.query.src === 'welcome' ? 'welcome' : 'newsletter';
        const target = order ? sponsorLandingUrl(order.sponsor && order.sponsor.url, { medium: 'email', campaign: src }) : '';
        res.set('Cache-Control', 'no-store');
        if (!target) return res.redirect(302, siteUrl);
        const ip = req.ip || req.socket.remoteAddress || '';
        const ua = req.get('user-agent') || '';
        if (req.method === 'GET' && !botName(ua) && typeof store.recordTraffic === 'function' && goLimiter.check(ip).ok) {
          const day = localDateStr(nowFn());
          store.recordTraffic({
            day, kind: 'click', path: `/go/s/${week}`, visitor: visitorHash(ip, ua, day, analyticsSecret),
            click_type: 'sponsor_click', click_url: String(order.sponsor.url || '').slice(0, 300)
          }).catch(err => console.warn('[sponsors] click record failed:', err.message));
        }
        res.redirect(302, target);
      } catch (err) { next(err); }
    });

    app.get('/advertise/checkout', async (req, res, next) => {
      try {
        const pkg = packageFor(req.query.package);
        if (!config.enabled || !pkg) return res.redirect(302, '/advertise');
        // Prefill from the query; only the form's own event fields are taken.
        // Contact details never ride in the URL (analytics and the Pixel see
        // page URLs): the submit form and its emails link with `from=<the
        // submission's id>` (a random UUID) and the server fills them in.
        // That id lives in forwardable emails, so the submitter's name and
        // email are only filled in while the submission is still waiting
        // for review and under a week old; the event fields (already public
        // once it's listed) always are. The page then drops the id from the
        // address bar (history.replaceState in renderCheckoutPage), and the
        // Pixel and Google tag leave it out of the URLs they report.
        const PREFILL = ['event_name', 'date', 'time', 'venue', 'address', 'description', 'url'];
        let values = Object.fromEntries(PREFILL.filter(k => typeof req.query[k] === 'string').map(k => [k, req.query[k].slice(0, 2000)]));
        const from = typeof req.query.from === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.from) ? req.query.from : '';
        const sub = from && typeof store.get === 'function' ? await store.get(from).catch(() => null) : null;
        if (sub && (sub.source || 'submission') === 'submission') {
          const p = sub.payload || {};
          const fresh = sub.status === 'pending' && nowFn().getTime() - Date.parse(sub.created_at) < PREFILL_CONTACT_MS;
          for (const [k, v] of [['event_name', p.name], ['date', p.date], ['time', p.time], ['venue', p.venue], ['address', p.address],
            ['description', p.description], ['url', p.url], ...(fresh ? [['business', sub.submitter_name], ['email', sub.submitter_email]] : [])]) {
            if (v) values[k] = String(v).slice(0, 2000);
          }
        }
        // Back from Stripe without paying (cancel_url): release their hold
        // so trying again isn't blocked by it, and refill the form.
        if (typeof req.query.cancelled === 'string' && req.query.cancelled) {
          const left = await withBookingLock(async () => {
            cache = null;
            const o = (await orders()).find(x => x.id === req.query.cancelled && x.status === 'pending');
            if (o) await save({ ...o, status: 'cancelled' });
            return o || null;
          });
          if (left) {
            await expireSession(left);
            values = { ...orderValues(left), ...values };
          }
        }
        sendHtml(res, renderCheckoutPage(pkg, { siteUrl, now: nowFn(), orders: await orders(), venues: getVenues(), values }), 200, 'no-store');
      } catch (err) { next(err); }
    });

    const previewLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 600 });
    app.post('/advertise/preview', async (req, res, next) => {
      try {
        const body = req.body || {};
        const pkg = packageFor(body.package);
        if (!pkg) return res.status(400).type('text/plain').send('Unknown package');
        if (!previewLimiter.check(req.ip || req.socket.remoteAddress).ok) return res.status(429).type('text/plain').send('Slow down');
        res.set('Cache-Control', 'no-store').type('html')
          .send(renderPreview(pkg.key, body, { now: nowFn(), orders: await orders(), venues: getVenues() }));
      } catch (err) { next(err); }
    });

    // Short cache, so a logo the admin removes (or a hidden or refunded
    // order's) stops showing within the hour.
    app.get('/sponsor-logo/:id', async (req, res, next) => {
      try {
        const path = `/sponsor-logo/${req.params.id}`;
        if (!LOGO_PATH.test(path) || typeof store.getSponsorLogo !== 'function') return res.status(404).end();
        const order = (await orders()).find(o => o.id === req.params.id);
        if (!logoServed(order, nowFn().getTime())) return res.status(404).end();
        const logo = await store.getSponsorLogo(req.params.id);
        if (!logo) return res.status(404).end();
        res.set({ 'Content-Type': logo.contentType, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' })
          .send(Buffer.from(logo.data));
      } catch (err) { next(err); }
    });

    // Open Vic’s Pick spots and the price for a date (the checkout preview
    // and anyone wiring a calendar can use it).
    app.get('/api/vics-pick/availability', async (req, res, next) => {
      try {
        const date = String(req.query.date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: 'date=YYYY-MM-DD required' });
        res.set('Cache-Control', 'no-store').json({ ok: true, ...pickAvailability(date, await orders(), nowFn()) });
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
          const priced = pkg.key === 'featured' ? pickPackage(v.order.event.date) : pkg;
          const { logo, ...fields } = v.order;
          const o = { ...fields, id: newId(), status: 'pending', amount: priced.amount, created_at: nowFn().toISOString() };
          if (logo && typeof store.saveSponsorLogo === 'function') {
            await store.saveSponsorLogo(o.id, logo);
            o.sponsor = { ...o.sponsor, logo: `/sponsor-logo/${o.id}` };
          }
          // The buyer's own earlier hold on this slot didn't count against
          // them (validateOrder); it's replaced, so one buyer can't hold two.
          const replaced = ctx.orders.filter(x => x.email === o.email && x.kind === o.kind && x.status === 'pending' &&
            (o.kind === 'weekly' ? x.week_start === o.week_start : x.event && x.event.date === o.event.date));
          for (const x of replaced) await save({ ...x, status: 'cancelled' });
          await save(o);
          return { order: o, replaced };
        });
        if (booked.errors) return fail(booked.errors);
        for (const x of booked.replaced) await expireSession(x);
        const order = booked.order;
        // A Vic’s Pick's price depends on its day (weekday vs Fri–Sun).
        const priced = pkg.key === 'featured' ? pickPackage(order.event.date) : pkg;
        let lineItem = {
          quantity: 1,
          price_data: {
            currency: 'usd', unit_amount: priced.amount,
            product_data: { name: `${SITE_NAME}: ${priced.name}` },
            recurring: pkg.interval ? { interval: pkg.interval } : undefined
          }
        };
        // Catalog price when we can get one; inline price_data otherwise, so
        // a catalog hiccup never blocks a sale.
        if (typeof stripe.ensurePrice === 'function') {
          try {
            lineItem = { quantity: 1, price: await stripe.ensurePrice(priced) };
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
            // as "processing" until they settle; see the webhook. Within a
            // few days of the date, cards only (`instantOnly`): a bank debit
            // could settle after it.
            ...(!pkg.interval && instantOnly(order, nowFn()) ? { payment_method_types: ['card'] } : {}),
            integration_identifier: INTEGRATION_ID,
            customer_email: order.email,
            client_reference_id: order.id,
            line_items: [lineItem],
            metadata: { order_id: order.id, package: pkg.key },
            subscription_data: pkg.interval ? { metadata: { order_id: order.id } } : undefined,
            expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_TTL_S,
            success_url: `${siteUrl}/advertise/thanks?order=${order.id}`,
            cancel_url: `${siteUrl}/advertise/checkout?package=${pkg.key}&cancelled=${order.id}`
          }, `vic361-order-${order.id}`);
        } catch (err) {
          console.error('[sponsors] checkout session failed:', err.message);
          if (slack) slack.alert('stripe-checkout', 'Sponsor checkout is failing', `Stripe: ${err.message}`);
          await save({ ...order, status: 'failed' }); // release the hold
          await dropLogo(order);
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
        sendHtml(res, renderThanksPage(order, { siteUrl, now: nowFn() }), 200, 'no-store');
      } catch (err) { next(err); }
    });

    app.get('/api/admin/sponsors', requireAdmin, async (req, res, next) => {
      try {
        cache = null;
        // Read the store directly: orders() falls back to an empty list on a
        // database error, which would look like "no orders".
        const list = supported ? await store.listSponsorOrders() : [];
        cache = { at: Date.now(), list };
        // Live Vic's Picks for today or later: is the pin finding its event?
        // (on_site false: not approved yet, rejected, or edited past matching.)
        let onSite = () => undefined;
        if (getPayload) {
          try {
            const events = ((await getPayload()) || {}).events || [];
            const p = await pins(list);
            const today = localDateStr(nowFn());
            onSite = o => (o.kind === 'featured' && o.event && LIVE.has(o.status) && o.event.date >= today
              ? events.some(ev => pickMatches(o, ev, p)) : undefined);
          } catch (err) { console.warn('[sponsors] on-site check failed:', err.message); }
        }
        res.json({
          ok: true,
          configured: config.enabled,
          supported,
          orders: list.filter(o => o.status !== 'expired' && o.status !== 'failed' && !(o.status === 'cancelled' && !o.paid_at) &&
            !(o.status === 'pending' && nowFn().getTime() - Date.parse(o.created_at) > 24 * 3600 * 1000))
            .map(o => { const s = onSite(o); return s === undefined ? o : { ...o, on_site: s }; }),
          weeks: bookableWeeks(nowFn(), list),
          calendar: sponsorCalendar(nowFn(), list)
        });
      } catch (err) { next(err); }
    });

    // Live report numbers for a paid weekly or Vic's Pick order (the
    // Sponsors tab's Report button): what its email says, so far.
    app.get('/api/admin/sponsors/:id/report', requireAdmin, async (req, res, next) => {
      try {
        cache = null;
        const list = supported ? await store.listSponsorOrders() : [];
        const order = list.find(o => o.id === req.params.id);
        if (!order) return res.status(404).json({ ok: false, error: 'not-found' });
        const report = await orderReport(order, list);
        if (!report) return res.status(400).json({ ok: false, error: 'no-report', message: 'Reports are for weekly sponsors and Vic’s Picks.' });
        res.json({ ok: true, ...report, report_sent: order.report_sent || null });
      } catch (err) { next(err); }
    });

    // The uploaded logo, whatever the order's status, for the Sponsors tab.
    app.get('/api/admin/sponsors/:id/logo', requireAdmin, async (req, res, next) => {
      try {
        const logo = typeof store.getSponsorLogo === 'function' ? await store.getSponsorLogo(req.params.id) : null;
        if (!logo) return res.status(404).json({ ok: false, error: 'not-found' });
        res.set({ 'Content-Type': logo.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
          .send(Buffer.from(logo.data));
      } catch (err) { next(err); }
    });

    // Hide pulls a placement (refund, bad copy); restore puts it back, unless
    // its day or week was sold meanwhile. Remove-logo deletes the uploaded
    // logo and keeps the rest of the placement. Edit changes a weekly
    // sponsor's wording, link, logo or week (sponsors are told to reply
    // with changes; a double-booked one can be moved to an open week).
    app.post('/api/admin/sponsors/:id', requireAdmin, async (req, res, next) => {
      try {
        const action = req.body && req.body.action;
        cache = null;
        const list = supported ? await store.listSponsorOrders() : [];
        const order = list.find(o => o.id === req.params.id);
        if (!order) return res.status(404).json({ ok: false, error: 'not-found' });
        if (action === 'hide' && LIVE.has(order.status)) {
          await save({ ...order, status: 'hidden', hidden_from: order.status });
        } else if (action === 'restore' && order.status === 'hidden') {
          const status = order.hidden_from || 'paid';
          const conflict = LIVE.has(status) ? restoreConflict(order, list, nowFn()) : '';
          if (conflict) return res.status(409).json({ ok: false, error: 'slot-taken', message: conflict });
          await save({ ...order, status, hidden_from: null });
        } else if (action === 'remove-logo' && order.sponsor && order.sponsor.logo) {
          if (typeof store.deleteSponsorLogo === 'function') await store.deleteSponsorLogo(order.id);
          const { logo: _gone, ...sponsor } = order.sponsor;
          await save({ ...order, sponsor });
        } else if (action === 'edit' && order.kind === 'weekly' && EDITABLE.has(order.status)) {
          const out = await withBookingLock(() => editWeekly(order, req.body || {}));
          if (out.errors) return res.status(400).json({ ok: false, error: 'invalid', errors: out.errors, message: Object.values(out.errors).join(' ') });
          if (out.moved) await sendConfirmation(out.order); // a double-booked sponsor's first confirmation
        } else {
          return res.status(400).json({ ok: false, error: 'bad-action' });
        }
        res.json({ ok: true });
      } catch (err) { next(err); }
    });
  }

  return { apply, orders, registerWebhook, registerRoutes, processEvent, sendSponsorReports, sendPickReports };
}
