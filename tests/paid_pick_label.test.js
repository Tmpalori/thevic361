// Paid placements are labeled: a paid pick (featured, not an editor's pick)
// ends its description with a small "#ad" on the site (server render and
// docs/app.js), on its event page, in "Coming up", in both parts of the
// newsletter and in llms.txt; an editor's pick looks as it did. And the
// Meta Pixel honors Global Privacy Control.

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

const AD = ' <span class="event-ad">#ad</span>';

describe('on the site', () => {
  it('server-rendered lists mark only paid picks, at the end of the description', () => {
    expect(isPaidPick(paid)).toBe(true);
    expect(isPaidPick(editors)).toBe(false);
    expect(isPaidPick(plain)).toBe(false);
    const p = renderEventItem(withPages([{ ...paid, description: 'Doors at 6.' }])[0]);
    expect(p).toContain(`<div class="event-desc">Doors at 6.${AD}</div>`);
    expect(p).toContain('<span class="badge badge--featured">Vic’s Pick</span> <span class="event-time">');
    // No description: the #ad still shows, on its own line.
    expect(renderEventItem(withPages([paid])[0])).toContain(`<div class="event-desc">${AD}</div>`);
    const e = renderEventItem(withPages([{ ...editors, description: 'Rides.' }])[0]);
    expect(e).toContain('<span class="badge badge--featured">Vic’s Pick</span>');
    expect(e).not.toContain('#ad');
    expect(renderEventItem(withPages([plain])[0])).not.toMatch(/badge--|#ad|event-desc/);
  });

  it('docs/app.js renders the same', () => {
    document.body.innerHTML = '<header id="site-header"></header><main><div id="events-container"></div><section id="sponsor-section"></section></main>';
    delete window.__vic361App;
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    window.fetch = () => new Promise(() => {});
    (0, eval)(APP_JS);
    const app = window.__vic361App;
    expect(app.renderEvent({ ...paid, description: 'Doors at 6.' })).toContain(`<div class="event-desc">Doors at 6.${AD}</div>`);
    expect(app.renderEvent(paid)).toContain(`<div class="event-desc">${AD}</div>`);
    expect(app.renderEvent(editors)).not.toContain('#ad');
    expect(app.renderEvent(editors)).toContain('badge--featured');
    expect(app.renderEvent(plain)).not.toContain('event-desc');
  });

  it('the event page, Coming up and llms.txt mark a paid pick #ad', () => {
    expect(pickBadges(paid)).not.toContain('#ad');
    const coming = renderComingUp(withPages([{ ...paid, date: '2026-10-20', big: true }, { ...editors, date: '2026-10-21', big: true }]), '2026-10-07');
    expect(coming.match(/event-ad/g)).toHaveLength(1);
    expect(coming).toContain(`Hall${AD}</span>`);
    const llms = renderLlmsTxt(withPages([{ ...paid, description: 'Doors at 6.' }, editors]), { siteUrl: SITE, now: new Date('2026-10-07T17:00:00Z') });
    expect(llms).toMatch(/Paid Show\]\([^)]+\) at Hall #ad/);
    expect(llms).toMatch(/Paid Show\]\([^)]+\) at Hall \(Vic's Pick\) - Doors at 6\. #ad/);
    expect(llms).toMatch(/Big Fair\]\([^)]+\) at Park \(editors' pick\)/);
    expect(llms).not.toMatch(/Big Fair[^\n]*#ad/);
  });

  it('uses the town’s pick name', () => {
    useTown(townConfig({}, { town: { id: 'bay', siteName: 'The Bay 979', siteNameHtml: 'The Bay <span>979</span>', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago', pickName: 'Bay’s Best' } }));
    const p = renderEventItem(withPages([paid])[0]);
    expect(p).toContain('Bay’s Best</span>');
    expect(p).toContain(AD);
  });
});

describe('in the newsletter', () => {
  it('the HTML row ends a paid pick’s description with #ad and keeps the editor’s pick as it was', () => {
    const p = eventRow({ ...paid, description: 'Doors at 6.', page: null }, SITE);
    expect(p).toContain('★ VIC’S PICK</span>');
    expect(p).toContain('Doors at 6. <span style="font-size:11px;">#ad</span></div>');
    expect(p).not.toContain('SPONSORED');
    expect(eventRow({ ...paid, page: null }, SITE)).toContain('<span style="font-size:11px;">#ad</span></div>');
    const e = eventRow({ ...editors, page: null }, SITE);
    expect(e).toContain('★ VIC’S PICK</span>');
    expect(e).not.toContain('#ad');
  });

  it('the plain-text part marks it too, and the pick name and share heading follow the town', () => {
    const now = new Date('2026-10-07T17:00:00Z');
    const issue = renderWeekly(withPages([paid, editors, plain]), { siteUrl: SITE, now, unsubscribeUrl: `${SITE}/unsubscribe`, address: 'PO Box 1', referral: { code: 'abc2345', count: 0 } });
    expect(issue.text).toMatch(/Paid Show @ Hall #ad/);
    expect(issue.text).not.toMatch(/Big Fair[^\n]*#ad/);
    expect(issue.text).not.toMatch(/sponsored/i);
    expect(issue.text).toContain('SHARE THE VIC 361');
    useTown(townConfig({}, { town: { id: 'bay', siteName: 'The Bay 979', siteNameHtml: 'The Bay <span>979</span>', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago', pickName: 'Bay’s Best' } }));
    const bay = renderWeekly(withPages([paid]), { siteUrl: 'https://www.thebay979.com', now, unsubscribeUrl: 'u', address: 'PO Box 1', referral: { code: 'abc2345', count: 0 } });
    expect(bay.html).toContain('★ BAY’S BEST</span>');
    expect(bay.html).not.toMatch(/VIC’S PICK|Vic 361/i);
    expect(bay.text).toContain('SHARE THE BAY 979');
    expect(bay.text).toContain('Paid Show @ Hall #ad');
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
