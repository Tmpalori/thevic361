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

  // Source pill copy. The admin shows where every event came from so the
  // editor can decide how much to trust it (an organizer-submitted event is
  // different from a Sonar scrape). `inferSource()` figures out a source for
  // legacy candidates that pre-date the explicit metadata.
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
    // Legacy heuristics: if the event was added from local YAML it usually
    // has no URL and was edited by hand; otherwise treat as candidate.
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
    pat: null,
    candidates: [],
    selected: new Set(), // event keys
    // week: 'this' (Mon–Sun of the current local week), 'next', or 'upcoming'
    // (everything from this Monday forward). Past dates are always hidden.
    filters: { search: '', category: '', venue: '', week: 'this' }
  };

  // ─── HELPERS ───
  function eventKey(ev) {
    // Stable key built from date + name + venue (no per-event id in source data).
    return [ev.date || '', ev.name || '', ev.venue || ''].join('|');
  }

  // Monday of the local-time week containing `now` (defaults to today).
  // Returned as a Date at local midnight.
  function getMondayOfWeek(now) {
    const base = now ? new Date(now.getTime()) : new Date();
    base.setHours(0, 0, 0, 0);
    const dow = base.getDay(); // 0 = Sun, 1 = Mon, … 6 = Sat
    const daysFromMonday = dow === 0 ? 6 : dow - 1;
    base.setDate(base.getDate() - daysFromMonday);
    return base;
  }

  // Returns { mondayStr, sundayStr } as YYYY-MM-DD for the active week.
  // offsetWeeks: 0 = this week, 1 = next week, …
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

  // Apply the week-bucket filter to a date string. Past dates (before this
  // Monday) are excluded from every bucket so a stale collector run doesn't
  // resurface last week's events as the primary review set.
  function inWeekBucket(dateStr, bucket, now) {
    if (!dateStr) return false;
    if (bucket === 'all') return true; // test-only escape hatch; not in UI
    const thisMonday = toLocalDateStr(getMondayOfWeek(now));
    if (dateStr < thisMonday) return false;
    if (bucket === 'upcoming') return true;
    const offset = bucket === 'next' ? 1 : 0;
    const { mondayStr, sundayStr } = getWeekRange(offset, now);
    return dateStr >= mondayStr && dateStr <= sundayStr;
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
      pruneStalePastSelections();
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
                ' ' + srcPill + submitterMeta + '</p>' +
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

  // Drop selections whose event date is before this Monday. Prevents picks
  // from last week's review session from leaking into the new week's publish.
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
  // Public events.json must never carry submitter PII or admin-only fields.
  // Strip every key that starts with "_" plus the explicit submitter list
  // before writing — defense in depth on top of API-side scoping. Public
  // _source is preserved without the underscore prefix as `source` so the
  // public site can render attribution if it ever wants to.
  const PRIVATE_KEYS = new Set([
    'submitter_name', 'submitter_email', 'submitter_ip', 'user_agent',
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
  // Write the payload to sessionStorage under a short key, then point the
  // iframe at index.html?previewKey=<key>. Keeps the URL short regardless of
  // how many events are selected (the old ?preview=<json-blob> form blew past
  // browser URI limits once the picks list got large).
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
  // Merge a list of candidate-shaped events into state.candidates without
  // duplicating by eventKey. Used by the Submissions tab's "Pull approved
  // into picker" action so the editor can include approved public submissions
  // in the next publish without leaving the picker.
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
    _state: state,
    _constants: {
      WEEKDAY_TARGET_MIN, WEEKDAY_TARGET_MAX,
      WEEKEND_TARGET_MIN, WEEKEND_TARGET_MAX,
      PAT_KEY, PICKS_KEY, REPO_OWNER, REPO_NAME, BRANCH,
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
