/* admin.js — The Vic 361 admin panel
 *
 * Static single-page admin: gated by a GitHub PAT stored in localStorage,
 * lets an editor pick events from candidates.json and publish docs/events.json
 * via the GitHub Contents API.
 */
(function () {
  'use strict';

  // ─── CONSTANTS ───
  const REPO_OWNER = 'Tmpalori';
  const REPO_NAME  = 'thevic361';
  const BRANCH     = 'main';
  const PAT_KEY    = 'vic361_admin_pat';
  const PICKS_KEY  = 'vic361_admin_picks';

  const CANDIDATES_PATH = 'candidates.json';
  const EVENTS_PATH     = 'docs/events.json';

  const ICON_MAP = {
    food: '🍔', music: '🎵', family: '🧑‍🧑‍🧒', drinks: '🍺',
    arts: '🎨', shopping: '🛍️', outdoors: '🏃',
    community: '📣', free: '🆓'
  };

  const WEEKDAY_TARGET_MIN = 4;
  const WEEKDAY_TARGET_MAX = 8;
  const WEEKEND_TARGET_MIN = 8;
  const WEEKEND_TARGET_MAX = 12;

  // ─── STATE ───
  const state = {
    pat: null,
    candidates: [],
    selected: new Set(), // event keys
    filters: { search: '', category: '', venue: '' }
  };

  // ─── HELPERS ───
  function eventKey(ev) {
    // Stable key built from date + name + venue (no per-event id in source data).
    return [ev.date || '', ev.name || '', ev.venue || ''].join('|');
  }

  function isWeekend(dateStr) {
    if (!dateStr) return false;
    // Parse YYYY-MM-DD as local date to avoid TZ drift.
    const parts = dateStr.split('-').map(Number);
    if (parts.length !== 3) return false;
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    const dow = d.getDay();
    return dow === 0 || dow === 5 || dow === 6; // Fri/Sat/Sun
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

  // ─── PAT / AUTH ───
  function getPat() {
    try { return localStorage.getItem(PAT_KEY); } catch (_) { return null; }
  }
  function setPat(pat) {
    try { localStorage.setItem(PAT_KEY, pat); } catch (_) {}
  }
  function clearPat() {
    try {
      localStorage.removeItem(PAT_KEY);
      localStorage.removeItem(PICKS_KEY);
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
  }

  // ─── GITHUB API ───
  function ghHeaders() {
    return {
      Authorization: 'Bearer ' + state.pat,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  function ghContentsUrl(path, ref) {
    let u = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME +
            '/contents/' + path;
    if (ref) u += '?ref=' + encodeURIComponent(ref);
    return u;
  }

  async function ghGetJsonFile(path) {
    const res = await fetch(ghContentsUrl(path, BRANCH), {
      headers: ghHeaders(), cache: 'no-store'
    });
    if (!res.ok) {
      const msg = 'GitHub fetch failed (' + res.status + ') for ' + path;
      throw new Error(msg);
    }
    const meta = await res.json();
    let text;
    if (meta.encoding === 'base64' && typeof meta.content === 'string') {
      // GitHub may wrap base64 in newlines.
      text = atob(meta.content.replace(/\n/g, ''));
      // Decode UTF-8 bytes.
      try {
        const bytes = Uint8Array.from(text, c => c.charCodeAt(0));
        text = new TextDecoder('utf-8').decode(bytes);
      } catch (_) { /* fall through with non-UTF8 text */ }
    } else if (meta.download_url) {
      const r2 = await fetch(meta.download_url);
      text = await r2.text();
    } else {
      throw new Error('Unsupported GitHub response for ' + path);
    }
    return { sha: meta.sha, data: JSON.parse(text) };
  }

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  async function ghPutJsonFile(path, dataObj, message, sha) {
    const body = {
      message: message,
      content: utf8ToBase64(JSON.stringify(dataObj, null, 2) + '\n'),
      branch: BRANCH
    };
    if (sha) body.sha = sha;
    const res = await fetch(ghContentsUrl(path), {
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
  async function loadCandidates() {
    const listEl = document.getElementById('picker-list');
    const loadEl = document.getElementById('picker-loading');
    const errEl = document.getElementById('picker-error');
    if (loadEl) loadEl.hidden = false;
    if (errEl) errEl.hidden = true;
    if (listEl) listEl.innerHTML = '';

    try {
      const { data } = await ghGetJsonFile(CANDIDATES_PATH);
      const events = Array.isArray(data && data.events) ? data.events : [];
      state.candidates = events.slice().sort((a, b) => {
        const da = (a.date || '') + ' ' + (a.time || '');
        const db = (b.date || '') + ' ' + (b.time || '');
        return da.localeCompare(db);
      });
      restoreSelectionsFromStorage();
      populateFilters();
      renderPicker();
      setStatus('Loaded ' + events.length + ' candidate event(s).', 'success');
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
    return events.filter(ev => {
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
        return (
          '<label class="event-row">' +
            '<input type="checkbox" data-key="' + escapeHtml(k) + '" ' + checked + '>' +
            '<div class="event-row__main">' +
              '<p class="event-row__name">' + escapeHtml(ev.name || '(untitled)') + '</p>' +
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

    // Wire checkboxes.
    listEl.querySelectorAll('input[type="checkbox"][data-key]').forEach(cb => {
      cb.addEventListener('change', () => {
        const k = cb.getAttribute('data-key');
        if (cb.checked) state.selected.add(k);
        else state.selected.delete(k);
        persistSelections();
        // Re-render only counts (cheap) by updating the day-group header text.
        updateCounts();
        // The per-day counts inside h2 also need refresh; simplest is full rerender.
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

  // ─── PICKED EVENTS ─→ events.json shape ───
  function getPickedEvents() {
    return state.candidates.filter(ev => state.selected.has(eventKey(ev)));
  }
  function buildEventsPayload() {
    return {
      last_updated: new Date().toISOString(),
      events: getPickedEvents()
    };
  }

  // ─── PREVIEW TAB ───
  function refreshPreview() {
    const frame = document.getElementById('preview-frame');
    if (!frame) return;
    const payload = buildEventsPayload();
    const blob = encodeURIComponent(JSON.stringify(payload));
    frame.src = 'index.html?preview=' + blob;
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
    if (!confirm('Publish ' + picks.length + ' event(s) to docs/events.json on main?')) {
      return;
    }
    if (btn) btn.disabled = true;
    setStatus('Publishing…');
    try {
      let sha = null;
      try {
        const cur = await ghGetJsonFile(EVENTS_PATH);
        sha = cur.sha;
      } catch (err) {
        // 404 is fine — file may not exist yet. Anything else, surface but try.
        console.warn('Could not get current events.json sha:', err.message);
      }
      const payload = buildEventsPayload();
      const msg = 'Publish events ' + new Date().toISOString().slice(0, 10) +
                  ' (' + picks.length + ' picks)';
      await ghPutJsonFile(EVENTS_PATH, payload, msg, sha);
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
      preview: document.getElementById('tab-preview'),
      newsletter: document.getElementById('tab-newsletter')
    };
    Object.entries(panels).forEach(([k, el]) => {
      if (!el) return;
      el.hidden = (k !== name);
      el.classList.toggle('is-active', k === name);
    });
    if (name === 'preview') refreshPreview();
    if (name === 'newsletter') refreshNewsletter();
  }

  // ─── INIT ───
  function wireEvents() {
    const authForm = document.getElementById('auth-form');
    if (authForm) {
      authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('auth-pat');
        const pat = (input.value || '').trim();
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
        clearPat();
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
    if (search) search.addEventListener('input', () => {
      state.filters.search = search.value; renderPicker();
    });
    if (cat) cat.addEventListener('change', () => {
      state.filters.category = cat.value; renderPicker();
    });
    if (ven) ven.addEventListener('change', () => {
      state.filters.venue = ven.value; renderPicker();
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
  }

  function init() {
    wireEvents();
    const pat = getPat();
    if (pat) {
      state.pat = pat;
      showApp();
      loadCandidates();
    } else {
      showAuthGate();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ─── TEST EXPORTS ───
  // Expose pure helpers for unit tests in environments that have a global hook.
  // Browser builds simply ignore this.
  const api = {
    eventKey, isWeekend, formatDateHeading, escapeHtml,
    applyFilters, groupByDate, buildNewsletterHtml,
    utf8ToBase64,
    _state: state,
    _constants: {
      WEEKDAY_TARGET_MIN, WEEKDAY_TARGET_MAX,
      WEEKEND_TARGET_MIN, WEEKEND_TARGET_MAX,
      PAT_KEY, PICKS_KEY, REPO_OWNER, REPO_NAME, BRANCH
    }
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.__vic361Admin = api;
  }
})();
