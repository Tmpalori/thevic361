/* server/newsletter.js — Own email newsletter, sent through Resend.
 *
 * The homepage signup form always shows. Until RESEND_API_KEY is set,
 * signups are saved straight to the list (nothing can be emailed yet, so
 * there's no confirmation step); once it's set, signups are double opt-in.
 *
 *   - Signup: POST /api/subscribe → pending subscriber + confirmation email
 *     (double opt-in, so nobody can sign up someone else). Forms say where
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
 *   - The weekly email is built from the published events (sponsor block
 *     first, then this week, featured first; links back to the site carry
 *     utm_source=newsletter) and sent with Resend's batch API,
 *     each copy with its own unsubscribe link. One send per week: a second
 *     attempt for the same week is refused unless forced.
 *   - Admin: counts, preview, test send, send now, CSV/paste import.
 *   - Automation: POST /api/newsletter/cron with X-Cron-Secret, called by
 *     .github/workflows/newsletter.yml on Monday mornings. The same run
 *     sends last week's sponsor reports and any Vic's Pick reports due
 *     (onCron, server/sponsors.js).
 */

import crypto from 'node:crypto';
import {
  SITE_NAME, escHtml, safeUrl, localDateStr, currentWeek, formatDay, sortEvents, layout, addDays, renderEventItem, pickRank,
  sponsorLinkUrl
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
    testTo: overrides.newsletterTestTo ?? env.NEWSLETTER_TEST_TO ?? ''
  };
  c.enabled = Boolean(c.apiKey);
  // The one switch for the automatic Monday send (Railway variable): on
  // unless NEWSLETTER_AUTOSEND=0. The site's scheduler (server/scheduler.js)
  // sends at 7:43 AM Central; newsletter.yml's late GitHub cron is only a
  // fallback and is told no when this is off.
  c.autosend = String(overrides.newsletterAutosend ?? env.NEWSLETTER_AUTOSEND ?? '1') !== '0';
  return c;
}

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

export function emailShell({ title, preheader, bodyHtml, footerHtml, siteUrl }) {
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
</table></td></tr></table></body></html>`);
}

function footer({ siteUrl, unsubscribeUrl, address }) {
  const a = 'color:#FFC93C;';
  return `Forwarded this? <a href="${siteUrl}/subscribe" style="${a}">Get it free every Monday</a>.<br>
You're getting this because you subscribed at <a href="${siteUrl}" style="${a}">thevic361.com</a>.<br>
<a href="${escHtml(unsubscribeUrl)}" style="${a}">Unsubscribe</a> · <a href="${siteUrl}/advertise" style="${a}">Advertise</a> · <a href="${siteUrl}/submit" style="${a}">Submit an event</a><br>
${escHtml(SITE_NAME)}${address ? ` · ${escHtml(address)}` : ' · Victoria, TX'}`;
}

function iconImgs(ev, siteUrl) {
  return (ev.icons || []).filter(k => ICON_KEYS.has(k)).slice(0, 3)
    .map(k => `<img src="${siteUrl}/email/${k}.png" width="22" height="22" alt="" style="vertical-align:middle;border:0;margin-right:2px;">`).join('');
}

export function eventRow(ev, siteUrl) {
  const link = ev.page ? `${siteUrl}${ev.page}` : (safeUrl(ev.url) || siteUrl);
  const where = [ev.venue].filter(Boolean).join('');
  const rowStyle = ev.featured
    ? `padding:10px 12px;background:${C.sunLight};border:2px solid ${C.ink};border-radius:12px;`
    : `padding:10px 4px;border-bottom:2px dashed ${C.line};`;
  return `<tr><td style="${rowStyle}">
${ev.featured ? `<span style="display:inline-block;background:${C.sunset};color:${C.ink};font-family:${DISPLAY};font-size:11px;font-weight:bold;padding:1px 8px;border:2px solid ${C.ink};border-radius:999px;margin-right:4px;">★ VIC’S PICK</span>` : ''}
${iconImgs(ev, siteUrl)}
${ev.time ? `<span style="display:inline-block;font-family:${DISPLAY};font-weight:bold;font-size:12px;padding:0 8px;border:2px solid ${C.ink};border-radius:999px;margin-right:4px;">${escHtml(ev.time)}</span>` : ''}
<a href="${escHtml(link)}" style="color:${C.ink};font-weight:800;text-decoration:none;">${escHtml(ev.name)}</a>${where ? ` <span style="color:${C.muted};">· ${escHtml(where)}</span>` : ''}${ev.free === true && !(ev.icons || []).includes('free') ? ` <span style="color:#2FA876;font-size:13px;font-weight:bold;">· Free</span>` : ''}
${ev.description ? `<div style="color:${C.muted};font-size:13px;margin-top:2px;">${escHtml(ev.description)}</div>` : ''}
</td></tr>`;
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
    if (/^\/(unsubscribe|subscribe\/confirm|go\/|email\/|sponsor-logo\/)/.test(rest)) return url;
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
  const logo = sponsor && /^\/sponsor-logo\/[A-Za-z0-9-]{8,64}$/.test(sponsor.logo || '') ? `${siteUrl}${sponsor.logo}` : '';
  return sponsor && sponsor.name ? `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:${C.sunLight};border:3px dashed ${C.ink};border-radius:16px;"><tr><td style="padding:14px 16px;">
<span style="display:inline-block;font-family:${DISPLAY};font-size:11px;font-weight:bold;letter-spacing:.5px;background:${C.sunset};color:${C.ink};border:2px solid ${C.ink};border-radius:999px;padding:1px 10px;">THIS WEEK'S SPONSOR</span>
${logo ? `<div style="margin:8px 0 2px;"><img src="${escHtml(logo)}" alt="${escHtml(sponsor.name)}" style="display:block;max-height:60px;max-width:200px;height:auto;border:0;"></div>` : ''}
<div style="font-family:${DISPLAY};font-size:20px;font-weight:bold;margin:6px 0 2px;">${escHtml(sponsor.name)}</div>
${sponsor.text ? `<div style="font-size:14px;">${escHtml(sponsor.text)}</div>` : ''}
${safeUrl(sponsor.url) && sponsor.cta ? `<a href="${escHtml(sponsorHref(sponsor, siteUrl, src))}" style="display:inline-block;margin-top:10px;background:#fff;color:${C.ink};font-family:${DISPLAY};font-weight:bold;padding:6px 14px;border:2px solid ${C.ink};border-radius:999px;text-decoration:none;">${escHtml(sponsor.cta)} →</a>` : ''}
</td></tr></table>` : '';
}

// The weekly issue: the rest of this week (today through Sunday).
export function renderWeekly(events, { siteUrl, now, sponsor, unsubscribeUrl, address }) {
  const today = localDateStr(now);
  const week = currentWeek(today).filter(d => d >= today);
  const byDay = week.map(d => ({ d, list: sortEvents(events.filter(e => e.date === d)) })).filter(x => x.list.length);
  const total = byDay.reduce((n, x) => n + x.list.length, 0);
  const short = d => formatDay(d, { month: 'short', day: 'numeric' });
  const range = week.length ? (week.length === 1 ? short(week[0]) : `${short(week[0])}–${short(week[week.length - 1])}`) : '';
  const subject = `This week in Victoria: ${total} ${total === 1 ? 'thing' : 'things'} to do (${range})`;
  // Paid Vic's Picks lead, then editor's picks (pickRank), then the rest.
  const highlights = byDay.flatMap(x => x.list).filter(e => e.featured).sort((a, b) => pickRank(a) - pickRank(b))
    .concat(byDay.flatMap(x => x.list)).map(e => e.name);
  const preheader = [...new Set(highlights)].slice(0, 3).join(' · ');

  // Day colors follow the weekday (Monday yellow ... Sunday coral), like the site.
  const days = byDay.map(({ d, list }) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;border:3px solid ${C.ink};border-radius:16px;overflow:hidden;border-collapse:separate;">
<tr><td style="background:${DAY_COLORS[(currentWeek(d).indexOf(d) + 7) % 7]};padding:10px 14px;border-bottom:3px solid ${C.ink};font-family:${DISPLAY};color:${C.ink};">
<span style="font-size:21px;font-weight:bold;">${escHtml(formatDay(d, { weekday: 'long' }))}</span>
<span style="display:inline-block;margin-left:6px;font-size:13px;font-weight:bold;background:#fff;border:2px solid ${C.ink};border-radius:999px;padding:0 9px;">${escHtml(formatDay(d, { month: 'long', day: 'numeric' }))}</span></td></tr>
<tr><td style="padding:6px 12px 10px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;">${list.slice(0, PER_DAY).map(e => eventRow(e, siteUrl)).join('')}</table>
${list.length > PER_DAY ? `<p style="margin:8px 0 0;font-size:13px;font-weight:bold;"><a href="${siteUrl}/" style="color:${C.accent};">+${list.length - PER_DAY} more on ${escHtml(formatDay(d, { weekday: 'long' }))} →</a></p>` : ''}
</td></tr></table>`).join('');

  const sponsorBlock = sponsorHtml(sponsor, siteUrl);

  const pill = (href, label) => `<a href="${siteUrl}${href}" style="display:inline-block;margin:6px 4px 0 0;font-family:${DISPLAY};font-weight:bold;font-size:13px;color:${C.ink};background:#fff;border:2px solid ${C.ink};border-radius:999px;padding:2px 10px;text-decoration:none;">${label}</a>`;
  const bodyHtml = `
<p style="margin:16px 0 4px;font-size:16px;">${total ? `Here's what's happening in Victoria, TX this week: <strong>${total} ${total === 1 ? 'event' : 'events'}</strong>.` : 'Nothing is listed yet for the rest of this week.'}</p>
<div>${pill('/this-weekend', 'This weekend')}${pill('/free-things-to-do', 'Free')}${pill('/kids-and-family', 'Kids')}${pill('/live-music', 'Live music')}</div>
${sponsorBlock}${days}
<p style="margin:28px 0 0;text-align:center;">${btn(`${siteUrl}/`, 'See the full list')}</p>`;

  // Sponsors are sold "the top of the Monday newsletter": first in both parts.
  const sponsorLine = sponsor && sponsor.name
    ? [`THIS WEEK'S SPONSOR: ${[sponsor.name, sponsor.text, safeUrl(sponsor.url) ? sponsorHref(sponsor, siteUrl) : ''].filter(Boolean).join(' - ')}`, '']
    : [];
  const campaign = `weekly-${currentWeek(today)[0]}`;
  const text = [
    `${subject}`, '', ...sponsorLine,
    ...byDay.flatMap(({ d, list }) => [formatDay(d, { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase(),
      ...list.slice(0, PER_DAY).map(e => `- ${e.time ? e.time + ' ' : ''}${e.name}${e.venue ? ' @ ' + e.venue : ''}${e.page ? ' ' + siteUrl + e.page : ''}`), '']),
    `Full list: ${siteUrl}/`, '', `Unsubscribe: ${unsubscribeUrl}`, `${SITE_NAME} · ${address || 'Victoria, TX'}`
  ].join('\n');

  // The paid Vic's Picks this issue actually stars (shown, not cut by
  // PER_DAY), recorded with the send for their reports.
  const picks = [...new Set(byDay.flatMap(({ list }) => list.slice(0, PER_DAY))
    .filter(e => e.featured && !e.editor_pick && e.sponsor_order).map(e => e.sponsor_order))];
  return {
    subject, total, picks,
    html: utmTag(emailShell({ title: 'This week in Victoria', preheader, bodyHtml, siteUrl, footerHtml: footer({ siteUrl, unsubscribeUrl, address }) }), siteUrl, campaign),
    text: utmTag(text, siteUrl, campaign, '&')
  };
}

export function renderConfirmEmail({ siteUrl, confirmUrl, address }) {
  const bodyHtml = `<p style="margin:18px 0;font-size:16px;">Tap the button to confirm and start getting Victoria's events every week.</p>
<p style="text-align:center;">${btn(confirmUrl, 'Confirm my subscription')}</p>
<p style="color:${C.muted};font-size:13px;">Didn't sign up? Ignore this email and you won't hear from us.</p>`;
  return {
    subject: 'Confirm your Vic 361 subscription',
    html: emailShell({ title: 'One tap to confirm', preheader: 'Confirm to get Victoria events every week', bodyHtml, siteUrl,
      footerHtml: `${escHtml(SITE_NAME)} · ${escHtml(address || 'Victoria, TX')}` }),
    text: `Confirm your subscription to The Vic 361: ${confirmUrl}\n\nDidn't sign up? Ignore this email.`
  };
}

// Sent once, right after someone confirms: what to expect, a few events
// they can use now (no waiting until Monday), the sponsor, and a nudge to
// share.
const WELCOME_PICKS = 5;
export function renderWelcomeEmail(events, { siteUrl, now, sponsor, unsubscribeUrl, address }) {
  const today = localDateStr(now);
  const soon = sortEvents((events || []).filter(e => e.date >= today && e.date <= addDays(today, 6)));
  const picks = [...soon.filter(e => e.featured).sort((a, b) => pickRank(a) - pickRank(b)), ...soon.filter(e => !e.featured)].slice(0, WELCOME_PICKS);
  const dayLabel = (d) => d === today ? 'Today' : formatDay(d, { weekday: 'long' });
  const coming = picks.length ? `
<p style="margin:22px 0 6px;font-family:${DISPLAY};font-size:19px;font-weight:bold;">Coming up this week</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;">${picks.map(e =>
    eventRow({ ...e, time: [dayLabel(e.date), e.time].filter(Boolean).join(', ') }, siteUrl)).join('')}</table>
${soon.length > picks.length ? `<p style="margin:10px 0 0;font-size:13px;font-weight:bold;"><a href="${siteUrl}/" style="color:${C.accent};">+${soon.length - picks.length} more this week →</a></p>` : ''}` : '';
  const bodyHtml = `
<p style="margin:18px 0 4px;font-size:16px;"><strong>You're in!</strong> Every Monday morning you'll get the week's events in Victoria, TX: concerts, markets, festivals, family stuff and more, all in one email.</p>
${coming}${sponsorHtml(sponsor, siteUrl, 'welcome')}
<p style="margin:26px 0 0;text-align:center;">${btn(`${siteUrl}/`, "See this week's events")}</p>
<p style="margin:22px 0 0;font-size:14px;color:${C.muted};">Know someone who's always asking what there is to do in Victoria? Forward them this email or send them to <a href="${siteUrl}/" style="color:${C.accent};font-weight:bold;">thevic361.com</a>.</p>`;
  const text = [
    "You're in! Every Monday morning you'll get the week's events in Victoria, TX.", '',
    ...(picks.length ? ['COMING UP THIS WEEK', ...picks.map(e =>
      `- ${dayLabel(e.date)}${e.time ? ' ' + e.time : ''}: ${e.name}${e.venue ? ' @ ' + e.venue : ''}${e.page ? ' ' + siteUrl + e.page : ''}`), ''] : []),
    `This week's events: ${siteUrl}/`, '', `Unsubscribe: ${unsubscribeUrl}`, `${SITE_NAME} · ${address || 'Victoria, TX'}`
  ].join('\n');
  return {
    subject: 'Welcome to The Vic 361',
    html: utmTag(emailShell({ title: 'Welcome to The Vic 361', preheader: picks.length ? `Coming up: ${picks.slice(0, 3).map(e => e.name).join(' · ')}` : "Victoria's events, every Monday",
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
(window.vicTurnstile?window.vicTurnstile.token(f):Promise.resolve('')).then(function(t){return fetch('/api/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:f.email.value,company:f.company.value,turnstile_token:t,source:window.vic361Source?window.vic361Source(f.getAttribute('data-source')):f.getAttribute('data-source')})});})
.then(function(r){return r.json().catch(function(){return{};}).then(function(j){return{ok:r.ok,j:j};});})
.then(function(x){m.textContent=x.ok?(x.j.message||'Check your inbox to confirm.'):(x.j.message||'Something went wrong. Try again.');if(x.ok){f.email.value='';var was=false;try{was=localStorage.getItem('vic361-subscribed')==='1';localStorage.setItem('vic361-subscribed','1')}catch(e){}if(!was&&window.vic361Track)window.vic361Track('subscribe_click',{link_url:'form'});}})
.catch(function(){m.textContent='Something went wrong. Try again.';}).then(function(){b.disabled=false;if(window.vicTurnstile)window.vicTurnstile.reset(f);});});})();
</script>`;
}

// ─── Signup page ─────────────────────────────────────────────────────────

const SHOW_COUNT_FROM = 100; // "Join 40 locals" undersells; say nothing until it's a real crowd

// The signup page: what you get, the form, then proof (real events from
// the next seven days) for people who scroll before deciding.
export function renderSubscribePage(events, { siteUrl, now, subscriberCount = 0 }) {
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
    <p class="sub-again"><a class="btn btn--primary" href="#signup-email">Get the full list every Monday</a> <a class="btn btn--outline" href="/">See this week's events</a></p>` : '';
  const body = `
    <section class="sub-hero">
      <p class="sub-kicker">Free · Every Monday · Victoria, TX</p>
      <h1 class="page-title">Victoria's best events, in your inbox every Monday.</h1>
      <p class="page-lead">One email a week with what's going on around town: live music, festivals, markets, family days, and new spots opening.</p>
      ${signupFormHtml({ source: 'subscribe-page', button: 'Subscribe free' })}
      <p class="sub-fine">No spam, ever. Unsubscribe with one click.</p>
      ${crowd}
    </section>
    <ul class="sub-perks" role="list">
      <li><strong>Every Monday morning.</strong> The whole week, day by day, before you make plans.</li>
      <li><strong>Free things to do</strong> marked, so you can find them fast.</li>
      <li><strong>New &amp; notable:</strong> places that just opened and things you haven't heard about yet.</li>
    </ul>
    ${proof}`;
  return layout({
    siteUrl, path: '/subscribe', nav: null,
    title: `Free Weekly Events Newsletter for Victoria, TX | ${SITE_NAME}`,
    description: "Get Victoria, TX's best events in your inbox every Monday: live music, festivals, markets, family events, and new spots. Free, no spam.",
    body
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────

export function registerNewsletter(app, { store, requireAdmin, siteUrl, nowFn, getPublicPayload, getSendPayload = getPublicPayload, createRateLimiter, config, resend, slack = null, verifyHuman = async () => true, withNav = async html => html, onCron = null }) {
  const subscribeLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
  const confirmLimiter = createRateLimiter({ windowMs: 24 * 60 * 60 * 1000, max: 3 });
  const supported = typeof store.addSubscriber === 'function';

  const page = (title, message) => layout({
    siteUrl, path: '/subscribe', nav: null, noindex: true, pixel: false, title: `${title} | ${SITE_NAME}`, description: title,
    body: `<h1 class="page-title">${escHtml(title)}</h1><p class="page-lead">${message}</p><p><a class="btn btn--primary" href="/">See this week's events</a></p>`
  });

  function weekKey(now) {
    return currentWeek(localDateStr(now))[0];
  }

  // One send at a time in this process: the Monday cron and an admin
  // Send/Retry can overlap, and both would read "not sent yet" and mail
  // everyone. The second gets 'in-progress' instead.
  let sending = false;
  async function sendWeekly(opts = {}) {
    if (sending) return { ok: false, error: 'in-progress', message: 'The newsletter is going out right now. Check back in a minute.' };
    sending = true;
    try {
      return await sendWeeklyNow(opts);
    } finally {
      sending = false;
    }
  }

  async function sendWeeklyNow({ force = false } = {}) {
    if (!config.enabled) return { ok: false, error: 'not-configured' };
    // CAN-SPAM: every marketing email needs a physical postal address.
    if (!config.address) return { ok: false, error: 'no-address', message: 'Set NEWSLETTER_ADDRESS (a mailing address) before sending.' };
    const now = nowFn();
    const key = weekKey(now);
    const prior = await store.getNewsletterSend(key);
    const priorFailed = prior && Array.isArray(prior.failed_emails) ? prior.failed_emails : [];
    // Fully sent: done. Partly sent: a retry (cron or admin) only goes to
    // the people who didn't get it. Force resends to everyone.
    if (prior && !force && !priorFailed.length) return { ok: false, error: 'already-sent', sent: prior };
    const resume = Boolean(prior && !force && priorFailed.length);
    const payload = await getSendPayload();
    let subs = await store.listSubscribers({ status: 'active' });
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
    const probe = renderWeekly(payload.events, { siteUrl, now, sponsor: payload.sponsor, unsubscribeUrl: '', address: config.address });
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
    for (let i = 0; i < subs.length; i += BATCH_SIZE) {
      await progress();
      const chunk = subs.slice(i, i + BATCH_SIZE);
      const msgs = chunk.map(s => {
        const unsubscribeUrl = `${siteUrl}/unsubscribe?token=${encodeURIComponent(s.token)}`;
        const issue = renderWeekly(payload.events, { siteUrl, now, sponsor: payload.sponsor, unsubscribeUrl, address: config.address });
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
      if (failures.length) slack.alert(`newsletter-failed-${key}`, 'Newsletter send partly failed', `${sent} sent, ${record.failed} failed.\n${failures[0]}`, `${siteUrl}/admin.html`);
      else slack.notify({ title: '📧 Newsletter sent', fields: [['Recipients', sent], ['Subject', probe.subject], ['Events', probe.total]] });
    }
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
    if (!email) return res.status(400).json({ ok: false, message: 'Enter a valid email address.' });
    if (!(await verifyHuman(req))) return res.status(400).json({ ok: false, error: 'turnstile-failed', message: "We couldn't confirm you're not a bot. Please try again." });
    // Every outcome (new, waiting to confirm, already subscribed) gets the
    // same answer, so the form can't be used to find out who's on the list.
    // Whether it was a first signup is the browser's to know (docs/track.js
    // Lead), not the server's to say.
    const done = config.enabled ? { ok: true } : { ok: true, message: "You're on the list! See you Monday." };
    try {
      const source = signupSource(body.source);
      const sub = await store.addSubscriber({ email, source });
      if (sub.status === 'active') return res.json(done);
      // No email service yet: keep the signup (they asked for it on our own
      // form) and skip the confirmation email we can't send.
      if (!config.enabled) {
        await store.confirmSubscriber(sub.token);
        if (slack) slack.notify({ title: '📬 New newsletter subscriber', fields: [['Email', email], ['From', source]] });
        return res.json(done);
      }
      // A few confirmation emails per address a day, whoever asks, so the
      // form can't be used to flood someone's inbox.
      if (!confirmLimiter.check(email).ok) return res.json(done);
      const confirmUrl = `${siteUrl}/subscribe/confirm?token=${encodeURIComponent(sub.token)}`;
      const mail = renderConfirmEmail({ siteUrl, confirmUrl, address: config.address });
      await resend.send({ from: config.from, to: [email], subject: mail.subject, html: mail.html, text: mail.text });
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
    if (slack) slack.notify({ title: '📬 New newsletter subscriber', fields: [['Email', sub.email], ...(sub.source ? [['From', sub.source]] : [])] });
    if (!config.enabled || !config.address) return; // never send without the required mailing address
    try {
      const payload = await getPublicPayload();
      const unsubscribeUrl = `${siteUrl}/unsubscribe?token=${encodeURIComponent(sub.token)}`;
      const mail = renderWelcomeEmail(payload.events, { siteUrl, now: nowFn(), sponsor: payload.sponsor, unsubscribeUrl, address: config.address });
      await resend.send({
        from: config.from, to: [sub.email], subject: mail.subject, html: mail.html, text: mail.text,
        ...(config.replyTo ? { reply_to: config.replyTo } : {}),
        headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
      }, `vic361-welcome-${sub.id || sub.token}`);
    } catch (err) {
      console.warn('[newsletter] welcome email failed:', err.message);
    }
  }

  app.get('/subscribe', async (req, res, next) => {
    try {
      const payload = await getPublicPayload();
      let count = 0;
      if (supported) { try { count = (await store.countSubscribers()).active || 0; } catch { /* page still works */ } }
      res.set('Cache-Control', 'public, max-age=300');
      // withNav (server/index.js) adds the seasonal tabs other pages get.
      res.type('html').send(await withNav(renderSubscribePage(payload.events, { siteUrl, now: nowFn(), subscriberCount: count }), '/subscribe'));
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
      return res.type('html').send(page("You're subscribed", 'The week\'s events will land in your inbox every Monday morning.'));
    }
    res.type('html').send(buttonPage('/subscribe/confirm', 'Confirm your subscription',
      'One tap and the week\'s events land in your inbox every Monday morning.', token, 'Confirm my subscription'));
  });

  app.post('/subscribe/confirm', async (req, res) => {
    const sub = supported ? await store.confirmSubscriber(String(req.query.token || '')) : null;
    // Only the first confirm: a second click on the same link sends nothing.
    if (sub && sub.newly_confirmed) welcome(sub);
    res.status(sub ? 200 : 404).type('html').send(sub
      ? page("You're subscribed", 'The week\'s events will land in your inbox every Monday morning.')
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

  app.get('/api/admin/newsletter', requireAdmin, async (req, res) => {
    if (!supported) return res.json({ ok: false, error: 'not-supported' });
    const counts = await store.countSubscribers();
    const sends = await store.listNewsletterSends(8);
    const payload = await getPublicPayload();
    const issue = renderWeekly(payload.events, { siteUrl, now: nowFn(), sponsor: payload.sponsor, unsubscribeUrl: '#', address: config.address });
    // A week whose send partly failed isn't "sent": the button stays on to
    // retry just the people who missed it (sendWeekly resumes).
    const record = await store.getNewsletterSend(weekKey(nowFn()));
    const failed = record ? (Array.isArray(record.failed_emails) ? record.failed_emails.length : Number(record.failed) || 0) : 0;
    res.json({
      ok: true, configured: config.enabled, from: config.from, address_set: Boolean(config.address),
      autosend: config.enabled && config.autosend, counts, sends, next: { subject: issue.subject, events: issue.total },
      this_week_sent: Boolean(record) && !failed,
      this_week_failed: failed,
      this_week_recipients: record ? Number(record.recipients) || 0 : 0
    });
  });

  app.get('/api/admin/newsletter/preview', requireAdmin, async (req, res) => {
    const payload = await getPublicPayload();
    const issue = renderWeekly(payload.events, { siteUrl, now: nowFn(), sponsor: payload.sponsor, unsubscribeUrl: '#', address: config.address });
    res.type('html').send(issue.html);
  });

  app.post('/api/admin/newsletter/test', requireAdmin, async (req, res) => {
    if (!config.enabled) return res.status(503).json({ ok: false, error: 'not-configured' });
    const to = normalizeEmail((req.body || {}).email) || normalizeEmail(config.testTo);
    if (!to) return res.status(400).json({ ok: false, error: 'no-test-address', message: 'Enter an address to send the test to.' });
    try {
      const payload = await getPublicPayload();
      const issue = renderWeekly(payload.events, { siteUrl, now: nowFn(), sponsor: payload.sponsor, unsubscribeUrl: `${siteUrl}/unsubscribe`, address: config.address });
      await resend.send({ from: config.from, to: [to], subject: `[Test] ${issue.subject}`, html: issue.html, text: issue.text });
      res.json({ ok: true, to });
    } catch (err) {
      res.status(502).json({ ok: false, error: 'send-failed', message: err.message });
    }
  });

  app.post('/api/admin/newsletter/send', requireAdmin, async (req, res) => {
    try {
      const out = await sendWeekly({ force: Boolean((req.body || {}).force) });
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
  async function scheduledSend() {
    const out = await sendWeekly();
    // Same Monday run: last week's sponsors get their click reports
    // (server/sponsors.js sendSponsorReports; safe to call more than once).
    if (onCron) {
      try { out.sponsor_reports = await onCron(nowFn()); } catch (err) {
        console.error('[newsletter] sponsor reports failed:', err.message);
        if (slack) slack.alert('sponsor-reports', 'Sponsor click reports failed', err.message, `${siteUrl}/admin.html`);
      }
    }
    // Monday's automatic send found nothing published for this week.
    if (slack && out.error === 'no-events') {
      slack.alert('newsletter-no-events', 'Newsletter skipped: nothing published for this week',
        'Publish this week\'s picks in admin, then send it from the Newsletter tab.', `${siteUrl}/admin.html`);
    }
    if (slack && out.error === 'no-address') {
      slack.alert('newsletter-no-address', 'Newsletter not sent: no mailing address', out.message, `${siteUrl}/admin.html`);
    }
    const done = out.ok || ['already-sent', 'no-events', 'no-subscribers', 'in-progress'].includes(out.error);
    return { ...out, ok: done, sent_ok: out.ok, final: ['not-configured', 'no-address'].includes(out.error) };
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
      const { ok: done, sent_ok: sentOk, final: _f, ...out } = await scheduledSend();
      // already-sent / no-events are normal outcomes for a cron, not failures.
      res.status(done ? 200 : 500).json({ ...out, ok: sentOk });
    } catch (err) {
      if (slack) slack.alert('newsletter-cron', 'Newsletter send crashed', err.message);
      res.status(500).json({ ok: false, error: 'send-failed', message: err.message });
    }
  });

  return { sendWeekly, scheduledSend };
}
