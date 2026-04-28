/* submit.js — Public event submission flow.
 *
 * Loads /api/config to discover whether Cloudflare Turnstile is required, and
 * if so injects the widget. Honeypot field + form-completion timer + a single
 * POST to /api/submissions handle the rest. The server is the source of truth
 * for validation, dedupe, rate limiting, and Turnstile verification — this
 * file is just a friendly UX layer.
 */
(function () {
  'use strict';

  const API_BASE = ''; // same-origin
  const FORM_LOAD_TS = Date.now();
  let turnstileToken = null;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function showFieldError(name, msg) {
    const el = document.querySelector(`[data-error-for="${name}"]`);
    if (el) el.textContent = msg || '';
  }
  function clearFieldErrors() {
    $$('.field-error').forEach(el => { el.textContent = ''; });
    const fe = $('#form-error');
    if (fe) { fe.textContent = ''; fe.hidden = true; }
  }
  function showFormError(msg) {
    const fe = $('#form-error');
    if (!fe) return;
    fe.textContent = msg;
    fe.hidden = false;
  }

  // Load Cloudflare Turnstile script and render the widget if a site key is
  // configured. Stores the resulting token via setTurnstileToken().
  function setTurnstileToken(t) { turnstileToken = t; }

  function injectTurnstile(siteKey) {
    if (!siteKey) return;
    if (window.turnstile && window.turnstile.render) {
      renderTurnstile(siteKey);
      return;
    }
    // Cloudflare exposes turnstile.render once the loader script is in.
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__vic361TsReady';
    s.async = true; s.defer = true;
    window.__vic361TsReady = function () { renderTurnstile(siteKey); };
    document.head.appendChild(s);
  }

  function renderTurnstile(siteKey) {
    if (!window.turnstile || !window.turnstile.render) return;
    const mount = $('#f-turnstile');
    if (!mount) return;
    window.turnstile.render(mount, {
      sitekey: siteKey,
      callback: token => setTurnstileToken(token),
      'error-callback': () => setTurnstileToken(null),
      'expired-callback': () => setTurnstileToken(null)
    });
  }

  async function loadConfig() {
    try {
      const res = await fetch(API_BASE + '/api/config', { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) { return null; }
  }

  function collectIcons() {
    return $$('input[name="icons"]:checked').map(el => el.value);
  }

  function collectForm() {
    const get = name => {
      const el = document.querySelector(`[name="${name}"]`);
      return el ? el.value : '';
    };
    const free = (document.querySelector('input[name="free"]:checked') || {}).value === 'true';
    const submitter_kind = (document.querySelector('input[name="submitter_kind"]:checked') || {}).value || 'other';
    return {
      name: get('name'),
      date: get('date'),
      time: get('time'),
      end_time: get('end_time'),
      venue: get('venue'),
      address: get('address'),
      url: get('url'),
      description: get('description'),
      icons: collectIcons(),
      free,
      submitter_kind,
      submitter_name: get('submitter_name'),
      submitter_email: get('submitter_email'),
      company: get('company'),
      elapsed_ms: Date.now() - FORM_LOAD_TS,
      turnstile_token: turnstileToken
    };
  }

  async function handleSubmit(e) {
    e.preventDefault();
    clearFieldErrors();
    const btn = $('#submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

    const body = collectForm();
    let res, json;
    try {
      res = await fetch(API_BASE + '/api/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      json = await res.json().catch(() => null);
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Submit for review'; }
      showFormError('Could not reach the server. Try again in a moment.');
      return;
    }

    if (!res.ok || !json || json.ok === false) {
      if (btn) { btn.disabled = false; btn.textContent = 'Submit for review'; }
      if (json && json.errors) {
        for (const k of Object.keys(json.errors)) showFieldError(k, json.errors[k]);
        showFormError('Please fix the highlighted fields.');
      } else if (json && json.error === 'turnstile-failed') {
        showFormError('We couldn\'t verify you aren\'t a bot. Try the challenge again.');
        if (window.turnstile && window.turnstile.reset) window.turnstile.reset();
      } else if (res.status === 429) {
        showFormError('Too many submissions from your network. Try again later.');
      } else {
        showFormError('Something went wrong. Please try again.');
      }
      return;
    }

    // Success branch.
    const card = $('#form-card');
    const thanks = $('#thanks-card');
    if (card) card.hidden = true;
    if (thanks) {
      thanks.hidden = false;
      const msg = $('#thanks-message');
      if (json.duplicate && msg) {
        msg.textContent = 'Looks like a matching submission was already in our queue. We\'ll review it soon.';
      } else if (json.queued === false && msg) {
        msg.textContent = 'Got it — we\'ll take a look.';
      }
    }
  }

  function wireResetForAnother() {
    const btn = $('#submit-another');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const card = $('#form-card');
      const thanks = $('#thanks-card');
      const form = $('#submit-form');
      if (form) form.reset();
      clearFieldErrors();
      if (window.turnstile && window.turnstile.reset) window.turnstile.reset();
      setTurnstileToken(null);
      if (card) card.hidden = false;
      if (thanks) thanks.hidden = true;
      const subBtn = $('#submit-btn');
      if (subBtn) { subBtn.disabled = false; subBtn.textContent = 'Submit for review'; }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  async function init() {
    const form = $('#submit-form');
    if (form) form.addEventListener('submit', handleSubmit);
    wireResetForAnother();

    // Pre-fill date with today (local) so users don't have to pick a year first.
    const dateEl = $('#f-date');
    if (dateEl && !dateEl.value) {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      dateEl.value = `${y}-${m}-${day}`;
    }

    const cfg = await loadConfig();
    if (cfg && cfg.turnstile_site_key) {
      injectTurnstile(cfg.turnstile_site_key);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Test hook — exposes the form collector + token setter for jsdom tests.
  if (typeof window !== 'undefined') {
    window.__vic361Submit = {
      collectForm, setTurnstileToken, FORM_LOAD_TS
    };
  }
})();
