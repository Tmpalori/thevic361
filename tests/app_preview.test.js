// Smoke test for the public site preview-mode reader (docs/app.js).
//
// Verifies that ?previewKey=<key> loads payload from sessionStorage and that
// the removed legacy ?preview=<json> form is ignored. We don't boot the full
// loadAndRender pipeline (it depends on the full index.html DOM and
// document.fetch); instead we evaluate app.js, which exposes a small
// __vic361App surface for tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(__dirname, '..', 'docs');
const APP_JS = readFileSync(resolve(DOCS, 'app.js'), 'utf8');

function bootApp(search) {
  // Reset DOM and globals between tests.
  document.body.innerHTML = '<div id="events-container"></div>';
  delete window.__vic361App;

  // Override window.location.search by replacing the document URL via History.
  // jsdom supports history.replaceState for this.
  window.history.replaceState({}, '', '/' + (search || ''));

  // Stub APIs that app.js touches at module-eval time but jsdom doesn't ship.
  if (!window.matchMedia) {
    window.matchMedia = () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {}
    });
  }
  // Stub fetch — loadAndRender will call it when no preview is set, but we
  // just need the IIFE to expose __vic361App without crashing.
  window.fetch = () => Promise.resolve({ json: () => Promise.resolve({ events: [] }) });

  // eslint-disable-next-line no-eval
  (0, eval)(APP_JS);
  return window.__vic361App;
}

describe('public site preview mode (PR #20)', () => {
  afterEach(() => {
    try { window.sessionStorage.clear(); } catch (e) {}
    try { window.localStorage.clear(); } catch (e) {}
    delete window.__vic361App;
  });

  it('readPreviewData returns null when no preview params are present', () => {
    const app = bootApp('');
    expect(app.readPreviewData()).toBeNull();
  });

  it('readPreviewData reads sessionStorage when ?previewKey is set', () => {
    const payload = { last_updated: '2026-04-26T00:00:00Z', events: [{ name: 'X' }] };
    window.sessionStorage.setItem('vic361_preview_abc123', JSON.stringify(payload));
    const app = bootApp('?previewKey=abc123');
    const data = app.readPreviewData();
    expect(data).not.toBeNull();
    expect(data.events[0].name).toBe('X');
  });

  it('readPreviewData falls back to localStorage when sessionStorage is empty', () => {
    const payload = { last_updated: 'x', events: [{ name: 'Y' }] };
    window.localStorage.setItem('vic361_preview_def456', JSON.stringify(payload));
    const app = bootApp('?previewKey=def456');
    const data = app.readPreviewData();
    expect(data && data.events[0].name).toBe('Y');
  });

  it('readPreviewData ignores the removed inline ?preview=<json> form', () => {
    // A crafted ?preview= link could inject markup on the public site.
    const payload = { last_updated: 'x', events: [{ name: 'Z' }] };
    const blob = encodeURIComponent(JSON.stringify(payload));
    const app = bootApp('?preview=' + blob);
    expect(app.readPreviewData()).toBeNull();
  });

  it('showPreviewIndicator renders a single fixed banner', () => {
    const app = bootApp('');
    app.showPreviewIndicator();
    app.showPreviewIndicator(); // Idempotent.
    const banners = document.querySelectorAll('#vic361-preview-banner');
    expect(banners.length).toBe(1);
    expect(banners[0].textContent.toLowerCase()).toContain('preview');
  });
});

describe('escaping on the public homepage', () => {
  it('escapes quotes so a URL or name cannot break out of an attribute', () => {
    bootApp('');
    const app = window.__vic361App;
    expect(app.escHtml('a"b\'c<d>&')).toBe('a&quot;b&#39;c&lt;d&gt;&amp;');
    expect(app.safeHref('https://a.com/"onmouseover="alert(1)')).toBe('');
    expect(app.safeHref('javascript:alert(1)')).toBe('');
    expect(app.safeHref('https://a.com/x?y=1&z=2')).toBe('https://a.com/x?y=1&amp;z=2');
    const html = app.renderEvent({ date: '2099-01-01', name: 'Ladies" onclick="x', url: 'https://a.com/"x', icons: ['music'] });
    const div = document.createElement('div');
    div.innerHTML = html;
    expect(div.querySelector('[onclick]')).toBeNull();
    expect(div.querySelector('[onmouseover]')).toBeNull();
  });
});
