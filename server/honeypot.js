/* server/honeypot.js — The hidden spam-trap field on public forms.
 *
 * Every public form (submit, newsletter signup, contact, sponsor checkout,
 * the homepage signup card) carries a hidden text field people never see
 * or fill; a bot that fills every field fills it too, and the request is
 * answered as if it worked so the bot moves on.
 *
 * The field used to be named "company", which is the standard autofill
 * name for the organization field: a browser or password manager could
 * fill it for a real business owner, and their submission, signup or paid
 * checkout vanished without a trace. It's now HONEYPOT_FIELD, a name no
 * autofill knows, hidden with display:none. The old name is still honored
 * for a while, so a page cached before the rename keeps working the same.
 *
 * A hit is logged, and Slack hears about it at most once a day per form
 * (with the count since the last ping), so a false positive can be seen
 * without bot traffic flooding a channel.
 */

export const HONEYPOT_FIELD = 'hp_field';
// Pages cached before the rename still send this one.
export const LEGACY_HONEYPOT_FIELD = 'company';

const PING_EVERY_MS = 24 * 60 * 60 * 1000;
// slack → Map(form → { at, count }); per Slack client, so separate apps
// (and tests) don't share a throttle.
const pings = new WeakMap();

// The name of the trap field that was filled, or '' when none was.
export function honeypotHit(body) {
  for (const name of [HONEYPOT_FIELD, LEGACY_HONEYPOT_FIELD]) {
    const v = body && body[name];
    if (typeof v === 'string' && v.trim()) return name;
  }
  return '';
}

// Logs a trap hit (never the submitted values: a real person's typing may
// be in them) and pings Slack's activity channel at most once a day per form.
export function reportHoneypot(form, field, { slack = null, nowFn = () => Date.now() } = {}) {
  console.warn(`[honeypot] ${form}: trap field "${field}" was filled; dropped as a bot`);
  if (!slack || typeof slack.notify !== 'function') return;
  let byForm = pings.get(slack);
  if (!byForm) { byForm = new Map(); pings.set(slack, byForm); }
  const now = Number(nowFn());
  const seen = byForm.get(form) || { at: null, count: 0 };
  seen.count += 1;
  if (seen.at !== null && now - seen.at < PING_EVERY_MS) { byForm.set(form, seen); return; }
  const count = seen.count;
  byForm.set(form, { at: now, count: 0 });
  Promise.resolve(slack.notify({
    title: `🪤 Spam trap caught a ${form} form`,
    fields: [['Caught', count === 1 ? '1 since the last note' : `${count} since the last note`], ['Field', field]],
    text: 'Dropped as a bot (the hidden field was filled). If someone says their form "went through" but nothing arrived, autofill may have filled the hidden field.',
    footer: 'At most one note a day per form'
  })).catch(() => {});
}

// Both steps for a route: true when the request should be dropped.
export function honeypotTripped(body, form, opts = {}) {
  const field = honeypotHit(body);
  if (!field) return false;
  reportHoneypot(form, field, opts);
  return true;
}
