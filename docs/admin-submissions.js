/* admin-submissions.js — Admin Submissions tab.
 *
 * Talks to the Express API exposed by server/index.js. Auth modes:
 *   1. Default: reuse the session token issued by /api/admin/login
 *      (same `vic361_admin_session` localStorage key used by the picker tab).
 *      Works on the Railway deploy that serves both the admin and the API.
 *   2. Override: paste a custom API base URL + bearer token. Only needed
 *      when pointing the static admin at a different backend, or when the
 *      operator is using the legacy ADMIN_TOKEN env var.
 *
 * Override config keys (localStorage):
 *   - vic361_submissions_api_url      (e.g. https://other.up.railway.app)
 *   - vic361_submissions_admin_token  (raw bearer token)
 */
(function () {
  'use strict';

  const API_KEY = 'vic361_submissions_api_url';
  const TOK_KEY = 'vic361_submissions_admin_token';
  const SESSION_KEY = 'vic361_admin_session';

  const state = {
    apiBase: '',
    token: '',
    status: 'pending',
    submissions: [],
    editing: new Set()
  };

  // Resolve which API base URL + bearer token to use for /api/admin/* calls.
  // Override (legacy) config wins if set, otherwise fall back to same-origin
  // with the unified session token from /api/admin/login.
  function resolveAuth() {
    const overrideBase = state.apiBase || '';
    const overrideTok = state.token || '';
    if (overrideBase || overrideTok) {
      return { base: overrideBase, token: overrideTok, source: 'override' };
    }
    let session = '';
    try { session = localStorage.getItem(SESSION_KEY) || ''; } catch (_) {}
    return { base: '', token: session, source: 'session' };
  }

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
    const { base } = resolveAuth();
    return (base || '') + path;
  }

  async function apiFetch(path, init) {
    const { base, token } = resolveAuth();
    const headers = Object.assign({}, (init && init.headers) || {});
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (init && init.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch((base || '') + path, Object.assign({}, init, { headers }));
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
    const { base, token, source } = resolveAuth();
    if (!base && location.protocol === 'file:') {
      showError('Open the admin from your Railway URL, or set the Submissions API URL override.');
      return;
    }
    if (!token) {
      if (source === 'session') {
        showError('Sign in via the login form to view submissions.');
      } else {
        showError('Set the admin token override above.');
      }
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
    const { token } = resolveAuth();
    if (!token) return;
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

  // Field metadata for the edit view. Keeping it declarative makes the
  // render predictable and keeps the visible label tied to the data-edit key
  // the save handler uses, so the admin always sees what they're editing.
  const EDIT_FIELDS = [
    { key: 'name',        label: 'Event name',           type: 'input',    placeholder: 'Event name' },
    { key: 'date',        label: 'Date',                 type: 'input',    placeholder: 'YYYY-MM-DD' },
    { key: 'time',        label: 'Start time',           type: 'input',    placeholder: 'e.g. 7:00 PM' },
    { key: 'end_time',    label: 'End time',             type: 'input',    placeholder: 'e.g. 10:00 PM (optional)' },
    { key: 'venue',       label: 'Venue',                type: 'input',    placeholder: 'Venue name' },
    { key: 'address',     label: 'Address',              type: 'input',    placeholder: 'Street address' },
    { key: 'url',         label: 'Link',                 type: 'input',    placeholder: 'https://example.com' },
    { key: 'description', label: 'Description',          type: 'textarea', rows: 3, placeholder: 'Description' },
    { key: 'submitter_first_name', label: 'Submitter first name', type: 'input', placeholder: 'First name' },
    { key: 'submitter_last_name',  label: 'Submitter last name',  type: 'input', placeholder: 'Last name' },
    { key: 'submitter_phone',      label: 'Submitter phone',      type: 'input', placeholder: 'Phone number' }
  ];

  function renderEditField(f, p) {
    const id = 'sub-edit-' + f.key + '-' + Math.random().toString(36).slice(2, 8);
    const val = escapeHtml(p[f.key] || '');
    const ph = escapeHtml(f.placeholder || '');
    const label = '<label class="submission-edit__label" for="' + id + '">' +
      escapeHtml(f.label) + '</label>';
    const control = f.type === 'textarea'
      ? '<textarea id="' + id + '" data-edit="' + f.key + '" rows="' + (f.rows || 3) +
          '" placeholder="' + ph + '">' + val + '</textarea>'
      : '<input id="' + id + '" data-edit="' + f.key + '" value="' + val +
          '" placeholder="' + ph + '">';
    return '<div class="submission-edit__field">' + label + control + '</div>';
  }

  function renderRow(row) {
    const p = row.payload || {};
    const cats = (p.icons || []).join(', ');
    const editing = state.editing.has(row.id);
    // Prefer the concatenated submitter_name (stored at row level for backcompat),
    // fall back to the first/last parts on the payload if a row predates the
    // backcompat write.
    const fullName = row.submitter_name ||
      [p.submitter_first_name, p.submitter_last_name].filter(Boolean).join(' ');
    const submitterBlock = (fullName || row.submitter_email || row.submitter_kind || p.submitter_phone)
      ? '<div class="submission-card__submitter">' +
          '<strong>' + escapeHtml(submitterLabel(row.submitter_kind)) + '</strong>' +
          (fullName ? ' · ' + escapeHtml(fullName) : '') +
          (row.submitter_email ? ' · ' + escapeHtml(row.submitter_email) : '') +
          (p.submitter_phone ? ' · ' + escapeHtml(p.submitter_phone) : '') +
        '</div>'
      : '';

    const editBlock = editing
      ? '<div class="submission-edit">' +
          '<p class="submission-edit__title">Editing submission · ' +
            escapeHtml(p.name || '(untitled)') + '</p>' +
          EDIT_FIELDS.map(f => renderEditField(f, p)).join('') +
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
          (p.address ? '<span>🗺️ ' + escapeHtml(p.address) + '</span>' : '') +
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
      // Server re-runs validateSubmission on the payload, which requires the
      // contact fields. submitter_email lives at row level (not in payload),
      // so merge it back in along with the row-level submitter_name fallback
      // so a payload-only edit still validates after the form-required-fields
      // change.
      const merged = Object.assign(
        {},
        orig && orig.payload,
        {
          submitter_email: (orig && orig.submitter_email) || '',
          submitter_name: (orig && orig.submitter_name) || ''
        },
        updates
      );
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

    // Override panel toggle. Hidden by default since the unified login flow
    // means most operators never need to touch it.
    const cfgToggle = $('#submissions-config-toggle');
    const cfgPanel = $('#submissions-config');
    if (cfgToggle && cfgPanel) {
      cfgToggle.addEventListener('click', () => {
        cfgPanel.hidden = !cfgPanel.hidden;
        cfgToggle.textContent = cfgPanel.hidden
          ? 'Override API / token…'
          : 'Hide override';
      });
    }

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
        const { token } = resolveAuth();
        if (token) loadSubmissions();
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
