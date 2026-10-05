/* server/metaPixel.js — Meta (Facebook/Instagram) Pixel for running ads.
 *
 * Why a served script instead of a snippet in each page: the pixel ID lives
 * in a Railway variable (META_PIXEL_ID), and the public pages come from three
 * places (docs/index.html, the server-rendered layout in seo.js, and static
 * pages). Each one loads /pixel.js; the server fills in the ID, or sends an
 * empty script while it's unset, so nothing loads from Meta until the owner
 * turns it on.
 *
 * The pixel reports PageView on load. docs/track.js reports Lead when a
 * newsletter signup goes through, so ads can optimize for signups.
 */

// Pixel IDs are numeric. Anything else is a typo in Railway and is ignored
// rather than written into a script.
export function pixelId(raw) {
  const v = String(raw || '').trim();
  return /^\d{5,20}$/.test(v) ? v : null;
}

export function metaPixelJs(id) {
  if (!id) return '/* Meta Pixel off: set META_PIXEL_ID to turn it on. */\n';
  // Same visits track.js skips: a browser signed into the admin, the admin
  // preview, and the private social kit page. Counting the owner would
  // teach Meta that the owner is the audience.
  return `(function () {
  var skip = false;
  try { skip = !!localStorage.getItem('vic361_admin_session'); } catch (e) { /* storage blocked */ }
  if (/[?&]previewKey=/.test(location.search) || location.pathname.indexOf('/social/') === 0) skip = true;
  if (skip) return;
  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
  n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
  document,'script','https://connect.facebook.net/en_US/fbevents.js');
  fbq('init', '${id}');
  fbq('track', 'PageView');
})();
`;
}
