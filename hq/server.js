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
import { rowOf, totalsOf, renderDashboard, renderLogin } from './render.js';

export { rowOf, totalsOf, renderDashboard, renderLogin };

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
    const rows = (await Promise.all(config.towns.map(t => fetchTown(t, fetchImpl)))).map((t, i) => rowOf(t, i));
    res.type('html').send(renderDashboard(rows, nowFn()));
  });

  // The same rows as JSON, for scripts (logged in only).
  app.get('/api/towns', async (req, res) => {
    if (!signedIn(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const rows = (await Promise.all(config.towns.map(t => fetchTown(t, fetchImpl)))).map((t, i) => rowOf(t, i));
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
