// Admin UI helpers: confirmation prompts, monitor-type dependent fields, and bar tooltips.
(function () {
  'use strict';

  document.addEventListener('submit', function (e) {
    var msg = e.target.getAttribute && e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  var type = document.getElementById('type-select');
  if (type) {
    var groups = {
      'f-port': ['tcp'],
      'f-method': ['http'],
      'f-status': ['http'],
      'f-keyword': ['http'],
      'f-http-flags': ['http'],
    };
    var sync = function () {
      Object.keys(groups).forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.hidden = groups[id].indexOf(type.value) === -1;
      });
    };
    type.addEventListener('change', sync);
    sync();
  }

  // Simple native tooltips for admin history bars.
  Array.prototype.forEach.call(document.querySelectorAll('.bars-admin [data-tip]'), function (el) {
    el.title = el.getAttribute('data-tip');
  });
})();
