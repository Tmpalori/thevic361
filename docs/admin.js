/* admin.js — The Vic 361 admin panel
 *
 * Auth model:
 *   1. Server login (preferred). POST /api/admin/login → bearer session token
 *      stored as `vic361_admin_session`. Used for every /api/admin/* call,
 *      including publishing events. The server holds GITHUB_TOKEN and writes
 *      docs/events.json on our behalf so the browser never holds a PAT.
 *   2. Legacy PAT (fallback). If the server reports `github_publish_enabled =
 *      false` we fall back to the old browser-side GitHub Contents API flow
 *      using a PAT in localStorage.
 *
 * State stored in localStorage:
 *   vic361_admin_session  — bearer session token from /api/admin/login
 *   vic361_admin_pat      — legacy GitHub PAT (only used in fallback mode)
 *   vic361_admin_picks    — selected event keys
 */
(function () {
  'use strict';

  // ─── CONSTANTS ───
  const REPO_OWNER = 'Tmpalori';
  const REPO_NAME  = 'thevic361';
  const BRANCH     = 'main';
  const PAT_KEY      = 'vic361_admin_pat';
  const SESSION_KEY  = 'vic361_admin_session';
  const PICKS_KEY    = 'vic361_admin_picks';
  const THEME_KEY    = 'vic361_admin_theme';

  const CANDIDATES_PATH = 'candidates.json';
  const EVENTS_PATH     = 'docs/events.json';

  const ICON_MAP = {
    food: '🍔', music: '🎵', family: '🧑‍🧑‍🧒', drinks: '🍺',
    arts: '🎨', shopping: '🛍️', outdoors: '🏃',
    community: '📣', free: '🆓'
  };

  const SOURCE_LABEL = {
    submission: 'Submitted',
    local: 'Local YAML',
    scraper: 'Scraper',
    sonar: 'Sonar',
    facebook: 'Facebook',
    instagram: 'Instagram',
    candidate: 'Website',
    unknown: 'Unknown',
    // Collector scraper ids (collect_events.py tags each candidate).
    local_events: 'Local YAML',
    google_sheet: 'Google Sheet',
    city_calendar: 'City calendar',
    chamber: 'Chamber',
    library: 'Library',
    theatre_victoria: 'Theatre Victoria',
    jwelch: 'J Welch Farms',
    generals: 'Generals',
    moonshine: 'Moonshine',
    vtx_artwalk: 'Art Walk',
    allevents: 'AllEvents',
    apify_facebook: 'Facebook events',
    apify_eventbrite: 'Eventbrite',
    apify_facebook_posts: 'Facebook posts',
    apify_instagram_posts: 'Instagram posts'
  };
  function inferSource(ev) {
    if (!ev) return 'unknown';
    const explicit = ev._source || (ev.meta && ev.meta.source);
    if (explicit) return explicit;
    const u = String(ev.url || '').toLowerCase();
    if (u.includes('facebook.com')) return 'facebook';
    if (u.includes('instagram.com')) return 'instagram';
    if (u.includes('eventbrite')) return 'scraper';
    if (!u) return 'local';
    return 'candidate';
  }
  function sourceLabel(key) {
    return SOURCE_LABEL[key] || (key ? String(key) : 'Unknown');
  }

  // Only http(s) URLs are allowed as a clickable source link — anything else
  // (javascript:, data:, mailto:, blank) is rendered as plain text or hidden.
  // We rely on the URL constructor to reject malformed input rather than
  // hand-rolling a regex.
  function isHttpUrl(value) {
    if (!value) return false;
    const s = String(value).trim();
    if (!s) return false;
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) {
      return false;
    }
  }

  // Compact display form for a URL in the picker row. Keeps the host plus a
  // short tail of the path so the operator can tell which page it points at
  // without the row blowing up to two lines.
  function shortenUrl(value) {
    const s = String(value || '').trim();
    if (!s) return '';
    try {
      const u = new URL(s);
      const host = u.hostname.replace(/^www\./, '');
      const path = u.pathname.replace(/\/+$/, '');
      const display = host + (path && path !== '/' ? path : '');
      return display.length > 48 ? display.slice(0, 45) + '…' : display;
    } catch (_) {
      return s.length > 48 ? s.slice(0, 45) + '…' : s;
    }
  }

  const WEEKDAY_TARGET_MIN = 4;
  const WEEKDAY_TARGET_MAX = 8;
  const WEEKEND_TARGET_MIN = 8;
  const WEEKEND_TARGET_MAX = 12;

  // ─── STATE ───
  const state = {
    // Session bearer token (preferred). When present, used for /api/admin/*.
    session: null,
    // Legacy GitHub PAT (fallback only). Used to talk directly to api.github.com.
    pat: null,
    // Reflects /api/config so we know which auth modes are usable.
    serverConfig: null,
    candidates: [],
    selected: new Set(),
    // Keys (date|name|venue) of events currently published on the live site.
    // Fetched via /api/admin/published-events after candidates load. Used to
    // pre-check live events on a fresh login and to render a "Published" pill
    // so the operator can tell which checked rows are already live vs.
    // session-only picks.
    publishedKeys: new Set(),
    // key -> { score, overflow, keep } for live events (server/scoring.js).
    scoreInfo: new Map(),
    hiddenKeys: new Set(),   // live events the event check hid (server/eventcheck.js)
    filters: { search: '', category: '', venue: '', week: 'this' }
  };

  // ─── HELPERS ───
  function eventKey(ev) {
    return [ev.date || '', ev.name || '', ev.venue || ''].join('|');
  }

  // The town this admin runs (from /api/config; Victoria until it loads).
  const TOWN_DEFAULTS = { id: 'victoria', siteName: 'The Vic 361', domain: 'thevic361.com', city: 'Victoria', pickName: 'Vic’s Pick', timezone: 'America/Chicago' };
  function town() {
    return Object.assign({}, TOWN_DEFAULTS, (state.serverConfig && state.serverConfig.town) || {});
  }
  // Where Save & Publish writes (the server's GitHub settings, else these).
  function repo() {
    const c = state.serverConfig || {};
    return { owner: c.github_owner || REPO_OWNER, name: c.github_repo || REPO_NAME, branch: c.github_branch || BRANCH,
      eventsPath: c.github_events_path || EVENTS_PATH,
      candidatesPath: c.github_candidates_path || CANDIDATES_PATH };
  }

  // The few labels admin.html writes as Victoria's, set from the town once
  // /api/config has loaded (the same text for Victoria).
  function applyTownLabels() {
    const t = town();
    document.title = 'Admin — ' + t.siteName;
    const h1 = document.querySelector('.auth-card h1, body > header h1, h1');
    if (h1 && /— Admin$/.test(h1.textContent)) h1.textContent = t.siteName + ' — Admin';
    const reply = document.getElementById('reply-title');
    if (reply) reply.textContent = 'Reply as news@' + t.domain;
    const hint = document.querySelector('#reply-modal .event-edit-form__hint');
    if (hint && /^Signed /.test(hint.textContent)) hint.textContent = 'Signed “— ' + t.siteName + '”. Their answer comes back to Slack.';
  }

  // Midnight (local clock) of today's date in the town, whatever zone the
  // browser is in, so "this week" is the town's week.
  function townToday(now) {
    const s = new Intl.DateTimeFormat('en-CA', { timeZone: town().timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(now || new Date());
    const p = s.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function getMondayOfWeek(now) {
    const base = townToday(now);
    const dow = base.getDay();
    const daysFromMonday = dow === 0 ? 6 : dow - 1;
    base.setDate(base.getDate() - daysFromMonday);
    return base;
  }

  function getWeekRange(offsetWeeks, now) {
    const monday = getMondayOfWeek(now);
    if (offsetWeeks) monday.setDate(monday.getDate() + offsetWeeks * 7);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { mondayStr: toLocalDateStr(monday), sundayStr: toLocalDateStr(sunday) };
  }

  function toLocalDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function inWeekBucket(dateStr, bucket, now) {
    if (!dateStr) return false;
    if (bucket === 'all') return true;
    const thisMonday = toLocalDateStr(getMondayOfWeek(now));
    if (dateStr < thisMonday) return false;
    if (bucket === 'upcoming') return true;
    const offset = bucket === 'next' ? 1 : 0;
    const { mondayStr, sundayStr } = getWeekRange(offset, now);
    return dateStr >= mondayStr && dateStr <= sundayStr;
  }

  function isWeekend(dateStr) {
    if (!dateStr) return false;
    const parts = dateStr.split('-').map(Number);
    if (parts.length !== 3) return false;
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    const dow = d.getDay();
    return dow === 0 || dow === 5 || dow === 6;
  }

  function formatDateHeading(dateStr) {
    const parts = dateStr.split('-').map(Number);
    if (parts.length !== 3) return dateStr;
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    return d.toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric'
    });
  }

  // Only http(s) links are clickable; a scraped `javascript:` URL renders as #.
  function httpUrl(u) {
    return typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : '#';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setStatus(msg, kind) {
    const el = document.getElementById('status-message');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.remove('is-error', 'is-success');
    if (kind === 'error') el.classList.add('is-error');
    if (kind === 'success') el.classList.add('is-success');
  }

  // ─── SESSION + PAT STORAGE ───
  function getSession() {
    try { return localStorage.getItem(SESSION_KEY); } catch (_) { return null; }
  }
  function setSession(tok) {
    try { localStorage.setItem(SESSION_KEY, tok); } catch (_) {}
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
  }
  function getPat() {
    try { return localStorage.getItem(PAT_KEY); } catch (_) { return null; }
  }
  function setPat(pat) {
    try { localStorage.setItem(PAT_KEY, pat); } catch (_) {}
  }
  function clearPat() {
    try { localStorage.removeItem(PAT_KEY); } catch (_) {}
  }
  function clearAuth() {
    clearSession();
    clearPat();
    try {
      localStorage.removeItem(PICKS_KEY);
      localStorage.removeItem(PENDING_KEY);
      localStorage.removeItem('vic361_submissions_admin_token');
      localStorage.removeItem('vic361_submissions_api_url');
    } catch (_) {}
  }

  function showAuthGate(errMsg) {
    const gate = document.getElementById('auth-gate');
    const app = document.getElementById('app');
    if (gate) gate.hidden = false;
    if (app) app.hidden = true;
    const errEl = document.getElementById('auth-error');
    if (errEl) {
      if (errMsg) {
        errEl.textContent = errMsg;
        errEl.hidden = false;
      } else {
        errEl.textContent = '';
        errEl.hidden = true;
      }
    }
  }
  function showApp() {
    const gate = document.getElementById('auth-gate');
    const app = document.getElementById('app');
    if (gate) gate.hidden = true;
    if (app) app.hidden = false;
    openReplyFromHash();
  }

  // ─── REPLY AS NEWS@ ───
  // Slack's "Reply as news@" links open admin.html#reply?to=…&subject=…&ref=…
  // (server/inbound.js replyLink). Sign-in keeps the hash, so the box opens
  // right after logging in too.
  function parseReplyHash(hash) {
    const m = /^#reply\?(.*)$/.exec(hash || '');
    if (!m) return null;
    const q = new URLSearchParams(m[1]);
    return { to: q.get('to') || '', subject: q.get('subject') || '', ref: q.get('ref') || '' };
  }

  function openReplyFromHash() {
    const r = parseReplyHash(window.location.hash);
    const modal = document.getElementById('reply-modal');
    if (!r || !modal || !state.session) return;
    const form = document.getElementById('reply-form');
    form.reset();
    form.elements.to.value = r.to;
    form.elements.subject.value = r.subject;
    form.elements.ref.value = r.ref;
    showReplyErrors({});
    document.getElementById('reply-status').textContent = '';
    modal.hidden = false;
    form.elements.text.focus();
  }

  function closeReplyModal() {
    const modal = document.getElementById('reply-modal');
    if (modal) modal.hidden = true;
    if (/^#reply\?/.test(window.location.hash)) history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function showReplyErrors(errors, message) {
    document.querySelectorAll('#reply-form [data-error-for]').forEach(el => {
      el.textContent = (errors && errors[el.getAttribute('data-error-for')]) || '';
    });
    const top = document.getElementById('reply-form-error');
    top.textContent = message || '';
    top.hidden = !message;
  }

  async function sendReply(ev) {
    ev.preventDefault();
    const form = ev.target;
    const btn = document.getElementById('reply-send-btn');
    const status = document.getElementById('reply-status');
    const body = { to: form.elements.to.value.trim(), subject: form.elements.subject.value.trim(),
      text: form.elements.text.value, ref: form.elements.ref.value };
    btn.disabled = true;
    status.textContent = 'Sending…';
    try {
      const { res, json } = await adminFetch('/api/admin/email/reply', { method: 'POST', body: JSON.stringify(body) });
      if (res.ok && json && json.ok) {
        status.textContent = 'Sent ✓';
        setTimeout(closeReplyModal, 900);
      } else {
        status.textContent = '';
        showReplyErrors((json && json.errors) || {}, json && !json.errors ? (json.message || 'Couldn’t send. Try again.') : '');
      }
    } catch (_) {
      status.textContent = '';
      showReplyErrors({}, 'Couldn’t reach the server. Try again.');
    } finally {
      btn.disabled = false;
    }
  }

  // ─── SERVER API ───
  function apiBaseUrl() {
    // Same origin as the admin page. The Express server serves both, so this
    // works without configuration on Railway.
    return '';
  }

  async function fetchServerConfig() {
    try {
      const r = await fetch(apiBaseUrl() + '/api/config', { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { return null; }
  }

  // requireAdmin's 'unauthorized' plus /api/admin/me's reasons (server/auth.js).
  const SESSION_ERRORS = new Set(['unauthorized', 'missing-credentials', 'missing', 'expired', 'malformed', 'bad-signature', 'not-configured']);

  async function adminFetch(path, init) {
    const headers = Object.assign({}, (init && init.headers) || {});
    if (state.session) headers['Authorization'] = 'Bearer ' + state.session;
    if (init && init.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(apiBaseUrl() + path, Object.assign({}, init, { headers }));
    let json = null;
    try { json = await res.json(); } catch (_) {}
    // Only a 401 that's about the admin session signs out. Others carry
    // their own error code (e.g. 'github-token-invalid' from an older
    // server's Pull now) and their caller explains them; signing out there
    // would loop the owner through login and lose an open edit.
    const code = json && json.error;
    if (res.status === 401 && (!code || SESSION_ERRORS.has(code))) {
      // Session expired or revoked; force a fresh login.
      state.session = null;
      clearSession();
      showAuthGate('Session expired — please sign in again.');
    }
    return { res, json };
  }

  async function login({ username, password }) {
    const r = await fetch(apiBaseUrl() + '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    let json = null;
    try { json = await r.json(); } catch (_) {}
    if (!r.ok || !json || !json.ok) {
      const msg = (json && json.error === 'rate-limited')
        ? 'Too many sign-in attempts. Try again in a few minutes.'
        : (json && json.error === 'login-not-configured')
          ? 'Server login is not configured. Set ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_SESSION_SECRET on the server.'
          : 'Invalid username or password.';
      throw new Error(msg);
    }
    return json.token;
  }

  // ─── GITHUB API (legacy PAT fallback) ───
  function ghHeaders() {
    return {
      Authorization: 'Bearer ' + state.pat,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }
  function ghContentsUrl(p, ref) {
    let u = 'https://api.github.com/repos/' + repo().owner + '/' + repo().name +
            '/contents/' + p;
    if (ref) u += '?ref=' + encodeURIComponent(ref);
    return u;
  }
  async function ghGetJsonFile(p) {
    const res = await fetch(ghContentsUrl(p, repo().branch), {
      headers: ghHeaders(), cache: 'no-store'
    });
    if (!res.ok) {
      throw new Error('GitHub fetch failed (' + res.status + ') for ' + p);
    }
    const meta = await res.json();
    let text;
    if (meta.encoding === 'base64' && typeof meta.content === 'string') {
      text = atob(meta.content.replace(/\n/g, ''));
      try {
        const bytes = Uint8Array.from(text, c => c.charCodeAt(0));
        text = new TextDecoder('utf-8').decode(bytes);
      } catch (_) { /* keep best-effort decode */ }
    } else if (meta.download_url) {
      const r2 = await fetch(meta.download_url);
      text = await r2.text();
    } else {
      throw new Error('Unsupported GitHub response for ' + p);
    }
    return { sha: meta.sha, data: JSON.parse(text) };
  }
  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  async function ghPutJsonFile(p, dataObj, message, sha) {
    const body = {
      message: message,
      content: utf8ToBase64(JSON.stringify(dataObj, null, 2) + '\n'),
      branch: repo().branch
    };
    if (sha) body.sha = sha;
    const res = await fetch(ghContentsUrl(p), {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch (_) {}
      throw new Error('Publish failed (' + res.status + '): ' + detail);
    }
    return res.json();
  }
  async function verifyPat(pat) {
    const res = await fetch('https://api.github.com/repos/' + repo().owner + '/' + repo().name, {
      headers: {
        Authorization: 'Bearer ' + pat,
        Accept: 'application/vnd.github+json'
      }
    });
    if (!res.ok) {
      const msg = res.status === 401 || res.status === 403
        ? 'Token rejected by GitHub. Check scopes (contents:write).'
        : 'Could not reach GitHub (HTTP ' + res.status + ').';
      throw new Error(msg);
    }
  }

  // ─── CANDIDATES ───
  function publishMode() {
    // Prefer the server whenever we're signed in. The server now handles
    // candidates (local-file fallback when GITHUB_TOKEN is missing) and
    // publishing (saved to Railway's local store; optionally also committed
    // to GitHub when GITHUB_TOKEN is configured).
    if (state.session) return 'server';
    if (state.pat) return 'pat';
    return null;
  }

  async function loadCandidates() {
    const listEl = document.getElementById('picker-list');
    const loadEl = document.getElementById('picker-loading');
    const errEl = document.getElementById('picker-error');
    if (loadEl) loadEl.hidden = false;
    if (errEl) errEl.hidden = true;
    if (listEl) listEl.innerHTML = '';

    try {
      let data;
      let warning = null;
      let source = null;
      const mode = publishMode();
      if (mode === 'server') {
        const { res, json } = await adminFetch('/api/admin/candidates');
        if (!res.ok || !json || !json.ok) {
          throw new Error((json && json.message) || 'Failed to load candidates from server.');
        }
        data = json.data;
        warning = json.warning || null;
        source = json.source || null;
      } else if (mode === 'pat') {
        const got = await ghGetJsonFile(repo().candidatesPath);
        data = got.data;
      } else {
        throw new Error('No publishing credentials configured.');
      }
      const events = Array.isArray(data && data.events) ? data.events : [];
      state.candidates = events.slice().sort((a, b) => {
        const da = (a.date || '') + ' ' + (a.time || '');
        const db = (b.date || '') + ' ' + (b.time || '');
        return da.localeCompare(db);
      });
      restoreSelectionsFromStorage();
      // Fetch the currently-published events so candidates already on the
      // live site show up pre-checked. Best-effort: a failure here just
      // means fewer rows are pre-checked, not a broken page.
      await loadPublishedAndSeedSelections();
      pruneStalePastSelections();
      populateFilters();
      renderPicker();
      setStatus('Loaded ' + state.candidates.length + ' event(s).', 'success');
      // Note: the server may report `source=local-file` and a `warning` field
      // when the optional GITHUB_TOKEN isn't configured. That's the intended
      // operating mode now — candidates are served from the bundled file on
      // disk — so we deliberately don't surface those as a banner anymore.
      void warning;
    } catch (err) {
      console.error(err);
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = err.message || String(err);
      }
      setStatus('Failed to load candidates.', 'error');
    } finally {
      if (loadEl) loadEl.hidden = true;
    }
  }

  function populateFilters() {
    const catSel = document.getElementById('filter-category');
    const venSel = document.getElementById('filter-venue');
    if (!catSel || !venSel) return;

    const cats = new Set();
    const venues = new Set();
    for (const ev of state.candidates) {
      (ev.icons || []).forEach(c => cats.add(c));
      if (ev.venue) venues.add(ev.venue);
    }

    catSel.innerHTML = '<option value="">All categories</option>' +
      Array.from(cats).sort().map(c =>
        '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>'
      ).join('');

    venSel.innerHTML = '<option value="">All venues</option>' +
      Array.from(venues).sort().map(v =>
        '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + '</option>'
      ).join('');
  }

  function applyFilters(events) {
    const f = state.filters;
    const q = f.search.trim().toLowerCase();
    const bucket = f.week || 'this';
    return events.filter(ev => {
      if (!inWeekBucket(ev.date, bucket)) return false;
      if (f.category && !(ev.icons || []).includes(f.category)) return false;
      if (f.venue && ev.venue !== f.venue) return false;
      if (q) {
        const hay = ((ev.name || '') + ' ' + (ev.description || '') + ' ' +
                     (ev.venue || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function groupByDate(events) {
    const groups = new Map();
    for (const ev of events) {
      const k = ev.date || '(undated)';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(ev);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }

  // ─── RENDER PICKER ───
  function renderPicker() {
    const listEl = document.getElementById('picker-list');
    const emptyEl = document.getElementById('picker-empty');
    if (!listEl) return;

    const filtered = applyFilters(state.candidates);
    if (!filtered.length) {
      listEl.innerHTML = '';
      if (emptyEl) emptyEl.hidden = false;
      updateCounts();
      return;
    }
    if (emptyEl) emptyEl.hidden = true;

    const groups = groupByDate(filtered);
    listEl.innerHTML = groups.map(([date, evs]) => {
      const heading = date === '(undated)' ? 'Undated' : formatDateHeading(date);
      const weekend = isWeekend(date);
      void weekend;
      const selectedInGroup = evs.filter(ev => state.selected.has(eventKey(ev))).length;
      const countCls = selectedInGroup ? 'is-ok' : 'is-warn';

      const rows = evs.map(ev => {
        const k = eventKey(ev);
        const checked = state.selected.has(k) ? 'checked' : '';
        const icons = (ev.icons || []).map(i => ICON_MAP[i] || '').join(' ');
        const src = inferSource(ev);
        const srcPill = '<span class="src-pill src-pill--' + escapeHtml(src) +
          '" title="Source: ' + escapeHtml(sourceLabel(src)) + '">' +
          escapeHtml(sourceLabel(src)) + '</span>';
        // A live event past its day's limit (15 Mon–Thu, 20 Fri–Sun) is off
        // the day lists but keeps its page and its place in the guides.
        const info = state.publishedKeys.has(k) && state.canKeep ? state.scoreInfo.get(k) : null;
        const scorePill = !info ? ''
          : info.pick
          ? '<span class="src-pill src-pill--kept" title="Score ' + info.score + ': one of this day’s top events, so the site shows it as a Vic’s Pick. A paid Vic’s Pick takes its place.">Vic’s Pick (auto)</span>'
          : info.keep
          ? '<span class="src-pill src-pill--kept" title="Shown on its day whatever its score (you chose this).">Shown anyway</span>' +
            '<button type="button" class="btn btn--outline event-row__keep-btn" data-act="keep-event" data-keep="0" data-key="' + escapeHtml(k) + '">Undo</button>'
          : info.overflow
          ? '<span class="src-pill src-pill--dropped" title="Score ' + info.score + ': not in this day’s top events, so it’s off the homepage, newsletter and day pages. It keeps its own page and stays in the guides.">Dropped · score ' + info.score + '</span>' +
            '<button type="button" class="btn btn--outline event-row__keep-btn" data-act="keep-event" data-keep="1" data-key="' + escapeHtml(k) + '">Show anyway</button>'
          : '';
        const publishedPill = state.hiddenKeys.has(k)
          ? '<span class="src-pill src-pill--hidden" title="Published, but the event check hid it from the site. Restore it on the Home tab.">Hidden by check</span>'
          : state.publishedKeys.has(k)
          ? '<span class="src-pill src-pill--published" title="Currently live on ' + escapeHtml(town().domain) + '">On site</span>'
          : '';
        const submitterMeta = ev._submitter_kind
          ? '<span class="src-meta">' + escapeHtml(ev._submitter_kind === 'organizer'
              ? 'Organizer' : ev._submitter_kind === 'found_online'
              ? 'Found online' : 'Submitter: ' + ev._submitter_kind) + '</span>'
          : '';
        // Clickable source URL. Rendered OUTSIDE the parent <label> so a
        // click opens the link instead of toggling the row checkbox, and
        // text-drag selects the URL text instead of being intercepted by
        // the label. data-act="open-source" lets the click handler stop
        // propagation so the surrounding label never sees it.
        const sourceLink = isHttpUrl(ev.url)
          ? '<a class="event-row__source-link" data-act="open-source" ' +
              'href="' + escapeHtml(httpUrl(ev.url)) + '" ' +
              'target="_blank" rel="noopener noreferrer" ' +
              'title="Open source: ' + escapeHtml(ev.url) + '">' +
              escapeHtml(shortenUrl(ev.url)) + ' ↗</a>'
          : '';
        // The Edit button is rendered alongside the checkbox label so the
        // operator can correct AI mistakes on a candidate (typos, missing
        // times, wrong venue) without touching the checkbox state. It lives
        // outside the <label> so clicking it doesn't toggle the checkbox.
        const editBtn = (publishMode() === 'server')
          ? '<button type="button" class="btn btn--outline event-row__edit-btn" ' +
              'data-act="edit-event" data-key="' + escapeHtml(k) + '">Edit</button>'
          : '';
        const actionsHtml = (editBtn || sourceLink)
          ? '<div class="event-row__actions">' + editBtn + sourceLink + '</div>'
          : '';
        return (
          '<div class="event-row-wrap">' +
            '<label class="event-row">' +
              '<input type="checkbox" data-key="' + escapeHtml(k) + '" ' + checked + '>' +
              '<div class="event-row__main">' +
                '<p class="event-row__name">' + escapeHtml(ev.name || '(untitled)') +
                  ' ' + srcPill + publishedPill + scorePill + submitterMeta + '</p>' +
                '<div class="event-row__meta">' +
                  (ev.time ? '<span>🕒 ' + escapeHtml(ev.time) + (ev.end_time ? ' – ' + escapeHtml(ev.end_time) : '') + '</span>' : '') +
                  (ev.venue ? '<span>📍 ' + escapeHtml(ev.venue) + '</span>' : '') +
                  (ev.free ? '<span>🆓 Free</span>' : '') +
                '</div>' +
                (ev.description
                  ? '<p class="event-row__desc">' + escapeHtml(ev.description) + '</p>'
                  : '') +
                actionsHtml +
              '</div>' +
              '<div class="event-row__icons" aria-hidden="true">' + icons + '</div>' +
            '</label>' +
          '</div>'
        );
      }).join('');

      return (
        '<section class="day-group" data-date="' + escapeHtml(date) + '">' +
          '<h2>' + escapeHtml(heading) +
            ' <span class="day-group__count ' + countCls + '">' +
              selectedInGroup + ' of ' + evs.length + ' on the site' +
            '</span>' +
          '</h2>' +
          rows +
        '</section>'
      );
    }).join('');

    listEl.querySelectorAll('input[type="checkbox"][data-key]').forEach(cb => {
      cb.addEventListener('change', () => {
        const k = cb.getAttribute('data-key');
        if (cb.checked) state.selected.add(k);
        else state.selected.delete(k);
        persistSelections();
        updateCounts();
        renderPicker();
      });
    });

    listEl.querySelectorAll('button[data-act="keep-event"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const k = btn.getAttribute('data-key');
        const keep = btn.getAttribute('data-keep') === '1';
        btn.disabled = true;
        try {
          const { res, json } = await adminFetch('/api/admin/keep-event', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: k, keep })
          });
          if (!res.ok || !json || !json.ok) throw new Error('HTTP ' + res.status);
          setStatus(keep ? 'It’s back on its day.' : 'It’s scored like the rest again.', 'success');
          // Re-reads scores; unsaved picks survive (they're kept as pending).
          await loadPublishedAndSeedSelections();
          renderPicker();
        } catch (err) {
          btn.disabled = false;
          setStatus('Couldn’t change that event: ' + err.message, 'error');
        }
      });
    });

    listEl.querySelectorAll('button[data-act="edit-event"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const k = btn.getAttribute('data-key');
        const ev = state.candidates.find(c => eventKey(c) === k);
        if (ev) openEventEditModal(ev);
      });
    });

    // Source link click must not toggle the row's checkbox or "select" the
    // label. We stop propagation but DON'T preventDefault — the browser
    // still follows the href into a new tab via target="_blank".
    listEl.querySelectorAll('a[data-act="open-source"]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      // Same for keyboard activation (Enter on a focused link).
      a.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
      });
    });

    updateCounts();
  }

  function updateCounts() {
    const total = state.selected.size;
    let weekday = 0, weekend = 0;
    for (const ev of state.candidates) {
      if (!state.selected.has(eventKey(ev))) continue;
      if (isWeekend(ev.date)) weekend++; else weekday++;
    }
    const sum = document.getElementById('count-summary');
    if (sum) {
      const added = Array.from(state.selected).filter(k => !state.publishedKeys.has(k)).length;
      const thisMonday = toLocalDateStr(getMondayOfWeek());
      const removed = Array.from(state.publishedKeys).filter(k => !state.selected.has(k) &&
        state.candidates.some(ev => eventKey(ev) === k && (ev.date || '') >= thisMonday)).length;
      void weekday; void weekend;
      sum.textContent = total + ' event' + (total === 1 ? '' : 's') + ' checked' +
        (added || removed ? ' · unsaved: ' + (added ? '+' + added + ' ' : '') + (removed ? '−' + removed : '') : ' · matches the live site');
      sum.classList.remove('is-ok', 'is-warn');
      sum.classList.add(added || removed ? 'is-warn' : 'is-ok');
    }
  }

  // ─── SELECTIONS PERSISTENCE ───
  // Unsaved changes are stored as a diff against the live site, so Reload
  // or a refresh keeps them without freezing out events that went live
  // meanwhile (auto-publish).
  const PENDING_KEY = 'vic361_admin_pending';
  function persistSelections() {
    try {
      localStorage.setItem(PICKS_KEY, JSON.stringify(Array.from(state.selected)));
      if (state.liveLoaded) {
        const add = Array.from(state.selected).filter(k => !state.publishedKeys.has(k));
        const remove = Array.from(state.publishedKeys).filter(k => !state.selected.has(k));
        if (add.length || remove.length) localStorage.setItem(PENDING_KEY, JSON.stringify({ add, remove }));
        else localStorage.removeItem(PENDING_KEY);
      }
    } catch (_) {}
  }
  function readPending() {
    try {
      const p = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
      if (p && Array.isArray(p.add) && Array.isArray(p.remove)) return p;
    } catch (_) {}
    return { add: [], remove: [] };
  }
  function restoreSelectionsFromStorage() {
    try {
      const raw = localStorage.getItem(PICKS_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) state.selected = new Set(arr);
    } catch (_) {}
  }

  // Pulls the currently-published events from the server and seeds
  // state.selected so candidates already live show up pre-checked. Also
  // populates state.publishedKeys for the "Published" pill in renderPicker.
  // Server endpoint requires admin auth; in PAT mode (no Railway session)
  // there's no Railway-side published store to read, so we skip silently.
  async function loadPublishedAndSeedSelections() {
    if (publishMode() !== 'server') return;
    state.liveLoaded = false;
    try {
      const { res, json } = await adminFetch('/api/admin/published-events');
      if (!res.ok || !json || !json.ok) throw new Error('HTTP ' + res.status);
      const events = Array.isArray(json.events) ? json.events : [];
      const keys = new Set(events.map(eventKey));
      state.publishedKeys = keys;
      // "Show anyway" saves to the published store; with nothing published
      // there yet (the bundled file is showing), there's nothing to save to.
      state.canKeep = json.source === 'store';
      state.scoreInfo = new Map(events.filter(ev => typeof ev.score === 'number')
        .map(ev => [eventKey(ev), { score: ev.score, overflow: Boolean(ev.overflow), keep: Boolean(ev.keep), pick: Boolean(ev.editor_pick) }]));
      // Sent back with Save & Publish so the server can refuse if the live
      // list changed meanwhile (see /api/admin/publish-events).
      state.publishedVersion = json.last_updated || null;
      // Match on the original key and the shown (edited) one: the list
      // here has the edits overlay applied.
      state.hiddenKeys = new Set((await loadHidden()).flatMap(h => [h.key, h.shown_key].filter(Boolean)));
      // The live site is the starting point: everything on it starts checked.
      // Live events that aren't in this week's candidates (kept from an
      // earlier collect, approved submissions, hand-added) are added to the
      // list too. Otherwise they'd be invisible here and Save & Publish
      // would silently take them off the site.
      const candidateKeys = new Set(state.candidates.map(eventKey));
      const thisMonday = toLocalDateStr(getMondayOfWeek());
      const liveOnly = events.filter(ev => !candidateKeys.has(eventKey(ev)) && (ev.date || '') >= thisMonday);
      if (liveOnly.length) {
        state.candidates = state.candidates.concat(liveOnly).sort((a, b) =>
          ((a.date || '') + ' ' + (a.time || '')).localeCompare((b.date || '') + ' ' + (b.time || '')));
      }
      state.selected = new Set(keys);
      const pending = readPending();
      const known = new Set(state.candidates.map(eventKey));
      pending.add.forEach(k => { if (known.has(k)) state.selected.add(k); });
      pending.remove.forEach(k => state.selected.delete(k));
      state.liveLoaded = true;
      persistSelections();
    } catch (err) {
      // Without the live list, Save & Publish would quietly drop every live
      // event that isn't in this week's candidates. Block it instead.
      console.warn('[admin] published-events fetch failed:', err.message);
      setStatus('Couldn’t load what’s live on the site, so Save & Publish is off. Press Reload to try again.', 'error');
    }
    const btn = document.getElementById('publish-btn');
    if (btn) btn.disabled = !state.liveLoaded;
  }

  function pruneStalePastSelections() {
    const thisMonday = toLocalDateStr(getMondayOfWeek());
    const keep = new Set();
    for (const ev of state.candidates) {
      const k = eventKey(ev);
      if (state.selected.has(k) && (ev.date || '') >= thisMonday) keep.add(k);
    }
    if (keep.size !== state.selected.size) {
      state.selected = keep;
      persistSelections();
    }
  }

  // ─── PICKED EVENTS ─→ events.json shape ───
  function getPickedEvents() {
    return state.candidates.filter(ev => state.selected.has(eventKey(ev)));
  }
  // Fields that must never leak to the public events.json. Includes the
  // contact-detail fields added when the submission form started requiring
  // first/last/email/phone — they live on the payload for the admin queue but
  // are not part of the public event shape.
  const PRIVATE_KEYS = new Set([
    'submitter_name', 'submitter_email', 'submitter_ip', 'user_agent',
    'submitter_first_name', 'submitter_last_name', 'submitter_phone',
    'submitter_kind',
    'admin_notes', 'review_history'
  ]);
  function stripPrivateFields(ev) {
    const out = {};
    let publicSource = null;
    for (const [k, v] of Object.entries(ev || {})) {
      if (PRIVATE_KEYS.has(k)) continue;
      if (k === '_source') { publicSource = v; continue; }
      if (k.startsWith('_')) continue;
      out[k] = v;
    }
    if (publicSource) out.source = publicSource;
    return out;
  }
  function buildEventsPayload() {
    return {
      last_updated: new Date().toISOString(),
      events: getPickedEvents().map(stripPrivateFields)
    };
  }

  // ─── PREVIEW TAB ───
  const PREVIEW_STORAGE_PREFIX = 'vic361_preview_';

  function generatePreviewKey() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function writePreviewToStorage(payload) {
    const key = generatePreviewKey();
    const storageKey = PREVIEW_STORAGE_PREFIX + key;
    try {
      // One preview at a time; old ones would fill sessionStorage.
      Object.keys(sessionStorage).forEach(k => { if (k.indexOf(PREVIEW_STORAGE_PREFIX) === 0) sessionStorage.removeItem(k); });
      sessionStorage.setItem(storageKey, JSON.stringify(payload));
    } catch (err) {
      console.error('Failed to write preview to sessionStorage:', err);
      return null;
    }
    return key;
  }

  function buildPreviewSrc(payload) {
    const key = writePreviewToStorage(payload);
    if (key) {
      return 'index.html?previewKey=' + encodeURIComponent(key);
    }
    setStatus('Preview couldn’t be prepared (browser storage is full or blocked).', 'error');
    return 'about:blank';
  }

  function refreshPreview() {
    const frame = document.getElementById('preview-frame');
    if (!frame) return;
    frame.src = buildPreviewSrc(buildEventsPayload());
  }

  // ─── NEWSLETTER TAB ───
  function buildNewsletterHtml() {
    const picks = getPickedEvents();
    if (!picks.length) {
      return '<p>No events selected yet.</p>';
    }
    const groups = groupByDate(picks);
    const parts = [];
    parts.push('<div style="font-family: Georgia, serif; color:#222; max-width:640px;">');
    parts.push('<h1 style="font-family: Georgia, serif;">This Week in ' + escapeHtml(town().siteName) + '</h1>');
    for (const [date, evs] of groups) {
      const heading = date === '(undated)' ? 'Undated' : formatDateHeading(date);
      parts.push('<h2 style="border-bottom:2px solid #2d5b8a; padding-bottom:4px;">' +
        escapeHtml(heading) + '</h2>');
      for (const ev of evs) {
        parts.push('<div style="margin: 0 0 16px;">');
        const titleText = escapeHtml(ev.name || '(untitled)');
        const title = ev.url
          ? '<a href="' + escapeHtml(httpUrl(ev.url)) + '" style="color:#2d5b8a;">' + titleText + '</a>'
          : titleText;
        parts.push('<p style="margin:0; font-weight:bold; font-size:1.1em;">' + title + '</p>');
        const meta = [];
        if (ev.time) meta.push(escapeHtml(ev.time));
        if (ev.venue) meta.push(escapeHtml(ev.venue));
        if (ev.address) meta.push(escapeHtml(ev.address));
        if (ev.free) meta.push('Free');
        if (meta.length) {
          parts.push('<p style="margin:2px 0; color:#555; font-size:0.95em;">' +
            meta.join(' · ') + '</p>');
        }
        if (ev.description) {
          parts.push('<p style="margin:6px 0 0;">' + escapeHtml(ev.description) + '</p>');
        }
        parts.push('</div>');
      }
    }
    parts.push('</div>');
    return parts.join('\n');
  }

  function refreshNewsletter() {
    const ta = document.getElementById('newsletter-html');
    if (!ta) return;
    ta.value = buildNewsletterHtml();
  }

  async function copyNewsletter() {
    const ta = document.getElementById('newsletter-html');
    const flash = document.getElementById('newsletter-copied');
    if (!ta) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(ta.value);
      } else {
        ta.removeAttribute('readonly');
        ta.select();
        document.execCommand('copy');
        ta.setAttribute('readonly', '');
      }
      if (flash) {
        flash.hidden = false;
        setTimeout(() => { flash.hidden = true; }, 1500);
      }
    } catch (err) {
      setStatus('Copy failed: ' + (err && err.message), 'error');
    }
  }

  // ─── EMAIL NEWSLETTER (Resend) ───
  function emailNlMsg(text, kind) {
    const el = document.getElementById('email-nl-msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', kind === 'error');
    el.classList.toggle('is-success', kind === 'success');
  }

  function renderEmailNewsletter(d) {
    const st = document.getElementById('email-nl-status');
    const item = (label, value) => '<div class="sources-summary__item"><span class="sources-summary__label">' +
      escapeHtml(label) + '</span><span class="sources-summary__value">' + escapeHtml(String(value)) + '</span></div>';
    if (st) st.innerHTML = item('Subscribers', d.counts.active) + item('Awaiting confirmation', d.counts.pending) +
      item('Unsubscribed', d.counts.unsubscribed) +
      item('Monday issue', d.this_week_failed ? ('Partly sent (' + d.this_week_failed + ' failed)')
        : d.this_week_sent ? 'Sent' : (d.next.events + ' events ready')) +
      (d.weekend ? item('Thursday weekend issue', !d.weekend.enabled ? 'Off (NEWSLETTER_WEEKEND=0)'
        : d.weekend.failed ? ('Partly sent (' + d.weekend.failed + ' failed)')
        : d.weekend.sent ? 'Sent' : (d.weekend.next.events + ' events ready')) +
        item('Skip Thursdays', d.weekend.opted_out || 0) : '') +
      item('Auto-send', d.autosend ? (d.weekend && d.weekend.enabled === false ? 'On, Mondays' : 'On, Mondays and Thursdays') : 'Off');
    const warn = document.getElementById('email-nl-warning');
    const issues = [];
    if (!d.configured) issues.push('Add RESEND_API_KEY in Railway to turn on sending. Signups are being saved in the meantime.');
    if (!d.address_set) issues.push('Set NEWSLETTER_ADDRESS (a mailing address) in Railway; US law requires one in every newsletter.');
    if (warn) { warn.hidden = !issues.length; warn.textContent = issues.join(' '); }
    syncEmailNlSend(d);
    const sends = document.getElementById('email-nl-sends');
    if (sends) {
      sends.innerHTML = (d.sends || []).length
        ? '<tr><th class="traffic-label"></th><th class="traffic-num">Sent</th><th class="traffic-num">Opened</th></tr>' +
          d.sends.map(s => {
            const n = Number(s.recipients) || 0;
            const kind = s.edition === 'weekend' ? 'Thu weekend' : 'Mon';
            // Opens: unique per subscriber, from the tracking image.
            const opened = typeof s.opens === 'number'
              ? s.opens + (n ? ' (' + Math.round(100 * s.opens / n) + '%)' : '') : '—';
            return '<tr><td class="traffic-label"><small>' + kind + '</small> ' + escapeHtml(s.subject || s.week_key) + '</td><td class="traffic-num">' +
              n + (s.failed ? ' (' + Number(s.failed) + ' failed)' : '') + '</td><td class="traffic-num">' + escapeHtml(opened) + '</td></tr>';
          }).join('') +
          '<tr><td class="traffic-empty" colspan="3"><small>Opens read high: Apple Mail loads every email\u2019s images for its users, and some work mail scanners do too.</small></td></tr>'
        : '<tr><td class="traffic-empty">No newsletters sent yet.</td></tr>';
    }
    // Referral program: who's sharing. "Counted" is a friend still subscribed
    // a day after signing up; "pending" is still in that hold.
    const refs = document.getElementById('email-nl-referrers');
    if (refs) {
      const tiers = (d.referral_tiers || []).map(t => t.n + ': ' + t.reward).join(' · ');
      refs.innerHTML = (d.referrers || []).length
        ? '<tr><th class="traffic-label"></th><th class="traffic-num">Counted</th><th class="traffic-num">Pending</th></tr>' +
          d.referrers.map(r => '<tr><td class="traffic-label">' + escapeHtml(r.email) + '</td><td class="traffic-num">' +
            Number(r.referrals) + '</td><td class="traffic-num">' + Number(r.pending) + '</td></tr>').join('') +
          '<tr><td class="traffic-empty" colspan="3"><small>Rewards: ' + escapeHtml(tiers) + '</small></td></tr>'
        : '<tr><td class="traffic-empty">No referrals yet. Every subscriber gets a share link in the welcome email and every issue.</td></tr>';
    }
    // Gift cards the Monday send created (server/referralRewards.js). Held
    // ones (friends that look made up), failed ones and, without Tremendous,
    // by-hand ones get Send / Skip.
    const rw = document.getElementById('email-nl-rewards');
    if (rw) {
      const label = { sent: 'Sent', pending: 'Sending', held: '\u{1F440} Held', failed: 'Failed', manual: 'Send by hand', skipped: 'Skipped' };
      const how = d.gift_cards === 'tremendous' ? 'Gift cards go out automatically through Tremendous.'
        : 'Tremendous isn\u2019t set up (TREMENDOUS_API_KEY, TREMENDOUS_CAMPAIGN_ID), so send these by hand.';
      rw.innerHTML = (d.referral_rewards || []).map(r => {
        const note = r.status === 'held' ? r.flags : (r.status === 'failed' || r.status === 'manual') ? r.reason : '';
        const act = ['held', 'failed', 'manual'].includes(r.status)
          ? '<button type="button" class="btn btn--outline" data-reward="' + escapeHtml(r.id) + '" data-act="approve">' +
            (d.gift_cards === 'tremendous' ? 'Send' : 'Mark sent') + '</button> ' +
            '<button type="button" class="btn btn--outline" data-reward="' + escapeHtml(r.id) + '" data-act="skip">Skip</button>'
          : '';
        return '<tr><td class="traffic-label">' + escapeHtml(r.email) + '<br><small>' + escapeHtml(r.what) +
          (note ? ' \u00b7 ' + escapeHtml(note) : '') + '</small></td><td class="traffic-num">' + escapeHtml(label[r.status] || r.status) +
          '</td><td class="traffic-num">' + act + '</td></tr>';
      }).join('') + '<tr><td class="traffic-empty" colspan="3"><small>' + escapeHtml(how) + '</small></td></tr>';
    }
  }

  // The issue picked next to the buttons (Monday's or Thursday's).
  const nlEdition = () => ((document.getElementById('email-nl-edition') || {}).value === 'weekend' ? 'weekend' : 'weekly');
  // The send button for the picked issue: sent, partly sent (retry just the
  // people who missed it), or ready.
  function syncEmailNlSend(d) {
    const send = document.getElementById('email-nl-send');
    if (!send || !d || !d.counts) return;
    const wk = nlEdition() === 'weekend';
    const w = d.weekend || {};
    const failed = wk ? w.failed : d.this_week_failed;
    const sent = wk ? w.sent : d.this_week_sent;
    const n = wk ? Math.max(0, d.counts.active - (w.opted_out || 0)) : d.counts.active;
    send.disabled = !d.configured || !n || Boolean(sent) || (wk && !w.enabled);
    send.textContent = failed ? ('Retry ' + failed + ' failed') : sent ? (wk ? 'Weekend issue already sent' : 'Already sent this week')
      : ('Send to ' + n + ' subscribers');
  }

  async function loadEmailNewsletter() {
    if (publishMode() !== 'server') return;
    try {
      const { res, json } = await adminFetch('/api/admin/newsletter');
      if (!res.ok || !json || !json.ok) throw new Error((json && json.message) || ('HTTP ' + res.status));
      state.emailNewsletter = json;
      renderEmailNewsletter(json);
    } catch (err) {
      emailNlMsg('Could not load newsletter status: ' + (err.message || err), 'error');
    }
  }

  async function previewEmailNewsletter() {
    const frame = document.getElementById('email-nl-frame');
    try {
      const res = await fetch(apiBaseUrl() + '/api/admin/newsletter/preview?edition=' + nlEdition(),
        { headers: state.session ? { Authorization: 'Bearer ' + state.session } : {} });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      frame.srcdoc = await res.text();
      frame.hidden = false;
    } catch (err) {
      emailNlMsg('Preview failed: ' + (err.message || err), 'error');
    }
  }

  async function emailNlPost(path, body, okText) {
    try {
      const { res, json } = await adminFetch(path, { method: 'POST', body: JSON.stringify(body || {}), headers: { 'Content-Type': 'application/json' } });
      if (!res.ok || !json || !json.ok) throw new Error((json && (json.message || json.error)) || ('HTTP ' + res.status));
      emailNlMsg(okText(json), 'success');
      loadEmailNewsletter();
    } catch (err) {
      emailNlMsg(err.message || String(err), 'error');
      // A partly failed send changed the status (and the button to Retry).
      loadEmailNewsletter();
    }
  }

  // ─── EVENT EDIT MODAL (PR #22) ───
  // The admin Edit button on a picker row opens this modal so an operator can
  // correct details an AI scraper got wrong (typos, missing times, wrong
  // venue) without re-running the weekly collector. Edits are persisted on
  // the server in an overlay keyed by the original eventKey, then merged into
  // /api/admin/candidates and /api/admin/published-events automatically.
  // Save & Publish still owns the actual write to the public site, so the
  // admin approval/publish workflow stays intact.
  const ICON_KEYS = [
    'food', 'music', 'family', 'drinks', 'arts',
    'shopping', 'outdoors', 'community', 'free'
  ];

  // The candidate event currently being edited. Used by the save handler to
  // derive the original_key the server expects.
  let editingEvent = null;

  function setEditFormStatus(text, kind) {
    const el = document.getElementById('event-edit-status');
    if (!el) return;
    el.classList.remove('is-error', 'is-success');
    if (kind === 'error') el.classList.add('is-error');
    if (kind === 'success') el.classList.add('is-success');
    el.textContent = text || '';
  }

  function clearEditFormErrors() {
    const errEl = document.getElementById('event-edit-form-error');
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
    document.querySelectorAll('.event-edit-form__field-error').forEach(s => {
      s.textContent = '';
    });
  }

  function showEditFormErrors(errors) {
    if (!errors) return;
    const errEl = document.getElementById('event-edit-form-error');
    if (errors._form && errEl) {
      errEl.textContent = errors._form;
      errEl.hidden = false;
    }
    Object.entries(errors).forEach(([field, msg]) => {
      if (field === '_form') return;
      const span = document.querySelector(
        '.event-edit-form__field-error[data-error-for="' + field + '"]'
      );
      if (span) span.textContent = msg;
    });
    if (errEl && !errors._form) {
      errEl.textContent = 'Please fix the highlighted fields and try again.';
      errEl.hidden = false;
    }
  }

  // Keep the modal's "Open ↗" link, "Copy full URL" button, and read-only
  // <code> display in sync with whatever's typed in the URL field. The Open
  // link is hidden when the input is empty or doesn't parse as http(s) so we
  // never let the admin click through to a javascript: URL or similar. The
  // Copy button + display show whenever there's any URL text at all (even a
  // partial URL the admin is fixing) so it's always copy-able.
  // Start and end time choices, as on the submit form (docs/submit.js
  // buildTimeOptions): every half hour from 5:00 AM to 1:30 AM.
  const TIME_CHOICES = (function () {
    const out = [];
    for (let m = 5 * 60; m <= 25 * 60 + 30; m += 30) {
      const hh = Math.floor(m / 60) % 24;
      out.push(((hh + 11) % 12 + 1) + ':' + String(m % 60).padStart(2, '0') + (hh < 12 ? ' AM' : ' PM'));
    }
    return out;
  })();

  // Select an event's time; "06:30 PM" or "7pm" picks the matching choice,
  // and a time that isn't one (6:45 PM, "Doors 7, show 8") is added so
  // opening the editor never drops it.
  const TIME_RE = /^0?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i;
  function setTimeSelect(select, value) {
    let v = String(value || '').trim();
    const m = v.match(TIME_RE);
    if (m) v = Number(m[1]) + ':' + (m[2] || '00') + ' ' + m[3].toUpperCase() + 'M';
    if (select.options.length < 2) {
      for (const t of TIME_CHOICES) select.add(new Option(t, t));
    }
    Array.from(select.querySelectorAll('option[data-extra]')).forEach(o => o.remove());
    if (v && !TIME_CHOICES.includes(v)) {
      const o = new Option(v, v);
      o.dataset.extra = '1';
      select.add(o, 1);
    }
    select.value = v;
  }

  function syncEditUrlOpenLink() {
    const input = document.getElementById('event-edit-url');
    const link = document.getElementById('event-edit-url-open');
    const copyBtn = document.getElementById('event-edit-url-copy');
    const display = document.getElementById('event-edit-url-display');
    const copied = document.getElementById('event-edit-url-copied');
    if (!input) return;
    const raw = (input.value || '').trim();
    if (link) {
      if (isHttpUrl(raw)) {
        link.href = raw;
        link.hidden = false;
      } else {
        link.removeAttribute('href');
        link.hidden = true;
      }
    }
    if (copyBtn) copyBtn.hidden = !raw;
    if (display) {
      if (raw) {
        display.textContent = raw;
        display.hidden = false;
      } else {
        display.textContent = '';
        display.hidden = true;
      }
    }
    // Hide the "Copied!" flash whenever the URL changes — it's only shown
    // briefly after a successful copy.
    if (copied) copied.hidden = true;
  }

  // Copies the full URL to the clipboard. Falls back to the legacy
  // execCommand path on browsers without navigator.clipboard. We surface a
  // brief "Copied!" flash so the admin gets immediate confirmation; if the
  // copy fails we set a status message instead of leaving the user wondering.
  async function copyEditUrl() {
    const input = document.getElementById('event-edit-url');
    const copied = document.getElementById('event-edit-url-copied');
    if (!input) return false;
    const raw = (input.value || '').trim();
    if (!raw) return false;
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(raw);
        ok = true;
      }
    } catch (_) { /* fall through to legacy path */ }
    if (!ok) {
      try {
        // Legacy path: select the input contents and run execCommand('copy').
        // Works even when navigator.clipboard is unavailable (older Safari,
        // insecure contexts).
        input.focus();
        input.select();
        ok = document.execCommand && document.execCommand('copy');
      } catch (_) { ok = false; }
    }
    if (ok && copied) {
      copied.hidden = false;
      setTimeout(() => { copied.hidden = true; }, 1500);
    } else if (!ok) {
      setEditFormStatus('Could not copy — please select the URL text manually.', 'error');
    }
    return ok;
  }

  function openEventEditModal(ev) {
    if (!ev) return;
    editingEvent = ev;
    const modal = document.getElementById('event-edit-modal');
    const form = document.getElementById('event-edit-form');
    if (!modal || !form) return;
    clearEditFormErrors();
    setEditFormStatus('');
    // Prefill fields from the current event shape.
    form.elements['name'].value = ev.name || '';
    form.elements['date'].value = ev.date || '';
    // A collected range ("9:00 AM – 1:00 PM") opens as its start and end;
    // the site joins them back the same way.
    let start = ev.time || '';
    let end = ev.end_time || '';
    const range = !end && String(start).match(/^\s*([^–—-]+?)\s*[–—-]\s*([^–—-]+?)\s*$/);
    if (range && TIME_RE.test(range[1]) && TIME_RE.test(range[2])) { start = range[1]; end = range[2]; }
    setTimeSelect(form.elements['time'], start);
    // An event collected without a time can be corrected without inventing
    // one (validateEventEdit allows it blank); one that had a time keeps it.
    const timeRequired = Boolean(String(ev.time || '').trim());
    form.elements['time'].required = timeRequired;
    const timeMark = form.querySelector('[data-time-required]');
    if (timeMark) timeMark.hidden = !timeRequired;
    setTimeSelect(form.elements['end_time'], end);
    form.elements['venue'].value = ev.venue || '';
    form.elements['address'].value = ev.address || '';
    form.elements['description'].value = ev.description || '';
    form.elements['url'].value = ev.url || '';
    syncEditUrlOpenLink();
    form.elements['free'].checked = Boolean(ev.free);
    // An editor's pick is featured only by its score (server/scoring.js);
    // the box means a real Vic's Pick, so it starts unticked for one.
    if (form.elements['featured']) form.elements['featured'].checked = Boolean(ev.featured && !ev.editor_pick);
    const haveIcons = new Set(Array.isArray(ev.icons) ? ev.icons : []);
    form.querySelectorAll('input[name="icons"]').forEach(cb => {
      cb.checked = haveIcons.has(cb.value);
    });
    modal.hidden = false;
    // Focus the first field for keyboard users.
    setTimeout(() => {
      try { form.elements['name'].focus(); } catch (_) {}
    }, 0);
  }

  function closeEventEditModal() {
    const modal = document.getElementById('event-edit-modal');
    if (modal) modal.hidden = true;
    editingEvent = null;
    clearEditFormErrors();
    setEditFormStatus('');
    setSaving(false);
    syncEditUrlOpenLink();
  }

  function setSaving(on) {
    const btn = document.getElementById('event-edit-save-btn');
    const form = document.getElementById('event-edit-form');
    if (!form || !btn) return;
    btn.disabled = !!on;
    btn.textContent = on ? 'Saving…' : 'Save changes';
    form.querySelectorAll('input, textarea, button[data-act="close"]').forEach(el => {
      if (el.id === 'event-edit-save-btn') return;
      el.disabled = !!on;
    });
  }

  function readEditFormPayload() {
    const form = document.getElementById('event-edit-form');
    if (!form) return null;
    const icons = Array.from(form.querySelectorAll('input[name="icons"]:checked'))
      .map(cb => cb.value);
    return {
      name: (form.elements['name'].value || '').trim(),
      date: (form.elements['date'].value || '').trim(),
      time: (form.elements['time'].value || '').trim(),
      end_time: (form.elements['end_time'].value || '').trim(),
      venue: (form.elements['venue'].value || '').trim(),
      address: (form.elements['address'].value || '').trim(),
      description: (form.elements['description'].value || '').trim(),
      url: (form.elements['url'].value || '').trim(),
      icons,
      free: Boolean(form.elements['free'].checked),
      featured: Boolean(form.elements['featured'] && form.elements['featured'].checked)
    };
  }

  // Apply an edited event to local state.candidates so the picker, preview,
  // and newsletter all reflect the correction immediately without a reload.
  // We replace the row matching the original key with the new shape, then
  // dedupe by the new key so we never end up with two rows for one event.
  function applyEditToLocalState(originalKey, edited) {
    const newKey = [edited.date || '', edited.name || '', edited.venue || ''].join('|');
    const next = [];
    const seen = new Set();
    let replaced = false;
    for (const ev of state.candidates) {
      const k = eventKey(ev);
      if (k === originalKey) {
        const merged = { ...ev, ...edited };
        // Ticked Vic's Pick: a real one now, not the score's (Save & Publish
        // strips `featured` from editor's picks).
        if (edited.featured) delete merged.editor_pick;
        const mk = eventKey(merged);
        if (!seen.has(mk)) { seen.add(mk); next.push(merged); }
        replaced = true;
        continue;
      }
      if (replaced && k === newKey) continue; // collide with new key — drop
      if (seen.has(k)) continue;
      seen.add(k);
      next.push(ev);
    }
    state.candidates = next;
    // Keep selection state in sync — if the original was selected, the new
    // key carries that forward.
    if (state.selected.has(originalKey) && originalKey !== newKey) {
      state.selected.delete(originalKey);
      state.selected.add(newKey);
      persistSelections();
    }
    if (state.publishedKeys.has(originalKey) && originalKey !== newKey) {
      state.publishedKeys.delete(originalKey);
      state.publishedKeys.add(newKey);
    }
  }

  async function saveEventEdit(e) {
    if (e) e.preventDefault();
    if (!editingEvent) return;
    if (publishMode() !== 'server') {
      setEditFormStatus('Editing requires a server session — sign in first.', 'error');
      return;
    }
    clearEditFormErrors();
    const payload = readEditFormPayload();
    if (!payload) return;
    const originalKey = eventKey(editingEvent);
    setSaving(true);
    setEditFormStatus('Saving…');
    try {
      const { res, json } = await adminFetch('/api/admin/event-edits', {
        method: 'POST',
        body: JSON.stringify({ original_key: originalKey, payload })
      });
      if (res.status === 400 && json && json.errors) {
        showEditFormErrors(json.errors);
        setEditFormStatus('Fix the errors and save again.', 'error');
        return;
      }
      if (!res.ok || !json || !json.ok) {
        const msg = (json && (json.message || json.error))
          || ('Save failed (HTTP ' + res.status + ').');
        setEditFormStatus(msg, 'error');
        return;
      }
      // Server stores `payload` as the canonical edited shape. Apply it to
      // local state so the UI updates without a full reload.
      applyEditToLocalState(originalKey, json.edit && json.edit.payload || payload);
      populateFilters();
      renderPicker();
      setStatus('Event updated. Save & Publish to push the change live.', 'success');
      closeEventEditModal();
    } catch (err) {
      console.error('[admin] event edit save failed:', err);
      setEditFormStatus(err.message || 'Save failed.', 'error');
    } finally {
      setSaving(false);
    }
  }

  function wireEventEditModal() {
    const modal = document.getElementById('event-edit-modal');
    const form = document.getElementById('event-edit-form');
    if (!modal || !form) return;
    modal.querySelectorAll('[data-act="close"]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        closeEventEditModal();
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) closeEventEditModal();
    });
    form.addEventListener('submit', saveEventEdit);
    // Live-update the "Open ↗" link, copy button, and full-URL display as
    // the admin edits the URL field.
    const urlInput = document.getElementById('event-edit-url');
    if (urlInput) {
      urlInput.addEventListener('input', syncEditUrlOpenLink);
      urlInput.addEventListener('change', syncEditUrlOpenLink);
    }
    const copyBtn = document.getElementById('event-edit-url-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        copyEditUrl();
      });
    }
    // The read-only <code> display is selectable. When the admin clicks it,
    // select the entire URL so a single click + Cmd/Ctrl+C is enough to copy.
    const display = document.getElementById('event-edit-url-display');
    if (display) {
      display.addEventListener('click', () => {
        try {
          const r = document.createRange();
          r.selectNodeContents(display);
          const sel = window.getSelection();
          if (sel) { sel.removeAllRanges(); sel.addRange(r); }
        } catch (_) { /* ignore — fallback is the Copy button */ }
      });
    }
  }

  // ─── PUBLISH ───
  async function publish() {
    const btn = document.getElementById('publish-btn');
    const picks = getPickedEvents();
    if (publishMode() === 'server' && !state.liveLoaded) {
      setStatus('Couldn’t load what’s live on the site. Press Reload before publishing.', 'error');
      return;
    }
    if (!picks.length) {
      setStatus('Select at least one event before publishing.', 'error');
      return;
    }
    const mode = publishMode();
    if (!mode) {
      setStatus('Cannot publish — please sign in first.', 'error');
      return;
    }
    if (!confirm('Update the live site to these ' + picks.length + ' checked event(s)? Unchecked events come off the site.')) {
      return;
    }
    if (btn) btn.disabled = true;
    setStatus('Publishing…');
    try {
      const payload = buildEventsPayload();
      if (mode === 'server') {
        const { res, json } = await adminFetch('/api/admin/publish-events', {
          method: 'POST',
          body: JSON.stringify({ events: payload.events, based_on: state.publishedVersion || undefined })
        });
        if (res.status === 409 && json && json.error === 'stale') {
          // Reload the live list; unsaved checks/unchecks are kept (pending).
          await loadPublishedAndSeedSelections();
          renderPicker();
          setStatus(json.message, 'error');
          return;
        }
        if (res.status === 413) {
          throw new Error('That list is too big to publish in one go. Uncheck some events and try again.');
        }
        if (!res.ok || !json || !json.ok) {
          throw new Error((json && (json.message || json.error)) || ('Publish failed (' + res.status + ')'));
        }
        // Surface partial-publish status. The server always saves to Railway
        // first; the GitHub commit is best-effort and only happens when
        // GITHUB_TOKEN is configured. A failed/skipped GitHub commit must NOT
        // be surfaced as an error — the public site (Railway/Postgres) is
        // already updated, which is what Save & Publish is responsible for.
        state.publishedKeys = new Set(state.selected);
        if (json.last_updated) state.publishedVersion = json.last_updated;
        persistSelections();
        renderPicker();
        const dest = (json && json.destinations) || {};
        const ghOk = dest.github && dest.github.ok;
        const ghAttempted = dest.github && dest.github.error !== 'github-not-configured';
        if (ghOk) {
          setStatus('Published ' + picks.length + ' event(s) to Railway and GitHub.', 'success');
        } else if (ghAttempted) {
          // Optional GitHub mirror failed (e.g. expired/bad token). The local
          // publish to Railway already succeeded, so this is a non-blocking
          // warning, not a failure of Save & Publish.
          console.warn('[admin] github mirror commit skipped:',
            (dest.github && dest.github.message) || 'unknown error');
          setStatus('Published ' + picks.length + ' event(s) to Railway. (Optional GitHub mirror skipped.)', 'success');
        } else {
          setStatus('Published ' + picks.length + ' event(s) to Railway.', 'success');
        }
        return;
      } else {
        // Legacy PAT fallback.
        let sha = null;
        try { sha = (await ghGetJsonFile(repo().eventsPath)).sha; }
        catch (err) { console.warn('Could not get current events.json sha:', err.message); }
        const msg = 'Publish events ' + new Date().toISOString().slice(0, 10) +
                    ' (' + picks.length + ' picks)';
        await ghPutJsonFile(repo().eventsPath, payload, msg, sha);
      }
      setStatus('Published ' + picks.length + ' event(s) to docs/events.json.', 'success');
    } catch (err) {
      console.error(err);
      setStatus(err.message || 'Publish failed.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ─── HOME TAB ───
  // Setup checklist and at-a-glance numbers from /api/admin/setup.
  function ago(iso) {
    if (!iso) return 'never';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return String(iso);
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 60) return mins + ' min ago';
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return hrs + ' hr ago';
    return Math.round(hrs / 24) + ' days ago';
  }
  // Events the event check hid. Best effort: a failure just shows none.
  async function loadHidden() {
    try {
      const { res, json } = await adminFetch('/api/admin/hidden');
      return res.ok && json && json.ok && Array.isArray(json.hidden) ? json.hidden : [];
    } catch (e) {
      return [];
    }
  }

  async function renderHiddenOnHome() {
    const box = document.getElementById('home-hidden');
    const list = document.getElementById('home-hidden-list');
    if (!box || !list) return;
    const hidden = await loadHidden();
    box.hidden = !hidden.length;
    list.innerHTML = hidden.map(h =>
      '<li class="home-check home-check--no"><span class="home-check__mark" aria-hidden="true">🙈</span><div>' +
      '<strong>' + escapeHtml(h.name || h.page) + '</strong> <span class="home-check__state">' +
      escapeHtml([h.date, h.venue].filter(Boolean).join(' · ')) + '</span>' +
      '<p class="home-check__fix">' + escapeHtml(h.reason || 'Hidden by the event check') +
      ' <button type="button" class="btn btn--outline" data-restore="' + escapeHtml(h.key) + '">Restore</button></p>' +
      '</div></li>').join('');
    list.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'Restoring…';
      try {
        const { res, json } = await adminFetch('/api/admin/hidden/restore', {
          method: 'POST', body: JSON.stringify({ key: b.dataset.restore }), headers: { 'Content-Type': 'application/json' }
        });
        if (!res.ok || !json || !json.ok) throw new Error((json && json.error) || ('HTTP ' + res.status));
        renderHiddenOnHome();
      } catch (e) {
        b.disabled = false;
        b.textContent = 'Restore failed, try again';
      }
    }));
  }

  // Contact-form messages (also sent to Slack); kept here so none is lost.
  async function renderMessagesOnHome() {
    const box = document.getElementById('home-messages');
    const list = document.getElementById('home-messages-list');
    if (!box || !list) return;
    let messages = [];
    try {
      const { res, json } = await adminFetch('/api/admin/messages');
      if (res.ok && json && json.ok && Array.isArray(json.messages)) messages = json.messages;
    } catch (e) { /* best effort */ }
    box.hidden = !messages.length;
    list.innerHTML = messages.slice(0, 20).map(m =>
      '<li class="home-check"><span class="home-check__mark" aria-hidden="true">✉️</span><div>' +
      '<strong>' + escapeHtml(m.name || '') + '</strong> <span class="home-check__state">' +
      escapeHtml([m.topic, m.business, ago(m.created_at)].filter(Boolean).join(' · ')) + '</span>' +
      '<p class="home-check__fix">' + escapeHtml(m.message || '') + '</p>' +
      '<p class="home-check__fix"><a href="mailto:' + escapeHtml(encodeURIComponent(m.email || '')).replace(/%40/g, '@') + '">' +
      escapeHtml(m.email || '') + '</a></p></div></li>').join('');
  }

  async function loadHome() {
    const el = document.getElementById('home-body');
    const err = document.getElementById('home-error');
    if (!el || publishMode() !== 'server') return;
    try {
      const { res, json } = await adminFetch('/api/admin/setup');
      if (!res.ok || !json || !json.ok) throw new Error((json && json.message) || 'Could not load status.');
      err.hidden = true;
      const st = json.status || {};
      // Collect runs Sunday and Wednesday: more than 4 days means a run was
      // missed or failed.
      const collectedMs = Date.parse(st.collected_at || '');
      const staleCollect = !Number.isFinite(collectedMs) || Date.now() - collectedMs > 4 * 86400000;
      const tiles = [
        ['Upcoming events on the site', st.upcoming_events ?? '—', 'picker'],
        ['Submissions waiting', st.pending_submissions ?? '—', 'submissions'],
        ['Newsletter subscribers', st.subscribers ?? '—', 'newsletter'],
        ['Events last collected', ago(st.collected_at), 'sources', staleCollect],
        ['Site last updated', ago(st.published_at), 'picker']
      ];
      document.getElementById('home-tiles').innerHTML = tiles.map(([label, val, tab, warn]) =>
        '<button type="button" class="home-tile' + (warn ? ' home-tile--warn' : '') + '" data-goto="' + tab + '"><span class="home-tile__val">' +
        escapeHtml(String(val)) + '</span><span class="home-tile__label">' + escapeHtml(label) +
        (warn ? ' (check the collector)' : '') + '</span></button>').join('');
      const order = { required: 0, recommended: 1, optional: 2 };
      const checks = (json.checks || []).slice().sort((a, b) =>
        (a.ok === true) - (b.ok === true) || order[a.level] - order[b.level]);
      const done = checks.filter(c => c.ok === true).length;
      document.getElementById('home-setup-count').textContent = done + ' of ' + checks.length + ' set up';
      document.getElementById('home-checks').innerHTML = checks.map(c => {
        const mark = c.ok === true ? '✅' : c.ok === false ? (c.level === 'optional' ? '⚪' : '⚠️') : '🔎';
        const state = c.ok === true ? 'Set up' : c.ok === false ? 'Not set up' : 'Check in GitHub';
        return '<li class="home-check home-check--' + (c.ok === true ? 'ok' : c.ok === false ? 'no' : 'unknown') + '">' +
          '<span class="home-check__mark" aria-hidden="true">' + mark + '</span>' +
          '<div><strong>' + escapeHtml(c.label) + '</strong> <span class="home-check__state">' + state +
          (c.ok === true ? '' : ' · ' + escapeHtml(c.level)) + '</span>' +
          (c.ok === true ? '' : '<p class="home-check__fix">' + escapeHtml(c.fix) +
            (c.link ? ' <a href="' + escapeHtml(c.link) + '" target="_blank" rel="noopener">Open GitHub settings</a>' : '') + '</p>') +
          '</div></li>';
      }).join('');
      el.hidden = false;
      el.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => activateTab(b.dataset.goto)));
      renderHiddenOnHome();
      renderMessagesOnHome();
      loadHomeGoals();
    } catch (e) {
      err.hidden = false;
      err.textContent = e.message || String(e);
    }
  }

  // ─── GROWTH TAB ───
  // GET /api/admin/growth (server/growth.js): the two goals, subscribers
  // per day with the real cost per subscriber, each Monday issue, signup
  // weeks and categories. The goals also show at the top of Home.
  const money = (n, cents) => '$' + (cents ? n / 100 : n).toLocaleString('en-US', { minimumFractionDigits: cents ? 0 : 2, maximumFractionDigits: 2 });
  const fmtDay = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  function goalsHtml(g) {
    if (!g) return '';
    const s = g.subscribers || {};
    const r = g.revenue || {};
    const pct = (n, of) => Math.max(0, Math.min(100, of ? n / of * 100 : 0));
    const goal = (label, value, p, note) => '<div class="goal"><div class="goal__label">' + escapeHtml(label) + '</div>' +
      '<div class="goal__value">' + escapeHtml(value) + '</div>' +
      '<div class="goal__bar"><span class="goal__fill" style="width:' + p.toFixed(1) + '%"></span></div>' +
      '<div class="goal__note">' + escapeHtml(note) + '</div></div>';
    const pace = s.per_week > 0
      ? '+' + s.per_week + ' a week lately' + (s.eta ? ' · 10,000 by ' + new Date(s.eta + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) + ' at this pace' : '')
      : 'Not growing over the last two weeks';
    const month = r.month ? new Date(r.month + '-15T12:00:00').toLocaleDateString('en-US', { month: 'long' }) : 'This month';
    return goal('Subscribers', (s.active || 0).toLocaleString('en-US') + ' / ' + (s.goal || 10000).toLocaleString('en-US'), pct(s.active, s.goal), pace) +
      goal(month + ' sponsor revenue', money(r.cents || 0, true) + ' / ' + money(r.goal_cents || 1000000, true), pct(r.cents, r.goal_cents),
        (r.orders || 0) + ' paid placement' + (r.orders === 1 ? '' : 's') + (r.recurring_cents ? ' (incl. ' + money(r.recurring_cents, true) + ' monthly partners)' : ''));
  }

  function renderGrowth(g) {
    const goals = document.getElementById('growth-goals');
    if (goals) goals.innerHTML = goalsHtml(g.goals);
    const t = g.totals || {};
    const item = (label, value) => '<div class="sources-summary__item"><span class="sources-summary__label">' + escapeHtml(label) +
      '</span><span class="sources-summary__value">' + escapeHtml(String(value)) + '</span></div>';
    const y = g.yesterday;
    const totals = document.getElementById('growth-totals');
    if (totals) totals.innerHTML =
      (y ? item('Yesterday', y.joined + ' new' + (y.cost_per_sub != null ? ' · ' + money(y.cost_per_sub) + ' each' : '')) : '') +
      item('Last ' + g.days + ' days', t.joined + ' new · ' + t.unsubscribed + ' left · net ' + (t.net >= 0 ? '+' : '') + t.net) +
      item('Ad spend', t.spend != null ? money(t.spend) : 'not reported yet') +
      item('Real cost per subscriber', t.cost_per_sub != null ? money(t.cost_per_sub) : '—') +
      item('Where they came from', Object.entries(t.by_source || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(' · ') || '—') +
      item('Waiting to confirm', g.pending || 0);

    const chart = document.getElementById('growth-chart');
    if (chart) {
      const max = Math.max(1, ...g.daily.map(d => d.joined));
      chart.innerHTML = g.daily.map(d => '<div class="traffic-col" title="' + escapeHtml(fmtDay(d.day) + ': ' + d.joined + ' new, ' + d.unsubscribed + ' left' +
        (d.spend != null ? ', ' + money(d.spend) + ' spent' : '')) + '"><span class="traffic-col-bar" style="height:' + Math.round(d.joined / max * 100) + '%"></span></div>').join('');
    }
    const note = document.getElementById('growth-spend-note');
    if (note) note.textContent = g.spend_reported
      ? 'Real cost per subscriber is Meta’s spend that day divided by the people who actually joined (imported addresses left out). Meta’s own “signups” miss iPhones, in-app browsers and ad blockers, so this is the number to trust. Facebook ads counts only signups the site could tie to an ad, so some ad signups show as Site.'
      : 'Ad spend shows here once the daily Meta ads report runs (8:37 AM). It sends each day’s spend to the site.';

    const daily = document.getElementById('growth-daily');
    if (daily) {
      const rows = g.daily.slice().reverse();
      daily.innerHTML = '<thead><tr><th>Day</th><th class="num">New</th><th>From</th><th class="num">Left</th><th class="num">Spend</th><th class="num">Per sub</th></tr></thead><tbody>' +
        rows.map(d => '<tr><td>' + escapeHtml(fmtDay(d.day)) + '</td><td class="num">' + d.joined + '</td><td class="muted">' +
          escapeHtml(Object.entries(d.by_source).map(([k, v]) => k + ' ' + v).join(', ')) + '</td><td class="num">' + (d.unsubscribed || '') +
          '</td><td class="num">' + (d.spend != null ? money(d.spend) : '') + '</td><td class="num">' + (d.cost_per_sub != null ? money(d.cost_per_sub) : '') + '</td></tr>').join('') +
        '</tbody>';
    }

    const issues = document.getElementById('growth-issues');
    if (issues) {
      const pct = v => (v == null ? '—' : v + '%');
      issues.innerHTML = (g.issues || []).length
        ? '<thead><tr><th>Issue</th><th class="num">Sent</th><th class="num">Opened</th><th class="num">Clicked that day</th><th class="num">Reader visits until the next issue</th><th>Top events from the email</th><th class="num">Left</th></tr></thead><tbody>' +
          g.issues.map(x => '<tr><td>' + escapeHtml((x.edition === 'weekend' ? 'Thu ' : 'Mon ') + fmtDay(x.week)) + (x.edition === 'weekend' ? ' <span class="muted">weekend</span>' : '') + '</td><td class="num">' + x.sent + '</td><td class="num">' + x.opens + ' (' + pct(x.open_rate) + ')' +
            '</td><td class="num">' + x.clickers + ' (' + pct(x.click_rate) + ')</td><td class="num">' + (x.reader_days || 0) + '</td><td class="muted">' +
            escapeHtml(x.top_events.map(e => e.name + ' (' + e.views + ')').join(', ') || '—') + '</td><td class="num">' + (x.unsubscribed || '') + '</td></tr>').join('') + '</tbody>'
        : '<tbody><tr><td class="traffic-empty">No issues sent yet.</td></tr></tbody>';
    }

    const cohorts = document.getElementById('growth-cohorts');
    if (cohorts) {
      const share = (n, of) => of ? Math.round(n / of * 100) + '%' : '—';
      cohorts.innerHTML = (g.signup_weeks || []).length
        ? '<thead><tr><th>Week of</th><th class="num">Joined</th><th class="num">Still on</th><th class="num">Opened lately</th></tr></thead><tbody>' +
          g.signup_weeks.map(w => '<tr><td>' + escapeHtml(fmtDay(w.week)) + '</td><td class="num">' + w.joined + '</td><td class="num">' + share(w.active, w.joined) +
            '</td><td class="num">' + (w.opened == null ? 'no issue yet' : share(w.opened, w.sent)) + '</td></tr>').join('') + '</tbody>'
        : '<tbody><tr><td class="traffic-empty">No signups yet.</td></tr></tbody>';
    }

    const cats = document.getElementById('growth-categories');
    if (cats) {
      cats.innerHTML = (g.categories || []).length
        ? '<thead><tr><th>Category</th><th class="num">Page views</th><th class="num">Link taps</th></tr></thead><tbody>' +
          g.categories.map(c => '<tr><td>' + escapeHtml(c.category) + '</td><td class="num">' + c.views + '</td><td class="num">' + c.taps + '</td></tr>').join('') + '</tbody>'
        : '<tbody><tr><td class="traffic-empty">No event views yet.</td></tr></tbody>';
    }
  }

  let growthSeq = 0;
  async function loadGrowth() {
    const seq = ++growthSeq;
    const loadEl = document.getElementById('growth-loading');
    const errEl = document.getElementById('growth-error');
    const body = document.getElementById('growth-body');
    const days = (document.getElementById('growth-days') || {}).value || '30';
    if (publishMode() !== 'server') {
      if (errEl) { errEl.hidden = false; errEl.textContent = 'Sign in to the server to view growth.'; }
      return;
    }
    if (loadEl) loadEl.hidden = false;
    if (errEl) errEl.hidden = true;
    try {
      const { res, json } = await adminFetch('/api/admin/growth?days=' + encodeURIComponent(days));
      if (seq !== growthSeq) return; // a newer request (another period) is on its way
      if (!res.ok || !json || !json.ok) throw new Error((json && json.message) || ('Failed to load growth (HTTP ' + res.status + ').'));
      renderGrowth(json);
      if (body) body.hidden = false;
    } catch (err) {
      console.error(err);
      if (errEl) { errEl.hidden = false; errEl.textContent = err.message || String(err); }
    } finally {
      if (loadEl) loadEl.hidden = true;
    }
  }

  // The goals on Home; a failure just leaves them off.
  async function loadHomeGoals() {
    const el = document.getElementById('home-goals');
    if (!el || publishMode() !== 'server') return;
    try {
      const { res, json } = await adminFetch('/api/admin/growth?goals=1');
      if (!res.ok || !json || !json.ok) return;
      el.innerHTML = goalsHtml(json.goals);
      el.hidden = false;
    } catch (_) { /* Home works without it */ }
  }

  // ─── TABS ───
  function activateTab(name) {
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(t => t.classList.toggle('is-active', t.dataset.tab === name));
    const panels = {
      home: document.getElementById('tab-home'),
      growth: document.getElementById('tab-growth'),
      picker: document.getElementById('tab-picker'),
      submissions: document.getElementById('tab-submissions'),
      preview: document.getElementById('tab-preview'),
      newsletter: document.getElementById('tab-newsletter'),
      sources: document.getElementById('tab-sources'),
      traffic: document.getElementById('tab-traffic'),
      sponsors: document.getElementById('tab-sponsors')
    };
    Object.entries(panels).forEach(([k, el]) => {
      if (!el) return;
      el.hidden = (k !== name);
      el.classList.toggle('is-active', k === name);
    });
    const counts = document.getElementById('count-summary');
    if (counts) counts.hidden = name !== 'picker' && name !== 'preview';
    if (name === 'home') loadHome();
    if (name === 'growth') loadGrowth();
    if (name === 'preview') refreshPreview();
    if (name === 'newsletter') { refreshNewsletter(); loadEmailNewsletter(); }
    if (name === 'sources') loadSources();
    if (name === 'traffic') loadTraffic();
    if (name === 'sponsors') loadSponsors();
  }

  // ─── SPONSORS TAB ────────────────────────────────────────────────────
  // Paid orders from the Stripe checkout (server/sponsors.js).
  const SPONSOR_KIND = { weekly: 'Weekly sponsor', partner: 'Venue partner', featured: 'Vic’s Pick event' };
  const SPONSOR_STATUS = { paid: 'Live', active: 'Live', pending: 'Awaiting payment', hidden: 'Hidden', cancelled: 'Cancelled', paused: 'Payment issue', refunded: 'Refunded', disputed: 'Disputed', processing: 'Payment processing', conflict: 'Double-booked: refund', late: 'Paid after its date: refund', failed: 'Checkout failed' };

  function sponsorDetail(o) {
    if (o.kind === 'weekly') return 'Week of ' + o.week_start + (o.sponsor ? ': ' + o.sponsor.text : '');
    if (o.kind === 'partner') return o.venue_name || o.venue_slug || '';
    return o.event ? o.event.name + ' (' + o.event.date + ')' + (o.submission_id ? ' · in Submissions' : '') : '';
  }

  // Weekly orders the server lets the admin edit (server/sponsors.js EDITABLE).
  const SPONSOR_EDITABLE = new Set(['paid', 'hidden', 'processing', 'conflict']);

  // Inline editor under a weekly order's row: wording, link, button text,
  // address, week and logo. Sponsors are told to reply with changes, and a
  // double-booked order is fixed by moving it to an open week.
  function openSponsorEdit(id, button) {
    const d = state.sponsors || {};
    const o = (d.orders || []).find(x => x.id === id);
    const row = button && button.closest('tr');
    if (!o || !row) return;
    const existing = row.nextElementSibling;
    if (existing && existing.classList.contains('sponsor-edit-row')) { existing.remove(); return; }
    const s = o.sponsor || {};
    const weeks = (d.weeks || []).filter(w => w.available || w.start === o.week_start);
    if (!weeks.some(w => w.start === o.week_start)) weeks.unshift({ start: o.week_start, label: 'Week of ' + o.week_start + ' (current)' });
    const input = (name, label, value, max) => '<label class="sponsor-edit__field">' + escapeHtml(label) +
      '<input name="' + name + '" maxlength="' + max + '" value="' + escapeHtml(value || '') + '"></label>';
    const tr = document.createElement('tr');
    tr.className = 'sponsor-edit-row';
    tr.innerHTML = '<td colspan="7"><form class="sponsor-edit" data-id="' + escapeHtml(o.id) + '">' +
      input('business', 'Business name', o.business || s.name, 80) +
      '<label class="sponsor-edit__field">Message<textarea name="text" maxlength="160" rows="2">' + escapeHtml(s.text || '') + '</textarea></label>' +
      input('url', 'Website or page', s.url, 300) +
      input('cta', 'Button text', s.cta, 24) +
      input('address', 'Address', s.address, 120) +
      '<label class="sponsor-edit__field">Week<select name="week">' + weeks.map(w => '<option value="' + escapeHtml(w.start) + '"' +
        (w.start === o.week_start ? ' selected' : '') + '>' + escapeHtml(w.label) + '</option>').join('') + '</select></label>' +
      '<label class="sponsor-edit__field">New logo (optional)<input type="file" name="logo" accept="image/png,image/jpeg,image/webp"></label>' +
      '<button type="submit" class="btn btn--primary">Save changes</button> <button type="button" class="btn btn--ghost" data-sponsor-edit-cancel>Cancel</button>' +
      (o.status === 'conflict' ? '<p class="sponsor-edit__hint">Double-booked: pick an open week to put it live (they get their confirmation email), or refund them in Stripe.</p>' : '') +
      '</form></td>';
    row.after(tr);
  }

  // Shrink a chosen logo in the browser like the checkout page does (max
  // 480x240 PNG), so the request stays small.
  function sponsorLogoData(file) {
    return new Promise((resolve, reject) => {
      if (!file) return resolve('');
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.onload = () => {
        const im = new Image();
        im.onload = () => {
          const s = Math.min(1, 480 / im.width, 240 / im.height);
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(im.width * s)); c.height = Math.max(1, Math.round(im.height * s));
          c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/png'));
        };
        im.onerror = () => reject(new Error('That file isn’t an image we can use. Try a PNG or JPG.'));
        im.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function saveSponsorEdit(form) {
    const errEl = document.getElementById('sponsors-error');
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      const f = form.elements;
      const body = { action: 'edit', business: f.business.value, text: f.text.value, url: f.url.value, cta: f.cta.value,
        address: f.address.value, week: f.week.value };
      const logo = await sponsorLogoData(f.logo.files && f.logo.files[0]);
      if (logo) body.logo_data = logo;
      const { res, json } = await adminFetch('/api/admin/sponsors/' + encodeURIComponent(form.getAttribute('data-id')), {
        method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }
      });
      if (!res.ok || !json || !json.ok) throw new Error((json && (json.message || json.error)) || ('HTTP ' + res.status));
      if (errEl) errEl.hidden = true;
      loadSponsors();
    } catch (err) {
      if (errEl) { errEl.hidden = false; errEl.textContent = err.message || String(err); }
      if (btn) btn.disabled = false;
    }
  }

  function renderSponsors(d) {
    state.sponsors = d;
    const status = document.getElementById('sponsors-status');
    if (status) {
      status.textContent = d.configured
        ? 'Online checkout is on: /advertise shows Buy now buttons.'
        : 'Online checkout is off. Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in Railway to turn on Buy now buttons.';
    }
    const table = document.getElementById('sponsors-orders');
    if (table) {
      table.innerHTML = d.orders.length
        ? '<tr><th>Date</th><th>Package</th><th>Business</th><th>Details</th><th>Amount</th><th>Status</th><th></th></tr>' +
          d.orders.map(o => {
            const live = o.status === 'paid' || o.status === 'active';
            const hasLogo = Boolean(o.sponsor && o.sponsor.logo);
            const editable = o.kind === 'weekly' && SPONSOR_EDITABLE.has(o.status);
            const reportable = (o.kind === 'weekly' || o.kind === 'featured') && (live || Boolean(o.paid_at));
            const btn = (reportable ? '<button type="button" class="btn btn--ghost" data-sponsor-action="report" data-id="' + escapeHtml(o.id) + '">Report</button>' : '') +
              (editable ? '<button type="button" class="btn btn--ghost" data-sponsor-action="edit" data-id="' + escapeHtml(o.id) + '">Edit</button>' : '') +
              (live ?'<button type="button" class="btn btn--ghost" data-sponsor-action="hide" data-id="' + escapeHtml(o.id) + '">Hide</button>'
              : o.status === 'hidden' ? '<button type="button" class="btn btn--ghost" data-sponsor-action="restore" data-id="' + escapeHtml(o.id) + '">Restore</button>' : '') +
              (hasLogo ? '<button type="button" class="btn btn--ghost" data-sponsor-action="remove-logo" data-id="' + escapeHtml(o.id) + '">Remove logo</button>' : '') +
              (o.paid_at ? '<button type="button" class="btn btn--ghost" data-sponsor-action="' + (o.test ? 'unmark-test' : 'mark-test') + '" data-id="' + escapeHtml(o.id) + '">' +
                (o.test ? 'Not a test' : 'Mark as test') + '</button>' : '');
            // Filled in by loadSponsorLogos (the image needs the admin session).
            const logo = hasLogo ? '<br><img class="sponsor-admin-logo" alt="Uploaded logo" data-logo-id="' + escapeHtml(o.id) + '">' : '';
            return '<tr><td>' + escapeHtml((o.paid_at || o.created_at || '').slice(0, 10)) + '</td>' +
              '<td>' + escapeHtml(SPONSOR_KIND[o.kind] || o.kind) + '</td>' +
              '<td>' + escapeHtml(o.business || '') + '<br><small>' + escapeHtml(o.email || '') + '</small></td>' +
              '<td>' + escapeHtml(sponsorDetail(o)) + logo + '</td>' +
              '<td>$' + escapeHtml(String(Math.round((o.amount || 0) / 100))) + (o.test ? '<br><small>Test, not counted</small>' : '') +
                (o.refunded_cents > 0 && o.status !== 'refunded' ? '<br><small>$' + escapeHtml((o.refunded_cents / 100).toFixed(2)) + ' refunded</small>' : '') + '</td>' +
              // on_site false: a paid Vic's Pick whose event the pin can't
              // find on the site (not approved yet, rejected, or edited).
              '<td>' + (o.on_site === false
                ? '<strong class="sponsor-not-live">Paid, not on the site yet</strong><br><small>Approve its event in Submissions</small>'
                : o.status === 'disputed' && o.dispute && o.dispute.status && o.dispute.status !== 'open' ? 'Dispute lost'
                : escapeHtml(SPONSOR_STATUS[o.status] || o.status)) + '</td><td>' + btn + '</td></tr>';
          }).join('')
        : '<tr><td class="traffic-empty">No orders yet.</td></tr>';
      loadSponsorLogos(table);
    }
    const cal = document.getElementById('sponsors-calendar');
    if (cal && Array.isArray(d.calendar)) cal.innerHTML = d.calendar.map(renderCalendarWeek).join('');
  }

  // One week of the sponsorship calendar: the weekly sponsor slot, then a
  // cell per day with its Vic's Pick spots (filled dots = taken) and who.
  const SLOT_LABEL = { booked: 'paid', processing: 'payment processing', held: 'being paid for' };
  function renderCalendarWeek(w) {
    const weekly = w.weekly
      ? '<span class="cal-weekly cal-weekly--' + escapeHtml(w.weekly.state) + '">Weekly sponsor: <strong>' + escapeHtml(w.weekly.business) + '</strong> (' + escapeHtml(SLOT_LABEL[w.weekly.state] || w.weekly.state) + ')</span>'
      : '<span class="cal-weekly cal-weekly--open">Weekly sponsor: open</span>';
    const days = w.days.map(day => {
      const dots = [];
      for (let i = 0; i < day.cap; i++) {
        const p = day.picks[i];
        dots.push('<span class="cal-dot' + (p ? ' cal-dot--' + escapeHtml(p.state === 'booked' ? 'booked' : 'held') : '') + '"></span>');
      }
      const names = day.picks.map(p => '<li title="' + escapeHtml(p.event) + '">' + escapeHtml(p.business || p.event) +
        (p.state !== 'booked' ? ' <em>(' + escapeHtml(SLOT_LABEL[p.state] || p.state) + ')</em>' : '') + '</li>').join('');
      const label = new Date(day.date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
      return '<div class="cal-day' + (day.past ? ' cal-day--past' : '') + (day.left === 0 ? ' cal-day--full' : '') + (day.weekend ? ' cal-day--weekend' : '') + '">' +
        '<div class="cal-day__head">' + escapeHtml(label) + '<span class="cal-price">' + escapeHtml(day.price) + '</span></div>' +
        '<div class="cal-dots" aria-label="' + escapeHtml(day.taken + ' of ' + day.cap + ' Vic’s Picks taken') + '">' + dots.join('') + '</div>' +
        '<div class="cal-count">' + (day.left === 0 ? 'Sold out' : escapeHtml(day.left + ' open')) + '</div>' +
        (names ? '<ul class="cal-names">' + names + '</ul>' : '') + '</div>';
    }).join('');
    return '<section class="cal-week"><div class="cal-week__head"><strong>' + escapeHtml(w.label) + '</strong>' + weekly + '</div>' +
      '<div class="cal-grid">' + days + '</div></section>';
  }

  // Weekly sponsor logos, so they can be checked (and pulled) here. Fetched
  // with the admin session: the public URL stops serving hidden orders.
  function loadSponsorLogos(root) {
    root.querySelectorAll('img[data-logo-id]').forEach(async img => {
      try {
        const headers = state.session ? { Authorization: 'Bearer ' + state.session } : {};
        const r = await fetch(apiBaseUrl() + '/api/admin/sponsors/' + encodeURIComponent(img.getAttribute('data-logo-id')) + '/logo', { headers });
        if (!r.ok) { img.remove(); return; }
        img.src = URL.createObjectURL(await r.blob());
      } catch (_) { img.remove(); }
    });
  }

  async function loadSponsors() {
    const errEl = document.getElementById('sponsors-error');
    const body = document.getElementById('sponsors-body');
    if (publishMode() !== 'server') {
      if (errEl) { errEl.hidden = false; errEl.textContent = 'Sign in to the server to view sponsors.'; }
      return;
    }
    if (errEl) errEl.hidden = true;
    try {
      const { res, json } = await adminFetch('/api/admin/sponsors');
      if (!res.ok || !json || !json.ok) throw new Error((json && json.message) || ('Failed to load sponsors (HTTP ' + res.status + ').'));
      renderSponsors(json);
      if (body) body.hidden = false;
    } catch (err) {
      console.error(err);
      if (errEl) { errEl.hidden = false; errEl.textContent = err.message || String(err); }
    }
  }

  // Report: the numbers the sponsor's email has (or will have), live from
  // GET /api/admin/sponsors/:id/report, in a row under the order. A second
  // tap closes it.
  function sponsorReportRows(r) {
    const s = r.stats || {};
    const n = v => String(Number(v) || 0);
    const rows = r.kind === 'weekly'
      ? [['Week', s.week_start + ' to ' + s.week_end], ['Block seen', n(s.views) + ' times (' + n(s.view_people) + ' people)'],
        ['Clicked on the site', n(s.site_people) + ' people (' + n(s.site_clicks) + ' clicks)'],
        ['Clicked in emails', n(s.email_people) + ' people (' + n(s.email_clicks) + ' clicks)'],
        ['Newsletter copies with the block' + (s.newsletter_issues > 1 ? ' (Mon + Thu)' : ''), n(s.newsletter_recipients)], ['Site visitors that week', n(s.site_visitors)]]
      : [['Counting', s.start + ' to ' + s.end], ['Shown in lists as a Vic’s Pick', n(s.shown) + ' times (' + n(s.shown_people) + ' people)'],
        ['Event page views', n(s.page_views) + ' (' + n(s.page_people) + ' people)'],
        ['Clicked their link', n(s.link_people) + ' people (' + n(s.link_clicks) + ' clicks)'],
        ['Added to calendar', n(s.calendar_adds)], ['Shares', n(s.shares)],
        ['Visits from shares', n(s.share_visits) + ' (' + n(s.share_people) + ' people)'],
        ['Newsletter', s.newsletter_starred ? 'Starred, ' + n(s.newsletter_recipients) + ' copies' + (s.newsletter_issues > 1 ? ' (Mon + Thu)' : '') : 'Not starred'],
        ...(r.on_site === false ? [['On the site', 'Never matched a listed event']] : [])];
    (s.where || []).forEach(w => rows.push(['Seen on ' + w.type, n(w.views)]));
    rows.push(['Report email', r.report_sent ? 'Sent ' + String(r.report_sent).slice(0, 10) : 'Not sent yet']);
    return rows;
  }

  async function openSponsorReport(id, button) {
    const row = button && button.closest('tr');
    if (!row) return;
    const existing = row.nextElementSibling;
    if (existing && existing.classList.contains('sponsor-report-row')) { existing.remove(); return; }
    const tr = document.createElement('tr');
    tr.className = 'sponsor-report-row';
    tr.innerHTML = '<td colspan="7">Loading report…</td>';
    row.after(tr);
    try {
      const { res, json } = await adminFetch('/api/admin/sponsors/' + encodeURIComponent(id) + '/report');
      if (!res.ok || !json || !json.ok) throw new Error((json && (json.message || json.error)) || ('HTTP ' + res.status));
      tr.innerHTML = '<td colspan="7"><table class="sponsor-report">' +
        sponsorReportRows(json).map(([k, v]) => '<tr><th scope="row">' + escapeHtml(k) + '</th><td>' + escapeHtml(v) + '</td></tr>').join('') +
        '</table><small>Some browsers block our counter, so real numbers can be a bit higher. Newsletter opens aren’t in sponsor reports (Apple Mail inflates them).</small></td>';
    } catch (err) {
      tr.innerHTML = '<td colspan="7">' + escapeHtml('Report unavailable: ' + (err.message || String(err))) + '</td>';
    }
  }

  async function sponsorAction(id, action) {
    const errEl = document.getElementById('sponsors-error');
    try {
      const { res, json } = await adminFetch('/api/admin/sponsors/' + encodeURIComponent(id), {
        method: 'POST', body: JSON.stringify({ action }), headers: { 'Content-Type': 'application/json' }
      });
      if (!res.ok || !json || !json.ok) throw new Error((json && (json.message || json.error)) || ('HTTP ' + res.status));
      loadSponsors();
    } catch (err) {
      if (errEl) { errEl.hidden = false; errEl.textContent = err.message || String(err); }
    }
  }

  // ─── TRAFFIC TAB ─────────────────────────────────────────────────────
  // First-party visitor stats from /api/admin/traffic (server/analytics.js).
  function trafficRows(el, rows, emptyText, labelFn) {
    if (!el) return;
    if (!rows || !rows.length) {
      el.innerHTML = '<tr><td class="traffic-empty">' + escapeHtml(emptyText) + '</td></tr>';
      return;
    }
    const max = Math.max.apply(null, rows.map(r => r.count)) || 1;
    el.innerHTML = rows.map(r =>
      '<tr><td class="traffic-label">' + (labelFn ? labelFn(r) : escapeHtml(r.key)) + '</td>' +
      '<td class="traffic-bar-cell"><span class="traffic-bar" style="width:' + Math.round(r.count / max * 100) + '%"></span></td>' +
      '<td class="traffic-num">' + r.count + '</td></tr>').join('');
  }

  function renderTraffic(t) {
    const totals = document.getElementById('traffic-totals');
    const stat = (label, v) => '<div class="sources-summary__item"><span class="sources-summary__label">' +
      escapeHtml(label) + '</span><span class="sources-summary__value">' + v.visitors +
      ' visitors · ' + v.views + ' views</span></div>';
    // The period picked, plus the last 7 days when that's a different box.
    const range = t.totals.range || t.totals.month;
    // Shares sent (every share_* click) and the visits shared links brought.
    const shares = (t.clicks || []).filter(c => /^share_/.test(c.key)).reduce((a, c) => a + c.count, 0);
    const fromShares = ((t.sources || []).find(s => s.key === 'Shared link') || {}).count || 0;
    if (totals) totals.innerHTML = stat('Today', t.totals.today) +
      (t.days === 7 ? '' : stat('Last 7 days', t.totals.week)) +
      stat('Last ' + t.days + ' days', range) +
      '<div class="sources-summary__item"><span class="sources-summary__label">Shares, last ' + t.days + ' days</span>' +
      '<span class="sources-summary__value">' + shares + ' sent · ' + fromShares + ' views from shared links</span></div>';

    const chart = document.getElementById('traffic-chart');
    if (chart) {
      const max = Math.max(1, ...t.daily.map(d => d.visitors));
      chart.innerHTML = t.daily.map(d => {
        const label = new Date(d.day + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return '<div class="traffic-col" title="' + escapeHtml(label + ': ' + d.visitors + ' visitors, ' + d.views + ' views') + '">' +
          '<span class="traffic-col-bar" style="height:' + Math.round(d.visitors / max * 100) + '%"></span></div>';
      }).join('');
    }

    const link = r => '<a href="' + escapeHtml(httpUrl(location.origin + r.key)) + '" target="_blank" rel="noopener">' + escapeHtml(r.key) + '</a>';
    trafficRows(document.getElementById('traffic-pages'), t.top_pages, 'No page views yet.', link);
    trafficRows(document.getElementById('traffic-sources'), t.sources, 'No visits yet.');
    trafficRows(document.getElementById('traffic-clicks'), t.clicks, 'No clicks yet.', r => escapeHtml(r.label));
    trafficRows(document.getElementById('traffic-top-clicked'), t.top_clicked, 'No event or sponsor clicks yet.',
      r => escapeHtml(r.key.length > 60 ? r.key.slice(0, 57) + '…' : r.key));
    trafficRows(document.getElementById('traffic-crawlers'), t.crawlers, 'No crawler visits yet.');
    const ai = t.ai;
    const aiEl = document.getElementById('traffic-ai');
    if (ai && aiEl) {
      const item = (label, value) => '<div class="sources-summary__item"><span class="sources-summary__label">' +
        escapeHtml(label) + '</span><span class="sources-summary__value">' + escapeHtml(value) + '</span></div>';
      aiEl.innerHTML = item('People sent by AI', ai.sent_visitors + ' visitors · ' + ai.sent_views + ' views') +
        item('Read by AI to answer someone', ai.answer_reads + ' times') +
        item('AI search crawls', String(ai.search_crawls)) +
        item('AI training crawls', String(ai.training_crawls));
      trafficRows(document.getElementById('traffic-ai-sent'), ai.sent_by, 'No visits from AI yet.');
      trafficRows(document.getElementById('traffic-ai-pages'), ai.answer_pages, 'None yet.', link);
    }
    trafficRows(document.getElementById('traffic-referrers'), t.referrer_sites, 'None yet.');
  }

  async function loadTraffic() {
    const loadEl = document.getElementById('traffic-loading');
    const errEl = document.getElementById('traffic-error');
    const body = document.getElementById('traffic-body');
    const days = (document.getElementById('traffic-days') || {}).value || '30';
    if (publishMode() !== 'server') {
      if (errEl) { errEl.hidden = false; errEl.textContent = 'Sign in to the server to view traffic.'; }
      return;
    }
    if (loadEl) loadEl.hidden = false;
    if (errEl) errEl.hidden = true;
    try {
      const { res, json } = await adminFetch('/api/admin/traffic?days=' + encodeURIComponent(days));
      if (!res.ok || !json || !json.ok) {
        throw new Error((json && json.message) || ('Failed to load traffic (HTTP ' + res.status + ').'));
      }
      state.traffic = json;
      renderTraffic(json);
      if (body) body.hidden = false;
      loadEventStats(state.eventStatsWeek || '');
    } catch (err) {
      console.error(err);
      if (errEl) { errEl.hidden = false; errEl.textContent = err.message || String(err); }
    } finally {
      if (loadEl) loadEl.hidden = true;
    }
  }

  // ─── EVENT STATS (Traffic tab) ───
  // Each event's week (GET /api/admin/event-stats), with a ready-to-send
  // pitch per event: "your event got X views ... want it to be a Vic's Pick?"
  async function loadEventStats(week) {
    const table = document.getElementById('event-stats');
    if (!table) return;
    try {
      const { res, json } = await adminFetch('/api/admin/event-stats' + (week ? '?week=' + encodeURIComponent(week) : ''));
      if (!res.ok || !json || !json.ok) throw new Error((json && json.message) || ('HTTP ' + res.status));
      state.eventStats = json;
      state.eventStatsWeek = json.week_start;
      renderEventStats(json);
    } catch (err) {
      const msg = document.getElementById('event-stats-msg');
      if (msg) msg.textContent = 'Could not load event stats: ' + (err.message || err);
    }
  }

  function shiftWeek(ymd, days) {
    const d = new Date(ymd + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function eventPitch(ev, d) {
    const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
    const bits = [plural(ev.page_views, 'view', 'views') + ' of its page'];
    if (ev.link_people) bits.push(plural(ev.link_people, 'person', 'people') + ' tapped through to your link');
    if (ev.calendar_adds) bits.push(plural(ev.calendar_adds, 'calendar add', 'calendar adds'));
    if (ev.shares) bits.push('it was shared ' + plural(ev.shares, 'time', 'times') + (ev.share_visits ? ', bringing in ' + plural(ev.share_visits, 'more visit', 'more visits') : ''));
    const list = bits.length > 1 ? bits.slice(0, -1).join(', ') + ' and ' + bits[bits.length - 1] : bits[0];
    // The newsletter's reach that week, not a claim this event was in it
    // (an issue shows a few events a day, from the day it's sent).
    const mon = d.newsletter || {};
    const wk = mon.weekend || {};
    const parts = [
      mon.recipients ? 'Our Monday newsletter that week went to ' + mon.recipients + ' ' + town().city + ' locals' + (mon.opens ? ' (' + mon.opens + ' opened it)' : '') : '',
      wk.recipients ? (mon.recipients ? 'and Thursday\'s weekend issue to ' : 'Our Thursday weekend newsletter that week went to ') + wk.recipients +
        (mon.recipients ? '' : ' ' + town().city + ' locals') + (wk.opens ? ' (' + wk.opens + ' opened it)' : '') : ''
    ].filter(Boolean);
    const nl = parts.length ? ' ' + parts.join(', ') + '.' : '';
    return 'Hi ' + (ev.venue || 'there') + '!\n\n' +
      'We featured ' + ev.name + ' on ' + town().siteName + ', ' + town().city + '\'s free events guide, and it got ' + list + '.' + nl + '\n\n' +
      'Want your next event front and center? A Vic\'s Pick highlights it on its day on the site (booked in time, it\'s starred in the newsletter too): ' +
      location.origin + '/advertise\n\nThanks!\n' + town().siteName;
  }

  function renderEventStats(d) {
    const table = document.getElementById('event-stats');
    const label = document.getElementById('event-stats-week');
    const next = document.getElementById('event-stats-next');
    if (label) label.textContent = '(' + d.week_start + ' to ' + d.week_end + (d.this_week ? ', so far' : '') + ')';
    if (next) next.disabled = Boolean(d.this_week);
    const msg = document.getElementById('event-stats-msg');
    const nlw = (d.newsletter && d.newsletter.weekend) || {};
    const nlLines = [
      d.newsletter && d.newsletter.recipients ? 'Monday sent to ' + d.newsletter.recipients + ', opened by ' + d.newsletter.opens : '',
      nlw.recipients ? 'Thursday sent to ' + nlw.recipients + ', opened by ' + nlw.opens : ''
    ].filter(Boolean);
    if (msg) msg.textContent = nlLines.length ? 'Newsletter that week: ' + nlLines.join('; ') + '.' : '';
    if (!table) return;
    const n = v => Number(v) || 0;
    table.innerHTML = (d.events || []).length
      ? '<tr><th class="traffic-label">Event</th><th class="traffic-num">Views</th><th class="traffic-num">Link taps</th>' +
        '<th class="traffic-num">Shares</th><th class="traffic-num">From shares</th><th class="traffic-num"></th></tr>' +
        d.events.map((ev, i) => '<tr><td class="traffic-label">' + escapeHtml(ev.name) + '<br><small>' + escapeHtml((ev.venue ? ev.venue + ' · ' : '') + ev.date) + '</small></td>' +
          '<td class="traffic-num">' + n(ev.page_views) + '</td><td class="traffic-num">' + n(ev.link_people) + '</td>' +
          '<td class="traffic-num">' + n(ev.shares) + '</td><td class="traffic-num">' + n(ev.share_visits) + '</td>' +
          '<td class="traffic-num"><button type="button" class="btn btn--outline" data-pitch="' + i + '">Copy pitch</button></td></tr>').join('')
      : '<tr><td class="traffic-empty">No events listed that week.</td></tr>';
  }

  // ─── SOURCES TAB ─────────────────────────────────────────────────────
  // Cache of the most recent payload so renderSources is testable in jsdom
  // without re-fetching.
  state.sources = null;

  function setSourcesMessage(text, kind, opts) {
    const el = document.getElementById('sources-message');
    if (!el) return;
    el.classList.remove('is-success', 'is-error');
    if (kind === 'success') el.classList.add('is-success');
    if (kind === 'error') el.classList.add('is-error');
    // When opts.actionsUrl is provided, render an inline link so the user
    // can open the GitHub Actions page and run the workflow manually.
    el.innerHTML = '';
    if (text) {
      const span = document.createElement('span');
      span.textContent = text;
      el.appendChild(span);
    }
    if (opts && opts.actionsUrl) {
      const a = document.createElement('a');
      a.href = opts.actionsUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'sources-message__link';
      a.textContent = 'Open GitHub Actions →';
      if (text) el.appendChild(document.createTextNode(' '));
      el.appendChild(a);
    }
  }

  // Pulls a friendly message + optional actions_url out of the trigger-collect
  // response. Falls back to the raw `message` field for unknown error codes.
  function describeTriggerError(json, status) {
    const actionsUrl = (json && json.actions_url) || null;
    const errCode = json && json.error;
    if (errCode === 'github-token-invalid' || status === 401) {
      return {
        kind: 'error',
        text: 'The server\'s GitHub token is invalid or expired, so one-click Pull Now can\'t dispatch the workflow. Save & Publish is unaffected — only this button needs the token. You can still run the Weekly Collect workflow manually using your normal GitHub login.',
        actionsUrl
      };
    }
    if (errCode === 'github-not-configured') {
      return {
        kind: 'error',
        text: 'No server-side GitHub token is configured, so one-click Pull Now is disabled. Save & Publish is unaffected. You can still run the Weekly Collect workflow manually on GitHub.',
        actionsUrl
      };
    }
    if (errCode === 'dispatch-failed') {
      const ghStatus = json && json.github_status;
      let prefix = 'GitHub rejected the workflow dispatch';
      if (ghStatus === 403) prefix = 'The server\'s GitHub token is missing the actions:write permission';
      if (ghStatus === 404) prefix = 'The Weekly Collect workflow file wasn\'t found on the configured branch';
      return {
        kind: 'error',
        text: prefix + '. Save & Publish is unaffected — you can still run the workflow manually on GitHub.',
        actionsUrl
      };
    }
    return {
      kind: 'error',
      text: (json && json.message) || ('Pull now failed (HTTP ' + status + '). Save & Publish is unaffected.'),
      actionsUrl
    };
  }

  function formatSourceTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit'
      });
    } catch (_) { return iso; }
  }

  function renderSources(payload) {
    if (!payload) return;
    state.sources = payload;
    const lastEl = document.getElementById('sources-last-run');
    const nextEl = document.getElementById('sources-next-run');
    const mergedEl = document.getElementById('sources-merged-count');
    if (lastEl) lastEl.textContent = formatSourceTime(payload.last_run_at);
    if (nextEl) {
      const t = formatSourceTime(payload.next_run_at);
      nextEl.textContent = payload.next_run_note
        ? t + ' · ' + payload.next_run_note
        : t;
    }
    if (mergedEl) {
      const m = (payload.merged_count == null) ? '—' : String(payload.merged_count);
      const r = (payload.raw_count == null) ? null : String(payload.raw_count);
      mergedEl.textContent = r ? (m + ' (from ' + r + ' raw)') : m;
    }
    const triggerBtn = document.getElementById('sources-trigger');
    const triggerHelp = document.getElementById('sources-trigger-help');
    const actionsLink = document.getElementById('sources-actions-link');
    if (triggerBtn) triggerBtn.disabled = !payload.trigger_enabled;
    if (triggerHelp) {
      triggerHelp.textContent = payload.trigger_enabled
        ? 'One-click Pull Now uses the server\'s GitHub token. Save & Publish does not.'
        : 'One-click Pull Now is disabled (no server-side GitHub token). Save & Publish is unaffected — you can still run the Weekly Collect workflow manually on GitHub.';
    }
    // Always show the GitHub Actions fallback link when we have a URL,
    // regardless of whether one-click is enabled. This gives the user a
    // dependable manual path even when the server token is stale or absent.
    if (actionsLink) {
      if (payload.actions_url) {
        actionsLink.href = payload.actions_url;
        actionsLink.hidden = false;
      } else {
        actionsLink.hidden = true;
      }
    }
    const listEl = document.getElementById('sources-list');
    const emptyEl = document.getElementById('sources-empty');
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    if (!sources.length) {
      if (listEl) listEl.innerHTML = '';
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    if (!listEl) return;
    listEl.innerHTML = sources.map(s => {
      const statusCls = 'is-' + (s.status || 'unknown');
      const countText = (s.status === 'unknown')
        ? '—'
        : String(s.count || 0);
      const metaParts = [];
      metaParts.push('Last pulled: ' + formatSourceTime(s.last_pulled_at));
      const message = s.message
        ? '<p class="source-card__message">' + escapeHtml(s.message) + '</p>'
        : '';
      return (
        '<div class="source-card" data-source="' + escapeHtml(s.name) + '">' +
          '<div class="source-card__row">' +
            '<p class="source-card__name">' + escapeHtml(s.label || s.name) + '</p>' +
            '<span class="source-card__status ' + statusCls + '">' +
              escapeHtml(s.status || 'unknown') +
            '</span>' +
          '</div>' +
          '<div class="source-card__row">' +
            '<span>' +
              '<span class="source-card__count">' + escapeHtml(countText) + '</span>' +
              '<span class="source-card__count-label">events</span>' +
            '</span>' +
            '<span class="source-card__category">' + escapeHtml(s.category || '') + '</span>' +
          '</div>' +
          '<p class="source-card__meta">' + escapeHtml(metaParts.join(' · ')) + '</p>' +
          message +
        '</div>'
      );
    }).join('');
  }

  async function loadSources() {
    const loadEl = document.getElementById('sources-loading');
    const errEl = document.getElementById('sources-error');
    const emptyEl = document.getElementById('sources-empty');
    if (loadEl) loadEl.hidden = false;
    if (errEl) errEl.hidden = true;
    if (emptyEl) emptyEl.hidden = true;
    if (publishMode() !== 'server') {
      if (loadEl) loadEl.hidden = true;
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = 'Sign in to the server to view source status.';
      }
      return;
    }
    try {
      const { res, json } = await adminFetch('/api/admin/sources');
      if (!res.ok || !json || !json.ok) {
        throw new Error((json && json.message) || ('Failed to load sources (HTTP ' + res.status + ').'));
      }
      renderSources(json);
    } catch (err) {
      console.error(err);
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = err.message || String(err);
      }
    } finally {
      if (loadEl) loadEl.hidden = true;
    }
  }

  async function triggerCollect() {
    const btn = document.getElementById('sources-trigger');
    if (publishMode() !== 'server') {
      setSourcesMessage('Sign in to the server first.', 'error');
      return;
    }
    if (!confirm('Trigger the Weekly Collect workflow now? It usually takes a couple of minutes to finish.')) {
      return;
    }
    if (btn) btn.disabled = true;
    setSourcesMessage('Dispatching workflow…');
    let succeeded = false;
    try {
      const { res, json } = await adminFetch('/api/admin/trigger-collect', {
        method: 'POST'
      });
      if (!res.ok || !json || !json.ok) {
        const desc = describeTriggerError(json, res.status);
        setSourcesMessage(desc.text, desc.kind, { actionsUrl: desc.actionsUrl });
        return;
      }
      succeeded = true;
      setSourcesMessage(json.message || 'Workflow dispatched.', 'success',
        json.actions_url ? { actionsUrl: json.actions_url } : null);
    } catch (err) {
      console.error(err);
      // Network-level failure (no JSON body). Surface a clear, non-alarming
      // message and still show the manual fallback if we know the URL from
      // the most recent /api/admin/sources payload.
      const fallbackUrl = state.sources && state.sources.actions_url;
      setSourcesMessage(
        'Could not reach the server to trigger Pull Now. Save & Publish is unaffected. You can run the workflow manually on GitHub.',
        'error',
        fallbackUrl ? { actionsUrl: fallbackUrl } : null
      );
    } finally {
      // Always re-enable the button; the server config drives whether it stays
      // disabled in renderSources.
      if (btn) btn.disabled = false;
      // Refresh status — counts won't reflect the new run yet, but timestamps
      // and any state changes will. The actual collector run is asynchronous;
      // a follow-up Refresh after a couple of minutes shows new counts.
      loadSources();
    }
    return succeeded;
  }

  // ─── INIT ───
  function applyServerConfigToUi(cfg) {
    const patForm = document.getElementById('auth-pat-form');
    const loginForm = document.getElementById('auth-form');
    const help = document.getElementById('auth-help');
    if (!cfg) return;
    if (cfg.admin_login_enabled) {
      if (loginForm) loginForm.hidden = false;
      if (help) help.textContent = 'Sign in with your admin username and password.';
    } else {
      if (loginForm) loginForm.hidden = true;
      if (help) help.textContent = 'Server login is not configured. Set ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_SESSION_SECRET on the server, or use a GitHub PAT below.';
    }
    // The server can now load candidates and save publishes locally without a
    // GitHub token, so the PAT fallback is only useful when login itself is
    // not configured. Hide it whenever login works.
    if (patForm) patForm.hidden = Boolean(cfg.admin_login_enabled);
  }

  async function authedSession() {
    // Verify the stored session is still valid by hitting /api/admin/me.
    if (!state.session) return false;
    const r = await fetch(apiBaseUrl() + '/api/admin/me', {
      headers: { Authorization: 'Bearer ' + state.session }
    });
    return r.ok;
  }

  // ─── THEME (DARK MODE) ───
  // Stored value is 'dark' | 'light'. Absent = follow OS preference (handled
  // by `@media (prefers-color-scheme: dark)` in admin.css). The pre-paint
  // <script> in admin.html already applied any saved choice; this code keeps
  // the toggle button label in sync and handles user clicks.
  function getStoredTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return v === 'dark' || v === 'light' ? v : null;
    } catch (_) { return null; }
  }
  function setStoredTheme(v) {
    try {
      if (v === 'dark' || v === 'light') localStorage.setItem(THEME_KEY, v);
      else localStorage.removeItem(THEME_KEY);
    } catch (_) { /* ignore */ }
  }
  function prefersDark() {
    try {
      return !!(window.matchMedia &&
                window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (_) { return false; }
  }
  function effectiveTheme() {
    const stored = getStoredTheme();
    if (stored) return stored;
    return prefersDark() ? 'dark' : 'light';
  }
  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'dark' || theme === 'light') {
      root.setAttribute('data-theme', theme);
    } else {
      root.removeAttribute('data-theme');
    }
    updateThemeToggleUi();
  }
  function updateThemeToggleUi() {
    const isDark = effectiveTheme() === 'dark';
    const buttons = document.querySelectorAll('#theme-toggle, #theme-toggle-auth');
    buttons.forEach(btn => {
      btn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
      btn.setAttribute('aria-label',
        isDark ? 'Switch to light mode' : 'Switch to dark mode');
      const icon = btn.querySelector('.theme-toggle__icon');
      const label = btn.querySelector('.theme-toggle__label');
      if (icon) icon.textContent = isDark ? '☀️' : '🌙';
      if (label) label.textContent = isDark ? 'Light mode' : 'Dark mode';
    });
  }
  function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    setStoredTheme(next);
    applyTheme(next);
  }
  function initTheme() {
    // Apply whichever choice (or system default) is in effect, then keep the
    // toggle button labels accurate. The pre-paint script already handled the
    // explicit case; this catches the OS-pref case where data-theme is unset.
    const stored = getStoredTheme();
    if (stored) {
      applyTheme(stored);
    } else {
      applyTheme(null);
    }
    // If the user hasn't picked explicitly, follow OS-level changes live.
    try {
      const mq = window.matchMedia &&
                 window.matchMedia('(prefers-color-scheme: dark)');
      if (mq && mq.addEventListener) {
        mq.addEventListener('change', () => {
          if (!getStoredTheme()) updateThemeToggleUi();
        });
      } else if (mq && mq.addListener) {
        mq.addListener(() => {
          if (!getStoredTheme()) updateThemeToggleUi();
        });
      }
    } catch (_) { /* ignore */ }
  }

  function wireEvents() {
    const replyForm = document.getElementById('reply-form');
    const replyModal = document.getElementById('reply-modal');
    if (replyForm && replyModal) {
      replyForm.addEventListener('submit', sendReply);
      replyModal.addEventListener('click', (e) => {
        if (e.target.closest('[data-act="close"]')) closeReplyModal();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !replyModal.hidden) closeReplyModal();
      });
      window.addEventListener('hashchange', openReplyFromHash);
    }
    const authForm = document.getElementById('auth-form');
    if (authForm) {
      authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const u = (document.getElementById('auth-username') || {}).value || '';
        const p = (document.getElementById('auth-password') || {}).value || '';
        const errEl = document.getElementById('auth-error');
        if (errEl) errEl.hidden = true;
        try {
          const tok = await login({ username: u.trim(), password: p });
          setSession(tok);
          state.session = tok;
          showApp();
          loadHome();
          loadCandidates();
        } catch (err) {
          showAuthGate(err.message || 'Sign-in failed.');
        }
      });
    }

    const patForm = document.getElementById('auth-pat-form');
    if (patForm) {
      patForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('auth-pat');
        const pat = (input && input.value || '').trim();
        if (!pat) return;
        const errEl = document.getElementById('auth-error');
        if (errEl) errEl.hidden = true;
        try {
          await verifyPat(pat);
          setPat(pat);
          state.pat = pat;
          showApp();
          loadHome();
          loadCandidates();
        } catch (err) {
          showAuthGate(err.message || 'Authentication failed.');
        }
      });
    }

    const signOut = document.getElementById('signout-btn');
    if (signOut) {
      signOut.addEventListener('click', () => {
        clearAuth();
        state.session = null;
        state.pat = null;
        state.selected = new Set();
        showAuthGate();
      });
    }

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    });

    const nlPreview = document.getElementById('email-nl-preview');
    const nlTest = document.getElementById('email-nl-test');
    const nlSend = document.getElementById('email-nl-send');
    const nlImport = document.getElementById('email-nl-import');
    if (nlPreview) nlPreview.addEventListener('click', previewEmailNewsletter);
    if (nlTest) nlTest.addEventListener('click', () => emailNlPost('/api/admin/newsletter/test',
      { email: (document.getElementById('email-nl-test-to') || {}).value, edition: nlEdition() }, j => 'Test sent to ' + j.to + '.'));
    const nlEditionSel = document.getElementById('email-nl-edition');
    if (nlEditionSel) nlEditionSel.addEventListener('change', () => {
      syncEmailNlSend(state.emailNewsletter);
      const frame = document.getElementById('email-nl-frame');
      if (frame && !frame.hidden) previewEmailNewsletter();
    });
    if (nlSend) nlSend.addEventListener('click', () => {
      const nl = state.emailNewsletter || {};
      const wk = nlEdition() === 'weekend';
      const w = nl.weekend || {};
      const retry = (wk ? w.failed : nl.this_week_failed) || 0;
      const n = nl.counts ? (wk ? nl.counts.active - (w.opted_out || 0) : nl.counts.active) : 0;
      const what = wk ? 'this weekend\'s issue' : 'this week\'s newsletter';
      if (!window.confirm(retry ? 'Retry ' + what + ' for the ' + retry + ' subscribers who didn\'t get it?'
        : 'Send ' + what + ' to ' + n + ' subscribers?')) return;
      emailNlPost('/api/admin/newsletter/send', { edition: nlEdition() }, j => 'Sent to ' + j.recipients + ' subscribers.');
    });
    const nlRewards = document.getElementById('email-nl-rewards');
    if (nlRewards) nlRewards.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-reward]');
      if (!b) return;
      const approve = b.dataset.act === 'approve';
      if (approve && !window.confirm('Send this gift card now?')) return;
      emailNlPost('/api/admin/newsletter/rewards/' + encodeURIComponent(b.dataset.reward) + '/' + b.dataset.act, {},
        () => approve ? 'Gift card sent.' : 'Skipped.');
    });
    if (nlImport) nlImport.addEventListener('click', () => emailNlPost('/api/admin/newsletter/import',
      { emails: (document.getElementById('email-nl-import-text') || {}).value },
      j => 'Imported ' + j.added + ' new, ' + j.already + ' already subscribed' +
        (j.skipped_unsubscribed ? ', ' + j.skipped_unsubscribed + ' skipped (unsubscribed)' : '') + '.'));

    const evStats = document.getElementById('event-stats');
    if (evStats) evStats.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-pitch]');
      const d = state.eventStats;
      if (!b || !d) return;
      const text = eventPitch(d.events[Number(b.dataset.pitch)], d);
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = 'Copied!';
        setTimeout(() => { b.textContent = 'Copy pitch'; }, 2000);
      } catch (_) {
        window.prompt('Copy this pitch:', text);
      }
    });
    const evPrev = document.getElementById('event-stats-prev');
    const evNext = document.getElementById('event-stats-next');
    if (evPrev) evPrev.addEventListener('click', () => state.eventStatsWeek && loadEventStats(shiftWeek(state.eventStatsWeek, -7)));
    if (evNext) evNext.addEventListener('click', () => state.eventStatsWeek && loadEventStats(shiftWeek(state.eventStatsWeek, 7)));

    const trafficDays = document.getElementById('traffic-days');
    const trafficRefresh = document.getElementById('traffic-refresh');
    if (trafficDays) trafficDays.addEventListener('change', loadTraffic);
    if (trafficRefresh) trafficRefresh.addEventListener('click', loadTraffic);
    const growthDays = document.getElementById('growth-days');
    const growthRefresh = document.getElementById('growth-refresh');
    if (growthDays) growthDays.addEventListener('change', loadGrowth);
    if (growthRefresh) growthRefresh.addEventListener('click', loadGrowth);

    const sponsorsRefresh = document.getElementById('sponsors-refresh');
    if (sponsorsRefresh) sponsorsRefresh.addEventListener('click', loadSponsors);
    const sponsorsOrders = document.getElementById('sponsors-orders');
    if (sponsorsOrders) sponsorsOrders.addEventListener('submit', e => {
      const f = e.target.closest('form.sponsor-edit');
      if (!f) return;
      e.preventDefault();
      saveSponsorEdit(f);
    });
    if (sponsorsOrders) sponsorsOrders.addEventListener('click', e => {
      const cancel = e.target.closest('[data-sponsor-edit-cancel]');
      if (cancel) { cancel.closest('tr').remove(); return; }
      const b = e.target.closest('[data-sponsor-action]');
      if (!b) return;
      const action = b.getAttribute('data-sponsor-action');
      if (action === 'edit') { openSponsorEdit(b.getAttribute('data-id'), b); return; }
      if (action === 'report') { openSponsorReport(b.getAttribute('data-id'), b); return; }
      if (action === 'hide' && !confirm('Hide this placement from the site? (Refund it in Stripe separately.)')) return;
      if (action === 'mark-test' && !confirm('Mark this order as a test? It stops counting toward revenue. (Hide it too if it\'s still on the site.)')) return;
      if (action === 'remove-logo' && !confirm('Remove this sponsor’s logo? Their block stays up without it. This can’t be undone.')) return;
      sponsorAction(b.getAttribute('data-id'), action);
    });

    const search = document.getElementById('filter-search');
    const cat = document.getElementById('filter-category');
    const ven = document.getElementById('filter-venue');
    const wk = document.getElementById('filter-week');
    if (search) search.addEventListener('input', () => {
      state.filters.search = search.value; renderPicker();
    });
    if (cat) cat.addEventListener('change', () => {
      state.filters.category = cat.value; renderPicker();
    });
    if (ven) ven.addEventListener('change', () => {
      state.filters.venue = ven.value; renderPicker();
    });
    if (wk) wk.addEventListener('change', () => {
      state.filters.week = wk.value; renderPicker();
    });

    const reload = document.getElementById('reload-btn');
    if (reload) reload.addEventListener('click', loadCandidates);

    const publishBtn = document.getElementById('publish-btn');
    if (publishBtn) publishBtn.addEventListener('click', publish);

    const previewRefresh = document.getElementById('preview-refresh');
    if (previewRefresh) previewRefresh.addEventListener('click', refreshPreview);

    const newsRefresh = document.getElementById('newsletter-refresh');
    if (newsRefresh) newsRefresh.addEventListener('click', refreshNewsletter);
    const newsCopy = document.getElementById('newsletter-copy');
    if (newsCopy) newsCopy.addEventListener('click', copyNewsletter);

    const sourcesRefresh = document.getElementById('sources-refresh');
    if (sourcesRefresh) sourcesRefresh.addEventListener('click', loadSources);
    const sourcesTrigger = document.getElementById('sources-trigger');
    if (sourcesTrigger) sourcesTrigger.addEventListener('click', triggerCollect);

    document.querySelectorAll('#theme-toggle, #theme-toggle-auth')
      .forEach(btn => btn.addEventListener('click', toggleTheme));

    wireEventEditModal();
  }

  async function init() {
    wireEvents();
    initTheme();
    state.session = getSession();
    state.pat = getPat();
    // Best-effort fetch of server config so the UI knows which auth flows are
    // usable. Failures here are non-fatal — falls back to login form visible.
    state.serverConfig = await fetchServerConfig();
    applyTownLabels();
    applyServerConfigToUi(state.serverConfig);

    if (state.session) {
      // Probe the session before showing the app so an expired session lands
      // the editor on the login form instead of the picker with broken calls.
      const ok = await authedSession();
      if (ok) {
        showApp();
        loadHome();
        loadCandidates();
        return;
      }
      // Session was bad — clear and fall through.
      state.session = null;
      clearSession();
      // With server login on, a leftover PAT (from before login was set
      // up) must not take over: PAT publishing commits docs/events.json,
      // which the live site ignores once a published row exists, so
      // "published" would change nothing. Sign in again instead.
      if (state.serverConfig && state.serverConfig.admin_login_enabled) {
        state.pat = null;
        showAuthGate('Session expired — please sign in again.');
        return;
      }
    }
    // The PAT path is only for servers without login (the PAT form is
    // hidden otherwise), so a stale PAT is ignored when login is on.
    if (state.pat && state.serverConfig && state.serverConfig.admin_login_enabled) state.pat = null;
    if (state.pat) {
      showApp();
      loadHome();
      loadCandidates();
      return;
    }
    showAuthGate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ─── TEST EXPORTS ───
  function mergeCandidateEvents(extra) {
    if (!Array.isArray(extra) || !extra.length) return 0;
    const existing = new Set(state.candidates.map(eventKey));
    let added = 0;
    for (const ev of extra) {
      const k = eventKey(ev);
      if (existing.has(k)) continue;
      state.candidates.push(ev);
      existing.add(k);
      added++;
    }
    if (added) {
      state.candidates.sort((a, b) => {
        const da = (a.date || '') + ' ' + (a.time || '');
        const db = (b.date || '') + ' ' + (b.time || '');
        return da.localeCompare(db);
      });
      populateFilters();
      renderPicker();
    }
    return added;
  }

  const api = {
    eventKey, isWeekend, formatDateHeading, escapeHtml,
    applyFilters, groupByDate, buildNewsletterHtml,
    utf8ToBase64,
    buildEventsPayload, buildPreviewSrc, writePreviewToStorage,
    getMondayOfWeek, getWeekRange, inWeekBucket, toLocalDateStr, town, repo, applyTownLabels,
    pruneStalePastSelections, loadCandidates, loadHome, activateTab, publish,
    inferSource, sourceLabel, mergeCandidateEvents, stripPrivateFields,
    publishMode,
    getStoredTheme, setStoredTheme, effectiveTheme, applyTheme, toggleTheme,
    initTheme, updateThemeToggleUi,
    renderSources, loadSources, triggerCollect, formatSourceTime,
    setSourcesMessage, describeTriggerError,
    parseReplyHash, openReplyFromHash, closeReplyModal,
    openEventEditModal, closeEventEditModal, applyEditToLocalState,
    readEditFormPayload, showEditFormErrors, syncEditUrlOpenLink,
    copyEditUrl,
    isHttpUrl, shortenUrl,
    _state: state,
    renderTraffic: renderTraffic,
    renderGrowth, goalsHtml,
    _constants: {
      WEEKDAY_TARGET_MIN, WEEKDAY_TARGET_MAX,
      WEEKEND_TARGET_MIN, WEEKEND_TARGET_MAX,
      PAT_KEY, PICKS_KEY, SESSION_KEY, THEME_KEY,
      REPO_OWNER, REPO_NAME, BRANCH,
      PREVIEW_STORAGE_PREFIX
    }
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.__vic361Admin = api;
  }
})();
