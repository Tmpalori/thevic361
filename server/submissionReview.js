/* server/submissionReview.js — The AI review of free event submissions.
 *
 * scripts/review_submissions.py (.github/workflows/submission-review.yml,
 * every 15 minutes) reads the pending public submissions here, runs the
 * collector's rules and one OpenAI pass over them, and posts back one
 * decision per submission:
 *
 *   approve    tidied up and published (auto-publish runs right away), and
 *              the submitter gets a "you're live" email
 *   flag       left pending for the admin, with the AI's reason in the notes
 *   reject     spam or a church/worship event (the site doesn't list those)
 *   duplicate  the exact event is already live
 *
 * The AI may only rewrite the name, description and icons. Date, time,
 * venue, address, link and the submitter's details always stay as sent.
 * Each submission is reviewed once (`ai_review` on the row); an admin edit
 * or decision always wins, and paid Vic's Pick submissions are left to the
 * admin. SUBMISSION_AUTOAPPROVE=0 turns approvals into flags.
 *
 * Safety: the shared secret (like the event check), pending rows only, at
 * most MAX_PER_RUN decisions per call.
 */

import crypto from 'node:crypto';
import { validateSubmission } from './validate.js';
import { normalizePayload, eventKeyOf } from './db.js';

export const MAX_PER_RUN = 20;
const DECISIONS = new Set(['approve', 'flag', 'reject', 'duplicate']);
const STATUS = { approve: 'approved', reject: 'rejected', duplicate: 'duplicate' };
const LABEL = { approve: 'Approved', flag: 'Flagged', reject: 'Rejected', duplicate: 'Duplicate' };

function secretOk(given, want) {
  const g = Buffer.from(String(given || ''));
  const w = Buffer.from(String(want || ''));
  return w.length > 0 && g.length === w.length && crypto.timingSafeEqual(g, w);
}

// Waiting for the AI: pending public submissions it hasn't seen and the
// admin hasn't touched (anything beyond the "submitted" history entry).
export function awaitingReview(row) {
  if (!row || row.status !== 'pending' || (row.source || 'submission') !== 'submission') return false;
  if (row.ai_review) return false;
  const history = Array.isArray(row.review_history) ? row.review_history : [];
  return history.every(h => h && h.action === 'submitted');
}

// The stored payload with only the AI's allowed changes applied. Returns
// { payload, changes } or { error }.
export function applyCleanup(payload, cleaned) {
  const c = cleaned && typeof cleaned === 'object' ? cleaned : {};
  const next = { ...payload };
  const changes = [];
  if (typeof c.name === 'string' && c.name.trim() && c.name.trim() !== payload.name) {
    next.name = c.name.trim();
    changes.push('name');
  }
  if (typeof c.description === 'string' && c.description.trim() && c.description.trim() !== payload.description) {
    next.description = c.description.trim();
    changes.push('description');
  }
  if (Array.isArray(c.icons) && c.icons.length) {
    next.icons = c.icons;
    if (payload.free && !next.icons.includes('free')) next.icons = [...next.icons, 'free'];
  }
  // The same validation as an admin edit (icons filtered to the allowed set,
  // lengths capped); submitter fields pass through untouched.
  const v = validateSubmission(next, { adminEdit: true });
  if (!v.ok) return { error: Object.values(v.errors)[0] || 'invalid' };
  const out = normalizePayload(v.data.payload);
  if (JSON.stringify(out.icons) !== JSON.stringify(payload.icons || [])) changes.push('icons');
  return { payload: out, changes };
}

export function registerSubmissionReview(app, { store, secret, nowFn, autoApprove, publish, onApproved = () => {}, slack = null, siteUrl = '' }) {
  app.get('/api/submission-review/pending', async (req, res, next) => {
    if (!secretOk(req.get('x-cron-secret'), secret)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    try {
      const rows = (await store.list({ status: 'pending' })).filter(awaitingReview);
      // Only what the review needs: no emails, phone numbers or IPs.
      const submissions = rows.slice(0, MAX_PER_RUN).map(r => {
        const { submitter_first_name: _f, submitter_last_name: _l, submitter_phone: _p, ...event } = r.payload || {};
        return { id: r.id, created_at: r.created_at, submitter_kind: r.submitter_kind || 'other', event };
      });
      res.json({ ok: true, auto_approve: autoApprove, submissions });
    } catch (err) { next(err); }
  });

  app.post('/api/submission-review', async (req, res, next) => {
    if (!secretOk(req.get('x-cron-secret'), secret)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const asks = Array.isArray(req.body && req.body.reviews) ? req.body.reviews : null;
    if (!asks) return res.status(400).json({ ok: false, error: 'bad-payload', message: 'reviews[] required' });
    if (asks.length > MAX_PER_RUN) {
      return res.status(400).json({ ok: false, error: 'too-many', message: `At most ${MAX_PER_RUN} reviews at once.` });
    }
    try {
      const done = [];
      const skipped = [];
      for (const ask of asks) {
        const id = String(ask && ask.id || '');
        let decision = String(ask && ask.decision || '');
        const reason = String(ask && ask.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        const row = id ? await store.get(id) : null;
        if (!row || !awaitingReview(row)) { skipped.push({ id, why: 'not-awaiting-review' }); continue; }
        if (!DECISIONS.has(decision)) { skipped.push({ id, why: 'bad-decision' }); continue; }
        if (decision === 'approve' && !autoApprove) decision = 'flag';

        // Cleanup is applied only to what goes live; a flagged submission
        // keeps the submitter's words for the admin to judge, with the
        // suggestion in the notes.
        let payload = row.payload;
        let changes = [];
        let note = reason;
        if (decision === 'approve' || decision === 'flag') {
          const fixed = applyCleanup(row.payload, ask.cleaned);
          if (fixed.error) {
            decision = 'flag';
            note = `${reason ? reason + ' ' : ''}(AI cleanup was invalid: ${fixed.error})`.trim();
          } else if (decision === 'approve') {
            payload = fixed.payload;
            changes = fixed.changes;
          } else if (fixed.changes.length) {
            const s = fixed.payload;
            note = `${reason} Suggested: ${fixed.changes.includes('name') ? `name “${s.name}”; ` : ''}` +
              `${fixed.changes.includes('description') ? `description “${s.description}”` : ''}`.trim();
          }
        }
        const at = nowFn().toISOString();
        const history = [...(Array.isArray(row.review_history) ? row.review_history : []),
          { at, action: STATUS[decision] ? `status:${STATUS[decision]}` : 'ai-flag', note: `AI review: ${note || LABEL[decision]}`.slice(0, 500) }];
        const aiNote = `AI review (${LABEL[decision].toLowerCase()}): ${note || 'no notes'}`;
        const patch = {
          review_history: history,
          admin_notes: [row.admin_notes, aiNote].filter(Boolean).join('\n').slice(0, 2000),
          ai_review: { at, decision, reason: note, changes, original: changes.length ? row.payload : null }
        };
        if (STATUS[decision]) patch.status = STATUS[decision];
        if (decision === 'approve') patch.payload = payload;
        const updated = await store.update(id, patch);
        done.push({ id, decision, reason: note, changes, row: updated || { ...row, ...patch } });
      }

      let published = null;
      if (done.some(d => d.decision === 'approve')) {
        try {
          published = await publish();
        } catch (err) {
          console.error('[submission-review] publish failed:', err.message);
          published = { ok: false, error: err.message };
        }
        for (const d of done) if (d.decision === 'approve') {
          try { await onApproved(d.row); } catch (err) { console.warn('[submission-review] live email failed:', err.message); }
        }
      }
      if (slack && done.length) {
        const lines = done.map(d => {
          const ev = d.row.payload || {};
          const fixed = d.changes.length ? ` (tidied: ${d.changes.join(', ')})` : '';
          return `• *${LABEL[d.decision]}*: ${ev.name} · ${ev.date}${fixed}${d.decision === 'approve' ? '' : `: ${d.reason}`}`;
        });
        const live = done.filter(d => d.decision === 'approve').length;
        const flagged = done.filter(d => d.decision === 'flag').length;
        slack.notify({
          channel: 'activity',
          title: `🤖 Submission review: ${[live && `${live} live`, flagged && `${flagged} for you to look at`,
            done.length - live - flagged && `${done.length - live - flagged} turned away`].filter(Boolean).join(', ')}`,
          text: lines.join('\n') + (published && !published.ok ? `\n⚠️ Publishing failed: ${published.error || published.message}` : ''),
          link: `${siteUrl}/admin.html`, footer: 'Undo or edit anything in the Submissions tab'
        });
      }
      res.json({
        ok: true,
        done: done.map(({ id, decision, reason, changes, row }) => ({ id, decision, reason, changes, key: eventKeyOf(row.payload || {}) })),
        skipped,
        published: published ? Boolean(published.ok) : null
      });
    } catch (err) { next(err); }
  });
}
