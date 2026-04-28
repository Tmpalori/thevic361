/* server/validate.js — Submission validation + light sanitization.
 *
 * Anything in here runs BEFORE we touch the DB and BEFORE Turnstile (cheap
 * rejects first). Sanitization strips control chars, caps lengths, and
 * normalizes booleans, but does NOT attempt to scrub HTML — payloads are only
 * rendered through escapeHtml() in the admin UI and as plain text in the
 * public site, never inserted as raw HTML.
 */

const MAX_NAME = 200;
const MAX_VENUE = 200;
const MAX_ADDRESS = 300;
const MAX_DESC = 2000;
const MAX_URL = 500;
const MAX_TIME = 60;
const MAX_EMAIL = 254;
const MAX_SUBMITTER_NAME = 120;

const ALLOWED_ICONS = new Set([
  'food', 'music', 'family', 'drinks', 'arts',
  'shopping', 'outdoors', 'community', 'free'
]);

const ALLOWED_SUBMITTER_KIND = new Set(['organizer', 'found_online', 'other']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Strip ASCII control chars (\x00-\x1F minus \t\n, plus DEL) before trim/cap.
const CONTROL_CHARS = new RegExp('[\\x00-\\x08\\x0B-\\x1F\\x7F]', 'g');

function clean(s, max) {
  if (s == null) return '';
  return String(s).replace(CONTROL_CHARS, '').trim().slice(0, max);
}

export function validateSubmission(input) {
  const errors = {};
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: { _form: 'Invalid request body.' } };
  }

  const name = clean(input.name, MAX_NAME);
  if (!name) errors.name = 'Event name is required.';
  else if (name.length < 3) errors.name = 'Event name is too short.';

  const date = clean(input.date, 10);
  if (!date) errors.date = 'Date is required.';
  else if (!ISO_DATE.test(date)) errors.date = 'Date must look like YYYY-MM-DD.';
  else {
    const d = new Date(date + 'T12:00:00Z');
    if (isNaN(d.getTime())) errors.date = 'Date is invalid.';
  }

  const time = clean(input.time, MAX_TIME);
  if (!time) errors.time = 'Start time is required.';

  const end_time = clean(input.end_time, MAX_TIME);

  const venue = clean(input.venue, MAX_VENUE);
  if (!venue) errors.venue = 'Venue is required.';

  const address = clean(input.address, MAX_ADDRESS);
  const description = clean(input.description, MAX_DESC);
  const url = clean(input.url, MAX_URL);
  if (url && !URL_RE.test(url)) {
    errors.url = 'Link must start with http:// or https://';
  }

  let icons = [];
  if (Array.isArray(input.icons)) {
    icons = input.icons
      .map(c => clean(c, 32).toLowerCase())
      .filter(c => ALLOWED_ICONS.has(c));
    icons = Array.from(new Set(icons)).slice(0, 8);
  }

  const free = Boolean(input.free);
  if (free && !icons.includes('free')) icons.push('free');

  const submitter_name = clean(input.submitter_name, MAX_SUBMITTER_NAME);
  const submitter_email = clean(input.submitter_email, MAX_EMAIL);
  if (submitter_email && !EMAIL_RE.test(submitter_email)) {
    errors.submitter_email = 'Email looks invalid.';
  }

  let submitter_kind = clean(input.submitter_kind, 32).toLowerCase();
  if (!submitter_kind) submitter_kind = 'other';
  if (!ALLOWED_SUBMITTER_KIND.has(submitter_kind)) {
    submitter_kind = 'other';
  }

  if (Object.keys(errors).length) return { ok: false, errors };

  return {
    ok: true,
    data: {
      payload: {
        name, date, time, end_time, venue, address, description, url,
        icons, free
      },
      submitter_name,
      submitter_email,
      submitter_kind
    }
  };
}

// Honeypot: a hidden field named "company" no real user fills. Combined with
// elapsed_ms (time from form render to submit), we get a cheap bot filter.
export function checkBotSignals(input, opts = {}) {
  const minMs = opts.minMs ?? 1500;
  const maxMs = opts.maxMs ?? 60 * 60 * 1000;
  if (input && typeof input.company === 'string' && input.company.trim()) {
    return { ok: false, reason: 'honeypot' };
  }
  const elapsed = Number(input && input.elapsed_ms);
  if (Number.isFinite(elapsed)) {
    if (elapsed < minMs) return { ok: false, reason: 'too-fast' };
    if (elapsed > maxMs) return { ok: false, reason: 'too-slow' };
  }
  return { ok: true };
}

export const _internal = {
  ALLOWED_ICONS, ALLOWED_SUBMITTER_KIND, ISO_DATE, URL_RE, EMAIL_RE
};
