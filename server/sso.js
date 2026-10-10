/* server/sso.js — HQ's one-time sign-in passes to a town's admin.
 *
 * The owner signs in to HQ once; each town's "Admin →" there opens that
 * town's admin already signed in. HQ mints a pass and posts it (a form
 * POST, never a URL) to the town's POST /api/admin/sso, which checks it and
 * hands back an ordinary admin session.
 *
 * A pass is base64url(JSON {v, aud, sub, iat, exp, n}) + "." + an
 * HMAC-SHA256 over it, keyed per town by HQ_SSO_SECRET: the town holds it,
 * and HQ holds each town's copy in HQ_TOWNS ("sso"). It is a different
 * secret from HQ_API_KEY, which only reads numbers. A pass is good for:
 *   - one town: `aud` is "<slug>@<host>" and must be this town's
 *   - 30 seconds (the town allows 10 s of clock difference, never a pass
 *     that claims to live longer than TTL_MAX_S)
 *   - one use: the town claims its nonce `n` in the database first, so a
 *     copied pass, or one replayed into a second container during a
 *     deploy, is refused
 * Unset on either side, the feature is off. Comparisons are constant-time.
 */

import crypto from 'node:crypto';

export const TTL_S = 30;
export const TTL_MAX_S = 120;
export const SKEW_S = 10;
export const MIN_SSO_SECRET = 32;
const MAX_PASS = 2048;
const DOMAIN = 'hq-sso-v1';

// One key per secret, and only ever used for passes.
const keyOf = secret => crypto.createHmac('sha256', String(secret)).update(`${DOMAIN}\0key`).digest();
const macOf = (secret, body) => crypto.createHmac('sha256', keyOf(secret)).update(`${DOMAIN}\0${body}`).digest('base64url');

export function audienceOf(slug, siteUrl) {
  let host = '';
  try { host = new URL(siteUrl).hostname.toLowerCase(); } catch (_) { /* empty: matches nothing */ }
  return `${slug}@${host}`;
}

// HQ: a pass for one town.
export function mintPass(secret, { slug, siteUrl, sub, now = Date.now() }) {
  if (String(secret || '').length < MIN_SSO_SECRET) throw new Error('sso-secret-too-short');
  const iat = Math.floor(now / 1000);
  const payload = { v: 1, aud: audienceOf(slug, siteUrl), sub: String(sub || 'hq'), iat, exp: iat + TTL_S,
    n: crypto.randomBytes(18).toString('base64url') };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${macOf(secret, body)}`;
}

// The town: { ok, payload } or { ok: false, reason }. It still has to claim
// payload.n before trusting it (one use).
export function verifyPass(secret, pass, { slug, siteUrl, now = Date.now() }) {
  if (String(secret || '').length < MIN_SSO_SECRET) return { ok: false, reason: 'off' };
  if (typeof pass !== 'string' || !pass || pass.length > MAX_PASS) return { ok: false, reason: 'malformed' };
  const dot = pass.indexOf('.');
  if (dot < 1 || dot !== pass.lastIndexOf('.')) return { ok: false, reason: 'malformed' };
  const body = pass.slice(0, dot);
  const want = Buffer.from(macOf(secret, body));
  const got = Buffer.from(pass.slice(dot + 1));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, reason: 'bad-signature' };
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return { ok: false, reason: 'malformed' }; }
  if (!p || p.v !== 1 || typeof p.n !== 'string' || p.n.length < 16 || typeof p.sub !== 'string') return { ok: false, reason: 'malformed' };
  if (p.aud !== audienceOf(slug, siteUrl)) return { ok: false, reason: 'wrong-town' };
  const t = Math.floor(now / 1000);
  if (!Number.isInteger(p.iat) || !Number.isInteger(p.exp) || p.exp - p.iat > TTL_MAX_S || p.exp <= p.iat) return { ok: false, reason: 'malformed' };
  if (p.iat > t + SKEW_S) return { ok: false, reason: 'not-yet-valid' };
  if (p.exp + SKEW_S < t) return { ok: false, reason: 'expired' };
  return { ok: true, payload: p };
}
