/* server/widget.js — "Upcoming at <venue>" widget venues embed on their sites.
 *
 * Venues paste an iframe plus one plain link. The iframe shows their next
 * events (from the published list) and every click lands on The Vic 361;
 * the plain link under it is a real backlink Google can follow (links
 * inside an iframe count for the iframe's site, not the venue's page).
 *
 *   GET /widget/:slug   the iframe page (framing allowed from anywhere)
 *   GET /for-venues     pick a venue, copy the code, see a live preview
 */

import { SITE_NAME, escHtml, localDateStr, formatDay, sortEvents, layout } from './seo.js';
import { venueFor } from './guides.js';

const MAX = 5;

export function venueUpcoming(venue, events, venues, today) {
  return sortEvents((events || []).filter(ev => ev.date >= today && venueFor(ev, venues) === venue)).slice(0, MAX);
}

export function embedCode(siteUrl, venue) {
  return `<iframe src="${siteUrl}/widget/${venue.slug}" title="Upcoming events at ${escHtml(venue.name)}" width="100%" height="420" style="border:0;max-width:480px;" loading="lazy"></iframe>
<p style="font-size:13px;max-width:480px;"><a href="${siteUrl}${venue.path}">More events at ${escHtml(venue.name)}</a> on <a href="${siteUrl}/">The Vic 361</a>, things to do in Victoria, TX</p>`;
}

export function renderWidget(venue, list, { siteUrl }) {
  const ref = `utm_source=widget&utm_medium=${encodeURIComponent(venue.slug)}`;
  const link = (path) => `${siteUrl}${path}${path.includes('?') ? '&' : '?'}${ref}`;
  const items = list.map(ev => `
    <li><a href="${escHtml(link(ev.page || '/'))}" target="_blank" rel="noopener">
      <span class="d">${escHtml(formatDay(ev.date, { weekday: 'short', month: 'short', day: 'numeric' }))}${ev.time ? ` · ${escHtml(ev.time)}` : ''}</span>
      <span class="n">${escHtml(ev.name)}</span></a></li>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Upcoming at ${escHtml(venue.name)} | ${SITE_NAME}</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:'Nunito','Helvetica Neue',Arial,sans-serif;color:#1F1A3D;background:transparent}
.w{background:#fff;border:3px solid #1F1A3D;border-radius:18px;box-shadow:5px 5px 0 #1F1A3D;overflow:hidden;margin:2px 7px 7px 2px}
.h{background:#FFC93C;border-bottom:3px solid #1F1A3D;padding:10px 14px;font-weight:900;font-size:17px}
ul{list-style:none;margin:0;padding:4px 10px}li a{display:block;padding:9px 4px;border-bottom:2px dashed #E8D9AE;color:inherit;text-decoration:none}
li:last-child a{border-bottom:0}li a:hover .n{text-decoration:underline}
.d{display:block;font-size:12px;font-weight:800;color:#4B3FD1}.n{font-weight:800;font-size:15px}
.e{padding:14px;font-size:14px}.f{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 14px;border-top:3px solid #1F1A3D;background:#2B2370;font-size:12px;font-weight:800}
.f a{color:#FFC93C;text-decoration:none}
</style></head><body><div class="w">
<div class="h">Upcoming at ${escHtml(venue.name)}</div>
${list.length ? `<ul>${items}</ul>` : `<div class="e">Nothing listed right now. <a href="${escHtml(link('/'))}" target="_blank" rel="noopener">See what's on in Victoria</a>.</div>`}
<div class="f"><a href="${escHtml(link(venue.path))}" target="_blank" rel="noopener">All events here →</a><a href="${escHtml(link('/'))}" target="_blank" rel="noopener">The Vic 361</a></div>
</div></body></html>`;
}

export function renderForVenues({ siteUrl, venues, venue }) {
  const opts = venues.slice().sort((a, b) => a.name.localeCompare(b.name))
    .map(v => `<option value="${escHtml(v.slug)}"${venue && v.slug === venue.slug ? ' selected' : ''}>${escHtml(v.name)}</option>`).join('');
  const body = `
    <h1 class="page-title">Show your events on your website</h1>
    <p class="page-lead">Free for every Victoria venue: a little box that lists your upcoming events from The Vic 361 and updates itself every week.</p>
    <form class="co-form" method="get" action="/for-venues">
      <div class="co-field"><label for="v">Your venue</label>
      <select id="v" name="venue" onchange="this.form.submit()"><option value="">Choose…</option>${opts}</select></div>
      <noscript><button class="btn btn--primary" type="submit">Get the code</button></noscript>
    </form>
    ${venue ? `
    <h2 class="section-heading">Your code</h2>
    <p>Paste this where you want the box to appear (Squarespace and Wix: add an "Embed" or "Code" block; WordPress: a "Custom HTML" block).</p>
    <textarea class="embed-code" readonly rows="6" onclick="this.select()">${escHtml(embedCode(siteUrl, venue))}</textarea>
    <p><button type="button" class="btn btn--outline" onclick="var t=document.querySelector('.embed-code');t.select();navigator.clipboard&&navigator.clipboard.writeText(t.value);this.textContent='Copied!'">Copy code</button></p>
    <h2 class="section-heading">Preview</h2>
    <iframe src="/widget/${escHtml(venue.slug)}" title="Preview" width="100%" height="420" style="border:0;max-width:480px;"></iframe>` : ''}
    <p class="page-cta">Not listed, or events missing? <a href="/submit">Submit an event</a> or <a href="/contact">send us a message</a>. Want your events pinned to the top? <a href="/advertise">Become a venue partner</a>.</p>`;
  return layout({
    siteUrl, path: '/for-venues', title: `Free events widget for Victoria venues | ${SITE_NAME}`,
    description: 'Free widget for Victoria, TX venues: show your upcoming events from The Vic 361 on your own website.', body
  });
}

export function registerWidget(app, { siteUrl, getPublicPayload, getVenues, nowFn, sendHtml }) {
  app.get('/widget/:slug', async (req, res, next) => {
    try {
      const venues = getVenues();
      const venue = venues.find(v => v.slug === req.params.slug);
      if (!venue) return res.status(404).type('text/plain').send('Unknown venue');
      const payload = await getPublicPayload();
      const list = venueUpcoming(venue, payload.events, venues, localDateStr(nowFn()));
      // Meant to be framed by venue websites.
      res.removeHeader('X-Frame-Options');
      res.set('Content-Security-Policy', "frame-ancestors *; object-src 'none'; base-uri 'self'");
      res.set('Cache-Control', 'public, max-age=600');
      res.type('html').send(renderWidget(venue, list, { siteUrl }));
    } catch (err) { next(err); }
  });

  app.get('/for-venues', (req, res) => {
    const venues = getVenues();
    const venue = venues.find(v => v.slug === req.query.venue) || null;
    sendHtml(res, renderForVenues({ siteUrl, venues, venue }));
  });
}
