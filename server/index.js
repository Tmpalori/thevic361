/* server/index.js — Lightweight Express server for The Vic 361.
 *
 * Responsibilities:
 *   - Public POST /api/submissions endpoint backed by Postgres (or JSON file)
 *   - Admin GET/POST /api/admin/submissions[...] gated by ADMIN_TOKEN
 *   - Serves the existing static site from /docs (so a Railway deploy can
 *     stand alone without GitHub Pages — DNS cutover is a separate decision)
 *
 * Hard rules:
 *   - Public submissions never auto-publish; everything goes to a review queue.
 *   - When TURNSTILE_SECRET_KEY is set, missing/invalid tokens are rejected.
 *   - Submitter email + IP never leave the admin scope.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore, normalizePayload, newId, nowIso } from './db.js';
import { validateSubmission, checkBotSignals } from './validate.js';
import { verifyTurnstile } from './turnstile.js';
import { createRateLimiter } from './rateLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');

export async function createApp(opts = {}) {
  const app = express();

  const adminToken = opts.adminToken ?? process.env.ADMIN_TOKEN ?? null;
  const turnstileSecret = opts.turnstileSecret ?? process.env.TURNSTILE_SECRET_KEY ?? null;
  const turnstileSiteKey = opts.turnstileSiteKey ?? process.env.TURNSTILE_SITE_KEY ?? null;
  const trustProxy = opts.trustProxy ?? true;
  if (trustProxy) app.set('trust proxy', true);

  const storeBundle = opts.storeBundle ?? await createStore({
    databaseUrl: opts.databaseUrl,
    file: opts.storageFile
  });
  const store = storeBundle.store;

  const submitLimiter = opts.submitLimiter || createRateLimiter({
    windowMs: 60 * 1000, max: 5
  });
  const submitLimiterDaily = opts.submitLimiterDaily || createRateLimiter({
    windowMs: 24 * 60 * 60 * 1000, max: 30
  });

  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  // ─── Public config (site key only — never expose secret) ───
  app.get('/api/config', (req, res) => {
    res.json({
      turnstile_site_key: turnstileSiteKey || null,
      turnstile_required: Boolean(turnstileSecret),
      storage: storeBundle.kind
    });
  });

  // ─── Health ───
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, storage: storeBundle.kind });
  });

  // ─── Public: submit ───
  app.post('/api/submissions', async (req, res) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const burst = submitLimiter.check(ip);
    if (!burst.ok) {
      res.set('Retry-After', String(burst.retryAfter || 60));
      return res.status(429).json({ ok: false, error: 'rate-limited' });
    }
    const daily = submitLimiterDaily.check(ip);
    if (!daily.ok) {
      res.set('Retry-After', String(daily.retryAfter || 3600));
      return res.status(429).json({ ok: false, error: 'rate-limited-daily' });
    }

    // Bot signals (honeypot, timing) — cheapest checks first.
    const bot = checkBotSignals(req.body || {});
    if (!bot.ok) {
      // Return 200 to bots so they don't retry/iterate; log for visibility.
      console.warn('[submissions] bot-signal-block:', bot.reason, ip);
      return res.json({ ok: true, queued: false });
    }

    const v = validateSubmission(req.body || {});
    if (!v.ok) return res.status(400).json({ ok: false, errors: v.errors });

    // Turnstile is required if a secret is configured.
    const ts = await verifyTurnstile(req.body && req.body.turnstile_token, {
      secret: turnstileSecret,
      remoteip: ip,
      fetch: opts.fetch
    });
    if (!ts.ok) {
      return res.status(400).json({ ok: false, error: 'turnstile-failed' });
    }

    const dup = await store.findDuplicate({
      date: v.data.payload.date,
      name: v.data.payload.name,
      venue: v.data.payload.venue
    });
    if (dup) {
      return res.json({
        ok: true,
        queued: false,
        duplicate: true,
        message: 'A matching submission is already in our review queue.',
        id: dup.id
      });
    }

    const now = nowIso();
    const row = {
      id: newId(),
      created_at: now,
      updated_at: now,
      status: 'pending',
      source: 'submission',
      submitter_kind: v.data.submitter_kind,
      submitter_name: v.data.submitter_name,
      submitter_email: v.data.submitter_email,
      submitter_ip: typeof ip === 'string' ? ip.slice(0, 64) : null,
      user_agent: String(req.headers['user-agent'] || '').slice(0, 256),
      payload: normalizePayload(v.data.payload),
      admin_notes: '',
      review_history: [{ at: now, action: 'submitted', note: 'Public submission' }]
    };
    await store.insert(row);
    return res.status(201).json({ ok: true, queued: true, id: row.id });
  });

  // ─── Admin auth middleware ───
  function requireAdmin(req, res, next) {
    if (!adminToken) {
      return res.status(503).json({
        ok: false,
        error: 'admin-not-configured',
        message: 'Set ADMIN_TOKEN env var to enable the submissions admin API.'
      });
    }
    const hdr = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(hdr);
    const provided = m ? m[1] : (req.headers['x-admin-token'] || '');
    if (!provided || provided !== adminToken) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    next();
  }

  // ─── Admin: list ───
  app.get('/api/admin/submissions', requireAdmin, async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const rows = await store.list({ status: status || undefined });
    res.json({ ok: true, submissions: rows });
  });

  // ─── Admin: detail ───
  app.get('/api/admin/submissions/:id', requireAdmin, async (req, res) => {
    const row = await store.get(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'not-found' });
    res.json({ ok: true, submission: row });
  });

  // ─── Admin: status transition ───
  // Body: { status, payload?, admin_notes?, note? }
  // Allowed transitions: pending -> approved|rejected|duplicate, plus edits
  // to payload while pending. "approved" rows show up as candidates the editor
  // can include in the next publish (the existing GitHub-API publish flow on
  // docs/admin.html still owns the actual events.json write).
  app.post('/api/admin/submissions/:id', requireAdmin, async (req, res) => {
    const row = await store.get(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'not-found' });

    const body = req.body || {};
    const patch = {};
    const ALLOWED = new Set(['pending', 'approved', 'rejected', 'duplicate']);
    if (body.status !== undefined) {
      if (!ALLOWED.has(body.status)) {
        return res.status(400).json({ ok: false, error: 'bad-status' });
      }
      patch.status = body.status;
    }
    if (body.payload !== undefined) {
      const v = validateSubmission(body.payload);
      if (!v.ok) return res.status(400).json({ ok: false, errors: v.errors });
      patch.payload = normalizePayload(v.data.payload);
    }
    if (typeof body.admin_notes === 'string') {
      patch.admin_notes = body.admin_notes.slice(0, 2000);
    }
    const history = Array.isArray(row.review_history) ? row.review_history.slice() : [];
    history.push({
      at: nowIso(),
      action: patch.status ? ('status:' + patch.status) : 'edit',
      note: typeof body.note === 'string' ? body.note.slice(0, 500) : ''
    });
    patch.review_history = history;

    const updated = await store.update(req.params.id, patch);
    res.json({ ok: true, submission: updated });
  });

  // ─── Admin: approved -> candidate-shaped events ───
  // Returns approved submissions in the same shape as candidates.json events
  // so the existing admin picker/publish flow can ingest them by simply
  // appending them to the candidate list before publishing.
  app.get('/api/admin/approved-events', requireAdmin, async (req, res) => {
    const rows = await store.list({ status: 'approved' });
    const events = rows.map(r => ({
      ...r.payload,
      _source: r.source || 'submission',
      _source_id: r.id,
      _submitter_kind: r.submitter_kind || null
    }));
    res.json({ ok: true, events });
  });

  // ─── Static site ───
  app.use(express.static(DOCS_DIR, { extensions: ['html'] }));

  app.get('/', (req, res, next) => {
    res.sendFile(path.join(DOCS_DIR, 'index.html'), err => {
      if (err) next(err);
    });
  });

  // ─── 404 + error handlers ───
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ ok: false, error: 'not-found' });
    }
    res.status(404).type('text/plain').send('Not found');
  });

  app.use((err, req, res, _next) => {
    console.error('[server] error:', err);
    if (req.path.startsWith('/api/')) {
      return res.status(500).json({ ok: false, error: 'server-error' });
    }
    res.status(500).type('text/plain').send('Server error');
  });

  return { app, store, storeBundle };
}

// Start the server when invoked directly. Importing this module (e.g. from
// tests) does not auto-listen.
const isMain = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch (_) { return false; }
})();

if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  createApp().then(({ app, storeBundle }) => {
    app.listen(port, () => {
      console.log(`[thevic361] listening on :${port} (storage=${storeBundle.kind})`);
    });
  }).catch(err => {
    console.error('[thevic361] failed to start:', err);
    process.exit(1);
  });
}
