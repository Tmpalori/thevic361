// Paid placements are labeled (FTC): a paid pick (featured, not an editor's
// pick) carries "Sponsored" next to the pick badge on the site (server
// render and docs/app.js), on its event page, in "Coming up", in both parts
// of the newsletter and in llms.txt; an editor's pick looks as it did. And
// the Meta Pixel honors Global Privacy Control.

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import { renderEventItem, renderComingUp, renderLlmsTxt, withPages, pickBadges, isPaidPick } from '../server/seo.js';
import { eventRow, renderWeekly } from '../server/newsletter.js';
import { metaPixelJs } from '../server/metaPixel.js';
import { townConfig, useTown, VICTORIA } from '../server/town.js';

const APP_JS = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'app.js'), 'utf8');
const SITE = 'https://www.thevic361.com';
const paid = { name: 'Paid Show', date: '2026-10-09', time: '7:00 PM', venue: 'Hall', featured: true, sponsor_order: 'order-123456' };
const editors = { name: 'Big Fair', date: '2026-10-09', time: '9:00 AM', venue: 'Park', featured: true, editor_pick: true };
const plain = { name: 'Trivia', date: '2026-10-09', time: '8:00 PM', venue: 'Bar' };

afterEach(() => useTown(VICTORIA));

describe('on the site', () => {
  it('server-rendered lists label only paid picks', () => {
    expect(isPaidPick(paid)).toBe(true);
    expect(isPaidPick(editors)).toBe(false);
    expect(isPaidPick(plain)).toBe(false);
    const p = renderEventItem(withPages([paid])[0]);
    expect(p).toContain('<span class="badge badge--featured">Vic’s Pick</span> <span class="badge badge--sponsored">Sponsored</span>');
    const e = renderEventItem(withPages([editors])[0]);
    expect(e).toContain('<span class="badge badge--featured">Vic’s Pick</span>');
    expect(e).not.toContain('Sponsored');
    expect(renderEventItem(withPages([plain])[0])).not.toContain('badge--');
  });

  it('docs/app.js renders the same badges', () => {
    document.body.innerHTML = '<header id="site-header"></header><main><div id="events-container"></div><section id="sponsor-section"></section></main>';
    delete window.__vic361App;
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    window.fetch = () => new Promise(() => {});
    (0, eval)(APP_JS);
    const app = window.__vic361App;
    expect(app.renderEvent(paid)).toContain('<span class="badge badge--featured">Vic’s Pick</span> <span class="badge badge--sponsored">Sponsored</span>');
    expect(app.renderEvent(editors)).not.toContain('Sponsored');
    expect(app.renderEvent(editors)).toContain('badge--featured');
  });

  it('the event page, Coming up and llms.txt say a paid pick is sponsored', () => {
    expect(pickBadges(paid)).toContain('Sponsored');
    const coming = renderComingUp(withPages([{ ...paid, date: '2026-10-20', big: true }, { ...editors, date: '2026-10-21', big: true }]), '2026-10-07');
    expect(coming.match(/badge--sponsored/g)).toHaveLength(1);
    const llms = renderLlmsTxt(withPages([paid, editors]), { siteUrl: SITE, now: new Date('2026-10-07T17:00:00Z') });
    expect(llms).toMatch(/Paid Show\]\([^)]+\) at Hall \(sponsored\)/);
    expect(llms).toMatch(/Big Fair\]\([^)]+\) at Park \(editors' pick\)/);
  });

  it('uses the town’s pick name', () => {
    useTown(townConfig({}, { town: { id: 'bay', siteName: 'The Bay 979', siteNameHtml: 'The Bay <span>979</span>', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago', pickName: 'Bay’s Best' } }));
    expect(renderEventItem(withPages([paid])[0])).toContain('Bay’s Best</span> <span class="badge badge--sponsored">Sponsored</span>');
  });
});

describe('in the newsletter', () => {
  it('the HTML row labels a paid pick SPONSORED and keeps the editor’s pick as it was', () => {
    const p = eventRow({ ...paid, page: null }, SITE);
    expect(p).toContain('★ VIC’S PICK</span>');
    expect(p).toContain('>SPONSORED</span>');
    const e = eventRow({ ...editors, page: null }, SITE);
    expect(e).toContain('★ VIC’S PICK</span>');
    expect(e).not.toContain('SPONSORED');
  });

  it('the plain-text part labels it too, and the pick name and share heading follow the town', () => {
    const now = new Date('2026-10-07T17:00:00Z');
    const issue = renderWeekly(withPages([paid, editors, plain]), { siteUrl: SITE, now, unsubscribeUrl: `${SITE}/unsubscribe`, address: 'PO Box 1', referral: { code: 'abc2345', count: 0 } });
    expect(issue.text).toMatch(/Paid Show @ Hall \(Vic's Pick, sponsored\)/);
    expect(issue.text).not.toMatch(/Big Fair[^\n]*sponsored/);
    expect(issue.text).toContain('SHARE THE VIC 361');
    useTown(townConfig({}, { town: { id: 'bay', siteName: 'The Bay 979', siteNameHtml: 'The Bay <span>979</span>', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago', pickName: 'Bay’s Best' } }));
    const bay = renderWeekly(withPages([paid]), { siteUrl: 'https://www.thebay979.com', now, unsubscribeUrl: 'u', address: 'PO Box 1', referral: { code: 'abc2345', count: 0 } });
    expect(bay.html).toContain('★ BAY’S BEST</span>');
    expect(bay.html).not.toMatch(/VIC’S PICK|Vic 361/i);
    expect(bay.text).toContain('SHARE THE BAY 979');
    expect(bay.text).toContain("(Bay's Best, sponsored)");
  });
});

describe('Meta Pixel and Global Privacy Control', () => {
  function run(gpc) {
    const loaded = [];
    const ctx = {
      location: { search: '', pathname: '/' },
      localStorage: { getItem: () => null },
      navigator: gpc === undefined ? {} : { globalPrivacyControl: gpc },
      document: {
        createElement: () => ({}),
        getElementsByTagName: () => [{ parentNode: { insertBefore: (el) => loaded.push(el) } }]
      }
    };
    ctx.window = ctx;
    vm.runInNewContext(metaPixelJs('1234567890'), ctx);
    return { loaded, fbq: ctx.fbq };
  }

  it('doesn’t load when the browser sends GPC', () => {
    const off = run(true);
    expect(off.fbq).toBeUndefined();
    expect(off.loaded).toHaveLength(0);
  });

  it('loads as before without it', () => {
    for (const gpc of [undefined, false]) {
      const on = run(gpc);
      expect(typeof on.fbq).toBe('function');
      expect(on.loaded).toHaveLength(1);
    }
  });
});
