/* server/index.js — Lightweight Express server for The Vic 361.
 *
 * Responsibilities:
 *   - Public POST /api/submissions endpoint backed by Postgres (or JSON file)
 *   - Admin GET/POST /api/admin/submissions[...] gated by ADMIN_TOKEN
 *   - Serves the existing static site from /docs (so a Railway deploy can
 *     stand alone without GitHub Pages — DNS cutover is a separate decision)
 *
 * Hard rules:
 *   - Public submissions go to a review queue; the AI review
 *     (server/submissionReview.js) publishes the clean ones and flags the rest.
 *   - When TURNSTILE_SECRET_KEY is set, missing/invalid tokens are rejected.
 *   - Submitter email + IP never leave the admin scope.
 */

import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createStore, normalizePayload, newId, nowIso, applyEventEdits, eventKeyOf, withoutSubmitter } from './db.js';
import { validateSubmission, validateEventEdit, checkBotSignals } from './validate.js';
import { verifyTurnstile } from './turnstile.js';
import { createRateLimiter } from './rateLimit.js';
import { createAuth } from './auth.js';
import { createGithub } from './github.js';
import { readMetadataFile, buildSourcesPayload } from './sources.js';
import { crawlerMiddleware, beaconRow, summarize } from './analytics.js';
import { pixelId, metaPixelJs } from './metaPixel.js';
import { registerEventCheck, withoutHidden, visibleKeyed, stripKeys } from './eventcheck.js';
import { newsletterConfig, createResend, registerNewsletter, signupFormHtml } from './newsletter.js';
import { createMailer, renderSubmissionReceived, renderSubmissionLive } from './notify.js';
import { registerSubmissionReview, isPaidPick } from './submissionReview.js';
import { stripeConfig, createStripe, createSponsors, samplePreviews, renderLogoTooLargePage, sameEvent } from './sponsors.js';
import { slackConfig, createSlack } from './slack.js';
import { registerContact } from './contact.js';
import { renderEventCard, eventCardVersion } from './ogImage.js';
import { createAutoPublish, unpublishEvent, replacePublishedEvent, forgetRemoved } from './autopublish.js';
import crypto from 'node:crypto';
import net from 'node:net';
import {
  HUB_PAGES, localDateStr, withPages, renderHome, renderHubPage, renderEventPage,
  renderAboutPage, renderPrivacyPage, renderAdvertisePage, renderNotFoundPage, renderSitemap, renderLlmsTxt
  , fillSeasonalNav
} from './seo.js';
import {
  buildVenues, venueFor, renderVenuePage, renderVenueIndex, venuesWithEvents,
  SEASONS, activeSeasons, renderSeasonPage, renderIcs, eventActionsHtml
} from './guides.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const CANDIDATES_FILE = path.join(REPO_ROOT, 'candidates.json');
const COLLECTION_METADATA_FILE = path.join(REPO_ROOT, 'collection_metadata.json');
const EVENTS_FILE = path.join(DOCS_DIR, 'events.json');
const VENUES_FILE = path.join(REPO_ROOT, 'venues.json');
const WEEKLY_COLLECT_WORKFLOW = 'weekly-collect.yml';

const BASE_CSP = "frame-ancestors 'self'; object-src 'none'; base-uri 'self'";

// The admin page keeps its session token in localStorage, so it gets a
// script CSP: only its own files and its inline theme snippet (allowed by
// hash, computed here so editing the snippet can't silently break it) may
// run. It loads no analytics, pixel or Turnstile.
async function adminPageCsp() {
  let html = '';
  try { html = await fsp.readFile(path.join(DOCS_DIR, 'admin.html'), 'utf8'); } catch (_) { /* no admin page */ }
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => ` 'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  return `script-src 'self'${hashes.join('')}; ${BASE_CSP}`;
}

async function readJsonFile(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw);
}

function safeTokenEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

export async function createApp(opts = {}) {
  const app = express();

  const adminToken = opts.adminToken ?? process.env.ADMIN_TOKEN ?? null;
  const turnstileSecret = opts.turnstileSecret ?? process.env.TURNSTILE_SECRET_KEY ?? null;
  const turnstileSiteKey = opts.turnstileSiteKey ?? process.env.TURNSTILE_SITE_KEY ?? null;
  // Railway's edge is the one proxy in front of us. Trusting exactly one hop
  // makes req.ip the address Railway saw; `true` would trust the left-most
  // X-Forwarded-For entry, which any client can set to dodge rate limits.
  const trustProxy = opts.trustProxy ?? 1;
  if (trustProxy) app.set('trust proxy', trustProxy === true ? 1 : trustProxy);
  // On Railway the edge sets X-Real-IP to the visitor's address
  // (docs.railway.com: Public Networking > Specs & Limits); prefer it so the
  // rate limits key on the real client however many hops sit in between.
  if (trustProxy && (opts.railway ?? Boolean(process.env.RAILWAY_ENVIRONMENT_NAME))) {
    app.use((req, res, next) => {
      const real = String(req.headers['x-real-ip'] || '').trim();
      if (net.isIP(real)) Object.defineProperty(req, 'ip', { value: real, configurable: true });
      next();
    });
  }

  // Canonical host. www.thevic361.com is where Google already indexes the
  // site and where all real traffic lands; the bare domain 301s to it so
  // search engines see one site instead of two copies.
  const siteUrl = (opts.siteUrl ?? process.env.SITE_URL ?? 'https://www.thevic361.com').replace(/\/+$/, '');
  // Owner pings in Slack (server/slack.js); a no-op until SLACK_WEBHOOK_URL is set.
  const slack = opts.slack || createSlack(slackConfig(process.env, opts));
  const canonicalHost = new URL(siteUrl).host;
  const apexHost = canonicalHost.replace(/^www\./, '');
  app.use((req, res, next) => {
    // Squarespace's domain forwarding (which answers the bare domain)
    // sends thevic361.com/about to www.thevic361.com//about, which no route
    // matches. Collapse the leading slashes. The result always starts with
    // a single "/", so it stays on this site (never "//evil.example").
    const url = req.originalUrl.replace(/^\/{2,}/, '/');
    if (apexHost !== canonicalHost && req.hostname === apexHost) {
      return res.redirect(301, siteUrl + url);
    }
    if (url !== req.originalUrl) return res.redirect(301, url);
    next();
  });

  // Baseline security headers. Public pages get no script CSP: they rely on
  // inline scripts (GA bootstrap, JSON-LD, page scripts in seo.js and
  // sponsors.js), inline onload/onclick handlers, Google Analytics, the Meta
  // Pixel and Turnstile, so a useful script-src needs per-response nonces
  // and no inline handlers first. Their CSP only locks down framing,
  // plugins and <base> hijacking; the admin page gets script-src too.
  app.disable('x-powered-by');
  const adminCsp = await adminPageCsp();
  app.use((req, res, next) => {
    const isAdminPage = req.path === '/admin.html' || req.path === '/admin';
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'SAMEORIGIN',
      'Strict-Transport-Security': 'max-age=31536000',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': isAdminPage ? adminCsp : BASE_CSP
    });
    next();
  });

  app.use(compression());

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

  // Note crawler hits on public pages for the admin Traffic tab. Registered
  // before every route so it sees the server-rendered pages too.
  if (typeof store.recordTraffic === 'function') app.use(crawlerMiddleware(store, () => (opts.now || (() => new Date()))()));

  const submitLimiter = opts.submitLimiter || createRateLimiter({
    windowMs: 60 * 1000, max: 5
  });
  const submitLimiterDaily = opts.submitLimiterDaily || createRateLimiter({
    windowMs: 24 * 60 * 60 * 1000, max: 30
  });
  // "We got it" emails per recipient address, whatever IP sends the form.
  const receiptLimiter = createRateLimiter({ windowMs: 24 * 60 * 60 * 1000, max: 3 });

  // ─── Sponsor checkout (Stripe; see server/sponsors.js) ───
  // Created here because the Stripe webhook needs the raw body and so must
  // be registered before the JSON parser below. Its page routes come later.
  const stripeCfg = stripeConfig(process.env, opts);
  // Resend: the newsletter and the "we got it" emails (server/notify.js).
  const newsletter = newsletterConfig(process.env, opts);
  const nlResend = opts.resend || createResend(newsletter.apiKey);
  const mailer = createMailer({ resend: nlResend, config: newsletter });

  const sponsors = createSponsors({
    store, siteUrl, config: stripeCfg, slack, mailer, mailAddress: newsletter.address,
    nowFn: () => (opts.now || (() => new Date()))(),
    stripe: opts.stripe || createStripe(stripeCfg.secretKey),
    getVenues: () => venues,
    // The public events before placements, to show in the Sponsors tab when
    // a paid Vic's Pick isn't on the site.
    getPayload: () => loadPublicPayload()
  });
  sponsors.registerWebhook(app);

  // The admin's sponsor edit can carry a new logo (a data URL, shrunk in
  // the browser), so it alone gets a bigger JSON limit.
  const smallJson = express.json({ limit: '64kb' });
  const sponsorEditJson = express.json({ limit: '600kb' });
  app.use((req, res, next) => (/^\/api\/admin\/sponsors\/[^/]+$/.test(req.path) ? sponsorEditJson : smallJson)(req, res, next));
  // The sponsor checkout form can carry a logo (a data URL, shrunk in the
  // browser), so it alone gets a bigger limit.
  const smallForms = express.urlencoded({ extended: false, limit: '64kb' });
  const checkoutForm = express.urlencoded({ extended: false, limit: '600kb' });
  app.use((req, res, next) => (req.path === '/advertise/checkout' ? checkoutForm : smallForms)(req, res, next));

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

  // Vic's Pick checkout prefilled with a submission's event and contact
  // (by its id; server/sponsors.js fills them in, so none of it is in the URL).
  function upgradeUrlFor(row) {
    return `${siteUrl}/advertise/checkout?package=featured&from=${encodeURIComponent(row.id)}`;
  }

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
        message: 'A matching submission is already in our review queue.'
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
    const ev = row.payload;
    slack.notify({
      title: '📝 New event submitted',
      fields: [['Event', ev.name], ['When', [ev.date, ev.time].filter(Boolean).join(' ')], ['Venue', ev.venue],
        ['From', [row.submitter_name, row.submitter_email].filter(Boolean).join(' · ')]],
      text: ev.description ? ev.description.slice(0, 300) : '',
      link: `${siteUrl}/admin.html`, footer: 'The AI review will publish it or flag it for you, usually within the hour'
    });
    // Tell them it worked and what happens next (no-op without Resend).
    if (row.submitter_email && receiptLimiter.check(row.submitter_email.toLowerCase()).ok) {
      const mail = renderSubmissionReceived(ev, { siteUrl, address: newsletter.address, upgradeUrl: upgradeUrlFor(row) });
      mailer.send(row.submitter_email, mail, `vic361-submission-${row.id}`);
    }
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
    if (adminToken && provided && safeTokenEqual(provided, adminToken)) {
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
    const oldKey = eventKeyOf(row.payload || {});
    const rekeyed = Boolean(patch.payload) && eventKeyOf(patch.payload) !== oldKey;
    const history = Array.isArray(row.review_history) ? row.review_history.slice() : [];
    history.push({
      at: nowIso(),
      action: patch.status ? ('status:' + patch.status) : 'edit',
      note: typeof body.note === 'string' ? body.note.slice(0, 500) : '',
      // The key it had before this edit, so a later un-approve can still
      // find the live event if it kept the old one.
      ...(rekeyed ? { prev_key: oldKey } : {})
    });
    patch.review_history = history;

    const now = (opts.now || (() => new Date()))();
    const wasApproved = row.status === 'approved';
    const isApproved = (patch.status || row.status) === 'approved';
    const updated = await store.update(req.params.id, patch);
    const result = { ok: true, submission: updated, unpublished: false };

    // Editing an approved (live) submission updates the live event too.
    if (wasApproved && isApproved && patch.payload) {
      try {
        result.updated_live = await replacePublishedEvent(store, oldKey, patch.payload, now);
        if (result.updated_live) archiveEvents(((await store.getPublished()) || {}).events || []);
      } catch (err) {
        console.warn('[admin] live update after edit failed:', err.message);
        result.updated_live = false;
      }
    }

    // Un-approving takes it off the site too (it may have gone live through
    // auto-publish or the AI review); otherwise it would stay published.
    // Tries every key it has had, so an edit before the reject can't leave
    // the old version up.
    if (wasApproved && !isApproved) {
      const keys = [oldKey, eventKeyOf((updated || {}).payload || {}),
        ...history.map(h => h && h.prev_key).filter(Boolean)];
      try {
        result.unpublished = await unpublishEvent(store, keys, now);
      } catch (err) {
        console.warn('[admin] unpublish after un-approve failed:', err.message);
      }
    }
    // Someone paid for this one: turning it away needs a refund or a fix.
    if (isPaidPick(row) && (patch.status === 'rejected' || patch.status === 'duplicate') && patch.status !== row.status) {
      slack.notify({ channel: 'sales', title: `⚠️ Paid Vic’s Pick marked ${patch.status}: ${(row.payload || {}).name}`,
        text: `${row.submitter_name || 'The buyer'} (${row.submitter_email || 'no email'}) paid for this pick. ` +
          (patch.status === 'duplicate'
            ? 'Check the Sponsors tab shows it on the site (the pin has to find the listed event); if not, refund it in Stripe.'
            : 'Refund it in Stripe and hide the order in the Sponsors tab.'),
        link: `${siteUrl}/admin.html` });
    }

    // Approving by hand publishes it now (approved submissions only, like
    // the AI review) and emails the submitter once it's live.
    if (!wasApproved && isApproved && updated) {
      try { await forgetRemoved(store, eventKeyOf(updated.payload || {})); } catch (err) {
        console.warn('[admin] clearing removed mark failed:', err.message);
      }
      const res2 = await publishApproved([updated]);
      result.published = res2.published;
      result.live = res2.live[0];
    }
    res.json(result);
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
  const candidatesFile = opts.candidatesFile || CANDIDATES_FILE;
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
        const local = await readJsonFile(candidatesFile);
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
          ...withoutSubmitter(r.payload),
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

    // Apply admin event-edits overlay last so the editor sees the corrected
    // version of every candidate, regardless of source. Failures here are
    // best-effort — without overlays the admin still sees the raw events.
    let edits = [];
    try {
      edits = await store.listEventEdits();
    } catch (err) {
      console.warn('[admin] event_edits list failed:', err.message);
    }
    events = applyEventEdits(events, edits);

    res.json({
      ok: true,
      sha,
      source,
      warning,
      data: { events }
    });
  });

  // ─── Admin: edit a candidate event ────────────────────────────────────
  // POST /api/admin/event-edits
  // Body: { original_key, payload: { name, date, time, end_time, venue,
  //         address, description, url, icons, free } }
  //
  // The original_key is the eventKey (date|name|venue) of the candidate row
  // the admin is correcting; the server uses it to attach the edit to the
  // right source row even when the admin changes the date/name/venue. The
  // overlay is applied automatically in /api/admin/candidates and
  // /api/admin/published-events so the picker, preview, newsletter, and
  // published shape all stay in sync — without duplicating the row.
  //
  // This endpoint never publishes to the public site by itself. The admin
  // still has to hit Save & Publish to push the corrected event live, which
  // preserves the existing approval/publish workflow.
  app.post('/api/admin/event-edits', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const original_key = typeof body.original_key === 'string'
      ? body.original_key.trim().slice(0, 600)
      : '';
    if (!original_key || original_key.split('|').length !== 3) {
      return res.status(400).json({
        ok: false,
        error: 'bad-original-key',
        message: 'original_key must be "date|name|venue".'
      });
    }
    const v = validateEventEdit(body.payload || {});
    if (!v.ok) return res.status(400).json({ ok: false, errors: v.errors });

    try {
      const row = await store.upsertEventEdit({
        original_key,
        payload: v.data
      });
      // The edit can rename a live event (new page URL); archive it now so
      // that URL keeps working after the week rotates out.
      store.getPublished().then(p => p && archiveEvents(p.events)).catch(() => {});
      res.json({
        ok: true,
        edit: row,
        new_key: eventKeyOf(v.data)
      });
    } catch (err) {
      console.error('[admin] event-edit upsert failed:', err.message);
      res.status(500).json({
        ok: false, error: 'event-edit-failed', message: err.message
      });
    }
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
    // The editor sends the version of the live list it started from. If
    // something published since (an AI-approved submission, a collect run),
    // publishing this older picture would silently take those events down,
    // so refuse; the editor reloads the live list and keeps its changes.
    if (typeof body.based_on === 'string' && body.based_on) {
      let current = null;
      try { current = await store.getPublished(); } catch (_) { current = null; }
      if (current && current.last_updated && current.last_updated !== body.based_on) {
        return res.status(409).json({ ok: false, error: 'stale',
          message: 'New events went live since you opened this page. The list has been reloaded with your changes kept; check it and publish again.' });
      }
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
      archiveEvents(events);
    } catch (err) {
      console.error('[admin] local publish save failed:', err.message);
      return res.status(500).json({
        ok: false, error: 'local-publish-failed', message: err.message
      });
    }

    const result = {
      ok: true,
      published: events.length,
      last_updated: payload.last_updated,
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

  const eventsFile = opts.eventsFile || EVENTS_FILE;
  // ─── Admin: currently-published events ───
  // Returns the events payload that is currently being served on /events.json
  // so the admin picker can pre-check rows that are already live. Source
  // priority:
  //   1. Local store (Railway/Postgres). This is what the public site is
  //      actually serving for any session that has hit Save & Publish since
  //      Railway took over publishing.
  //   2. Bundled docs/events.json on disk. This is the source of truth when
  //      the admin hasn't published since PR #47 deployed (so the local store
  //      is empty), but the public site still shows whatever the most recent
  //      GitHub publish committed to docs/events.json.
  // Without the file fallback, a fresh deploy with a non-empty docs/events.json
  // and an empty Railway store would show every published event as unchecked
  // in the admin — which is exactly what the user reported.
  app.get('/api/admin/published-events', requireAdmin, async (req, res) => {
    try {
      let published = null;
      let source = 'store';
      try {
        published = await store.getPublished();
      } catch (err) {
        console.warn('[admin] published-events store lookup failed:', err.message);
      }
      if (!published) {
        // Fall back to the bundled events.json snapshot. This is the file
        // GitHub Pages / Railway statically served before Railway took over
        // publishing, and it remains a faithful picture of "currently live"
        // until the admin hits Save & Publish under the new flow.
        try {
          const bundled = await readJsonFile(eventsFile);
          if (bundled && Array.isArray(bundled.events)) {
            published = bundled;
            source = 'docs-file';
          }
        } catch (err) {
          if (err.code !== 'ENOENT') {
            console.warn('[admin] published-events file fallback failed:', err.message);
          }
        }
      }
      if (!published) {
        return res.json({
          ok: true, events: [], last_updated: null, source: 'empty'
        });
      }
      let events = Array.isArray(published.events) ? published.events : [];
      // Apply the same admin edits overlay so a correction made in the editor
      // shows up immediately on the live site for every event whose published
      // identity still matches the overlay's original_key. New picks go
      // through publish-events and already store the edited shape there.
      try {
        const edits = await store.listEventEdits();
        events = applyEventEdits(events, edits);
      } catch (err) {
        console.warn('[admin] published-events overlay skipped:', err.message);
      }
      res.json({
        ok: true,
        events,
        last_updated: published.last_updated || null,
        source
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
    let events = rows.map(r => ({
      ...withoutSubmitter(r.payload),
      _source: r.source || 'submission',
      _source_id: r.id,
      _submitter_kind: r.submitter_kind || null
    }));
    try {
      const edits = await store.listEventEdits();
      events = applyEventEdits(events, edits);
    } catch (err) {
      console.warn('[admin] approved-events overlay skipped:', err.message);
    }
    res.json({ ok: true, events });
  });

  // ─── Traffic (admin Traffic tab, see server/analytics.js) ───
  // Daily visitor hashes are salted with a server secret so they can't be
  // reversed to an IP. A random salt (when no secret is set) just means
  // visitor counts reset on restart.
  const analyticsSecret = opts.analyticsSecret ?? process.env.ADMIN_SESSION_SECRET ?? crypto.randomBytes(16).toString('hex');
  const trackLimiter = opts.trackLimiter || createRateLimiter({ windowMs: 60 * 1000, max: 120 });

  app.post('/api/track', async (req, res) => {
    // Always 204: the beacon never waits on or reacts to the answer.
    res.status(204).end();
    if (typeof store.recordTraffic !== 'function') return;
    const ip = req.ip || req.socket.remoteAddress || '';
    if (!trackLimiter.check(ip).ok) return;
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return; } }
    const row = beaconRow(body, {
      ip, ua: req.get('user-agent') || '', secret: analyticsSecret,
      siteHost: new URL(siteUrl).host, now: nowFn()
    });
    if (!row) return;
    try { await store.recordTraffic(row); } catch (err) {
      console.warn('[traffic] record failed:', err.message);
    }
  });

  // Meta Pixel for ads (server/metaPixel.js). Short cache so setting or
  // changing META_PIXEL_ID takes effect within minutes of a redeploy.
  const metaPixelScript = metaPixelJs(pixelId(opts.metaPixelId ?? process.env.META_PIXEL_ID));
  app.get('/pixel.js', (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'public, max-age=300').send(metaPixelScript);
  });

  app.get('/api/admin/traffic', requireAdmin, async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    if (typeof store.listTraffic !== 'function') return res.json({ ok: false, error: 'not-supported' });
    try {
      const now = nowFn();
      const since = new Date(now.getTime() - (days + 1) * 86400000).toISOString().slice(0, 10);
      const rows = await store.listTraffic(since);
      res.set('Cache-Control', 'no-store');
      res.json(summarize(rows, { now, days }));
    } catch (err) {
      console.error('[traffic] summary failed:', err.message);
      res.status(500).json({ ok: false, error: 'traffic-failed', message: err.message });
    }
  });

  // ─── Public events feed ───
  // The live payload is the published row in the store (with the admin
  // event-edits overlay applied). When nothing has been published yet we
  // fall back to the bundled docs/events.json from the deploy. Both the
  // JSON feed and the server-rendered pages below read through here so
  // they always agree.
  // Paid placements (sponsor of the week, featured events, venue partners)
  // are layered on at read time so every consumer sees the same thing.
  async function getPublicPayload() {
    return sponsors.apply(await loadPublicPayload());
  }

  // The public events of a published payload, with the edits overlay
  // applied and hidden events left out, still carrying original keys.
  async function visibleFrom(published) {
    let edits = [];
    try {
      edits = await store.listEventEdits();
    } catch (err) {
      console.warn('[events] overlay skipped:', err.message);
    }
    return visibleKeyed(published, edits);
  }

  async function loadPublicPayload() {
    try {
      const published = await store.getPublished();
      if (published) {
        // The published payload keeps original event identities; the
        // overlay maps original_key -> corrected shape so a correction made
        // between publishes shows up without another Save & Publish.
        // Events the event check hid stay published but off the site
        // (server/eventcheck.js matches them by original key).
        return { ...published, events: stripKeys(await visibleFrom(published)).map(withoutSubmitter), source: 'store' };
      }
    } catch (err) {
      console.warn('[events] published lookup failed:', err.message);
    }
    try {
      const bundled = await readJsonFile(eventsFile);
      // The bundled copy can carry a `hidden` list too (Save & Publish
      // commits the whole payload), so a database outage hides the same.
      return { ...bundled, events: stripKeys(visibleKeyed(bundled, [])).map(withoutSubmitter), source: 'bundled' };
    } catch (err) {
      console.warn('[events] bundled events.json unreadable:', err.message);
      return { events: [], source: 'empty' };
    }
  }

  // In-memory copy of the archive (see listArchived). Declared before the
  // boot backfill below, which clears it.
  const ARCHIVE_TTL_MS = 5 * 60 * 1000;
  let archiveCache = null;

  // Keep every published event's page alive after its week rotates out
  // (see archiveEvents in db.js). Best-effort: a failure here must never
  // block a publish or a page view.
  // Archive what the site actually shows: the edits overlay changes names
  // (and so page slugs), and those are the URLs people share.
  function archiveEvents(events) {
    if (typeof store.archiveEvents !== 'function') return Promise.resolve();
    archiveCache = null;
    return Promise.resolve(typeof store.listEventEdits === 'function' ? store.listEventEdits() : [])
      .catch(() => [])
      .then(edits => store.archiveEvents(withPages(applyEventEdits(events, edits))))
      .then(() => { archiveCache = null; })
      .catch(err => console.warn('[events] archive skipped:', err.message));
  }

  // Backfill the archive with whatever is live at boot, so pages published
  // before the archive existed are covered too.
  const archiveReady = store.getPublished()
    .then(p => p && archiveEvents(p.events))
    .catch(err => console.warn('[events] archive backfill skipped:', err.message));

  async function serveEventsJson(req, res, next) {
    try {
      // auto_publish and the hidden lists are bookkeeping, not public.
      const { source, auto_publish: _auto, hidden: _h, hidden_restored: _r, ...payload } = await getPublicPayload();
      if (source === 'empty') return next();
      // Store-backed payloads change on publish; the bundled file only on deploy.
      if (source === 'store') res.set('Cache-Control', 'no-store');
      return res.json(payload);
    } catch (err) {
      next(err);
    }
  }
  app.get('/events.json', serveEventsJson);
  app.get('/docs/events.json', serveEventsJson);

  // Turnstile for the other public forms (contact, newsletter signup, sponsor
  // checkout). Off until TURNSTILE_SECRET_KEY is set, like /api/submissions.
  async function verifyHuman(req) {
    const b = req.body || {};
    const token = b['cf-turnstile-response'] || b.turnstile_token;
    const r = await verifyTurnstile(typeof token === 'string' ? token : '', {
      secret: turnstileSecret, remoteip: req.ip, fetch: opts.fetch
    });
    return r.ok;
  }

  // Cron secrets, one per endpoint: NEWSLETTER_CRON_SECRET (newsletter
  // send), EVENT_CHECK_SECRET (hide events), SUBMISSION_REVIEW_SECRET
  // (approve and publish submissions). The fallbacks below (and the same
  // chain in event-check.yml / submission-review.yml) keep setups made
  // before the later two existed working, but then one leaked value grants
  // all three, so the setup checklist flags a shared secret.
  const eventCheckSecret = opts.eventCheckSecret ??
    (process.env.EVENT_CHECK_SECRET || process.env.NEWSLETTER_CRON_SECRET || '');
  const submissionReviewSecret = opts.submissionReviewSecret ??
    (process.env.SUBMISSION_REVIEW_SECRET || process.env.EVENT_CHECK_SECRET || process.env.NEWSLETTER_CRON_SECRET || '');

  // ─── Newsletter (Resend; see server/newsletter.js) ───
  // Event check (server/eventcheck.js): hide what the weekly check is sure
  // about, restore from admin Home.
  registerEventCheck(app, {
    store, requireAdmin, nowFn: () => (opts.now || (() => new Date()))(),
    secret: eventCheckSecret,
    loadVisibleKeyed: async () => visibleFrom((await store.getPublished()) || {})
  });

  registerNewsletter(app, {
    store, requireAdmin, siteUrl, nowFn: () => (opts.now || (() => new Date()))(),
    getPublicPayload, createRateLimiter, config: newsletter, resend: nlResend, slack, verifyHuman,
    // Monday's run also sends last week's sponsor click reports. A daily
    // scheduler can call sponsors.sendSponsorReports(now) as well; it's
    // idempotent (each order records report_sent).
    onCron: now => sponsors.sendSponsorReports(now),
    withNav: async (html, path) => {
      const payload = await getPublicPayload();
      return fillSeasonalNav(html, activeSeasons(payload.events, await listArchived(), nowFn()), path);
    }
  });

  // ─── Server-rendered pages (SEO + AI crawlers) ───
  // See server/seo.js for why. Registered before express.static so "/"
  // gets the rendered homepage instead of the raw docs/index.html.
  const nowFn = opts.now || (() => new Date());
  let indexTemplate = null;

  function sendHtml(res, html, status = 200, cacheControl = null) {
    html = fillSeasonalNav(html, res.locals.seasons || [], res.req.path);
    // Short public cache: a new publish shows up within minutes, and a
    // burst of crawler traffic doesn't hit Postgres on every request.
    res.status(status).set('Cache-Control', cacheControl || (status === 200 ? 'public, max-age=300' : 'no-store'));
    res.type('html').send(html);
  }

  // venues.json ships with the deploy; read once at boot.
  let venues = [];
  try {
    venues = buildVenues(await readJsonFile(opts.venuesFile || VENUES_FILE));
  } catch (err) {
    console.warn('[venues] venues.json unreadable:', err.message);
  }

  // The archive only changes on publish, so keep it in memory for a few
  // minutes instead of reading every archived event on every page view.
  async function listArchived() {
    if (typeof store.listArchivedEvents !== 'function') return [];
    if (archiveCache && Date.now() - archiveCache.at < ARCHIVE_TTL_MS) return archiveCache.events;
    try {
      const events = await store.listArchivedEvents();
      archiveCache = { at: Date.now(), events };
      return events;
    } catch (err) {
      console.warn('[events] archive list failed:', err.message);
      return archiveCache ? archiveCache.events : [];
    }
  }

  const pageHandler = render => async (req, res, next) => {
    try {
      const payload = await getPublicPayload();
      // Hidden events keep their archive row; keep their pages off too.
      const archived = withoutHidden(await listArchived(), payload);
      const now = nowFn();
      res.locals.seasons = activeSeasons(payload.events, archived, now);
      await render(req, res, payload, { siteUrl, now, sponsor: payload.sponsor || null, archived, venues });
    } catch (err) {
      next(err);
    }
  };

  app.get(['/', '/index.html'], pageHandler(async (req, res, payload, ctx) => {
    // Admin preview loads the homepage with ?preview / ?previewKey and
    // renders its own unpublished picks client-side; serve it untouched.
    if (req.query.preview || req.query.previewKey) {
      return res.sendFile(path.join(DOCS_DIR, 'index.html'));
    }
    if (!indexTemplate || opts.reloadTemplates) {
      indexTemplate = await fsp.readFile(path.join(DOCS_DIR, 'index.html'), 'utf8');
    }
    sendHtml(res, renderHome(indexTemplate, payload.events, {
      ...ctx, signupHtml: signupFormHtml()
    }));
  }));

  for (const page of HUB_PAGES) {
    app.get(page.path, pageHandler(async (req, res, payload, ctx) => {
      sendHtml(res, renderHubPage(page, payload.events, ctx));
    }));
  }

  async function findEvent(payload, page) {
    let ev = payload.events.find(e => e.page === page);
    if (!ev && typeof store.getArchivedEvent === 'function') {
      ev = await store.getArchivedEvent(page);
      // A hidden event's archived copy stays hidden.
      if (ev && !withoutHidden([{ ...ev, page }], payload).length) ev = null;
    }
    return ev || null;
  }

  // Add-to-calendar file. Registered before /events/:slug, which would
  // otherwise treat "<slug>.ics" as a slug.
  app.get('/events/:slug.ics', pageHandler(async (req, res, payload, ctx) => {
    const ev = await findEvent(payload, `/events/${req.params.slug}`);
    if (!ev) return sendHtml(res, renderNotFoundPage({ ...ctx, kind: 'event' }), 404);
    res.set('Content-Disposition', `attachment; filename="${String(req.params.slug).replace(/[^a-z0-9-]/gi, '') || 'event'}.ics"`);
    res.type('text/calendar; charset=utf-8').send(renderIcs(ev, ctx));
  }));

  // Link-preview card (server/ogImage.js). The page links it with ?v=<hash
  // of what's drawn>, so the long cache is safe: an edited event gets a new
  // URL, and Facebook re-fetches it. Also registered before /events/:slug.
  app.get('/events/:slug.png', pageHandler(async (req, res, payload) => {
    const ev = await findEvent(payload, `/events/${req.params.slug}`);
    if (!ev) return res.status(404).type('text/plain').send('Not found');
    let png;
    try {
      png = renderEventCard({ ...ev, page: `/events/${req.params.slug}` });
    } catch (err) {
      // A broken card shouldn't break the share: show the site image instead.
      console.error('[og] event card render failed:', err.message);
      return res.redirect(302, '/og-image.png');
    }
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('image/png').send(png);
  }));

  app.get('/events/:slug', pageHandler(async (req, res, payload, ctx) => {
    const ev = await findEvent(payload, `/events/${req.params.slug}`);
    if (!ev) return sendHtml(res, renderNotFoundPage({ ...ctx, kind: 'event' }), 404);
    const venue = venueFor(ev, venues);
    sendHtml(res, renderEventPage(ev, payload.events, {
      ...ctx, extras: eventActionsHtml(ev, siteUrl), venuePath: venue ? venue.path : null,
      image: `${ev.page}.png?v=${eventCardVersion(ev)}`
    }));
  }));

  app.get('/venues', pageHandler(async (req, res, payload, ctx) => {
    sendHtml(res, renderVenueIndex(venues, payload.events, ctx.archived, ctx));
  }));

  app.get('/venues/:slug', pageHandler(async (req, res, payload, ctx) => {
    const venue = venues.find(v => v.slug === req.params.slug);
    if (!venue) return sendHtml(res, renderNotFoundPage({ ...ctx, kind: 'venue' }), 404);
    sendHtml(res, renderVenuePage(venue, payload.events, ctx.archived, ctx));
  }));

  for (const season of SEASONS) {
    app.get(season.path, pageHandler(async (req, res, payload, ctx) => {
      sendHtml(res, renderSeasonPage(season, payload.events, ctx.archived, ctx));
    }));
    // People guess the short form (/halloween for /halloween-events).
    const short = season.path.replace(/-events$/, '');
    if (short !== season.path) {
      app.get(short, (req, res) => res.redirect(301, season.path + (req.originalUrl.match(/\?.*$/) || [''])[0]));
    }
  }

  app.get('/advertise', pageHandler(async (req, res, payload, ctx) => {
    sendHtml(res, renderAdvertisePage({ ...ctx, checkout: stripeCfg.enabled, previews: samplePreviews() }));
  }));

  // Contact form → Slack; replaces publishing an email address.
  registerContact(app, { siteUrl, slack, createRateLimiter, sendHtml, verifyHuman });

  sponsors.registerRoutes(app, { requireAdmin, createRateLimiter, sendHtml, verifyHuman, analyticsSecret });

  app.get('/about', pageHandler(async (req, res, payload, ctx) => {
    sendHtml(res, renderAboutPage(ctx));
  }));

  app.get('/privacy', pageHandler(async (req, res, payload, ctx) => {
    sendHtml(res, renderPrivacyPage(ctx));
  }));

  app.get('/sitemap.xml', pageHandler(async (req, res, payload, ctx) => {
    res.set('Cache-Control', 'public, max-age=300');
    const extraPaths = [
      '/venues', '/subscribe', '/privacy',
      ...activeSeasons(payload.events, ctx.archived, ctx.now).map(s => s.path),
      ...venuesWithEvents(venues, payload.events, ctx.archived, ctx.now).map(v => v.path)
    ];
    res.type('application/xml').send(renderSitemap(payload.events, { ...ctx, lastmod: payload.last_updated, extraPaths }));
  }));

  app.get('/llms.txt', pageHandler(async (req, res, payload, ctx) => {
    res.set('Cache-Control', 'public, max-age=300');
    const extraLinks = [
      ['Event venues in Victoria, TX', '/venues', 'every venue we track, with its upcoming events'],
      ...activeSeasons(payload.events, ctx.archived, ctx.now).map(s => [s.title, s.path, s.description])
    ];
    res.type('text/plain; charset=utf-8').send(renderLlmsTxt(payload.events, { ...ctx, extraLinks, sponsor: payload.sponsor || null }));
  }));

  // The social kit lives at docs/social/latest/index.html; static serving
  // has directory indexes off, so send the bare folder there.
  app.get(['/social', '/social/', '/social/latest', '/social/latest/'], (req, res) => {
    res.redirect(302, '/social/latest/index.html');
  });

  // ─── Auto-publish (server/autopublish.js) ───
  // Each collector run commits candidates.json and redeploys; on boot the
  // new candidates go live without anyone opening the admin. Production
  // only, so PR environments and tests never publish on their own.
  const autoPublish = createAutoPublish({
    store, candidatesFile, readJsonFile, siteUrl, slack, archiveEvents,
    nowFn: () => (opts.now || (() => new Date()))()
  });
  app.post('/api/admin/auto-publish', requireAdmin, async (req, res, next) => {
    try { res.json(await autoPublish.run({ force: true })); } catch (err) { next(err); }
  });
  // ─── Approved submissions go live (AI review and manual approval) ───
  // True when the event is on the public site; then "You're live" goes out
  // with a link to its page. A paid Vic's Pick also counts when it matched
  // an event already listed (the pin finds that one).
  async function notifyLive(row) {
    const key = eventKeyOf(row.payload);
    const events = (await getPublicPayload()).events || [];
    const paid = isPaidPick(row);
    const live = events.find(e => eventKeyOf(e) === key) || (paid ? events.find(e => sameEvent(row.payload, e)) : null);
    if (!live) return false;
    if (row.submitter_email) {
      const mail = renderSubmissionLive(paid ? { ...row.payload, name: live.name, featured: true } : row.payload, {
        siteUrl, address: newsletter.address, upgradeUrl: upgradeUrlFor(row), pick: paid,
        pageUrl: live.page ? `${siteUrl}${live.page}` : ''
      });
      await mailer.send(row.submitter_email, mail, `vic361-submission-live-${row.id}`);
    }
    return true;
  }

  // Publish approved submissions now (never the collector's candidates) and
  // say which of `rows` made it onto the site.
  async function publishApproved(rows) {
    let published;
    try {
      published = await autoPublish.run({ force: true, quiet: true, submissionsOnly: true });
    } catch (err) {
      console.error('[submissions] publish failed:', err.message);
      return { published: false, live: rows.map(() => false) };
    }
    const live = [];
    for (const row of rows) {
      try { live.push(published && published.ok ? await notifyLive(row) : false); } catch (err) {
        console.warn('[submissions] live check/email failed:', err.message);
        live.push(null);
      }
    }
    return { published: Boolean(published && published.ok), live };
  }

  // ─── AI review of submissions (server/submissionReview.js) ───
  registerSubmissionReview(app, {
    store, slack, siteUrl,
    nowFn: () => (opts.now || (() => new Date()))(),
    secret: submissionReviewSecret,
    autoApprove: opts.submissionAutoApprove ?? process.env.SUBMISSION_AUTOAPPROVE !== '0',
    publish: () => autoPublish.run({ force: true, quiet: true, submissionsOnly: true }),
    onApproved: notifyLive
  });

  const autoOnBoot = opts.autoPublish ??
    (process.env.AUTO_PUBLISH !== '0' && process.env.RAILWAY_ENVIRONMENT_NAME === 'production');
  if (autoOnBoot) {
    const t = setTimeout(() => {
      autoPublish.run().catch(err => {
        console.error('[auto-publish] failed:', err.message);
        slack.alert('auto-publish', 'Auto-publish failed', err.message, `${siteUrl}/admin.html`);
      });
    }, opts.autoPublishDelayMs ?? 3000);
    if (t.unref) t.unref();
  }

  // ─── Admin home: setup checklist + at-a-glance numbers ───
  // Presence checks only; no secret value ever leaves the server. Things the
  // server can't see (GitHub Actions secrets) are listed as "check in GitHub".
  app.get('/api/admin/setup', requireAdmin, async (req, res) => {
    const env = process.env;
    const ghSecrets = `https://github.com/${github.owner}/${github.repo}/settings/secrets/actions`;
    const cronSecrets = [newsletter.cronSecret, eventCheckSecret, submissionReviewSecret].filter(Boolean);
    const checks = [
      { key: 'database', label: 'Database', ok: storeBundle.kind === 'postgres', level: 'required',
        fix: 'Add a Postgres database in Railway so events and subscribers survive deploys.' },
      { key: 'login', label: 'Admin login', ok: auth.configured, level: 'required',
        fix: 'Set ADMIN_USERNAME, ADMIN_PASSWORD and ADMIN_SESSION_SECRET in Railway.' },
      { key: 'auto_publish', label: 'Auto-publish events', ok: env.AUTO_PUBLISH !== '0', level: 'required',
        fix: 'Remove AUTO_PUBLISH=0 from Railway.' },
      { key: 'slack', label: 'Slack alerts', ok: slack.enabled, level: 'recommended',
        fix: 'Set SLACK_WEBHOOK_URL in Railway (and as a GitHub secret) to get pings for breakage, sponsors and submissions. Optional: SLACK_SALES_WEBHOOK_URL, SLACK_ACTIVITY_WEBHOOK_URL and SLACK_ALERTS_WEBHOOK_URL send each kind to its own channel.' },
      { key: 'newsletter', label: 'Email newsletter (Resend)', ok: newsletter.enabled && Boolean(newsletter.address), level: 'recommended',
        fix: newsletter.enabled ? 'Set NEWSLETTER_ADDRESS (a mailing address is required by law in every email).' : 'Set RESEND_API_KEY and NEWSLETTER_ADDRESS in Railway.' },
      { key: 'newsletter_auto', label: 'Newsletter sends itself Mondays', ok: Boolean(newsletter.cronSecret), level: 'recommended',
        fix: 'Set NEWSLETTER_CRON_SECRET in Railway and as a GitHub secret (the same long random string in both). The Monday send also emails last week\'s sponsor their click report.' },
      { key: 'reply_to', label: 'Customer email replies reach you', ok: Boolean(newsletter.replyTo), level: 'recommended',
        fix: 'Set NEWSLETTER_REPLY_TO in Railway to an inbox you read. Sponsor and submitter emails say "just reply", and without it replies go to the sending address.' },
      { key: 'stripe', label: 'Sponsor payments (Stripe)', ok: stripeCfg.enabled, level: 'recommended',
        fix: 'In Stripe: create a restricted key (Checkout Sessions, Products and Prices: write) and a webhook to ' + siteUrl +
          '/api/stripe/webhook on API version 2026-09-30.endive. Put them in Railway as STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.' },
      { key: 'event_check', label: 'Event check hides church events, non-events and duplicates',
        ok: Boolean(eventCheckSecret), level: 'recommended', link: ghSecrets,
        fix: 'Set EVENT_CHECK_SECRET in Railway and as a GitHub secret (any long random string, the same in both). Until then the check only reports to Slack.' },
      { key: 'submission_review', label: 'AI review publishes good free submissions', ok: Boolean(submissionReviewSecret), level: 'recommended', link: ghSecrets,
        fix: 'Set SUBMISSION_REVIEW_SECRET in Railway and as a GitHub secret (any long random string, the same in both). Until then submissions wait for you in the Submissions tab.' },
      { key: 'separate_secrets', label: 'Each automation has its own secret', ok: new Set(cronSecrets).size === cronSecrets.length, level: 'optional', link: ghSecrets,
        fix: 'NEWSLETTER_CRON_SECRET, EVENT_CHECK_SECRET and SUBMISSION_REVIEW_SECRET share a value (or one is unset and borrows another), so one leak could send the newsletter, hide events and publish submissions. Give each its own long random string, the same in Railway and GitHub.' },
      { key: 'pull_now', label: '"Pull now" button (GitHub token)', ok: github.isConfigured(), level: 'optional',
        fix: 'Set GITHUB_TOKEN in Railway (fine-grained, Actions: write on this repo).' },
      { key: 'spam', label: 'Spam protection on forms (Turnstile)', ok: Boolean(turnstileSecret && turnstileSiteKey), level: 'optional',
        fix: 'In Cloudflare Turnstile, add a widget (or add www.thevic361.com to an existing one) in Managed mode, then set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY in Railway. Protects Submit, Contact, newsletter signup and sponsor checkout.' },
      { key: 'social', label: 'Auto-post to Facebook + Instagram', ok: null, level: 'recommended', link: ghSecrets,
        fix: 'In GitHub: secrets META_PAGE_ID, META_PAGE_TOKEN, IG_USER_ID and the repo variable SOCIAL_AUTOPOST = 1.' },
      { key: 'collector_keys', label: 'Event collector keys (OpenAI, Apify, Gemini)', ok: null, level: 'recommended', link: ghSecrets,
        fix: 'In GitHub secrets: OPENAI_API_KEY (cleanup + junk filter), APIFY_TOKEN (Facebook, Instagram, Eventbrite) and GEMINI_API_KEY (Google Search discovery; free key at aistudio.google.com).' }
    ];

    const status = {};
    try {
      const pub = (await store.getPublished()) || {};
      const today = localDateStr(nowFn());
      // What visitors see: less anything the event check hid.
      const events = visibleKeyed(pub, []);
      status.live_events = events.length;
      status.upcoming_events = events.filter(e => e && e.date >= today).length;
      status.hidden_events = (pub.hidden || []).filter(h => h.date >= today).length;
      status.auto_published_at = (pub.auto_publish && pub.auto_publish.at) || null;
      status.published_at = pub.last_updated || null;
    } catch { /* leave blank */ }
    try { status.collected_at = (await readJsonFile(candidatesFile)).last_updated || null; } catch { /* none */ }
    try { status.pending_submissions = (await store.list({ status: 'pending' })).length; } catch { /* none */ }
    try {
      if (typeof store.countSubscribers === 'function') status.subscribers = (await store.countSubscribers()).active || 0;
    } catch { /* none */ }
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, checks, status, site_url: siteUrl });
  });

  // ─── Static site ───
  // Images and icons rarely change: a day's cache saves a mobile visitor
  // ~10 revalidations per page. CSS/JS have no cache-busting ?v=, so keep
  // theirs short enough that a deploy shows up quickly. Social-kit files
  // are rebuilt daily under the same names. HTML and JSON stay revalidated.
  app.use(express.static(DOCS_DIR, {
    extensions: ['html'],
    index: false,
    setHeaders(res, file) {
      const rel = path.relative(DOCS_DIR, file).split(path.sep).join('/');
      let cc = 'public, max-age=0';
      if (rel.startsWith('social/')) cc = 'public, max-age=300';
      else if (/\.(png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(rel)) cc = 'public, max-age=86400';
      else if (/\.(css|js)$/i.test(rel)) cc = 'public, max-age=600';
      res.setHeader('Cache-Control', cc);
    }
  }));

  // ─── 404 + error handlers ───
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ ok: false, error: 'not-found' });
    }
    // A person following a mistyped or old link gets the site, not a dead
    // end; images, scripts and other files keep the short text answer.
    const wantsPage = /text\/html/.test(req.get('accept') || '') ||
      (!/\.[a-z0-9]+$/i.test(req.path) && req.accepts(['html', 'text']) === 'html');
    if ((req.method === 'GET' || req.method === 'HEAD') && wantsPage) {
      return sendHtml(res, renderNotFoundPage({ siteUrl, kind: req.path.startsWith('/venues/') ? 'venue' : req.path.startsWith('/events/') ? 'event' : 'page' }), 404);
    }
    res.status(404).type('text/plain').send('Not found');
  });

  app.use((err, req, res, _next) => {
    // A garbled tracking beacon (bad JSON from a browser extension, a bot)
    // isn't worth a 500 or an error log line.
    if (req.path === '/api/track') return res.status(204).end();
    // A body over its size limit (body-parser 413) is the sender's problem,
    // not a site error: no 500, no Slack alert. On the sponsor checkout it
    // means the logo was too big, so say that.
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      if (req.path === '/advertise/checkout') return sendHtml(res, renderLogoTooLargePage({ siteUrl }), 413, 'no-store');
      if (req.path.startsWith('/api/')) return res.status(413).json({ ok: false, error: 'too-large' });
      return res.status(413).type('text/plain').send('Too large');
    }
    console.error('[server] error:', err);
    slack.alert(`500:${req.path}:${err && err.message}`, 'Site error (500)',
      `${req.method} ${req.path}\n${(err && err.message) || err}`);
    if (req.path.startsWith('/api/')) {
      return res.status(500).json({ ok: false, error: 'server-error' });
    }
    res.status(500).type('text/plain').send('Server error');
  });

  await archiveReady;
  return { app, store, storeBundle, slack };
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
  const cfg = slackConfig();
  const bootSlack = createSlack(cfg);
  // A crash takes the site down until Railway restarts it; say so first.
  process.on('uncaughtException', err => {
    console.error('[thevic361] uncaught:', err);
    bootSlack.alert('crash', 'Server crashed and is restarting', err && err.stack ? err.stack.slice(0, 1500) : String(err))
      .finally(() => process.exit(1));
  });
  process.on('unhandledRejection', err => {
    console.error('[thevic361] unhandled rejection:', err);
    bootSlack.alert(`rejection:${err && err.message}`, 'Unhandled error in the server', (err && err.message) || String(err));
  });
  createApp().then(({ app, storeBundle }) => {
    // No "deployed" ping: every merge redeploys, so it was noise. A failed
    // boot or a crash still alerts (below and above).
    app.listen(port, () => {
      console.log(`[thevic361] listening on :${port} (storage=${storeBundle.kind})`);
    });
  }).catch(err => {
    console.error('[thevic361] failed to start:', err);
    bootSlack.alert('boot', 'Server failed to start', (err && err.message) || String(err))
      .finally(() => process.exit(1));
  });
}
