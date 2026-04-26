// Smoke test for the static admin panel (docs/admin.html + admin.js).
//
// Loads the static HTML into jsdom and evaluates admin.js so we can verify:
//   - The auth gate is shown when no PAT is in localStorage
//   - The app shell unhides when a PAT is present
//   - Pure helpers (filtering, grouping, weekend detection, newsletter HTML)
//     behave correctly on representative candidate data
//
// No real GitHub PAT or network call is required.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(__dirname, '..', 'docs');

const HTML = readFileSync(resolve(DOCS, 'admin.html'), 'utf8');
const JS = readFileSync(resolve(DOCS, 'admin.js'), 'utf8');

function bootDom({ pat = null } = {}) {
  // Reset jsdom DOM and globals between tests.
  // Extract the body contents from the static HTML.
  const bodyMatch = HTML.match(/<body>([\s\S]*?)<\/body>/);
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : '';
  // Strip the trailing <script src="./admin.js"> — we'll evaluate JS directly.
  document.querySelectorAll('script[src*="admin.js"]').forEach(s => s.remove());

  delete window.__vic361Admin;
  window.localStorage.clear();
  if (pat) window.localStorage.setItem('vic361_admin_pat', pat);

  // Evaluate admin.js in the jsdom global scope. The IIFE uses window/document
  // from its enclosing scope, which in jsdom is the test global scope.
  // eslint-disable-next-line no-eval
  (0, eval)(JS);
  return window.__vic361Admin;
}

describe('admin.html static structure', () => {
  it('exposes the expected core element ids', () => {
    bootDom();
    const ids = [
      'auth-gate', 'auth-form', 'auth-pat', 'auth-error',
      'app', 'signout-btn',
      'tab-picker', 'tab-preview', 'tab-newsletter',
      'filter-search', 'filter-category', 'filter-venue',
      'reload-btn', 'publish-btn',
      'preview-frame', 'preview-refresh',
      'newsletter-html', 'newsletter-copy', 'newsletter-refresh',
      'count-summary', 'count-guidance', 'status-message',
      'picker-list', 'picker-loading', 'picker-empty', 'picker-error'
    ];
    for (const id of ids) {
      expect(document.getElementById(id), `missing #${id}`).not.toBeNull();
    }
  });

  it('exposes three tab buttons', () => {
    bootDom();
    const tabs = document.querySelectorAll('.tab-btn');
    expect(tabs.length).toBe(3);
    expect(Array.from(tabs).map(t => t.dataset.tab).sort())
      .toEqual(['newsletter', 'picker', 'preview']);
  });
});

describe('admin auth gate behavior', () => {
  it('shows the auth gate when no PAT is in localStorage', () => {
    bootDom();
    const gate = document.getElementById('auth-gate');
    const app = document.getElementById('app');
    expect(gate.hidden).toBe(false);
    expect(app.hidden).toBe(true);
  });

  it('shows the app shell when a PAT is already in localStorage', () => {
    bootDom({ pat: 'ghp_fake_for_test' });
    const gate = document.getElementById('auth-gate');
    const app = document.getElementById('app');
    expect(gate.hidden).toBe(true);
    expect(app.hidden).toBe(false);
  });

  it('Sign out clears the PAT and re-shows the auth gate', () => {
    bootDom({ pat: 'ghp_fake_for_test' });
    document.getElementById('signout-btn').click();
    expect(window.localStorage.getItem('vic361_admin_pat')).toBeNull();
    expect(document.getElementById('auth-gate').hidden).toBe(false);
    expect(document.getElementById('app').hidden).toBe(true);
  });
});

describe('admin pure helpers', () => {
  let api;
  beforeEach(() => { api = bootDom(); });
  afterEach(() => { delete window.__vic361Admin; });

  const sampleEvents = [
    {
      date: '2026-04-20', name: 'Monday Bingo', time: '6 PM',
      venue: 'Palace Bingo', icons: ['community'], description: 'Cards at the door'
    },
    {
      date: '2026-04-25', name: 'Saturday Market', time: '9 AM',
      venue: 'Town Square', icons: ['shopping', 'free'], free: true,
      description: 'Local vendors and food'
    },
    {
      date: '2026-04-26', name: 'Sunday Concert', time: '7 PM',
      venue: 'Riverside Park', icons: ['music'], description: 'Free outdoor concert'
    }
  ];

  it('isWeekend identifies Fri/Sat/Sun', () => {
    expect(api.isWeekend('2026-04-20')).toBe(false); // Monday
    expect(api.isWeekend('2026-04-24')).toBe(true);  // Friday
    expect(api.isWeekend('2026-04-25')).toBe(true);  // Saturday
    expect(api.isWeekend('2026-04-26')).toBe(true);  // Sunday
    expect(api.isWeekend('')).toBe(false);
  });

  it('eventKey is stable and unique across events', () => {
    const keys = sampleEvents.map(api.eventKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toContain('Monday Bingo');
  });

  it('applyFilters filters by category, venue, and search', () => {
    api._state.candidates = sampleEvents;
    api._state.filters = { search: '', category: 'music', venue: '' };
    expect(api.applyFilters(sampleEvents).map(e => e.name)).toEqual(['Sunday Concert']);

    api._state.filters = { search: 'market', category: '', venue: '' };
    expect(api.applyFilters(sampleEvents).map(e => e.name)).toEqual(['Saturday Market']);

    api._state.filters = { search: '', category: '', venue: 'Palace Bingo' };
    expect(api.applyFilters(sampleEvents).map(e => e.name)).toEqual(['Monday Bingo']);
  });

  it('groupByDate buckets events by date in chronological order', () => {
    const groups = api.groupByDate(sampleEvents);
    expect(groups.map(([d]) => d)).toEqual(['2026-04-20', '2026-04-25', '2026-04-26']);
    expect(groups[0][1][0].name).toBe('Monday Bingo');
  });

  it('buildNewsletterHtml renders selected events into HTML', () => {
    api._state.candidates = sampleEvents;
    api._state.selected = new Set(sampleEvents.map(api.eventKey));
    const html = api.buildNewsletterHtml();
    expect(html).toContain('Saturday Market');
    expect(html).toContain('Sunday Concert');
    expect(html).toContain('This Week in The Vic 361');
  });

  it('buildNewsletterHtml returns an empty-state message when nothing selected', () => {
    api._state.candidates = sampleEvents;
    api._state.selected = new Set();
    expect(api.buildNewsletterHtml()).toContain('No events selected');
  });

  it('utf8ToBase64 round-trips UTF-8 text', () => {
    const s = 'Vic 361 — café & música';
    const b64 = api.utf8ToBase64(s);
    // Decode through Buffer to confirm fidelity.
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    expect(decoded).toBe(s);
  });

  it('exposes the documented constants', () => {
    expect(api._constants.PAT_KEY).toBe('vic361_admin_pat');
    expect(api._constants.REPO_OWNER).toBe('Tmpalori');
    expect(api._constants.REPO_NAME).toBe('thevic361');
    expect(api._constants.BRANCH).toBe('main');
    expect(api._constants.WEEKDAY_TARGET_MIN).toBe(4);
    expect(api._constants.WEEKDAY_TARGET_MAX).toBe(8);
    expect(api._constants.WEEKEND_TARGET_MIN).toBe(8);
    expect(api._constants.WEEKEND_TARGET_MAX).toBe(12);
    expect(api._constants.PREVIEW_STORAGE_PREFIX).toBe('vic361_preview_');
  });
});

describe('admin preview mode (PR #20)', () => {
  let api;
  beforeEach(() => {
    api = bootDom();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    window.sessionStorage.clear();
    delete window.__vic361Admin;
  });

  // Generate a large picks list — the kind that broke ?preview=<json> URLs.
  function manyEvents(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({
        date: '2026-04-' + String(20 + (i % 7)).padStart(2, '0'),
        name: 'Event number ' + i + ' with a moderately long name',
        time: '7 PM',
        venue: 'Venue ' + (i % 10) + ' with descriptive label',
        icons: ['music', 'food'],
        description: 'Lorem ipsum dolor sit amet, '.repeat(8) + ' #' + i
      });
    }
    return out;
  }

  it('writePreviewToStorage stores the payload under the short key prefix', () => {
    const payload = { last_updated: '2026-04-26T00:00:00Z', events: manyEvents(3) };
    const key = api.writePreviewToStorage(payload);
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
    const stored = window.sessionStorage.getItem('vic361_preview_' + key);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored).events.length).toBe(3);
  });

  it('buildPreviewSrc returns a SHORT URL even with 100+ events', () => {
    const payload = { last_updated: '2026-04-26T00:00:00Z', events: manyEvents(150) };
    const src = api.buildPreviewSrc(payload);
    // Old ?preview=<json-blob> approach produced URLs in the tens-of-thousands
    // of chars range. The new ?previewKey=<key> form must stay tiny.
    expect(src.startsWith('index.html?previewKey=')).toBe(true);
    expect(src.length).toBeLessThan(200);
  });

  it('buildPreviewSrc with empty picks is also short', () => {
    const src = api.buildPreviewSrc({ last_updated: 'x', events: [] });
    expect(src.startsWith('index.html?previewKey=')).toBe(true);
    expect(src.length).toBeLessThan(200);
  });
});
