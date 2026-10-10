/* hq/render.js — the HQ pages (hq/server.js serves them).
 *
 * Server-rendered and script-free (the CSP allows no scripts): charts are
 * inline SVG, hover readouts are CSS, and every value a chart shows is also
 * in the town table, so nothing is hover-only. Town colors follow the
 * town's place in HQ_TOWNS, never its rank, so a town keeps its color when
 * another one is down. Everything a town sends is escaped.
 */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fin = n => (n === null || n === undefined || n === '' ? null : Number.isFinite(Number(n)) ? Number(n) : null);
const TZ = 'America/Chicago';
const SLOTS = 8;   // categorical colors; a ninth town reads gray

// ─── Numbers ─────────────────────────────────────────────────────────────

const num = n => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
const compact = n => {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return `${+(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${+(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
  return Math.round(n).toLocaleString('en-US');
};
const money = c => (Number.isFinite(c) ? `$${Math.round(c / 100).toLocaleString('en-US')}` : '—');
const moneyShort = c => (Number.isFinite(c) ? `$${compact(c / 100)}` : '—');
const pct = n => (Number.isFinite(n) ? `${+n.toFixed(1)}%` : '—');
const signed = n => (Number.isFinite(n) ? `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Math.round(n)).toLocaleString('en-US')}` : '—');
const dateOf = d => new Date(`${d}T12:00:00Z`);
const shortDay = d => dateOf(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortMonth = m => dateOf(`${m}-01`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
function ago(iso, now) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '—';
  const m = Math.max(0, Math.round((now.getTime() - t) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

// ─── Data ────────────────────────────────────────────────────────────────

// One town's numbers, from its /api/hq/summary (or its error).
export function rowOf(t, index = 0) {
  const base = { slug: t.slug, siteUrl: t.siteUrl, color: index };
  const s = t.summary;
  if (!s) return { ...base, error: t.error };
  const subs = s.subscribers || {};
  const rev = s.revenue || {};
  const sp = s.sponsors || {};
  const issues = Array.isArray(s.issues) ? s.issues : [];
  const issue = issues[0] || null;
  const health = s.health || {};
  const setup = s.setup || {};
  const goals = subs.goals || {};
  const problems = [
    health.database === false && 'database',
    health.scheduler_blocked && 'scheduler',
    health.slack_refused && 'Slack',
    ...(setup.required_missing || []).map(k => `setup: ${k}`)
  ].filter(Boolean);
  return {
    ...base,
    name: s.town && s.town.name, adminUrl: (s.town && s.town.admin_url) || `${t.siteUrl}/admin.html`,
    commit: (s.town && s.town.commit) || null,
    subscribers: s.subscribers ? fin(subs.active) : null,
    pending: fin(subs.pending),
    net7: s.subscribers ? fin(subs.net_7_days) : null,
    net30: fin(subs.net_30_days),
    joined30: fin(subs.joined_30_days),
    left30: fin(subs.left_30_days),
    sources: subs.sources_30_days && typeof subs.sources_30_days === 'object' ? subs.sources_30_days : {},
    daily: (Array.isArray(subs.daily) ? subs.daily : []).filter(d => d && /^\d{4}-\d{2}-\d{2}$/.test(d.day) && fin(d.active) !== null)
      .map(d => ({ day: d.day, active: fin(d.active) })),
    openRate: issue ? fin(issue.open_rate) : null,
    clickRate: issue ? fin(issue.click_rate) : null,
    issues: issues.slice(0, 4).reverse().map(i => ({ sent_at: i.sent_at, edition: i.edition, sent: fin(i.sent), openRate: fin(i.open_rate) })),
    revenueCents: rev.month_to_date ? fin(rev.month_to_date.cents) : null,
    recurringCents: rev.month_to_date ? fin(rev.month_to_date.recurring_cents) : null,
    lastMonthCents: rev.last_month ? fin(rev.last_month.cents) : null,
    months: (Array.isArray(rev.months) ? rev.months : []).filter(m => m && /^\d{4}-\d{2}$/.test(m.month))
      .map(m => ({ month: m.month, cents: fin(m.cents) || 0 })),
    adSpend: s.ads ? fin(s.ads.spend_30_days) : null,
    costPerSub: s.ads ? fin(s.ads.cost_per_sub_30_days) : null,
    weeks: (Array.isArray(sp.weeks) ? sp.weeks : []).filter(w => w && /^\d{4}-\d{2}-\d{2}$/.test(w.week_start))
      .map(w => ({ week: w.week_start, booked: Boolean(w.booked) })),
    openWeeks: s.sponsors ? fin(sp.weeks_open_next_4) : null,
    bookedWeeks: s.sponsors ? fin(sp.weeks_booked_next_4) : null,
    picks: s.sponsors ? fin(sp.picks_sold_this_month) : null,
    waiting: fin(s.submissions_waiting),
    upcoming: s.events ? fin(s.events.upcoming) : null,
    lastCollect: (s.events && s.events.last_collect) || null,
    publishedAt: (s.events && s.events.published_at) || null,
    subGoal: goals.subscribers ? { goal: fin(goals.subscribers.goal), perWeek: fin(goals.subscribers.per_week), eta: goals.subscribers.eta || null } : null,
    revenueGoalCents: goals.revenue ? fin(goals.revenue.goal_cents) : null,
    recommendedMissing: (setup.recommended_missing || []).length,
    problems
  };
}

// The whole network: sums, rates weighted by subscribers, and the series
// the charts draw.
export function totalsOf(rows) {
  const up = rows.filter(r => !r.error);
  // null when no town reports it (an older town), so it reads — rather than 0.
  const sum = k => (rows.some(r => Number.isFinite(r[k])) ? rows.reduce((a, r) => a + (Number.isFinite(r[k]) ? r[k] : 0), 0) : null);
  const weighted = k => {
    const rs = rows.filter(r => Number.isFinite(r[k]) && Number.isFinite(r.subscribers) && r.subscribers > 0);
    const w = rs.reduce((a, r) => a + r.subscribers, 0);
    return w ? Math.round(rs.reduce((a, r) => a + r[k] * r.subscribers, 0) / w * 10) / 10 : null;
  };
  const byDay = new Map();
  for (const r of up) for (const d of r.daily || []) byDay.set(d.day, (byDay.get(d.day) || 0) + d.active);
  const monthKeys = [...new Set(up.flatMap(r => (r.months || []).map(m => m.month)))].sort().slice(-6);
  const sources = {};
  for (const r of up) for (const [k, v] of Object.entries(r.sources || {})) if (Number.isFinite(Number(v))) sources[k] = (sources[k] || 0) + Number(v);
  const spendRows = up.filter(r => Number.isFinite(r.adSpend));
  const adSpend = spendRows.length ? Math.round(spendRows.reduce((a, r) => a + r.adSpend, 0) * 100) / 100 : null;
  const paidJoined = spendRows.reduce((a, r) => a + (Number.isFinite(r.costPerSub) && r.costPerSub > 0 ? r.adSpend / r.costPerSub : 0), 0);
  return {
    towns: rows.length, down: rows.filter(r => r.error).length,
    attention: rows.filter(r => r.error || (r.problems && r.problems.length)).length,
    subscribers: sum('subscribers'), pending: sum('pending'), net7: sum('net7'), net30: sum('net30'),
    joined30: sum('joined30'), left30: sum('left30'),
    revenueCents: sum('revenueCents'), lastMonthCents: sum('lastMonthCents'), recurringCents: sum('recurringCents'),
    openWeeks: sum('openWeeks'), bookedWeeks: sum('bookedWeeks'), picks: sum('picks'), waiting: sum('waiting'), upcoming: sum('upcoming'),
    openRate: weighted('openRate'), clickRate: weighted('clickRate'),
    adSpend, costPerSub: adSpend !== null && paidJoined > 0 ? Math.round(adSpend / paidJoined * 100) / 100 : null,
    subGoal: up.reduce((a, r) => a + ((r.subGoal && r.subGoal.goal) || 0), 0) || null,
    revenueGoalCents: up.reduce((a, r) => a + (r.revenueGoalCents || 0), 0) || null,
    daily: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, active]) => ({ day, active })),
    months: monthKeys.map(month => ({ month, towns: up.map(r => ({ r, cents: ((r.months || []).find(m => m.month === month) || {}).cents || 0 })) })),
    sources: Object.entries(sources).sort((a, b) => b[1] - a[1])
  };
}

// ─── Charts (inline SVG) ─────────────────────────────────────────────────

function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}
function ticks(min, max, count = 4, fromZero = false) {
  if (fromZero) min = Math.min(0, min);
  if (max === min) { max += 1; if (!fromZero) min -= 1; }
  const step = Math.max(1, niceStep(max - min, count));
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(v);
  return out;
}
const tipWidth = (...lines) => Math.max(...lines.map(l => String(l).length)) * 6.6 + 20;

// A line with a soft area wash, a hover crosshair per day and an end label.
function lineChart(points, { w = 640, h = 220, label = 'subscribers', id = 'l' } = {}) {
  if (points.length < 2) return '<p class="empty">Not enough history yet.</p>';
  const L = 44, R = 64, T = 14, B = 28;
  const pw = w - L - R, ph = h - T - B;
  const vals = points.map(p => p.active);
  const tk = ticks(Math.min(...vals), Math.max(...vals), 4);
  const y = v => T + ph - ((v - tk[0]) / (tk[tk.length - 1] - tk[0])) * ph;
  const x = i => L + (i / (points.length - 1)) * pw;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.active).toFixed(1)}`).join('');
  const area = `${line}L${x(points.length - 1).toFixed(1)},${T + ph}L${L},${T + ph}Z`;
  const grid = tk.map(v => `<line class="grid" x1="${L}" x2="${L + pw}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>` +
    `<text class="tick" x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${compact(v)}</text>`).join('');
  const xi = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const xl = xi.map((i, k) => `<text class="tick" x="${x(i).toFixed(1)}" y="${h - 8}" text-anchor="${k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}">${esc(shortDay(points[i].day))}</text>`).join('');
  const band = pw / (points.length - 1);
  const hits = points.map((p, i) => {
    const px = x(i), py = y(p.active);
    const v = `${num(p.active)} ${label}`, d = shortDay(p.day);
    const tw = tipWidth(v, d);
    const tx = Math.min(Math.max(px - tw / 2, L), L + pw - tw);
    const ty = py - 58 < T ? py + 14 : py - 58;
    return `<g class="hit" tabindex="0"><rect x="${(px - band / 2).toFixed(1)}" y="${T}" width="${band.toFixed(1)}" height="${ph}" fill="transparent"/>` +
      `<line class="xh" x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${T}" y2="${T + ph}"/>` +
      `<circle class="hd" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="5"/>` +
      `<g class="tip"><rect x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" width="${tw.toFixed(1)}" height="44" rx="8"/>` +
      `<text x="${(tx + 10).toFixed(1)}" y="${(ty + 19).toFixed(1)}" class="tv">${esc(v)}</text>` +
      `<text x="${(tx + 10).toFixed(1)}" y="${(ty + 35).toFixed(1)}" class="tl">${esc(d)}</text></g>` +
      `<title>${esc(d)}: ${esc(v)}</title></g>`;
  }).join('');
  const last = points[points.length - 1];
  const lx = x(points.length - 1), ly = y(last.active);
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(`Active ${label}, last ${points.length} days`)}">` +
    `<defs><linearGradient id="${id}g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".18"/>` +
    `<stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>${grid}` +
    `<line class="base" x1="${L}" x2="${L + pw}" y1="${T + ph}" y2="${T + ph}"/>${xl}` +
    `<path d="${area}" fill="url(#${id}g)"/><path class="ln" d="${line}"/>` +
    `<circle class="end" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4.5"/>` +
    `<text class="endl" x="${(lx + 10).toFixed(1)}" y="${(ly + 4).toFixed(1)}">${compact(last.active)}</text>${hits}</svg>`;
}

// A tiny trend line for a stat tile or a town card.
function sparkline(values, { w = 120, h = 34 } = {}) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return '';
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const x = i => 3 + (i / (v.length - 1)) * (w - 6);
  const y = n => 4 + (h - 8) - ((n - lo) / span) * (h - 8);
  const d = v.map((n, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(n).toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}"/>` +
    `<circle cx="${x(v.length - 1).toFixed(1)}" cy="${y(v[v.length - 1]).toFixed(1)}" r="3"/></svg>`;
}

// Revenue per month, one stacked column per month, a segment per town.
function revenueColumns(months, { w = 640, h = 240 } = {}) {
  if (!months.some(m => m.towns.some(t => t.cents > 0))) return '<p class="empty">No revenue in the last six months yet.</p>';
  const L = 52, R = 12, T = 22, B = 28;
  const pw = w - L - R, ph = h - T - B;
  const totals = months.map(m => m.towns.reduce((a, t) => a + t.cents, 0));
  const tk = ticks(0, Math.max(...totals, 1), 4, true);
  const top = tk[tk.length - 1];
  const y = c => T + ph - (c / top) * ph;
  const bandW = pw / months.length;
  const bw = Math.min(28, bandW * 0.5);
  const grid = tk.map(v => `<line class="grid" x1="${L}" x2="${L + pw}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>` +
    `<text class="tick" x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${moneyShort(v)}</text>`).join('');
  const cols = months.map((m, i) => {
    const cx = L + bandW * i + bandW / 2;
    const bx = cx - bw / 2;
    const segs = m.towns.filter(t => t.cents > 0);
    let acc = 0;
    const parts = segs.map((t, k) => {
      const y0 = y(acc), y1 = y(acc + t.cents);
      acc += t.cents;
      const isTop = k === segs.length - 1;
      const gap = k ? 2 : 0;   // a 2px surface gap between stacked segments
      const yb = y0 - gap, yt = y1;
      const hgt = Math.max(0, yb - yt);
      const r = isTop ? Math.min(4, hgt) : 0;
      const d = `M${bx.toFixed(1)},${yb.toFixed(1)}V${(yt + r).toFixed(1)}` +
        (r ? `Q${bx.toFixed(1)},${yt.toFixed(1)} ${(bx + r).toFixed(1)},${yt.toFixed(1)}H${(bx + bw - r).toFixed(1)}Q${(bx + bw).toFixed(1)},${yt.toFixed(1)} ${(bx + bw).toFixed(1)},${(yt + r).toFixed(1)}`
          : `H${(bx + bw).toFixed(1)}`) + `V${yb.toFixed(1)}Z`;
      const name = t.r.name || t.r.slug;
      return `<path class="seg ${townClass(t.r)}" d="${d}" tabindex="0"><title>${esc(name)} · ${esc(shortMonth(m.month))}: ${esc(money(t.cents))}</title></path>`;
    }).join('');
    const total = totals[i];
    return `${parts}<text class="cap" x="${cx.toFixed(1)}" y="${(y(total) - 7).toFixed(1)}" text-anchor="middle">${total ? moneyShort(total) : ''}</text>` +
      `<text class="tick" x="${cx.toFixed(1)}" y="${h - 8}" text-anchor="middle">${esc(shortMonth(m.month))}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Revenue by month, last six months">${grid}` +
    `<line class="base" x1="${L}" x2="${L + pw}" y1="${T + ph}" y2="${T + ph}"/>${cols}</svg>`;
}

// Open rate of a town's last few issues, oldest first.
function issueBars(issues) {
  if (!issues.length) return '<p class="empty">No issues sent yet.</p>';
  return `<div class="ibars">${issues.map(i => {
    const v = Number.isFinite(i.openRate) ? i.openRate : 0;
    const when = i.sent_at ? shortDay(String(i.sent_at).slice(0, 10)) : '';
    const what = `${pct(i.openRate)} opened${Number.isFinite(i.sent) ? ` of ${num(i.sent)}` : ''}`;
    return `<div class="ibar" title="${esc(when ? `${when}${i.edition ? ` (${i.edition})` : ''}: ${what}` : what)}">` +
      `<span class="iv">${pct(i.openRate)}</span><span class="col"><i style="height:${Math.max(2, Math.min(100, v)).toFixed(1)}%"></i></span>` +
      `<span class="il">${esc(when)}</span></div>`;
  }).join('')}</div>`;
}

// ─── Pieces ──────────────────────────────────────────────────────────────

const townClass = r => (r.color < SLOTS ? `t${r.color}` : 'tx');
const dot = r => `<span class="dot ${townClass(r)}" aria-hidden="true"></span>`;

function delta(n, { suffix = '', goodUp = true, fmt = signed } = {}) {
  if (!Number.isFinite(n)) return '<span class="delta">—</span>';
  const dir = n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
  const good = dir === 'flat' ? 'flat' : (dir === 'up') === goodUp ? 'good' : 'bad';
  return `<span class="delta ${good}"><span aria-hidden="true">${dir === 'up' ? '▲' : dir === 'down' ? '▼' : '•'}</span> ${esc(fmt(n))}${esc(suffix)}</span>`;
}
function changePct(now, before) {
  if (!Number.isFinite(now) || !Number.isFinite(before) || before <= 0) return null;
  return Math.round((now - before) / before * 1000) / 10;
}
function meter(value, goal, { fmt = num, label = '' } = {}) {
  if (!Number.isFinite(goal) || goal <= 0) return '';
  const p = Math.max(0, Math.min(100, (value || 0) / goal * 100));
  return `<div class="meter"><div class="mh"><span>${esc(label)}</span><span><b>${esc(fmt(value))}</b> / ${esc(fmt(goal))}</span></div>` +
    `<div class="track" role="meter" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${value || 0}" aria-label="${esc(label)}"><i style="width:${p.toFixed(1)}%"></i></div></div>`;
}
function tile(label, value, { sub = '', trend = '', tone = '' } = {}) {
  return `<div class="tile${tone ? ` ${tone}` : ''}"><div class="tlabel">${esc(label)}</div><div class="tvalue">${esc(value)}</div>` +
    `<div class="tfoot">${sub}${trend}</div></div>`;
}
function healthChip(r) {
  if (r.error) return `<span class="chip crit"><span aria-hidden="true">✕</span> ${esc(r.error)}</span>`;
  if (r.problems.length) return `<span class="chip warn"><span aria-hidden="true">!</span> ${esc(r.problems.join(', '))}</span>`;
  return '<span class="chip ok"><span aria-hidden="true">✓</span> Healthy</span>';
}
function weekSlots(weeks) {
  if (!weeks.length) return '';
  return `<div class="slots">${weeks.map(w => `<span class="slot${w.booked ? ' on' : ''}" title="${esc(`Week of ${shortDay(w.week)}: ${w.booked ? 'booked' : 'open'}`)}">` +
    `<i aria-hidden="true"></i><span>${esc(shortDay(w.week))}</span><span class="sr">${w.booked ? 'booked' : 'open'}</span></span>`).join('')}</div>`;
}

// ─── Page ────────────────────────────────────────────────────────────────

const STYLE = `
:root{color-scheme:light;
--page:#f4f4f1;--surface:#fcfcfb;--raise:#ffffff;--ink:#0b0b0b;--ink2:#52514e;--muted:#6f6d68;--grid:#e1e0d9;--axis:#c3c2b7;
--ring:rgba(11,11,11,.08);--shadow:0 1px 2px rgba(11,11,11,.04),0 8px 24px -12px rgba(11,11,11,.12);
--accent:#2a78d6;--accent-soft:#cde2fb;--good:#006300;--bad:#b42318;--ok-bg:#e6f4e6;--warn-bg:#fdf1d8;--crit-bg:#fbe4e2;--warn-ink:#7a4d00;
--t0:#2a78d6;--t1:#eb6834;--t2:#1baf7a;--t3:#eda100;--t4:#e87ba4;--t5:#008300;--t6:#6250d6;--t7:#e34948;--tx:#898781;
--hero:linear-gradient(135deg,#ffffff 0%,#eef4fd 100%)}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;
--page:#0d0d0d;--surface:#1a1a19;--raise:#1f1f1e;--ink:#f0efec;--ink2:#c3c2b7;--muted:#9a988f;--grid:#2c2c2a;--axis:#383835;
--ring:rgba(255,255,255,.08);--shadow:0 1px 2px rgba(0,0,0,.3),0 12px 32px -16px rgba(0,0,0,.6);
--accent:#3987e5;--accent-soft:#184f95;--good:#0ca30c;--bad:#ff7b72;--ok-bg:rgba(12,163,12,.14);--warn-bg:rgba(250,178,25,.14);--crit-bg:rgba(208,59,59,.18);--warn-ink:#fab219;
--t0:#3987e5;--t1:#d95926;--t2:#199e70;--t3:#c98500;--t4:#d55181;--t5:#008300;--t6:#9085e9;--t7:#e66767;
--hero:linear-gradient(135deg,#1c1f26 0%,#1a1a19 70%)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--page);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
.shell{max-width:1240px;margin:0 auto;padding:0 16px 48px}
header.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--page) 82%,transparent);backdrop-filter:saturate(1.4) blur(12px);-webkit-backdrop-filter:saturate(1.4) blur(12px);border-bottom:1px solid var(--ring)}
.bar{max-width:1240px;margin:0 auto;padding:12px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;letter-spacing:-.01em;font-size:15px;text-decoration:none}
.logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--t0),var(--t6));display:grid;place-items:center;color:#fff;font-size:12px;font-weight:700;letter-spacing:.02em}
.spacer{flex:1}
.meta{color:var(--muted);font-size:13px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:9px;border:1px solid var(--ring);background:var(--raise);color:var(--ink);text-decoration:none;font-size:13px;font-weight:550}
.btn:hover{border-color:var(--axis)}
.btn.primary{background:var(--accent);border-color:transparent;color:#fff}
.chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12.5px;font-weight:600;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.chip.ok{background:var(--ok-bg);color:var(--good)}.chip.warn{background:var(--warn-bg);color:var(--warn-ink)}.chip.crit{background:var(--crit-bg);color:var(--bad)}
h1{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin:28px 0 12px}
h2{font-size:15px;font-weight:650;margin:0;letter-spacing:-.01em}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:16px;box-shadow:var(--shadow)}
.pad{padding:18px 20px}
.hd2{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.hd2 .meta{font-size:12.5px}
.hero{display:grid;grid-template-columns:minmax(260px,1fr) 2fr;gap:0;background:var(--hero);overflow:hidden}
.hero .left{padding:24px;border-right:1px solid var(--ring);display:flex;flex-direction:column;gap:14px}
.hero .right{padding:18px 20px 8px}
.big{font-size:56px;line-height:1;font-weight:700;letter-spacing:-.03em}
.big small{display:block;font-size:13px;font-weight:550;color:var(--muted);letter-spacing:0;margin-bottom:10px;text-transform:uppercase;letter-spacing:.06em}
.row{display:flex;gap:16px;flex-wrap:wrap;align-items:center}
.kv{display:flex;flex-direction:column;gap:2px}.kv span{color:var(--muted);font-size:12px}.kv b{font-size:15px;font-weight:650}
.delta{font-size:13px;font-weight:600;color:var(--ink2);white-space:nowrap}.delta.good{color:var(--good)}.delta.bad{color:var(--bad)}
.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:12px}
.tile{background:var(--surface);border:1px solid var(--ring);border-radius:14px;padding:14px 16px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:4px;min-width:0}
.tile.attn{border-color:color-mix(in srgb,var(--warn-ink) 45%,transparent)}
.tlabel{color:var(--muted);font-size:12.5px;font-weight:550}
.tvalue{font-size:26px;font-weight:700;letter-spacing:-.02em;line-height:1.15}
.tfoot{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:8px;min-height:34px;color:var(--muted);font-size:12.5px}
.spark{width:96px;height:30px;flex:none}.spark path{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.spark circle{fill:var(--accent);stroke:var(--surface);stroke-width:2}
.grid2{display:grid;grid-template-columns:3fr 2fr;gap:12px;margin-top:12px}
.chart{display:block;width:100%;height:auto;overflow:visible}
.chart .grid{stroke:var(--grid);stroke-width:1}.chart .base{stroke:var(--axis);stroke-width:1}
.chart text{font:11px system-ui,-apple-system,"Segoe UI",sans-serif;fill:var(--muted);font-variant-numeric:tabular-nums}
.chart .ln{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.chart .end{fill:var(--accent);stroke:var(--surface);stroke-width:2}
.chart .endl{fill:var(--ink);font-weight:650;font-size:12px}
.chart .cap{fill:var(--ink2);font-weight:600}
.chart .xh{stroke:var(--axis);stroke-width:1}.chart .hd{fill:var(--accent);stroke:var(--surface);stroke-width:2}
.chart .hit .xh,.chart .hit .hd,.chart .hit .tip{opacity:0;transition:opacity .08s}
.chart .hit:hover .xh,.chart .hit:hover .hd,.chart .hit:hover .tip,.chart .hit:focus .xh,.chart .hit:focus .hd,.chart .hit:focus .tip{opacity:1}
.chart .hit{outline:none}
.chart .tip rect{fill:var(--raise);stroke:var(--ring)}
.chart .tip .tv{fill:var(--ink);font-weight:700;font-size:12.5px}.chart .tip .tl{fill:var(--muted)}
.chart .seg{transition:opacity .1s;outline:none}.chart .seg:hover,.chart .seg:focus{opacity:.78}
${Array.from({ length: SLOTS }, (_, i) => `.t${i}{--c:var(--t${i})}`).join('')}.tx{--c:var(--tx)}
.chart .seg{fill:var(--c)}
.dot{display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--c);flex:none}
.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--ink2);font-size:12.5px}.legend span{display:inline-flex;align-items:center;gap:6px}
.sources{display:flex;flex-direction:column;gap:12px}
.src{display:grid;grid-template-columns:110px 1fr 48px;align-items:center;gap:10px;font-size:13px}
.src .b{height:10px;border-radius:0 4px 4px 0;background:var(--accent);min-width:2px}
.src .n{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.src .l{color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.empty{color:var(--muted);margin:24px 0;text-align:center}
.narrow{display:none}
.tablewrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;min-width:900px;font-variant-numeric:tabular-nums}
th,td{padding:12px 10px;text-align:right;white-space:nowrap;border-bottom:1px solid var(--grid)}
th:first-child,td:first-child{text-align:left}
th{font-size:11.5px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em;background:var(--surface);position:sticky;top:0}
tbody tr:hover td{background:color-mix(in srgb,var(--accent) 5%,transparent)}
tbody tr:last-child td{border-bottom:0}
td.town{display:flex;align-items:center;gap:10px;font-weight:600}
td.town a{text-decoration:none}td.town a:hover{text-decoration:underline}
td.hl{text-align:left}
.inl{display:inline-flex;align-items:center;gap:8px;justify-content:flex-end}
.inl i{display:inline-block;height:6px;border-radius:0 3px 3px 0;background:var(--accent);opacity:.5}
tfoot td{font-weight:700;border-top:1px solid var(--axis);border-bottom:0}
.towns{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px}
.town-card{display:flex;flex-direction:column;gap:16px;position:relative;overflow:hidden}
.town-card::before{content:"";position:absolute;left:0;top:0;right:0;height:3px;background:var(--c)}
.tc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.tc-name{display:flex;flex-direction:column;gap:2px;min-width:0}
.tc-name h2{display:flex;align-items:center;gap:8px}
.tc-name a.host{color:var(--muted);font-size:12.5px;text-decoration:none}.tc-name a.host:hover{text-decoration:underline}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.stat{background:var(--page);border-radius:12px;padding:10px 12px;min-width:0}
.stat>span{display:block;color:var(--muted);font-size:12px}.stat b{display:block;font-size:19px;font-weight:700;letter-spacing:-.01em}
.stat .delta{display:block;font-size:12px;margin-top:2px}
.sec{display:flex;flex-direction:column;gap:8px}
.sec-t{font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em;display:flex;justify-content:space-between}
.ibars{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;align-items:end}
.ibar{display:flex;flex-direction:column;align-items:center;gap:4px}
.ibar .col{height:64px;width:100%;max-width:24px;display:flex;align-items:flex-end;background:var(--page);border-radius:4px 4px 0 0}
.ibar .col i{display:block;width:100%;background:var(--accent);border-radius:4px 4px 0 0}
.ibar .iv{font-size:12px;font-weight:650;font-variant-numeric:tabular-nums}.ibar .il{font-size:11px;color:var(--muted)}
.slots{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.slot{display:flex;align-items:center;gap:6px;padding:7px 9px;border-radius:10px;border:1px dashed var(--axis);font-size:12px;color:var(--muted)}
.slot i{width:8px;height:8px;border-radius:50%;border:2px solid var(--axis);flex:none}
.slot.on{border-style:solid;border-color:transparent;background:var(--ok-bg);color:var(--good);font-weight:600}.slot.on i{background:var(--good);border-color:var(--good)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.meter{display:flex;flex-direction:column;gap:6px}
.mh{display:flex;justify-content:space-between;font-size:12.5px;color:var(--muted)}.mh b{color:var(--ink)}
.track{height:8px;border-radius:999px;background:var(--accent-soft);overflow:hidden}.track i{display:block;height:100%;border-radius:999px;background:var(--accent)}
.tc-foot{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:12px;border-top:1px solid var(--grid);padding-top:12px}
.tc-foot b{color:var(--ink2);font-weight:600}
.down{display:flex;flex-direction:column;gap:10px;justify-content:center;min-height:160px}
.goalrow{display:grid;grid-template-columns:1fr;gap:12px}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
.login{min-height:100vh;display:grid;place-items:center;padding:16px}
.login .card{width:100%;max-width:380px;padding:28px}
.login h2{font-size:20px;margin:14px 0 4px}.login p{color:var(--muted);margin:0 0 20px}
form{display:grid;gap:10px}
input{font:inherit;padding:11px 12px;border:1px solid var(--axis);border-radius:10px;background:var(--raise);color:var(--ink)}
input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
button{font:inherit;font-weight:600;padding:11px;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}
.err{color:var(--bad);background:var(--crit-bg);padding:9px 12px;border-radius:10px;margin:0 0 14px}
@media (max-width:1000px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.grid2{grid-template-columns:1fr}.hero{grid-template-columns:1fr}.hero .left{border-right:0;border-bottom:1px solid var(--ring)}}
@media (max-width:520px){.wide{display:none}.narrow{display:block}.big{font-size:44px}.towns{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.tvalue{font-size:22px}.tile .spark{display:none}.tile{padding:12px}.bar .meta{display:none}.src{grid-template-columns:84px 1fr 40px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
@media (forced-colors:active){.chart .ln{stroke:CanvasText}.dot,.track i,.ibar .col i{forced-color-adjust:none}}
`;

function page(title, body, { refresh = false } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex">${refresh ? '<meta http-equiv="refresh" content="300">' : ''}` +
    `<meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

export function renderLogin(error = '') {
  return page('HQ · Log in', `<main class="login"><div class="card"><div class="logo" aria-hidden="true">HQ</div>` +
    `<h2>HQ</h2><p>Every town on one screen.</p>` +
    (error ? `<p class="err bad" role="alert">${esc(error)}</p>` : '') +
    `<form method="post" action="/login"><input name="username" autocomplete="username" placeholder="Username" aria-label="Username" required>` +
    `<input name="password" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password" required><button>Log in</button></form></div></main>`);
}

function townCard(r, now) {
  if (r.error) {
    return `<article class="card pad town-card ${townClass(r)}"><div class="tc-head"><div class="tc-name"><h2>${dot(r)}${esc(r.slug)}</h2>` +
      `<a class="host" href="${esc(r.siteUrl)}">${esc(r.siteUrl.replace(/^https:\/\//, ''))}</a></div>${healthChip(r)}</div>` +
      `<div class="down"><p class="meta">HQ couldn't read this town just now. Its own admin may still work.</p>` +
      `<div><a class="btn" href="${esc(r.siteUrl)}/admin.html">Open admin →</a></div></div></article>`;
  }
  const revChange = changePct(r.revenueCents, r.lastMonthCents);
  const sg = r.subGoal;
  const eta = sg && sg.eta ? `on pace for ${shortDay(sg.eta)}${sg.perWeek ? ` · ${signed(sg.perWeek)}/wk` : ''}` : sg && sg.perWeek ? `${signed(sg.perWeek)}/wk` : '';
  return `<article class="card pad town-card ${townClass(r)}">` +
    `<div class="tc-head"><div class="tc-name"><h2>${dot(r)}${esc(r.name || r.slug)}</h2>` +
    `<a class="host" href="${esc(r.siteUrl)}">${esc(r.siteUrl.replace(/^https:\/\//, ''))}</a></div>` +
    `<a class="btn" href="${esc(r.adminUrl)}">Admin →</a></div>` +
    `<div>${healthChip(r)}${r.recommendedMissing ? ` <span class="chip warn" title="Recommended settings not set">${r.recommendedMissing} to set up</span>` : ''}</div>` +
    `<div class="stats">` +
    `<div class="stat"><span>Subscribers</span><b>${num(r.subscribers)}</b>${delta(r.net7, { suffix: ' 7d' })}</div>` +
    `<div class="stat"><span>Revenue (month)</span><b>${money(r.revenueCents)}</b>${revChange === null ? '<span class="delta">—</span>' : delta(revChange, { suffix: '% vs last', fmt: n => `${Math.abs(n)}` })}</div>` +
    `<div class="stat"><span>Open rate</span><b>${pct(r.openRate)}</b><span class="delta">${Number.isFinite(r.clickRate) ? `${pct(r.clickRate)} clicked` : '—'}</span></div>` +
    `</div>` +
    `<div class="sec"><div class="sec-t"><span>Subscribers, 30 days</span><span>${signed(r.net30)} net</span></div>` +
    `${lineChart(r.daily, { w: 420, h: 140, id: `t${r.slug}` })}</div>` +
    `<div class="sec"><div class="sec-t"><span>Open rate, last issues</span></div>${issueBars(r.issues)}</div>` +
    (r.weeks.length ? `<div class="sec"><div class="sec-t"><span>Sponsor weeks</span><span>${num(r.bookedWeeks)} of ${r.weeks.length} booked</span></div>${weekSlots(r.weeks)}</div>` : '') +
    `<div class="goalrow">${sg ? meter(r.subscribers, sg.goal, { label: 'Subscriber goal' }) : ''}${meter(r.revenueCents, r.revenueGoalCents, { label: 'Revenue goal', fmt: moneyShort })}</div>` +
    (eta ? `<div class="meta">${esc(eta)}</div>` : '') +
    `<div class="tc-foot"><span>Picks <b>${num(r.picks)}</b></span><span>Waiting <b>${num(r.waiting)}</b></span><span>Upcoming <b>${num(r.upcoming)}</b></span>` +
    `<span>Collected <b>${esc(ago(r.lastCollect, now))}</b></span><span>Published <b>${esc(ago(r.publishedAt, now))}</b></span>` +
    (r.commit ? `<span>Build <code>${esc(r.commit)}</code></span>` : '') + `</div></article>`;
}

const weeksOf = (booked, open) => (Number.isFinite(booked) && Number.isFinite(open) ? `${num(booked)}/${num(booked + open)}` : '—');

function townTable(rows, t) {
  const maxSubs = Math.max(1, ...rows.map(r => (Number.isFinite(r.subscribers) ? r.subscribers : 0)));
  const body = rows.map(r => r.error
    ? `<tr><td class="town">${dot(r)}<a href="${esc(r.siteUrl)}/admin.html">${esc(r.slug)}</a></td><td colspan="10" class="hl">${healthChip(r)}</td></tr>`
    : `<tr><td class="town">${dot(r)}<a href="${esc(r.adminUrl)}">${esc(r.name || r.slug)}</a></td>` +
      `<td><span class="inl"><i style="width:${Math.round((r.subscribers || 0) / maxSubs * 60)}px"></i>${num(r.subscribers)}</span></td>` +
      `<td>${signed(r.net7)}</td><td>${signed(r.net30)}</td><td>${pct(r.openRate)}</td><td>${pct(r.clickRate)}</td>` +
      `<td>${money(r.revenueCents)}</td><td>${weeksOf(r.bookedWeeks, r.openWeeks)}</td>` +
      `<td>${num(r.picks)}</td><td>${num(r.waiting)}</td><td class="hl">${healthChip(r)}</td></tr>`).join('');
  const foot = rows.length > 1
    ? `<tfoot><tr><td>All towns</td><td>${num(t.subscribers)}</td><td>${signed(t.net7)}</td><td>${signed(t.net30)}</td><td>${pct(t.openRate)}</td>` +
      `<td>${pct(t.clickRate)}</td><td>${money(t.revenueCents)}</td><td>${weeksOf(t.bookedWeeks, t.openWeeks)}</td>` +
      `<td>${num(t.picks)}</td><td>${num(t.waiting)}</td><td class="hl"></td></tr></tfoot>` : '';
  return `<div class="card tablewrap"><table><thead><tr><th>Town</th><th>Subscribers</th><th>7-day net</th><th>30-day net</th><th>Open rate</th>` +
    `<th>Click rate</th><th>Revenue (month)</th><th>Sponsor weeks</th><th>Picks</th><th>Waiting</th><th>Health</th></tr></thead>` +
    `<tbody>${body}</tbody>${foot}</table></div>`;
}

export function renderDashboard(rows, now) {
  const t = totalsOf(rows);
  const up = rows.filter(r => !r.error);
  const when = now.toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const status = t.attention
    ? `<span class="chip warn"><span aria-hidden="true">!</span> ${t.attention} need${t.attention === 1 ? 's' : ''} attention${t.down ? ` · ${t.down} not answering` : ''}</span>`
    : '<span class="chip ok"><span aria-hidden="true">✓</span> All towns healthy</span>';
  const revChange = changePct(t.revenueCents, t.lastMonthCents);
  const monthTotals = t.months.map(m => m.towns.reduce((a, x) => a + x.cents, 0));
  const slotsTotal = Number.isFinite(t.bookedWeeks) && Number.isFinite(t.openWeeks) ? t.bookedWeeks + t.openWeeks : null;

  const tiles = [
    tile('Revenue this month', money(t.revenueCents), {
      sub: revChange === null ? `<span>${money(t.lastMonthCents)} last month</span>` : `${delta(revChange, { suffix: '% vs last month', fmt: n => `${Math.abs(n)}` })}`,
      trend: sparkline(monthTotals) }),
    tile('Recurring (partners)', money(t.recurringCents), { sub: '<span>monthly, in this month</span>' }),
    tile('Latest open rate', pct(t.openRate), { sub: `<span>${Number.isFinite(t.clickRate) ? `${pct(t.clickRate)} clicked through` : 'no issue yet'}</span>` }),
    tile('Ad spend, 30 days', t.adSpend === null ? '—' : `$${t.adSpend.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
      { sub: `<span>${t.costPerSub === null ? 'no paid sign-ups yet' : `$${t.costPerSub.toFixed(2)} per subscriber`}</span>` }),
    tile('Sponsor weeks, next 4', slotsTotal ? `${num(t.bookedWeeks)} / ${num(slotsTotal)}` : '—', { sub: `<span>${Number.isFinite(t.openWeeks) ? `${num(t.openWeeks)} open to sell` : 'not reported'}</span>` }),
    tile('Picks sold this month', num(t.picks), { sub: '<span>paid Local Picks</span>' }),
    tile('Submissions waiting', num(t.waiting), { sub: `<span>${t.waiting ? 'to review in each admin' : t.waiting === 0 ? 'all caught up' : 'not reported'}</span>`, tone: t.waiting ? 'attn' : '' }),
    tile('Upcoming events', num(t.upcoming), { sub: `<span>published across ${up.length} town${up.length === 1 ? '' : 's'}</span>` })
  ].join('');

  const legend = up.length > 1 ? `<div class="legend">${up.map(r => `<span>${dot(r)}${esc(r.name || r.slug)}</span>`).join('')}</div>` : '';
  const maxSrc = Math.max(1, ...t.sources.map(([, v]) => v));
  const sources = t.sources.length
    ? `<div class="sources">${t.sources.map(([k, v]) => `<div class="src"><span class="l">${esc(k)}</span>` +
      `<span><span class="b" style="display:block;width:${(v / maxSrc * 100).toFixed(1)}%"></span></span><span class="n">${num(v)}</span></div>`).join('')}</div>`
    : '<p class="empty">No sign-ups in the last 30 days.</p>';

  const body =
    `<header class="top"><div class="bar"><a class="brand" href="/"><span class="logo" aria-hidden="true">HQ</span>Network HQ</a>${status}` +
    `<span class="spacer"></span><span class="meta">${t.towns} town${t.towns === 1 ? '' : 's'} · updated ${esc(when)} CT</span>` +
    `<a class="btn" href="/">Refresh</a><a class="btn" href="/logout">Log out</a></div></header>` +
    `<main class="shell">` +
    `<h1>Network</h1>` +
    `<section class="card hero"><div class="left"><div class="big"><small>Active subscribers</small>${num(t.subscribers)}</div>` +
    `<div class="row">${delta(t.net7, { suffix: ' this week' })}${delta(t.net30, { suffix: ' in 30 days' })}</div>` +
    `<div class="row"><div class="kv"><span>Joined (30d)</span><b>${num(t.joined30)}</b></div><div class="kv"><span>Left (30d)</span><b>${num(t.left30)}</b></div>` +
    `<div class="kv"><span>Pending</span><b>${num(t.pending)}</b></div></div>` +
    `${meter(t.subscribers, t.subGoal, { label: 'Network subscriber goal' })}</div>` +
    `<div class="right"><div class="hd2"><h2>Subscribers, last 30 days</h2><span class="meta">all towns</span></div><div class="wide">${lineChart(t.daily, { id: 'net' })}</div><div class="narrow">${lineChart(t.daily, { id: 'netn', w: 360, h: 200 })}</div></div></section>` +
    `<div class="tiles">${tiles}</div>` +
    `<div class="grid2"><section class="card pad"><div class="hd2"><h2>Revenue by month</h2>${legend || '<span class="meta">last six months</span>'}</div>` +
    `<div class="wide">${revenueColumns(t.months)}</div><div class="narrow">${revenueColumns(t.months, { w: 360, h: 220 })}</div></section>` +
    `<section class="card pad"><div class="hd2"><h2>Where subscribers came from</h2><span class="meta">last 30 days</span></div>${sources}</section></div>` +
    `<h1>Towns</h1>${townTable(rows, t)}` +
    `<div class="towns" style="margin-top:12px">${rows.map(r => townCard(r, now)).join('')}</div>` +
    `</main>`;
  return page('HQ', body, { refresh: true });
}
