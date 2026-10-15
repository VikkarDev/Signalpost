// Network probes. Each probe resolves (never rejects) to:
//   { ok: boolean, responseMs: number|null, statusCode?: number, error?: string, tlsExpiresAt?: number }

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { config } from '../config.js';

const USER_AGENT = `Signalpost/1.0 (+${config.publicUrl})`;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;

const FRIENDLY = {
  ENOTFOUND: 'DNS lookup failed (host not found)',
  EAI_AGAIN: 'DNS lookup failed (temporary resolver failure)',
  ECONNREFUSED: 'Connection refused',
  ECONNRESET: 'Connection reset by peer',
  EHOSTUNREACH: 'Host unreachable',
  ENETUNREACH: 'Network unreachable',
  ETIMEDOUT: 'Connection timed out',
  EPIPE: 'Connection closed unexpectedly',
  CERT_HAS_EXPIRED: 'TLS certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS certificate is self-signed',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS certificate chain contains a self-signed certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate could not be verified',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match host name',
};

export function describeError(err) {
  if (!err) return 'Unknown error';
  const friendly = FRIENDLY[err.code];
  if (friendly) return `${friendly} (${err.code})`;
  return err.code ? `${err.message} (${err.code})` : err.message || String(err);
}

/**
 * Parse an expected-status spec such as "200-299,301" into a predicate.
 * Throws on invalid input.
 */
export function parseExpectedStatus(spec) {
  const parts = String(spec || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error('Expected status must not be empty');
  const ranges = parts.map((p) => {
    const m = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(p);
    if (!m) throw new Error(`Invalid status code or range: "${p}"`);
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    if (lo < 100 || hi > 599 || hi < lo) throw new Error(`Invalid status range: "${p}"`);
    return [lo, hi];
  });
  return (code) => ranges.some(([lo, hi]) => code >= lo && code <= hi);
}

// Cloudflare edge error codes that mean "Cloudflare could not reach the origin/tunnel".
const CF_ORIGIN_ERRORS = {
  502: 'Bad gateway at Cloudflare edge',
  503: 'Service unavailable at Cloudflare edge',
  504: 'Gateway timeout at Cloudflare edge',
  520: 'Cloudflare 520: origin returned an unknown error',
  521: 'Cloudflare 521: origin refused the connection',
  522: 'Cloudflare 522: connection to origin timed out',
  523: 'Cloudflare 523: origin unreachable',
  524: 'Cloudflare 524: origin timed out',
  525: 'Cloudflare 525: TLS handshake with origin failed',
  526: 'Cloudflare 526: invalid origin certificate',
  530: 'Cloudflare 530: origin/tunnel unavailable (often error 1033, tunnel down)',
};

export function httpProbe(m) {
  const started = performance.now();
  const deadline = Date.now() + m.timeout_ms;
  const accept = parseExpectedStatus(m.expected_status);
  const method = m.method === 'HEAD' ? 'HEAD' : 'GET';

  return new Promise((resolve) => {
    let settled = false;
    let currentReq = null;
    let tlsExpiresAt;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (currentReq) currentReq.destroy();
      resolve({ responseMs: Math.round(performance.now() - started), tlsExpiresAt, ...result });
    };

    const timer = setTimeout(() => finish({ ok: false, responseMs: null, error: `Timed out after ${m.timeout_ms} ms` }), m.timeout_ms);

    const go = (rawUrl, redirectsLeft) => {
      let url;
      try {
        url = new URL(rawUrl);
      } catch {
        return finish({ ok: false, error: `Invalid URL: ${rawUrl}` });
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return finish({ ok: false, error: `Unsupported protocol ${url.protocol}` });
      }
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(
        url,
        {
          method,
          agent: false, // fresh connection every time: measures real reachability
          timeout: Math.max(1, deadline - Date.now()),
          rejectUnauthorized: !m.ignore_tls,
          servername: net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
          headers: {
            'User-Agent': USER_AGENT,
            Accept: '*/*',
            'Cache-Control': 'no-cache',
            Connection: 'close',
          },
        },
        (res) => {
          if (url.protocol === 'https:' && !tlsExpiresAt && res.socket?.getPeerCertificate) {
            try {
              const cert = res.socket.getPeerCertificate();
              if (cert?.valid_to) tlsExpiresAt = Date.parse(cert.valid_to) || undefined;
            } catch {
              /* ignore */
            }
          }
          const code = res.statusCode;
          if (m.follow_redirects && code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            const next = new URL(res.headers.location, url).toString();
            return go(next, redirectsLeft - 1);
          }

          const needBody = Boolean(m.keyword) && method === 'GET';
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            if (!needBody) return;
            if (size < MAX_BODY_BYTES) {
              chunks.push(c);
              size += c.length;
            }
          });
          res.on('error', (err) => finish({ ok: false, statusCode: code, error: describeError(err) }));
          res.on('end', () => {
            if (!accept(code)) {
              const cf = res.headers['cf-ray'] && CF_ORIGIN_ERRORS[code];
              return finish({
                ok: false,
                statusCode: code,
                error: cf || `Unexpected HTTP status ${code} (expected ${m.expected_status})`,
              });
            }
            if (needBody) {
              const body = Buffer.concat(chunks).toString('utf8');
              if (!body.includes(m.keyword)) {
                return finish({ ok: false, statusCode: code, error: `Response did not contain keyword "${m.keyword}"` });
              }
            }
            finish({ ok: true, statusCode: code });
          });
        },
      );
      currentReq = req;
      req.on('timeout', () => req.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })));
      req.on('error', (err) => finish({ ok: false, responseMs: null, error: describeError(err) }));
      req.end();
    };

    try {
      go(m.target, m.follow_redirects ? MAX_REDIRECTS : 0);
    } catch (err) {
      finish({ ok: false, responseMs: null, error: describeError(err) });
    }
  });
}

export function tcpProbe(m) {
  const started = performance.now();
  return new Promise((resolve) => {
    let done = false;
    const socket = net.connect({ host: m.target, port: m.port });
    const finish = (r) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(m.timeout_ms);
    socket.once('connect', () => finish({ ok: true, responseMs: Math.round(performance.now() - started) }));
    socket.once('timeout', () => finish({ ok: false, responseMs: null, error: `Timed out after ${m.timeout_ms} ms` }));
    socket.once('error', (err) => finish({ ok: false, responseMs: null, error: describeError(err) }));
  });
}

export const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9_]([A-Za-z0-9_.:-]*[A-Za-z0-9_])?$/;

export function pingProbe(m) {
  if (!HOST_RE.test(m.target) || m.target.startsWith('-')) {
    return Promise.resolve({ ok: false, responseMs: null, error: 'Invalid host name' });
  }
  const waitSec = String(Math.max(1, Math.ceil(m.timeout_ms / 1000)));
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      // Arguments are passed as an array (no shell), and the host is validated above.
      child = spawn('ping', ['-n', '-c', '1', '-W', waitSec, '--', m.target], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, responseMs: null, error: `Could not run ping: ${describeError(err)}` });
      return;
    }
    const killer = setTimeout(() => child.kill('SIGKILL'), m.timeout_ms + 2000);
    child.stdout.on('data', (d) => {
      if (out.length < 8192) out += d;
    });
    child.stderr.on('data', (d) => {
      if (out.length < 8192) out += d;
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      resolve({ ok: false, responseMs: null, error: `Could not run ping: ${describeError(err)}` });
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      const t = /time[=<]([\d.]+)\s*ms/.exec(out);
      if (code === 0 && t) {
        resolve({ ok: true, responseMs: Math.round(Number(t[1])) });
      } else {
        const reason = /operation not permitted|permission denied/i.test(out)
          ? 'ping not permitted in container (needs NET_RAW capability)'
          : /unknown host|bad address|name or service not known|failure in name resolution/i.test(out)
            ? 'DNS lookup failed'
            : 'No reply (host down or ICMP blocked)';
        resolve({ ok: false, responseMs: null, error: reason });
      }
    });
  });
}

export function runProbe(m) {
  switch (m.type) {
    case 'http':
      return httpProbe(m);
    case 'tcp':
      return tcpProbe(m);
    case 'ping':
      return pingProbe(m);
    default:
      return Promise.resolve({ ok: false, responseMs: null, error: `Unknown monitor type ${m.type}` });
  }
}
