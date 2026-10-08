// @vitest-environment jsdom
//
// docs/track.js: a share counts once it's sent (or copied), the shared link
// carries ?s=sh, and a visit from such a link is reported as one.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = readFileSync(path.join(__dirname, '..', 'docs', 'track.js'), 'utf8');
let sent;
// Once per file: each run adds its document listeners again.
let loaded = false;
// eslint-disable-next-line no-new-func
const load = () => { if (!loaded) { loaded = true; new Function(SRC)(); } };
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  sent = [];
  vi.stubGlobal('fetch', (url, opts) => { sent.push(JSON.parse(opts.body)); return Promise.resolve({}); });
  history.replaceState(null, '', '/');
  document.body.innerHTML = '';
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('share tracking', () => {
  it('a visit from a shared link is reported as one, and the tag comes off the address bar', async () => {
    history.replaceState(null, '', '/events/2026-10-10-farmers-market?s=sh&utm_source=x#top');
    load();
    window.dispatchEvent(new Event('scroll'));
    await flush();
    const view = sent.find(b => b.kind === 'view');
    expect(view.via).toBe('share');
    expect(location.pathname + location.search + location.hash).toBe('/events/2026-10-10-farmers-market?utm_source=x#top');
  });

  it('the share sheet gets the tagged link; the share counts only once it was sent', async () => {
    load();
    document.body.innerHTML = '<button class="event-share" data-share-url="/events/2026-10-10-farmers-market" data-share-text="Farmers Market">s</button>';
    let finish;
    const share = vi.fn(() => new Promise((resolve, reject) => { finish = { resolve, reject }; }));
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    const btn = document.querySelector('button');

    btn.click();
    expect(share.mock.calls[0][0].url).toBe(`${location.origin}/events/2026-10-10-farmers-market?s=sh`);
    finish.reject(new Error('AbortError')); // closed the sheet
    await flush();
    expect(sent.filter(b => b.kind === 'click')).toEqual([]);

    btn.click();
    finish.resolve();
    await flush();
    const clicks = sent.filter(b => b.kind === 'click');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ type: 'share_from_list', url: `${location.origin}/events/2026-10-10-farmers-market` });
    delete navigator.share;
  });

  it('without a share sheet, the tagged link is copied and the copy counts', async () => {
    load();
    document.body.innerHTML = '<button class="share-btn" data-share-url="https://www.thevic361.com/this-weekend" data-share-text="This weekend">Share</button>';
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    document.querySelector('button').click();
    await flush();
    expect(writeText).toHaveBeenCalledWith('https://www.thevic361.com/this-weekend?s=sh');
    expect(sent.filter(b => b.kind === 'click')).toMatchObject([{ type: 'share_native', url: 'https://www.thevic361.com/this-weekend' }]);
    expect(document.querySelector('button').textContent).toBe('Link copied');
  });
});
