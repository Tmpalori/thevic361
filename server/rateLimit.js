/* server/rateLimit.js — In-memory sliding-window rate limiter.
 *
 * Single-process, no Redis dep. Suitable for the v1 submission volume (a
 * Victoria, TX events board, not a hyperscaler). If the server is scaled to
 * multiple replicas later, swap this for a shared store — the API surface is
 * deliberately small.
 */

import { isIP } from 'node:net';

// Keys that are client addresses go through ipKey, so every limiter keys an
// IPv6 client on its /64 even when the caller passes the raw req.ip (the
// contact, newsletter and sponsor forms do). Other keys (an email address,
// 'all', an already-keyed "/64") pass through unchanged.
const normKey = key => (typeof key === 'string' && isIP(key) ? ipKey(key) : key);

export function createRateLimiter({ windowMs, max } = {}) {
  const w = windowMs ?? 60 * 1000;
  const m = max ?? 5;
  const buckets = new Map();

  let lastSweep = 0;
  // Drop idle keys now and then so the map can't grow without bound.
  function sweep(now) {
    if (now - lastSweep < w) return;
    lastSweep = now;
    for (const [k, arr] of buckets) {
      if (!arr.length || arr[arr.length - 1] <= now - w) buckets.delete(k);
    }
  }

  function check(rawKey) {
    const key = normKey(rawKey);
    const now = Date.now();
    sweep(now);
    const cutoff = now - w;
    const arr = (buckets.get(key) || []).filter(t => t > cutoff);
    if (arr.length >= m) {
      buckets.set(key, arr);
      return { ok: false, retryAfter: Math.ceil((arr[0] + w - now) / 1000) };
    }
    arr.push(now);
    buckets.set(key, arr);
    return { ok: true, remaining: m - arr.length };
  }

  // Would check() refuse this key right now? Records nothing, so failures
  // can be counted apart from attempts (the login and admin-token caps).
  function peek(rawKey) {
    const key = normKey(rawKey);
    const now = Date.now();
    const arr = (buckets.get(key) || []).filter(t => t > now - w);
    if (arr.length >= m) return { ok: false, retryAfter: Math.ceil((arr[0] + w - now) / 1000) };
    return { ok: true, remaining: m - arr.length };
  }

  function reset() { buckets.clear(); }
  function size() { return buckets.size; }

  return { check, peek, reset, size };
}

// On Railway the edge sets X-Real-IP to the visitor's address
// (docs.railway.com: Public Networking > Specs & Limits). With trust proxy
// on, prefer it, so rate limits key on the real client however many hops
// sit in between, not on the edge (one shared bucket for everyone). The
// town server and HQ both use this.
export function railwayRealIp() {
  return (req, res, next) => {
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (isIP(real)) Object.defineProperty(req, 'ip', { value: real, configurable: true });
    next();
  };
}

// The rate-limit key for a client address. One IPv6 subscriber usually gets
// a whole /64, so keying on the full address would hand an attacker
// billions of fresh budgets; key on the /64 instead. IPv4 (including the
// IPv4-mapped "::ffff:1.2.3.4" form) keys on the address.
export function ipKey(ip) {
  let s = String(ip || '').trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return mapped[1];
  if (!s.includes(':')) return s;
  s = s.split('%')[0];
  const [head, tail = ''] = s.split('::');
  const left = head ? head.split(':') : [];
  const right = s.includes('::') && tail ? tail.split(':') : [];
  const groups = s.includes('::')
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left;
  return groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}
