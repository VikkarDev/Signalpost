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
