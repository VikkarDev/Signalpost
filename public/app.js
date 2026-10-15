// Tooltips for history bars and component help icons (hover, keyboard focus, and tap on mobile).
(function () {
  'use strict';
  var tip = document.getElementById('tooltip');
  if (!tip) return;
  var current = null;

  function show(el) {
    var text = el.getAttribute('data-tip');
    if (!text) return;
    current = el;
    tip.textContent = text;
    tip.hidden = false;
    var r = el.getBoundingClientRect();
    var tw = tip.offsetWidth;
    var th = tip.offsetHeight;
    var left = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), window.innerWidth - tw - 8);
    var top = r.top - th - 8;
    if (top < 8) top = r.bottom + 8;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function hide() {
    current = null;
    tip.hidden = true;
  }

  document.addEventListener('mouseover', function (e) {
    var el = e.target.closest('[data-tip]');
    if (el) show(el);
    else if (current) hide();
  });
  document.addEventListener('focusin', function (e) {
    var el = e.target.closest('[data-tip]');
    if (el) show(el);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-tip]');
    if (el && el !== current) show(el);
    else hide();
  });
  window.addEventListener('scroll', hide, { passive: true });
})();

// Live updates: re-fetch the page every N seconds and swap in the new <main>,
// keeping scroll position and which groups are collapsed. Paused while the tab is hidden.
(function () {
  'use strict';
  var seconds = Number(document.body.getAttribute('data-live'));
  if (!seconds || !window.fetch || !window.DOMParser) return;
  var timer = null;
  var busy = false;

  function groupStates() {
    var states = {};
    Array.prototype.forEach.call(document.querySelectorAll('details[data-group]'), function (d) {
      states[d.getAttribute('data-group')] = d.open;
    });
    return states;
  }

  function refresh() {
    if (busy) return;
    busy = true;
    fetch(window.location.pathname, { cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) {
        var doc = new DOMParser().parseFromString(text, 'text/html');
        var next = doc.querySelector('main');
        var current = document.querySelector('main');
        if (!next || !current) return;
        var states = groupStates();
        current.innerHTML = next.innerHTML;
        Array.prototype.forEach.call(current.querySelectorAll('details[data-group]'), function (d) {
          var name = d.getAttribute('data-group');
          if (Object.prototype.hasOwnProperty.call(states, name)) d.open = states[name];
        });
        document.title = doc.title;
        var tip = document.getElementById('tooltip');
        if (tip) tip.hidden = true;
      })
      .catch(function () {
        /* offline or server restarting; try again next round */
      })
      .then(function () {
        busy = false;
        schedule();
      });
  }

  function schedule() {
    clearTimeout(timer);
    if (!document.hidden) timer = setTimeout(refresh, seconds * 1000);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) clearTimeout(timer);
    else refresh();
  });
  schedule();
})();
