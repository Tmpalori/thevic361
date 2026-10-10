/* hq/server.js — every town on one screen (MULTI_CITY_PLAN.md 4.2).
 *
 * A separate Railway service from the towns (start command: node
 * hq/server.js). It has its own login and holds no town data: on each page
 * load it asks every town's GET /api/hq/summary (server/hq.js) with that
 * town's HQ_API_KEY and shows totals plus one row per town. A town with an
 * "sso" secret opens its admin already signed in (POST /go/<slug> mints a
 * one-time pass, server/sso.js); one without asks for its own login.
 *
 * Env:
 *   HQ_TOWNS            JSON list: [{"slug":"victoria","site_url":"https://www.thevic361.com","key":"…","sso":"…"}]
 *                       "sso" (optional) is the town's HQ_SSO_SECRET: with it,
 *                       the town's Admin → signs straight in (server/sso.js)
 *   HQ_TOWN_<SLUG>      (optional) one more town, {"site_url","key","sso"}
 *   HQ_SSO_<SLUG>       (optional) a town's HQ_SSO_SECRET, instead of "sso"
 *   HQ_USERNAME         login
 *   HQ_PASSWORD         login (12+ characters)
 *   HQ_SESSION_SECRET   signs the login cookie (32+ characters); the
 *                       signing key also mixes in a hash of the login, so
 *                       changing HQ_PASSWORD signs every session out
 *   PORT                (Railway sets it)
 *
 * Keys never reach the browser. A town that's down or refuses the key shows
 * as a red row; the rest still load.
 */

import crypto from 'node:crypto';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { createRateLimiter, ipKey, railwayRealIp } from '../server/rateLimit.js';
import { mintPass, MIN_SSO_SECRET } from '../server/sso.js';
import { rowOf, totalsOf, renderDashboard, renderLogin, renderLogout } from './render.js';

export { rowOf, totalsOf, renderDashboard, renderLogin };

const SESSION_HOURS = 12;
const FETCH_TIMEOUT_MS = 8000;
const COOKIE = 'hq_session';

// The HQ settings from env, or an error naming what's wrong.
// A town's name in a variable name: "victoria" → VICTORIA, "st-joe" → ST_JOE.
const envName = slug => slug.toUpperCase().replace(/-/g, '_');

export function hqConfig(env = process.env) {
  let towns;
  try { towns = JSON.parse(env.HQ_TOWNS || '[]'); } catch (_) { throw new Error('HQ_TOWNS must be JSON: [{"slug","site_url","key"}, …]'); }
  if (!Array.isArray(towns)) throw new Error('HQ_TOWNS must be JSON: [{"slug","site_url","key"}, …]');
  // A town can also be its own variable, HQ_TOWN_<SLUG> = {"site_url","key"},
  // so adding one never means rewriting (or reading) the others' keys.
  for (const [name, value] of Object.entries(env)) {
    const m = /^HQ_TOWN_([A-Z0-9_]+)$/.exec(name);
    if (!m) continue;
    let t;
    try { t = JSON.parse(value); } catch (_) { throw new Error(`${name} must be JSON: {"site_url","key"}`); }
    towns.push({ ...t, slug: m[1].toLowerCase().replace(/_/g, '-') });
  }
  if (!towns.length) throw new Error('HQ_TOWNS lists no towns');
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
    // The sign-in secret: "sso" in the town's entry, or HQ_SSO_<SLUG>.
    const sso = String((t && t.sso) || env[`HQ_SSO_${envName(slug)}`] || '').trim();
    if (sso && sso.length < MIN_SSO_SECRET) throw new Error(`HQ_TOWNS ${slug}: sso must be the town's HQ_SSO_SECRET (${MIN_SSO_SECRET}+ characters)`);
    if (sso && sso === key) throw new Error(`HQ_TOWNS ${slug}: sso must differ from key (HQ_SSO_SECRET is not HQ_API_KEY)`);
    return { slug, siteUrl, key, ...(sso ? { sso } : {}) };
  });
  const username = String(env.HQ_USERNAME || '').trim();
  const password = String(env.HQ_PASSWORD || '');
  const secret = String(env.HQ_SESSION_SECRET || '');
  if (!username || password.length < 12) throw new Error('Set HQ_USERNAME and HQ_PASSWORD (12+ characters)');
  if (secret.length < 32) throw new Error('Set HQ_SESSION_SECRET (32+ characters)');
  return { towns, username, password, secret };
}

const same = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

// The cookie's signing key: the secret plus a hash of the username and
// password (as server/auth.js does for town admins), so a new HQ_PASSWORD
// invalidates every session signed with the old one.
export function sessionKey(config) {
  const login = crypto.createHash('sha256').update(`${config.username}\0${config.password}`).digest('hex');
  return crypto.createHmac('sha256', config.secret).update(`hq-session:${login}`).digest();
}

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
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

export function createHqApp(config, {
  fetchImpl = globalThis.fetch, nowFn = () => new Date(), loginLimiter,
  railway = Boolean(process.env.RAILWAY_ENVIRONMENT_NAME)
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // The client's own address behind Railway's edge, as the town server
  // does: else every visitor may share the edge's bucket, and ten bad tries
  // by anyone lock the owner out.
  if (railway) app.use(railwayRealIp());
  const limiter = loginLimiter || createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
  const key = sessionKey(config);
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    });
    next();
  });
  const signedIn = req => Boolean(verify(key, cookieOf(req, COOKIE), nowFn().getTime()));
  const secure = req => req.secure || req.get('x-forwarded-proto') === 'https';

  app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    if (!limiter.check(ipKey(req.ip)).ok) return res.status(429).type('html').send(renderLogin('Too many tries. Wait a few minutes.'));
    const b = req.body || {};
    // `|`, not `||`: both compare every time, so timing says nothing about which was wrong.
    if (!same(b.username || '', config.username) | !same(b.password || '', config.password)) {
      return res.status(401).type('html').send(renderLogin('Wrong username or password.'));
    }
    const token = sign(key, { u: config.username, exp: nowFn().getTime() + SESSION_HOURS * 3600 * 1000 });
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: secure(req), maxAge: SESSION_HOURS * 3600 * 1000, path: '/' });
    res.redirect(303, '/');
  });

  // Logout is a POST (the cookie is SameSite=Strict, so another site can't
  // send it). GET, from an old link or bookmark, asks first.
  app.post('/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect(303, '/');
  });
  app.get('/logout', (req, res) => res.type('html').send(renderLogout()));

  app.get('/', async (req, res) => {
    if (!signedIn(req)) return res.type('html').send(renderLogin());
    const rows = (await Promise.all(config.towns.map(t => fetchTown(t, fetchImpl)))).map((t, i) => rowOf({ ...t, sso: Boolean(config.towns[i].sso) }, i));
    res.type('html').send(renderDashboard(rows, nowFn()));
  });

  // The same rows as JSON, for scripts (logged in only).
  app.get('/api/towns', async (req, res) => {
    if (!signedIn(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const rows = (await Promise.all(config.towns.map(t => fetchTown(t, fetchImpl)))).map((t, i) => rowOf({ ...t, sso: Boolean(config.towns[i].sso) }, i));
    res.json({ ok: true, totals: totalsOf(rows), towns: rows });
  });

  // A town's Admin →: a one-time pass for that town, posted from the
  // owner's browser by a page that submits itself (the pass never sits in
  // a URL). Signed in only; the cookie is SameSite=Strict, and the Origin
  // must be HQ's own, so another site can't start this.
  app.post('/go/:slug', (req, res) => {
    if (!signedIn(req)) return res.status(401).type('html').send(renderLogin());
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).type('text').send('Forbidden');
    const t = config.towns.find(x => x.slug === req.params.slug);
    if (!t || !t.sso) return res.status(404).type('text').send('Not found');
    const pass = mintPass(t.sso, { slug: t.slug, siteUrl: t.siteUrl, sub: config.username, now: nowFn().getTime() });
    const nonce = crypto.randomBytes(16).toString('base64');
    const action = `${t.siteUrl}/api/admin/sso`;
    res.set('Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action ${t.siteUrl}; frame-ancestors 'none'; base-uri 'none'`);
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Opening ${esc(t.slug)}…</title>` +
      `<form id="go" method="post" action="${esc(action)}"><input type="hidden" name="pass" value="${esc(pass)}">` +
      `<noscript><button>Open ${esc(t.slug)} admin</button></noscript></form>` +
      `<script nonce="${nonce}">document.getElementById('go').submit()</script>`);
  });

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use((req, res) => res.status(404).type('text').send('Not found'));
  return app;
}

// Railway copies the service into every PR environment that touches HQ's
// code, with production's variables. Such a copy must not be a second door
// to the real login and every town's numbers: outside production HQ only
// answers /health (so the deploy is healthy) and says login is off.
export function isPreview(env = process.env) {
  const name = String(env.RAILWAY_ENVIRONMENT_NAME || '');
  return Boolean(name) && name !== 'production';
}

export function createPreviewApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
      'Strict-Transport-Security': 'max-age=31536000',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
    next();
  });
  app.get('/health', (req, res) => res.json({ ok: true, preview: true }));
  app.use((req, res) => res.status(404).type('text').send('HQ preview: login is off outside production.'));
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT) || 8080;
  if (isPreview()) {
    createPreviewApp().listen(port, () => console.log(`[hq] preview (${process.env.RAILWAY_ENVIRONMENT_NAME}): login off, no towns asked`));
  } else {
    startHq(port);
  }
}

function startHq(port) {
  let config;
  try { config = hqConfig(); } catch (err) {
    console.error(`[hq] won't start: ${err.message}`);
    process.exit(1);
  }
  createHqApp(config).listen(port, () => console.log(`[hq] listening on :${port} (${config.towns.length} towns)`));
}
