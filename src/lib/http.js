import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

export class HttpError extends Error {
  constructor(status, message, expose = true) {
    super(message);
    this.status = status;
    this.expose = expose;
  }
}

/** Tiny method + path router with `:param` segments. */
export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => {
          keys.push(k);
          return '/([^/]+)';
        }) +
        '/?$',
    );
    this.routes.push({ method, re, keys, handlers });
  }
  get(p, ...h) {
    this.add('GET', p, ...h);
  }
  post(p, ...h) {
    this.add('POST', p, ...h);
  }
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return { handlers: r.handlers, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function clientIp(req) {
  if (config.trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.length < 64) return cf.trim();
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string') return xff.split(',')[0].trim().slice(0, 64);
  }
  return req.socket.remoteAddress || 'unknown';
}

export function isHttps(req) {
  if (req.socket.encrypted) return true;
  if (!config.trustProxy) return false;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0].trim() === 'https') return true;
  const visitor = req.headers['cf-visitor'];
  return typeof visitor === 'string' && visitor.includes('"https"');
}

const MAX_BODY = 64 * 1024;

/**
 * Read a POST body. URL-encoded forms always; multipart only when `allowFiles` is set
 * (files end up in form._files as { filename, type, data }).
 */
export function readForm(req, { maxBytes = MAX_BODY, allowFiles = false } = {}) {
  return new Promise((resolve, reject) => {
    const header = req.headers['content-type'] || '';
    const type = header.split(';')[0].trim().toLowerCase();
    const multipart = type === 'multipart/form-data';
    if (type !== 'application/x-www-form-urlencoded' && !(multipart && allowFiles)) {
      reject(new HttpError(415, 'Unsupported content type'));
      req.resume();
      return;
    }
    let boundary = null;
    if (multipart) {
      const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(header);
      boundary = m && (m[1] || m[2]);
      if (!boundary || boundary.length > 200) {
        reject(new HttpError(400, 'Malformed upload'));
        req.resume();
        return;
      }
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (multipart) {
        resolve(parseMultipart(body, boundary));
        return;
      }
      const params = new URLSearchParams(body.toString('utf8'));
      const form = {};
      for (const [k, v] of params) {
        if (k in form) form[k] = [].concat(form[k], v);
        else form[k] = v;
      }
      resolve(form);
    });
    req.on('error', reject);
  });
}

function parseMultipart(buf, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const form = { _files: {} };
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    pos += delim.length;
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // closing "--"
    pos += 2; // CRLF after the delimiter
    const headerEnd = buf.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) break;
    const next = buf.indexOf(delim, headerEnd + 4);
    if (next === -1) break;
    const headers = buf.subarray(pos, headerEnd).toString('utf8');
    const content = buf.subarray(headerEnd + 4, next - 2); // drop the CRLF before the next delimiter
    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    const ctype = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim().toLowerCase();
    if (name) {
      if (filename !== undefined) form._files[name] = { filename, type: ctype || '', data: Buffer.from(content) };
      else form[name] = content.toString('utf8');
    }
    pos = next;
  }
  return form;
}

export function securityHeaders(res, nonce) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      `script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}`,
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

export function sendHtml(res, status, body, headers = {}) {
  const buf = Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(res.req.method === 'HEAD' ? undefined : buf);
}

export function sendJson(res, status, obj, headers = {}) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(res.req.method === 'HEAD' ? undefined : buf);
}

export function redirect(res, location, status = 303) {
  // Only allow same-site relative redirects.
  const safe = typeof location === 'string' && location.startsWith('/') && !location.startsWith('//') ? location : '/';
  res.writeHead(status, { Location: safe, 'Cache-Control': 'no-store' });
  res.end();
}

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Serve files from a directory; returns false if not found. */
export function serveStatic(req, res, root, relPath) {
  const filePath = path.normalize(path.join(root, relPath));
  if (!filePath.startsWith(root + path.sep)) return false;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'public, max-age=3600',
    ETag: etag,
  });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(filePath).pipe(res);
  return true;
}

/** Fixed-window in-memory rate limiter keyed by an arbitrary string. */
export class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), Math.min(windowMs, 60000));
    this.timer.unref();
  }
  /** Returns true if the request is allowed. */
  hit(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset <= now) {
      e = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, e);
    }
    e.count++;
    return e.count <= this.limit;
  }
  count(key) {
    const e = this.hits.get(key);
    return e && e.reset > Date.now() ? e.count : 0;
  }
  retryAfter(key) {
    const e = this.hits.get(key);
    return e ? Math.max(1, Math.ceil((e.reset - Date.now()) / 1000)) : 0;
  }
  reset(key) {
    this.hits.delete(key);
  }
  sweep() {
    const now = Date.now();
    for (const [k, e] of this.hits) if (e.reset <= now) this.hits.delete(k);
    // Hard cap on memory in case of a flood of unique keys.
    if (this.hits.size > 50000) this.hits.clear();
  }
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
