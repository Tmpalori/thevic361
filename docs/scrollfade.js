/* docs/scrollfade.js — sideways-scrolling chip rows (the browse links,
 * the homepage filters) fade at an edge while there's more to scroll
 * that way, so it's obvious they scroll. style.css draws the fade from
 * --fade-l / --fade-r; this sets them from the scroll position. Without
 * it the right edge just stays faded. */
(function () {
  var SEL = '.browse-inner, .event-filters';
  function update(el) {
    var max = el.scrollWidth - el.clientWidth;
    el.style.setProperty('--fade-l', el.scrollLeft > 2 ? '36px' : '0px');
    el.style.setProperty('--fade-r', el.scrollLeft < max - 2 ? '36px' : '0px');
  }
  function all() { document.querySelectorAll(SEL).forEach(update); }
  document.addEventListener('scroll', function (e) {
    var t = e.target;
    if (t && t.matches && t.matches(SEL)) update(t);
  }, { capture: true, passive: true });
  window.addEventListener('resize', all, { passive: true });
  window.addEventListener('load', all);
  if (document.readyState !== 'loading') all(); else document.addEventListener('DOMContentLoaded', all);
  // The homepage filter row is built by app.js after load.
  setTimeout(all, 500);
})();
