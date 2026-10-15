// End-to-end test: boots the real server against a temporary database and real local targets.
// Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = 3000 + Math.floor(Math.random() * 2000) + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'correct-horse-battery';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalpost-test-'));
let server;
let target;
let targetPort;
let targetStatus = 200;
let closedPort;
let cookie = '';
let discordHits = [];

function startTarget() {
  return new Promise((resolve) => {
    target = http.createServer((req, res) => {
      if (req.url.startsWith('/api/webhooks/')) {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          discordHits.push(JSON.parse(body));
          res.writeHead(204).end();
        });
        return;
      }
      res.writeHead(targetStatus, { 'Content-Type': 'text/plain' }).end('hello signalpost');
    });
    target.listen(0, '127.0.0.1', () => {
      targetPort = target.address().port;
      resolve();
    });
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function req(method, p, form, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (cookie) headers.Cookie = cookie;
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(BASE + p, { method, headers, body, redirect: 'manual' });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, location: res.headers.get('location'), text: await res.text(), headers: res.headers };
}

async function csrf(p = '/admin') {
  const page = await req('GET', p);
  const m = /name="_csrf" value="([^"]+)"/.exec(page.text);
  assert.ok(m, `csrf token on ${p}`);
  return m[1];
}

before(async () => {
  await startTarget();
  closedPort = await freePort();
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: PASSWORD,
      COOKIE_SECURE: 'false',
      MIN_CHECK_INTERVAL_SECONDS: '5',
      LOG_LEVEL: 'warn',
      LOGIN_MAX_ATTEMPTS: '3',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
});

after(async () => {
  if (server) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill('SIGTERM');
    await exited;
  }
  target.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('public page renders with no data and no fabricated uptime', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /No services configured yet/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('admin pages require authentication', async () => {
  const r = await req('GET', '/admin/monitors');
  assert.equal(r.status, 303);
  assert.match(r.location, /^\/admin\/login/);
  const p = await req('POST', '/admin/monitors', { name: 'x' });
  assert.equal(p.status, 401);
});

test('wrong password is rejected and throttled', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await req('POST', '/admin/login', { username: 'admin', password: 'nope' }, { 'X-Forwarded-For': '203.0.113.9' });
    assert.equal(r.status, 401);
  }
  const blocked = await req('POST', '/admin/login', { username: 'admin', password: PASSWORD }, { 'X-Forwarded-For': '203.0.113.9' });
  assert.equal(blocked.status, 429, 'locked out after max attempts, even with the right password');
});

test('login works and CSRF is enforced', async () => {
  const r = await req('POST', '/admin/login', { username: 'admin', password: PASSWORD });
  assert.equal(r.status, 303);
  assert.equal(r.location, '/admin');
  assert.ok(cookie.startsWith('sp_session='));
  const bad = await req('POST', '/admin/components', { name: 'Files', _csrf: 'forged' });
  assert.equal(bad.status, 403);
});

let componentId;
let upId;
let downId;
let tcpId;

test('create component and monitors', async () => {
  const token = await csrf();
  const c = await req('POST', '/admin/components', { _csrf: token, name: 'Files', description: 'File sharing', sort_order: '10', visible: '1' });
  assert.equal(c.status, 303);
  componentId = Number(/\/admin\/components\/(\d+)/.exec(c.location)[1]);

  const base = { _csrf: token, component_id: String(componentId), method: 'GET', expected_status: '200-299', interval_s: '5', timeout_ms: '2000', failure_threshold: '1', enabled: '1', follow_redirects: '1' };
  const up = await req('POST', '/admin/monitors', { ...base, name: 'files internal', type: 'http', scope: 'internal', target: `http://127.0.0.1:${targetPort}/`, keyword: 'signalpost' });
  assert.equal(up.status, 303, up.text);
  upId = Number(/\/admin\/monitors\/(\d+)/.exec(up.location)[1]);

  const down = await req('POST', '/admin/monitors', { ...base, name: 'files public', type: 'http', scope: 'public', target: `http://127.0.0.1:${closedPort}/` });
  assert.equal(down.status, 303);
  downId = Number(/\/admin\/monitors\/(\d+)/.exec(down.location)[1]);

  const tcp = await req('POST', '/admin/monitors', { ...base, component_id: '', name: 'tcp target', type: 'tcp', scope: 'internal', target: '127.0.0.1', port: String(targetPort) });
  assert.equal(tcp.status, 303);
  tcpId = Number(/\/admin\/monitors\/(\d+)/.exec(tcp.location)[1]);

  const invalid = await req('POST', '/admin/monitors', { ...base, name: 'bad', type: 'http', scope: 'public', target: 'ftp://x', expected_status: 'abc' });
  assert.equal(invalid.status, 422);
  assert.match(invalid.text, /URL must start with http/);
});

test('alert rule validation', async () => {
  const token = await csrf('/admin/alerts');
  const r = await req('POST', '/admin/alerts', { _csrf: token, name: 'bad', channel: 'discord', target: 'https://example.com/hook', scope_public: '1', on_down: '1', enabled: '1' });
  assert.equal(r.status, 422);
  assert.match(r.text, /valid Discord webhook/);
  const email = await req('POST', '/admin/alerts', { _csrf: token, name: 'mail', channel: 'email', target: 'ops@example.com', scope_public: '1', on_down: '1', enabled: '1' });
  assert.equal(email.status, 303);
});

test('manual checks record real results and state', async () => {
  const token = await csrf();
  for (const id of [upId, downId, tcpId]) {
    const r = await req('POST', `/admin/monitors/${id}/check`, { _csrf: token });
    assert.equal(r.status, 303);
  }
  const upPage = await req('GET', `/admin/monitors/${upId}`);
  assert.match(upPage.text, /badge-up/);
  const downPage = await req('GET', `/admin/monitors/${downId}`);
  assert.match(downPage.text, /badge-down/);
  assert.match(downPage.text, /Connection refused/);
  const tcpPage = await req('GET', `/admin/monitors/${tcpId}`);
  assert.match(tcpPage.text, /badge-up/);
});

test('dashboard diagnoses an edge failure when internal is healthy', async () => {
  const r = await req('GET', '/admin');
  assert.match(r.text, /application itself is healthy/);
});

test('public status reflects real data and hides internals', async () => {
  const api = JSON.parse((await req('GET', '/api/v1/status')).text);
  assert.equal(api.components.length, 1);
  const c = api.components[0];
  assert.equal(c.name, 'Files');
  assert.equal(c.status, 'major_outage', 'all public monitors down => major outage');
  assert.ok(c.uptime_90d !== null && c.uptime_90d < 100);
  const withData = c.history.filter((d) => d.status !== 'nodata');
  assert.equal(withData.length, 1, 'only today has data');
  assert.equal(c.history.length, 90);
  const html = (await req('GET', '/')).text;
  assert.doesNotMatch(html, new RegExp(String(closedPort)), 'internal target is not exposed');
  assert.doesNotMatch(html, /Connection refused/);
});

test('incident lifecycle', async () => {
  const token = await csrf('/admin/incidents/new');
  const r = await req('POST', '/admin/incidents', { _csrf: token, title: 'Files slow', status: 'investigating', impact: 'minor', component_ids: String(componentId), message: 'Looking into it' });
  assert.equal(r.status, 303);
  const id = Number(/\/admin\/incidents\/(\d+)/.exec(r.location)[1]);
  let pub = await req('GET', '/');
  assert.match(pub.text, /Files slow/);
  assert.match(pub.text, /Looking into it/);
  const u = await req('POST', `/admin/incidents/${id}/updates`, { _csrf: token, status: 'resolved', message: 'Fixed <script>alert(1)</script>' });
  assert.equal(u.status, 303);
  pub = await req('GET', `/incidents/${id}`);
  assert.match(pub.text, /Resolved/);
  assert.doesNotMatch(pub.text, /<script>alert/);
  assert.match(pub.text, /&lt;script&gt;/);
});

test('maintenance window marks component', async () => {
  const token = await csrf('/admin/maintenance/new');
  const now = new Date(Date.now() - 60000);
  const later = new Date(Date.now() + 3600000);
  const fmt = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d).replace(' ', 'T');
  const r = await req('POST', '/admin/maintenance', { _csrf: token, title: 'Disk upgrade', starts_at: fmt(now), ends_at: fmt(later), component_ids: String(componentId) });
  assert.equal(r.status, 303, r.text);
  const pub = await req('GET', '/');
  assert.match(pub.text, /Disk upgrade/);
  assert.match(pub.text, /In progress/);
});

test('disable and delete monitor', async () => {
  const token = await csrf();
  const t = await req('POST', `/admin/monitors/${tcpId}/toggle`, { _csrf: token });
  assert.equal(t.status, 303);
  const d = await req('POST', `/admin/monitors/${tcpId}/delete`, { _csrf: token });
  assert.equal(d.status, 303);
  const gone = await req('GET', `/admin/monitors/${tcpId}`);
  assert.equal(gone.status, 404);
});

test('down transition delivers a Discord webhook, then recovery', async () => {
  // The UI only accepts real discord.com webhook URLs, so insert a rule pointing at the local fake endpoint directly.
  const db = new DatabaseSync(path.join(dataDir, 'signalpost.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  const now = Date.now();
  db.prepare(`INSERT INTO alert_rules (name, channel, target, scopes, created_at, updated_at) VALUES (?, 'discord', ?, 'internal,public,canary', ?, ?)`)
    .run('local discord', `http://127.0.0.1:${targetPort}/api/webhooks/1/test`, now, now);
  db.close();
  discordHits = [];
  const token = await csrf();
  const base = { _csrf: token, component_id: String(componentId), method: 'GET', expected_status: '200-299', interval_s: '3600', timeout_ms: '2000', failure_threshold: '1', enabled: '1' };
  // A monitor on a component that is under maintenance must NOT alert.
  const quiet = await req('POST', '/admin/monitors', { ...base, name: 'quiet', type: 'http', scope: 'public', target: `http://127.0.0.1:${closedPort}/` });
  const quietId = Number(/\/admin\/monitors\/(\d+)/.exec(quiet.location)[1]);
  await req('POST', `/admin/monitors/${quietId}/check`, { _csrf: token });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(discordHits.length, 0, 'alerts suppressed during maintenance');
  await req('POST', `/admin/monitors/${quietId}/delete`, { _csrf: token });

  const m = await req('POST', '/admin/monitors', { ...base, component_id: '', name: 'flaky', type: 'http', scope: 'public', target: `http://127.0.0.1:${targetPort}/flaky` });
  const id = Number(/\/admin\/monitors\/(\d+)/.exec(m.location)[1]);
  targetStatus = 200;
  await req('POST', `/admin/monitors/${id}/check`, { _csrf: token });
  targetStatus = 503;
  await req('POST', `/admin/monitors/${id}/check`, { _csrf: token });
  for (let i = 0; i < 20 && !discordHits.length; i++) await new Promise((r) => setTimeout(r, 100));
  targetStatus = 200;
  assert.ok(discordHits.length >= 1, 'webhook received');
  const embed = discordHits[0].embeds[0];
  assert.match(embed.title, /flaky is DOWN/);
  assert.match(embed.description, /Unexpected HTTP status 503/);
  discordHits = [];
  await req('POST', `/admin/monitors/${id}/check`, { _csrf: token });
  for (let i = 0; i < 20 && !discordHits.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(discordHits[0].embeds[0].title, /recovered/);
  await req('POST', `/admin/monitors/${id}/delete`, { _csrf: token });
});

test('backup download returns a SQLite file', async () => {
  const token = await csrf('/admin/settings');
  const res = await fetch(`${BASE}/admin/backup`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `_csrf=${encodeURIComponent(token)}`,
  });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
});

test('logout invalidates the session', async () => {
  const token = await csrf();
  const old = cookie;
  await req('POST', '/admin/logout', { _csrf: token });
  cookie = old;
  const r = await req('GET', '/admin');
  assert.equal(r.status, 303);
});
