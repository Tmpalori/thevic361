// @vitest-environment jsdom
//
// docs/track.js: ad visits and subscribe-link clicks. Its own file so each
// test file gets a fresh page (track.js adds document listeners once per
// load, and they'd pile up across tests in one file).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = readFileSync(path.join(__dirname, '..', 'docs', 'track.js'), 'utf8');
let sent;
const load = () => new Function(SRC)();  // eslint-disable-line no-new-func

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  vi.stubGlobal('fetch', (url, opts) => { sent.push(JSON.parse(opts.body)); return Promise.resolve({}); });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('ad visits and subscribe links', () => {
  it('any paid medium marks the visit as from an ad', () => {
    window.history.replaceState(null, '', '/?utm_source=fb&utm_medium=paid_social');
    sessionStorage.clear();
    load();  // the only load in this file
    expect(window.vic361Source('subscribe-page')).toBe('subscribe-page:ad');
    window.history.replaceState(null, '', '/');
  });

  it('only counts clicks on our own /subscribe page', async () => {
    window.dispatchEvent(new Event('scroll'));  // view first, so only clicks follow
    await vi.advanceTimersByTimeAsync(0);
    const click = async href => {
      const a = document.createElement('a');
      a.setAttribute('href', href);
      a.addEventListener('click', e => e.preventDefault());
      document.body.appendChild(a);
      a.click();
      a.remove();
      await vi.advanceTimersByTimeAsync(0);
    };
    const before = sent.filter(b => b.type === 'subscribe_click').length;
    await click('/subscribe');
    await click('https://someband.example/subscribe');
    await click('/subscribe/confirm?token=x');
    expect(sent.filter(b => b.type === 'subscribe_click').length - before).toBe(1);
  });
});

