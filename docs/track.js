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
    }
  });
})();
