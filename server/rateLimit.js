/* server/rateLimit.js — In-memory sliding-window rate limiter.
 *
 * Single-process, no Redis dep. Suitable for the v1 submission volume (a
 * Victoria, TX events board, not a hyperscaler). If the server is scaled to
 * multiple replicas later, swap this for a shared store — the API surface is
 * deliberately small.
 */

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

  function check(key) {
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

  function reset() { buckets.clear(); }
  function size() { return buckets.size; }

  return { check, reset, size };
}
