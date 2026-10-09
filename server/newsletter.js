/* server/newsletter.js — Own email newsletter, sent through Resend.
 *
 * The homepage signup form always shows. Signups are single opt-in: a new
 * address goes straight on the list and, once RESEND_API_KEY is set, gets
 * the welcome email right away.
 *
 *   - Signup: POST /api/subscribe → active subscriber + welcome email. Only
 *     a comeback (someone who unsubscribed) gets a confirmation email
 *     instead, so nobody else can sign them back up. Forms say where
 *     they are (`source`); docs/track.js adds ":ad" for visitors who
 *     arrived from a paid ad, so the Slack ping shows what's working.
 *   - GET /subscribe is the signup page every Subscribe button points at
 *     (and where ads should land): the pitch, the form, and a taste of
 *     this week's events.
 *     The answer is the same whether the address is new, waiting or already
 *     subscribed, and confirmation emails are capped per address.
 *   - GET /subscribe/confirm?token=… and /unsubscribe?token=… only show a
 *     one-button page (mail link scanners open every link); the POST
 *     confirms or removes. POST /unsubscribe is also the RFC 8058 one-click
 *     target mail clients use.
 *   - Two issues a week, built from the published events (sponsor block
 *     first, featured first; links back to the site carry
 *     utm_source=newsletter) and sent with Resend's batch API, each copy
 *     with its own unsubscribe link:
 *       weekly   Monday 7:43 AM Central: the rest of the week. Keyed by the
 *                week's Monday (newsletter_sends.week_key).
 *       weekend  Thursday 7:00 AM: Friday through Sunday. Keyed by the
 *                week's Thursday, so it's its own send, open count and row
 *                in the admin. Readers can turn it off and keep Monday's
 *                (/email-prefs, `weekend_optout`); NEWSLETTER_WEEKEND=0 in
 *                Railway stops it for everyone.
 *     One send per issue: a second attempt is refused unless forced.
 *   - Referrals: every subscriber gets a link, /r/<code> (→ /subscribe?ref=,
 *     kept for the visit by docs/track.js and sent with the form). A new
 *     signup through it records referred_by and must be confirmed by email; it
 *     counts for the sharer once the friend has been on the list a day and
 *     while they stay subscribed, one per inbox (see emailKey in db.js).
 *     The welcome email and each Monday copy show the reader's link and
 *     progress (REFERRAL_TIERS); Monday's send Slacks the owner who just
 *     earned a reward, once per tier (rewards go out by hand).
 *   - Open tracking: each weekly copy has a 1x1 image,
 *     /email/o/<week>/<subscriber id>.gif, counted once per subscriber per
 *     issue (email_opens) and shown as opens and open rate per send in the
 *     admin. Welcome, confirmation and test emails have none.
 *   - Admin: counts, preview, test send, send now, CSV/paste import.
 *   - Automation: the site's scheduler (server/scheduler.js) sends both
 *     issues. POST /api/newsletter/cron with X-Cron-Secret is the Monday
 *     fallback, called by .github/workflows/newsletter.yml. Monday's run
 *     also sends last week's sponsor reports and any Vic's Pick reports due
 *     (onCron, server/sponsors.js).
 */

import crypto from 'node:crypto';
import { emailKey } from './db.js';
import { REFERRAL_TIERS, DRAWING_AMOUNT, referralFlags, createReferralRewards } from './referralRewards.js';

export { REFERRAL_TIERS, referralFlags };
import { inboundConfig } from './inbound.js';
import {
  SITE_NAME, escHtml, safeUrl, localDateStr, currentWeek, formatDay, sortEvents, layout, addDays, renderEventItem, pickRank, parseTimes,
  sponsorLinkUrl, formatTime, placeText, iconKeys, isSponsorLogo, SAMPLE_LOGO
} from './seo.js';

const RESEND_API = 'https://api.resend.com';
// Strict enough that Resend accepts every address we keep: no empty dot
// segments ("bob@gmail..com", ".bob@"), domain labels of letters, digits
// and inner hyphens, and a real TLD. Matched after lowercasing.
const EMAIL_RE = /^[^\s@<>"',;.]+(?:\.[^\s@<>"',;.]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const BATCH_SIZE = 100;          // Resend batch limit
const PER_DAY = 6;               // events per day in the email

export function newsletterConfig(env = process.env, overrides = {}) {
  const c = {
    apiKey: overrides.resendApiKey ?? env.RESEND_API_KEY ?? '',
    from: overrides.newsletterFrom ?? env.NEWSLETTER_FROM ?? 'The Vic 361 <news@thevic361.com>',
    replyTo: overrides.newsletterReplyTo ?? env.NEWSLETTER_REPLY_TO ?? '',
    address: overrides.newsletterAddress ?? env.NEWSLETTER_ADDRESS ?? '',
    cronSecret: overrides.newsletterCronSecret ?? env.NEWSLETTER_CRON_SECRET ?? '',
    testTo: overrides.newsletterTestTo ?? env.NEWSLETTER_TEST_TO ?? '',
    // Replies to news@ reach Slack (server/inbound.js) once receiving is set up.
    inbound: inboundConfig(env, overrides).enabled
  };
  c.enabled = Boolean(c.apiKey);
  // The one switch for the automatic Monday send (Railway variable): on
  // unless NEWSLETTER_AUTOSEND=0. The site's scheduler (server/scheduler.js)
  // sends at 7:43 AM Central; newsletter.yml's late GitHub cron is only a
  // fallback and is told no when this is off.
  c.autosend = String(overrides.newsletterAutosend ?? env.NEWSLETTER_AUTOSEND ?? '1') !== '0';
  // The Thursday weekend issue: on unless NEWSLETTER_WEEKEND=0.
  c.weekend = String(overrides.newsletterWeekend ?? env.NEWSLETTER_WEEKEND ?? '1') !== '0';
  return c;
}

// The two issues. key: the send's id (newsletter_sends.week_key), the
// week's Monday or Thursday; days: the dates the issue lists.
export const EDITIONS = {
  weekly: { key: today => currentWeek(today)[0], days: today => currentWeek(today).filter(d => d >= today) },
  weekend: { key: today => currentWeek(today)[3], days: today => currentWeek(today).slice(4).filter(d => d >= today) }
};
// Which issue a send was, from its key's weekday (Thursday is the weekend one).
export function editionOf(weekKey) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(weekKey || '')) && new Date(`${weekKey}T12:00:00Z`).getUTCDay() === 4 ? 'weekend' : 'weekly';
}
// How the newsletter is described in its pages and emails. Copy elsewhere
// (seo.js pages, docs/app.js, social captions, sponsor promises) says the
// same in its own words. NEWSLETTER_WEEKEND=0 is a stopgap switch: it
// stops the Thursday send and its settings link, not this wording.
export const SCHEDULE = 'every Monday and Thursday';

export function normalizeEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

// "j•••@gmail.com": enough for someone to recognize their own address.
export function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!user || !domain) return '';
  return `${user[0]}•••@${domain}`;
}

export function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// ─── Resend client ───────────────────────────────────────────────────────

// Resend calls give up after RESEND_TIMEOUT_MS. Without it a Resend that
// accepts the connection and never answers holds the caller for undici's
// 5-minute default: the sponsor confirmation, the reports and the weekly
// batch all wait on it, and so would anything queued behind them.
export const RESEND_TIMEOUT_MS = 15000;

export function createResend(apiKey, fetchImpl = globalThis.fetch, { timeoutMs = RESEND_TIMEOUT_MS } = {}) {
  async function call(path, body, idempotencyKey, extraHeaders = {}) {
    // One signal for the request and the body read below.
    const res = await fetchImpl(`${RESEND_API}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        ...extraHeaders
      },
      body: JSON.stringify(body)
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error(`Resend ${path} HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
      err.status = res.status;
      // Resend's error name ("invalid_idempotent_request"...), for callers
      // that branch on more than the status.
      if (json && typeof json.name === 'string') err.code = json.name;
      throw err;
    }
    return json;
  }
  return {
    send: (msg, key) => call('/emails', msg, key),
    // Batch validation is strict by default: one address Resend refuses
    // fails all 100 messages. Permissive sends the rest and lists the
    // refused ones in `errors` ({ index, message }).
    batch: (msgs, key) => call('/emails/batch', msgs, key, { 'x-batch-validation': 'permissive' })
  };
}

// ─── Email content ───────────────────────────────────────────────────────

// Same cartoon identity as the site (docs/style.css): ink outlines, sticker
// colors, rounded type. Email clients can't load icons.svg or web fonts
// reliably, so icons and the skyline are PNGs in docs/email/ and the font
// stack falls back to rounded system faces.
export const C = {
  bg: '#FFF4D6', card: '#FFFFFF', ink: '#1F1A3D', muted: '#554E7A', accent: '#4B3FD1',
  line: '#E8D9AE', sun: '#FFC93C', sunLight: '#FFF0BF', sunset: '#FF7A3D', navy: '#2B2370', sky: '#DDF2FF'
};
const DAY_COLORS = ['#FFC93C', '#8FD3FF', '#FF8FC0', '#3DBE8B', '#FF7A3D', '#B9A6FF', '#FF8A80'];
const ICON_KEYS = new Set(['food', 'music', 'family', 'drinks', 'arts', 'shopping', 'outdoors', 'community', 'free']);
const DISPLAY = "'Fredoka','Baloo 2','Trebuchet MS',Arial,sans-serif";
const BODY = "'Nunito','Helvetica Neue',Arial,sans-serif";
// "+N more" links: a small ink-outlined pill, like the site's chips.
const MORE_PILL = `display:inline-block;font-family:${DISPLAY};font-weight:bold;font-size:14px;color:${C.ink};border:2px solid ${C.ink};border-radius:999px;box-shadow:2px 2px 0 ${C.ink};padding:5px 14px;text-decoration:none;`;
export const btn = (href, label) => `<a href="${escHtml(href)}" style="display:inline-block;background:${C.accent};color:#fff;font-family:${DISPLAY};font-weight:bold;font-size:16px;padding:11px 22px;border:3px solid ${C.ink};border-radius:999px;box-shadow:3px 3px 0 ${C.ink};text-decoration:none;">${escHtml(label)}</a>`;

// ─── Dark mode ───────────────────────────────────────────────────────────
// Email apps decide how a message looks in dark mode, and they disagree:
//   - Apple Mail honors color-scheme "light only" and leaves it alone.
//   - Outlook (web, new Mac/Windows, phone) recolors anyway, but it never
//     recolors background *images*, and it marks what it recolored with
//     data-ogsc (text) / data-ogsb (background), which a <style> can target.
//   - Classic Outlook for Windows inverts everything; Gmail's apps recolor
//     too. Nothing reliable stops them, so the design has to read well
//     inverted (solid backgrounds, dark outlines, no mid-tone text).
// darkSafe() runs over the finished HTML: every inline background color is
// also painted as a one-color gradient (an image to Outlook), and every
// colored element gets a class the Outlook rules use to put its colors back.
const colorKey = c => c.slice(1).toLowerCase();

export function darkSafe(html) {
  const bgs = new Set(), texts = new Set();
  const body = html.replace(/<(table|td|div|span|a|p|body)\b([^>]*?)\sstyle="([^"]*)"([^>]*)>/gi, (tag, name, before, style, after) => {
    const classes = [];
    let bgHex = null;
    style = style.replace(/(^|;)\s*background(?:-color)?\s*:\s*(#[0-9a-f]{3,6})\s*(?=;|$)/i, (m, sep, hex) => {
      bgHex = hex;
      bgs.add(colorKey(hex));
      classes.push(`b-${colorKey(hex)}`);
      return `${sep}background-color:${hex};background-image:linear-gradient(${hex},${hex})`;
    });
    const fg = /(^|;)\s*color\s*:\s*(#[0-9a-f]{3,6})/i.exec(style);
    if (fg) { texts.add(colorKey(fg[2])); classes.push(`t-${colorKey(fg[2])}`); }
    if (!classes.length) return tag;
    let attrs = `${before}${after}`;
    // Classic Outlook for Windows reads the old bgcolor attribute.
    const bgcolor = bgHex && /^(table|td|body)$/i.test(name) && !/\bbgcolor=/i.test(attrs) ? ` bgcolor="${bgHex}"` : '';
    if (/\bclass="/i.test(attrs)) attrs = attrs.replace(/\bclass="([^"]*)"/i, (m, c) => `class="${c} ${classes.join(' ')}"`);
    else attrs += ` class="${classes.join(' ')}"`;
    return `<${name}${attrs}${bgcolor} style="${style}">`;
  });
  const rules = [
    // Outlook marks the recolored element itself or a wrapper; cover both.
    ...[...bgs].map(k => `[data-ogsb].b-${k},[data-ogsb] .b-${k}{background-color:#${k} !important;background-image:linear-gradient(#${k},#${k}) !important}`),
    ...[...texts].map(k => `[data-ogsc].t-${k},[data-ogsc] .t-${k}{color:#${k} !important}`)
  ];
  // Two blocks: Gmail drops a whole <style> it doesn't understand, and the
  // Outlook attribute selectors are the part it might not.
  const head = `<style>:root{color-scheme:light only;supported-color-schemes:light only}</style>\n<style>${rules.join('\n')}</style>`;
  return body.replace('</head>', () => `${head}</head>`);
}

// Invisible spacers after the preheader, so inbox previews (Gmail, iOS)
// stop at the preheader instead of running on into the header text.
const PREHEADER_FILLER = '&#847;&zwnj;&nbsp;'.repeat(80);

export function emailShell({ title, preheader, bodyHtml, footerHtml, siteUrl, pixelUrl = '' }) {
  return darkSafe(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"><title>${escHtml(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@600;700&family=Nunito:wght@400;700;800&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:${C.bg};">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escHtml(preheader || '')}${PREHEADER_FILLER}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.card};border:3px solid ${C.ink};border-radius:20px;box-shadow:6px 6px 0 ${C.ink};overflow:hidden;">
<tr><td align="center" style="background:${C.sky};padding:22px 24px 0;font-family:${DISPLAY};color:${C.ink};">
<div><span style="font-size:22px;font-weight:bold;">The Vic</span> <span style="display:inline-block;font-size:18px;font-weight:bold;background:${C.sun};border:3px solid ${C.ink};border-radius:8px;padding:0 6px;">361</span></div>
<div style="font-size:30px;font-weight:bold;line-height:1.15;margin:10px 0 12px;">${escHtml(title)}</div></td></tr>
<tr><td style="background:${C.sky};padding:0;line-height:0;border-bottom:3px solid ${C.ink};"><img src="${siteUrl}/email/skyline.png" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
<tr><td style="padding:8px 22px 26px;font-family:${BODY};color:${C.ink};font-size:15px;line-height:1.5;">${bodyHtml}</td></tr>
<tr><td style="background:${C.navy};padding:18px 24px;border-top:3px solid ${C.ink};font-family:${BODY};color:#D6CFFF;font-size:12px;line-height:1.6;font-weight:bold;">${footerHtml}</td></tr>
</table></td></tr></table>${pixelUrl ? `<img src="${escHtml(pixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;">` : ''}</body></html>`);
}

function footer({ siteUrl, unsubscribeUrl, address, prefsUrl = '', edition = 'weekly' }) {
  const a = 'color:#FFC93C;';
  const prefs = prefsUrl
    ? `<br><a href="${escHtml(prefsUrl)}" style="${a}">${edition === 'weekend' ? 'Just want Mondays? Skip the weekend email' : 'Email settings'}</a>` : '';
  return `Forwarded this? <a href="${siteUrl}/subscribe" style="${a}">Get it free ${SCHEDULE}</a>.<br>
You're getting this because you subscribed at <a href="${siteUrl}" style="${a}">thevic361.com</a>.<br>
<a href="${escHtml(unsubscribeUrl)}" style="${a}">Unsubscribe</a> · <a href="${siteUrl}/advertise" style="${a}">Advertise</a> · <a href="${siteUrl}/submit" style="${a}">Submit an event</a>${prefs}<br>
${escHtml(SITE_NAME)}${address ? ` · ${escHtml(address)}` : ' · Victoria, TX'}`;
}

// Up to three icons, the site's set (iconKeys: `free: true` is the Free
// icon). Free always makes the cut: it's the one readers scan for.
function iconImgs(ev, siteUrl) {
  const keys = iconKeys(ev).filter(k => ICON_KEYS.has(k));
  const shown = keys.slice(0, 3);
  if (keys.includes('free') && !shown.includes('free')) shown[2] = 'free';
  return shown
    .map(k => `<img src="${siteUrl}/email/${k}.png" width="22" height="22" alt="" style="vertical-align:middle;border:0;margin-right:2px;">`).join('');
}

// "7 PM" / "7:30 AM": the start of an event's time, with AM/PM even when
// the stored range shares one ("4-10 p.m." starts at 4 PM), or ''.
function clockOf(time) {
  const t = parseTimes(time)[0];
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

// A Vic's Pick is its own yellow card with space around it, so the dashed
// divider is left off the row just above one (`next` is the row after).
export function eventRow(ev, siteUrl, next) {
  const link = ev.page ? `${siteUrl}${ev.page}` : (safeUrl(ev.url) || siteUrl);
  // Same place line and "Nearby · Cuero" tag as the site's list items.
  const where = placeText(ev);
  const rowStyle = ev.featured
    ? `padding:10px 12px;background:${C.sunLight};border:2px solid ${C.ink};border-radius:12px;`
    : `padding:10px 4px;${next?.featured ? '' : `border-bottom:2px dashed ${C.line};`}`;
  const open = ev.featured
    ? `<tr><td style="padding:6px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;"><tr><td style="${rowStyle}">`
    : `<tr><td style="${rowStyle}">`;
  const close = ev.featured ? '</td></tr></table></td></tr>' : '</td></tr>';
  return `${open}
${ev.featured ? `<span style="display:inline-block;background:${C.sunset};color:${C.ink};font-family:${DISPLAY};font-size:11px;font-weight:bold;padding:1px 8px;border:2px solid ${C.ink};border-radius:999px;margin-right:4px;">★ VIC’S PICK</span>` : ''}
${ev.town ? `<span style="display:inline-block;background:${C.sky};color:${C.ink};font-family:${DISPLAY};font-size:11px;font-weight:bold;padding:1px 8px;border:2px solid ${C.ink};border-radius:999px;margin-right:4px;">Nearby · ${escHtml(ev.town)}</span>` : ''}
${iconImgs(ev, siteUrl)}
${ev.time ? `<span style="display:inline-block;font-family:${DISPLAY};font-weight:bold;font-size:12px;padding:0 8px;border:2px solid ${C.ink};border-radius:999px;margin-right:4px;">${escHtml(formatTime(ev.time))}</span>` : ''}
<a href="${escHtml(link)}" style="color:${C.ink};font-weight:800;text-decoration:none;">${escHtml(ev.name)}</a>${where ? ` <span style="color:${C.muted};">· ${escHtml(where)}</span>` : ''}${ev.also ? ` <span style="color:${C.muted};font-size:13px;font-weight:bold;">· also ${escHtml(ev.also)}</span>` : ''}
${ev.description ? `<div style="color:${C.muted};font-size:13px;margin-top:2px;">${escHtml(ev.description)}</div>` : ''}
${close}`;
}

// Email apps send no referrer, so links back to the site carry UTM tags
// (server/analytics.js maps utm_source=newsletter to "Newsletter" in the
// Traffic tab). Only our own pages: not unsubscribe or confirm links
// (private tokens), images, or the /go/ sponsor redirect (it tags the
// sponsor's link itself). `amp` is '&amp;' in HTML and '&' in plain text.
export function utmTag(content, siteUrl, campaign, amp = '&amp;') {
  if (!siteUrl) return content;
  const base = siteUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${base}(/[^\\s"'<>]*)?`, 'g');
  const tags = `utm_source=newsletter${amp}utm_medium=email${amp}utm_campaign=${encodeURIComponent(campaign)}`;
  return content.replace(re, (url, rest = '') => {
    if (/^\/(unsubscribe|subscribe\/confirm|email-prefs|go\/|email\/|sponsor-logo\/|r\/)/.test(rest)) return url;
    const hash = url.indexOf('#');
    const [head, frag] = hash === -1 ? [url, ''] : [url.slice(0, hash), url.slice(hash)];
    return `${head}${head.includes('?') ? amp : '?'}${tags}${frag}`;
  });
}

// A paid weekly sponsor's button goes through /go/s/<week> (server/
// sponsors.js), which counts the click for the sponsor's end-of-week report
// and then sends the reader on with UTM tags. A hand-set sponsor (no order)
// links straight to its site.
export function sponsorHref(sponsor, siteUrl, src = 'newsletter') {
  if (siteUrl && /^\d{4}-\d{2}-\d{2}$/.test(sponsor.week || '')) return `${siteUrl}/go/s/${sponsor.week}?src=${src}`;
  return safeUrl(sponsor.url);
}

function sponsorHtml(sponsor, siteUrl = '', src = 'newsletter') {
  // Logo: absolute URL (email clients can't resolve a path), only our own.
  const logo = sponsor && isSponsorLogo(sponsor.logo) ? `${siteUrl}${sponsor.logo}` : '';
  return sponsor && sponsor.name ? `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:${C.sunLight};border:3px dashed ${C.ink};border-radius:16px;"><tr><td style="padding:14px 16px;">
<span style="display:inline-block;font-family:${DISPLAY};font-size:11px;font-weight:bold;letter-spacing:.5px;background:${C.sunset};color:${C.ink};border:2px solid ${C.ink};border-radius:999px;padding:1px 10px;">THIS WEEK'S SPONSOR</span>
${logo ? `<div style="margin:8px 0 2px;"><img src="${escHtml(logo)}" alt="${escHtml(sponsor.name)}" style="display:block;max-height:60px;max-width:200px;height:auto;border:0;"></div>` : ''}
<div style="font-family:${DISPLAY};font-size:20px;font-weight:bold;margin:6px 0 2px;">${escHtml(sponsor.name)}</div>
${sponsor.text ? `<div style="font-size:14px;">${escHtml(sponsor.text)}</div>` : ''}
${safeUrl(sponsor.url) && sponsor.cta ? `<a href="${escHtml(sponsorHref(sponsor, siteUrl, src))}" style="display:inline-block;margin-top:10px;background:#fff;color:${C.ink};font-family:${DISPLAY};font-weight:bold;padding:6px 14px;border:2px solid ${C.ink};border-radius:999px;text-decoration:none;">${escHtml(sponsor.cta)} →</a>` : ''}
</td></tr></table>` : '';
}

// What each package looks like inside the newsletter, for /advertise: the
// real sponsor block, and a Saturday with a starred Vic's Pick among its
// neighbors (same renderers as the issue).
export function sampleEmailPreviews(siteUrl = '') {
  const day = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border:3px solid ${C.ink};border-radius:16px;overflow:hidden;border-collapse:separate;background:#fff;">
<tr><td style="background:${DAY_COLORS[5]};padding:10px 14px;border-bottom:3px solid ${C.ink};font-family:${DISPLAY};color:${C.ink};"><span style="font-size:20px;font-weight:bold;">Saturday</span></td></tr>
<tr><td style="padding:6px 12px 10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;">${rows}</table></td></tr></table>`;
  const evs = [
    { name: 'Farmers Market', time: '8:00 AM', venue: 'Market Square' },
    { name: 'Your Event Name', time: '7:00 PM', venue: 'Your Venue', description: 'A line or two about your event.', featured: true },
    { name: 'Live Music', time: '9:00 PM', venue: 'Downtown' }
  ];
  return {
    weekly: `<div style="font-family:Arial,Helvetica,sans-serif;color:${C.ink};">${sponsorHtml({ name: 'Your Business', text: 'One or two sentences about what you offer.', cta: 'Learn more', url: siteUrl || 'https://www.thevic361.com', logo: SAMPLE_LOGO }, siteUrl)}</div>`,
    featured: `<div style="font-family:Arial,Helvetica,sans-serif;color:${C.ink};font-size:15px;">${day(evs.map((e, i) => eventRow({ ...e, page: null, url: '' }, siteUrl, evs[i + 1])).join(''))}</div>`
  };
}

// ─── Choosing what an issue shows ─────────────────────────────────────
// Each day shows PER_DAY events: paid Vic's Picks always, then editor's
// picks, then the best-rated (`appeal`, 1–5, from the collector), then
// earlier ones. Shown in time order (picks keep their badge), so a day
// reads morning to night. The weekend issue leaves out what nobody plans a
// weekend around (FILLER), never a paid pick.
const FILLER = /\b(training|course|certification|seminar|webinar|orientation|meeting|support group|info(?:rmation)? session|hiring event|job fair|career fair|tutoring|open house|chair yoga)\b/i;
const paidPick = e => Boolean(e.featured && !e.editor_pick);
export function isFiller(ev) {
  if (paidPick(ev)) return false;
  return FILLER.test(String(ev.name || '')) || (ev.appeal != null && Number(ev.appeal) <= 2);
}
const startMin = e => { const t = parseTimes(e.time)[0]; return t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : 9999; };
const appealOf = e => (Number.isFinite(Number(e.appeal)) && e.appeal != null ? Number(e.appeal) : 3);
const byBest = (a, b) => pickRank(a) - pickRank(b) || appealOf(b) - appealOf(a) || startMin(a) - startMin(b);
const normName = v => String(v || '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b(the|disneys)\b/g, ' ').replace(/\s+/g, ' ').trim();
// The same event listed twice (two sources): one name inside the other.
const sameEvent = (a, b) => {
  const x = normName(a.name), y = normName(b.name);
  return x.length >= 8 && y.length >= 8 && (x === y || x.includes(y) || y.includes(x));
};
const dayShort = d => formatDay(d, { weekday: 'short' });

// [{ d, list }] for the issue's days: filler out (weekend), same-day
// duplicates merged, an event on several days shown on its first with
// "also Sat & Sun" (a paid pick keeps its own day), best first.
export function issueDays(events, days, { weekend = false } = {}) {
  const out = days.map(d => {
    const list = [];
    for (const e of sortEvents(events.filter(x => x.date === d)).sort(byBest)) {
      if (weekend && isFiller(e)) continue;
      const twin = list.find(x => sameEvent(x, e) && (!x.venue || !e.venue || normName(x.venue) === normName(e.venue)));
      if (twin && !paidPick(e)) continue;
      list.push({ ...e });
    }
    return { d, list };
  });
  const seen = new Map();
  for (const day of out) {
    day.list = day.list.filter(e => {
      const key = normName(e.name) + '|' + normName(e.venue);
      const first = seen.get(key);
      if (!first) { seen.set(key, e); return true; }
      if (paidPick(e)) return true;
      first._also = [...(first._also || []), day.d];
      return false;
    });
  }
  for (const day of out) for (const e of day.list) {
    if (e._also) { e.also = e._also.map(dayShort).join(' & '); delete e._also; }
  }
  return out.filter(x => x.list.length);
}

// The day's events to show: the best PER_DAY, in time order.
function shownOf(list) {
  return list.slice(0, PER_DAY).sort((a, b) => startMin(a) - startMin(b) || pickRank(a) - pickRank(b));
}

// The issue's top three: best-rated across all its days.
export function dontMiss(byDay, n = 3) {
  return byDay.flatMap(x => x.list).slice().sort((a, b) => appealOf(b) - appealOf(a) || pickRank(a) - pickRank(b) ||
    (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || startMin(a) - startMin(b)).slice(0, n);
}

// An issue: the rest of this week (weekly, Monday) or Friday through
// Sunday (weekend, Thursday). See EDITIONS.
export function renderWeekly(events, { siteUrl, now, sponsor, unsubscribeUrl, address, openPixelUrl = '', referral = null, edition = 'weekly', prefsUrl = '', replyAsk = false }) {
  const today = localDateStr(now);
  const weekend = edition === 'weekend';
  const week = (EDITIONS[edition] || EDITIONS.weekly).days(today);
  const byDay = issueDays(events, week, { weekend });
  const total = byDay.reduce((n, x) => n + x.list.length, 0);
  const top = dontMiss(byDay);
  // The "Don't miss" box only when there's a lot to choose from.
  const topShown = total >= 6 ? top : [];
  const short = d => formatDay(d, { month: 'short', day: 'numeric' });
  const range = week.length ? (week.length === 1 ? short(week[0]) : `${short(week[0])}–${short(week[week.length - 1])}`) : '';
  const title = weekend ? 'This weekend in Victoria' : 'This week in Victoria';
  const listPath = weekend ? '/this-weekend' : '/';
  const subject = `${title}: ${total} ${total === 1 ? 'thing' : 'things'} to do (${range})`;
  const preheader = top.map(e => e.name).join(' · ');
  const when = e => [dayShort(e.date), clockOf(e.time)].filter(Boolean).join(' ');
  const topHtml = topShown.length ? `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:#fff;border:3px solid ${C.ink};border-radius:16px;"><tr><td style="padding:12px 16px;">
<div style="font-family:${DISPLAY};font-size:19px;font-weight:bold;margin-bottom:4px;">Don’t miss ${weekend ? 'this weekend' : 'this week'}</div>
${topShown.map((e, i) => `<div style="margin-top:6px;font-size:15px;"><strong>${i + 1}.</strong> <a href="${escHtml(e.page ? siteUrl + e.page : (safeUrl(e.url) || siteUrl))}" style="color:${C.ink};font-weight:800;">${escHtml(e.name)}</a> <span style="color:${C.muted};">· ${escHtml([when(e), e.venue || placeText(e)].filter(Boolean).join(' · '))}</span></div>`).join('')}
</td></tr></table>` : '';

  // Day colors follow the weekday (Monday yellow ... Sunday coral), like the site.
  const days = byDay.map(({ d, list }) => { const dayColor = DAY_COLORS[(currentWeek(d).indexOf(d) + 7) % 7]; return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;border:3px solid ${C.ink};border-radius:16px;overflow:hidden;border-collapse:separate;">
<tr><td style="background:${dayColor};padding:10px 14px;border-bottom:3px solid ${C.ink};font-family:${DISPLAY};color:${C.ink};">
<span style="font-size:21px;font-weight:bold;">${escHtml(formatDay(d, { weekday: 'long' }))}</span>
<span style="display:inline-block;margin-left:6px;font-size:13px;font-weight:bold;background:#fff;border:2px solid ${C.ink};border-radius:999px;padding:0 9px;">${escHtml(formatDay(d, { month: 'long', day: 'numeric' }))}</span></td></tr>
<tr><td style="padding:6px 12px 10px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;">${shownOf(list).map((e, i, arr) => eventRow(e, siteUrl, arr[i + 1])).join('')}</table>
${list.length > PER_DAY ? `<p style="margin:12px 0 4px;text-align:center;"><a href="${siteUrl}${weekend ? listPath : `/#day-${currentWeek(d).indexOf(d)}`}" style="${MORE_PILL}background:${dayColor};">+${list.length - PER_DAY} more on ${escHtml(formatDay(d, { weekday: 'long' }))} →</a></p>` : ''}
</td></tr></table>`; }).join('');

  const sponsorBlock = sponsorHtml(sponsor, siteUrl);

  const pill = (href, label) => `<a href="${siteUrl}${href}" style="display:inline-block;margin:6px 4px 0 0;font-family:${DISPLAY};font-weight:bold;font-size:13px;color:${C.ink};background:#fff;border:2px solid ${C.ink};border-radius:999px;padding:2px 10px;text-decoration:none;">${label}</a>`;
  const bodyHtml = `
<p style="margin:16px 0 4px;font-size:16px;">${total ? `Here's what's happening in Victoria, TX ${weekend ? 'this weekend' : 'this week'}: <strong>${total} ${total === 1 ? 'event' : 'events'}</strong>.` : `Nothing is listed yet for ${weekend ? 'this weekend' : 'the rest of this week'}.`}</p>
<div>${weekend ? pill('/', 'All week') : pill('/this-weekend', 'This weekend')}${pill('/free-things-to-do', 'Free')}${pill('/kids-and-family', 'Kids')}${pill('/live-music', 'Live music')}</div>
${sponsorBlock}${topHtml}${days}
<p style="margin:28px 0 0;text-align:center;">${btn(`${siteUrl}${listPath}`, weekend ? 'See the whole weekend' : 'See the full list')}</p>
${replyAsk ? replyAskHtml(false) : ''}
${referral ? referralHtml({ siteUrl, ...referral }) : ''}`;

  // Sponsors are sold "the top of the newsletter": first in both parts (and
  // the week's sponsor is in Thursday's issue too).
  const sponsorLine = sponsor && sponsor.name
    ? [`THIS WEEK'S SPONSOR: ${[sponsor.name, sponsor.text, safeUrl(sponsor.url) ? sponsorHref(sponsor, siteUrl) : ''].filter(Boolean).join(' - ')}`, '']
    : [];
  const campaign = `${weekend ? 'weekend' : 'weekly'}-${(EDITIONS[edition] || EDITIONS.weekly).key(today)}`;
  const text = [
    `${subject}`, '', ...sponsorLine,
    ...(topShown.length ? [`DON'T MISS ${weekend ? 'THIS WEEKEND' : 'THIS WEEK'}`, ...topShown.map((e, i) => `${i + 1}. ${e.name} (${[when(e), e.venue || placeText(e)].filter(Boolean).join(', ')})${e.page ? ' ' + siteUrl + e.page : ''}`), ''] : []),
    ...byDay.flatMap(({ d, list }) => [formatDay(d, { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase(),
      ...shownOf(list).map(e => `- ${e.time ? formatTime(e.time) + ' ' : ''}${e.name}${placeText(e) ? ' @ ' + placeText(e) : ''}${e.town ? ' (' + e.town + ')' : ''}${e.also ? ' (also ' + e.also + ')' : ''}${e.page ? ' ' + siteUrl + e.page : ''}`), '']),
    `Full list: ${siteUrl}${listPath}`, '', ...(replyAsk ? [replyAskText(false), ''] : []), ...(referral ? referralText({ siteUrl, ...referral }) : []),
    ...(prefsUrl ? [`${weekend ? 'Just want Mondays? Skip the weekend email' : 'Email settings'}: ${prefsUrl}`] : []),
    `Unsubscribe: ${unsubscribeUrl}`, `${SITE_NAME} · ${address || 'Victoria, TX'}`
  ].join('\n');

  // The paid Vic's Picks this issue actually stars (shown, not cut by
  // PER_DAY), recorded with the send for their reports.
  const picks = [...new Set(byDay.flatMap(({ list }) => shownOf(list))
    .filter(e => e.featured && !e.editor_pick && e.sponsor_order).map(e => e.sponsor_order))];
  return {
    subject, total, picks,
    html: utmTag(emailShell({ title, preheader, bodyHtml, siteUrl, pixelUrl: openPixelUrl, footerHtml: footer({ siteUrl, unsubscribeUrl, address, prefsUrl, edition }) }), siteUrl, campaign),
    text: utmTag(text, siteUrl, campaign, '&')
  };
}

// reminder: the one follow-up a day later to someone who hasn't tapped it
// (sendConfirmReminders), with a subject that says what it's for.
// One inbox, one key for rate limits (same as emailKey in db.js).
export const inboxKey = emailKey;

export function renderConfirmEmail({ siteUrl, confirmUrl, address, reminder = false }) {
  const lead = reminder
    ? `You asked for The Vic 361 yesterday but haven't confirmed yet. One tap and Victoria's best events land in your inbox ${SCHEDULE}.`
    : `Tap the button to confirm and start getting Victoria's events ${SCHEDULE}.`;
  const bodyHtml = `<p style="margin:18px 0;font-size:16px;">${escHtml(lead)}</p>
<p style="text-align:center;">${btn(confirmUrl, 'Confirm my subscription')}</p>
<p style="color:${C.muted};font-size:13px;">Didn't sign up? Ignore this email and you won't hear from us${reminder ? ' again' : ''}.</p>`;
  return {
    subject: reminder ? 'Still want Victoria\'s events? Tap to confirm' : 'Confirm your Vic 361 subscription',
    html: emailShell({ title: reminder ? 'Just one tap left' : 'One tap to confirm',
      preheader: reminder ? 'Your Vic 361 signup is waiting on one tap' : `Confirm to get Victoria events ${SCHEDULE}`, bodyHtml, siteUrl,
      footerHtml: `${escHtml(SITE_NAME)} · ${escHtml(address || 'Victoria, TX')}` }),
    text: reminder
      ? `${lead}\n\nConfirm: ${confirmUrl}\n\nDidn't sign up? Ignore this email and you won't hear from us again.`
      : `Confirm your subscription to The Vic 361: ${confirmUrl}\n\nDidn't sign up? Ignore this email.`
  };
}

// ─── Referral program ───
// Every subscriber has a link, thevic361.com/r/<code>. A friend who signs up
// through it counts for them while that friend stays subscribed. The tiers
// and the gift cards are in server/referralRewards.js (REFERRAL_TIERS);
// emails, Slack and the rules page read them. The first tier is at 1 on
// purpose: each tier up, about a tenth as many readers get there (Morning
// Brew's ladder), so the cheap early rewards do most of the work.
const REF_CODE_RE = /^[a-z2-9]{7}$/;
export function normalizeRefCode(raw) {
  const c = String(raw || '').trim().toLowerCase();
  return REF_CODE_RE.test(c) ? c : null;
}
export function refLink(siteUrl, code) { return `${siteUrl}/r/${code}`; }
function nextTier(count) { return REFERRAL_TIERS.find(t => t.n > count) || null; }
export function referralProgress(count) {
  const next = nextTier(count);
  const done = count === 1 ? "You've brought in 1 friend so far." : count ? `You've brought in ${count} friends so far.` : '';
  const todo = next ? `${next.n - count} more and you get ${next.reward}.` : "You've unlocked every reward. Thank you!";
  return [done, todo].filter(Boolean).join(' ');
}

// The "share" box in the weekly issue and the welcome email: this reader's
// own link and how close they are to the next reward.
function referralHtml({ siteUrl, code, count = 0 }) {
  if (!code) return '';
  const url = refLink(siteUrl, code);
  const tiers = REFERRAL_TIERS.map(t => `${t.n} ${t.n === 1 ? 'friend' : 'friends'}: ${escHtml(t.reward)}`).join('<br>');
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0 0;border-collapse:separate;"><tr><td style="background:${C.sunLight};border:2px solid ${C.ink};border-radius:14px;padding:16px 18px;">
<p style="margin:0 0 6px;font-family:${DISPLAY};font-size:19px;font-weight:bold;">Share The Vic 361, get local perks</p>
<p style="margin:0 0 10px;font-size:14px;">Know someone who's always asking what there is to do in Victoria? Send them your link:</p>
<p style="margin:0 0 10px;text-align:center;"><a href="${url}" style="display:inline-block;font-family:${DISPLAY};font-weight:bold;font-size:17px;color:${C.ink};background:#fff;border:2px solid ${C.ink};border-radius:999px;padding:6px 16px;text-decoration:none;">${escHtml(url.replace(/^https?:\/\/(www\.)?/, ''))}</a></p>
<p style="margin:0 0 8px;font-size:14px;font-weight:bold;">${escHtml(referralProgress(count))}</p>
<p style="margin:0;font-size:12px;color:${C.muted};">${tiers}<br>Every friend who joins in a month is another entry in that month's drawing. A friend counts a day after they sign up with your link and confirm their email, for as long as they stay subscribed. Gift cards arrive by email. <a href="${siteUrl}/referral-rules" style="color:${C.muted};">Rules</a></p>
</td></tr></table>`;
}
export function renderReferralRules({ siteUrl }) {
  const cards = REFERRAL_TIERS.filter(t => t.amount);
  const li = (title, text) => `<li><strong>${title}</strong> ${text}</li>`;
  return layout({
    siteUrl, path: '/referral-rules', nav: null, pixel: false, title: `Referral rewards: official rules | ${SITE_NAME}`,
    description: 'How The Vic 361 newsletter referral rewards and monthly gift card drawing work.',
    body: `<h1 class="page-title">Referral rewards: official rules</h1>
<p class="page-lead">Share The Vic 361 with friends and earn gift cards. No purchase is necessary: subscribing and sharing are free.</p>
<ul>
${li('Who can take part.', 'Anyone subscribed to The Vic 361 newsletter who is 18 or older and lives in the United States. The Vic 361\'s owner and their household can\'t win. Void where prohibited.')}
${li('Your link.', 'Every subscriber gets a personal share link in each newsletter. A friend counts for you when they sign up through your link, confirm their email address, and stay subscribed for at least 24 hours. Each email inbox counts once, and your own addresses don\'t count.')}
${li('Monthly drawing.', `Each friend who joins through your link during a calendar month is one entry in that month's drawing. In the first week of the next month, one entry is picked at random from all entries, and its owner gets a $${DRAWING_AMOUNT} digital gift card. Your odds depend on how many entries there are that month. Entries don't carry over to the next month.`)}
${cards.map(t => li(`${t.n} friends.`, `A $${t.amount} digital gift card, once per subscriber.`)).join('\n')}
${li('How rewards arrive.', 'Gift cards are sent by email from our rewards partner, Tremendous, usually on the Monday after you earn them. You choose the store from their list. Tremendous gets your email address to send it.')}
${li('Fair play.', 'Referrals have to be real people who want the newsletter. We can hold back or cancel rewards for sign-ups that look made up (fake, throwaway or duplicate addresses), and our decisions about who counts are final.')}
${li('Changes.', 'We may change or end the program at any time. Rewards you have already earned will still be sent.')}
</ul>
<p>Questions? <a href="/contact">Get in touch</a>.</p>`
  });
}

function referralText({ siteUrl, code, count = 0 }) {
  if (!code) return [];
  return ['SHARE THE VIC 361', `Send friends your link: ${refLink(siteUrl, code)}`, referralProgress(count),
    `Rules: ${siteUrl}/referral-rules`, ''];
}

// Sent once, right after someone signs up (or a comeback confirms): what
// to expect, a few events they can use now (no waiting for the next issue), the
// sponsor, and a nudge to share.
const WELCOME_PICKS = 5;

// "Hit reply" asks (only when NEWSLETTER_REPLY_TO is set, so a reply never
// bounces). Readers tell us what they want more of, and a reply teaches
// Gmail and friends the issue is wanted mail, which keeps it out of spam
// and Promotions.
const REPLY_TOPICS = 'live music, family stuff, food & drink, markets, nightlife, arts';
function replyAskHtml(welcome) {
  return welcome
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:${C.sky};border:2px solid ${C.ink};border-radius:14px;border-collapse:separate;"><tr><td style="padding:12px 16px;font-size:15px;">
<strong style="font-family:${DISPLAY};font-size:17px;">One quick favor: hit reply 👋</strong><br>
Tell us what you're most into (${REPLY_TOPICS}...). We read every reply and use it to pick what goes in, and a reply helps make sure we keep landing in your inbox.</td></tr></table>`
    : `<p style="margin:22px 0 0;font-size:14px;text-align:center;color:${C.muted};">What do you want more of? <strong style="color:${C.ink};">Just hit reply</strong> and tell us. We read every one.</p>`;
}
const replyAskText = welcome => welcome
  ? `ONE QUICK FAVOR: hit reply and tell us what you're most into (${REPLY_TOPICS}...). We read every reply, and a reply helps make sure we keep landing in your inbox.`
  : 'What do you want more of? Just hit reply and tell us. We read every one.';

// A transparent 1x1 GIF, the newsletter's open-tracking image.
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
export function renderWelcomeEmail(events, { siteUrl, now, sponsor, unsubscribeUrl, address, referral = null, replyAsk = false }) {
  const today = localDateStr(now);
  const soon = sortEvents((events || []).filter(e => e.date >= today && e.date <= addDays(today, 6)));
  // Picks always make the five, then they're shown in time order like the
  // site; days past this Sunday carry their date (they aren't on the
  // homepage's week yet).
  const picks = sortEvents([...soon.filter(e => e.featured).sort((a, b) => pickRank(a) - pickRank(b)), ...soon.filter(e => !e.featured)].slice(0, WELCOME_PICKS));
  const weekEnd = currentWeek(today)[6];
  const dayLabel = (d) => d === today ? 'Today' : d > weekEnd ? formatDay(d, { weekday: 'short', month: 'short', day: 'numeric' }) : formatDay(d, { weekday: 'long' });
  const coming = picks.length ? `
<p style="margin:22px 0 6px;font-family:${DISPLAY};font-size:19px;font-weight:bold;">Coming up this week</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;">${picks.map((e, i) =>
    eventRow({ ...e, time: [dayLabel(e.date), e.time].filter(Boolean).join(', ') }, siteUrl, picks[i + 1])).join('')}</table>
${soon.length > picks.length ? `<p style="margin:12px 0 4px;text-align:center;"><a href="${siteUrl}/" style="${MORE_PILL}background:${C.sun};">+${soon.length - picks.length} more this week →</a></p>` : ''}` : '';
  const bodyHtml = `
<p style="margin:18px 0 4px;font-size:16px;"><strong>You're in!</strong> Every Monday morning you'll get the week's events in Victoria, TX (concerts, markets, festivals, family stuff and more), and every Thursday morning the weekend's best.</p>
${replyAsk ? replyAskHtml(true) : ''}
${coming}${sponsorHtml(sponsor, siteUrl, 'welcome')}
<p style="margin:26px 0 0;text-align:center;">${btn(`${siteUrl}/`, "See this week's events")}</p>
${referral ? referralHtml({ siteUrl, ...referral }) : `<p style="margin:22px 0 0;font-size:14px;color:${C.muted};">Know someone who's always asking what there is to do in Victoria? Forward them this email or send them to <a href="${siteUrl}/" style="color:${C.accent};font-weight:bold;">thevic361.com</a>.</p>`}`;
  const text = [
    "You're in! Every Monday morning you'll get the week's events in Victoria, TX, and every Thursday the weekend's best.", '',
    ...(replyAsk ? [replyAskText(true), ''] : []),
    ...(picks.length ? ['COMING UP THIS WEEK', ...picks.map(e =>
      `- ${dayLabel(e.date)}${e.time ? ' ' + formatTime(e.time) : ''}: ${e.name}${placeText(e) ? ' @ ' + placeText(e) : ''}${e.page ? ' ' + siteUrl + e.page : ''}`), ''] : []),
    `This week's events: ${siteUrl}/`, '', ...(referral ? referralText({ siteUrl, ...referral }) : []),
    `Unsubscribe: ${unsubscribeUrl}`, `${SITE_NAME} · ${address || 'Victoria, TX'}`
  ].join('\n');
  return {
    subject: 'Welcome to The Vic 361',
    html: utmTag(emailShell({ title: 'Welcome to The Vic 361', preheader: picks.length ? `Coming up: ${picks.slice(0, 3).map(e => e.name).join(' · ')}` : `Victoria's events, ${SCHEDULE}`,
      bodyHtml, siteUrl, footerHtml: footer({ siteUrl, unsubscribeUrl, address }) }), siteUrl, 'welcome'),
    text: utmTag(text, siteUrl, 'welcome', '&')
  };
}

// Where a signup came from. Forms send one of these; ":ad" means the visitor
// first landed from a paid ad (docs/track.js). Anything else is "site".
const SIGNUP_SOURCES = new Set(['footer', 'list-card', 'subscribe-page']);
export function signupSource(raw) {
  const [base, tag] = String(raw || '').split(':');
  if (!SIGNUP_SOURCES.has(base)) return 'site';
  return tag === 'ad' ? `${base}:ad` : base;
}

// Newsletter signup form: the homepage footer and the /subscribe page.
export function signupFormHtml({ source = 'footer', button = 'Subscribe' } = {}) {
  return `<form class="signup-form" id="signup-form" action="/api/subscribe" method="post" novalidate data-turnstile="fetch" data-source="${escHtml(source)}">
  <label for="signup-email" class="visually-hidden">Email address</label>
  <input id="signup-email" name="email" type="email" required autocomplete="email" placeholder="you@example.com">
  <input type="text" name="company" tabindex="-1" autocomplete="off" class="hp-field" aria-hidden="true">
  <button type="submit" class="btn btn--primary">${escHtml(button)}</button>
  <p class="signup-msg" id="signup-msg" role="status" aria-live="polite"></p>
</form>
<script>
(function(){var f=document.getElementById('signup-form');if(!f)return;var m=document.getElementById('signup-msg');
f.addEventListener('submit',function(e){e.preventDefault();var b=f.querySelector('button');b.disabled=true;m.textContent='';
(window.vicTurnstile?window.vicTurnstile.token(f):Promise.resolve('')).then(function(t){return fetch('/api/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:f.email.value,company:f.company.value,turnstile_token:t,source:window.vic361Source?window.vic361Source(f.getAttribute('data-source')):f.getAttribute('data-source'),ref:window.vic361Ref?window.vic361Ref():''})});})
.then(function(r){return r.json().catch(function(){return{};}).then(function(j){return{ok:r.ok,j:j};});})
.then(function(x){m.textContent=x.ok?'✅ '+(x.j.message||"You're on the list! Check your inbox."):(x.j.message||'Something went wrong. Try again.');if(x.ok){f.email.value='';f.classList.add('is-done');var was=false;try{was=localStorage.getItem('vic361-subscribed')==='1';localStorage.setItem('vic361-subscribed','1')}catch(e){}if(!was&&window.vic361Track)window.vic361Track('subscribe_click',{link_url:'form'});}})
.catch(function(){m.textContent='Something went wrong. Try again.';}).then(function(){b.disabled=false;if(window.vicTurnstile)window.vicTurnstile.reset(f);});});})();
</script>`;
}

// ─── Signup page ─────────────────────────────────────────────────────────

const SHOW_COUNT_FROM = 100; // "Join 40 locals" undersells; say nothing until it's a real crowd

// The signup page: what you get, the form, then proof (real events from
// the next seven days) for people who scroll before deciding.
export function renderSubscribePage(events, { siteUrl, now, subscriberCount = 0, invited = false }) {
  const today = localDateStr(now);
  const end = addDays(today, 6);
  const next7 = sortEvents(events.filter(e => e.date >= today && e.date <= end));
  const seen = new Set();
  // Vic's Picks get a spot first, then the list reads in date order with
  // the day on each line (renderEventItem alone shows only the time).
  const dayOf = d => d === today ? 'Today' : formatDay(d, { weekday: 'short' });
  const picks = sortEvents(next7.filter(e => e.featured).sort((a, b) => pickRank(a) - pickRank(b)).concat(next7)
    .filter(e => e.page && !seen.has(e.name) && seen.add(e.name)).slice(0, 5))
    .map(e => ({ ...e, time: [dayOf(e.date), e.time].filter(Boolean).join(' · ') }));
  const crowd = subscriberCount >= SHOW_COUNT_FROM
    ? `<p class="sub-crowd">Join ${Math.floor(subscriberCount / 10) * 10}+ Victoria locals who already get it.</p>` : '';
  const proof = picks.length ? `
    <h2 class="section-heading">Coming up in the next week</h2>
    <p class="sub-proof-lead">${next7.length} things to do in Victoria in the next seven days, including:</p>
    <ul class="event-list sub-picks" role="list">${picks.map(renderEventItem).join('')}</ul>
    <p class="sub-again"><a class="btn btn--primary" href="#signup-email">Get the full list ${SCHEDULE}</a> <a class="btn btn--outline" href="/">See this week's events</a></p>` : '';
  const body = `
    <section class="sub-hero">
      ${invited ? '<p class="sub-invited">🎁 A friend invited you to The Vic 361</p>' : ''}
      <p class="sub-kicker">Free · Mondays and Thursdays · Victoria, TX</p>
      <h1 class="page-title">Victoria's best events, in your inbox ${SCHEDULE}.</h1>
      ${signupFormHtml({ source: 'subscribe-page', button: 'Subscribe free' })}
      <p class="sub-fine">No spam, ever. Unsubscribe with one click.</p>
      <p class="page-lead">The whole week on Monday, the weekend on Thursday: live music, festivals, markets, family days, and new spots opening.</p>
      ${crowd}
    </section>
    <ul class="sub-perks" role="list">
      <li><strong>Monday mornings:</strong> the whole week, day by day, before you make plans.</li>
      <li><strong>Thursday mornings:</strong> the weekend, Friday to Sunday, in time to plan it (skip it anytime and keep Mondays).</li>
      <li><strong>Free things to do</strong> marked, so you can find them fast.</li>
      <li><strong>New &amp; notable:</strong> places that just opened and things you haven't heard about yet.</li>
    </ul>
    ${proof}
    <script>
    // Already on the signup page: the header's Subscribe button (and "Get
    // the full list") take you to the email box instead of reloading the
    // page, which looked like the button didn't work.
    document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href="/subscribe"],a[href="#signup-email"]');var i=document.getElementById('signup-email');
    if(!a||!i)return;e.preventDefault();i.scrollIntoView({behavior:'smooth',block:'center'});i.focus({preventScroll:true});});
    </script>`;
  return layout({
    siteUrl, path: '/subscribe', nav: null,
    title: `Free Events Newsletter for Victoria, TX | ${SITE_NAME}`,
    description: `Get Victoria, TX's best events in your inbox ${SCHEDULE}: live music, festivals, markets, family events, and new spots. Free, no spam.`,
    body
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────

export function registerNewsletter(app, { store, requireAdmin, siteUrl, nowFn, getPublicPayload, getSendPayload = getPublicPayload, createRateLimiter, config, resend, slack = null, verifyHuman = async () => true, withNav = async html => html, onCron = null, tremendous = null }) {
  const rewards = createReferralRewards({ store, slack, tremendous, nowFn, localDate: localDateStr });
  const subscribeLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
  const confirmLimiter = createRateLimiter({ windowMs: 24 * 60 * 60 * 1000, max: 3 });
  // Signups without a bot-check token can ask for a confirmation email
  // without passing the check, so they share one hourly budget: a script
  // can't use the form to mail strangers at scale (and hurt the domain).
  const unverifiedLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30 });
  // The open pixel writes on every hit, so a per-IP cap keeps a loop from
  // hammering the table. It's high: Gmail's image proxy and Apple Mail
  // Privacy Protection fetch for many readers from shared IPs right after a
  // send, and a low cap (it was 120) dropped real opens. Made-up URLs can't
  // pad the count anyway (recordEmailOpen ignores non-subscriber ids and
  // counts each subscriber once per issue).
  const pixelLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5000 });
  const supported = typeof store.addSubscriber === 'function';

  const openPixel = (week, id) => `${siteUrl}/email/o/${week}/${encodeURIComponent(id)}.gif`;

  // One subscriber's referral link and count, for the welcome email. A
  // store without referrals (or a failed read) just leaves the box out.
  async function referralFor(sub) {
    if (!sub || !sub.id || typeof store.ensureRefCodes !== 'function') return null;
    try {
      const code = (await store.ensureRefCodes([sub.id]))[sub.id];
      if (!code) return null;
      const count = (await store.countReferrals([code]))[code] || 0;
      return { code, count };
    } catch (err) {
      console.warn('[newsletter] referral link failed:', err.message);
      return null;
    }
  }

  // Monday's send: each recipient's code and count. The rewards that came
  // due go out after the newsletter (rewards.run below), so a slow gift
  // card service can't hold up the issue.
  async function referralsForSend(subs) {
    if (typeof store.ensureRefCodes !== 'function') return { codes: {}, counts: {} };
    try {
      const codes = await store.ensureRefCodes(subs.map(s => s.id).filter(Boolean));
      const counts = await store.countReferrals(Object.values(codes));
      return { codes, counts };
    } catch (err) {
      console.warn('[newsletter] referral links failed:', err.message);
      return { codes: {}, counts: {} };
    }
  }

  const page = (title, message) => layout({
    siteUrl, path: '/subscribe', nav: null, noindex: true, pixel: false, title: `${title} | ${SITE_NAME}`, description: title,
    body: `<h1 class="page-title">${escHtml(title)}</h1><p class="page-lead">${message}</p><p><a class="btn btn--primary" href="/">See this week's events</a></p>`
  });

  // A send record's people still owed the issue (a partly failed send).
  const failedCount = r => (r ? (Array.isArray(r.failed_emails) ? r.failed_emails.length : Number(r.failed) || 0) : 0);

  // One send at a time in this process: the Monday cron and an admin
  // Send/Retry can overlap, and both would read "not sent yet" and mail
  // everyone. The second gets 'in-progress' instead.
  // Per issue: Monday's retry and Thursday's send are different people and
  // keys, so one mustn't make the other look done ("in-progress" counts as
  // done for the scheduler, since that same issue is going out).
  const sending = new Set();
  async function sendWeekly(opts = {}) {
    const edition = opts.edition || 'weekly';
    if (sending.has(edition)) return { ok: false, error: 'in-progress', message: 'The newsletter is going out right now. Check back in a minute.' };
    sending.add(edition);
    try {
      return await sendWeeklyNow(opts);
    } finally {
      sending.delete(edition);
    }
  }

  const prefsLink = s => `${siteUrl}/email-prefs?token=${encodeURIComponent(s.token)}`;

  async function sendWeeklyNow({ force = false, edition = 'weekly' } = {}) {
    if (!EDITIONS[edition]) return { ok: false, error: 'unknown-edition' };
    if (!config.enabled) return { ok: false, error: 'not-configured' };
    // CAN-SPAM: every marketing email needs a physical postal address.
    if (!config.address) return { ok: false, error: 'no-address', message: 'Set NEWSLETTER_ADDRESS (a mailing address) before sending.' };
    if (edition === 'weekend' && !config.weekend) return { ok: false, error: 'weekend-off', message: 'NEWSLETTER_WEEKEND=0 is set in Railway.' };
    const weekend = edition === 'weekend';
    const now = nowFn();
    const key = EDITIONS[edition].key(localDateStr(now));
    const prior = await store.getNewsletterSend(key);
    const priorFailed = prior && Array.isArray(prior.failed_emails) ? prior.failed_emails : [];
    // Fully sent: done. Partly sent: a retry (cron or admin) only goes to
    // the people who didn't get it. Force resends to everyone.
    if (prior && !force && !priorFailed.length) return { ok: false, error: 'already-sent', sent: prior };
    const resume = Boolean(prior && !force && priorFailed.length);
    const payload = await getSendPayload();
    let subs = await store.listSubscribers({ status: 'active' });
    if (weekend) subs = subs.filter(s => !s.weekend_optout);
    if (resume) {
      const retry = new Set(priorFailed);
      subs = subs.filter(s => retry.has(s.email));
    }
    if (!subs.length) {
      if (resume) {
        await store.recordNewsletterSend({ ...prior, failed: 0, failed_emails: [] });
        return { ok: false, error: 'already-sent', sent: prior };
      }
      return { ok: false, error: 'no-subscribers' };
    }
    const probe = renderWeekly(payload.events, { siteUrl, now, sponsor: payload.sponsor, unsubscribeUrl: '', address: config.address, edition });
    if (!probe.total) return { ok: false, error: 'no-events' };

    let sent = 0;
    const failures = [];
    const failedEmails = [];
    // Addresses Resend's permissive validation refused. Retrying them can't
    // help (same address, same answer), so they don't count as failed:
    // otherwise the week never reads "sent" and every Monday retries and
    // alerts again. They're marked bounced (no future sends) and listed in
    // one Slack note.
    const refusedEmails = [];
    // Only a forced resend (to everyone, on purpose) gets a fresh key. A
    // resume reuses the first try's key, so a chunk Resend queued but
    // answered after our 15 s timeout gets a 409 (counted as sent) instead
    // of going to those people twice.
    const attempt = force ? `-f${Date.now()}` : '';
    const base = resume ? (prior.recipients || 0) : 0;
    let waiting = subs.map(s => s.email);
    // A resumed send renders from the resume day onward, so a pick starred
    // in Monday's issue may be missing from probe.picks by Tuesday. The
    // record keeps every pick any part of the week's send starred (the
    // Vic's Pick report reads it).
    const picks = resume && Array.isArray(prior.picks) ? [...new Set([...prior.picks, ...probe.picks])] : probe.picks;
    // Written before each chunk, with everyone not yet sent counted as
    // failed: if the process dies mid-send, the week reads "partly sent"
    // and Retry (or the next cron) goes only to the people still waiting.
    const progress = () => store.recordNewsletterSend({
      week_key: key, subject: probe.subject, recipients: base + sent, picks,
      failed: failedEmails.length + waiting.length, failed_emails: [...failedEmails, ...waiting]
    });
    const refs = await referralsForSend(subs);
    for (let i = 0; i < subs.length; i += BATCH_SIZE) {
      await progress();
      const chunk = subs.slice(i, i + BATCH_SIZE);
      const msgs = chunk.map(s => {
        const unsubscribeUrl = `${siteUrl}/unsubscribe?token=${encodeURIComponent(s.token)}`;
        // Open tracking: a 1x1 image per copy, keyed by week and subscriber
        // id (not the token, which unsubscribes). See /email/o below.
        const openPixelUrl = s.id ? openPixel(key, s.id) : '';
        const code = s.id && refs.codes[s.id];
        const referral = code ? { code, count: refs.counts[code] || 0 } : null;
        const issue = renderWeekly(payload.events, { siteUrl, now, sponsor: payload.sponsor, unsubscribeUrl, address: config.address, openPixelUrl, referral, replyAsk: Boolean(config.replyTo || config.inbound),
          edition, prefsUrl: s.token && config.weekend ? prefsLink(s) : '' });
        return {
          from: config.from, to: [s.email], subject: issue.subject, html: issue.html, text: issue.text,
          ...(config.replyTo ? { reply_to: config.replyTo } : {}),
          headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
        };
      });
      // Idempotency key per week + who's in the chunk (not its position: a
      // resume puts the same people at chunk 0): a retried request can't
      // double-send, and a 409 (key already used, by an earlier send of
      // these same people within Resend's 24 hours) means they got it.
      const who = crypto.createHash('sha256').update(chunk.map(s => s.email).join(',')).digest('hex').slice(0, 16);
      try {
        const out = await resend.batch(msgs, `vic361-${key}-${who}${attempt}`);
        // Permissive validation: refused addresses come back by index; the
        // rest of the chunk went out.
        const refused = new Map((out && Array.isArray(out.errors) ? out.errors : []).map(e => [Number(e.index), e.message]));
        chunk.forEach((s, j) => {
          if (refused.has(j)) refusedEmails.push({ email: s.email, reason: String(refused.get(j) || '').slice(0, 200) });
          else sent++;
        });
      } catch (err) {
        if (err.status === 409) sent += chunk.length;
        else {
          failures.push(err.message);
          failedEmails.push(...chunk.map(s => s.email));
        }
      }
      waiting = waiting.slice(chunk.length);
    }
    const record = {
      week_key: key, subject: probe.subject, picks,
      recipients: base + sent,
      failed: failedEmails.length, failed_emails: failedEmails
    };
    await store.recordNewsletterSend(record);
    if (refusedEmails.length) {
      const emails = refusedEmails.map(r => r.email);
      let marked = false;
      try {
        if (typeof store.markSubscribersBounced === 'function') { await store.markSubscribersBounced(emails); marked = true; }
      } catch (err) { console.warn('[newsletter] marking refused addresses bounced failed:', err.message); }
      if (slack) {
        slack.alert(`newsletter-refused-${key}`, `Newsletter: Resend refused ${emails.length} address(es)`,
          `${refusedEmails.slice(0, 20).map(r => `${r.email}: ${r.reason}`).join('\n')}${emails.length > 20 ? `\n…and ${emails.length - 20} more` : ''}\n` +
          (marked ? 'They are marked bounced and get no more issues; re-import one to try it again.' : 'They could not be marked bounced, so the next send will try them again.'),
          `${siteUrl}/admin.html`);
      }
    }
    if (slack) {
      const name = weekend ? 'Weekend newsletter' : 'Newsletter';
      if (failures.length) slack.alert(`newsletter-failed-${key}`, `${name} send partly failed`, `${sent} sent, ${record.failed} failed.\n${failures[0]}`, `${siteUrl}/admin.html`);
      else slack.notify({ title: `📧 ${name} sent`, fields: [['Recipients', sent], ['Subject', probe.subject], ['Events', probe.total]] });
    }
    // Referral rewards, once Monday's issue is out (never throws).
    if (!weekend) await rewards.run(refs.counts);
    return { ok: failures.length === 0, ...record, refused: refusedEmails.map(r => r.email), errors: failures.slice(0, 3) };
  }

  app.post('/api/subscribe', async (req, res) => {
    if (!supported) return res.status(503).json({ ok: false, message: 'Signups are paused. Try again soon.' });
    const ip = req.ip || req.socket.remoteAddress || '';
    if (!subscribeLimiter.check(ip).ok) return res.status(429).json({ ok: false, message: 'Too many tries. Try again later.' });
    const body = req.body || {};
    // Honeypot: a hidden field people never fill. Pretend it worked.
    if (body.company) return res.json({ ok: true });
    const email = normalizeEmail(body.email);
    // Logged without the address: enough to tell a typo from a bot-check
    // failure ([turnstile] rejected) when a signup is turned away.
    if (!email) {
      console.warn('[newsletter] signup rejected: invalid email');
      return res.status(400).json({ ok: false, message: 'Enter a valid email address.' });
    }
    // The bot check. A token that fails is a 400. No token at all usually
    // means the check never loaded (the Facebook/Instagram in-app browser,
    // where ad taps land, lost about 1 in 9 signups this way on Oct 7), so
    // that signup isn't refused: it gets a confirmation email instead, the
    // same as a comeback. A real reader taps it; an address a bot typed in
    // never gets on the list.
    const human = await verifyHuman(req);
    const hasToken = Boolean(body['cf-turnstile-response'] || body.turnstile_token);
    if (!human && hasToken) return res.status(400).json({ ok: false, error: 'turnstile-failed', message: "We couldn't confirm you're not a bot. Please try again." });
    const unverified = !human;
    if (unverified) console.warn('[newsletter] signup without a bot-check token: sending a confirmation email instead');
    // Every outcome (new, waiting to confirm, already subscribed) gets the
    // same answer, so the form can't be used to find out who's on the list.
    // Whether it was a first signup is the browser's to know (docs/track.js
    // Lead), not the server's to say.
    // A referral link (/r/<code>) the browser carried to this form. It only
    // credits an active subscriber, and never the referrer's own inbox (a
    // +tag or Gmail dots make another address for it).
    let referredBy = null;
    const ref = normalizeRefCode(body.ref);
    if (ref && typeof store.getReferrer === 'function') {
      try {
        const referrer = await store.getReferrer(ref);
        if (referrer && emailKey(referrer.email) !== emailKey(email)) referredBy = referrer.ref_code;
      } catch (err) {
        console.warn('[newsletter] referral lookup failed:', err.message);
      }
    }
    // Unverified signups and any signup carrying a referral code all get the
    // confirm message, whatever the address's state or whose code it is, so
    // the form can't tell anyone who's subscribed or who owns a code.
    const almost = { ok: true, message: 'Almost there! Check your inbox and tap Confirm to start getting it.' };
    const confirmFirst = unverified || Boolean(ref);
    const done = confirmFirst && config.enabled
      ? almost
      : { ok: true, message: config.enabled ? "You're on the list! Check your inbox." : "You're on the list! Look for us Monday and Thursday mornings." };
    try {
      const source = signupSource(body.source);
      const sub = await store.addSubscriber({ email, source, referredBy });
      if (sub.status === 'active') return res.json(done);
      // A referred address still waiting to confirm stays that way when it's
      // sent again without the code: only its inbox can put it on the list.
      // The answer doesn't change (that would tell anyone it's waiting).
      const needsConfirm = confirmFirst || Boolean(sub.referred_by);
      // Single opt-in: a new address is on the list right away and gets the
      // welcome email (with its unsubscribe link) now. One of the first two
      // ad-driven signups never finished the confirmation step, and the Turnstile
      // check, honeypot and rate limit already keep out junk. The exception
      // is a comeback (old_tokens): someone who unsubscribed must confirm
      // from their own inbox, so nobody else can sign them back up. So does a
      // friend from a referral link: a made-up address can't tap Confirm, so
      // it never counts toward a reward.
      const comeback = (sub.old_tokens || []).length > 0;
      if ((!comeback && !needsConfirm) || !config.enabled) {
        const confirmed = await store.confirmSubscriber(sub.token);
        // Not awaited: the welcome email shouldn't hold up the form.
        if (confirmed && confirmed.newly_confirmed) welcome(confirmed);
        return res.json(done);
      }
      // A few confirmation emails per inbox a day, whoever asks (a +tag or
      // Gmail dots don't make a new inbox), so the form can't be used to
      // flood someone's inbox.
      if (!confirmLimiter.check(inboxKey(email)).ok) return res.json(done);
      if (unverified && !unverifiedLimiter.check('all').ok) {
        console.warn('[newsletter] hourly cap on confirmation emails for signups without a bot check reached');
        return res.json(done);
      }
      const confirmUrl = `${siteUrl}/subscribe/confirm?token=${encodeURIComponent(sub.token)}`;
      const mail = renderConfirmEmail({ siteUrl, confirmUrl, address: config.address });
      // Same answer whether or not the email went: a failure here must not
      // tell anyone this address needed confirming (an unsubscribed or
      // waiting address) when a new one gets "You're on the list".
      try {
        await resend.send({ from: config.from, to: [email], subject: mail.subject, html: mail.html, text: mail.text });
      } catch (err) {
        console.error('[newsletter] confirmation email failed:', err.message);
        if (slack) slack.alert('newsletter-subscribe-failed', 'Newsletter confirmation emails are failing', err.message, `${siteUrl}/admin.html`);
      }
      res.json(done);
    } catch (err) {
      console.error('[newsletter] subscribe failed:', err.message);
      // Usually Resend (key rotated, domain unverified, outage): every signup
      // fails until someone looks, so tell the owner (de-duplicated by key).
      if (slack) slack.alert('newsletter-subscribe-failed', 'Newsletter signups are failing', err.message, `${siteUrl}/admin.html`);
      res.status(500).json({ ok: false, message: 'Something went wrong. Try again.' });
    }
  });

  async function welcome(sub) {
    if (slack) slack.notify({ channel: 'hype', title: '📬 New newsletter subscriber', fields: [['Email', sub.email], ...(sub.source ? [['From', sub.source]] : []),
      ...(sub.referred_by ? [['Referred by', sub.referred_by]] : [])] });
    if (!config.enabled || !config.address) return; // never send without the required mailing address
    try {
      const payload = await getPublicPayload();
      const unsubscribeUrl = `${siteUrl}/unsubscribe?token=${encodeURIComponent(sub.token)}`;
      const referral = await referralFor(sub);
      const mail = renderWelcomeEmail(payload.events, { siteUrl, now: nowFn(), sponsor: payload.sponsor, unsubscribeUrl, address: config.address, referral, replyAsk: Boolean(config.replyTo || config.inbound) });
      await resend.send({
        from: config.from, to: [sub.email], subject: mail.subject, html: mail.html, text: mail.text,
        ...(config.replyTo ? { reply_to: config.replyTo } : {}),
        headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
      // One key per confirmation: a comeback's welcome (new token, new
      // unsubscribe link) isn't a repeat of the first one, and reusing the
      // key would make Resend refuse it.
      }, `vic361-welcome-${sub.id || sub.token}-${new Date(sub.confirmed_at || 0).getTime() || 0}`);
    } catch (err) {
      console.warn('[newsletter] welcome email failed:', err.message);
      // The signup is saved either way, but with single opt-in this is the
      // only email a new subscriber gets before Monday: a broken Resend key
      // or domain should reach the owner (de-duplicated by key).
      if (slack) slack.alert('newsletter-welcome-failed', 'Newsletter welcome emails are failing', err.message, `${siteUrl}/admin.html`);
    }
  }

  // Open tracking pixel. Always answers the image (an email client showing
  // a broken image would look bad), never cached, so each open asks again.
  // Opens are counted once per subscriber per issue (store.recordEmailOpen
  // ignores ids that aren't subscribers). Apple Mail loads images for its
  // users in the background and some work mail scanners do too, so the
  // rate reads higher than real opens; the admin tab says so.
  // Only issues from the last six months count, and each IP has an hourly
  // cap, so made-up URLs can't pad the table.
  app.get('/email/o/:week/:file', (req, res) => {
    const m = /^([A-Za-z0-9-]{8,64})\.gif$/.exec(req.params.file);
    const week = req.params.week;
    const today = localDateStr(nowFn());
    // A weekend issue is keyed by its Thursday, so one sent early in the
    // week has a key up to 3 days ahead.
    const recent = /^\d{4}-\d{2}-\d{2}$/.test(week) && week <= addDays(today, 3) && week >= addDays(today, -183);
    if (m && recent && pixelLimiter.check(req.ip || '').ok && supported && typeof store.recordEmailOpen === 'function') {
      store.recordEmailOpen({ week_key: req.params.week, subscriber_id: m[1] })
        .catch(err => console.warn('[newsletter] recording an open failed:', err.message));
    }
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, private', 'Content-Length': String(PIXEL_GIF.length) });
    res.end(PIXEL_GIF);
  });

  // Referral links. The code rides along to the signup form in the URL
  // (docs/track.js keeps it for the visit); nothing is looked up here, so
  // the link can't be used to check whose code is whose.
  app.get('/r/:code', (req, res) => {
    const code = normalizeRefCode(req.params.code);
    res.set('Cache-Control', 'no-store');
    res.redirect(302, code ? `/subscribe?ref=${code}` : '/subscribe');
  });

  // The referral program's official rules (the monthly drawing needs them).
  app.get('/referral-rules', (req, res) => {
    res.type('html').send(renderReferralRules({ siteUrl }));
  });

  app.get('/subscribe', async (req, res, next) => {
    try {
      const payload = await getPublicPayload();
      let count = 0;
      if (supported) { try { count = (await store.countSubscribers()).active || 0; } catch { /* page still works */ } }
      res.set('Cache-Control', 'public, max-age=300');
      // withNav (server/index.js) adds the seasonal tabs other pages get.
      const invited = Boolean(normalizeRefCode(req.query.ref));
      res.type('html').send(await withNav(renderSubscribePage(payload.events, { siteUrl, now: nowFn(), subscriberCount: count, invited }), '/subscribe'));
    } catch (err) {
      next(err);
    }
  });

  const findByToken = async (token) => {
    if (!supported || !token || typeof store.getSubscriberByToken !== 'function') return null;
    try { return await store.getSubscriberByToken(token); } catch { return null; }
  };
  const buttonPage = (path, title, lead, token, label) => layout({
    siteUrl, path, nav: null, noindex: true, pixel: false, title: `${title} | ${SITE_NAME}`, description: title,
    body: `<h1 class="page-title">${escHtml(title)}</h1><p class="page-lead">${lead}</p>
<form method="post" action="${path}?token=${encodeURIComponent(token)}"><button class="btn btn--primary" type="submit">${escHtml(label)}</button></form>`
  });

  // GET only shows a button: mail link scanners (Safe Links, Mimecast) open
  // every link, and a GET that confirmed would sign up people who never
  // clicked. The person's tap on the button is the opt-in.
  app.get('/subscribe/confirm', async (req, res) => {
    const token = String(req.query.token || '');
    const sub = await findByToken(token);
    if (supported && typeof store.getSubscriberByToken === 'function' && (!sub || sub.status === 'unsubscribed')) {
      return res.status(404).type('html').send(page('Link expired', 'That confirmation link isn\'t valid anymore. <a href="/subscribe">Sign up again</a>.'));
    }
    if (sub && sub.status === 'active') {
      return res.type('html').send(page("You're subscribed", 'The week\'s events will land in your inbox every Monday morning, and the weekend\'s every Thursday.'));
    }
    res.type('html').send(buttonPage('/subscribe/confirm', 'Confirm your subscription',
      'One tap and the week\'s events land in your inbox every Monday morning, and the weekend\'s every Thursday.', token, 'Confirm my subscription'));
  });

  app.post('/subscribe/confirm', async (req, res) => {
    const sub = supported ? await store.confirmSubscriber(String(req.query.token || '')) : null;
    // Only the first confirm: a second click on the same link sends nothing.
    if (sub && sub.newly_confirmed) welcome(sub);
    res.status(sub ? 200 : 404).type('html').send(sub
      ? page("You're subscribed", 'The week\'s events will land in your inbox every Monday morning, and the weekend\'s every Thursday.')
      : page('Link expired', 'That confirmation link isn\'t valid anymore. <a href="/subscribe">Sign up again</a>.'));
  });

  app.get('/unsubscribe', async (req, res) => {
    const token = String(req.query.token || '');
    // GET only shows a button: link scanners in mail systems follow GETs.
    // It names the (masked) address, so someone reading a forwarded copy can
    // see the link belongs to whoever forwarded it.
    const sub = await findByToken(token);
    const who = sub && sub.email ? ` for <strong>${escHtml(maskEmail(sub.email))}</strong>` : '';
    const forwarded = sub && sub.email ? ' <small>Not your address? This email was forwarded to you; <a href="/subscribe">sign up for your own</a> instead.</small>' : '';
    res.type('html').send(buttonPage('/unsubscribe', 'Unsubscribe', `Stop The Vic 361 newsletter${who}?${forwarded}`, token, 'Unsubscribe'));
  });

  // Also the RFC 8058 one-click endpoint mail clients POST to.
  app.post('/unsubscribe', async (req, res) => {
    const ok = supported ? await store.unsubscribe(String(req.query.token || '')) : false;
    res.status(ok ? 200 : 404).type('html').send(ok
      ? page("You're unsubscribed", 'You won\'t get any more newsletters. You can <a href="/subscribe">sign up again</a> anytime.')
      : page('Link expired', 'That unsubscribe link isn\'t valid.'));
  });

  // Email settings: keep or skip the Thursday weekend issue. GET shows the
  // choice (link scanners follow GETs), POST makes it.
  const prefsPage = (sub, token, note = '') => {
    const off = Boolean(sub.weekend_optout);
    const action = `/email-prefs?token=${encodeURIComponent(token)}&weekend=${off ? '1' : '0'}`;
    return layout({
      siteUrl, path: '/email-prefs', nav: null, noindex: true, pixel: false, title: `Email settings | ${SITE_NAME}`, description: 'Email settings',
      body: `<h1 class="page-title">Email settings</h1>${note ? `<p class="page-lead"><strong>${escHtml(note)}</strong></p>` : ''}
<p class="page-lead">For <strong>${escHtml(maskEmail(sub.email))}</strong>: the Monday issue (the whole week) ${off ? 'only' : 'and the Thursday weekend issue (Friday to Sunday)'}.</p>
<form method="post" action="${action}"><button class="btn btn--primary" type="submit">${off ? 'Get the weekend issue too' : 'Just Mondays, skip the weekend issue'}</button></form>
<p><small>Want nothing at all? <a href="/unsubscribe?token=${encodeURIComponent(token)}">Unsubscribe</a>.</small></p>`
    });
  };
  app.get('/email-prefs', async (req, res) => {
    const token = String(req.query.token || '');
    const sub = supported && typeof store.setWeekendOptout === 'function' ? await findByToken(token) : null;
    res.set('Cache-Control', 'no-store');
    if (!sub || sub.status !== 'active') return res.status(404).type('html').send(page('Link expired', 'That link isn\'t valid anymore. <a href="/subscribe">Sign up again</a>.'));
    res.type('html').send(prefsPage(sub, token));
  });
  app.post('/email-prefs', async (req, res) => {
    const token = String(req.query.token || '');
    let sub = null;
    // Only an active subscriber's setting changes (a pending comeback's
    // link waits until they've confirmed).
    const current = supported && typeof store.setWeekendOptout === 'function' ? await findByToken(token) : null;
    if (current && current.status === 'active') {
      try { sub = await store.setWeekendOptout(token, String(req.query.weekend) === '0'); } catch (err) { console.warn('[newsletter] email settings failed:', err.message); }
    }
    res.set('Cache-Control', 'no-store');
    if (!sub || sub.status !== 'active') return res.status(404).type('html').send(page('Link expired', 'That link isn\'t valid anymore. <a href="/subscribe">Sign up again</a>.'));
    res.type('html').send(prefsPage(sub, token, sub.weekend_optout ? 'Done: just Mondays from now on.' : 'Done: you\'ll get the weekend issue on Thursdays too.'));
  });

  app.get('/api/admin/newsletter', requireAdmin, async (req, res) => {
    if (!supported) return res.json({ ok: false, error: 'not-supported' });
    const counts = await store.countSubscribers();
    // Two issues a week: 16 is the last eight weeks.
    let sends = await store.listNewsletterSends(16);
    // Unique opens per issue. A failed read leaves them off, not the tab.
    if (typeof store.countEmailOpens === 'function' && sends.length) {
      try {
        const opens = await store.countEmailOpens(sends.map(x => x.week_key));
        sends = sends.map(x => ({ ...x, opens: opens[x.week_key] || 0 }));
      } catch (err) {
        console.warn('[newsletter] reading opens failed:', err.message);
      }
    }
    const payload = await getPublicPayload();
    const now = nowFn();
    const issue = renderWeekly(payload.events, { siteUrl, now, sponsor: payload.sponsor, unsubscribeUrl: '#', address: config.address });
    // A week whose send partly failed isn't "sent": the button stays on to
    // retry just the people who missed it (sendWeekly resumes).
    // Top referrers and their rewards (emails shown in full: this is the
    // owner's admin, and a held reward needs a person to look at it).
    let referrers = [], referralRewards = [];
    if (typeof store.topReferrers === 'function') {
      try { referrers = await store.topReferrers(10); } catch (err) { console.warn('[newsletter] reading referrers failed:', err.message); }
    }
    try {
      referralRewards = (await rewards.list(20)).map(r => ({ id: r.id, email: r.email, what: rewards.describe(r), status: r.status,
        flags: r.flags, reason: r.reason, created_at: r.created_at }));
    } catch (err) { console.warn('[newsletter] reading referral rewards failed:', err.message); }
    // This week's two issues, and how many skip Thursday's.
    const today = localDateStr(now);
    const [record, wkRecord, optedOut] = await Promise.all([
      store.getNewsletterSend(EDITIONS.weekly.key(today)),
      store.getNewsletterSend(EDITIONS.weekend.key(today)),
      typeof store.countWeekendOptouts === 'function' ? store.countWeekendOptouts().catch(() => 0) : 0
    ]);
    const failed = failedCount(record);
    const wkFailed = failedCount(wkRecord);
    const wkIssue = renderWeekly(payload.events, { siteUrl, now, sponsor: payload.sponsor, unsubscribeUrl: '#', address: config.address, edition: 'weekend' });
    res.json({
      ok: true, configured: config.enabled, from: config.from, address_set: Boolean(config.address),
      autosend: config.enabled && config.autosend, counts, next: { subject: issue.subject, events: issue.total },
      referrers, referral_tiers: REFERRAL_TIERS, referral_rewards: referralRewards,
      gift_cards: tremendous && tremendous.enabled ? 'tremendous' : 'manual',
      this_week_sent: Boolean(record) && !failed,
      this_week_failed: failed,
      this_week_recipients: record ? Number(record.recipients) || 0 : 0,
      weekend: {
        enabled: config.weekend, opted_out: optedOut, next: { subject: wkIssue.subject, events: wkIssue.total },
        sent: Boolean(wkRecord) && !wkFailed, failed: wkFailed, recipients: wkRecord ? Number(wkRecord.recipients) || 0 : 0
      },
      sends: sends.map(x => ({ ...x, edition: editionOf(x.week_key) }))
    });
  });

  const editionParam = v => (v === 'weekend' ? 'weekend' : 'weekly');
  app.get('/api/admin/newsletter/preview', requireAdmin, async (req, res) => {
    const payload = await getPublicPayload();
    const issue = renderWeekly(payload.events, { siteUrl, now: nowFn(), sponsor: payload.sponsor, unsubscribeUrl: '#', address: config.address, replyAsk: Boolean(config.replyTo || config.inbound),
      edition: editionParam(req.query.edition), prefsUrl: config.weekend ? '#' : '' });
    res.type('html').send(issue.html);
  });

  app.post('/api/admin/newsletter/test', requireAdmin, async (req, res) => {
    if (!config.enabled) return res.status(503).json({ ok: false, error: 'not-configured' });
    const to = normalizeEmail((req.body || {}).email) || normalizeEmail(config.testTo);
    if (!to) return res.status(400).json({ ok: false, error: 'no-test-address', message: 'Enter an address to send the test to.' });
    try {
      const payload = await getPublicPayload();
      const issue = renderWeekly(payload.events, { siteUrl, now: nowFn(), sponsor: payload.sponsor, unsubscribeUrl: `${siteUrl}/unsubscribe`, address: config.address, replyAsk: Boolean(config.replyTo || config.inbound),
        edition: editionParam((req.body || {}).edition), prefsUrl: config.weekend ? `${siteUrl}/email-prefs` : '' });
      await resend.send({ from: config.from, to: [to], subject: `[Test] ${issue.subject}`, html: issue.html, text: issue.text, ...(config.replyTo ? { reply_to: config.replyTo } : {}) });
      res.json({ ok: true, to });
    } catch (err) {
      res.status(502).json({ ok: false, error: 'send-failed', message: err.message });
    }
  });

  // A held, failed or by-hand referral reward: send it now, or skip it.
  app.post('/api/admin/newsletter/rewards/:id/:action', requireAdmin, async (req, res) => {
    const { id, action } = req.params;
    if (!['approve', 'skip'].includes(action)) return res.status(404).json({ ok: false, message: 'Unknown action.' });
    try {
      const out = action === 'approve' ? await rewards.approve(id) : await rewards.skip(id);
      res.status(out.status).json({ ok: out.ok, message: out.message, reward: out.reward });
    } catch (err) {
      console.error('[referrals] admin reward action failed:', err.message);
      res.status(503).json({ ok: false, message: `Couldn't update the reward: ${err.message}` });
    }
  });

  app.post('/api/admin/newsletter/send', requireAdmin, async (req, res) => {
    try {
      const out = await sendWeekly({ force: Boolean((req.body || {}).force), edition: editionParam((req.body || {}).edition) });
      if (!out.ok && out.failed) out.message = `Sent to ${out.recipients}, but ${out.failed} failed (${(out.errors || [])[0] || 'email service error'}). Press Retry to send to the rest.`;
      res.status(out.ok ? 200 : (out.error === 'not-configured' ? 503 : 409)).json(out);
    } catch (err) {
      res.status(500).json({ ok: false, error: 'send-failed', message: err.message });
    }
  });

  app.post('/api/admin/newsletter/import', requireAdmin, async (req, res) => {
    const raw = String((req.body || {}).emails || '');
    const emails = [...new Set(raw.split(/[\s,;]+/).map(normalizeEmail).filter(Boolean))];
    if (!emails.length) return res.status(400).json({ ok: false, message: 'No valid email addresses found.' });
    const result = await store.importSubscribers(emails, 'import');
    res.json({ ok: true, ...result });
  });

  // The automatic Monday send, from the site scheduler or the cron
  // endpoint. `ok` means done for this week (sent, already sent, nothing to
  // send); `final` means retrying won't help (setup missing).
  async function scheduledSend(edition = 'weekly') {
    const weekend = edition === 'weekend';
    const out = await sendWeekly({ edition });
    // Same Monday run: last week's sponsors get their click reports
    // (server/sponsors.js sendSponsorReports; safe to call more than once).
    if (onCron && !weekend) {
      try { out.sponsor_reports = await onCron(nowFn()); } catch (err) {
        console.error('[newsletter] sponsor reports failed:', err.message);
        if (slack) slack.alert('sponsor-reports', 'Sponsor click reports failed', err.message, `${siteUrl}/admin.html`);
      }
    }
    // The automatic send found nothing published for the days it covers.
    if (slack && out.error === 'no-events') {
      slack.alert(`newsletter-no-events${weekend ? '-weekend' : ''}`,
        weekend ? 'Weekend newsletter skipped: nothing published for Friday to Sunday' : 'Newsletter skipped: nothing published for this week',
        'Publish the events in admin, then send it from the Newsletter tab.', `${siteUrl}/admin.html`);
    }
    if (slack && out.error === 'no-address') {
      slack.alert('newsletter-no-address', 'Newsletter not sent: no mailing address', out.message, `${siteUrl}/admin.html`);
    }
    const done = out.ok || ['already-sent', 'no-events', 'no-subscribers', 'in-progress', 'weekend-off'].includes(out.error);
    return { ...out, edition, ok: done, sent_ok: out.ok, final: ['not-configured', 'no-address', 'weekend-off'].includes(out.error) };
  }

  // Scheduled send (GitHub Actions fallback, newsletter.yml). Needs the
  // shared secret; refuses when no secret is configured so the endpoint
  // can't be triggered by anyone. A run marked X-Cron-Scheduled honors
  // NEWSLETTER_AUTOSEND=0; a hand-started run sends regardless.
  app.post('/api/newsletter/cron', async (req, res) => {
    const given = Buffer.from(String(req.get('x-cron-secret') || ''));
    const want = Buffer.from(config.cronSecret || '');
    // Compare byte lengths: timingSafeEqual throws on a length mismatch,
    // and a non-ASCII header has more bytes than characters.
    const ok = want.length > 0 && given.length === want.length && crypto.timingSafeEqual(given, want);
    if (!ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (req.get('x-cron-scheduled') === '1' && !config.autosend) {
      return res.json({ ok: false, error: 'autosend-off', message: 'NEWSLETTER_AUTOSEND=0 in Railway; not sending automatically.' });
    }
    try {
      // newsletter.yml sends X-Newsletter-Edition: weekend on Thursdays.
      const { ok: done, sent_ok: sentOk, final: _f, ...out } = await scheduledSend(req.get('x-newsletter-edition') === 'weekend' ? 'weekend' : 'weekly');
      // already-sent / no-events are normal outcomes for a cron, not failures.
      res.status(done ? 200 : 500).json({ ...out, ok: sentOk });
    } catch (err) {
      if (slack) slack.alert('newsletter-cron', 'Newsletter send crashed', err.message);
      res.status(500).json({ ok: false, error: 'send-failed', message: err.message });
    }
  });

  // One reminder, a day after signing up, to anyone who got the "tap to
  // confirm" email and hasn't (the Facebook in-app browser sometimes skips
  // the bot check, and those signups have to confirm). Only signups from
  // the last week, so old pending rows aren't dug up. Hourly, from the
  // scheduler's health job; claims each row first so it's sent once.
  async function sendConfirmReminders(now = nowFn()) {
    if (!supported || !config.enabled || !config.address || typeof store.listConfirmReminders !== 'function') return { sent: 0 };
    const t = now.getTime();
    const due = await store.listConfirmReminders({
      from: new Date(t - 7 * 24 * 3600e3).toISOString(), to: new Date(t - 24 * 3600e3).toISOString(), limit: 50
    });
    let sent = 0;
    for (const sub of due) {
      if (!(await store.markReminded(sub.id))) continue;
      try {
        const confirmUrl = `${siteUrl}/subscribe/confirm?token=${encodeURIComponent(sub.token)}`;
        const mail = renderConfirmEmail({ siteUrl, confirmUrl, address: config.address, reminder: true });
        await resend.send({ from: config.from, to: [sub.email], subject: mail.subject, html: mail.html, text: mail.text }, `vic361-remind-${sub.id}`);
        sent++;
      } catch (err) {
        console.warn('[newsletter] confirm reminder failed:', err.message);
        try { await store.markReminded(sub.id, false); } catch { /* tried again next hour or never */ }
      }
    }
    if (sent) console.log(`[newsletter] sent ${sent} confirm reminder(s)`);
    return { sent };
  }

  return { sendWeekly, scheduledSend, sendConfirmReminders };
}
