/* server/autopublish.js — Publish the collector's events without a manual step.
 *
 * The weekly collector commits candidates.json, which redeploys the site.
 * On boot (production only) this module publishes those candidates, so the
 * site, social kit and newsletter always have this week's events even if
 * nobody opens the admin.
 *
 * The admin stays in charge:
 *   - Events already published that are still upcoming are kept as-is
 *     (including anything the admin added by hand).
 *   - An event this module added that the admin later removed is remembered
 *     and not re-added next run.
 *   - Approved community submissions are included.
 *   - Edits (the event_edits overlay) keep applying on read, as before.
 *
 * State lives in the published payload under `auto_publish`, which the
 * admin's Save & Publish already carries forward with other extras.
 */

import { eventKeyOf } from './db.js';
import { localDateStr } from './seo.js';
import { sameEvent } from './sponsors.js';

// Internal collector fields (_source, _also_from...) aren't public.
function publicFields(ev) {
  const out = {};
  for (const [k, v] of Object.entries(ev || {})) if (!k.startsWith('_')) out[k] = v;
  return out;
}

function sortKey(ev) {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(ev.time || '');
  let mins = 24 * 60;
  if (m) {
    mins = (Number(m[1]) % 12) * 60 + Number(m[2]) + (/pm/i.test(m[3]) ? 720 : 0);
  }
  return `${ev.date}|${String(mins).padStart(4, '0')}`;
}

export function createAutoPublish({ store, candidatesFile, readJsonFile, nowFn, slack = null, siteUrl, archiveEvents = () => {} }) {
  async function run({ force = false } = {}) {
    let candidates;
    try {
      candidates = await readJsonFile(candidatesFile);
    } catch (err) {
      return { ok: false, error: 'no-candidates', message: err.message };
    }
    const from = candidates && candidates.last_updated;
    const fresh = Array.isArray(candidates && candidates.events) ? candidates.events : [];
    const prior = (await store.getPublished()) || {};
    const state = prior.auto_publish || {};
    if (!force && from && state.from === from) return { ok: true, skipped: 'already-published', from };

    const today = localDateStr(nowFn());
    const upcoming = ev => ev && ev.date >= today && ev.name;
    const kept = (Array.isArray(prior.events) ? prior.events : []).filter(upcoming);
    const keptKeys = new Set(kept.map(eventKeyOf));

    // Auto-added last time but missing now: the admin took it down.
    const rejected = new Set([
      ...(state.rejected || []),
      ...(state.keys || []).filter(k => !keptKeys.has(k))
    ].filter(k => k.slice(0, 10) >= today));

    let approved = [];
    try {
      approved = (await store.list({ status: 'approved' })).map(r => r.payload).filter(upcoming);
    } catch (err) {
      console.warn('[auto-publish] approved submissions skipped:', err.message);
    }

    const events = [...kept];
    const added = [];
    let skippedRejected = 0;
    for (const raw of [...approved, ...fresh.filter(upcoming)]) {
      const ev = publicFields(raw);
      const key = eventKeyOf(ev);
      if (rejected.has(key)) { skippedRejected++; continue; }
      if (events.some(e => eventKeyOf(e) === key || sameEvent(e, ev))) continue;
      events.push(ev);
      added.push(key);
    }
    events.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));

    const { events: _e, last_updated: _l, auto_publish: _a, ...extras } = prior;
    const now = nowFn().toISOString();
    const stillPresent = new Set(events.map(eventKeyOf));
    const payload = {
      ...extras,
      last_updated: now,
      events,
      auto_publish: {
        from: from || null,
        at: now,
        keys: [...new Set([...(state.keys || []).filter(k => stillPresent.has(k)), ...added])],
        rejected: [...rejected]
      }
    };
    await store.setPublished(payload);
    archiveEvents(events);

    const result = { ok: true, published: events.length, added: added.length, kept: kept.length, skipped_removed: skippedRejected, from };
    console.log('[auto-publish]', JSON.stringify(result));
    if (slack) {
      slack.notify({
        title: `🗓️ Published ${events.length} events automatically`,
        fields: [['New this run', added.length], ['Kept from before', kept.length], ['Skipped (you removed)', skippedRejected]],
        text: events.length ? '' : 'No upcoming events were found. Check the collector run.',
        link: `${siteUrl}/admin.html`, footer: 'Edit or remove anything in admin'
      });
    }
    return result;
  }

  return { run };
}
