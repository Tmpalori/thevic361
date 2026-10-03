/* server/slack.js — Owner notifications in Slack via an incoming webhook.
 *
 * Same setup as austincommercialsites.com: SLACK_WEBHOOK_URL holds a Slack
 * incoming-webhook URL (Railway variable, production only). Unset means
 * every call is a no-op, so local runs, tests and PR environments stay quiet.
 *
 * Sends are fire-and-forget: a Slack outage must never break a submission,
 * a checkout or a page view. Alerts (things breaking) are de-duplicated by
 * key so a crash loop or a bad deploy pings once per window, not per request.
 */

const ALERT_WINDOW_MS = 15 * 60 * 1000;

// Slack mrkdwn treats &, <, > specially; escape anything user-supplied so it
// can't inject links or @channel mentions.
export const slackEscape = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slackConfig(env = process.env, overrides = {}) {
  const url = overrides.slackWebhookUrl ?? env.SLACK_WEBHOOK_URL ?? '';
  return {
    url,
    enabled: /^https:\/\/hooks\.slack\.com\//.test(url),
    // Railway sets these; they label which deploy sent the message.
    environment: env.RAILWAY_ENVIRONMENT_NAME || env.NODE_ENV || 'local',
    commit: (env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7)
  };
}

export function createSlack(config, { fetchImpl = globalThis.fetch, nowFn = () => Date.now() } = {}) {
  const lastAlert = new Map();

  async function post(text, blocks) {
    if (!config.enabled) return false;
    try {
      const res = await fetchImpl(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(blocks ? { text, blocks } : { text })
      });
      if (!res.ok) console.warn('[slack] HTTP', res.status);
      return res.ok;
    } catch (err) {
      console.warn('[slack] send failed:', err.message);
      return false;
    }
  }

  // A titled message with optional "label: value" fields and a footer line.
  function notify({ title, fields = [], text = '', link = null, footer = '' }) {
    const e = slackEscape;
    const blocks = [{ type: 'header', text: { type: 'plain_text', text: String(title).slice(0, 150) } }];
    const f = fields.filter(([, v]) => v != null && v !== '').slice(0, 10)
      .map(([k, v]) => ({ type: 'mrkdwn', text: `*${e(k)}*\n${e(v).slice(0, 500)}` }));
    if (f.length) blocks.push({ type: 'section', fields: f });
    if (text) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: e(text).slice(0, 2900) } });
    const ctx = [footer, link ? `<${link}|Open>` : '', config.environment !== 'production' ? `env: ${config.environment}` : '']
      .filter(Boolean).join(' · ');
    if (ctx) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: ctx }] });
    return post(String(title), blocks);
  }

  // Something broke. Pings once per key per window.
  function alert(key, title, detail = '', link = null) {
    const now = nowFn();
    const last = lastAlert.get(key);
    if (last !== undefined && now - last < ALERT_WINDOW_MS) return Promise.resolve(false);
    lastAlert.set(key, now);
    return notify({ title: `🚨 ${title}`, text: detail, link, footer: config.commit ? `deploy ${config.commit}` : '' });
  }

  return { enabled: config.enabled, notify, alert, post };
}
