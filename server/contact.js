/* server/contact.js — Contact form that delivers to the owner's Slack.
 *
 * Replaces the public email address: /contact posts here, and each message
 * arrives in Slack (server/slack.js) with the sender's email so the owner
 * can reply from wherever they like. Nothing personal is published.
 *
 * If Slack isn't configured or is down, the message is written to the
 * server log (Railway keeps it) so nothing is silently lost.
 */

import { SITE_NAME, escHtml, layout } from './seo.js';
import { normalizeEmail } from './newsletter.js';

export const CONTACT_TOPICS = [
  ['advertising', 'Advertising or sponsorship'],
  ['event', 'A question about an event'],
  ['fix', 'Fix or remove a listing'],
  ['other', 'Something else']
];

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

export function renderContactPage({ siteUrl, values = {}, errors = {}, sent = false }) {
  const v = values;
  const e = errors;
  const field = (name, label, input, err) => `<div class="co-field"><label for="c-${name}">${label}</label>${input}${err ? `<small class="co-error">${escHtml(err)}</small>` : ''}</div>`;
  const body = sent
    ? `<h1 class="page-title">Message sent</h1>
       <p class="page-lead">Thanks! We read every message and usually reply within a day.</p>
       <p><a class="btn btn--primary" href="/">See this week's events</a></p>`
    : `<h1 class="page-title">Contact us</h1>
    <p class="page-lead">Questions about advertising, an event, or a listing? Send us a note and we'll get back to you, usually within a day.</p>
    ${e._form ? `<p class="co-error co-error--form">${escHtml(e._form)}</p>` : ''}
    <form class="co-form" method="post" action="/contact" data-turnstile>
      <div class="hp-field" aria-hidden="true"><label>Company <input name="company" tabindex="-1" autocomplete="off"></label></div>
      ${field('topic', 'What is this about?', `<select id="c-topic" name="topic">${CONTACT_TOPICS.map(([k, l]) => `<option value="${k}"${v.topic === k ? ' selected' : ''}>${escHtml(l)}</option>`).join('')}</select>`)}
      ${field('name', 'Your name', `<input id="c-name" name="name" required maxlength="80" value="${escHtml(v.name || '')}"${e.name ? ' aria-invalid="true"' : ''}>`, e.name)}
      ${field('email', 'Your email', `<input id="c-email" name="email" type="email" required maxlength="254" value="${escHtml(v.email || '')}"${e.email ? ' aria-invalid="true"' : ''}>`, e.email)}
      ${field('business', 'Business (optional)', `<input id="c-business" name="business" maxlength="80" value="${escHtml(v.business || '')}">`)}
      ${field('message', 'Message', `<textarea id="c-message" name="message" required maxlength="3000" rows="6"${e.message ? ' aria-invalid="true"' : ''}>${escHtml(v.message || '')}</textarea>`, e.message)}
      <button class="btn btn--primary" type="submit">Send message</button>
      <p class="co-hint">Listing an event? <a href="/submit">Submit it here</a>; it's free.</p>
    </form>`;
  return layout({
    siteUrl, path: '/contact', noindex: sent,
    title: `Contact | ${SITE_NAME}`,
    description: 'Contact The Vic 361 about advertising, an event, or a listing in Victoria, TX.',
    body
  });
}

export function registerContact(app, { siteUrl, slack, createRateLimiter, sendHtml, verifyHuman = async () => true }) {
  const limiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5 });

  app.get('/contact', (req, res) => {
    const topic = CONTACT_TOPICS.some(([k]) => k === req.query.topic) ? req.query.topic : 'advertising';
    sendHtml(res, renderContactPage({ siteUrl, values: { topic } }));
  });

  app.post('/contact', async (req, res, next) => {
    try {
      const b = req.body || {};
      const values = {
        topic: CONTACT_TOPICS.some(([k]) => k === b.topic) ? b.topic : 'other',
        name: clean(b.name, 80), email: clean(b.email, 254), business: clean(b.business, 80), message: clean(b.message, 3000)
      };
      // Honeypot: pretend it worked so bots move on.
      if (clean(b.company, 200)) return sendHtml(res, renderContactPage({ siteUrl, sent: true }), 200, 'no-store');
      const fail = (errors, status = 400) => sendHtml(res, renderContactPage({ siteUrl, values, errors }), status, 'no-store');
      if (!limiter.check(req.ip || req.socket.remoteAddress).ok) return fail({ _form: 'Too many messages from here. Try again in an hour.' }, 429);
      if (!(await verifyHuman(req))) return fail({ _form: "We couldn't confirm you're not a bot. Please try again." });
      const errors = {};
      if (!values.name) errors.name = 'Please add your name.';
      const email = normalizeEmail(values.email);
      if (!email) errors.email = 'Please add a valid email so we can reply.';
      if (values.message.length < 5) errors.message = 'Please add a short message.';
      if (Object.keys(errors).length) return fail(errors);

      const topic = CONTACT_TOPICS.find(([k]) => k === values.topic)[1];
      const delivered = await slack.notify({
        title: `✉️ Website message: ${topic}`,
        fields: [['From', values.name], ['Email', email], ['Business', values.business]],
        text: values.message,
        footer: 'Reply by email to the sender'
      });
      if (!delivered) {
        // Railway keeps logs; better there than lost.
        console.log('[contact] message (Slack unavailable):', JSON.stringify({ ...values, email }));
      }
      sendHtml(res, renderContactPage({ siteUrl, sent: true }), 200, 'no-store');
    } catch (err) { next(err); }
  });
}
