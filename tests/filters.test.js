// Homepage filter chips (docs/app.js). They filter the events already in
// the page, which the server renders with data-icons on every entry.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const APP_JS = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'app.js'), 'utf8');

function day(idx, entries) {
  return `<section class="day-section" id="day-${idx}"><ul class="event-list">` +
    entries.map(([name, icons]) => `<li class="event-entry" data-icons="${icons}">${name}</li>`).join('') +
    '</ul></section>';
}

function boot() {
  document.body.innerHTML = '<main><div id="events-container">' +
    day(0, [['Mon Trivia', 'drinks community'], ['Story Time', 'family free']]) +
    day(1, []) + day(2, []) + day(3, []) +
    day(4, [['Fri Concert', 'music']]) + day(5, [['Sat Market', 'food shopping free']]) + day(6, []) +
    '</div></main>';
  delete window.__vic361App;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  // Never resolves, so loadAndRender doesn't replace our fixture DOM.
  window.fetch = () => new Promise(() => {});
  (0, eval)(APP_JS);
  return window.__vic361App;
}

const visible = () => [...document.querySelectorAll('.event-entry')].filter(li => !li.hidden && !li.closest('.day-section').hidden).map(li => li.textContent);

describe('homepage filters', () => {
  it('renders the chip bar above the list', () => {
    boot();
    const chips = [...document.querySelectorAll('#event-filters .filter-chip')].map(b => b.textContent);
    expect(chips).toEqual(['All', 'This weekend', 'Free', 'Kids & Family', 'Music', 'Food & Drink', 'Arts', 'Outdoors']);
  });

  it('filters by category, free, and weekend', () => {
    const app = boot();
    app.applyFilter('free');
    expect(visible()).toEqual(['Story Time', 'Sat Market']);
    app.applyFilter('food drinks');
    expect(visible()).toEqual(['Mon Trivia', 'Sat Market']);
    app.applyFilter('weekend');
    expect(visible()).toEqual(['Fri Concert', 'Sat Market']);
    app.applyFilter('all');
    expect(visible().length).toBe(4);
  });

  it('chip clicks update aria-pressed', () => {
    boot();
    document.querySelector('[data-filter="music"]').click();
    expect(document.querySelector('[data-filter="music"]').getAttribute('aria-pressed')).toBe('true');
    expect(visible()).toEqual(['Fri Concert']);
  });
});
