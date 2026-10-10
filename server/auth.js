/* server/auth.js — Admin login + signed session tokens.
 *
 * Replaces the old "paste a GitHub PAT into the browser" flow with a real
 * username/password login backed by Railway env vars:
 *
 *   ADMIN_USERNAME            Admin login name. Required to enable login.
 *   ADMIN_PASSWORD            Admin password. Plain string compared
 *                             constant-time against the submitted password.
 *                             Required to enable login.
 *   ADMIN_SESSION_SECRET      HMAC key for signing session tokens. Required.
 *                             Use a long random string (e.g. `openssl rand
 *                             -hex 32`). Rotating it, or changing the
 *                             username or password, invalidates every
 *                             outstanding session.
 *   ADMIN_SESSION_TTL_HOURS   Optional. Token lifetime in hours. Default 12.
 *
 * The token format is a tiny home-grown JWT-ish blob:
 *
 *   base64url(JSON({sub, iat, exp})) + "." + base64url(HMAC_SHA256(payload))
 *
 * No `alg` header — there is exactly one algorithm and one key, so the alg
 * confusion attacks don't apply. Tokens are short-lived; no revocation list.
 * The key is derived from ADMIN_SESSION_SECRET plus a hash of
 * ADMIN_USERNAME and ADMIN_PASSWORD, so changing the password (what the
 * failed-sign-in alert tells the owner to do) also ends every session
 * already issued, not just rotating the secret.
 *
 * All comparisons that touch secrets use crypto.timingSafeEqual.
 */

import crypto from 'node:crypto';

const DEFAULT_TTL_HOURS = 12;

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const std = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(std, 'base64');
}

// Compares fixed-length digests, so neither the contents nor the length of
// the secret leaks through timing.
function safeEqualStr(a, b) {
  const ah = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const bh = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ah, bh) && String(a) === String(b);
}

function safeEqualBuf(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Minimum lengths for the admin password and the session / legacy token
// secrets (the same rule HQ uses).
export const MIN_PASSWORD = 12;
export const MIN_SECRET = 32;

export function createAuth(opts = {}) {
  const username = opts.username ?? process.env.ADMIN_USERNAME ?? null;
  const password = opts.password ?? process.env.ADMIN_PASSWORD ?? null;
  const secret = opts.secret ?? process.env.ADMIN_SESSION_SECRET ?? null;
  const ttlHours = Number(
    opts.ttlHours ?? process.env.ADMIN_SESSION_TTL_HOURS ?? DEFAULT_TTL_HOURS
  );
  const ttlMs = (Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : DEFAULT_TTL_HOURS) * 3600 * 1000;

  // The "configured" check intentionally requires all three. A missing
  // ADMIN_SESSION_SECRET means we can't sign anything, so we refuse to
  // pretend login works.
  const configured = Boolean(username && password && secret);

  // Too short to stand up to guessing spread over many addresses (each
  // gets its own login budget). Not refused: production may run on these
  // today, and turning login off would lock the owner out of the admin.
  // Instead the setup checklist and a boot alert say so (server/index.js).
  const weak = [];
  if (configured && String(password).length < MIN_PASSWORD) weak.push(`ADMIN_PASSWORD is shorter than ${MIN_PASSWORD} characters`);
  if (configured && String(secret).length < MIN_SECRET) weak.push(`ADMIN_SESSION_SECRET is shorter than ${MIN_SECRET} characters`);

  // Same token format and algorithm; only the key changes with the
  // credentials. The password enters as a hash, never as key material
  // directly, and the secret still has to be known to sign.
  const signingKey = configured
    ? crypto.createHmac('sha256', secret).update('vic361-admin-session\0' +
      crypto.createHash('sha256').update(`${username}\0${password}`, 'utf8').digest('hex')).digest()
    : null;

  function signToken({ sub = username, now = Date.now() } = {}) {
    if (!configured) throw new Error('auth-not-configured');
    const payload = {
      sub,
      iat: Math.floor(now / 1000),
      exp: Math.floor((now + ttlMs) / 1000)
    };
    const payloadB64 = b64urlEncode(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', signingKey).update(payloadB64).digest();
    const sigB64 = b64urlEncode(sig);
    return payloadB64 + '.' + sigB64;
  }

  function verifyToken(token, { now = Date.now() } = {}) {
    if (!configured) return { ok: false, reason: 'not-configured' };
    if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing' };
    const dot = token.indexOf('.');
    if (dot < 1 || dot === token.length - 1) return { ok: false, reason: 'malformed' };
    const payloadB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);

    const expected = crypto.createHmac('sha256', signingKey).update(payloadB64).digest();
    let provided;
    try { provided = b64urlDecode(sigB64); } catch (_) { return { ok: false, reason: 'malformed' }; }
    if (!safeEqualBuf(expected, provided)) return { ok: false, reason: 'bad-signature' };

    let payload;
    try { payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')); }
    catch (_) { return { ok: false, reason: 'malformed' }; }

    const nowSec = Math.floor(now / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < nowSec) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, payload };
  }

  function checkLogin({ username: u, password: p }) {
    if (!configured) return { ok: false, reason: 'not-configured' };
    // Compare both fields in constant time. We deliberately compare both even
    // when the username mismatches so timing doesn't leak which one was wrong.
    const userOk = safeEqualStr(u || '', username);
    const passOk = safeEqualStr(p || '', password);
    if (!userOk || !passOk) return { ok: false, reason: 'bad-credentials' };
    return { ok: true };
  }

  return {
    configured,
    weak,
    ttlMs,
    username,
    signToken,
    verifyToken,
    checkLogin
  };
}
