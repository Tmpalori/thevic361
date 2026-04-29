/* server/sources.js — Per-source collection status for the admin "Sources" tab.
 *
 * Reads the local `collection_metadata.json` written by collect_events.py
 * (alongside candidates.json) and surfaces it to the admin UI:
 *
 *   - per-source row with name, count, status, last/started timestamps
 *   - last successful collection run timestamp (file mtime fallback)
 *   - next scheduled auto-pull time, computed from the Weekly Collect cron
 *
 * The cron in `.github/workflows/weekly-collect.yml` is `0 23 * * 0` — every
 * Sunday at 23:00 UTC. That's 6 PM CDT (Mar–Nov, UTC-5) or 5 PM CST
 * (Nov–Mar, UTC-6); the workflow file documents that DST drift as
 * intentional. We compute the next run as the next Sunday at 23:00 UTC.
 *
 * If `collection_metadata.json` is missing (e.g. the workflow hasn't run yet
 * after this code shipped), the response falls back to "unknown" but still
 * tells the UI when the next auto-pull will be and which sources we expect.
 */

import { promises as fsp } from 'node:fs';

// Source list expected from collect_events.py. Used to render placeholder
// rows when collection_metadata.json doesn't yet exist (e.g. between the
// time this code ships and the next Sunday workflow run).
const KNOWN_SOURCES = [
  { name: 'local_events',          label: 'Local YAML',           category: 'local' },
  { name: 'google_sheet',          label: 'Google Sheet',         category: 'submission' },
  { name: 'city_calendar',         label: 'City of Victoria',     category: 'web' },
  { name: 'chamber',               label: 'Chamber of Commerce',  category: 'web' },
  { name: 'library',               label: 'Public Library',       category: 'web' },
  { name: 'moonshine',             label: 'Moonshine Drinkery',   category: 'web' },
  { name: 'vtx_artwalk',           label: 'VTX Art Walk',         category: 'web' },
  { name: 'jwelch',                label: 'J Welch Farms',        category: 'web' },
  { name: 'theatre_victoria',      label: 'Theatre Victoria',     category: 'web' },
  { name: 'generals',              label: 'Victoria Generals',    category: 'web' },
  { name: 'allevents',             label: 'AllEvents.in',         category: 'web' },
  { name: 'apify_facebook',        label: 'Apify · Facebook events', category: 'apify' },
  { name: 'apify_facebook_posts',  label: 'Apify · Facebook posts → Sonar', category: 'apify' },
  { name: 'apify_instagram_posts', label: 'Apify · Instagram posts → Sonar', category: 'apify' },
  { name: 'perplexity',            label: 'Perplexity Sonar',     category: 'ai' },
];

const KNOWN_BY_NAME = new Map(KNOWN_SOURCES.map(s => [s.name, s]));

// Compute the next Sunday at 23:00 UTC strictly AFTER `now`. The workflow
// cron is `0 23 * * 0` so this is the next scheduled trigger; the actual
// Central-time equivalent shifts an hour around DST switches but the UTC
// instant is exact.
export function nextWeeklyRunUtc(now) {
  const ref = now ? new Date(now.getTime()) : new Date();
  // Build today's 23:00 UTC as the candidate.
  const next = new Date(Date.UTC(
    ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), 23, 0, 0, 0
  ));
  const dow = next.getUTCDay(); // 0 = Sunday
  let addDays;
  if (dow === 0) {
    addDays = next.getTime() > ref.getTime() ? 0 : 7;
  } else {
    addDays = (7 - dow) % 7;
    if (addDays === 0) addDays = 7;
  }
  next.setUTCDate(next.getUTCDate() + addDays);
  return next;
}

// Reads `collection_metadata.json` from disk if present. Returns null on
// any read/parse failure — callers must degrade gracefully.
export async function readMetadataFile(metadataPath) {
  try {
    const stat = await fsp.stat(metadataPath);
    const raw = await fsp.readFile(metadataPath, 'utf8');
    const parsed = JSON.parse(raw);
    return { meta: parsed, mtime: stat.mtime.toISOString() };
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return null;
  }
}

// Builds the response payload the /api/admin/sources route returns. Pure
// function over its inputs so it's easy to test.
export function buildSourcesPayload({ metadata, mtime, now, githubConfigured, actionsUrl }) {
  const next = nextWeeklyRunUtc(now);
  const seenNames = new Set();
  const rows = [];

  // Map from collector stats. Falls back to {} when metadata is missing.
  const lastRunAt = (metadata && metadata.last_run_at) || mtime || null;
  const stats = Array.isArray(metadata && metadata.sources) ? metadata.sources : [];

  for (const s of stats) {
    const known = KNOWN_BY_NAME.get(s.name);
    rows.push({
      name: s.name,
      label: known ? known.label : s.name,
      category: known ? known.category : 'other',
      count: typeof s.count === 'number' ? s.count : 0,
      status: s.status || 'unknown',
      message: s.message || null,
      started_at: s.started_at || null,
      finished_at: s.finished_at || null,
      last_pulled_at: s.finished_at || lastRunAt,
    });
    seenNames.add(s.name);
  }

  // Fill in placeholder rows for any known source the metadata didn't cover.
  // Status "unknown" tells the UI to render a muted state — no count, no
  // last-pulled time. This keeps the tab useful before the first metadata
  // file is written.
  for (const k of KNOWN_SOURCES) {
    if (seenNames.has(k.name)) continue;
    rows.push({
      name: k.name,
      label: k.label,
      category: k.category,
      count: 0,
      status: 'unknown',
      message: metadata
        ? 'Source did not appear in latest collection metadata.'
        : 'No collection_metadata.json yet — waiting for the next pull.',
      started_at: null,
      finished_at: null,
      last_pulled_at: null,
    });
  }

  return {
    ok: true,
    last_run_at: lastRunAt,
    next_run_at: next.toISOString(),
    next_run_cron: '0 23 * * 0',
    next_run_note: 'Sundays 23:00 UTC (≈ 6 PM Central CDT / 5 PM Central CST)',
    metadata_present: Boolean(metadata),
    merged_count: metadata && typeof metadata.merged_count === 'number'
      ? metadata.merged_count : null,
    raw_count: metadata && typeof metadata.raw_count === 'number'
      ? metadata.raw_count : null,
    window_start: metadata && metadata.window_start ? metadata.window_start : null,
    window_end: metadata && metadata.window_end ? metadata.window_end : null,
    candidates_only: metadata && typeof metadata.candidates_only === 'boolean'
      ? metadata.candidates_only : null,
    trigger_enabled: Boolean(githubConfigured),
    trigger_workflow_file: 'weekly-collect.yml',
    // Always provide the GitHub Actions URL so the UI can show a manual
    // "Run workflow" fallback link regardless of whether one-click Pull Now
    // is enabled. The user can run the workflow with their normal GitHub
    // login even if no server-side token is configured.
    actions_url: actionsUrl || null,
    // Save & Publish does NOT depend on the GITHUB_TOKEN required for
    // workflow_dispatch. Surface this so the UI can reassure the user when
    // Pull Now fails.
    save_publish_unaffected: true,
    sources: rows,
  };
}

export const KNOWN_SOURCES_FOR_TESTS = KNOWN_SOURCES;
