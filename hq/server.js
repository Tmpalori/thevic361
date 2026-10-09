/* hq/server.js — every town on one screen (MULTI_CITY_PLAN.md 4.2).
 *
 * A separate Railway service from the towns (start command: node
 * hq/server.js). It has its own login and holds no town data: on each page
 * load it asks every town's GET /api/hq/summary (server/hq.js) with that
 * town's HQ_API_KEY and shows totals plus one row per town, each linking to
 * the town's own admin (which still asks for its own login).
 *
 * Env:
 *   HQ_TOWNS            JSON list: [{"slug":"victoria","site_url":"https://www.thevic361.com","key":"…"}]
 *   HQ_USERNAME         login
 *   HQ_PASSWORD         login (12+ characters)
 *   HQ_SESSION_SECRET   signs the login cookie (32+ characters)
 *   PORT                (Railway sets it)
 *
 * Keys never reach the browser. A town that's down or refuses the key shows
 * as a red row; the rest still load.
 */

import crypto from 'node:crypto';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { createRateLimiter } from '../server/rateLimit.js';

const SESSION_HOURS = 12;
const FETCH_TIMEOUT_MS = 8000;
const COOKIE = 'hq_session';

// The HQ settings from env, or an error naming what's wrong.
export function hqConfig(env = process.env) {
  let towns;
  try { towns = JSON.parse(env.HQ_TOWNS || '[]'); } catch (_) { throw new Error('HQ_TOWNS must be JSON: [{"slug","site_url","key"}, …]'); }
  if (!Array.isArray(towns) || !towns.length) throw new Error('HQ_TOWNS lists no towns');
  const seen = new Set();
  towns = towns.map((t, i) => {
    const slug = String((t && t.slug) || '').trim();
    const siteUrl = String((t && t.site_url) || '').trim().replace(/\/+$/, '');
    const key = String((t && t.key) || '').trim();
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`HQ_TOWNS[${i}]: slug must be lowercase letters, digits or -`);
    if (seen.has(slug)) throw new Error(`HQ_TOWNS: ${slug} is listed twice`);
    seen.add(slug);
    if (!/^https:\/\/[a-z0-9.-]+$/.test(siteUrl)) throw new Error(`HQ_TOWNS ${slug}: site_url must be https://host`);
    if (key.length < 16) throw new Error(`HQ_TOWNS ${slug}: key must be the town's HQ_API_KEY (16+ characters)`);
    return { slug, siteUrl, key };
  });
  const username = String(env.HQ_USERNAME || '').trim();
  const password = String(env.HQ_PASSWORD || '');
  const secret = String(env.HQ_SESSION_SECRET || '');
  if (!username || password.length < 12) throw new Error('Set HQ_USERNAME and HQ_PASSWORD (12+ characters)');
  if (secret.length < 32) throw new Error('Set HQ_SESSION_SECRET (32+ characters)');
  return { towns, username, password, secret };
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const same = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

function sign(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
}
function verify(secret, token, now) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p && p.exp > now ? p : null;
  } catch (_) { return null; }
}
const cookieOf = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
};

// One town's summary, or { error } when it's down, slow or refuses the key.
export async function fetchTown(town, fetchImpl = globalThis.fetch) {
  try {
    const r = await fetchImpl(`${town.siteUrl}/api/hq/summary`, {
      headers: { Authorization: `Bearer ${town.key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!r.ok) return { slug: town.slug, siteUrl: town.siteUrl, error: r.status === 404 ? 'HQ_API_KEY not set on the town' : r.status === 401 ? 'key refused' : `HTTP ${r.status}` };
    const body = await r.json();
    if (!body || body.ok !== true) return { slug: town.slug, siteUrl: town.siteUrl, error: 'bad answer' };
    return { slug: town.slug, siteUrl: town.siteUrl, summary: body };
  } catch (err) {
    return { slug: town.slug, siteUrl: town.siteUrl, error: err && err.name === 'TimeoutError' ? 'timed out' : 'unreachable' };
  }
}

// The numbers each row and the totals show.
export function rowOf(t) {
  const s = t.summary;
  if (!s) return { slug: t.slug, siteUrl: t.siteUrl, error: t.error };
  const issue = (s.issues || [])[0] || null;
  const health = s.health || {};
  const problems = [
    health.database === false && 'database',
    health.scheduler_blocked && 'scheduler',
    health.slack_refused && 'Slack',
    ...((s.setup && s.setup.required_missing) || []).map(k => `setup: ${k}`)
  ].filter(Boolean);
  return {
    slug: t.slug, siteUrl: t.siteUrl, name: s.town && s.town.name, adminUrl: (s.town && s.town.admin_url) || `${t.siteUrl}/admin.html`,
    subscribers: s.subscribers ? s.subscribers.active : null,
    net7: s.subscribers ? s.subscribers.net_7_days : null,
    openRate: issue ? issue.open_rate : null,
    revenueCents: s.revenue && s.revenue.month_to_date ? s.revenue.month_to_date.cents : null,
    openWeeks: s.sponsors ? s.sponsors.weeks_open_next_4 : null,
    picks: s.sponsors ? s.sponsors.picks_sold_this_month : null,
    waiting: s.submissions_waiting,
    upcoming: s.events ? s.events.upcoming : null,
    problems
  };
}

export function totalsOf(rows) {
  const sum = k => rows.reduce((a, r) => a + (Number.isFinite(r[k]) ? r[k] : 0), 0);
  const rates = rows.filter(r => Number.isFinite(r.openRate) && Number.isFinite(r.subscribers) && r.subscribers > 0);
  const weight = rates.reduce((a, r) => a + r.subscribers, 0);
  return {
    towns: rows.length, down: rows.filter(r => r.error).length,
    subscribers: sum('subscribers'), net7: sum('net7'), revenueCents: sum('revenueCents'),
    openWeeks: sum('openWeeks'), picks: sum('picks'), waiting: sum('waiting'),
    openRate: weight ? Math.round(rates.reduce((a, r) => a + r.openRate * r.subscribers, 0) / weight * 10) / 10 : null
  };
}

const money = c => (Number.isFinite(c) ? `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—');
const num = n => (Number.isFinite(n) ? n.toLocaleString('en-US') : '—');
const pct = n => (Number.isFinite(n) ? `${n}%` : '—');
const signed = n => (Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n}` : '—');

const STYLE = `:root{--bg:#f7f6fb;--card:#fff;--ink:#1f1a3d;--muted:#5b5675;--line:#e4e1ef;--bad:#b42318;--good:#1a7f37;--accent:#4b3fd1}
@media (prefers-color-scheme:dark){:root{--bg:#14121f;--card:#1e1b2e;--ink:#eceaf6;--muted:#a9a4c2;--line:#2e2a45;--bad:#ff7b72;--good:#56d364;--accent:#a49bff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.card b{display:block;font-size:22px}.card span{color:var(--muted);font-size:13px}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;width:100%;min-width:760px}
th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}
th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}tr:last-child td{border-bottom:0}
a{color:var(--accent)}.bad{color:var(--bad)}.good{color:var(--good)}form{display:grid;gap:10px;max-width:320px}
input{font:inherit;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
button{font:inherit;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function renderLogin(error = '') {
  return page('HQ login', `<h1>HQ</h1><p class="sub">Every town on one screen.</p>` +
    (error ? `<p class="bad">${esc(error)}</p>` : '') +
    `<form method="post" action="/login"><input name="username" autocomplete="username" placeholder="Username" required>` +
    `<input name="password" type="password" autocomplete="current-password" placeholder="Password" required><button>Log in</button></form>`);
}

export function renderDashboard(rows, now) {
  const t = totalsOf(rows);
  const cards = [
    [num(t.subscribers), 'subscribers'], [signed(t.net7), 'net, last 7 days'], [pct(t.openRate), 'latest open rate'],
    [money(t.revenueCents), 'revenue this month'], [num(t.openWeeks), 'open sponsor weeks (next 4)'],
    [num(t.picks), 'picks sold this month'], [num(t.waiting), 'submissions waiting']
  ].map(([v, l]) => `<div class="card"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
  const body = rows.map(r => r.error
    ? `<tr><td><a href="${esc(r.siteUrl)}/admin.html">${esc(r.slug)}</a></td><td colspan="9" class="bad">${esc(r.error)}</td></tr>`
    : `<tr><td><a href="${esc(r.adminUrl)}">${esc(r.name || r.slug)}</a></td><td>${num(r.subscribers)}</td><td>${signed(r.net7)}</td>` +
      `<td>${pct(r.openRate)}</td><td>${money(r.revenueCents)}</td><td>${num(r.openWeeks)}</td><td>${num(r.picks)}</td>` +
      `<td>${num(r.waiting)}</td><td>${num(r.upcoming)}</td>` +
      `<td class="${r.problems.length ? 'bad' : 'good'}">${r.problems.length ? esc(r.problems.join(', ')) : 'OK'}</td></tr>`).join('');
  return page('HQ', `<h1>HQ</h1><p class="sub">${t.towns} town${t.towns === 1 ? '' : 's'}` +
    `${t.down ? `, <span class="bad">${t.down} not answering</span>` : ''} · ${esc(now.toISOString().slice(0, 16).replace('T', ' '))} UTC · ` +
    `<a href="/">Refresh</a> · <a href="/logout">Log out</a></p><div class="cards">${cards}</div>` +
    `<div class="wrap"><table><thead><tr><th>Town</th><th>Subscribers</th><th>7-day net</th><th>Open rate</th><th>Revenue (month)</th>` +
    `<th>Open weeks</th><th>Picks</th><th>Waiting</th><th>Upcoming events</th><th>Health</th></tr></thead><tbody>${body}</tbody></table></div>`);
}

export function createHqApp(config, { fetchImpl = globalThis.fetch, nowFn = () => new Date(), loginLimiter } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const limiter = loginLimiter || createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    });
    next();
  });
  const signedIn = req => Boolean(verify(config.secret, cookieOf(req, COOKIE), nowFn().getTime()));
  const secure = req => req.secure || req.get('x-forwarded-proto') === 'https';

  app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    if (!limiter.check(req.ip).ok) return res.status(429).type('html').send(renderLogin('Too many tries. Wait a few minutes.'));
    const b = req.body || {};
    // `|`, not `||`: both compare every time, so timing says nothing about which was wrong.
    if (!same(b.username || '', config.username) | !same(b.password || '', config.password)) {
      return res.status(401).type('html').send(renderLogin('Wrong username or password.'));
    }
    const token = sign(config.secret, { u: config.username, exp: nowFn().getTime() + SESSION_HOURS * 3600 * 1000 });
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: secure(req), maxAge: SESSION_HOURS * 3600 * 1000, path: '/' });
    res.redirect(303, '/');
  });

  app.get('/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect(303, '/');
  });

  app.get('/', async (req, res) => {
    if (!signedIn(req)) return res.type('html').send(renderLogin());
    const rows = (await Promise.all(config.towns.map(t => fetchTown(t, fetchImpl)))).map(rowOf);
    res.type('html').send(renderDashboard(rows, nowFn()));
  });

  // The same rows as JSON, for scripts (logged in only).
  app.get('/api/towns', async (req, res) => {
    if (!signedIn(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const rows = (await Promise.all(config.towns.map(t => fetchTown(t, fetchImpl)))).map(rowOf);
    res.json({ ok: true, totals: totalsOf(rows), towns: rows });
  });

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use((req, res) => res.status(404).type('text').send('Not found'));
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let config;
  try { config = hqConfig(); } catch (err) {
    console.error(`[hq] won't start: ${err.message}`);
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 8080;
  createHqApp(config).listen(port, () => console.log(`[hq] listening on :${port} (${config.towns.length} towns)`));
}
