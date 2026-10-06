/* server/notify.js — "We got it" emails for people who submit an event or
 * buy a sponsorship, sent through Resend like the newsletter and in the same
 * design (server/newsletter.js emailShell, dark-mode safe).
 *
 * Each email says it worked, what happens next, and how to reach us
 * (reply, or /contact, which goes to Slack). Sending never blocks or fails
 * the request it follows: a mail problem is logged and the person still
 * sees the on-page confirmation. Off until RESEND_API_KEY is set.
 */

import { SITE_NAME, escHtml, formatDay, safeUrl } from './seo.js';
import { C, btn, emailShell, eventRow } from './newsletter.js';

export function createMailer({ resend, config }) {
  return {
    enabled: Boolean(config && config.enabled),
    // Resolves to true when sent. Never throws.
    async send(to, mail, idempotencyKey) {
      if (!config || !config.enabled || !to) return false;
      try {
        await resend.send({
          from: config.from, to: [to], subject: mail.subject, html: mail.html, text: mail.text,
          ...(config.replyTo ? { reply_to: config.replyTo } : {})
        }, idempotencyKey);
        return true;
      } catch (err) {
        console.warn(`[notify] "${mail.subject}" to a customer failed:`, err.message);
        return false;
      }
    }
  };
}

const p = (html, style = '') => `<p style="margin:14px 0;font-size:15px;line-height:1.5;${style}">${html}</p>`;
const steps = items => `<ol style="margin:8px 0 14px;padding-left:22px;font-size:15px;line-height:1.55;">${items.map(i => `<li style="margin:4px 0;">${i}</li>`).join('')}</ol>`;
const box = html => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;background:${C.sunLight};border:3px dashed ${C.ink};border-radius:16px;"><tr><td style="padding:14px 16px;font-size:15px;line-height:1.5;">${html}</td></tr></table>`;

function contactFooter(siteUrl, address) {
  const a = 'color:#FFC93C;';
  return `Questions or something not right? Just reply to this email, or reach us at <a href="${siteUrl}/contact" style="${a}">thevic361.com/contact</a>.<br>` +
    `${escHtml(SITE_NAME)} · ${escHtml(address || 'Victoria, TX')}`;
}
const contactText = siteUrl => `Questions or something not right? Reply to this email or reach us at ${siteUrl}/contact`;

function eventTable(ev, siteUrl) {
  const day = ev.date ? formatDay(ev.date, { weekday: 'long', month: 'long', day: 'numeric' }) : '';
  const row = eventRow({ ...ev, page: null, url: '', time: [day, ev.time].filter(Boolean).join(', ') }, siteUrl);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 4px;">${row}</table>`;
}

// ─── Free submission received ────────────────────────────────────────────

export function renderSubmissionReceived(ev, { siteUrl, address, upgradeUrl }) {
  const name = ev.name || 'your event';
  const bodyHtml =
    p(`Thanks for sending in <strong>${escHtml(name)}</strong>. It's in our review queue. Here's what you sent:`) +
    eventTable(ev, siteUrl) +
    `<h2 style="font-size:18px;margin:20px 0 4px;">What happens next</h2>` +
    steps([
      'We review every submission. Most go live within the hour, and we’ll email you when it does; some need a closer look and take a day or two.',
      `If it's a fit, it goes on <a href="${siteUrl}" style="color:${C.accent};">thevic361.com</a> and can show up in the Monday newsletter and our social posts.`,
      'Free listings aren’t guaranteed a spot, and we may tidy up the wording.'
    ]) +
    box(`<strong>Want it guaranteed and pinned to the top of its day?</strong> Make it a Vic’s Pick ($49 Mon–Thu, $89 Fri–Sun). You’ll see a preview before you pay.<br><br>${btn(upgradeUrl, 'Make it a Vic’s Pick')}`) +
    p('Need to change a detail? Reply to this email with the fix.', `color:${C.muted};font-size:14px;`);
  return {
    subject: `We got your event: ${name}`,
    html: emailShell({ title: 'Thanks, we got it!', preheader: `${name} is in our review queue. Here's what happens next.`, bodyHtml, siteUrl,
      footerHtml: contactFooter(siteUrl, address) }),
    text: [
      `Thanks for sending in "${name}". It's in our review queue.`, '',
      `${ev.date || ''} ${ev.time || ''} · ${ev.venue || ''}`.trim(), '',
      'What happens next:',
      '1. We review every submission. Most go live within the hour, and we’ll email you when it does; some need a closer look and take a day or two.',
      `2. If it's a fit, it goes on ${siteUrl} and can show up in the Monday newsletter and our social posts.`,
      '3. Free listings aren’t guaranteed a spot, and we may tidy up the wording.', '',
      `Want it guaranteed and pinned to the top of its day? Make it a Vic's Pick: ${upgradeUrl}`, '',
      'Need to change a detail? Reply to this email with the fix.',
      contactText(siteUrl)
    ].join('\n')
  };
}

// ─── Free submission approved and live ───────────────────────────────────

export function renderSubmissionLive(ev, { siteUrl, address, pageUrl, upgradeUrl }) {
  const name = ev.name || 'your event';
  const link = pageUrl || siteUrl;
  const bodyHtml =
    p(`Good news: <strong>${escHtml(name)}</strong> is now on The Vic 361.`) +
    eventTable(ev, siteUrl) +
    `<div style="margin:16px 0;">${btn(link, 'See it on the site')}</div>` +
    p('Share that link anywhere you promote the event. It can also show up in the Monday newsletter and our social posts.') +
    box(`<strong>Want it pinned to the top of its day?</strong> Make it a Vic’s Pick ($49 Mon–Thu, $89 Fri–Sun). You’ll see a preview before you pay.<br><br>${btn(upgradeUrl, 'Make it a Vic’s Pick')}`) +
    p('We may have tidied the wording a little. Something wrong? Reply to this email with the fix.', `color:${C.muted};font-size:14px;`);
  return {
    subject: `You're live: ${name}`,
    html: emailShell({ title: 'Your event is live!', preheader: `${name} is now on thevic361.com.`, bodyHtml, siteUrl,
      footerHtml: contactFooter(siteUrl, address) }),
    text: [
      `Good news: "${name}" is now on The Vic 361.`, '',
      `${ev.date || ''} ${ev.time || ''} · ${ev.venue || ''}`.trim(), '',
      `See it: ${link}`,
      'Share that link anywhere you promote the event. It can also show up in the Monday newsletter and our social posts.', '',
      `Want it pinned to the top of its day? Make it a Vic's Pick: ${upgradeUrl}`, '',
      'We may have tidied the wording a little. Something wrong? Reply to this email with the fix.',
      contactText(siteUrl)
    ].join('\n')
  };
}

// ─── Sponsorship paid ────────────────────────────────────────────────────

export function renderSponsorConfirmed(order, { siteUrl, address }) {
  const business = order.business || 'there';
  const receipt = 'Stripe emails your payment receipt separately.';
  if (order.kind === 'weekly') {
    const start = order.week_start;
    const week = start ? formatDay(start, { weekday: 'long', month: 'long', day: 'numeric' }) : 'your week';
    const s = order.sponsor || {};
    const href = safeUrl(s.url);
    const block = box(`<div style="font-size:11px;font-weight:bold;letter-spacing:.5px;">THIS WEEK'S SPONSOR</div>` +
      `<div style="font-size:20px;font-weight:bold;margin:4px 0;">${escHtml(s.name || business)}</div>` +
      (s.text ? `<div>${escHtml(s.text)}</div>` : '') +
      (href ? `<div style="margin-top:8px;"><a href="${escHtml(href)}" style="color:${C.accent};font-weight:bold;">${escHtml(s.cta || 'Learn more')} →</a></div>` : ''));
    const bodyHtml =
      p(`Thanks, ${escHtml(business)}! Your payment went through and <strong>the week of ${escHtml(week)}</strong> is yours.`) +
      `<h2 style="font-size:18px;margin:20px 0 4px;">What happens next</h2>` +
      steps([
        `Your sponsor block goes live on its own on <strong>${escHtml(week)}</strong>, on every page of thevic361.com for the whole week.`,
        'It’s also the sponsor spot at the top of that Monday’s newsletter.',
        'At the end of the week we’ll send you how many people clicked.'
      ]) +
      p('Here’s your block as it will run:') + block +
      p(`Want to change the wording or link before it goes live? Reply to this email. ${receipt}`, `color:${C.muted};font-size:14px;`);
    return {
      subject: `You're booked: The Vic 361 sponsor, week of ${formatDay(start, { month: 'short', day: 'numeric' })}`,
      html: emailShell({ title: 'You’re booked!', preheader: `Your sponsor block goes live ${week}.`, bodyHtml, siteUrl,
        footerHtml: contactFooter(siteUrl, address) }),
      text: [
        `Thanks, ${business}! Your payment went through and the week of ${week} is yours.`, '',
        'What happens next:',
        `1. Your sponsor block goes live on its own on ${week}, on every page of thevic361.com for the whole week.`,
        '2. It’s also the sponsor spot at the top of that Monday’s newsletter.',
        '3. At the end of the week we’ll send you how many people clicked.', '',
        `Your block: ${s.name || business}: ${s.text || ''} ${href ? `(${s.cta || 'Learn more'}: ${href})` : ''}`.trim(), '',
        `Want to change the wording or link before it goes live? Reply to this email. ${receipt}`,
        contactText(siteUrl)
      ].join('\n')
    };
  }
  // Vic’s Pick
  const ev = order.event || {};
  const day = ev.date ? formatDay(ev.date, { weekday: 'long', month: 'long', day: 'numeric' }) : 'its day';
  const bodyHtml =
    p(`Thanks, ${escHtml(business)}! Your payment went through and <strong>${escHtml(ev.name || 'your event')}</strong> is a Vic’s Pick.`) +
    eventTable({ ...ev, featured: true }, siteUrl) +
    `<h2 style="font-size:18px;margin:20px 0 4px;">What happens next</h2>` +
    steps([
      'We check the details and publish it, usually within a day. If anything needs fixing, we’ll email you.',
      `Then it’s <strong>pinned to the top of ${escHtml(day)}</strong> on thevic361.com and its event page, with the Vic’s Pick badge.`,
      'It’s starred in that week’s newsletter and featured first in our social posts.'
    ]) +
    p(`Need to change a detail? Reply to this email. ${receipt}`, `color:${C.muted};font-size:14px;`);
  return {
    subject: `Your Vic's Pick is confirmed: ${ev.name || 'your event'}`,
    html: emailShell({ title: 'You’re a Vic’s Pick!', preheader: `${ev.name || 'Your event'} will be pinned to the top of ${day}.`, bodyHtml, siteUrl,
      footerHtml: contactFooter(siteUrl, address) }),
    text: [
      `Thanks, ${business}! Your payment went through and "${ev.name || 'your event'}" is a Vic's Pick.`, '',
      `${day}${ev.time ? `, ${ev.time}` : ''} · ${ev.venue || ''}`, '',
      'What happens next:',
      '1. We check the details and publish it, usually within a day. If anything needs fixing, we’ll email you.',
      `2. Then it's pinned to the top of ${day} on thevic361.com and its event page, with the Vic's Pick badge.`,
      "3. It's starred in that week's newsletter and featured first in our social posts.", '',
      `Need to change a detail? Reply to this email. ${receipt}`,
      contactText(siteUrl)
    ].join('\n')
  };
}
