/* server/db.js — Submission storage with two backends.
 *
 * If DATABASE_URL is set we use Postgres (Railway-style). Otherwise we fall
 * back to a JSON file on disk so local dev and Railway preview deploys without
 * a DB attached still work. The fallback keeps the API surface identical so
 * route handlers don't branch.
 *
 * Submissions schema (logical):
 *   id              text    — uuid-like
 *   created_at      iso     — server clock
 *   updated_at      iso
 *   status          text    — pending | approved | rejected | duplicate
 *   source          text    — submission | local | scraper | candidate | etc.
 *   submitter_kind  text    — organizer | found_online | other
 *   submitter_name  text
 *   submitter_email text
 *   payload         json    — public event fields (name, date, time, venue, ...)
 *   admin_notes     text
 *   review_history  json[]  — [{ at, action, note }]
 *
 * The payload column owns the public-facing event shape and matches the keys
 * used in candidates.json / docs/events.json (date, name, time, venue,
 * address, url, description, icons, free) so the admin can promote a row to a
 * publishable event without remapping fields.
 *
 * Event edits overlay (PR #22): admins can correct mistakes the AI made on
 * candidate events (typos, wrong times, missing end_time, etc.) without
 * forcing a re-collect. Each overlay is keyed by the ORIGINAL event key
 * (date|name|venue) so we can find the candidate to replace even when the
 * edit changes one of those fields.
 *
 *   id             text    — same as original_key
 *   original_key   text    — date|name|venue at time of first edit
 *   payload        json    — full edited event (date, name, time, venue, ...)
 *   updated_at     iso
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_FILE = path.resolve(process.cwd(), 'data', 'submissions.json');

function newId() {
  // randomUUID exists in Node 18+ and is collision-safe enough for our scale.
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

// Normalize a payload into the canonical event shape used by the rest of the
// site so admin promotion is a straight copy. Trims strings to sane lengths
// (defense-in-depth on top of route validation).
export function normalizePayload(input) {
  const s = (v, max = 500) => {
    if (v == null) return '';
    return String(v).trim().slice(0, max);
  };
  const icons = Array.isArray(input.icons)
    ? input.icons.map(c => s(c, 32)).filter(Boolean).slice(0, 8)
    : [];
  return {
    date: s(input.date, 10),
    name: s(input.name, 200),
    time: s(input.time, 60),
    end_time: s(input.end_time, 60),
    venue: s(input.venue, 200),
    address: s(input.address, 300),
    url: s(input.url, 500),
    description: s(input.description, 2000),
    icons,
    free: Boolean(input.free),
    submitter_first_name: s(input.submitter_first_name, 60),
    submitter_last_name: s(input.submitter_last_name, 60),
    submitter_phone: s(input.submitter_phone, 40)
  };
}

// Canonical "event identity" key used everywhere in the codebase to dedupe
// candidates and detect duplicate submissions. Keep in sync with the
// browser-side eventKey() in docs/admin.js.
export function eventKeyOf(ev) {
  if (!ev) return '||';
  return [ev.date || '', ev.name || '', ev.venue || ''].join('|');
}

// Apply the admin event-edits overlay on top of a list of events. For each
// event matching an edit's original_key (or current key), replace it with the
// edited payload. New keys produced by an edit replace any existing event
// that would otherwise collide so the admin sees a single corrected row.
export function applyEventEdits(events, edits) {
  if (!Array.isArray(events) || !edits || !edits.length) return events || [];
  const byOriginal = new Map();
  for (const e of edits) {
    if (e && e.original_key) byOriginal.set(e.original_key, e);
  }
  const seen = new Set();
  const out = [];
  for (const ev of events) {
    const k = eventKeyOf(ev);
    const edit = byOriginal.get(k);
    const merged = edit ? { ...ev, ...edit.payload } : ev;
    const newKey = eventKeyOf(merged);
    if (seen.has(newKey)) continue;
    seen.add(newKey);
    out.push(merged);
  }
  return out;
}

// ─── JSON FILE BACKEND ───
const FILE_TRAFFIC_CAP = 50000;

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}
// Postgres keeps a bit over a year of traffic; older rows are pruned.
const TRAFFIC_RETENTION_DAYS = 400;

class FileStore {
  constructor(file) {
    this.file = file || DEFAULT_FILE;
    this._writeLock = Promise.resolve();
  }

  async _read() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return { submissions: [], published: null, event_edits: [], event_archive: {}, traffic: [], subscribers: [], newsletter_sends: [], sponsor_orders: [] };
      }
      if (!Array.isArray(parsed.submissions)) parsed.submissions = [];
      if (!parsed.event_archive || typeof parsed.event_archive !== 'object') parsed.event_archive = {};
      if (!Array.isArray(parsed.traffic)) parsed.traffic = [];
      if (!Array.isArray(parsed.subscribers)) parsed.subscribers = [];
      if (!Array.isArray(parsed.newsletter_sends)) parsed.newsletter_sends = [];
      if (!Array.isArray(parsed.sponsor_orders)) parsed.sponsor_orders = [];
      if (!Array.isArray(parsed.event_edits)) parsed.event_edits = [];
      return parsed;
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { submissions: [], published: null, event_edits: [], event_archive: {}, traffic: [], subscribers: [], newsletter_sends: [], sponsor_orders: [] };
      }
      throw err;
    }
  }

  async _write(data) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, this.file);
  }

  // Serialize writes so concurrent submissions don't clobber each other.
  _withWrite(fn) {
    const next = this._writeLock.then(fn, fn);
    this._writeLock = next.catch(() => {});
    return next;
  }

  async ready() { return true; }

  async insert(row) {
    return this._withWrite(async () => {
      const data = await this._read();
      data.submissions.push(row);
      await this._write(data);
      return row;
    });
  }

  async list({ status } = {}) {
    const data = await this._read();
    const rows = status
      ? data.submissions.filter(r => r.status === status)
      : data.submissions.slice();
    rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return rows;
  }

  async get(id) {
    const data = await this._read();
    return data.submissions.find(r => r.id === id) || null;
  }

  async update(id, patch) {
    return this._withWrite(async () => {
      const data = await this._read();
      const idx = data.submissions.findIndex(r => r.id === id);
      if (idx === -1) return null;
      const merged = { ...data.submissions[idx], ...patch, updated_at: nowIso() };
      data.submissions[idx] = merged;
      await this._write(data);
      return merged;
    });
  }

  // Last-published events.json payload, for the case where Railway is
  // operating without a GitHub token and we still want a durable copy.
  async getPublished() {
    const data = await this._read();
    return data.published || null;
  }

  async setPublished(payload) {
    return this._withWrite(async () => {
      const data = await this._read();
      data.published = payload;
      await this._write(data);
      return payload;
    });
  }

  // Every event ever published, keyed by its public page path
  // (/events/<date>-<slug>). Event pages stay up after their week rotates
  // out of the live payload, so links and search rankings don't 404.
  async archiveEvents(events) {
    return this._withWrite(async () => {
      const data = await this._read();
      for (const ev of events) {
        if (ev && ev.page) data.event_archive[ev.page] = ev;
      }
      await this._write(data);
    });
  }

  // Visitor stats (server/analytics.js). Capped so the JSON file stays
  // small; production uses Postgres.
  async recordTraffic(row) {
    return this._withWrite(async () => {
      const data = await this._read();
      data.traffic.push({ ...row, ts: nowIso() });
      if (data.traffic.length > FILE_TRAFFIC_CAP) data.traffic.splice(0, data.traffic.length - FILE_TRAFFIC_CAP);
      await this._write(data);
    });
  }

  async listTraffic(sinceDay) {
    const data = await this._read();
    return data.traffic.filter(r => r.day >= sinceDay);
  }

  // ─── Newsletter (server/newsletter.js) ───
  async addSubscriber({ email, source }) {
    return this._withWrite(async () => {
      const data = await this._read();
      let sub = data.subscribers.find(x => x.email === email);
      const now = nowIso();
      if (sub && sub.status === 'active') return sub;
      let fresh = false;
      if (!sub) {
        sub = { id: newId(), email, status: 'pending', token: newToken(), source, created_at: now };
        data.subscribers.push(sub);
        fresh = true;
      } else if (sub.status === 'unsubscribed') {
        // Coming back: credit where they came back from.
        Object.assign(sub, { status: 'pending', token: newToken(), unsubscribed_at: null, source });
        fresh = true;
      }
      await this._write(data);
      // new_signup: a first signup or a comeback, not a re-submit. Only
      // these count as conversions (docs/track.js Lead).
      return { ...sub, new_signup: fresh };
    });
  }

  async confirmSubscriber(token) {
    if (!token) return null;
    return this._withWrite(async () => {
      const data = await this._read();
      const sub = data.subscribers.find(x => x.token === token && x.status !== 'unsubscribed');
      if (!sub) return null;
      const newly = sub.status !== 'active';
      if (newly) Object.assign(sub, { status: 'active', confirmed_at: nowIso() });
      await this._write(data);
      return { ...sub, newly_confirmed: newly };
    });
  }

  async unsubscribe(token) {
    if (!token) return false;
    return this._withWrite(async () => {
      const data = await this._read();
      const sub = data.subscribers.find(x => x.token === token);
      if (!sub) return false;
      Object.assign(sub, { status: 'unsubscribed', unsubscribed_at: nowIso() });
      await this._write(data);
      return true;
    });
  }

  async listSubscribers({ status } = {}) {
    const data = await this._read();
    return data.subscribers.filter(x => !status || x.status === status);
  }

  async countSubscribers() {
    const data = await this._read();
    const c = { active: 0, pending: 0, unsubscribed: 0 };
    for (const x of data.subscribers) c[x.status] = (c[x.status] || 0) + 1;
    return c;
  }

  // Imported addresses already opted in elsewhere (an old list), so they start
  // active. People who unsubscribed here are never re-added.
  async importSubscribers(emails, source) {
    return this._withWrite(async () => {
      const data = await this._read();
      const out = { added: 0, already: 0, skipped_unsubscribed: 0 };
      for (const email of emails) {
        const sub = data.subscribers.find(x => x.email === email);
        if (!sub) {
          data.subscribers.push({ id: newId(), email, status: 'active', token: newToken(), source, created_at: nowIso(), confirmed_at: nowIso() });
          out.added++;
        } else if (sub.status === 'unsubscribed') out.skipped_unsubscribed++;
        else { if (sub.status !== 'active') Object.assign(sub, { status: 'active', confirmed_at: nowIso() }); out.already++; }
      }
      await this._write(data);
      return out;
    });
  }

  async recordNewsletterSend(rec) {
    return this._withWrite(async () => {
      const data = await this._read();
      data.newsletter_sends = data.newsletter_sends.filter(x => x.week_key !== rec.week_key);
      data.newsletter_sends.push({ ...rec, sent_at: nowIso() });
      await this._write(data);
    });
  }

  async getNewsletterSend(weekKey) {
    const data = await this._read();
    return data.newsletter_sends.find(x => x.week_key === weekKey) || null;
  }

  async listNewsletterSends(limit = 10) {
    const data = await this._read();
    return data.newsletter_sends.slice().sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1)).slice(0, limit);
  }

  // ─── Sponsor orders (server/sponsors.js) ───
  async saveSponsorOrder(order) {
    return this._withWrite(async () => {
      const data = await this._read();
      data.sponsor_orders = data.sponsor_orders.filter(x => x.id !== order.id);
      data.sponsor_orders.push(order);
      await this._write(data);
    });
  }

  async listSponsorOrders() {
    const data = await this._read();
    return data.sponsor_orders.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  // Weekly sponsor logos, kept apart from orders (orders are read on every
  // page view; logos only when someone loads the image).
  async saveSponsorLogo(id, { contentType, data: bytes }) {
    return this._withWrite(async () => {
      const data = await this._read();
      data.sponsor_logos = data.sponsor_logos || {};
      data.sponsor_logos[id] = { contentType, data: Buffer.from(bytes).toString('base64') };
      await this._write(data);
    });
  }

  async getSponsorLogo(id) {
    const data = await this._read();
    const row = (data.sponsor_logos || {})[id];
    return row ? { contentType: row.contentType, data: Buffer.from(row.data, 'base64') } : null;
  }

  async getArchivedEvent(page) {
    const data = await this._read();
    return data.event_archive[page] || null;
  }

  async listArchivedEvents() {
    const data = await this._read();
    return Object.values(data.event_archive);
  }

  // Lightweight duplicate detector: same date + normalized name + venue, status
  // not rejected.
  async findDuplicate({ date, name, venue }) {
    const data = await this._read();
    const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const dn = norm(name), dv = norm(venue);
    return data.submissions.find(r => {
      if (r.status === 'rejected') return false;
      const p = r.payload || {};
      return (p.date || '') === date &&
        norm(p.name) === dn &&
        norm(p.venue) === dv;
    }) || null;
  }

  // Admin event-edits overlay (PR #22). Stored as a flat list keyed by
  // original_key — the eventKey at the time of the first edit. Subsequent
  // edits to the same row update the same entry so we never accumulate
  // multiple stale overlays for one event.
  async listEventEdits() {
    const data = await this._read();
    return Array.isArray(data.event_edits) ? data.event_edits.slice() : [];
  }

  async upsertEventEdit({ original_key, payload }) {
    return this._withWrite(async () => {
      const data = await this._read();
      if (!Array.isArray(data.event_edits)) data.event_edits = [];
      const idx = data.event_edits.findIndex(e => e.original_key === original_key);
      const now = nowIso();
      const row = {
        id: original_key,
        original_key,
        payload,
        updated_at: now,
        created_at: idx === -1 ? now : (data.event_edits[idx].created_at || now)
      };
      if (idx === -1) data.event_edits.push(row);
      else data.event_edits[idx] = row;
      await this._write(data);
      return row;
    });
  }
}

// ─── POSTGRES BACKEND ───
class PgStore {
  constructor(pool) {
    this.pool = pool;
    this._readyPromise = null;
  }

  async ready() {
    if (!this._readyPromise) {
      this._readyPromise = (async () => {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS event_submissions (
            id TEXT PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            status TEXT NOT NULL DEFAULT 'pending',
            source TEXT NOT NULL DEFAULT 'submission',
            submitter_kind TEXT,
            submitter_name TEXT,
            submitter_email TEXT,
            submitter_ip TEXT,
            user_agent TEXT,
            payload JSONB NOT NULL,
            admin_notes TEXT,
            review_history JSONB NOT NULL DEFAULT '[]'::jsonb
          );
        `);
        await this.pool.query(`
          CREATE INDEX IF NOT EXISTS event_submissions_status_idx
            ON event_submissions(status);
        `);
        await this.pool.query(`
          CREATE INDEX IF NOT EXISTS event_submissions_created_idx
            ON event_submissions(created_at DESC);
        `);
        // Single-row store for the most-recent published events.json payload.
        // Lets Railway operate independently of GitHub when GITHUB_TOKEN is
        // not configured or the GitHub API is unreachable.
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS published_events (
            id INT PRIMARY KEY,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        // Admin event-edits overlay (PR #22). Keyed by the original event
        // identity (date|name|venue) so subsequent edits to the same row
        // upsert the same record instead of stacking.
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS event_edits (
            original_key TEXT PRIMARY KEY,
            payload JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        // Every event ever published, keyed by its public page path, so
        // /events/<slug> keeps working after the week rotates out.
        // Visitor stats (server/analytics.js): one row per page view, click,
        // or crawler hit. No IPs or cookies, only a daily visitor hash.
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS traffic (
            id BIGSERIAL PRIMARY KEY,
            day DATE NOT NULL,
            ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            kind TEXT NOT NULL,
            path TEXT,
            visitor TEXT,
            ref_source TEXT,
            ref_host TEXT,
            click_type TEXT,
            click_url TEXT,
            bot TEXT
          );
        `);
        await this.pool.query('CREATE INDEX IF NOT EXISTS traffic_day_idx ON traffic(day);');
        // Newsletter subscribers (server/newsletter.js). token is the secret
        // in confirm/unsubscribe links.
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS subscribers (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'pending',
            token TEXT NOT NULL UNIQUE,
            source TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            confirmed_at TIMESTAMPTZ,
            unsubscribed_at TIMESTAMPTZ
          );
        `);
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS newsletter_sends (
            week_key TEXT PRIMARY KEY,
            subject TEXT,
            recipients INT NOT NULL DEFAULT 0,
            failed INT NOT NULL DEFAULT 0,
            sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        // Who didn't get it, so a retry resends to them only.
        await this.pool.query(`ALTER TABLE newsletter_sends ADD COLUMN IF NOT EXISTS failed_emails JSONB NOT NULL DEFAULT '[]'::jsonb`);
        // Sponsor orders (server/sponsors.js). Low volume, read whole; the
        // order itself lives in payload so new fields need no migration.
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS sponsor_orders (
            id TEXT PRIMARY KEY,
            payload JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        // Weekly sponsor logos (small images, read only when displayed).
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS sponsor_logos (
            id TEXT PRIMARY KEY,
            content_type TEXT NOT NULL,
            data BYTEA NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS event_archive (
            page TEXT PRIMARY KEY,
            event_date DATE,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
      })().catch(err => {
        this._readyPromise = null;
        throw err;
      });
    }
    return this._readyPromise;
  }

  _row(r) {
    if (!r) return null;
    return {
      id: r.id,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
      status: r.status,
      source: r.source,
      submitter_kind: r.submitter_kind,
      submitter_name: r.submitter_name,
      submitter_email: r.submitter_email,
      submitter_ip: r.submitter_ip,
      user_agent: r.user_agent,
      payload: r.payload,
      admin_notes: r.admin_notes,
      review_history: r.review_history || []
    };
  }

  async insert(row) {
    await this.ready();
    const q = `
      INSERT INTO event_submissions
        (id, created_at, updated_at, status, source, submitter_kind,
         submitter_name, submitter_email, submitter_ip, user_agent, payload,
         admin_notes, review_history)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *;
    `;
    const r = await this.pool.query(q, [
      row.id, row.created_at, row.updated_at, row.status, row.source,
      row.submitter_kind, row.submitter_name, row.submitter_email,
      row.submitter_ip, row.user_agent, row.payload, row.admin_notes,
      JSON.stringify(row.review_history || [])
    ]);
    return this._row(r.rows[0]);
  }

  async list({ status } = {}) {
    await this.ready();
    const args = [];
    let q = 'SELECT * FROM event_submissions';
    if (status) { args.push(status); q += ' WHERE status = $1'; }
    q += ' ORDER BY created_at DESC LIMIT 500';
    const r = await this.pool.query(q, args);
    return r.rows.map(x => this._row(x));
  }

  async get(id) {
    await this.ready();
    const r = await this.pool.query('SELECT * FROM event_submissions WHERE id=$1', [id]);
    return this._row(r.rows[0] || null);
  }

  async update(id, patch) {
    await this.ready();
    const fields = ['status', 'source', 'submitter_kind', 'submitter_name',
      'submitter_email', 'admin_notes', 'payload', 'review_history'];
    const sets = [];
    const args = [];
    for (const f of fields) {
      if (patch[f] !== undefined) {
        args.push(f === 'review_history' || f === 'payload' ? JSON.stringify(patch[f]) : patch[f]);
        sets.push(`${f} = $${args.length}`);
      }
    }
    sets.push('updated_at = NOW()');
    args.push(id);
    const q = `UPDATE event_submissions SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`;
    const r = await this.pool.query(q, args);
    return this._row(r.rows[0] || null);
  }

  async getPublished() {
    await this.ready();
    const r = await this.pool.query(
      'SELECT payload FROM published_events WHERE id = 1'
    );
    return r.rows[0] ? r.rows[0].payload : null;
  }

  async setPublished(payload) {
    await this.ready();
    await this.pool.query(`
      INSERT INTO published_events (id, payload, updated_at)
      VALUES (1, $1, NOW())
      ON CONFLICT (id) DO UPDATE
        SET payload = EXCLUDED.payload, updated_at = NOW();
    `, [JSON.stringify(payload)]);
    return payload;
  }

  async archiveEvents(events) {
    await this.ready();
    const rows = events.filter(ev => ev && ev.page);
    for (const ev of rows) {
      await this.pool.query(`
        INSERT INTO event_archive (page, event_date, payload, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (page) DO UPDATE
          SET event_date = EXCLUDED.event_date, payload = EXCLUDED.payload, updated_at = NOW();
      `, [ev.page, /^\d{4}-\d{2}-\d{2}$/.test(ev.date || '') ? ev.date : null, JSON.stringify(ev)]);
    }
  }

  async recordTraffic(row) {
    await this.ready();
    await this.pool.query(`
      INSERT INTO traffic (day, kind, path, visitor, ref_source, ref_host, click_type, click_url, bot)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
    `, [row.day, row.kind, row.path || null, row.visitor || null, row.ref_source || null,
        row.ref_host || null, row.click_type || null, row.click_url || null, row.bot || null]);
    // Prune now and then instead of on a schedule.
    if (Math.random() < 0.002) {
      await this.pool.query(`DELETE FROM traffic WHERE day < CURRENT_DATE - $1::int`, [TRAFFIC_RETENTION_DAYS]);
    }
  }

  async listTraffic(sinceDay) {
    await this.ready();
    const r = await this.pool.query(`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, kind, path, visitor, ref_source, ref_host,
             click_type, click_url, bot
      FROM traffic WHERE day >= $1::date
    `, [sinceDay]);
    return r.rows;
  }

  // ─── Newsletter ───
  async addSubscriber({ email, source }) {
    await this.ready();
    const existing = (await this.pool.query('SELECT * FROM subscribers WHERE email = $1', [email])).rows[0];
    if (existing && existing.status === 'active') return existing;
    if (existing && existing.status === 'pending') return existing;
    if (existing) {
      // Coming back: credit where they came back from.
      const row = (await this.pool.query(
        `UPDATE subscribers SET status = 'pending', token = $2, unsubscribed_at = NULL, source = $3 WHERE email = $1 RETURNING *`,
        [email, newToken(), source])).rows[0];
      return { ...row, new_signup: true };
    }
    // xmax = 0 means this statement inserted the row (not the conflict path).
    const row = (await this.pool.query(
      `INSERT INTO subscribers (id, email, status, token, source) VALUES ($1, $2, 'pending', $3, $4)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING *, (xmax = 0) AS inserted`,
      [newId(), email, newToken(), source])).rows[0];
    const { inserted, ...sub } = row;
    return { ...sub, new_signup: Boolean(inserted) };
  }

  async confirmSubscriber(token) {
    if (!token) return null;
    await this.ready();
    // newly_confirmed: was pending until this call (the welcome email goes out once).
    const r = await this.pool.query(
      `WITH prev AS (
         SELECT id, status FROM subscribers WHERE token = $1 AND status <> 'unsubscribed' FOR UPDATE
       )
       UPDATE subscribers s SET status = 'active', confirmed_at = COALESCE(s.confirmed_at, NOW())
       FROM prev WHERE s.id = prev.id
       RETURNING s.*, (prev.status <> 'active') AS newly_confirmed`, [token]);
    return r.rows[0] || null;
  }

  async unsubscribe(token) {
    if (!token) return false;
    await this.ready();
    const r = await this.pool.query(
      `UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = NOW() WHERE token = $1`, [token]);
    return r.rowCount > 0;
  }

  async listSubscribers({ status } = {}) {
    await this.ready();
    const r = status
      ? await this.pool.query('SELECT email, status, token FROM subscribers WHERE status = $1 ORDER BY created_at', [status])
      : await this.pool.query('SELECT email, status, token FROM subscribers ORDER BY created_at');
    return r.rows;
  }

  async countSubscribers() {
    await this.ready();
    const r = await this.pool.query('SELECT status, COUNT(*)::int AS n FROM subscribers GROUP BY status');
    const c = { active: 0, pending: 0, unsubscribed: 0 };
    for (const row of r.rows) c[row.status] = row.n;
    return c;
  }

  async importSubscribers(emails, source) {
    await this.ready();
    const out = { added: 0, already: 0, skipped_unsubscribed: 0 };
    for (const email of emails) {
      const existing = (await this.pool.query('SELECT status FROM subscribers WHERE email = $1', [email])).rows[0];
      if (!existing) {
        await this.pool.query(
          `INSERT INTO subscribers (id, email, status, token, source, confirmed_at) VALUES ($1, $2, 'active', $3, $4, NOW())
           ON CONFLICT (email) DO NOTHING`, [newId(), email, newToken(), source]);
        out.added++;
      } else if (existing.status === 'unsubscribed') {
        out.skipped_unsubscribed++;
      } else {
        await this.pool.query(
          `UPDATE subscribers SET status = 'active', confirmed_at = COALESCE(confirmed_at, NOW()) WHERE email = $1`, [email]);
        out.already++;
      }
    }
    return out;
  }

  async recordNewsletterSend(rec) {
    await this.ready();
    await this.pool.query(`
      INSERT INTO newsletter_sends (week_key, subject, recipients, failed, failed_emails, sent_at) VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
      ON CONFLICT (week_key) DO UPDATE SET subject = EXCLUDED.subject, recipients = EXCLUDED.recipients,
        failed = EXCLUDED.failed, failed_emails = EXCLUDED.failed_emails, sent_at = NOW()
    `, [rec.week_key, rec.subject, rec.recipients, rec.failed, JSON.stringify(rec.failed_emails || [])]);
  }

  async saveSponsorOrder(order) {
    await this.ready();
    await this.pool.query(`
      INSERT INTO sponsor_orders (id, payload, created_at, updated_at) VALUES ($1, $2::jsonb, COALESCE($3::timestamptz, NOW()), NOW())
      ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
    `, [order.id, JSON.stringify(order), order.created_at || null]);
  }

  async saveSponsorLogo(id, { contentType, data }) {
    await this.ready();
    await this.pool.query(`
      INSERT INTO sponsor_logos (id, content_type, data) VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data
    `, [id, contentType, Buffer.from(data)]);
  }

  async getSponsorLogo(id) {
    await this.ready();
    const r = await this.pool.query('SELECT content_type, data FROM sponsor_logos WHERE id = $1', [id]);
    return r.rows[0] ? { contentType: r.rows[0].content_type, data: r.rows[0].data } : null;
  }

  async listSponsorOrders() {
    await this.ready();
    // Abandoned checkouts pile up; keep every live or recent order and let
    // old expired/failed ones fall out instead of capping the whole list.
    const r = await this.pool.query(
      `SELECT payload FROM sponsor_orders
        WHERE COALESCE(payload->>'status', '') NOT IN ('expired', 'failed')
           OR created_at > now() - interval '30 days'
        ORDER BY created_at DESC`);
    return r.rows.map(row => row.payload);
  }

  async getNewsletterSend(weekKey) {
    await this.ready();
    const r = await this.pool.query('SELECT * FROM newsletter_sends WHERE week_key = $1', [weekKey]);
    return r.rows[0] || null;
  }

  async listNewsletterSends(limit = 10) {
    await this.ready();
    const r = await this.pool.query('SELECT * FROM newsletter_sends ORDER BY sent_at DESC LIMIT $1', [limit]);
    return r.rows;
  }

  async getArchivedEvent(page) {
    await this.ready();
    const r = await this.pool.query('SELECT payload FROM event_archive WHERE page = $1', [page]);
    return r.rows[0] ? r.rows[0].payload : null;
  }

  async listArchivedEvents() {
    await this.ready();
    const r = await this.pool.query('SELECT payload FROM event_archive ORDER BY event_date DESC NULLS LAST');
    return r.rows.map(row => row.payload);
  }

  async findDuplicate({ date, name, venue }) {
    await this.ready();
    const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const q = `
      SELECT * FROM event_submissions
      WHERE status <> 'rejected'
        AND payload->>'date' = $1
        AND lower(regexp_replace(coalesce(payload->>'name',''),'\\s+',' ','g')) = $2
        AND lower(regexp_replace(coalesce(payload->>'venue',''),'\\s+',' ','g')) = $3
      LIMIT 1;
    `;
    const r = await this.pool.query(q, [date, norm(name), norm(venue)]);
    return this._row(r.rows[0] || null);
  }

  async listEventEdits() {
    await this.ready();
    const r = await this.pool.query(
      'SELECT original_key, payload, created_at, updated_at FROM event_edits ORDER BY updated_at DESC'
    );
    return r.rows.map(row => ({
      id: row.original_key,
      original_key: row.original_key,
      payload: row.payload,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
    }));
  }

  async upsertEventEdit({ original_key, payload }) {
    await this.ready();
    const r = await this.pool.query(`
      INSERT INTO event_edits (original_key, payload, created_at, updated_at)
      VALUES ($1, $2, NOW(), NOW())
      ON CONFLICT (original_key) DO UPDATE
        SET payload = EXCLUDED.payload,
            updated_at = NOW()
      RETURNING original_key, payload, created_at, updated_at;
    `, [original_key, JSON.stringify(payload)]);
    const row = r.rows[0];
    return {
      id: row.original_key,
      original_key: row.original_key,
      payload: row.payload,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
    };
  }
}

// ─── FACTORY ───
export async function createStore(opts = {}) {
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      // Railway Postgres ships SSL by default; allow self-signed certs.
      ssl: databaseUrl.includes('sslmode=disable') ? false : { rejectUnauthorized: false }
    });
    const store = new PgStore(pool);
    await store.ready();
    return { kind: 'postgres', store, pool };
  }
  const file = opts.file || DEFAULT_FILE;
  return { kind: 'file', store: new FileStore(file), file };
}

export { FileStore, PgStore, newId, nowIso };
