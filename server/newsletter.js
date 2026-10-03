/* server/newsletter.js — Own email newsletter, sent through Resend.
 *
 * Replaces the Beehiiv embed once RESEND_API_KEY is set (until then the
 * homepage keeps the Beehiiv form, so nothing breaks mid-switch).
 *
 *   - Signup: POST /api/subscribe → pending subscriber + confirmation email
 *     (double opt-in, so nobody can sign up someone else).
 *   - GET /subscribe/confirm?token=… activates; /unsubscribe?token=… shows a
 *     one-button page and POST /unsubscribe (also the RFC 8058 one-click
 *     target mail clients use) removes them.
 *   - The weekly email is built from the published events (this week,
 *     featured first, sponsor block) and sent with Resend's batch API,
 *     each copy with its own unsubscribe link. One send per week: a second
 *     attempt for the same week is refused unless forced.
 *   - Admin: counts, preview, test send, send now, CSV/paste import.
 *   - Automation: POST /api/newsletter/cron with X-Cron-Secret, called by
 *     .github/workflows/newsletter.yml on Monday mornings.
 */

import crypto from 'node:crypto';
import {
  SITE_NAME, escHtml, safeUrl, localDateStr, currentWeek, formatDay, sortEvents, layout
} from './seo.js';

const RESEND_API = 'https://api.resend.com';
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
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
  return c;
}

export function normalizeEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

export function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// ─── Resend client ───────────────────────────────────────────────────────

export function createResend(apiKey, fetchImpl = globalThis.fetch) {
  async function call(path, body, idempotencyKey) {
    const res = await fetchImpl(`${RESEND_API}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
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
    send: (msg) => call('/emails', msg),
    batch: (msgs, key) => call('/emails/batch', msgs, key)
  };
}

// ─── Email content ───────────────────────────────────────────────────────

const C = { bg: '#FAF5E4', card: '#FFFBEC', ink: '#1E1B33', muted: '#5C5878', accent: '#4E47B8', line: '#E0DAC2' };

function emailShell({ title, preheader, bodyHtml, footerHtml }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escHtml(preheader || '')}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.card};border:1px solid ${C.line};border-radius:10px;">
<tr><td style="background:${C.accent};padding:20px 24px;border-radius:10px 10px 0 0;font-family:Georgia,serif;color:#FFFBEC;">
<div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;opacity:.85;font-family:Arial,sans-serif;">The Vic 361</div>
<div style="font-size:26px;font-weight:bold;line-height:1.2;margin-top:4px;">${escHtml(title)}</div></td></tr>
<tr><td style="padding:8px 24px 24px;font-family:Arial,Helvetica,sans-serif;color:${C.ink};font-size:15px;line-height:1.5;">${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid ${C.line};font-family:Arial,sans-serif;color:${C.muted};font-size:12px;line-height:1.5;">${footerHtml}</td></tr>
</table></td></tr></table></body></html>`;
}

function footer({ siteUrl, unsubscribeUrl, address }) {
  return `You're getting this because you subscribed at <a href="${siteUrl}" style="color:${C.accent};">thevic361.com</a>.<br>
<a href="${escHtml(unsubscribeUrl)}" style="color:${C.accent};">Unsubscribe</a> · <a href="${siteUrl}/advertise" style="color:${C.accent};">Advertise</a> · <a href="${siteUrl}/submit" style="color:${C.accent};">Submit an event</a><br>
${escHtml(SITE_NAME)}${address ? ` · ${escHtml(address)}` : ' · Victoria, TX'}`;
}

function eventRow(ev, siteUrl) {
  const link = ev.page ? `${siteUrl}${ev.page}` : (safeUrl(ev.url) || siteUrl);
  const where = [ev.venue].filter(Boolean).join('');
  return `<tr><td style="padding:8px 0;border-bottom:1px solid ${C.line};">
${ev.featured ? `<span style="display:inline-block;background:${C.accent};color:#fff;font-size:11px;font-weight:bold;padding:1px 6px;border-radius:8px;margin-right:4px;">FEATURED</span>` : ''}
<span style="color:${C.accent};font-weight:bold;">${escHtml(ev.time || '')}</span>
<a href="${escHtml(link)}" style="color:${C.ink};font-weight:bold;text-decoration:none;">${escHtml(ev.name)}</a>${where ? ` <span style="color:${C.muted};">· ${escHtml(where)}</span>` : ''}${ev.free === true ? ` <span style="color:#3F7D2E;font-size:13px;">· Free</span>` : ''}
${ev.description ? `<div style="color:${C.muted};font-size:13px;">${escHtml(ev.description)}</div>` : ''}
</td></tr>`;
}

// The weekly issue: the rest of this week (today through Sunday).
export function renderWeekly(events, { siteUrl, now, sponsor, unsubscribeUrl, address }) {
  const today = localDateStr(now);
  const week = currentWeek(today).filter(d => d >= today);
  const byDay = week.map(d => ({ d, list: sortEvents(events.filter(e => e.date === d)) })).filter(x => x.list.length);
  const total = byDay.reduce((n, x) => n + x.list.length, 0);
  const range = week.length ? `${formatDay(week[0], { month: 'short', day: 'numeric' })}–${formatDay(week[week.length - 1], { month: 'short', day: 'numeric' })}` : '';
  const subject = `This week in Victoria: ${total} things to do (${range})`;
  const highlights = byDay.flatMap(x => x.list).filter(e => e.featured).concat(byDay.flatMap(x => x.list)).map(e => e.name);
  const preheader = [...new Set(highlights)].slice(0, 3).join(' · ');

  const days = byDay.map(({ d, list }) => `
<h2 style="font-family:Georgia,serif;font-size:19px;margin:22px 0 4px;color:${C.ink};">${escHtml(formatDay(d, { weekday: 'long' }))} <span style="font-family:Arial,sans-serif;font-size:13px;color:${C.muted};font-weight:normal;">${escHtml(formatDay(d, { month: 'long', day: 'numeric' }))}</span></h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${list.slice(0, PER_DAY).map(e => eventRow(e, siteUrl)).join('')}</table>
${list.length > PER_DAY ? `<p style="margin:6px 0 0;font-size:13px;"><a href="${siteUrl}/" style="color:${C.accent};">+${list.length - PER_DAY} more on ${escHtml(formatDay(d, { weekday: 'long' }))} →</a></p>` : ''}`).join('');

  const sponsorBlock = sponsor && sponsor.name ? `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;background:${C.bg};border:1px solid ${C.line};border-radius:8px;"><tr><td style="padding:14px 16px;">
<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:${C.muted};">This week's sponsor</div>
<div style="font-family:Georgia,serif;font-size:18px;font-weight:bold;margin:2px 0;">${escHtml(sponsor.name)}</div>
${sponsor.text ? `<div style="font-size:14px;">${escHtml(sponsor.text)}</div>` : ''}
${safeUrl(sponsor.url) && sponsor.cta ? `<a href="${escHtml(safeUrl(sponsor.url))}" style="display:inline-block;margin-top:8px;color:${C.accent};font-weight:bold;">${escHtml(sponsor.cta)} →</a>` : ''}
</td></tr></table>` : '';

  const bodyHtml = `
<p style="margin:16px 0 0;">${total ? `Here's what's happening in Victoria, TX this week: <strong>${total} events</strong>.` : 'Nothing is listed yet for the rest of this week.'}
<a href="${siteUrl}/this-weekend" style="color:${C.accent};">This weekend</a> · <a href="${siteUrl}/free-things-to-do" style="color:${C.accent};">Free</a> · <a href="${siteUrl}/kids-and-family" style="color:${C.accent};">Kids</a> · <a href="${siteUrl}/live-music" style="color:${C.accent};">Live music</a></p>
${days}${sponsorBlock}
<p style="margin:24px 0 0;"><a href="${siteUrl}/" style="display:inline-block;background:${C.accent};color:#fff;font-weight:bold;padding:10px 18px;border-radius:999px;text-decoration:none;">See the full list</a></p>`;

  const text = [
    `${subject}`, '',
    ...byDay.flatMap(({ d, list }) => [formatDay(d, { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase(),
      ...list.slice(0, PER_DAY).map(e => `- ${e.time ? e.time + ' ' : ''}${e.name}${e.venue ? ' @ ' + e.venue : ''}${e.page ? ' ' + siteUrl + e.page : ''}`), '']),
    `Full list: ${siteUrl}/`, '', `Unsubscribe: ${unsubscribeUrl}`, `${SITE_NAME} · ${address || 'Victoria, TX'}`
  ].join('\n');

  return { subject, html: emailShell({ title: 'This week in Victoria', preheader, bodyHtml, footerHtml: footer({ siteUrl, unsubscribeUrl, address }) }), text, total };
}

export function renderConfirmEmail({ siteUrl, confirmUrl, address }) {
  const bodyHtml = `<p style="margin:16px 0;">Tap the button to confirm and start getting Victoria's events every week.</p>
<p><a href="${escHtml(confirmUrl)}" style="display:inline-block;background:${C.accent};color:#fff;font-weight:bold;padding:10px 18px;border-radius:999px;text-decoration:none;">Confirm my subscription</a></p>
<p style="color:${C.muted};font-size:13px;">Didn't sign up? Ignore this email and you won't hear from us.</p>`;
  return {
    subject: 'Confirm your Vic 361 subscription',
    html: emailShell({ title: 'One tap to confirm', preheader: 'Confirm to get Victoria events every week', bodyHtml,
      footerHtml: `${escHtml(SITE_NAME)} · ${escHtml(address || 'Victoria, TX')}` }),
    text: `Confirm your subscription to The Vic 361: ${confirmUrl}\n\nDidn't sign up? Ignore this email.`
  };
}

// Signup form that replaces the Beehiiv iframe on the homepage.
export function signupFormHtml() {
  return `<form class="signup-form" id="signup-form" action="/api/subscribe" method="post" novalidate>
  <label for="signup-email" class="visually-hidden">Email address</label>
  <input id="signup-email" name="email" type="email" required autocomplete="email" placeholder="you@example.com">
  <input type="text" name="company" tabindex="-1" autocomplete="off" class="hp-field" aria-hidden="true">
  <button type="submit" class="btn btn--primary">Subscribe</button>
  <p class="signup-msg" id="signup-msg" role="status" aria-live="polite"></p>
</form>
<script>
(function(){var f=document.getElementById('signup-form');if(!f)return;var m=document.getElementById('signup-msg');
f.addEventListener('submit',function(e){e.preventDefault();var b=f.querySelector('button');b.disabled=true;m.textContent='';
fetch('/api/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:f.email.value,company:f.company.value})})
.then(function(r){return r.json().catch(function(){return{};}).then(function(j){return{ok:r.ok,j:j};});})
.then(function(x){m.textContent=x.ok?'Check your inbox to confirm.':(x.j.message||'Something went wrong. Try again.');if(x.ok){f.email.value='';if(window.vic361Track)window.vic361Track('subscribe_click',{link_url:'form'});}})
.catch(function(){m.textContent='Something went wrong. Try again.';}).then(function(){b.disabled=false;});});})();
</script>`;
}

// ─── Routes ──────────────────────────────────────────────────────────────

export function registerNewsletter(app, { store, requireAdmin, siteUrl, nowFn, getPublicPayload, createRateLimiter, config, resend }) {
  const subscribeLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
  const supported = typeof store.addSubscriber === 'function';

  const page = (title, message) => layout({
    siteUrl, path: '/subscribe', nav: null, noindex: true, title: `${title} | ${SITE_NAME}`, description: title,
    body: `<h1 class="page-title">${escHtml(title)}</h1><p class="page-lead">${message}</p><p><a class="btn btn--primary" href="/">See this week's events</a></p>`
  });

  function weekKey(now) {
    return currentWeek(localDateStr(now))[0];
  }

  async function sendWeekly({ force = false } = {}) {
    if (!config.enabled) return { ok: false, error: 'not-configured' };
    const now = nowFn();
    const key = weekKey(now);
    const prior = await store.getNewsletterSend(key);
    if (prior && !force) return { ok: false, error: 'already-sent', sent: prior };
    const payload = await getPublicPayload();
    const subs = await store.listSubscribers({ status: 'active' });
    if (!subs.length) return { ok: false, error: 'no-subscribers' };
    const probe = renderWeekly(payload.events, { siteUrl, now, sponsor: payload.sponsor, unsubscribeUrl: '', address: config.address });
    if (!probe.total) return { ok: false, error: 'no-events' };

    let sent = 0;
    const failures = [];
    for (let i = 0; i < subs.length; i += BATCH_SIZE) {
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
      try {
        // Idempotency key per week + chunk: a retried request can't double-send.
        await resend.batch(msgs, `vic361-${key}-${i / BATCH_SIZE}${force ? `-f${Date.now()}` : ''}`);
        sent += chunk.length;
      } catch (err) {
        failures.push(err.message);
      }
    }
    const record = { week_key: key, subject: probe.subject, recipients: sent, failed: subs.length - sent };
    await store.recordNewsletterSend(record);
    return { ok: failures.length === 0, ...record, errors: failures.slice(0, 3) };
  }

  app.post('/api/subscribe', async (req, res) => {
    if (!supported || !config.enabled) return res.status(503).json({ ok: false, message: 'Signups are paused. Try again soon.' });
    const ip = req.ip || req.socket.remoteAddress || '';
    if (!subscribeLimiter.check(ip).ok) return res.status(429).json({ ok: false, message: 'Too many tries. Try again later.' });
    const body = req.body || {};
    // Honeypot: a hidden field people never fill. Pretend it worked.
    if (body.company) return res.json({ ok: true });
    const email = normalizeEmail(body.email);
    if (!email) return res.status(400).json({ ok: false, message: 'Enter a valid email address.' });
    try {
      const sub = await store.addSubscriber({ email, source: 'site' });
      if (sub.status === 'active') return res.json({ ok: true, already: true });
      const confirmUrl = `${siteUrl}/subscribe/confirm?token=${encodeURIComponent(sub.token)}`;
      const mail = renderConfirmEmail({ siteUrl, confirmUrl, address: config.address });
      await resend.send({ from: config.from, to: [email], subject: mail.subject, html: mail.html, text: mail.text });
      res.json({ ok: true });
    } catch (err) {
      console.error('[newsletter] subscribe failed:', err.message);
      res.status(500).json({ ok: false, message: 'Something went wrong. Try again.' });
    }
  });

  app.get('/subscribe/confirm', async (req, res) => {
    const sub = supported ? await store.confirmSubscriber(String(req.query.token || '')) : null;
    res.status(sub ? 200 : 404).type('html').send(sub
      ? page("You're subscribed", 'The week\'s events will land in your inbox every Monday morning.')
      : page('Link expired', 'That confirmation link isn\'t valid anymore. Sign up again from the homepage.'));
  });

  app.get('/unsubscribe', async (req, res) => {
    const token = String(req.query.token || '');
    // GET only shows a button: link scanners in mail systems follow GETs.
    res.type('html').send(layout({
      siteUrl, path: '/unsubscribe', nav: null, noindex: true, title: `Unsubscribe | ${SITE_NAME}`, description: 'Unsubscribe',
      body: `<h1 class="page-title">Unsubscribe</h1><p class="page-lead">Stop getting The Vic 361 newsletter?</p>
<form method="post" action="/unsubscribe?token=${encodeURIComponent(token)}"><button class="btn btn--primary" type="submit">Unsubscribe</button></form>`
    }));
  });

  // Also the RFC 8058 one-click endpoint mail clients POST to.
  app.post('/unsubscribe', async (req, res) => {
    const ok = supported ? await store.unsubscribe(String(req.query.token || '')) : false;
    res.status(ok ? 200 : 404).type('html').send(ok
      ? page("You're unsubscribed", 'You won\'t get any more newsletters. You can sign up again anytime on the homepage.')
      : page('Link expired', 'That unsubscribe link isn\'t valid.'));
  });

  app.get('/api/admin/newsletter', requireAdmin, async (req, res) => {
    if (!supported) return res.json({ ok: false, error: 'not-supported' });
    const counts = await store.countSubscribers();
    const sends = await store.listNewsletterSends(8);
    const payload = await getPublicPayload();
    const issue = renderWeekly(payload.events, { siteUrl, now: nowFn(), sponsor: payload.sponsor, unsubscribeUrl: '#', address: config.address });
    res.json({
      ok: true, configured: config.enabled, from: config.from, address_set: Boolean(config.address),
      autosend: Boolean(config.cronSecret), counts, sends, next: { subject: issue.subject, events: issue.total },
      this_week_sent: Boolean(await store.getNewsletterSend(weekKey(nowFn())))
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

  // Scheduled send (GitHub Actions). Needs the shared secret; refuses when
  // no secret is configured so the endpoint can't be triggered by anyone.
  app.post('/api/newsletter/cron', async (req, res) => {
    const given = String(req.get('x-cron-secret') || '');
    const ok = config.cronSecret && given.length === config.cronSecret.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(config.cronSecret));
    if (!ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
    try {
      const out = await sendWeekly();
      // already-sent / no-events are normal outcomes for a cron, not failures.
      res.status(out.ok || ['already-sent', 'no-events', 'no-subscribers'].includes(out.error) ? 200 : 500).json(out);
    } catch (err) {
      res.status(500).json({ ok: false, error: 'send-failed', message: err.message });
    }
  });

  return { sendWeekly };
}
