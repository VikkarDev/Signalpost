import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { log } from './lib/log.js';
import { openDatabase, closeDatabase } from './db.js';
import { bootstrapAdmin } from './auth.js';
import { Router, HttpError, RateLimiter, clientIp, securityHeaders, sendHtml, sendJson, serveStatic } from './lib/http.js';
import { registerPublic } from './routes/public.js';
import { registerAdmin } from './routes/admin.js';
import { scheduler } from './monitor/engine.js';
import { closeMailer } from './notify/index.js';
import { errorPage } from './views/public.js';

const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const router = new Router();
registerPublic(router);
registerAdmin(router);

const limiter = new RateLimiter(config.publicRateLimitPerMinute, 60000);

async function handle(req, res) {
  const started = performance.now();
  const ip = clientIp(req);
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400).end();
    return;
  }
  securityHeaders(res);

  res.on('finish', () => {
    if (url.pathname === '/healthz' || url.pathname.startsWith('/static/')) return;
    log.info('request', {
      method: req.method,
      path: url.pathname,
      status: res.statusCode,
      ms: Math.round(performance.now() - started),
      ip,
    });
  });

  try {
    if (url.pathname.startsWith('/static/')) {
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, STATIC_DIR, url.pathname.slice('/static/'.length))) return;
      throw new HttpError(404, 'Not found');
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(301, { Location: '/static/favicon.svg' }).end();
      return;
    }
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: *\nDisallow: /admin\n');
      return;
    }

    // Health checks are exempt from rate limiting; everything else is limited per client IP.
    if (url.pathname !== '/healthz' && !limiter.hit(ip)) {
      res.setHeader('Retry-After', String(limiter.retryAfter(ip)));
      throw new HttpError(429, 'Too many requests. Please slow down.');
    }

    const match = router.match(req.method, url.pathname);
    if (!match) throw new HttpError(404, 'Page not found');
    if (match.methodNotAllowed) throw new HttpError(405, 'Method not allowed');

    const ctx = { req, res, url, query: url.searchParams, params: match.params, ip };
    for (const h of match.handlers) await h(ctx);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) log.error('request failed', { method: req.method, path: url.pathname, err });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const message = err instanceof HttpError && err.expose ? err.message : 'Something went wrong. The error has been logged.';
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') sendJson(res, status, { error: message });
    else sendHtml(res, status, errorPage(status, message));
  }
}

async function main() {
  log.info('starting Signalpost', { node: process.versions.node, port: config.port, dataDir: config.dataDir, timezone: config.timezone });
  openDatabase();
  await bootstrapAdmin();

  const server = http.createServer({ requestTimeout: 30000, headersTimeout: 15000, keepAliveTimeout: 5000 }, (req, res) => {
    handle(req, res).catch((err) => {
      log.error('unhandled request error', { err });
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  server.maxHeadersCount = 100;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  log.info('http server listening', { host: config.host, port: config.port });
  scheduler.start();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown requested', { signal });
    const force = setTimeout(() => {
      log.error('graceful shutdown timed out; exiting');
      process.exit(1);
    }, config.shutdownTimeoutMs + 2000);
    force.unref();
    server.close();
    server.closeIdleConnections();
    await scheduler.stop(config.shutdownTimeoutMs);
    server.closeAllConnections();
    closeMailer();
    closeDatabase();
    log.info('shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => log.error('unhandled promise rejection', { err }));
process.on('uncaughtException', (err) => {
  log.error('uncaught exception; exiting', { err });
  process.exit(1);
});

main().catch((err) => {
  log.error('startup failed', { err });
  process.exit(1);
});
