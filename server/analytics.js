/* server/analytics.js — First-party visitor stats for the admin Traffic tab.
 *
 * No cookies and no third-party service. Two inputs:
 *   - People: docs/track.js sends a beacon to POST /api/track on each page
 *     view and on the clicks sponsors care about. Crawlers don't run JS, so
 *     these are humans; the beacon skips browsers signed into the admin.
 *   - Crawlers: a middleware notes HTML page hits from known search and AI
 *     bots (Googlebot, GPTBot, ClaudeBot, ...), so you can see whether the
 *     SEO work is being picked up.
 *
 * Visitors are counted with a hash of IP + user agent + day + a server
 * secret, so the same person is one visitor per day and nothing that
 * identifies them is stored. Multi-day totals sum daily visitors.
 */

import crypto from 'node:crypto';
import { localDateStr, addDays } from './seo.js';

// Known crawlers, checked in order. Anything else bot-like is "Other bot".
const BOTS = [
  ['Googlebot', /googlebot|google-inspectiontool|storebot-google/i],
  ['Bingbot', /bingbot|bingpreview/i],
  ['GPTBot (ChatGPT)', /gptbot|oai-searchbot|chatgpt-user/i],
  ['ClaudeBot', /claudebot|claude-searchbot|claude-user|anthropic-ai/i],
  ['PerplexityBot', /perplexitybot|perplexity-user/i],
  ['Applebot', /applebot/i],
  ['DuckDuckBot', /duckduckbot/i],
  ['Facebook preview', /facebookexternalhit|facebot|meta-externalagent/i],
  ['Other bot', /bot\b|bot\/|crawl|spider|slurp|preview|headless|lighthouse|python-requests|curl\/|wget|scrapy|httpclient|go-http/i]
];

export function botName(ua) {
  const s = String(ua || '');
  if (!s) return 'Other bot';
  for (const [name, re] of BOTS) if (re.test(s)) return name;
  return null;
}

// Group referrers into sources people recognize.
const SOURCES = [
  ['Google', /(^|\.)google\./],
  ['Bing', /(^|\.)bing\.com$/],
  ['ChatGPT', /(^|\.)(chatgpt\.com|openai\.com)$/],
  ['Perplexity', /(^|\.)perplexity\.ai$/],
  ['Claude', /(^|\.)claude\.ai$/],
  ['Copilot', /(^|\.)copilot\.microsoft\.com$/],
  ['DuckDuckGo', /(^|\.)duckduckgo\.com$/],
  ['Facebook', /(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/],
  ['Instagram', /(^|\.)instagram\.com$/],
  ['X / Twitter', /(^|\.)(t\.co|twitter\.com|x\.com)$/],
  ['Reddit', /(^|\.)reddit\.com$/],
  ['Nextdoor', /(^|\.)nextdoor\.com$/],
  ['Newsletter', /(^|\.)(beehiiv\.com|mail\.google\.com|outlook\.live\.com)$/]
];

export function referrerSource(ref, siteHost) {
  let host = '';
  try { host = new URL(ref).hostname.toLowerCase(); } catch { return { source: 'Direct', host: '' }; }
  const bare = host.replace(/^www\./, '');
  if (!host || (siteHost && bare === String(siteHost).replace(/^www\./, ''))) return { source: 'Direct', host: '' };
  for (const [name, re] of SOURCES) if (re.test(bare)) return { source: name, host: bare };
  return { source: 'Other sites', host: bare };
}

export function visitorHash(ip, ua, day, secret) {
  return crypto.createHash('sha256').update(`${secret}|${day}|${ip}|${ua}`).digest('hex').slice(0, 16);
}

export const CLICK_TYPES = new Set([
  'event_click', 'sponsor_click', 'subscribe_click', 'advertise_click',
  'add_to_calendar', 'share_native', 'share_facebook', 'share_x', 'share_text', 'filter'
]);

const CLICK_LABELS = {
  event_click: 'Event links', sponsor_click: 'Sponsor clicks', subscribe_click: 'Subscribe clicks',
  advertise_click: 'Advertise page clicks', add_to_calendar: 'Added to calendar',
  share_native: 'Shares (share sheet / copy)', share_facebook: 'Shares to Facebook',
  share_x: 'Shares to X', share_text: 'Shares by text', filter: 'Filter taps'
};

function cleanPath(p) {
  const s = String(p || '/').split('?')[0].split('#')[0].slice(0, 200);
  return s.startsWith('/') ? s : '/';
}

// Middleware: record HTML page hits from known crawlers (humans come in
// through the beacon). Runs after the response is sent; failures are logged
// and never affect the request.
export function crawlerMiddleware(store) {
  return (req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/admin')) return next();
    const bot = botName(req.get('user-agent'));
    if (!bot || bot === 'Other bot') return next();
    res.on('finish', () => {
      const type = String(res.get('content-type') || '');
      if (res.statusCode !== 200 || !type.includes('text/html')) return;
      store.recordTraffic({
        day: localDateStr(new Date()), kind: 'crawl', path: cleanPath(req.path), bot
      }).catch(err => console.warn('[traffic] crawl record failed:', err.message));
    });
    next();
  };
}

// Parse and validate a beacon body into a traffic row, or null to ignore.
export function beaconRow(body, { ip, ua, secret, siteHost, now }) {
  if (!body || typeof body !== 'object') return null;
  if (botName(ua)) return null; // headless browsers and scripts that run JS
  const day = localDateStr(now);
  const base = { day, path: cleanPath(body.path), visitor: visitorHash(ip, ua, day, secret) };
  if (body.kind === 'view') {
    const { source, host } = referrerSource(String(body.ref || '').slice(0, 500), siteHost);
    return { ...base, kind: 'view', ref_source: source, ref_host: host };
  }
  if (body.kind === 'click' && CLICK_TYPES.has(body.type)) {
    return { ...base, kind: 'click', click_type: body.type, click_url: String(body.url || '').slice(0, 300) };
  }
  return null;
}

function countBy(rows, keyFn, limit) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k) m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key, count]) => ({ key, count }));
}

function uniqueVisitors(rows) {
  // One visitor per (day, visitor hash); multi-day ranges sum daily uniques.
  return new Set(rows.map(r => `${r.day}|${r.visitor}`)).size;
}

// Build the admin Traffic payload from raw rows.
export function summarize(rows, { now, days = 30 }) {
  const today = localDateStr(now);
  const start = addDays(today, -(days - 1));
  const inRange = rows.filter(r => r.day >= start && r.day <= today);
  const views = inRange.filter(r => r.kind === 'view');
  const clicks = inRange.filter(r => r.kind === 'click');
  const crawls = inRange.filter(r => r.kind === 'crawl');

  const window = (n) => {
    const from = addDays(today, -(n - 1));
    const v = views.filter(r => r.day >= from);
    return { visitors: uniqueVisitors(v), views: v.length };
  };

  const daily = [];
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const v = views.filter(r => r.day === d);
    daily.push({ day: d, visitors: uniqueVisitors(v), views: v.length });
  }

  return {
    ok: true,
    generated_at: now.toISOString(),
    days,
    totals: { today: window(1), week: window(7), month: window(Math.min(30, days)) },
    daily,
    top_pages: countBy(views, r => r.path, 15),
    sources: countBy(views, r => r.ref_source || 'Direct', 12),
    referrer_sites: countBy(views.filter(r => r.ref_source === 'Other sites'), r => r.ref_host, 10),
    clicks: countBy(clicks, r => r.click_type, 20).map(c => ({ ...c, label: CLICK_LABELS[c.key] || c.key })),
    top_clicked: countBy(clicks.filter(r => r.click_type === 'event_click' || r.click_type === 'sponsor_click'),
      r => r.click_url, 10),
    crawlers: countBy(crawls, r => r.bot, 12),
    crawler_pages: countBy(crawls, r => r.path, 10)
  };
}
