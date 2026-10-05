/* server/eventcheck.js — Events hidden by the event check, and undoing it.
 *
 * scripts/sweep_events.py (run by .github/workflows/event-check.yml) looks
 * over the live list after each publish. The certain, rule-based findings
 * (church events, non-events, exact duplicates) it hides on its own through
 * POST /api/event-check/hide; judgment calls only go to Slack.
 *
 * Hiding never deletes. The published payload keeps the event and gains a
 * `hidden` entry; getPublicPayload filters hidden pages out at read time, so
 * the site, /events.json, the newsletter, the social kit and the sitemap
 * all drop it together. Auto-publish and the admin's Save & Publish carry
 * `hidden` forward like any other extra.
 *
 * Restoring (admin Home) removes the entry and remembers the page in
 * `hidden_restored`, so the next check doesn't hide it again.
 *
 * Safety: the hide endpoint needs the shared secret, only hides upcoming
 * events that are live right now, and refuses a batch bigger than
 * MAX_PER_RUN, so a bad rule can't empty the week.
 */

import crypto from 'node:crypto';
import { localDateStr } from './seo.js';
import { eventKeyOf } from './db.js';

export const MAX_PER_RUN = 10;
const PAGE_RE = /^\/events\/[a-z0-9-]{3,200}$/;

export function hiddenPages(published) {
  return new Set((published && Array.isArray(published.hidden) ? published.hidden : []).map(h => h.page));
}

// Filter for anything public. `events` must already carry pages.
export function withoutHidden(events, published) {
  const hide = hiddenPages(published);
  return hide.size ? events.filter(ev => !hide.has(ev.page)) : events;
}

function secretOk(given, want) {
  const g = Buffer.from(String(given || ''));
  const w = Buffer.from(String(want || ''));
  // Compare byte lengths: timingSafeEqual throws on a mismatch.
  return w.length > 0 && g.length === w.length && crypto.timingSafeEqual(g, w);
}

export function registerEventCheck(app, { store, requireAdmin, nowFn, secret, loadVisible }) {
  // Live (already filtered) events, plus the raw published payload.
  async function current() {
    const published = (await store.getPublished()) || null;
    const visible = await loadVisible();
    return { published, visible };
  }

  app.post('/api/event-check/hide', async (req, res) => {
    if (!secretOk(req.get('x-cron-secret'), secret)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const asks = Array.isArray(req.body && req.body.hide) ? req.body.hide : null;
    if (!asks) return res.status(400).json({ ok: false, error: 'bad-payload', message: 'hide[] required' });
    if (asks.length > MAX_PER_RUN) {
      return res.status(400).json({ ok: false, error: 'too-many', message: `Refusing to hide ${asks.length} events at once (max ${MAX_PER_RUN}).` });
    }
    try {
      const { published, visible } = await current();
      if (!published) return res.status(409).json({ ok: false, error: 'nothing-published' });
      const today = localDateStr(nowFn());
      const restored = new Set(published.hidden_restored || []);
      const already = hiddenPages(published);
      const added = [];
      const skipped = [];
      for (const ask of asks) {
        const page = String(ask && ask.page || '');
        const reason = String(ask && ask.reason || '').slice(0, 120);
        const ev = PAGE_RE.test(page) ? visible.find(e => e.page === page) : null;
        if (!ev || ev.date < today) { skipped.push({ page, why: 'not-live' }); continue; }
        if (restored.has(page)) { skipped.push({ page, why: 'restored-by-admin' }); continue; }
        if (already.has(page)) { skipped.push({ page, why: 'already-hidden' }); continue; }
        already.add(page);
        added.push({ page, key: eventKeyOf(ev), name: ev.name, date: ev.date, venue: ev.venue || '', reason, at: nowFn().toISOString() });
      }
      if (added.length) {
        const keep = (published.hidden || []).filter(h => h.date >= today);
        await store.setPublished({ ...published, hidden: [...keep, ...added] });
      }
      res.json({ ok: true, hidden: added, skipped });
    } catch (err) {
      console.error('[event-check] hide failed:', err.message);
      res.status(500).json({ ok: false, error: 'server-error' });
    }
  });

  app.get('/api/admin/hidden', requireAdmin, async (req, res) => {
    const published = (await store.getPublished()) || {};
    const today = localDateStr(nowFn());
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, hidden: (published.hidden || []).filter(h => h.date >= today) });
  });

  app.post('/api/admin/hidden/restore', requireAdmin, async (req, res) => {
    const page = String(req.body && req.body.page || '');
    const published = await store.getPublished();
    if (!published || !hiddenPages(published).has(page)) return res.status(404).json({ ok: false, error: 'not-hidden' });
    const today = localDateStr(nowFn());
    await store.setPublished({
      ...published,
      hidden: published.hidden.filter(h => h.page !== page),
      // Don't let the next check hide it again. Old pages age out.
      hidden_restored: [...new Set([...(published.hidden_restored || []), page])]
        .filter(p => (p.match(/\/events\/(\d{4}-\d{2}-\d{2})/) || [])[1] >= today)
    });
    res.json({ ok: true, restored: page });
  });
}
