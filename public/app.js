// Tooltips: plain text for help icons ([data-tip]), and a day breakdown for history bars
// ([data-day], JSON from src/views/public.js). Hover, keyboard focus, and tap on mobile.
(function () {
  'use strict';
  var tip = document.getElementById('tooltip');
  if (!tip) return;
  var current = null;
  var hideTimer = null;
  var shownAt = 0;
  var TARGETS = '[data-tip], [data-day]';

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  function dayContent(day) {
    var frag = document.createDocumentFragment();
    var head = el('div', 'day-head');
    head.appendChild(el('strong', null, day.d));
    if (day.u) head.appendChild(el('span', 'day-uptime', day.u + ' uptime'));
    frag.appendChild(head);
    if (day.n) frag.appendChild(el('p', 'day-note', day.n));
    var measured = false;
    (day.r || []).forEach(function (row) {
      var line = el('div', 'day-row');
      line.appendChild(el('span', 'day-label', row[0] + (row[3] ? '*' : '')));
      line.appendChild(el('span', 'day-num', plural(row[1], 'hr')));
      line.appendChild(el('span', 'day-num', plural(row[2], 'min')));
      frag.appendChild(line);
      if (row[3]) measured = true;
    });
    if (measured) frag.appendChild(el('p', 'day-foot', '* estimated from failed and slow checks'));
    if (day.i && day.i.length) {
      frag.appendChild(el('div', 'day-section', 'Related'));
      day.i.forEach(function (inc) {
        var a = el('a', 'day-link', inc[1]);
        a.href = '/incidents/' + Number(inc[0]);
        frag.appendChild(a);
      });
    }
    return frag;
  }

  function show(target) {
    clearTimeout(hideTimer);
    if (target === current && !tip.hidden) return;
    var raw = target.getAttribute('data-day');
    tip.textContent = '';
    if (raw) {
      try {
        tip.appendChild(dayContent(JSON.parse(raw)));
      } catch (err) {
        return;
      }
      tip.className = 'tooltip tooltip-day';
    } else {
      var text = target.getAttribute('data-tip');
      if (!text) return;
      tip.textContent = text;
      tip.className = 'tooltip';
    }
    current = target;
    shownAt = Date.now();
    tip.hidden = false;
    var r = target.getBoundingClientRect();
    var tw = tip.offsetWidth;
    var th = tip.offsetHeight;
    var center = r.left + r.width / 2;
    var left = Math.min(Math.max(8, center - tw / 2), window.innerWidth - tw - 8);
    var below = r.top - th - 10 < 8;
    tip.style.left = left + 'px';
    tip.style.top = (below ? r.bottom + 10 : r.top - th - 10) + 'px';
    tip.classList.toggle('tooltip-below', below);
    tip.style.setProperty('--arrow-x', Math.min(Math.max(12, center - left), tw - 12) + 'px');
  }
  function hide() {
    clearTimeout(hideTimer);
    current = null;
    tip.hidden = true;
  }
  // A short delay lets the pointer travel from a bar into the popup to click a link.
  function hideSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 150);
  }

  document.addEventListener('mouseover', function (e) {
    if (tip.contains(e.target)) return clearTimeout(hideTimer);
    var target = e.target.closest(TARGETS);
    if (target) show(target);
    else if (current) hideSoon();
  });
  document.addEventListener('focusin', function (e) {
    var target = e.target.closest(TARGETS);
    if (target) show(target);
  });
  document.addEventListener('focusout', function (e) {
    if (!tip.contains(e.relatedTarget)) hideSoon();
  });
  document.addEventListener('click', function (e) {
    if (tip.contains(e.target)) return;
    var target = e.target.closest(TARGETS);
    // A tap fires mouseover and then click; don't let the click close what the tap just opened.
    if (target && target === current && Date.now() - shownAt < 600) return;
    if (target && target !== current) show(target);
    else hide();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hide();
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
        if (next.hasAttribute('data-now')) current.setAttribute('data-now', next.getAttribute('data-now'));
        if (window.signalpostTick) window.signalpostTick();
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
