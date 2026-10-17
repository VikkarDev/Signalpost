// Keeps "checked 12s ago" style times ticking in the browser.
// Elements: <time class="ago" datetime="ISO" data-prefix="checked " data-late-after="ms">.
// The server's clock comes from data-now on <main>, so a wrong local clock doesn't matter.
(function () {
  'use strict';
  var offset = 0;

  function syncClock() {
    var main = document.querySelector('main[data-now]');
    var serverNow = main && Number(main.getAttribute('data-now'));
    if (serverNow) offset = serverNow - Date.now();
  }

  function format(ms) {
    var s = Math.round(ms / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 48) return h + ' h ago';
    return Math.round(h / 24) + ' days ago';
  }

  function tick() {
    var now = Date.now() + offset;
    Array.prototype.forEach.call(document.querySelectorAll('time.ago[datetime]'), function (el) {
      var t = Date.parse(el.getAttribute('datetime'));
      if (!t) return;
      var text = (el.getAttribute('data-prefix') || '') + format(now - t);
      if (el.textContent !== text) el.textContent = text;
      // A check that should have happened by now but didn't: the monitor may be stuck.
      var lateAfter = Number(el.getAttribute('data-late-after'));
      if (lateAfter) el.classList.toggle('late', now - t > lateAfter);
    });
  }

  // The live page refresh swaps <main>; pick up the new server time when that happens.
  window.signalpostTick = function () {
    syncClock();
    tick();
  };

  syncClock();
  tick();
  setInterval(tick, 1000);
})();
