/* docs/turnstile.js — Cloudflare Turnstile for the public forms.
 *
 * Forms marked data-turnstile get an invisible check ("interaction-only":
 * real people almost never see it; Cloudflare only shows a box when it's
 * unsure). The widget loads the first time someone focuses a field, so pages
 * stay light. Turnstile adds a hidden cf-turnstile-response field to the form,
 * which regular form posts send as-is; fetch-based forms call
 * vicTurnstile.token(form). With no site key configured this does nothing and
 * the server skips the check too.
 */
(function () {
  if (window.vicTurnstile) return;
  var cfg = null, cfgP = null, scriptP = null;

  function config() {
    if (cfgP) return cfgP;
    cfgP = fetch('/api/config').then(function (r) { return r.json(); })
      .then(function (c) { cfg = c || {}; return cfg; })
      .catch(function () { cfg = {}; return cfg; });
    return cfgP;
  }

  function loadScript() {
    if (scriptP) return scriptP;
    scriptP = new Promise(function (resolve) {
      if (window.turnstile && window.turnstile.render) return resolve();
      window.__vicTsLoaded = resolve;
      var s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__vicTsLoaded&render=explicit';
      s.async = true;
      document.head.appendChild(s);
    });
    return scriptP;
  }

  function mount(form) {
    if (form.__vicTs) return form.__vicTs;
    form.__vicTs = config().then(function (c) {
      if (!c.turnstile_site_key) return null;
      return loadScript().then(function () {
        var box = document.createElement('div');
        box.className = 'ts-mount';
        var btn = form.querySelector('[type=submit]');
        form.insertBefore(box, btn || null);
        return new Promise(function (resolve) {
          var state = { token: '', waiters: [] };
          state.id = window.turnstile.render(box, {
            sitekey: c.turnstile_site_key,
            appearance: 'interaction-only',
            callback: function (t) { state.token = t; state.waiters.splice(0).forEach(function (w) { w(t); }); },
            'expired-callback': function () { state.token = ''; },
            'error-callback': function () { state.token = ''; }
          });
          resolve(state);
        });
      });
    });
    return form.__vicTs;
  }

  // Resolves with the token ('' when Turnstile is off), waiting briefly for
  // Cloudflare to finish if needed.
  function token(form) {
    return mount(form).then(function (state) {
      if (!state) return '';
      if (state.token) return state.token;
      return new Promise(function (resolve) {
        state.waiters.push(resolve);
        setTimeout(function () { resolve(state.token || ''); }, 10000);
      });
    });
  }

  function reset(form) {
    if (form.__vicTs) form.__vicTs.then(function (s) {
      if (s && window.turnstile) { s.token = ''; window.turnstile.reset(s.id); }
    });
  }

  document.addEventListener('focusin', function (e) {
    var f = e.target && e.target.closest && e.target.closest('form[data-turnstile]');
    if (f) mount(f);
  });

  // Regular (non-fetch) forms: hold the submit until the token is in.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f.matches || !f.matches('form[data-turnstile]:not([data-turnstile=fetch])') || f.__vicTsReady) return;
    e.preventDefault();
    token(f).then(function () { f.__vicTsReady = true; f.submit(); });
  }, true);

  window.vicTurnstile = { token: token, reset: reset };
})();
