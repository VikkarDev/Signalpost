// Custom logo and footer links, stored in the settings table.

import crypto from 'node:crypto';
import { getSetting, setSetting, run } from './db.js';

export const MAX_LOGO_BYTES = 256 * 1024;
export const MAX_FOOTER_LINKS = 6;

let cache = null;

/** What the public layout needs. Cached until something changes. */
export function branding() {
  if (!cache) {
    try {
      cache = {
        logoVersion: getSetting('logo_data') ? getSetting('logo_version') : null,
        links: parseFooterLinks(getSetting('footer_links', '')).links,
      };
    } catch {
      return { logoVersion: null, links: [] };
    }
  }
  return cache;
}

function invalidate() {
  cache = null;
}

/** Sniff the file type from its first bytes rather than trusting the browser. */
export function detectImageType(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  const head = buf.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart();
  if ((head.startsWith('<svg') || head.startsWith('<?xml')) && head.includes('<svg')) return 'image/svg+xml';
  return null;
}

/** Returns an error message, or null when the logo was saved. */
export function saveLogo(buf) {
  if (!buf || !buf.length) return 'Choose an image file first.';
  if (buf.length > MAX_LOGO_BYTES) return `The image is too large (max ${MAX_LOGO_BYTES / 1024} KB).`;
  const type = detectImageType(buf);
  if (!type) return 'Use a PNG, JPEG, WebP or SVG image.';
  setSetting('logo_data', buf.toString('base64'));
  setSetting('logo_type', type);
  setSetting('logo_version', crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12));
  invalidate();
  return null;
}

export function removeLogo() {
  run("DELETE FROM settings WHERE key IN ('logo_data', 'logo_type', 'logo_version')");
  invalidate();
}

export function getLogo() {
  const data = getSetting('logo_data');
  if (!data) return null;
  return { type: getSetting('logo_type'), body: Buffer.from(data, 'base64'), version: getSetting('logo_version') };
}

/**
 * One link per line: "Label | https://example.com".
 * Returns { links: [{ label, url }], errors: [] }.
 */
export function parseFooterLinks(text) {
  const links = [];
  const errors = [];
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const i = line.lastIndexOf('|');
    const label = (i === -1 ? '' : line.slice(0, i)).trim().slice(0, 40);
    const url = (i === -1 ? line : line.slice(i + 1)).trim();
    let ok = false;
    try {
      const u = new URL(url);
      ok = (u.protocol === 'https:' || u.protocol === 'http:') && url.length <= 500;
    } catch {
      /* invalid */
    }
    if (!label || !ok) {
      errors.push(`Couldn't read "${line.slice(0, 60)}". Use: Label | https://example.com`);
      continue;
    }
    links.push({ label, url });
  }
  if (links.length > MAX_FOOTER_LINKS) errors.push(`At most ${MAX_FOOTER_LINKS} footer links.`);
  return { links: links.slice(0, MAX_FOOTER_LINKS), errors };
}

export function saveFooterLinks(text) {
  const { errors } = parseFooterLinks(text);
  if (errors.length) return errors;
  setSetting('footer_links', String(text || '').trim());
  invalidate();
  return [];
}
