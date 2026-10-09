/* server/referralRewards.js — Referral rewards, sent as digital gift cards.
 *
 *   - Tiers (REFERRAL_TIERS): every friend a reader brings in is an entry in
 *     that month's drawing; reaching 5 and 10 friends earns a gift card.
 *   - Monday's send (registerNewsletter → rewards.run) records each tier a
 *     reader newly reached and, once a month, draws the previous month's
 *     winner. Each reward is one referral_rewards row with a unique key
 *     (tier:<code>:<n>, draw:<YYYY-MM>), so nothing is created twice.
 *   - Rewards go out through Tremendous (TREMENDOUS_API_KEY and
 *     TREMENDOUS_CAMPAIGN_ID; the campaign in the Tremendous dashboard sets
 *     which gift cards the reader can pick and the email's branding). The
 *     order's external_id is the row key, so a retry never pays twice:
 *     Tremendous answers a repeat with the existing order.
 *   - A reward whose friends look made up (referralFlags) is held until
 *     the owner approves it in the admin. Without Tremendous set up, rewards
 *     are listed for the owner to send by hand ('manual').
 *   - Slack: one "🎁 Referral rewards" note per run, and an alert when a
 *     send fails (it's retried every Monday until it goes through).
 */
import { town } from './town.js';
import crypto from 'node:crypto';
import { emailKey, REF_HOLD_HOURS } from './db.js';

export const DRAWING_AMOUNT = 25;
export const REFERRAL_TIERS = [
  { n: 1, reward: `an entry in our monthly $${DRAWING_AMOUNT} gift card drawing`, drawing: true },
  { n: 5, reward: 'a $10 gift card', amount: 10 },
  { n: 10, reward: 'a $25 gift card', amount: 25 }
];

const TREMENDOUS_API = { live: 'https://api.tremendous.com/api/v2', sandbox: 'https://testflight.tremendous.com/api/v2' };
const TREMENDOUS_TIMEOUT_MS = 15000;
const STALE_MS = 10 * 60 * 1000;

export function tremendousConfig(env = process.env, opts = {}) {
  const apiKey = opts.tremendousApiKey ?? env.TREMENDOUS_API_KEY ?? '';
  const campaignId = opts.tremendousCampaignId ?? env.TREMENDOUS_CAMPAIGN_ID ?? '';
  return {
    apiKey, campaignId,
    // Test keys start TEST_ and only work on the sandbox.
    sandbox: /^TEST_/.test(apiKey) || env.TREMENDOUS_SANDBOX === '1',
    fundingSource: env.TREMENDOUS_FUNDING_SOURCE || 'BALANCE',
    enabled: Boolean(apiKey && campaignId)
  };
}

export function createTremendous(config, fetchImpl = globalThis.fetch) {
  const base = config.sandbox ? TREMENDOUS_API.sandbox : TREMENDOUS_API.live;
  return {
    enabled: config.enabled,
    // One gift card by email. Returns { orderId, status }.
    async sendReward({ externalId, amount, email, name, message }) {
      const res = await fetchImpl(`${base}/orders`, {
        method: 'POST',
        signal: AbortSignal.timeout(TREMENDOUS_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          external_id: externalId,
          payment: { funding_source_id: config.fundingSource },
          reward: {
            campaign_id: config.campaignId,
            value: { denomination: amount, currency_code: 'USD' },
            recipient: { name, email },
            delivery: { method: 'EMAIL', meta: { sender_name: town.siteName, message } }
          }
        })
      });
      let json = null;
      try { json = await res.json(); } catch { /* empty body */ }
      if (!res.ok) {
        const detail = json && (json.errors ? JSON.stringify(json.errors) : JSON.stringify(json));
        const err = new Error(res.status === 402
          ? 'Not enough money in the Tremendous balance. Add funds, then approve it again or wait for Monday.'
          : `Tremendous HTTP ${res.status}: ${String(detail).slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      const order = (json && json.order) || {};
      return { orderId: order.id || null, status: order.status || null };
    }
  };
}

// Signs a referrer's friends may be made up. The reward is held for the
// owner's OK, not refused: a real group chat can look like this too.
// friends: listReferredFriends rows for one referrer.
const BIG_PROVIDERS = new Set(['gmail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'att.net', 'sbcglobal.net', 'comcast.net', 'proton.me', 'protonmail.com']);
const THROWAWAY_DOMAINS = new Set(['mailinator.com', 'guerrillamail.com', 'sharklasers.com', 'yopmail.com', '10minutemail.com',
  'temp-mail.org', 'tempmail.com', 'trashmail.com', 'getnada.com', 'maildrop.cc', 'dispostable.com', 'mailnesia.com',
  'throwawaymail.com', 'fakeinbox.com', 'emailondeck.com', 'mohmal.com', 'tempmail.plus', 'mail.tm']);
export function referralFlags(friends) {
  const flags = [];
  const domainOf = (e) => String(e).toLowerCase().split('@').pop();
  const throwaway = friends.filter(f => THROWAWAY_DOMAINS.has(domainOf(f.email))).length;
  if (throwaway) flags.push(`${throwaway} at a throwaway-inbox site`);
  const times = friends.map(f => new Date(f.confirmed_at || NaN).getTime()).filter(Number.isFinite).sort((a, b) => a - b);
  let burst = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[i] - times[j] > 10 * 60e3) j++;
    burst = Math.max(burst, i - j + 1);
  }
  if (burst >= 3) flags.push(`${burst} joined within 10 minutes`);
  const tally = (key) => {
    const n = new Map();
    for (const f of friends) { const k = key(f.email); if (k) n.set(k, (n.get(k) || 0) + 1); }
    return [...n].sort((a, b) => b[1] - a[1])[0] || [null, 0];
  };
  const [domain, sameDomain] = tally(e => { const d = domainOf(e); return BIG_PROVIDERS.has(d) || THROWAWAY_DOMAINS.has(d) ? null : d; });
  if (sameDomain >= 3) flags.push(`${sameDomain} at ${domain}`);
  // sam1@, sam2@, sam.3@: the same name with a number on it.
  const [stem, lookalike] = tally(e => emailKey(e).split('@')[0].replace(/[^a-z]/g, '') || null);
  if (lookalike >= 3) flags.push(`${lookalike} addresses like "${stem}"`);
  return flags;
}

// The month whose drawing is due on `today` (Central YYYY-MM-DD): last
// month, from the 2nd on, so a friend who joined late on the 31st has
// cleared the 24-hour hold.
export function drawingMonth(today) {
  const [y, m, d] = today.split('-').map(Number);
  if (d < 2) return null;
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

// { code: { email, keys: Set } } of the month's entries: each friend who
// joined (confirmed) that month, still subscribed and past the hold, is one
// entry for the active subscriber who referred them; one inbox counts once.
export function drawingEntries(friends, month, { now, localDate }) {
  const cutoff = now - REF_HOLD_HOURS * 3600e3;
  const out = {};
  // One inbox is one entry in all: the earliest referral of it gets it,
  // even if a later one came through another code (see tallyReferrals).
  const claimed = new Set();
  const when = f => (f.confirmed_at ? new Date(f.confirmed_at).getTime() : Infinity);
  for (const f of [...friends].sort((a, b) => when(a) - when(b))) {
    if (!f.confirmed_at) continue;
    const key = emailKey(f.email);
    if (f.referrer_email && emailKey(f.referrer_email) === key) continue;
    if (claimed.has(key)) continue;
    claimed.add(key);
    if (!f.referrer_active) continue;
    const at = new Date(f.confirmed_at).getTime();
    if (!(at <= cutoff) || localDate(new Date(at)).slice(0, 7) !== month) continue;
    const e = out[f.referred_by] || (out[f.referred_by] = { email: f.referrer_email, keys: new Set(), friends: [] });
    e.keys.add(key); e.friends.push(f);
  }
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (ym) => MONTHS[Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(0, 4);

export function createReferralRewards({ store, slack = null, tremendous, nowFn = () => new Date(), localDate, randomInt = crypto.randomInt }) {
  const supported = typeof store.addReferralReward === 'function';

  function describe(row) {
    return row.kind === 'drawing'
      ? `$${row.amount} gift card: won the ${monthName(row.month)} drawing (${row.entries} of ${row.total_entries} entries)`
      : `$${row.amount} gift card for reaching ${row.tier} friends`;
  }

  // Sends one pending (or failed, or approved) reward and records the
  // result. Only the record can throw: if it does after Tremendous took
  // the order, the row stays 'pending' and a later run (or the admin)
  // sends it again, which Tremendous answers with the same order.
  async function deliver(row) {
    if (!tremendous || !tremendous.enabled) {
      return store.updateReferralReward(row.id, { status: 'manual', reason: 'Tremendous isn\'t set up: send it by hand.' });
    }
    let patch;
    try {
      const message = row.kind === 'drawing'
        ? `You won ${town.siteName}'s ${monthName(row.month)} referral drawing! Thanks for sharing the newsletter with your friends.`
        : `Thanks for sharing ${town.siteName}! You've brought in ${row.tier} friends, so here's a $${row.amount} gift card on us.`;
      const r = await tremendous.sendReward({
        externalId: `vic361-${row.key.replace(/:/g, '-')}`, amount: row.amount,
        email: row.email, name: row.email.split('@')[0], message
      });
      patch = /^(FAILED|CANCELED)$/.test(r.status || '')
        ? { status: 'failed', order_id: r.orderId, reason: `Tremendous order ${r.status}. Check it in Tremendous, then send it another way and Skip it here.` }
        : { status: 'sent', order_id: r.orderId, reason: r.status && r.status !== 'EXECUTED' ? `Tremendous order ${r.status}` : null };
    } catch (err) {
      console.warn('[referrals] reward send failed:', err.message);
      patch = { status: 'failed', reason: err.message };
    }
    return store.updateReferralReward(row.id, patch);
  }

  // null when the read fails: callers must not treat that as "no friends"
  // (that would skip the made-up-friends check and pay automatically).
  async function friendsOf(codes) {
    if (typeof store.listReferredFriends !== 'function') return [];
    try {
      return await store.listReferredFriends(codes);
    } catch (err) {
      console.warn('[referrals] reading friends failed:', err.message);
      return null;
    }
  }

  // Every reward so far (null when it can't be read), to spot one inbox
  // collecting under several addresses (owner+1@, owner+2@ ...).
  async function rewardsSoFar() {
    try { return await store.listReferralRewards({ limit: 5000 }); } catch (err) {
      console.warn('[referrals] reading earlier rewards failed:', err.message);
      return null;
    }
  }
  function sameInboxFlag(email, code, earlier) {
    if (!earlier) return 'couldn\'t check earlier rewards';
    const key = emailKey(email);
    return earlier.some(r => r.ref_code !== code && r.status !== 'skipped' && emailKey(r.email) === key)
      ? 'another address of this inbox already earned referral rewards' : null;
  }

  // Gift cards for each tier newly reached. counts: { code: counted friends }.
  // A code's ref_tier goes up only once its reward rows exist, so a failure
  // in between leaves the tier due for next time (the row key stops a
  // second row).
  async function tierRewards(counts) {
    const earned = Object.entries(counts).filter(([, n]) => n >= REFERRAL_TIERS[0].n);
    if (!earned.length || typeof store.listRefTiers !== 'function') return [];
    const known = await store.listRefTiers(earned.map(([c]) => c));
    const due = [];
    for (const [code, n] of earned) {
      const reached = REFERRAL_TIERS.filter(t => t.n <= n).pop();
      const k = known[code];
      if (!k || !reached || k.ref_tier >= reached.n) continue;
      // Every tier crossed since last time (someone can jump from 1 to 5).
      due.push({ code, email: k.email, reached: reached.n, tiers: REFERRAL_TIERS.filter(t => t.n > k.ref_tier && t.n <= n && t.amount) });
    }
    if (!due.length) return [];
    const withCards = due.filter(d => d.tiers.length);
    const friends = withCards.length ? await friendsOf(withCards.map(d => d.code)) : [];
    const earlier = withCards.length ? await rewardsSoFar() : [];
    const rows = [];
    for (const d of due) {
      const flags = friends ? referralFlags(friends.filter(f => f.referred_by === d.code)) : ['couldn\'t check this reader\'s friends'];
      const twin = sameInboxFlag(d.email, d.code, earlier ? [...earlier, ...rows] : null);
      if (twin) flags.push(twin);
      for (const t of d.tiers) {
        const row = await store.addReferralReward({ key: `tier:${d.code}:${t.n}`, kind: 'tier', ref_code: d.code, email: d.email,
          tier: t.n, amount: t.amount, status: flags.length ? 'held' : 'pending', flags: flags.join('; ') || null });
        if (row) rows.push(row);
      }
      await store.setRefTier(d.code, d.reached);
    }
    return rows;
  }

  // Last month's drawing, once: a random entry wins.
  async function drawing(now) {
    const month = drawingMonth(localDate(now));
    if (!month) return null;
    const friends = await friendsOf(null);
    if (!friends) return null; // tried again next Monday
    const entries = drawingEntries(friends, month, { now: now.getTime(), localDate });
    const codes = Object.keys(entries).sort();
    const total = codes.reduce((n, c) => n + entries[c].keys.size, 0);
    if (!total) return null;
    let pick = randomInt(total), code = codes[0];
    for (const c of codes) {
      if (pick < entries[c].keys.size) { code = c; break; }
      pick -= entries[c].keys.size;
    }
    const flags = referralFlags(entries[code].friends);
    const twin = sameInboxFlag(entries[code].email, code, await rewardsSoFar());
    if (twin) flags.push(twin);
    return store.addReferralReward({ key: `draw:${month}`, kind: 'drawing', ref_code: code, email: entries[code].email, month,
      amount: DRAWING_AMOUNT, entries: entries[code].keys.size, total_entries: total,
      status: flags.length ? 'held' : 'pending', flags: flags.join('; ') || null });
  }

  // A 'pending' row nobody has touched for a while was left by a crash or
  // restart mid-send: safe to send again (same Tremendous external_id).
  const stale = (row, now) => row.status === 'pending' && now - new Date(row.updated_at).getTime() > STALE_MS;

  function line(row, friends = []) {
    const what = describe(row);
    if (row.status === 'sent') return `${what}. Sent ✅`;
    if (row.status === 'manual') return `${what}. Send it by hand (Tremendous isn't set up).`;
    if (row.status === 'failed') return `${what}. Failed: ${row.reason} It's retried every Monday.`;
    if (row.status === 'held') {
      const mine = (friends || []).filter(f => f.referred_by === row.ref_code);
      const list = mine.slice(0, 12).map(f => f.email).join(', ') + (mine.length > 12 ? ` and ${mine.length - 12} more` : '');
      return `${what}.\n👀 Held for your OK (Admin → Newsletter → Referral rewards): ${row.flags}.\nFriends: ${list}`;
    }
    return what;
  }

  return {
    // Monday's run (after the newsletter has gone out): new tier rewards,
    // last month's drawing, and retries of earlier failures and of rows a
    // crash left half-sent; then one Slack note about all of it. Never throws.
    async run(counts) {
      if (!supported) return [];
      try {
        const fresh = [...await tierRewards(counts)];
        const won = await drawing(nowFn());
        if (won) fresh.push(won);
        const now = nowFn().getTime();
        const retry = (await store.listReferralRewards({ statuses: ['failed', 'pending'], limit: 50 }))
          .filter(r => r.status === 'failed' || stale(r, now));
        const done = [];
        for (const row of [...fresh, ...retry.filter(r => !fresh.some(f => f.id === r.id))]) {
          // One reward's trouble doesn't stop the rest.
          try {
            done.push(row.status === 'held' ? row : await deliver(row));
          } catch (err) {
            console.error('[referrals] recording a reward failed:', err.message);
            done.push({ ...row, status: 'failed', reason: `Couldn't record it (${err.message}); it's tried again next Monday.` });
          }
        }
        if (done.length && slack) {
          const held = done.filter(r => r.status === 'held');
          const friends = held.length ? await friendsOf([...new Set(held.map(r => r.ref_code))]) : [];
          // Slack shows 10 fields: the ones that need the owner first, and
          // a pointer to the admin for the rest.
          const order = { held: 0, failed: 1, manual: 2 };
          const sorted = [...done].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));
          const fields = sorted.slice(0, sorted.length > 10 ? 9 : 10).map(r => [r.email, line(r, friends)]);
          if (sorted.length > 10) fields.push(['…', `and ${sorted.length - 9} more in Admin → Newsletter → Referral rewards`]);
          slack.notify({ title: '🎁 Referral rewards', fields });
          const failed = done.filter(r => r.status === 'failed');
          if (failed.length) slack.alert('referral-reward-failed', 'A referral gift card didn\'t send', failed[0].reason);
        }
        return done;
      } catch (err) {
        console.error('[referrals] rewards run failed:', err.message);
        if (slack) slack.alert('referral-rewards-run-failed', 'Referral rewards didn\'t run this week', `${err.message}\nThey're tried again next Monday.`);
        return [];
      }
    },

    // Admin: send a held, failed, by-hand or stuck reward now (or, without
    // Tremendous, mark it sent by hand).
    async approve(id) {
      const row = await store.getReferralReward(id);
      if (!row) return { ok: false, status: 404, message: 'No such reward.' };
      if (!(['held', 'failed', 'manual'].includes(row.status) || stale(row, nowFn().getTime()))) {
        return { ok: false, status: 409, message: `It's already ${row.status}.` };
      }
      // Without Tremendous, "Mark sent" records that the owner sent it.
      const out = tremendous && tremendous.enabled ? await deliver(row)
        : await store.updateReferralReward(id, { status: 'sent', reason: 'Sent by hand' });
      return { ok: out.status === 'sent', status: out.status === 'sent' ? 200 : 502, reward: out,
        message: out.status === 'sent' ? 'Sent.' : out.reason };
    },

    // Admin: don't send this one (or it was sent another way).
    async skip(id) {
      const row = await store.getReferralReward(id);
      if (!row) return { ok: false, status: 404, message: 'No such reward.' };
      if (row.status === 'sent') return { ok: false, status: 409, message: 'It was already sent.' };
      return { ok: true, status: 200, reward: await store.updateReferralReward(id, { status: 'skipped' }) };
    },

    // The admin list: everything that needs the owner (held, failed, by
    // hand, stuck), however old, plus the latest others.
    async list(limit = 20) {
      if (!supported) return [];
      const open = await store.listReferralRewards({ statuses: ['held', 'failed', 'manual', 'pending'], limit: 500 });
      const recent = await store.listReferralRewards({ limit });
      const seen = new Set();
      return [...open, ...recent].filter(r => !seen.has(r.id) && seen.add(r.id))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    },
    describe
  };
}
