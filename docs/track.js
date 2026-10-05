/* track.js — page view and click tracking, loaded on every public page.
 *
 * Each event goes two places: Google Analytics (when it loaded) and our own
 * /api/track beacon, which feeds the admin Traffic tab. Sponsors and venues
 * pay for clicks, so we record the ones they care about: event detail
 * clicks, sponsor clicks, subscribe clicks. One delegated listener covers
 * both the server-rendered pages and the homepage list app.js re-renders.
 */
(function () {
  'use strict';

  // Don't count the site owner: a browser signed into the admin, the admin
  // preview iframe, and the private social kit page.
  var skip = false;
  try { skip = !!localStorage.getItem('vic361_admin_session'); } catch (e) { /* storage blocked */ }
  if (/[?&]previewKey=/.test(location.search) || location.pathname.indexOf('/social/') === 0) skip = true;

  function beacon(data) {
    if (skip) return;
    data.path = location.pathname;
    var body = JSON.stringify(data);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }))) return;
    } catch (e) { /* fall through to fetch */ }
    try {
      fetch('/api/track', { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'application/json' } });
    } catch (e) { /* tracking must never break the page */ }
  }

  // Signup forms report subscribe_click with link_url 'form' or 'list-card'
  // once /api/subscribe accepts the email; plain #subscribe links don't.
  // That success is the Lead that Meta ads optimize for (server/metaPixel.js).
  var SIGNUP_DONE = { form: 1, 'list-card': 1 };

  function track(type, params) {
    if (typeof window.gtag === 'function') window.gtag('event', type, params || {});
    if (type === 'subscribe_click' && params && SIGNUP_DONE[params.link_url] && typeof window.fbq === 'function') {
      window.fbq('track', 'Lead');
    }
    beacon({ kind: 'click', type: type, url: (params && params.link_url) || '' });
  }
  window.vic361Track = track;  // app.js filter chips report through this

  // utm_medium=paid marks a tap on an ad (server/analytics.js paidSource).
  var utm = '', utmMedium = '';
  try {
    var q = new URLSearchParams(location.search);
    utm = q.get('utm_source') || '';
    utmMedium = q.get('utm_medium') || '';
  } catch (e) { /* old browser */ }
  beacon({ kind: 'view', ref: document.referrer || '', utm: utm, utm_medium: utmMedium });

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (a.classList.contains('sponsor-cta')) {
      track('sponsor_click', { link_url: href });
    } else if (a.closest('.event-entry, .page-actions')) {
      track('event_click', { link_url: href, link_text: a.textContent.trim().slice(0, 100) });
    } else if (href.indexOf('#subscribe') !== -1) {
      track('subscribe_click');
    } else if (href.indexOf('/advertise') === 0) {
      track('advertise_click', { link_url: href });
    } else if (a.getAttribute('data-track')) {
      track(a.getAttribute('data-track'), { link_url: href });
    }
  });

  // "Share or copy link" on event pages: the phone's share sheet when
  // there is one, otherwise copy the link to the clipboard.
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-share-url]') : null;
    if (!btn) return;
    var url = btn.getAttribute('data-share-url');
    var text = btn.getAttribute('data-share-text') || '';
    track('share_native', { link_url: url });
    if (navigator.share) {
      navigator.share({ title: text, text: text, url: url }).catch(function () {});  // user closed the sheet
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () {
        btn.textContent = 'Link copied';
      }, function () { window.prompt('Copy this link:', url); });
    } else {
      window.prompt('Copy this link:', url);
    }
  });
})();
