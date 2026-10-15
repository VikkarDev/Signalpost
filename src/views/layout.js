import { html, raw } from '../lib/html.js';

export const VERSION = '1.1.0';

export const icons = {
  check: raw('<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>'),
  alert: raw('<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>'),
  x: raw('<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>'),
  tool: raw('<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M5.433 2.304A4.494 4.494 0 0 0 3.5 6c0 1.598.832 3.002 2.09 3.802.518.328.929.923.902 1.64v.008l-.164 3.337a.75.75 0 1 1-1.498-.073l.163-3.33c.002-.085-.05-.216-.207-.316A5.996 5.996 0 0 1 2 6a5.993 5.993 0 0 1 2.567-4.92 1.482 1.482 0 0 1 1.673-.04c.462.296.76.827.76 1.423v2.82c0 .082.041.16.11.206l.75.51a.25.25 0 0 0 .28 0l.75-.51A.249.249 0 0 0 9 5.282V2.463c0-.596.298-1.127.76-1.423a1.482 1.482 0 0 1 1.673.04A5.993 5.993 0 0 1 14 6a5.996 5.996 0 0 1-2.786 5.068c-.157.1-.209.23-.207.315l.163 3.33a.752.752 0 0 1-1.094.714.75.75 0 0 1-.404-.64l-.164-3.345c-.027-.717.384-1.312.902-1.64A4.495 4.495 0 0 0 12.5 6a4.494 4.494 0 0 0-1.933-3.696c-.024.017-.067.067-.067.16v2.818a1.75 1.75 0 0 1-.767 1.448l-.75.51a1.75 1.75 0 0 1-1.966 0l-.75-.51A1.75 1.75 0 0 1 5.5 5.282V2.463c0-.092-.043-.142-.067-.159Z"/></svg>'),
  question: raw('<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.92 6.085h.001a.749.749 0 1 1-1.342-.67c.169-.339.436-.701.849-.977C6.845 4.16 7.369 4 8 4a2.756 2.756 0 0 1 1.637.525c.503.377.863.965.863 1.725 0 .448-.115.83-.329 1.15-.205.307-.47.513-.692.662-.109.072-.22.138-.313.195l-.006.004a6.24 6.24 0 0 0-.26.16.952.952 0 0 0-.276.245.75.75 0 0 1-1.248-.832c.184-.264.42-.489.692-.661.103-.067.207-.132.313-.195l.007-.004c.1-.061.182-.11.258-.161a.969.969 0 0 0 .277-.245C8.96 6.514 9 6.427 9 6.25a.612.612 0 0 0-.262-.525A1.27 1.27 0 0 0 8 5.5c-.369 0-.595.09-.74.187a1.01 1.01 0 0 0-.34.398ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>'),
  dash: raw('<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 8a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 3 8Z"/></svg>'),
};

export const logo = raw(`<svg class="logo-mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
  <rect x="1" y="1" width="30" height="30" rx="8" fill="#1f2328"/>
  <path d="M6 17h5l2.5-6 4 11 2.5-5H26" fill="none" stroke="#3fb950" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`);

// Rendered hidden; theme.js reveals it and fills in the current mode (no-JS visitors just get "auto").
const themeToggle = raw('<button type="button" class="theme-toggle" hidden>Theme</button>');

export function stateIcon(state) {
  switch (state) {
    case 'operational':
      return icons.check;
    case 'degraded':
    case 'partial_outage':
      return icons.alert;
    case 'major_outage':
      return icons.x;
    case 'maintenance':
      return icons.tool;
    default:
      return icons.dash;
  }
}

export function publicLayout({ title, siteName, body, refresh = false, description = '' }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${description ? html`<meta name="description" content="${description}">` : ''}
${refresh ? raw('<meta http-equiv="refresh" content="60">') : ''}
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f6f8fa" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d1117" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<script src="/static/theme.js?v=${VERSION}"></script>
<link rel="stylesheet" href="/static/style.css?v=${VERSION}">
<script src="/static/app.js?v=${VERSION}" defer></script>
</head>
<body class="public">
<header class="hero">
  <div class="hero-art" aria-hidden="true"></div>
  <div class="container hero-inner">
    <a class="brand" href="/">${logo}<span>${siteName}</span></a>
    ${themeToggle}
  </div>
</header>
<main class="container">
${body}
</main>
<footer class="container site-footer">
  <a href="/history">Incident history</a>
  <span aria-hidden="true">·</span>
  <a href="/api/v1/status">JSON API</a>
  <span class="footer-right">Powered by Signalpost</span>
</footer>
<div class="tooltip" id="tooltip" role="tooltip" hidden></div>
</body>
</html>`;
}

const NAV = [
  ['dashboard', '/admin', 'Dashboard'],
  ['monitors', '/admin/monitors', 'Monitors'],
  ['components', '/admin/components', 'Components'],
  ['incidents', '/admin/incidents', 'Incidents'],
  ['maintenance', '/admin/maintenance', 'Maintenance'],
  ['alerts', '/admin/alerts', 'Alerts'],
  ['settings', '/admin/settings', 'Settings'],
];

export function adminLayout({ title, body, user, csrf, active, flash }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} · Signalpost admin</title>
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<script src="/static/theme.js?v=${VERSION}"></script>
<link rel="stylesheet" href="/static/style.css?v=${VERSION}">
<script src="/static/admin.js?v=${VERSION}" defer></script>
</head>
<body class="admin">
<header class="admin-bar">
  <div class="admin-container admin-bar-inner">
    <a class="brand brand-small" href="/admin">${logo}<span>Signalpost</span></a>
    <div class="admin-user">
      ${user ? html`<a href="/" target="_blank" rel="noopener" class="hide-sm">View site</a>` : ''}
      ${themeToggle}
      ${user
        ? html`<form method="post" action="/admin/logout" class="inline">
            <input type="hidden" name="_csrf" value="${csrf}">
            <button type="submit" class="link-button" title="Signed in as ${user.username}">Sign out</button>
          </form>`
        : ''}
    </div>
    ${user
      ? html`<nav class="admin-nav" aria-label="Admin">
          ${NAV.map(([key, href, label]) => html`<a href="${href}"${active === key ? html` class="active" aria-current="page"` : ''}>${label}</a>`)}
        </nav>`
      : ''}
  </div>
</header>
<main class="admin-container admin-main">
${flash ? html`<div class="flash flash-${flash.type}" role="status">${flash.text}</div>` : ''}
${body}
</main>
</body>
</html>`;
}
