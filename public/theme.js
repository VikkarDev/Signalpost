// Theme switcher (auto -> light -> dark). Loaded in <head> without defer so the page never flashes the wrong theme.
(function () {
  'use strict';
  var KEY = 'signalpost-theme';
  var root = document.documentElement;

  function read() {
    try {
      var v = window.localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'auto';
    } catch (e) {
      return 'auto';
    }
  }
  function apply(mode) {
    if (mode === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
  }
  var current = read();
  apply(current);

  var ICONS = {
    auto: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm0 1.5v13a6.5 6.5 0 0 0 0-13Z"/></svg>',
    light: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-1.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm5.657-8.157a.75.75 0 0 1 0 1.061l-1.061 1.06a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l1.06-1.06a.75.75 0 0 1 1.06 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 1 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0ZM8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0ZM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8Zm13 0a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8Zm-8 5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13Zm3.536-1.464a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061ZM2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-1.06-1.06a.75.75 0 0 1 0-1.06Z"/></svg>',
    dark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M9.598 1.591a.749.749 0 0 1 .785-.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.046-7.046.75.75 0 0 1 .175-.786Zm1.616 1.945a7 7 0 0 1-7.678 7.678 5.499 5.499 0 1 0 7.678-7.678Z"/></svg>',
  };
  var LABELS = { auto: 'system', light: 'light', dark: 'dark' };
  var NEXT = { auto: 'light', light: 'dark', dark: 'auto' };

  function render(btn, mode) {
    btn.innerHTML = ICONS[mode];
    btn.setAttribute('aria-label', 'Theme: ' + LABELS[mode]);
    btn.title = 'Theme: ' + LABELS[mode];
  }

  document.addEventListener('DOMContentLoaded', function () {
    var buttons = document.querySelectorAll('.theme-toggle');
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.hidden = false;
      render(btn, current);
      btn.addEventListener('click', function () {
        var mode = (current = NEXT[current]);
        try {
          if (mode === 'auto') window.localStorage.removeItem(KEY);
          else window.localStorage.setItem(KEY, mode);
        } catch (e) {
          /* storage unavailable: the choice still applies to this page view */
        }
        apply(mode);
        Array.prototype.forEach.call(buttons, function (b) {
          render(b, mode);
        });
      });
    });
  });
})();
