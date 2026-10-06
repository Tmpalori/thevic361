/* server/autopublish.js — Publish the collector's events without a manual step.
 *
 * The weekly collector commits candidates.json, which redeploys the site.
 * On boot (production only) this module publishes those candidates, so the
 * site, social kit and newsletter always have this week's events even if
 * nobody opens the admin.
 *
 * The admin stays in charge:
 *   - Events already published that are still upcoming are kept as-is
 *     (including anything the admin added by hand or edited), except that
 *     an event this module added takes the collector's newer copy of it
 *     (time, venue, address, link, description; the name only when the
 *     published one was cut off), so collector fixes reach live events.
 *   - Events this module added on an earlier run that two collector runs in
 *     a row no longer find are taken down: the collector fixed or dropped
 *     them. Never one from a source that only looks back a short time or
 *     answers differently each run (FB/IG posts, Gemini search), nor while
 *     its source didn't run ok this time, nor when the new run looks broken
 *     (far fewer events than this module has up).
 *   - An event this module added that the admin later removed is remembered
 *     and not re-added next run.
 *   - Approved community submissions are included.
 *   - Edits (the event_edits overlay) keep applying on read, as before.
 *
 * State lives in the published payload under `auto_publish`, which the
 * admin's Save & Publish already carries forward with other extras.
 */

import { eventKeyOf } from './db.js';
import { localDateStr, addDays } from './seo.js';
import { sameEvent } from './sponsors.js';

// Internal collector fields (_source, _also_from...) aren't public.
function publicFields(ev) {
  const out = {};
  // Underscore fields are internal; submitter_* is the submitter's contact.
  for (const [k, v] of Object.entries(ev || {})) if (!k.startsWith('_') && !k.startsWith('submitter_')) out[k] = v;
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

// Bump when the publish rules change so the next boot re-applies them to
// the current candidates (otherwise an unchanged candidates.json is skipped).
// 2: auto-added events the collector no longer finds are taken down.
// 3: auto-added events take the collector's newer copy of themselves.
// 4: big/town/curated refresh; the health check counts scraped events only.
// 5: scoring hints refresh; approved submissions are marked `submitted`.
// 6: retiring needs two misses, a source that ran ok, and never applies to
//    window-limited or non-deterministic sources.
export const AUTO_PUBLISH_RULES = 6;

// Sources whose events can't be retired for going missing. FB/IG posts are
// read back only a couple of weeks, so a post announcing an event weeks out
// drops out of the window before the event happens; Gemini search finds a
// different set each run.
export const NEVER_RETIRE_SOURCES = new Set(['apify_facebook_posts', 'apify_instagram_posts', 'gemini_search']);
// Consecutive collector runs an event must be missing from before it's
// taken down: one run's flicker (a slow page, a scraper's cap) isn't enough.
const RETIRE_AFTER_MISSES = 2;

// Every source that listed a candidate (its own plus the ones merged in).
function sourcesOf(ev) {
  return [ev && ev._source, ...((ev && ev._also_from) || [])].filter(s => typeof s === 'string' && s);
}

// What a newer collector copy may change on an event this module added.
// The name only when the published one was cut off (see cutOff).
// big/town/curated: tags set in local_events.yaml after an event went live.
// appeal/recurring/favorite/sources: the collector's scoring hints
// (server/scoring.js).
const REFRESH_FIELDS = ['time', 'venue', 'address', 'url', 'description', 'icons', 'free', 'big', 'town', 'curated',
  'appeal', 'recurring', 'favorite', 'sources'];
// Tags the collector writes only when set: a fresh copy without one means
// it was taken off (a wrong town removed from the YAML), so it goes.
// appeal/sources are different: missing means unknown, so they're kept.
// So is `recurring`: a bar's "every Tuesday" post and a dated "this
// Tuesday" post can alternate runs, and a weekly staple shouldn't flicker
// in and out of the weekly-repeat score (and editor's picks).
const TAG_FIELDS = ['big', 'town', 'curated', 'favorite'];

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// The published name is a cut-off copy of the new one: it stops mid-word
// ("... Quilt Guild of Greate" / "... of Greater Victoria") or ends in "...".
// Any other rename would move the event's page, so it's left alone.
export function cutOff(oldName, newName) {
  const a = normName(oldName), b = normName(newName);
  if (!a || b.length <= a.length) return false;
  if (b.startsWith(a) && b[a.length] !== ' ') return true;
  return /(\.\.\.|…)\s*$/.test(String(oldName || '')) && b.startsWith(a);
}

// New & Notable: this run's items first, then earlier finds still under
// three weeks old (items carry the date the collector found them).
const NOTABLE_KEEP_DAYS = 21;
const NOTABLE_MAX = 6;
export function mergeNotable(fresh, prior, today) {
  const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - NOTABLE_KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  const out = [];
  const seen = new Set();
  const add = (n) => {
    const k = String(n && n.name || '').toLowerCase().trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(n);
  };
  (fresh || []).forEach(add);
  (prior || []).filter(n => n && typeof n.added === 'string' && n.added >= cutoff).forEach(add);
  return out.slice(0, NOTABLE_MAX);
}

// The new run must have at least this share of the events this module has
// up before it may take any of them down.
const REPLACE_MIN_RATIO = 0.6;
// ...counted over the collector's own window. Hand-added events now run 90
// days ahead (local_events.yaml); counted too, they alone could pass the
// ratio on a run where every scraper failed and take the scraped events
// down.
const HEALTH_WINDOW_DAYS = 14;

// Take one event off the published list (an approved submission the admin
// rejected) and remember it as removed so auto-publish doesn't put it back.
// `key` may be a list: the submission's key now plus the keys it was
// published under before an edit, so an edited one still comes down.
export async function unpublishEvent(store, key, now) {
  const keys = new Set((Array.isArray(key) ? key : [key]).filter(Boolean));
  const prior = await store.getPublished();
  if (!prior || !Array.isArray(prior.events)) return false;
  const gone = prior.events.filter(ev => keys.has(eventKeyOf(ev))).map(eventKeyOf);
  if (!gone.length) return false;
  const events = prior.events.filter(ev => !keys.has(eventKeyOf(ev)));
  const state = prior.auto_publish || {};
  await store.setPublished({
    ...prior,
    last_updated: now.toISOString(),
    events,
    auto_publish: {
      ...state,
      keys: (state.keys || []).filter(k => !keys.has(k)),
      rejected: [...new Set([...(state.rejected || []), ...gone])]
    }
  });
  return true;
}

// The admin approved this event by hand: forget that it was removed before
// (e.g. rejected by mistake), so auto-publish may list it again.
export async function forgetRemoved(store, key) {
  const prior = await store.getPublished();
  const rejected = (prior && prior.auto_publish && prior.auto_publish.rejected) || [];
  if (!rejected.includes(key)) return false;
  await store.setPublished({ ...prior, auto_publish: { ...prior.auto_publish, rejected: rejected.filter(k => k !== key) } });
  return true;
}

// An approved submission edited in the admin: swap its live event for the
// edited one in place (same spot, auto-publish bookkeeping moved to the new
// key), so the fix shows up now and a later un-approve finds it. False when
// the old version isn't on the published list.
export async function replacePublishedEvent(store, oldKey, next, now) {
  const prior = await store.getPublished();
  if (!prior || !Array.isArray(prior.events)) return false;
  const idx = prior.events.findIndex(ev => eventKeyOf(ev) === oldKey);
  if (idx === -1) return false;
  const fresh = { ...prior.events[idx], ...publicFields(next) };
  const newKey = eventKeyOf(fresh);
  const events = prior.events.filter((ev, i) => i === idx || eventKeyOf(ev) !== newKey);
  events[events.indexOf(prior.events[idx])] = fresh;
  const state = prior.auto_publish || {};
  await store.setPublished({
    ...prior,
    last_updated: now.toISOString(),
    events,
    ...(prior.auto_publish ? {
      auto_publish: {
        ...state,
        keys: (state.keys || []).map(k => (k === oldKey ? newKey : k)),
        rejected: (state.rejected || []).filter(k => k !== newKey)
      }
    } : {})
  });
  return true;
}

export function createAutoPublish({ store, candidatesFile, readJsonFile, nowFn, slack = null, siteUrl, archiveEvents = () => {} }) {
  // submissionsOnly: add newly approved submissions and nothing else (the AI
  // submission review). The collector's candidates are left out entirely,
  // so it never publishes them when AUTO_PUBLISH=0 and never re-adds or
  // retires anything on its own.
  async function run({ force = false, quiet = false, submissionsOnly = false } = {}) {
    let candidates = null;
    if (!submissionsOnly) {
      try {
        candidates = await readJsonFile(candidatesFile);
      } catch (err) {
        return { ok: false, error: 'no-candidates', message: err.message };
      }
    }
    const published = await store.getPublished();
    // Nothing published yet means the site shows the bundled docs/events.json;
    // a submissions-only publish would replace that whole list with just
    // the approved submissions. Wait for a candidates publish instead.
    if (submissionsOnly && !published) return { ok: false, error: 'nothing-published' };
    const prior = published || {};
    const state = prior.auto_publish || {};
    const from = submissionsOnly ? (state.from || null) : candidates && candidates.last_updated;
    const fresh = !submissionsOnly && Array.isArray(candidates && candidates.events) ? candidates.events : [];
    if (!force && from && state.from === from && state.rules === AUTO_PUBLISH_RULES) {
      return { ok: true, skipped: 'already-published', from };
    }

    const today = localDateStr(nowFn());
    const upcoming = ev => ev && ev.date >= today && ev.name;
    const priorUpcoming = (Array.isArray(prior.events) ? prior.events : []).filter(upcoming);

    // Retire events this module added before that the new run no longer has.
    // Hand-added and hand-edited events are never touched.
    const autoKeys = new Set(state.keys || []);
    let edited = new Set();
    try {
      if (typeof store.listEventEdits === 'function') {
        edited = new Set((await store.listEventEdits()).map(e => e.original_key));
      }
    } catch (err) {
      console.warn('[auto-publish] event edits unavailable, retiring nothing:', err.message);
      edited = null;
    }
    const freshUpcoming = fresh.filter(upcoming);
    const ours = priorUpcoming.filter(ev => autoKeys.has(eventKeyOf(ev)));
    const healthEnd = addDays(today, HEALTH_WINDOW_DAYS);
    const scraped = ev => ev.date <= healthEnd && !ev.curated && ev._source !== 'local_events';
    const healthy = !submissionsOnly &&
      freshUpcoming.filter(scraped).length >= ours.filter(scraped).length * REPLACE_MIN_RATIO;
    const stillFound = ev => freshUpcoming.some(f => eventKeyOf(f) === eventKeyOf(ev) || sameEvent(f, ev));
    // What each key's source was (keys from before rule 6 have none: they
    // still need two misses) and how many runs in a row it's been missing.
    // A miss counts once per collector run (`from`), so a forced re-run or
    // a rules bump on the same candidates doesn't count it twice.
    const priorSources = (state.sources && typeof state.sources === 'object') ? state.sources : {};
    const priorMissing = (state.missing && typeof state.missing === 'object') ? state.missing : {};
    const newRun = !submissionsOnly && (from || null) !== (state.missing_from ?? null);
    const runStatus = (candidates && candidates.sources && typeof candidates.sources === 'object') ? candidates.sources : null;
    const missing = {};
    const retired = [];
    for (const ev of ours) {
      const k = eventKeyOf(ev);
      if (stillFound(ev)) continue;
      if (!edited) { // edits unreadable: retire nothing, forget nothing
        if (priorMissing[k]) missing[k] = priorMissing[k];
        continue;
      }
      if (edited.has(k)) continue;
      const srcs = Array.isArray(priorSources[k]) ? priorSources[k] : [];
      if (srcs.some(s => NEVER_RETIRE_SOURCES.has(s))) continue;
      const n = Number(priorMissing[k]) || 0;
      // A source that errored or came back empty this run says nothing
      // about whether its events still exist.
      const sourceOk = !runStatus || srcs.every(s => runStatus[s] === 'ok');
      const count = healthy && sourceOk && newRun ? n + 1 : n;
      if (count >= RETIRE_AFTER_MISSES && healthy && sourceOk) retired.push(ev);
      else if (count) missing[k] = count;
    }
    const retiredKeys = new Set(retired.map(eventKeyOf));
    const kept = priorUpcoming.filter(ev => !retiredKeys.has(eventKeyOf(ev)));
    const keptKeys = new Set(kept.map(eventKeyOf));
    if (!healthy && ours.length && !submissionsOnly) {
      console.warn(`[auto-publish] new run has ${freshUpcoming.length} upcoming events vs ${ours.length} auto-published; retiring nothing`);
      // A scraper probably broke: the week keeps last run's events, but
      // the owner should know before the next run quietly does the same.
      if (slack) {
        slack.alert('collector-unhealthy', 'Collector found far fewer events than last run; nothing was taken down',
          `${freshUpcoming.length} upcoming events this run vs ${ours.length} published by the last one. Check the Weekly Collect run and the Sources tab.`,
          `${siteUrl}/admin.html`);
      }
    }

    // Auto-added last time but missing now: the admin took it down.
    // (Retired events aren't "rejected": if a later run finds them again,
    // they come back.)
    const rejected = new Set([
      ...(state.rejected || []),
      ...(state.keys || []).filter(k => !keptKeys.has(k) && !retiredKeys.has(k))
    ].filter(k => k.slice(0, 10) >= today));

    let approved = [];
    try {
      // `submitted` earns the community-submission bonus in the event score.
      approved = (await store.list({ status: 'approved' })).map(r => ({ ...r.payload, submitted: true })).filter(upcoming);
    } catch (err) {
      console.warn('[auto-publish] approved submissions skipped:', err.message);
    }

    const events = [...kept];
    const added = [];
    let skippedRejected = 0;
    // An event this module published earlier gets the collector's newer copy
    // (cleaned venue, a link, the full name...), or collector fixes would
    // never reach anything already live. Never an event the admin edited or
    // added, an approved submission, a featured one, or when edits can't be
    // read. A hidden or restored event keeps its name and venue (the
    // hidden entry is matched by its key); so does one whose new key is
    // taken by another event.
    const approvedKeys = new Set(approved.map(eventKeyOf));
    const hiddenKeys = new Set([
      ...(Array.isArray(prior.hidden) ? prior.hidden.map(h => h && h.key) : []),
      ...(prior.hidden_restored || [])
    ]);
    const refreshed = new Set();
    const renamed = new Map();
    const canRefresh = ev => {
      const k = eventKeyOf(ev);
      return edited && autoKeys.has(k) && !edited.has(k) && !approvedKeys.has(k) && !ev.featured && !refreshed.has(k);
    };
    const refresh = (i, ev) => {
      const old = events[i];
      const oldKey = eventKeyOf(old);
      const next = { ...old };
      for (const f of REFRESH_FIELDS) if (f in ev) next[f] = ev[f];
      for (const f of TAG_FIELDS) if (!(f in ev)) delete next[f];
      if (!ev.description) next.description = old.description;
      if (cutOff(old.name, ev.name)) next.name = ev.name;
      const newKey = eventKeyOf(next);
      if (newKey !== oldKey && (hiddenKeys.has(oldKey) || events.some((e, j) => j !== i && eventKeyOf(e) === newKey))) {
        next.name = old.name;
        next.venue = old.venue;
      }
      const finalKey = eventKeyOf(next);
      refreshed.add(finalKey);
      if (JSON.stringify(next) === JSON.stringify(old)) return false;
      events[i] = next;
      if (finalKey !== oldKey) renamed.set(oldKey, finalKey);
      return true;
    };
    let updated = 0;
    const freshSet = new Set(fresh);
    const sourcesNow = new Map();
    const noteSources = (k, raw) => {
      const add = sourcesOf(raw);
      if (add.length) sourcesNow.set(k, [...new Set([...(sourcesNow.get(k) || []), ...add])]);
    };
    for (const raw of [...approved, ...fresh.filter(upcoming)]) {
      const ev = publicFields(raw);
      const key = eventKeyOf(ev);
      if (rejected.has(key)) { skippedRejected++; continue; }
      const i = events.findIndex(e => eventKeyOf(e) === key || sameEvent(e, ev));
      if (i !== -1 && raw.submitted === true && !events[i].submitted) {
        // Live already, but Save & Publish sent the admin's copy, which
        // doesn't carry the flag; the score's submission bonus needs it.
        events[i] = { ...events[i], submitted: true };
      }
      if (i !== -1) {
        const mine = autoKeys.has(eventKeyOf(events[i]));
        if (freshSet.has(raw) && canRefresh(events[i]) && refresh(i, ev)) updated++;
        if (mine && freshSet.has(raw)) noteSources(eventKeyOf(events[i]), raw);
        continue;
      }
      events.push(ev);
      added.push(key);
      if (freshSet.has(raw)) noteSources(key, raw);
    }
    events.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));

    const { events: _e, last_updated: _l, auto_publish: _a, ...extras } = prior;
    const now = nowFn().toISOString();
    const stillPresent = new Set(events.map(eventKeyOf));
    const keys = [...new Set([...(state.keys || []).map(k => renamed.get(k) || k).filter(k => stillPresent.has(k)), ...added])];
    // Sources found this run add to the ones recorded before (an event once
    // seen in a post stays never-retired), following renamed keys.
    const sources = {};
    const oldKeyOf = new Map([...renamed].map(([o, n]) => [n, o]));
    for (const k of keys) {
      const before = priorSources[k] || priorSources[oldKeyOf.get(k)] || [];
      const all = [...new Set([...(Array.isArray(before) ? before : []), ...(sourcesNow.get(k) || [])])];
      if (all.length) sources[k] = all;
    }
    const payload = {
      ...extras,
      // Candidates from before New & Notable was automated have no list:
      // keep whatever is published.
      ...(candidates && Array.isArray(candidates.new_and_notable)
        ? { new_and_notable: mergeNotable(candidates.new_and_notable, extras.new_and_notable, today) }
        : {}),
      last_updated: now,
      events,
      // "Show anyway" keys follow an event this run renamed.
      ...(Array.isArray(extras.kept) ? { kept: extras.kept.map(k => renamed.get(k) || k) } : {}),
      auto_publish: {
        from: from || null,
        at: now,
        keys,
        rejected: [...rejected],
        sources,
        // Kept for keys still live and still missing; anything found again
        // starts over.
        missing: Object.fromEntries(Object.entries(submissionsOnly ? priorMissing : missing).filter(([k]) => stillPresent.has(k))),
        missing_from: newRun ? (from || null) : (state.missing_from ?? null),
        // A submissions-only run doesn't count as publishing these
        // candidates; the next boot still publishes them as usual.
        rules: submissionsOnly ? (state.rules ?? null) : AUTO_PUBLISH_RULES
      }
    };
    await store.setPublished(payload);
    archiveEvents(events);

    const result = { ok: true, published: events.length, added: added.length, kept: kept.length, updated, retired: retired.length, skipped_removed: skippedRejected, from };
    console.log('[auto-publish]', JSON.stringify(result));
    const upcomingCount = events.filter(upcoming).length;
    if (slack && !submissionsOnly && !upcomingCount) {
      // Nothing coming up on the site is breakage, not news: alerts channel.
      slack.alert('auto-publish-empty', 'Auto-publish found no upcoming events',
        'The site has nothing coming up. Check the Weekly Collect run and the Sources tab.', `${siteUrl}/admin.html`);
    }
    if (slack && !quiet && upcomingCount) {
      slack.notify({
        title: `🗓️ Published ${events.length} events automatically`,
        fields: [['New this run', added.length], ['Kept from before', kept.length], ['Updated from the collector', updated],
          ['Taken down (no longer found)', retired.length], ['Skipped (you removed)', skippedRejected]],
        link: `${siteUrl}/admin.html`, footer: 'Edit or remove anything in admin'
      });
    }
    return result;
  }

  return { run };
}
