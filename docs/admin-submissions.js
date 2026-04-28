/* admin-submissions.js — Admin Submissions tab.
 *
 * Talks to the Express API exposed by server/index.js. Two pieces of config
 * live in localStorage so the static admin can target a Railway-hosted server
 * without baking URLs into source:
 *   - vic361_submissions_api_url   (e.g. https://thevic361.up.railway.app)
 *   - vic361_submissions_admin_token (the ADMIN_TOKEN env var on the server)
 *
 * If either is missing the tab still renders a config form. If the API URL is
 * empty we treat the same origin as the API host so a Railway deploy that
 * also serves the admin static page works with no extra config.
 */
(function () {
  'use strict';

  const API_KEY = 'vic361_submissions_api_url';
  const TOK_KEY = 'vic361_submissions_admin_token';

  const state = {
    apiBase: '',
    token: '',
    status: 'pending',
    submissions: [],
    editing: new Set()
  };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function getStored(k) { try { return localStorage.getItem(k) || ''; } catch (_) { return ''; } }
  function setStored(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

  function loadConfig() {
    state.apiBase = getStored(API_KEY).replace(/\/+$/, '');
    state.token = getStored(TOK_KEY);
    const apiInput = $('#submissions-api-url');
    const tokInput = $('#submissions-admin-token');
    if (apiInput) apiInput.value = state.apiBase;
    if (tokInput) tokInput.value = state.token;
  }

  function apiUrl(path) {
    const base = state.apiBase || '';
    return base + path;
  }

  async function apiFetch(path, init) {
    const headers = Object.assign({}, (init && init.headers) || {});
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    if (init && init.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(apiUrl(path), Object.assign({}, init, { headers }));
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { res, json };
  }

  function showError(msg) {
    const el = $('#submissions-error');
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = msg;
  }

  async function loadSubmissions() {
    if (!state.apiBase && location.protocol === 'file:') {
      showError('Set the Submissions API URL above (your Railway server).');
      return;
    }
    if (!state.token) {
      showError('Set the admin token above (matches ADMIN_TOKEN on the server).');
      return;
    }
    showError('');
    const path = '/api/admin/submissions' + (state.status ? '?status=' + encodeURIComponent(state.status) : '');
    let res, json;
    try {
      ({ res, json } = await apiFetch(path));
    } catch (err) {
      showError('Could not reach the submissions API: ' + (err && err.message));
      return;
    }
    if (!res.ok || !json || !json.ok) {
      const code = json && json.error;
      if (res.status === 401) showError('Token rejected by server.');
      else if (code === 'admin-not-configured') showError('Server is missing ADMIN_TOKEN env var.');
      else showError('Failed to load submissions (' + res.status + ').');
      return;
    }
    state.submissions = Array.isArray(json.submissions) ? json.submissions : [];
    render();
    refreshPendingBadge();
  }

  async function refreshPendingBadge() {
    if (!state.apiBase || !state.token) return;
    let res, json;
    try {
      ({ res, json } = await apiFetch('/api/admin/submissions?status=pending'));
    } catch (_) { return; }
    if (!res.ok || !json || !json.ok) return;
    const n = (json.submissions || []).length;
    const badge = $('#submissions-pending-badge');
    if (!badge) return;
    if (n > 0) { badge.hidden = false; badge.textContent = String(n); }
    else { badge.hidden = true; badge.textContent = '0'; }
  }

  function submitterLabel(kind) {
    if (kind === 'organizer') return 'Organizer';
    if (kind === 'found_online') return 'Found online';
    return 'Other';
  }

  function renderRow(row) {
    const p = row.payload || {};
    const cats = (p.icons || []).join(', ');
    const editing = state.editing.has(row.id);
    const submitterBlock = (row.submitter_name || row.submitter_email || row.submitter_kind)
      ? '<div class="submission-card__submitter">' +
          '<strong>' + escapeHtml(submitterLabel(row.submitter_kind)) + '</strong>' +
          (row.submitter_name ? ' · ' + escapeHtml(row.submitter_name) : '') +
          (row.submitter_email ? ' · ' + escapeHtml(row.submitter_email) : '') +
        '</div>'
      : '';

    const editBlock = editing
      ? '<div class="submission-edit">' +
          '<input data-edit="name" value="' + escapeHtml(p.name || '') + '" placeholder="Name">' +
          '<input data-edit="date" value="' + escapeHtml(p.date || '') + '" placeholder="YYYY-MM-DD">' +
          '<input data-edit="time" value="' + escapeHtml(p.time || '') + '" placeholder="Start time">' +
          '<input data-edit="venue" value="' + escapeHtml(p.venue || '') + '" placeholder="Venue">' +
          '<input data-edit="address" value="' + escapeHtml(p.address || '') + '" placeholder="Address">' +
          '<input data-edit="url" value="' + escapeHtml(p.url || '') + '" placeholder="Link">' +
          '<textarea data-edit="description" rows="3" placeholder="Description">' +
            escapeHtml(p.description || '') + '</textarea>' +
          '<div class="submission-card__actions">' +
            '<button data-act="save" class="btn btn--primary">Save edits</button>' +
            '<button data-act="cancel-edit" class="btn btn--outline">Cancel</button>' +
          '</div>' +
        '</div>'
      : '';

    const statusCls = 'submission-status--' + escapeHtml(row.status || 'pending');
    return (
      '<article class="submission-card" data-id="' + escapeHtml(row.id) + '">' +
        '<div class="submission-card__head">' +
          '<h3 class="submission-card__title">' + escapeHtml(p.name || '(untitled)') + '</h3>' +
          '<span class="submission-status ' + statusCls + '">' + escapeHtml(row.status || 'pending') + '</span>' +
        '</div>' +
        '<p class="submission-card__meta">' +
          (p.date ? '<span>📅 ' + escapeHtml(p.date) + '</span>' : '') +
          (p.time ? '<span>🕒 ' + escapeHtml(p.time) +
            (p.end_time ? ' – ' + escapeHtml(p.end_time) : '') + '</span>' : '') +
          (p.venue ? '<span>📍 ' + escapeHtml(p.venue) + '</span>' : '') +
          (cats ? '<span>🏷️ ' + escapeHtml(cats) + '</span>' : '') +
          (p.free ? '<span>🆓 Free</span>' : '<span>🎟️ Paid</span>') +
        '</p>' +
        (p.description ? '<p class="submission-card__desc">' + escapeHtml(p.description) + '</p>' : '') +
        (p.url ? '<p><a href="' + escapeHtml(p.url) + '" target="_blank" rel="noopener">' +
          escapeHtml(p.url) + '</a></p>' : '') +
        submitterBlock +
        editBlock +
        (editing ? '' : ('<div class="submission-card__actions">' +
          (row.status === 'approved' ? '' :
            '<button data-act="approve" class="btn btn--primary">Approve</button>') +
          (row.status === 'rejected' ? '' :
            '<button data-act="reject" class="btn btn--outline">Reject</button>') +
          (row.status === 'duplicate' ? '' :
            '<button data-act="duplicate" class="btn btn--outline">Mark duplicate</button>') +
          '<button data-act="edit" class="btn btn--outline">Edit</button>' +
        '</div>')) +
      '</article>'
    );
  }

  function render() {
    const list = $('#submissions-list');
    const empty = $('#submissions-empty');
    if (!list) return;
    if (!state.submissions.length) {
      list.innerHTML = '';
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = state.submissions.map(renderRow).join('');
    wireRowActions(list);
  }

  function wireRowActions(list) {
    list.querySelectorAll('.submission-card').forEach(card => {
      const id = card.getAttribute('data-id');
      card.querySelectorAll('button[data-act]').forEach(btn => {
        btn.addEventListener('click', () => handleAction(id, btn.getAttribute('data-act'), card));
      });
    });
  }

  async function patch(id, body) {
    const { res, json } = await apiFetch('/api/admin/submissions/' + encodeURIComponent(id), {
      method: 'POST',
      body: JSON.stringify(body)
    });
    if (!res.ok || !json || !json.ok) {
      showError((json && json.error) || ('Update failed (' + res.status + ').'));
      return null;
    }
    return json.submission;
  }

  async function handleAction(id, act, card) {
    if (act === 'approve') return doStatus(id, 'approved');
    if (act === 'reject') return doStatus(id, 'rejected');
    if (act === 'duplicate') return doStatus(id, 'duplicate');
    if (act === 'edit') {
      state.editing.add(id); render(); return;
    }
    if (act === 'cancel-edit') {
      state.editing.delete(id); render(); return;
    }
    if (act === 'save') {
      const updates = {};
      card.querySelectorAll('[data-edit]').forEach(el => {
        updates[el.getAttribute('data-edit')] = el.value;
      });
      const orig = state.submissions.find(s => s.id === id);
      const merged = Object.assign({}, orig && orig.payload, updates);
      const updated = await patch(id, { payload: merged });
      if (updated) {
        state.editing.delete(id);
        const idx = state.submissions.findIndex(s => s.id === id);
        if (idx !== -1) state.submissions[idx] = updated;
        render();
      }
    }
  }

  async function doStatus(id, status) {
    const updated = await patch(id, { status });
    if (updated) {
      const idx = state.submissions.findIndex(s => s.id === id);
      if (idx !== -1) state.submissions[idx] = updated;
      // If the current filter no longer matches, drop the row from view.
      if (state.status && state.status !== status) {
        state.submissions = state.submissions.filter(s => s.id !== id);
      }
      render();
      refreshPendingBadge();
    }
  }

  async function pullApprovedIntoPicker() {
    const { res, json } = await apiFetch('/api/admin/approved-events');
    if (!res.ok || !json || !json.ok) {
      showError('Failed to fetch approved submissions.');
      return;
    }
    const adminApi = (typeof window !== 'undefined') ? window.__vic361Admin : null;
    if (!adminApi || !adminApi.mergeCandidateEvents) {
      showError('Admin picker not loaded — cannot merge approved submissions.');
      return;
    }
    const added = adminApi.mergeCandidateEvents(json.events || []);
    showError('');
    const status = document.getElementById('status-message');
    if (status) {
      status.textContent = added
        ? ('Pulled ' + added + ' approved submission(s) into the picker.')
        : 'No new approved submissions to merge.';
      status.classList.remove('is-error');
      status.classList.add('is-success');
    }
    // Switch back to the Pick events tab so the editor can include them.
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('is-active', b.dataset.tab === 'picker'));
    ['picker', 'submissions', 'preview', 'newsletter'].forEach(name => {
      const el = document.getElementById('tab-' + name);
      if (el) { el.hidden = name !== 'picker'; el.classList.toggle('is-active', name === 'picker'); }
    });
  }

  function wire() {
    const saveBtn = $('#submissions-save-config');
    if (saveBtn) saveBtn.addEventListener('click', () => {
      const api = ($('#submissions-api-url') || {}).value || '';
      const tok = ($('#submissions-admin-token') || {}).value || '';
      setStored(API_KEY, api.trim().replace(/\/+$/, ''));
      setStored(TOK_KEY, tok.trim());
      loadConfig();
      loadSubmissions();
    });

    const refresh = $('#submissions-refresh');
    if (refresh) refresh.addEventListener('click', loadSubmissions);

    const pull = $('#submissions-pull-approved');
    if (pull) pull.addEventListener('click', pullApprovedIntoPicker);

    const sel = $('#submissions-status');
    if (sel) sel.addEventListener('change', () => {
      state.status = sel.value;
      loadSubmissions();
    });

    // Hook into existing tab switching so we lazy-load when the user opens
    // the tab the first time.
    document.querySelectorAll('.tab-btn').forEach(btn => {
      if (btn.dataset.tab !== 'submissions') return;
      btn.addEventListener('click', () => {
        if (state.apiBase || state.token) loadSubmissions();
      });
    });
  }

  function init() {
    loadConfig();
    wire();
    // Best-effort badge refresh on load so the editor sees pending count
    // without needing to open the tab.
    refreshPendingBadge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  if (typeof window !== 'undefined') {
    window.__vic361Submissions = {
      _state: state,
      apiUrl, loadConfig, render, renderRow,
      _testHooks: { loadSubmissions, doStatus, pullApprovedIntoPicker }
    };
  }
})();
