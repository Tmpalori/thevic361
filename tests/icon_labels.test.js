// @vitest-environment jsdom
//
// Event category icons (Free, Kids & Family, Music...) were aria-hidden, so
// screen-reader users got nothing for what sighted users see on every
// listing. The icon column is now one labelled image; the pictures and the
// layout are unchanged. Server (server/seo.js) and docs/app.js match.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderEventItem, iconsHtml, ICON_LABELS } from '../server/seo.js';

const APP = readFileSync(path.join(__dirname, '..', 'docs', 'app.js'), 'utf8');

function app() {
  document.body.innerHTML = '<header id="site-header"></header><main><div id="events-container"></div><section id="sponsor-section"></section></main>';
  delete window.__vic361App;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  window.fetch = () => new Promise(() => {});
  (0, eval)(APP);
  return window.__vic361App;
}

const iconSpan = html => {
  const div = document.createElement('div');
  div.innerHTML = `<ul>${html}</ul>`;
  return div.querySelector('.event-icons');
};

describe('event icons have a text alternative', () => {
  const ev = { date: '2026-10-10', name: 'Fall Fest', venue: 'De Leon Plaza', page: '/events/x', icons: ['music', 'family'], free: true };

  it('server: one labelled image naming each icon, pictures unchanged', () => {
    const span = iconSpan(renderEventItem(ev));
    expect(span.getAttribute('role')).toBe('img');
    expect(span.getAttribute('aria-label')).toBe('Music, Kids & Family, Free');
    expect(span.hasAttribute('aria-hidden')).toBe(false);
    expect([...span.querySelectorAll('svg.ico')].map(s => s.getAttribute('aria-hidden'))).toEqual(['true', 'true', 'true']);
    expect(span.querySelectorAll('use').length).toBe(3);
    expect(renderEventItem(ev)).toContain('aria-label="Music, Kids &amp; Family, Free"');
  });

  it('server: an event with no icons keeps an empty hidden column', () => {
    expect(iconsHtml({ icons: [] })).toBe('<span class="event-icons" aria-hidden="true"></span>');
    expect(iconsHtml({ icons: ['bogus'] })).toBe('<span class="event-icons" aria-hidden="true"></span>');
  });

  it('every icon key has a label', () => {
    for (const k of ['food', 'music', 'family', 'drinks', 'arts', 'shopping', 'outdoors', 'community', 'free']) {
      expect(ICON_LABELS[k], k).toBeTruthy();
    }
  });

  it('docs/app.js renders the same labels', () => {
    const a = app();
    for (const e of [ev, { ...ev, icons: [], free: false }, { ...ev, icons: ['food', 'drinks'], free: false }]) {
      const mine = iconSpan(a.renderEvent(e));
      const theirs = iconSpan(renderEventItem(e));
      expect(mine.getAttribute('role')).toBe(theirs.getAttribute('role'));
      expect(mine.getAttribute('aria-label')).toBe(theirs.getAttribute('aria-label'));
      expect(mine.getAttribute('aria-hidden')).toBe(theirs.getAttribute('aria-hidden'));
    }
  });
});
