/* track.js — GA4 click events, loaded on every public page.
 *
 * Sponsors and venues pay for clicks, so we record the ones they care
 * about: event detail clicks, sponsor clicks, and subscribe clicks. One
 * delegated listener covers both the server-rendered pages and the
 * homepage list that docs/app.js re-renders.
 */
(function () {
  'use strict';
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a || typeof window.gtag !== 'function') return;
    var href = a.getAttribute('href') || '';
    if (a.classList.contains('sponsor-cta')) {
      window.gtag('event', 'sponsor_click', { link_url: href });
    } else if (a.closest('.event-entry, .page-actions')) {
      window.gtag('event', 'event_click', { link_url: href, link_text: a.textContent.trim().slice(0, 100) });
    } else if (href.indexOf('#subscribe') !== -1) {
      window.gtag('event', 'subscribe_click');
    } else if (href.indexOf('/advertise') === 0) {
      window.gtag('event', 'advertise_click');
    } else if (a.getAttribute('data-track')) {
      window.gtag('event', a.getAttribute('data-track'), { link_url: href });
    }
  });

  // "Share or copy link" on event pages: the phone's share sheet when
  // there is one, otherwise copy the link to the clipboard.
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-share-url]') : null;
    if (!btn) return;
    var url = btn.getAttribute('data-share-url');
    var text = btn.getAttribute('data-share-text') || '';
    if (typeof window.gtag === 'function') window.gtag('event', 'share_native', { link_url: url });
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
