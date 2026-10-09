/* server/scheduler.js — The always-on Railway server is the clock.
 *
 * GitHub's cron runs hours late on this repo (Monday's 12:43 UTC newsletter
 * ran at 20:47; the 13:47 social kit at 21:13; "hourly" uptime every 3–6h),
 * so the time-critical jobs are started from here instead, in Central time
 * (Intl does the DST switch):
 *
 *   event-check        Mon 6:43 AM   dispatch event-check.yml (before the send)
 *   event-check-weekend Thu 6:00 AM  the same, before the weekend issue
 *   newsletter         Mon 7:43 AM   sendWeekly() in-process; retried on failure
 *   newsletter-weekend Thu 7:00 AM   the weekend issue (Friday–Sunday), same way
 *   meta-ads           daily 8:37 AM dispatch meta-ads.yml (scheduled=true)
 *   social-kit         daily 8:47 AM dispatch social-kit.yml (scheduled=true)
 *   sponsor-reports    daily 9:00 AM sponsors.sendSponsorReports(now), if it exists
 *   submission-review  every 15 min  dispatch submission-review.yml
 *   health             hourly        retry a missed boot auto-publish, then check the
 *                                    database, upcoming events, collector freshness
 *
 * Each daily/weekly job runs once per slot (its Central date). The claim is
 * a row in the store (scheduler_runs), taken atomically, so a restart or the
 * old and new containers overlapping during a deploy can't fire it twice.
 * A job missed while the server was down still runs later the same day
 * (until `until`). The 15-minute and hourly jobs are harmless to repeat and
 * only tracked in memory.
 *
 * The GitHub crons stay as late fallbacks: each lists its slot at both the
 * CDT and the CST UTC time, keeps only the one matching today's offset (so
 * it never asks before the slot, when lastSlot() still means yesterday),
 * then asks GET /api/scheduler/ran and skips itself when the site already
 * ran that slot (submission review is idempotent anyway).
 *
 * Production only (RAILWAY_ENVIRONMENT_NAME=production); SCHEDULER=0 turns it
 * off. Dispatching needs GITHUB_TOKEN with Actions: write; without a token
 * the dispatch jobs are left to GitHub's cron, and a token GitHub refuses
 * (401/403) gets one Slack alert a week and a setup-checklist warning.
 */

const TZ = 'America/Chicago';
const MIN = 60 * 1000;

// Central wall-clock parts of an instant.
export function centralParts(now) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short'
  }).formatToParts(now)) parts[p.type] = p.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    dow,
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

const hm = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const pad = n => String(n).padStart(2, '0');
function prevDate(ymd, days) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
const dowOf = ymd => new Date(ymd + 'T12:00:00Z').getUTCDay();

export const JOBS = [
  { name: 'event-check', dow: 1, at: '06:43', until: '12:00', workflow: 'event-check.yml' },
  // And before Thursday's weekend issue.
  { name: 'event-check-weekend', dow: 4, at: '06:00', until: '12:00', workflow: 'event-check.yml' },
  // Until noon: a deploy or restart later in the day mustn't send an issue
  // at night (the GitHub fallback still covers a missed morning).
  { name: 'newsletter', dow: 1, at: '07:43', until: '12:00', retryMins: [5, 15, 30] },
  // The weekend issue (Friday–Sunday), Thursday mornings.
  { name: 'newsletter-weekend', dow: 4, at: '07:00', until: '12:00', retryMins: [5, 15, 30] },
  { name: 'meta-ads', at: '08:37', until: '18:00', workflow: 'meta-ads.yml', inputs: { scheduled: 'true' } },
  { name: 'social-kit', at: '08:47', until: '18:00', workflow: 'social-kit.yml', inputs: { scheduled: 'true' } },
  { name: 'sponsor-reports', at: '09:00', until: '23:59' },
  { name: 'submission-review', every: 15, workflow: 'submission-review.yml' },
  { name: 'health', every: 60 }
];

// The slot a job is due in right now, or null when it isn't due.
export function dueSlot(job, now) {
  const c = centralParts(now);
  if (job.every) {
    const n = Math.floor(c.minutes / job.every) * job.every;
    return `${c.date}T${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
  }
  if (job.dow != null && c.dow !== job.dow) return null;
  if (c.minutes < hm(job.at) || c.minutes > hm(job.until)) return null;
  return c.date;
}

// The most recent slot a daily/weekly job should have run in (today once
// its time has passed, else the previous matching day). For the fallback
// crons' "did the site already do this?" question.
export function lastSlot(job, now) {
  const c = centralParts(now);
  for (let i = 0; i <= 7; i++) {
    const d = prevDate(c.date, i);
    if (job.dow != null && dowOf(d) !== job.dow) continue;
    if (i === 0 && c.minutes < hm(job.at)) continue;
    return d;
  }
  return null;
}

export function schedulerEnabled(env = process.env) {
  return env.RAILWAY_ENVIRONMENT_NAME === 'production' && env.SCHEDULER !== '0';
}

/**
 * handlers: { newsletter(), sponsorReports(now), health(now) }, each async.
 *   newsletter() → { ok, error?, retry?, message? } (see index.js)
 *   sponsorReports / health may be missing: the job is then skipped.
 */
export function createScheduler({ store, github, slack = null, nowFn = () => new Date(), handlers = {}, siteUrl = '', jobs = JOBS, log = console }) {
  const memory = new Map(); // job → last in-memory slot
  const busy = new Set();
  const state = { dispatchBlocked: null, lastTick: null };
  let timer = null;

  const persisted = job => !job.every;

  // Something the owner must fix: GitHub refused the token. Once a week
  // (persisted, so restarts don't repeat it), plus the setup checklist.
  async function dispatchRefused(err, now) {
    state.dispatchBlocked = { status: err.status, message: err.detail || err.message, at: now.toISOString() };
    const week = lastSlot({ dow: 1, at: '00:00' }, now);
    let first = true;
    try {
      first = (await store.claimJobRun('alert:dispatch-refused', week, now)).claimed;
      if (first) await store.finishJobRun('alert:dispatch-refused', week, { status: 'done', detail: String(err.status) });
    } catch { /* alert anyway */ }
    if (first && slack) {
      slack.alert('scheduler-dispatch', "The site can't start GitHub workflows on time",
        `GitHub answered ${err.status}: ${err.detail || err.message}. Social posts, the event check, the ads report and the AI submission review fall back to GitHub's own schedule, which runs hours late. ` +
        'Fix: give GITHUB_TOKEN in Railway Actions: write on this repo (fine-grained token).', `${siteUrl}/admin.html`);
    }
  }

  async function dispatch(job, now) {
    try {
      await github.dispatchWorkflow(job.workflow, github.branch, job.inputs);
      state.dispatchBlocked = null;
      return { ok: true };
    } catch (err) {
      if ([401, 403, 404, 422].includes(err.status)) {
        await dispatchRefused(err, now);
        return { ok: false, final: true, message: err.message };
      }
      return { ok: false, message: err.message };
    }
  }

  // Run one job's body. → { ok, final?, message? }
  async function runJob(job, now) {
    if (job.workflow) return dispatch(job, now);
    const fn = { newsletter: handlers.newsletter, 'newsletter-weekend': handlers.newsletterWeekend, 'sponsor-reports': handlers.sponsorReports, health: handlers.health }[job.name];
    try {
      const out = await fn(now);
      return out && typeof out === 'object' && 'ok' in out ? out : { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  // Whether a job can run at all here; otherwise it isn't claimed, so a
  // fallback (GitHub's cron) still does it.
  function available(job) {
    if (job.workflow) return Boolean(github && github.isConfigured());
    if (job.name === 'newsletter') return typeof handlers.newsletter === 'function' && (!handlers.newsletterReady || handlers.newsletterReady());
    if (job.name === 'newsletter-weekend') return typeof handlers.newsletterWeekend === 'function' && (!handlers.newsletterWeekendReady || handlers.newsletterWeekendReady());
    if (job.name === 'sponsor-reports') return typeof handlers.sponsorReports === 'function';
    if (job.name === 'health') return typeof handlers.health === 'function';
    return false;
  }

  async function runPersisted(job, slot, now) {
    const claim = await store.claimJobRun(job.name, slot, now);
    if (!claim.claimed) return null;
    const out = await runJob(job, now);
    const attempts = claim.attempts || 1;
    const retries = job.retryMins || (job.workflow ? [2, 5] : []);
    let status = out.ok ? 'done' : 'failed';
    let retryAt = null;
    if (!out.ok && !out.final && attempts <= retries.length) {
      status = 'retry';
      retryAt = new Date(now.getTime() + retries[attempts - 1] * MIN).toISOString();
    }
    await store.finishJobRun(job.name, slot, { status, retry_at: retryAt, detail: String(out.message || out.error || '').slice(0, 500) });
    if (status === 'failed' && !out.final && slack) {
      slack.alert(`scheduler-${job.name}-${slot}`, job.name === 'newsletter' ? `Monday newsletter send failed after ${attempts} tries`
        : job.name === 'newsletter-weekend' ? `Thursday weekend newsletter send failed after ${attempts} tries` : `Scheduled ${job.name} couldn't start`,
      String(out.message || out.error || 'unknown error'), `${siteUrl}/admin.html`);
    }
    if (status !== 'done') log.warn(`[scheduler] ${job.name} ${slot}: ${status}`, out.message || out.error || '');
    return status;
  }

  async function tick(now = nowFn()) {
    state.lastTick = now.toISOString();
    for (const job of jobs) {
      const slot = dueSlot(job, now);
      if (!slot || busy.has(job.name) || !available(job)) continue;
      if (!persisted(job) && memory.get(job.name) === slot) continue;
      busy.add(job.name);
      try {
        if (persisted(job)) {
          await runPersisted(job, slot, now);
        } else {
          memory.set(job.name, slot);
          const out = await runJob(job, now);
          if (!out.ok) log.warn(`[scheduler] ${job.name} ${slot}:`, out.message || out.error || '');
        }
      } catch (err) {
        log.warn(`[scheduler] ${job.name} failed:`, err.message);
      } finally {
        busy.delete(job.name);
      }
    }
  }

  // Did the scheduler already run this job's most recent slot? (The
  // fallback crons ask this before doing the same work again.)
  async function ran(name, now = nowFn()) {
    const job = jobs.find(j => j.name === name && persisted(j));
    if (!job) return null;
    const slot = lastSlot(job, now);
    const row = slot ? await store.getJobRun(job.name, slot) : null;
    return { job: name, slot, ran: Boolean(row && row.status === 'done') };
  }

  function start(intervalMs = MIN) {
    if (timer) return;
    // Every minute, aligned loosely; the first tick waits for boot to settle.
    const first = setTimeout(() => { tick().catch(() => {}); }, 15 * 1000);
    timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    if (first.unref) first.unref();
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, ran, start, stop, state };
}
