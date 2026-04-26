/* app.js — The Vic 361 */

(function () {
  'use strict';

  // ─── ICON MAP ───
  const ICON_MAP = {
    food:      '🍔',
    music:     '🎵',
    family:    '🧑‍🧑‍🧒',
    drinks:    '🍺',
    arts:      '🎨',
    shopping:  '🛍️',
    outdoors:  '🏃',
    community: '📣',
    free:      '🆓'
  };

  // ─── DARK MODE TOGGLE ───
  const toggle = document.querySelector('[data-theme-toggle]');
  const root = document.documentElement;
  let currentTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.setAttribute('data-theme', currentTheme);
  updateToggleIcon();

  if (toggle) {
    toggle.addEventListener('click', function () {
      currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', currentTheme);
      toggle.setAttribute('aria-label', 'Switch to ' + (currentTheme === 'dark' ? 'light' : 'dark') + ' mode');
      updateToggleIcon();
    });
  }

  function updateToggleIcon() {
    if (!toggle) return;
    if (currentTheme === 'dark') {
      toggle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
    } else {
      toggle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    }
  }

  // ─── STICKY HEADER SHADOW ───
  const header = document.getElementById('site-header');
  window.addEventListener('scroll', function () {
    if (window.scrollY > 10) {
      header.classList.add('scrolled');
    } else {
      header.classList.remove('scrolled');
    }
  }, { passive: true });

  // ─── DATE HELPERS ───
  function toLocalDateStr(date) {
    // Returns YYYY-MM-DD in local time
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function formatDayName(date) {
    return date.toLocaleDateString('en-US', { weekday: 'long' });
  }

  function formatMonthDay(date) {
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  }

  function isToday(dateStr) {
    return dateStr === toLocalDateStr(new Date());
  }

  // ─── RENDER ICONS ───
  function renderIcons(icons) {
    if (!icons || !icons.length) return '';
    return icons
      .map(function (key) { return ICON_MAP[key] || ''; })
      .filter(Boolean)
      .join(' ');
  }

  // ─── RENDER SINGLE EVENT ───
  function renderEvent(ev) {
    var iconHtml = renderIcons(ev.icons);
    var nameHtml = ev.url
      ? '<a href="' + ev.url + '" target="_blank" rel="noopener noreferrer">' + escHtml(ev.name) + '</a>'
      : escHtml(ev.name);

    var venuePart = '';
    if (ev.venue) {
      venuePart = ev.url
        ? '<a href="' + ev.url + '" target="_blank" rel="noopener noreferrer">' + escHtml(ev.venue) + '</a>'
        : escHtml(ev.venue);
      if (ev.address) {
        venuePart += ', ' + escHtml(ev.address);
      }
    }

    var freeBadge = '';

    var descHtml = ev.description
      ? '<div class="event-desc">' + escHtml(ev.description) + '</div>'
      : '';

    return '<li class="event-entry">' +
      '<span class="event-icons" aria-hidden="true">' + iconHtml + '</span>' +
      '<div class="event-details">' +
        '<span class="event-time">' + escHtml(ev.time) + '</span> ' +
        '<span class="event-name">' + nameHtml + '</span>' +
        (venuePart ? ' — <span class="event-venue">' + venuePart + '</span>' : '') +
        freeBadge +
        descHtml +
      '</div>' +
    '</li>';
  }

  // ─── RENDER DAY SECTION ───
  function renderDaySection(date, events, idx) {
    var dateStr = toLocalDateStr(date);
    var today = isToday(dateStr);
    var dayName = formatDayName(date);
    var monthDay = formatMonthDay(date);

    var todayBadgeHtml = today ? ' <span class="today-badge">Today</span>' : '';

    var eventsForDay = events.filter(function (e) { return e.date === dateStr; });
    // Sort by time ascending (events without time go last)
    eventsForDay.sort(function(a, b) {
      var ta = a.time || 'ZZ', tb = b.time || 'ZZ';
      // Normalize AM/PM times for comparison
      function toMins(t) {
        var m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
        if (!m) return 9999;
        var h = parseInt(m[1]), min = parseInt(m[2]), ampm = m[3].toUpperCase();
        if (ampm === 'PM' && h !== 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;
        return h * 60 + min;
      }
      return toMins(ta) - toMins(tb);
    });

    var bodyHtml;
    if (eventsForDay.length === 0) {
      bodyHtml = '<div class="empty-state">Nothing listed yet — know something happening? <a href="#submit">Submit an event.</a></div>';
    } else {
      bodyHtml = '<ul class="event-list" role="list">' +
        eventsForDay.map(renderEvent).join('') +
      '</ul>';
    }

    return '<section class="day-section" id="day-' + idx + '">' +
      '<div class="day-header">' +
        '<h2 class="day-name">' + dayName + todayBadgeHtml + '</h2>' +
        '<span class="day-date">' + monthDay + '</span>' +
      '</div>' +
      bodyHtml +
    '</section>';
  }

  // ─── RENDER NEW & NOTABLE ───
  function renderNotable(items) {
    if (!items || !items.length) return '';
    return items.map(function (item) {
      var icon = ICON_MAP[item.icon] || '📌';
      var tagClass = item.tag === 'new' ? 'badge--new' : 'badge--coming';
      var tagText = item.tag === 'new' ? 'NEW' : 'COMING';
      return '<li class="notable-entry">' +
        '<span class="notable-icon" aria-hidden="true">' + icon + '</span>' +
        '<div class="notable-details">' +
          '<span class="badge ' + tagClass + '">' + tagText + '</span> ' +
          '<span class="notable-name">' + escHtml(item.name) + '</span>' +
          '<div class="notable-desc">' + escHtml(item.description) + '</div>' +
        '</div>' +
      '</li>';
    }).join('');
  }

  // ─── RENDER SPONSOR ───
  function renderSponsor(sponsor) {
    if (!sponsor) return '';
    var ctaHtml = '';
    if (sponsor.cta) {
      if (sponsor.url) {
        ctaHtml = '<a href="' + sponsor.url + '" class="btn btn--outline" target="_blank" rel="noopener noreferrer">' + escHtml(sponsor.cta) + '</a>';
      } else {
        ctaHtml = '<span class="btn btn--outline" style="cursor:default; opacity:0.6">' + escHtml(sponsor.cta) + '</span>';
      }
    }
    return '<div class="sponsor-block">' +
      '<div class="sponsor-label">This week\'s sponsor</div>' +
      '<div class="sponsor-name">' + escHtml(sponsor.name) + '</div>' +
      '<div class="sponsor-text">' + escHtml(sponsor.text) + '</div>' +
      (sponsor.address ? '<div class="sponsor-address">📍 ' + escHtml(sponsor.address) + '</div>' : '') +
      ctaHtml +
    '</div>';
  }

  // ─── HTML ESCAPE ───
  function escHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── PREVIEW MODE ───
  // Admin's Preview tab loads this page in an iframe. Two preview transports
  // are supported:
  //   1. ?previewKey=<key>  — events stored in sessionStorage under
  //      'vic361_preview_<key>'. Preferred: keeps the URL short even with
  //      many picks.
  //   2. ?preview=<json>     — legacy inline JSON blob. Kept for backwards
  //      compatibility, but admin no longer generates these URLs.
  var PREVIEW_STORAGE_PREFIX = 'vic361_preview_';

  function readPreviewData() {
    try {
      var params = new URLSearchParams(window.location.search);
      var key = params.get('previewKey');
      if (key) {
        var storageKey = PREVIEW_STORAGE_PREFIX + key;
        var raw = null;
        try { raw = sessionStorage.getItem(storageKey); } catch (e) {}
        if (!raw) {
          try { raw = localStorage.getItem(storageKey); } catch (e) {}
        }
        if (raw) return JSON.parse(raw);
      }
      var inline = params.get('preview');
      if (inline) return JSON.parse(decodeURIComponent(inline));
    } catch (err) {
      console.error('Failed to read preview data:', err);
    }
    return null;
  }

  function showPreviewIndicator() {
    if (document.getElementById('vic361-preview-banner')) return;
    var banner = document.createElement('div');
    banner.id = 'vic361-preview-banner';
    banner.textContent = 'Preview mode — showing unpublished admin picks';
    banner.setAttribute('role', 'status');
    banner.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0',
      'background:#2d5b8a', 'color:#fff',
      'font:600 12px/1.4 system-ui, sans-serif',
      'text-align:center', 'padding:6px 12px',
      'z-index:9999', 'letter-spacing:0.02em',
      'box-shadow:0 1px 4px rgba(0,0,0,0.2)'
    ].join(';');
    document.body.appendChild(banner);
    document.body.style.paddingTop = (banner.offsetHeight || 28) + 'px';
  }

  // ─── MAIN LOAD ───
  function loadAndRender() {
    var previewData = readPreviewData();
    var dataPromise;
    if (previewData) {
      showPreviewIndicator();
      dataPromise = Promise.resolve(previewData);
    } else {
      dataPromise = fetch('./events.json').then(function (res) { return res.json(); });
    }
    dataPromise
      .then(function (data) {
        var container = document.getElementById('events-container');
        var notableList = document.getElementById('notable-list');
        var sponsorSection = document.getElementById('sponsor-section');
        var lastUpdatedEl = document.getElementById('last-updated');

        // Last updated
        if (data.last_updated && lastUpdatedEl) {
          var d = new Date(data.last_updated);
          lastUpdatedEl.textContent = 'Last updated: ' + d.toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
          }) + ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }

        // Build Mon–Sun of the current week
        var today = new Date();
        today.setHours(0, 0, 0, 0);
        var dayOfWeek = today.getDay(); // 0=Sun, 1=Mon … 6=Sat
        var daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        var monday = new Date(today);
        monday.setDate(today.getDate() - daysFromMonday);

        var days = [];
        for (var i = 0; i < 7; i++) {
          var d = new Date(monday);
          d.setDate(monday.getDate() + i);
          days.push(d);
        }

        var html = days.map(function (date, idx) {
          return renderDaySection(date, data.events || [], idx);
        }).join('');

        container.innerHTML = html;

        // ─── SKIP TO TODAY BUTTON ───
        var todayStr = toLocalDateStr(new Date());
        var todayIdx = -1;
        days.forEach(function (d, i) {
          if (toLocalDateStr(d) === todayStr) todayIdx = i;
        });
        // Show button whenever today isn't Monday (idx 0)
        if (todayIdx > 0) {
          var skipBar = document.getElementById('skip-today-bar');
          if (skipBar) {
            var btn = document.createElement('button');
            btn.className = 'btn btn--primary skip-today-btn';
            btn.textContent = '↓ Skip to Today';
            btn.addEventListener('click', function () {
              var sec = document.getElementById('day-' + todayIdx);
              if (sec) {
                var stickyHeader = document.getElementById('site-header');
                var stickyLegend = document.querySelector('.icon-legend');
                var stickyHeight = (stickyHeader ? stickyHeader.offsetHeight : 0) +
                                   (stickyLegend ? stickyLegend.offsetHeight : 0) + 8;
                var offset = sec.getBoundingClientRect().top + window.pageYOffset - stickyHeight;
                window.scrollTo({ top: offset, behavior: 'smooth' });
              }
            });
            skipBar.appendChild(btn);
            skipBar.style.display = 'block';
          }
        }

        // New & Notable
        if (notableList) {
          notableList.innerHTML = renderNotable(data.new_and_notable);
        }

        // Sponsor
        if (sponsorSection) {
          sponsorSection.innerHTML = renderSponsor(data.sponsor);
        }
      })
      .catch(function (err) {
        console.error('Failed to load events:', err);
        document.getElementById('events-container').innerHTML =
          '<p class="empty-state">Could not load events. Please try again later.</p>';
      });
  }

  // Expose a small surface for tests.
  if (typeof window !== 'undefined') {
    window.__vic361App = {
      readPreviewData: readPreviewData,
      showPreviewIndicator: showPreviewIndicator,
      PREVIEW_STORAGE_PREFIX: PREVIEW_STORAGE_PREFIX
    };
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadAndRender);
  } else {
    loadAndRender();
  }

})();
