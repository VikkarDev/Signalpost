// Admin page helpers.
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

  // Column names as data-label, so tables can collapse into cards on small screens (see style.css).
  Array.prototype.forEach.call(document.querySelectorAll('table.table'), function (table) {
    if (!table.tHead) return;
    var names = Array.prototype.map.call(table.tHead.rows[0].cells, function (th) {
      return th.textContent.trim();
    });
    Array.prototype.forEach.call(table.tBodies, function (body) {
      Array.prototype.forEach.call(body.rows, function (row) {
        Array.prototype.forEach.call(row.cells, function (td, i) {
          if (names[i]) td.setAttribute('data-label', names[i]);
        });
      });
    });
  });

  // Native tooltips for admin history bars.
  Array.prototype.forEach.call(document.querySelectorAll('.bars-admin [data-tip]'), function (el) {
    el.title = el.getAttribute('data-tip');
  });
})();
