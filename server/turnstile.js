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
// Without a timeout a slow Cloudflare holds the visitor's form request open
// for undici's default 300 s. Past this it counts as a network error, so
// the form answers (and the visitor can retry) instead of freezing.
const TIMEOUT_MS = 8000;

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
      body: body.toString(),
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS)
    });
  } catch (err) {
    return { ok: false, error: 'network-error', detail: err.message };
  }
  let json;
  // The body read is covered by the same signal.
  try { json = await res.json(); } catch (_) { json = null; }
  if (!json || !json.success) {
    return { ok: false, error: 'verification-failed', codes: json && json['error-codes'] };
  }
  // A widget can serve several sites, so a token solved on another one
  // passes siteverify too. When Cloudflare says where it was solved, it
  // must be one of ours (opts.hostnames, see turnstileHostnames).
  const hosts = opts.hostnames || [];
  if (hosts.length && json.hostname && !hosts.includes(String(json.hostname).toLowerCase())) {
    return { ok: false, error: 'hostname-mismatch', hostname: json.hostname };
  }
  return { ok: true, response: json };
}

// The hostnames a token may come from: the site's own host, as www and
// apex (either can serve the forms), plus the Railway domain this
// environment answers on (RAILWAY_PUBLIC_DOMAIN), so a PR or staging
// environment's forms still work.
export function turnstileHostnames(siteUrl, extra = []) {
  const out = new Set();
  let host = '';
  try { host = new URL(siteUrl).hostname.toLowerCase(); } catch { /* none */ }
  if (host) {
    const apex = host.replace(/^www\./, '');
    out.add(apex).add(`www.${apex}`);
  }
  for (const h of [].concat(extra || [])) if (h) out.add(String(h).toLowerCase().replace(/:\d+$/, ''));
  return [...out];
}
