/* server/turnstile.js — Cloudflare Turnstile server-side verification.
 *
 * If TURNSTILE_SECRET_KEY is set, we POST the token to Cloudflare's siteverify
 * endpoint. If unset, we treat verification as disabled (returns
 * { ok: true, disabled: true }) — the public submit page still ships honeypot,
 * timing, and rate limiting. This split keeps local dev frictionless while
 * letting prod opt in by setting the env var.
 *
 * Contract: never accept a missing or invalid token when the secret IS
 * configured. Tests pin this behavior.
 */

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(token, opts = {}) {
  const secret = opts.secret ?? process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true, disabled: true };
  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'missing-token' };
  }
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (!fetchImpl) {
    return { ok: false, error: 'fetch-unavailable' };
  }

  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', token);
  if (opts.remoteip) body.set('remoteip', opts.remoteip);

  let res;
  try {
    res = await fetchImpl(SITEVERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
  } catch (err) {
    return { ok: false, error: 'network-error', detail: err.message };
  }
  let json;
  try { json = await res.json(); } catch (_) { json = null; }
  if (!json || !json.success) {
    return { ok: false, error: 'verification-failed', codes: json && json['error-codes'] };
  }
  return { ok: true, response: json };
}
