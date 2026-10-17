// Small SVG status badges in the usual "label | message" style, for READMEs and websites.

import { escape } from './lib/html.js';

const COLORS = {
  operational: '#2da44e',
  degraded: '#bf8700',
  partial_outage: '#e16f24',
  major_outage: '#cf222e',
  maintenance: '#0969da',
  unknown: '#6e7781',
  none: '#6e7781',
};

const MESSAGES = {
  operational: 'operational',
  degraded: 'degraded',
  partial_outage: 'partial outage',
  major_outage: 'major outage',
  maintenance: 'maintenance',
  unknown: 'no data',
  none: 'no services',
};

// Rough Verdana 11px widths. The SVG pins each text to this length, so it only has to be close.
function textWidth(text) {
  let w = 0;
  for (const ch of text) {
    if ('iljI.,:;|!\'` '.includes(ch)) w += 3.6;
    else if ('mwMW@%'.includes(ch)) w += 10;
    else if (/[A-Z0-9#]/.test(ch)) w += 7.5;
    else w += 6.4;
  }
  return Math.round(w);
}

export function stateBadge(label, state) {
  return badge(label, MESSAGES[state] || state, COLORS[state] || COLORS.unknown);
}

export function uptimeBadge(label, ratio, text) {
  if (ratio == null) return badge(label, 'no data', COLORS.unknown);
  const color = ratio >= 0.999 ? COLORS.operational : ratio >= 0.99 ? COLORS.degraded : COLORS.major_outage;
  return badge(label, text, color);
}

export function badge(label, message, color) {
  const lw = textWidth(label) + 12;
  const mw = textWidth(message) + 12;
  const w = lw + mw;
  const l = escape(label);
  const m = escape(message);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${l}: ${m}">
<title>${l}: ${m}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3" textLength="${lw - 12}">${l}</text><text x="${lw / 2}" y="14" textLength="${lw - 12}">${l}</text>
<text x="${lw + mw / 2}" y="15" fill="#010101" fill-opacity=".3" textLength="${mw - 12}">${m}</text><text x="${lw + mw / 2}" y="14" textLength="${mw - 12}">${m}</text>
</g>
</svg>`;
}
