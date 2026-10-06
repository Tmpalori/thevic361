// docs/app.js re-renders the homepage in the browser; these check it stays
// in step with server/seo.js (times, folded past days, sponsor link) and
// that filter messages fit the day they're on.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { formatTime as serverFormatTime, renderDays, withPages } from '../server/seo.js';

const APP_JS = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'app.js'), 'utf8');

function boot(containerHtml, fetchImpl = () => new Promise(() => {})) {
  document.body.innerHTML = '<header id="site-header"></header><main><span id="skip-today-bar" hidden></span>' +
    `<div id="events-container">${containerHtml}</div><section id="sponsor-section"></section></main>`;
  delete window.__vic361App;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  window.fetch = fetchImpl;
  (0, eval)(APP_JS);
  return window.__vic361App;
}

afterEach(() => { vi.useRealTimers(); });

describe('docs/app.js matches the server renderer', () => {
  it('formats times the same way', () => {
    const app = boot('');
    for (const t of ['04:00 PM', '5:30PM – 7:00PM', '4:00 PM - 6:00 PM', '10am - 3pm', '7:00 p.m.', '10:05 AM', 'All day']) {
      expect(app.formatTime(t), t).toBe(serverFormatTime(t));
    }
    expect(app.renderEvent({ name: 'X', date: '2026-10-07', time: '06:00PM' })).toContain('<span class="event-time">6:00 PM</span>');
  });

  it('folds past days exactly like the server', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 7, 12)); // Wednesday, local time
    const events = withPages([
      { date: '2026-10-05', name: 'Monday Market', time: '9 AM', icons: ['food'] },
      { date: '2026-10-07', name: 'Trivia', time: '7 PM', icons: ['drinks'] }
    ]).map(({ page, ...ev }) => ev); // the client render without event pages
    let done;
    const ready = new Promise(r => { done = r; });
    boot('', () => Promise.resolve({ ok: true, json: () => { setTimeout(done, 0); return Promise.resolve({ events }); } }));
    await ready;
    await new Promise(r => setTimeout(r, 0));
    const html = document.getElementById('events-container').innerHTML;
    const server = renderDays(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'],
      events, '2026-10-07');
    const pastIds = h => [...h.matchAll(/day-section--past" id="(day-\d)"/g)].map(m => m[1]);
    expect(pastIds(html)).toEqual(['day-0', 'day-1']);
    expect(pastIds(server)).toEqual(['day-0', 'day-1']);
    const summary = h => h.match(/<summary class="day-header">[\s\S]*?<\/summary>/)[0];
    expect(summary(html)).toBe(summary(server));
  });

  it('marks the sponsor link as paid and tags it for the sponsor', () => {
    const app = boot('');
    const html = app.renderSponsor({ name: 'Acme', text: 'Hi', cta: 'Visit', url: 'https://acme.example/' });
    expect(html).toContain('rel="sponsored noopener"');
    expect(html).toContain('utm_source=thevic361&amp;utm_medium=sponsor&amp;utm_campaign=weekly-sponsor');
    expect(app.sponsorLink('https://acme.example/?utm_source=x')).toBe('https://acme.example/?utm_source=x');
  });
});

describe('theme toggle (inline head script on every page)', () => {
  it('flips the theme from any page and labels the button', async () => {
    const { THEME_SCRIPT } = await import('../server/seo.js');
    document.documentElement.removeAttribute('data-theme');
    window.matchMedia = () => ({ matches: false });
    document.body.innerHTML = '<button type="button" data-theme-toggle><svg><path></path></svg></button>';
    (0, eval)(THEME_SCRIPT.replace(/^<script>|<\/script>$/g, ''));
    document.dispatchEvent(new Event('DOMContentLoaded'));
    const btn = document.querySelector('[data-theme-toggle]');
    expect(btn.getAttribute('aria-label')).toBe('Switch to dark mode');
    btn.querySelector('path').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(btn.getAttribute('aria-label')).toBe('Switch to light mode');
    document.documentElement.removeAttribute('data-theme');
  });
});

describe('filter messages', () => {
  it('say "today" only on today', () => {
    const sec = (i, today) => `<section class="day-section" id="day-${i}"><div class="day-header"><h2 class="day-name">D${today ? ' <span class="today-badge">Today</span>' : ''}</h2></div>` +
      '<ul class="event-list"><li class="event-entry" data-icons="food">Lunch</li></ul></section>';
    const app = boot(sec(0, false) + sec(1, true));
    app.applyFilter('music');
    const msgs = [...document.querySelectorAll('.filter-empty')].map(e => e.textContent);
    expect(msgs).toEqual(['Nothing in this category on this day.', 'Nothing in this category today.']);
  });
});
