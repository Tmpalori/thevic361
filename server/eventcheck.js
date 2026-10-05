/* server/eventcheck.js — Events hidden by the event check, and undoing it.
 *
 * scripts/sweep_events.py (run by .github/workflows/event-check.yml) looks
 * over the live list after each publish. The certain, rule-based findings
 * (church events, non-events, exact duplicates) it hides on its own through
 * POST /api/event-check/hide; judgment calls only go to Slack.
 *
 * Hiding never deletes. The published payload keeps the event and gains a
 * `hidden` entry; the public list leaves hidden events out at read time, so
 * the site, /events.json, the newsletter, the social kit and the sitemap
 * all drop it together. Auto-publish and the admin's Save & Publish carry
 * `hidden` forward like any other extra.
 *
 * Identity: an entry is matched by the event's ORIGINAL key (date|name|venue
 * as published, before the admin edits overlay), not by its page URL. Page
 * slugs shift when a same-named event is added ("bingo-2" becomes another
 * event's page) and change when the admin renames an event; the original key
 * does neither. Entries also remember the page and shown key at hide time,
 * so archived copies of the event stay hidden too.
 *
 * Entries are kept for ARCHIVE_DAYS after the event (like the archive
 * itself), so a hidden event's page doesn't come back once its date passes.
 *
 * Restoring (admin Home) removes the entry and remembers the original key in
 * `hidden_restored`, so the next check doesn't hide it again.
 *
 * Safety: the hide endpoint needs the shared secret, only hides events that
 * are live and upcoming, and refuses more than MAX_PER_RUN at once, so a bad
 * rule can't empty the week.
 */

import crypto from 'node:crypto';
import { localDateStr, withPages, addDays } from './seo.js';
import { eventKeyOf, applyEventEdits } from './db.js';

export const MAX_PER_RUN = 10;
const ARCHIVE_DAYS = 400;
const PAGE_RE = /^\/events\/[a-z0-9-]{3,200}$/;
const OKEY = '_okey';

function entries(published) {
  return published && Array.isArray(published.hidden) ? published.hidden : [];
}

function hiddenSets(published) {
  const keys = new Set(), shown = new Set(), pages = new Set();
  for (const h of entries(published)) {
    if (h.key) keys.add(h.key);
    if (h.shown_key) shown.add(h.shown_key);
    if (h.page) pages.add(h.page);
  }
  return { keys, shown, pages };
}

// Published events with their original key attached, the edits overlay
// applied, and pages assigned. Hidden events are still in the list.
export function keyedEvents(events, edits = []) {
  const tagged = (Array.isArray(events) ? events : []).map(ev => ({ ...ev, [OKEY]: eventKeyOf(ev) }));
  return withPages(applyEventEdits(tagged, edits));
}

// What the public sees, still carrying the original key (for the hide
// endpoint). Pages are assigned before filtering so hiding one event
// never renumbers another's URL.
export function visibleKeyed(published, edits = []) {
  const { keys } = hiddenSets(published);
  const all = keyedEvents(published && published.events, edits);
  return keys.size ? all.filter(ev => !keys.has(ev[OKEY])) : all;
}

export function stripKeys(events) {
  return events.map(({ [OKEY]: _k, ...ev }) => ev);
}

// For lists without original keys (the archive): drop anything matching a
// hidden entry by page, shown key or original key.
export function withoutHidden(events, published) {
  const { keys, shown, pages } = hiddenSets(published);
  if (!keys.size && !pages.size) return events;
  return events.filter(ev => {
    const k = eventKeyOf(ev);
    return !(pages.has(ev.page) || shown.has(k) || keys.has(k));
  });
}

function secretOk(given, want) {
  const g = Buffer.from(String(given || ''));
  const w = Buffer.from(String(want || ''));
  // Compare byte lengths: timingSafeEqual throws on a mismatch.
  return w.length > 0 && g.length === w.length && crypto.timingSafeEqual(g, w);
}

export function registerEventCheck(app, { store, requireAdmin, nowFn, secret, loadVisibleKeyed }) {
  app.post('/api/event-check/hide', async (req, res) => {
    if (!secretOk(req.get('x-cron-secret'), secret)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const asks = Array.isArray(req.body && req.body.hide) ? req.body.hide : null;
    if (!asks) return res.status(400).json({ ok: false, error: 'bad-payload', message: 'hide[] required' });
    try {
      const published = await store.getPublished();
      if (!published) return res.status(409).json({ ok: false, error: 'nothing-published' });
      const visible = await loadVisibleKeyed();
      const today = localDateStr(nowFn());
      const restored = new Set(published.hidden_restored || []);
      const add = [];
      const skipped = [];
      for (const ask of asks) {
        const page = String(ask && ask.page || '');
        const reason = String(ask && ask.reason || '').slice(0, 120);
        const ev = PAGE_RE.test(page) ? visible.find(e => e.page === page) : null;
        if (!ev || ev.date < today) { skipped.push({ page, why: 'not-live' }); continue; }
        if (restored.has(ev[OKEY])) { skipped.push({ page, why: 'restored-by-admin' }); continue; }
        if (add.some(a => a.key === ev[OKEY])) continue;
        const { [OKEY]: key, ...shown } = ev;
        add.push({ key, shown_key: eventKeyOf(shown), page, name: ev.name, date: ev.date, venue: ev.venue || '', reason, at: nowFn().toISOString() });
      }
      // Counted after skipping restored/past ones: those never use up the cap.
      if (add.length > MAX_PER_RUN) {
        return res.status(400).json({ ok: false, error: 'too-many', message: `Refusing to hide ${add.length} events at once (max ${MAX_PER_RUN}).`, skipped });
      }
      if (add.length) {
        // Re-read right before writing so a publish that landed meanwhile
        // isn't overwritten with the older copy.
        const latest = (await store.getPublished()) || published;
        const cutoff = addDays(today, -ARCHIVE_DAYS);
        const have = new Set(entries(latest).map(h => h.key));
        const keep = entries(latest).filter(h => h.date >= cutoff);
        await store.setPublished({ ...latest, hidden: [...keep, ...add.filter(a => !have.has(a.key))] });
      }
      res.json({ ok: true, hidden: add, skipped });
    } catch (err) {
      console.error('[event-check] hide failed:', err.message);
      res.status(500).json({ ok: false, error: 'server-error' });
    }
  });

  app.get('/api/admin/hidden', requireAdmin, async (req, res) => {
    const published = (await store.getPublished()) || {};
    const today = localDateStr(nowFn());
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, hidden: entries(published).filter(h => h.date >= today) });
  });

  app.post('/api/admin/hidden/restore', requireAdmin, async (req, res) => {
    const key = String(req.body && req.body.key || '');
    const published = await store.getPublished();
    if (!published || !entries(published).some(h => h.key === key)) return res.status(404).json({ ok: false, error: 'not-hidden' });
    const today = localDateStr(nowFn());
    await store.setPublished({
      ...published,
      hidden: published.hidden.filter(h => h.key !== key),
      // Don't let the next check hide it again. Keys start with the date,
      // so past ones age out.
      hidden_restored: [...new Set([...(published.hidden_restored || []), key])].filter(k => k.slice(0, 10) >= today)
    });
    res.json({ ok: true, restored: key });
  });
}
