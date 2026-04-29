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
    candidate: 'Candidate',
    unknown: 'Unknown'
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
    filters: { search: '', category: '', venue: '', week: 'this' }
  };

  // ─── HELPERS ───
  function eventKey(ev) {
    return [ev.date || '', ev.name || '', ev.venue || ''].join('|');
  }

  function getMondayOfWeek(now) {
    const base = now ? new Date(now.getTime()) : new Date();
    base.setHours(0, 0, 0, 0);
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
    try { localStorage.removeItem(PICKS_KEY); } catch (_) {}
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

  async function adminFetch(path, init) {
    const headers = Object.assign({}, (init && init.headers) || {});
    if (state.session) headers['Authorization'] = 'Bearer ' + state.session;
    if (init && init.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(apiBaseUrl() + path, Object.assign({}, init, { headers }));
    let json = null;
    try { json = await res.json(); } catch (_) {}
    if (res.status === 401) {
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
    let u = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME +
            '/contents/' + p;
    if (ref) u += '?ref=' + encodeURIComponent(ref);
    return u;
  }
  async function ghGetJsonFile(p) {
    const res = await fetch(ghContentsUrl(p, BRANCH), {
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
      branch: BRANCH
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
    const res = await fetch('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME, {
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
        const got = await ghGetJsonFile(CANDIDATES_PATH);
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
      setStatus('Loaded ' + events.length + ' candidate event(s).', 'success');
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
      const targetMin = weekend ? WEEKEND_TARGET_MIN : WEEKDAY_TARGET_MIN;
      const targetMax = weekend ? WEEKEND_TARGET_MAX : WEEKDAY_TARGET_MAX;
      const selectedInGroup = evs.filter(ev => state.selected.has(eventKey(ev))).length;
      const inRange = selectedInGroup >= targetMin && selectedInGroup <= targetMax;
      const countCls = inRange ? 'is-ok' : 'is-warn';

      const rows = evs.map(ev => {
        const k = eventKey(ev);
        const checked = state.selected.has(k) ? 'checked' : '';
        const icons = (ev.icons || []).map(i => ICON_MAP[i] || '').join(' ');
        const src = inferSource(ev);
        const srcPill = '<span class="src-pill src-pill--' + escapeHtml(src) +
          '" title="Source: ' + escapeHtml(sourceLabel(src)) + '">' +
          escapeHtml(sourceLabel(src)) + '</span>';
        const publishedPill = state.publishedKeys.has(k)
          ? '<span class="src-pill src-pill--published" title="Currently live on thevic361.com">Published</span>'
          : '';
        const submitterMeta = ev._submitter_kind
          ? '<span class="src-meta">' + escapeHtml(ev._submitter_kind === 'organizer'
              ? 'Organizer' : ev._submitter_kind === 'found_online'
              ? 'Found online' : 'Submitter: ' + ev._submitter_kind) + '</span>'
          : '';
        return (
          '<label class="event-row">' +
            '<input type="checkbox" data-key="' + escapeHtml(k) + '" ' + checked + '>' +
            '<div class="event-row__main">' +
              '<p class="event-row__name">' + escapeHtml(ev.name || '(untitled)') +
                ' ' + srcPill + publishedPill + submitterMeta + '</p>' +
              '<div class="event-row__meta">' +
                (ev.time ? '<span>🕒 ' + escapeHtml(ev.time) + '</span>' : '') +
                (ev.venue ? '<span>📍 ' + escapeHtml(ev.venue) + '</span>' : '') +
                (ev.free ? '<span>🆓 Free</span>' : '') +
              '</div>' +
              (ev.description
                ? '<p class="event-row__desc">' + escapeHtml(ev.description) + '</p>'
                : '') +
            '</div>' +
            '<div class="event-row__icons" aria-hidden="true">' + icons + '</div>' +
          '</label>'
        );
      }).join('');

      return (
        '<section class="day-group" data-date="' + escapeHtml(date) + '">' +
          '<h2>' + escapeHtml(heading) +
            ' <span class="day-group__count ' + countCls + '">' +
              selectedInGroup + ' selected · target ' + targetMin + '–' + targetMax +
              (weekend ? ' (weekend)' : ' (weekday)') +
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
      sum.textContent = total + ' selected · ' + weekday + ' weekday / ' + weekend + ' weekend';
      const okWeekday = weekday >= WEEKDAY_TARGET_MIN && weekday <= WEEKDAY_TARGET_MAX;
      const okWeekend = weekend >= WEEKEND_TARGET_MIN && weekend <= WEEKEND_TARGET_MAX;
      sum.classList.remove('is-ok', 'is-warn');
      if (okWeekday && okWeekend) sum.classList.add('is-ok');
      else sum.classList.add('is-warn');
    }
  }

  // ─── SELECTIONS PERSISTENCE ───
  function persistSelections() {
    try {
      localStorage.setItem(PICKS_KEY, JSON.stringify(Array.from(state.selected)));
    } catch (_) {}
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
    try {
      const { res, json } = await adminFetch('/api/admin/published-events');
      if (!res.ok || !json || !json.ok) return;
      const events = Array.isArray(json.events) ? json.events : [];
      const keys = new Set(events.map(eventKey));
      state.publishedKeys = keys;
      // Pre-check anything that's published AND still in the candidate list.
      // We don't add keys that aren't in candidates — they'd be invisible
      // (no checkbox renders) and would inflate the count without recourse.
      const candidateKeys = new Set(state.candidates.map(eventKey));
      let added = 0;
      for (const k of keys) {
        if (candidateKeys.has(k) && !state.selected.has(k)) {
          state.selected.add(k);
          added += 1;
        }
      }
      if (added > 0) persistSelections();
    } catch (err) {
      console.warn('[admin] published-events fetch failed:', err.message);
    }
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
    const blob = encodeURIComponent(JSON.stringify(payload));
    return 'index.html?preview=' + blob;
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
    parts.push('<h1 style="font-family: Georgia, serif;">This Week in The Vic 361</h1>');
    for (const [date, evs] of groups) {
      const heading = date === '(undated)' ? 'Undated' : formatDateHeading(date);
      parts.push('<h2 style="border-bottom:2px solid #2d5b8a; padding-bottom:4px;">' +
        escapeHtml(heading) + '</h2>');
      for (const ev of evs) {
        parts.push('<div style="margin: 0 0 16px;">');
        const titleText = escapeHtml(ev.name || '(untitled)');
        const title = ev.url
          ? '<a href="' + escapeHtml(ev.url) + '" style="color:#2d5b8a;">' + titleText + '</a>'
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

  // ─── PUBLISH ───
  async function publish() {
    const btn = document.getElementById('publish-btn');
    const picks = getPickedEvents();
    if (!picks.length) {
      setStatus('Select at least one event before publishing.', 'error');
      return;
    }
    const mode = publishMode();
    if (!mode) {
      setStatus('Cannot publish — please sign in first.', 'error');
      return;
    }
    if (!confirm('Publish ' + picks.length + ' event(s) to docs/events.json on main?')) {
      return;
    }
    if (btn) btn.disabled = true;
    setStatus('Publishing…');
    try {
      const payload = buildEventsPayload();
      if (mode === 'server') {
        const { res, json } = await adminFetch('/api/admin/publish-events', {
          method: 'POST',
          body: JSON.stringify({ events: payload.events })
        });
        if (!res.ok || !json || !json.ok) {
          throw new Error((json && (json.message || json.error)) || ('Publish failed (' + res.status + ')'));
        }
        // Surface partial-publish status. The server always saves to Railway
        // first; the GitHub commit is best-effort and only happens when
        // GITHUB_TOKEN is configured. A failed/skipped GitHub commit must NOT
        // be surfaced as an error — the public site (Railway/Postgres) is
        // already updated, which is what Save & Publish is responsible for.
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
        try { sha = (await ghGetJsonFile(EVENTS_PATH)).sha; }
        catch (err) { console.warn('Could not get current events.json sha:', err.message); }
        const msg = 'Publish events ' + new Date().toISOString().slice(0, 10) +
                    ' (' + picks.length + ' picks)';
        await ghPutJsonFile(EVENTS_PATH, payload, msg, sha);
      }
      setStatus('Published ' + picks.length + ' event(s) to docs/events.json.', 'success');
    } catch (err) {
      console.error(err);
      setStatus(err.message || 'Publish failed.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ─── TABS ───
  function activateTab(name) {
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(t => t.classList.toggle('is-active', t.dataset.tab === name));
    const panels = {
      picker: document.getElementById('tab-picker'),
      submissions: document.getElementById('tab-submissions'),
      preview: document.getElementById('tab-preview'),
      newsletter: document.getElementById('tab-newsletter'),
      sources: document.getElementById('tab-sources')
    };
    Object.entries(panels).forEach(([k, el]) => {
      if (!el) return;
      el.hidden = (k !== name);
      el.classList.toggle('is-active', k === name);
    });
    if (name === 'preview') refreshPreview();
    if (name === 'newsletter') refreshNewsletter();
    if (name === 'sources') loadSources();
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
  }

  async function init() {
    wireEvents();
    initTheme();
    state.session = getSession();
    state.pat = getPat();
    // Best-effort fetch of server config so the UI knows which auth flows are
    // usable. Failures here are non-fatal — falls back to login form visible.
    state.serverConfig = await fetchServerConfig();
    applyServerConfigToUi(state.serverConfig);

    if (state.session) {
      // Probe the session before showing the app so an expired session lands
      // the editor on the login form instead of the picker with broken calls.
      const ok = await authedSession();
      if (ok) {
        showApp();
        loadCandidates();
        return;
      }
      // Session was bad — clear and fall through.
      state.session = null;
      clearSession();
    }
    if (state.pat) {
      showApp();
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
    getMondayOfWeek, getWeekRange, inWeekBucket, toLocalDateStr,
    pruneStalePastSelections,
    inferSource, sourceLabel, mergeCandidateEvents, stripPrivateFields,
    publishMode,
    getStoredTheme, setStoredTheme, effectiveTheme, applyTheme, toggleTheme,
    initTheme, updateThemeToggleUi,
    renderSources, loadSources, triggerCollect, formatSourceTime,
    setSourcesMessage, describeTriggerError,
    _state: state,
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
