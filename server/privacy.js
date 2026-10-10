/* server/privacy.js — Personal-data retention, deletion on request, and
 * the subscriber export.
 *
 *   purgePersonalData(store, now)  daily (server/scheduler.js "privacy-purge"):
 *     submissions older than SUBMISSION_IP_MONTHS lose the submitter's IP
 *     address and user agent; contact-form messages older than
 *     CONTACT_MONTHS are deleted. The privacy page states these periods.
 *   POST /api/admin/privacy/forget  { email }
 *     deletes what we keep about one address (subscriber row and opens,
 *     contact messages, the submitter fields of their submissions, failed
 *     sends); sponsor orders and referral rewards are money and stay for
 *     the books with the address masked (store.forgetEmail).
 *   GET /api/admin/subscribers.csv
 *     every subscriber (email, status, source, dates), so the business has
 *     a copy of the list outside Railway.
 */

import { normalizeEmail, maskEmail } from './newsletter.js';

export const SUBMISSION_IP_MONTHS = 12;
export const CONTACT_MONTHS = 24;

function monthsBefore(now, months) {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

export function retentionCutoffs(now) {
  return { submissionsBefore: monthsBefore(now, SUBMISSION_IP_MONTHS), contactBefore: monthsBefore(now, CONTACT_MONTHS) };
}

export async function purgePersonalData(store, now) {
  if (typeof store.purgePersonalData !== 'function') return { ok: true, skipped: 'not-supported' };
  const out = await store.purgePersonalData(retentionCutoffs(now));
  if (out.submissions || out.contact_messages) {
    console.log(`[privacy] retention: cleared IP/user agent on ${out.submissions} submission(s), deleted ${out.contact_messages} contact message(s)`);
  }
  return { ok: true, ...out };
}

// A spreadsheet opens a cell starting with = + - @ as a formula; a quote in
// front keeps it text (an address can't start with one, a source might).
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const SUBSCRIBER_CSV_COLUMNS = ['email', 'status', 'source', 'created_at', 'confirmed_at', 'unsubscribed_at'];
export function subscribersCsv(rows) {
  const lines = [SUBSCRIBER_CSV_COLUMNS.join(',')];
  for (const r of rows) lines.push(SUBSCRIBER_CSV_COLUMNS.map(k => csvCell(r[k])).join(','));
  return lines.join('\r\n') + '\r\n';
}

// "Forgotten" stand-in for an address kept on money records: enough to
// match a Stripe receipt by hand, not the address itself.
export function forgottenEmail(email) {
  return maskEmail(email) || 'forgotten';
}

export function registerPrivacy(app, { store, requireAdmin, slack = null, nowFn = () => new Date() }) {
  app.post('/api/admin/privacy/forget', requireAdmin, async (req, res, next) => {
    try {
      const email = normalizeEmail((req.body || {}).email);
      if (!email) return res.status(400).json({ ok: false, error: 'bad-email', message: 'Enter the email address to delete.' });
      if (typeof store.forgetEmail !== 'function') return res.status(501).json({ ok: false, error: 'not-supported' });
      const masked = forgottenEmail(email);
      const removed = await store.forgetEmail(email, masked);
      // Logged without the address itself: the log shouldn't keep what was
      // just deleted.
      const summary = Object.entries(removed).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing stored';
      console.log(`[privacy] forgot ${masked} at ${nowFn().toISOString()}: ${summary}`);
      if (slack) {
        slack.notify({ title: '🗑️ Personal data deleted on request', text: `${masked}: ${summary}`, channel: 'activity' });
      }
      res.json({ ok: true, masked, removed });
    } catch (err) { next(err); }
  });

  app.get('/api/admin/subscribers.csv', requireAdmin, async (req, res, next) => {
    try {
      if (typeof store.exportSubscribers !== 'function') return res.status(501).json({ ok: false, error: 'not-supported' });
      const rows = await store.exportSubscribers();
      const day = nowFn().toISOString().slice(0, 10);
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="subscribers-${day}.csv"`,
        'Cache-Control': 'no-store'
      }).send(subscribersCsv(rows));
    } catch (err) { next(err); }
  });
}
