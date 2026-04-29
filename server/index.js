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
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createStore, normalizePayload, newId, nowIso } from './db.js';
import { validateSubmission, checkBotSignals } from './validate.js';
import { verifyTurnstile } from './turnstile.js';
import { createRateLimiter } from './rateLimit.js';
import { createAuth } from './auth.js';
import { createGithub } from './github.js';
import { readMetadataFile, buildSourcesPayload } from './sources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const CANDIDATES_FILE = path.join(REPO_ROOT, 'candidates.json');
const COLLECTION_METADATA_FILE = path.join(REPO_ROOT, 'collection_metadata.json');
const EVENTS_FILE = path.join(DOCS_DIR, 'events.json');
const WEEKLY_COLLECT_WORKFLOW = 'weekly-collect.yml';

async function readJsonFile(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw);
}

export async function createApp(opts = {}) {
  const app = express();

  const adminToken = opts.adminToken ?? process.env.ADMIN_TOKEN ?? null;
  const turnstileSecret = opts.turnstileSecret ?? process.env.TURNSTILE_SECRET_KEY ?? null;
  const turnstileSiteKey = opts.turnstileSiteKey ?? process.env.TURNSTILE_SITE_KEY ?? null;
  const trustProxy = opts.trustProxy ?? true;
  if (trustProxy) app.set('trust proxy', true);

  // Username/password login + signed session tokens. Replaces the old
  // browser-side GitHub PAT flow. When ADMIN_USERNAME / ADMIN_PASSWORD /
  // ADMIN_SESSION_SECRET are set, /api/admin/login issues bearer tokens that
  // gate every /api/admin/* route. The legacy ADMIN_TOKEN is still accepted as
  // a fallback so existing scripts/configs keep working.
  const auth = opts.auth || createAuth({
    username: opts.adminUsername,
    password: opts.adminPassword,
    secret: opts.adminSessionSecret,
    ttlHours: opts.adminSessionTtlHours
  });

  // Server-side GitHub publisher. When GITHUB_TOKEN/GITHUB_PAT is set, the
  // admin can publish docs/events.json via /api/admin/publish-events without
  // ever holding a GitHub PAT in the browser.
  const github = opts.github || createGithub({
    token: opts.githubToken,
    owner: opts.githubOwner,
    repo: opts.githubRepo,
    branch: opts.githubBranch,
    fetch: opts.fetch
  });

  // Per-IP login throttle. 10 attempts / 15 min — enough for an admin who
  // typoes their password a few times, way too few for online brute force.
  const loginLimiter = opts.loginLimiter || createRateLimiter({
    windowMs: 15 * 60 * 1000, max: 10
  });

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
      storage: storeBundle.kind,
      // Tells the admin UI which auth flows are usable. Login is preferred;
      // legacy is a fallback for existing scripts that still post ADMIN_TOKEN.
      admin_login_enabled: auth.configured,
      admin_legacy_token_enabled: Boolean(adminToken),
      // The admin will only show the publish button when a server-side GitHub
      // token is configured. No secret value is exposed.
      github_publish_enabled: github.isConfigured(),
      github_owner: github.owner,
      github_repo: github.repo,
      github_branch: github.branch,
      // The Sources tab uses this to enable or disable the manual-pull button.
      // We piggyback on github_publish_enabled because both gates require a
      // GITHUB_TOKEN. The actual trigger endpoint also enforces this. Note:
      // this is presence-only — the token may be present but invalid; the UI
      // surfaces that distinction via the trigger-collect response.
      sources_trigger_enabled: github.isConfigured(),
      // GitHub Actions page for the Weekly Collect workflow. The admin Sources
      // tab links to this as a manual fallback when one-click Pull Now isn't
      // available (no token, invalid token, etc.).
      sources_actions_url: `https://github.com/${github.owner}/${github.repo}` +
        `/actions/workflows/${WEEKLY_COLLECT_WORKFLOW}`
    });
  });

  // ─── Admin: login ─────────────────────────────────────────────────────
  // Body: { username, password }. Returns { ok, token, expires_at } on success.
  app.post('/api/admin/login', async (req, res) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const burst = loginLimiter.check(ip);
    if (!burst.ok) {
      res.set('Retry-After', String(burst.retryAfter || 60));
      return res.status(429).json({ ok: false, error: 'rate-limited' });
    }
    if (!auth.configured) {
      return res.status(503).json({
        ok: false,
        error: 'login-not-configured',
        message: 'Set ADMIN_USERNAME, ADMIN_PASSWORD, and ADMIN_SESSION_SECRET to enable login.'
      });
    }
    const body = req.body || {};
    const result = auth.checkLogin({
      username: typeof body.username === 'string' ? body.username : '',
      password: typeof body.password === 'string' ? body.password : ''
    });
    if (!result.ok) {
      // Generic message — never disclose which field was wrong.
      return res.status(401).json({ ok: false, error: 'invalid-credentials' });
    }
    const token = auth.signToken();
    const expiresAt = new Date(Date.now() + auth.ttlMs).toISOString();
    res.json({ ok: true, token, expires_at: expiresAt });
  });

  // ─── Admin: who am I ──────────────────────────────────────────────────
  // Lets the UI silently confirm a stored session is still valid before
  // showing the dashboard, instead of pinging /api/admin/submissions just to
  // probe auth.
  app.get('/api/admin/me', (req, res) => {
    const ok = checkAdminAuth(req);
    if (!ok.ok) return res.status(401).json({ ok: false, error: ok.reason });
    res.json({ ok: true, kind: ok.kind, sub: ok.sub || null });
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

  // ─── Admin auth middleware ─────────────────────────────────────────────
  // Two acceptable credentials, in priority order:
  //   1. Session token from /api/admin/login (ADMIN_USERNAME / PASSWORD /
  //      SESSION_SECRET). Preferred.
  //   2. Legacy ADMIN_TOKEN (kept so existing scripts still work).
  // If *neither* is configured the API returns 503 so the UI can prompt the
  // operator to finish env setup instead of looking like a generic 401.
  function checkAdminAuth(req) {
    const hdr = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(hdr);
    const provided = m ? m[1] : (req.headers['x-admin-token'] || '');
    if (!provided) return { ok: false, reason: 'missing-credentials' };

    if (auth.configured) {
      const v = auth.verifyToken(provided);
      if (v.ok) return { ok: true, kind: 'session', sub: v.payload.sub };
      // Fall through to legacy token check before giving up.
    }
    if (adminToken && provided === adminToken) {
      return { ok: true, kind: 'legacy-token' };
    }
    return { ok: false, reason: 'unauthorized' };
  }

  function requireAdmin(req, res, next) {
    if (!auth.configured && !adminToken) {
      return res.status(503).json({
        ok: false,
        error: 'admin-not-configured',
        message: 'Set ADMIN_USERNAME + ADMIN_PASSWORD + ADMIN_SESSION_SECRET (recommended) or ADMIN_TOKEN to enable admin endpoints.'
      });
    }
    const result = checkAdminAuth(req);
    if (!result.ok) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    req.admin = { kind: result.kind, sub: result.sub || null };
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
      // Admin edits run validation in lenient mode for submitter contact
      // fields. The public form still enforces first/last/email/phone, but a
      // legacy row created before PR #32 doesn't have those fields and an
      // admin shouldn't have to retype someone else's info to fix a typo on
      // the venue. Format checks (email shape, phone digit count) still run
      // when a value is present. The row-level submitter_email and
      // submitter_name are preserved by leaving them out of the patch.
      const v = validateSubmission(body.payload, { adminEdit: true });
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

  // ─── Admin: candidates fetch ──────────────────────────────────────────
  // Tries GitHub first (so the editor sees the latest candidates.json), then
  // falls back to the bundled candidates.json on disk if the token is missing
  // or the GitHub API rejects us. The fallback keeps the admin usable on
  // Railway when GITHUB_TOKEN is unset or expired — the editor can still
  // pick events and publish them; only the GitHub commit step needs the
  // token.
  //
  // Approved submissions from the local store are *always* merged in so the
  // editor sees them in the picker without needing a separate "Pull approved"
  // round trip.
  app.get('/api/admin/candidates', requireAdmin, async (req, res) => {
    let sha = null;
    let events = [];
    let source = 'unknown';
    let warning = null;

    if (github.isConfigured()) {
      try {
        const got = await github.getJsonFile('candidates.json');
        sha = got.sha;
        events = Array.isArray(got.data && got.data.events) ? got.data.events : [];
        source = 'github';
      } catch (err) {
        console.warn('[admin] candidates github fetch failed, falling back to local file:', err.message);
        warning = `github-fetch-failed-${err.status || 'error'}`;
      }
    }

    if (source !== 'github') {
      try {
        const local = await readJsonFile(CANDIDATES_FILE);
        events = Array.isArray(local && local.events) ? local.events : [];
        source = 'local-file';
      } catch (err) {
        if (err.code === 'ENOENT') {
          source = 'empty';
          events = [];
        } else {
          console.error('[admin] local candidates read failed:', err.message);
          return res.status(500).json({
            ok: false, error: 'candidates-read-failed', message: err.message
          });
        }
      }
    }

    // Merge approved submissions so the editor sees them in the picker.
    try {
      const approved = await store.list({ status: 'approved' });
      const seen = new Set(events.map(e =>
        [e.date || '', e.name || '', e.venue || ''].join('|')
      ));
      for (const r of approved) {
        const ev = {
          ...r.payload,
          _source: r.source || 'submission',
          _source_id: r.id,
          _submitter_kind: r.submitter_kind || null
        };
        const k = [ev.date || '', ev.name || '', ev.venue || ''].join('|');
        if (seen.has(k)) continue;
        seen.add(k);
        events.push(ev);
      }
    } catch (err) {
      console.warn('[admin] approved submissions merge skipped:', err.message);
    }

    res.json({
      ok: true,
      sha,
      source,
      warning,
      data: { events }
    });
  });

  // ─── Admin: publish events.json ───────────────────────────────────────
  // Body: { events: [...], message?: "..." [, extras: {...}] }
  //
  // Behavior:
  //   1. Always saves the payload to the local store (Postgres or JSON file)
  //      so the Railway app's public events at /events.json reflects the new
  //      picks immediately, without depending on GitHub.
  //   2. If GITHUB_TOKEN is configured, also commits docs/events.json on the
  //      configured branch via the Contents API. Failures here are surfaced
  //      but do NOT fail the request — the local save already succeeded and
  //      the public site is updated.
  //   3. Preserves top-level extras like `new_and_notable` and `sponsor`.
  //      The admin UI only edits the events list; if the request body does
  //      not include `extras`, we carry forward whatever was on the most
  //      recent published payload (Railway Postgres, then the bundled
  //      docs/events.json fallback). This stops events-only publishes from
  //      silently wiping out the New & Notable section and the sponsor
  //      block. Callers can also send `extras: { new_and_notable, sponsor }`
  //      explicitly to update them.
  app.post('/api/admin/publish-events', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const events = Array.isArray(body.events) ? body.events : null;
    if (!events) {
      return res.status(400).json({ ok: false, error: 'bad-payload', message: 'events[] required' });
    }

    // Carry-forward top-level extras (new_and_notable, sponsor, …) so an
    // events-only Save & Publish doesn't drop them. Priority order:
    //   1. body.extras (caller explicitly provided them)
    //   2. last published payload from the store
    //   3. bundled docs/events.json on disk
    const PROTECTED_KEYS = new Set(['last_updated', 'events']);
    const extras = {};
    const explicit = (body.extras && typeof body.extras === 'object' && !Array.isArray(body.extras))
      ? body.extras : null;
    if (explicit) {
      for (const [k, v] of Object.entries(explicit)) {
        if (!PROTECTED_KEYS.has(k)) extras[k] = v;
      }
    } else {
      // Try previously published first.
      let prior = null;
      try { prior = await store.getPublished(); }
      catch (err) { console.warn('[admin] prior published lookup failed:', err.message); }
      if (!prior) {
        // Fall back to the bundled snapshot.
        try { prior = await readJsonFile(EVENTS_FILE); }
        catch (_) { prior = null; }
      }
      if (prior && typeof prior === 'object') {
        for (const [k, v] of Object.entries(prior)) {
          if (!PROTECTED_KEYS.has(k)) extras[k] = v;
        }
      }
    }

    const payload = Object.assign({}, extras, {
      last_updated: new Date().toISOString(),
      events
    });

    // Step 1 — local persistence. This is what makes the Railway public site
    // reflect the new picks regardless of GitHub state.
    try {
      await store.setPublished(payload);
    } catch (err) {
      console.error('[admin] local publish save failed:', err.message);
      return res.status(500).json({
        ok: false, error: 'local-publish-failed', message: err.message
      });
    }

    const result = {
      ok: true,
      published: events.length,
      destinations: { local: { ok: true } }
    };

    // Step 2 — best-effort GitHub commit. Only attempted when configured.
    if (github.isConfigured()) {
      let sha = null;
      try {
        const cur = await github.getJsonFile('docs/events.json');
        sha = cur.sha;
      } catch (err) {
        if (err.status !== 404) {
          console.warn('[admin] events.json sha fetch failed:', err.message);
        }
      }
      const message = (typeof body.message === 'string' && body.message.trim())
        ? body.message.trim().slice(0, 200)
        : `Publish events ${new Date().toISOString().slice(0, 10)} (${events.length} picks)`;
      try {
        const gh = await github.putJsonFile('docs/events.json', payload, message, sha);
        result.destinations.github = {
          ok: true,
          commit: gh && gh.commit ? {
            sha: gh.commit.sha,
            html_url: gh.commit.html_url
          } : null
        };
        result.commit = result.destinations.github.commit;
      } catch (err) {
        console.error('[admin] github publish failed (local save still succeeded):', err.message);
        result.destinations.github = {
          ok: false,
          error: 'publish-failed',
          message: err.detail || err.message
        };
        result.warning = 'github-publish-failed';
      }
    } else {
      result.destinations.github = {
        ok: false,
        error: 'github-not-configured',
        message: 'GITHUB_TOKEN is not set; events were saved to Railway but not committed to GitHub.'
      };
    }

    res.json(result);
  });

  // ─── Admin: currently-published events ───
  // Returns the events payload that is currently being served on /events.json,
  // pulled from the local store (Railway/Postgres). The admin UI uses this to
  // pre-check candidates that are already live, so a fresh login still shows
  // what was previously published instead of every checkbox starting empty.
  // If nothing has been published locally yet (rare on a fresh deploy), we
  // return an empty events list — the admin treats that the same as "nothing
  // currently live."
  app.get('/api/admin/published-events', requireAdmin, async (req, res) => {
    try {
      const published = await store.getPublished();
      if (!published) {
        return res.json({ ok: true, events: [], last_updated: null });
      }
      res.json({
        ok: true,
        events: Array.isArray(published.events) ? published.events : [],
        last_updated: published.last_updated || null
      });
    } catch (err) {
      console.error('[admin] published-events lookup failed:', err.message);
      res.status(500).json({
        ok: false,
        error: 'published-lookup-failed',
        message: err.message
      });
    }
  });

  // ─── Admin: per-source pull status ───────────────────────────────────
  // Returns a compact summary of what the weekly collector pulled this run,
  // which sources fed the candidate list, when each one was pulled, and
  // when the next auto-pull is due. The admin "Sources" tab consumes this.
  //
  // The data comes from `collection_metadata.json` (written next to
  // candidates.json by collect_events.py). If the file is missing — e.g.
  // before the first weekly run after this code ships — we still return a
  // useful payload with placeholder rows + the next scheduled run time.
  // Public Actions URL for the Weekly Collect workflow. Used both as a
  // graceful fallback in 401/503 responses and as a help link the UI can
  // always show ("Run workflow on GitHub").
  function actionsUrl() {
    return `https://github.com/${github.owner}/${github.repo}` +
      `/actions/workflows/${WEEKLY_COLLECT_WORKFLOW}`;
  }

  const metadataFile = opts.collectionMetadataFile || COLLECTION_METADATA_FILE;
  app.get('/api/admin/sources', requireAdmin, async (req, res) => {
    try {
      const read = await readMetadataFile(metadataFile);
      const payload = buildSourcesPayload({
        metadata: read ? read.meta : null,
        mtime: read ? read.mtime : null,
        now: new Date(),
        githubConfigured: github.isConfigured(),
        actionsUrl: actionsUrl(),
      });
      res.json(payload);
    } catch (err) {
      console.error('[admin] sources lookup failed:', err.message);
      res.status(500).json({ ok: false, error: 'sources-failed', message: err.message });
    }
  });

  // ─── Admin: trigger weekly collect workflow ───────────────────────────
  // POST /api/admin/trigger-collect
  // Fires a workflow_dispatch on the Weekly Collect GitHub Actions workflow.
  // Requires GITHUB_TOKEN with `actions:write` scope. Degrades clearly when
  // the token is missing (503 + diagnostic message) so the UI can disable
  // the button instead of silently failing.
  //
  // Failure-mode contract (consumed by the admin Sources tab):
  //   error: 'github-not-configured'  -> no token at all (503)
  //   error: 'github-token-invalid'   -> 401 Bad credentials (token stale/revoked)
  //   error: 'dispatch-failed'        -> 403/404/etc, original github_status returned
  // In every case we include `actions_url` so the UI can offer a manual fallback,
  // and a `save_publish_unaffected: true` flag so the UI never implies that the
  // public site failed to publish — Save & Publish does not depend on this token.
  app.post('/api/admin/trigger-collect', requireAdmin, async (req, res) => {
    if (!github.isConfigured()) {
      return res.status(503).json({
        ok: false,
        error: 'github-not-configured',
        message: 'No server-side GitHub token is configured, so one-click Pull Now is disabled. You can still run the Weekly Collect workflow manually on GitHub. Save & Publish is unaffected.',
        actions_url: actionsUrl(),
        save_publish_unaffected: true
      });
    }
    try {
      await github.dispatchWorkflow(WEEKLY_COLLECT_WORKFLOW, github.branch);
      res.json({
        ok: true,
        workflow: WEEKLY_COLLECT_WORKFLOW,
        ref: github.branch,
        message: 'Weekly Collect workflow dispatched. Refresh in a minute or two to see updated counts.',
        actions_url: actionsUrl()
      });
    } catch (err) {
      console.error('[admin] trigger-collect failed:', err.message);
      // 401 = the GITHUB_TOKEN on the server is invalid/expired/revoked. Surface
      // this as a recognizable "token-invalid" state so the UI can render
      // friendly copy and a fallback link instead of a raw "Bad credentials".
      if (err.status === 401) {
        return res.status(401).json({
          ok: false,
          error: 'github-token-invalid',
          github_status: 401,
          message: 'The server\'s GITHUB_TOKEN is invalid or expired, so one-click Pull Now can\'t dispatch the workflow. You can still run the Weekly Collect workflow manually on GitHub using your normal login. Save & Publish is unaffected — only the one-click Pull Now button needs this token.',
          actions_url: actionsUrl(),
          save_publish_unaffected: true
        });
      }
      // 403 typically means the token lacks `actions:write`. 404 = workflow
      // file not found on the configured branch. Both are useful to surface.
      const status = (err.status === 403 || err.status === 404) ? err.status : 502;
      res.status(status).json({
        ok: false,
        error: 'dispatch-failed',
        github_status: err.status || null,
        message: err.detail || err.message,
        actions_url: actionsUrl(),
        save_publish_unaffected: true
      });
    }
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

  // ─── Public events feed ───────────────────────────────────────────────
  // The static site at /index.html fetches `./events.json`. When the admin
  // publishes via /api/admin/publish-events we always save to the local
  // store (regardless of whether the GitHub commit also succeeded), so this
  // route serves the freshest copy if one exists. Otherwise we fall through
  // to the bundled docs/events.json from the deploy.
  async function serveEventsJson(req, res, next) {
    try {
      const published = await store.getPublished();
      if (published) {
        res.set('Cache-Control', 'no-store');
        return res.json(published);
      }
    } catch (err) {
      console.warn('[events] published lookup failed:', err.message);
    }
    next();
  }
  app.get('/events.json', serveEventsJson);
  app.get('/docs/events.json', serveEventsJson);

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
