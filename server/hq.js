/* server/hq.js — one town's numbers for the HQ dashboard (MULTI_CITY_PLAN.md 4.1).
 *
 * GET /api/hq/summary, for a separate HQ service that shows every town on
 * one screen. Off unless HQ_API_KEY is set: until then the route doesn't
 * exist (the site's own 404). With it, only `Authorization: Bearer
 * <HQ_API_KEY>` gets in; an admin session never does, and the key opens no
 * admin route (requireAdmin doesn't know it). Read-only, counts and dates
 * only: no names, emails or addresses. Rate limited and cached 60 s, so a
 * busy HQ can't load the database.
 */

import crypto from 'node:crypto';
import { dailyGrowth, sumDays, issueReport, monthRevenue, goals } from './growth.js';
import { localDateStr, addDays, currentWeek } from './seo.js';

const CACHE_MS = 60 * 1000;
const KEPT = new Set(['paid', 'processing', 'active', 'hidden']);

// The next four sponsor weeks (from next Monday) booked or open, and picks
// paid this month. Test orders don't count.
export function sponsorCounts(orders, today) {
  const live = (orders || []).filter(o => o && !o.test && KEPT.has(o.status));
  const nextMonday = addDays(currentWeek(today)[0], 7);
  const weeks = [0, 1, 2, 3].map(i => addDays(nextMonday, i * 7));
  const booked = weeks.filter(w => live.some(o => o.kind === 'weekly' && o.week_start === w)).length;
  const month = today.slice(0, 7);
  return {
    weeks_booked_next_4: booked,
    weeks_open_next_4: weeks.length - booked,
    picks_sold_this_month: live.filter(o => o.kind === 'featured' && String(o.paid_at || '').slice(0, 7) === month).length
  };
}

function keyOk(header, key) {
  const m = /^Bearer (.+)$/.exec(String(header || ''));
  if (!m || !key) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(key).digest();
  return crypto.timingSafeEqual(a, b);
}

// The summary from what the town's store and server already know. Every
// part is best effort: a piece that fails reads null instead of failing all.
export async function buildSummary({ store, nowFn, town, siteUrl, commit, getEvents, getOrders, setup, health }) {
  const now = nowFn();
  const today = localDateStr(now);
  const safe = async (fn, dflt = null) => { try { return await fn(); } catch { return dflt; } };
  const subs = await safe(() => store.listSubscriberStats(), []);
  const orders = await safe(getOrders, []);
  const daily = dailyGrowth(subs, [], { today, days: 31 });
  const done = daily.filter(d => d.day < today);
  const sends = await safe(() => store.listNewsletterSends(4), []);
  const weekKeys = sends.map(s => s.week_key);
  const opens = weekKeys.length ? await safe(() => store.countEmailOpens(weekKeys), {}) : {};
  const oldest = sends.map(s => String(s.sent_at || '').slice(0, 10)).filter(Boolean).sort()[0] || today;
  const rows = await safe(() => store.listTraffic(oldest), []);
  const events = await safe(getEvents, []);
  const lastMonthDay = addDays(today.slice(0, 7) + '-01', -1);
  const byStatus = {};
  for (const o of orders) if (o && !o.test) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  const s = await safe(setup, { checks: [], status: {} });
  const missing = level => s.checks.filter(c => c.level === level && c.ok === false).map(c => c.key);
  return {
    ok: true,
    generated_at: now.toISOString(),
    town: { id: town.id, name: town.siteName, site_url: siteUrl, admin_url: `${siteUrl}/admin.html`, commit: commit || null },
    subscribers: {
      active: subs.filter(x => x.status === 'active').length,
      pending: subs.filter(x => x.status === 'pending').length,
      net_7_days: sumDays(done.slice(-7)).net,
      net_30_days: sumDays(done.slice(-30)).net,
      goals: goals(subs, daily, monthRevenue(orders, today), today)
    },
    issues: issueReport(sends, opens, subs, rows, events).slice(0, 4)
      .map(i => ({ week: i.week, edition: i.edition, sent_at: i.sent_at, sent: i.sent, opens: i.opens, open_rate: i.open_rate,
        clickers: i.clickers, click_rate: i.click_rate })),
    revenue: {
      month_to_date: monthRevenue(orders, today),
      last_month: monthRevenue(orders, lastMonthDay),
      orders_by_status: byStatus,
      live_orders: orders.filter(o => o && !o.test && KEPT.has(o.status)).length
    },
    sponsors: sponsorCounts(orders, today),
    submissions_waiting: s.status.pending_submissions ?? null,
    events: { upcoming: s.status.upcoming_events ?? null, last_collect: s.status.collected_at ?? null, published_at: s.status.published_at ?? null },
    health: await safe(health, null),
    setup: { required_missing: missing('required'), recommended_missing: missing('recommended') }
  };
}

export function registerHq(app, { key = '', limiter, nowFn = () => new Date(), build, clientKey = req => req.ip }) {
  let cache = null;
  app.get('/api/hq/summary', async (req, res, next) => {
    if (!key) return next();
    if (!limiter.check(`hq:${clientKey(req)}`).ok) return res.status(429).json({ ok: false, error: 'rate-limited' });
    if (!keyOk(req.get('authorization'), key)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    res.set('Cache-Control', 'no-store');
    const t = nowFn().getTime();
    if (cache && t - cache.at < CACHE_MS) return res.json(cache.body);
    try {
      const body = await build();
      cache = { at: t, body };
      res.json(body);
    } catch (err) {
      console.error('[hq] summary failed:', err.message);
      res.status(500).json({ ok: false, error: 'summary-failed' });
    }
  });
}
