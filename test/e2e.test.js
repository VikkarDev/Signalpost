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
let pushHits = [];

function startTarget() {
  return new Promise((resolve) => {
    target = http.createServer((req, res) => {
      if (req.url.startsWith('/ntfy/') || req.url.startsWith('/hook')) {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          pushHits.push({ url: req.url, auth: req.headers.authorization || null, body: JSON.parse(body) });
          res.writeHead(200).end('{}');
        });
        return;
      }
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
      PUBLIC_RATE_LIMIT_PER_MINUTE: '2000',
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

test('ntfy and webhook rules deliver, and never show their secrets', async () => {
  const token = await csrf('/admin/alerts');
  const rule = { _csrf: token, scope_public: '1', on_down: '1', enabled: '1' };
  const bad = await req('POST', '/admin/alerts', { ...rule, name: 'bad', channel: 'ntfy', target: 'https://ntfy.sh/' });
  assert.equal(bad.status, 422);
  assert.match(bad.text, /topic URL/);

  const ntfy = await req('POST', '/admin/alerts', { ...rule, name: 'phone', channel: 'ntfy', target: `http://127.0.0.1:${targetPort}/ntfy/secret-topic`, token: 'tk_secret123' });
  assert.equal(ntfy.status, 303);
  const hook = await req('POST', '/admin/alerts', { ...rule, name: 'hook', channel: 'webhook', target: `http://127.0.0.1:${targetPort}/hook/abc` });
  assert.equal(hook.status, 303);

  const list = await req('GET', '/admin/alerts');
  const id = (name) => Number(new RegExp(`/admin/alerts/(\\d+)">${name}<`).exec(list.text)[1]);
  pushHits = [];
  await req('POST', `/admin/alerts/${id('phone')}/test`, { _csrf: token });
  await req('POST', `/admin/alerts/${id('hook')}/test`, { _csrf: token });
  const n = pushHits.find((h) => h.url.startsWith('/ntfy/'));
  assert.equal(n.url, '/ntfy/');
  assert.equal(n.auth, 'Bearer tk_secret123');
  assert.equal(n.body.topic, 'secret-topic');
  assert.match(n.body.title, /Test notification/);
  const w = pushHits.find((h) => h.url === '/hook/abc');
  assert.equal(w.auth, null);
  assert.equal(w.body.event, 'test');
  assert.match(w.body.text, /Test notification/);

  // Saving without re-entering the token keeps it; the edit page shows neither token nor full topic.
  const edit = await req('GET', `/admin/alerts/${id('phone')}`);
  assert.doesNotMatch(edit.text, /tk_secret123|secret-topic/);
  assert.match(edit.text, /sec••••/);
  await req('POST', `/admin/alerts/${id('phone')}`, { ...rule, name: 'phone', channel: 'ntfy', target: '', token: '' });
  pushHits = [];
  await req('POST', `/admin/alerts/${id('phone')}/test`, { _csrf: token });
  assert.equal(pushHits[0].auth, 'Bearer tk_secret123');

  for (const name of ['phone', 'hook']) await req('POST', `/admin/alerts/${id(name)}/delete`, { _csrf: token });
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
  // Today's bar lists the incident under "Related" with how long it has been going on.
  const today = [...pub.text.matchAll(/data-day="([^"]+)"/g)].map((m) => JSON.parse(m[1].replaceAll('&quot;', '"'))).find((d) => d.i);
  assert.deepEqual(today.i, [[id, 'Files slow']]);
  assert.equal(today.r[0][0], 'Degraded');
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
  assert.match(embed.title, /flaky is down/);
  assert.match(embed.description, /Unexpected HTTP status 503/);
  discordHits = [];
  await req('POST', `/admin/monitors/${id}/check`, { _csrf: token });
  for (let i = 0; i < 20 && !discordHits.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(discordHits[0].embeds[0].title, /back up/);
  await req('POST', `/admin/monitors/${id}/delete`, { _csrf: token });
});

test('atom feed lists incidents and maintenance', async () => {
  const r = await req('GET', '/feed.xml');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/atom\+xml/);
  assert.match(r.text, /<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">/);
  assert.match(r.text, /\[Resolved\] Files slow/);
  assert.match(r.text, /Maintenance: Disk upgrade/);
  // incident text is escaped twice over: once for HTML, once for XML
  assert.doesNotMatch(r.text, /<script>/);
  const page = await req('GET', '/');
  assert.match(page.text, /rel="alternate" type="application\/atom\+xml"/);
});

test('component groups render as collapsible sections', async () => {
  const token = await csrf('/admin/components');
  const c = await req('POST', '/admin/components', { _csrf: token, name: 'Notes', group_name: 'Home apps', sort_order: '20', visible: '1' });
  assert.equal(c.status, 303);
  const page = await req('GET', '/');
  assert.match(page.text, /<details class="group state-[a-z_]+" data-group="Home apps" open>/);
  const api = JSON.parse((await req('GET', '/api/v1/status')).text);
  assert.equal(api.components.find((x) => x.name === 'Notes').group, 'Home apps');
  assert.equal(api.components.find((x) => x.name === 'Files').group, null);
  assert.match(page.text, /data-live="30"/);
});

function multipart(fields, file) {
  const boundary = '----signalposttest' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="logo"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

async function uploadLogo(file) {
  const token = await csrf('/admin/settings');
  const { body, type } = multipart({ _csrf: token }, file);
  const res = await fetch(`${BASE}/admin/branding/logo`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': type }, body });
  return res.status;
}

test('logo upload, serving and removal', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png body \r\n with crlf')]);
  assert.equal(await uploadLogo({ name: 'logo.png', type: 'image/png', data: png }), 303);
  const page = await req('GET', '/');
  const v = /src="\/logo\?v=([0-9a-f]+)"/.exec(page.text);
  assert.ok(v, 'public page uses the uploaded logo');
  const logo = await fetch(`${BASE}/logo?v=${v[1]}`);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await logo.arrayBuffer()).equals(png), 'logo bytes round-trip exactly');

  assert.equal(await uploadLogo({ name: 'x.txt', type: 'image/png', data: Buffer.from('not an image') }), 422);

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal(await uploadLogo({ name: 'logo.svg', type: 'image/svg+xml', data: svg }), 303);
  const svgRes = await fetch(`${BASE}/logo`);
  assert.equal(svgRes.headers.get('content-type'), 'image/svg+xml');
  assert.match(svgRes.headers.get('content-security-policy'), /sandbox/);

  const token = await csrf('/admin/settings');
  await req('POST', '/admin/branding/logo/delete', { _csrf: token });
  assert.equal((await fetch(`${BASE}/logo`)).status, 404);
});

test('footer links are validated and shown', async () => {
  const token = await csrf('/admin/settings');
  const bad = await req('POST', '/admin/settings', { _csrf: token, site_name: 'Status', heading: 'Services', footer_links: 'Home | javascript:alert(1)' });
  assert.equal(bad.status, 422);
  const ok = await req('POST', '/admin/settings', { _csrf: token, site_name: 'Status', heading: 'Services', footer_links: 'Home | https://example.com\nContact | https://example.com/contact' });
  assert.equal(ok.status, 303);
  const page = await req('GET', '/');
  assert.match(page.text, /<a href="https:\/\/example.com\/contact" rel="noopener">Contact<\/a>/);
});

test('display settings change the public page', async () => {
  const token = await csrf('/admin/settings');
  const bad = await req('POST', '/admin/settings/display', { _csrf: token, history_days: '90', orange_below: '95', red_below: '99' });
  assert.equal(bad.status, 422, 'red threshold above orange is rejected');

  const ok = await req('POST', '/admin/settings/display', {
    _csrf: token, history_days: '30', orange_below: '100', red_below: '50', slow_counts_as_up: '1', show_uptime: '1', show_descriptions: '1',
  });
  assert.equal(ok.status, 303);
  const api = JSON.parse((await req('GET', '/api/v1/status')).text);
  assert.equal(api.page.history_days, 30);
  const files = api.components.find((x) => x.name === 'Files');
  assert.equal(files.history.length, 30);
  assert.equal(files.response_ms, null, 'response time hidden');
  assert.equal(files.last_checked_at, null, 'last checked hidden');
  // Files' only public monitor has been down all day: below 50% -> red
  assert.equal(files.history.at(-1).status, 'major_outage');

  const page = await req('GET', '/');
  assert.doesNotMatch(page.text, /checked \d/);
  assert.match(page.text, /30 days ago/);

  assert.match(page.text, /class="components"/);
  const list = await req('POST', '/admin/settings/display', {
    _csrf: token, layout: 'list', history_days: '30', orange_below: '100', red_below: '50', show_uptime: '1',
  });
  assert.equal(list.status, 303);
  const listPage = await req('GET', '/');
  assert.match(listPage.text, /<div class="rows">/);
  assert.match(listPage.text, /<div class="row state-major_outage">/);
  assert.doesNotMatch(listPage.text, /class="components"/);
  await req('POST', '/admin/settings/display', {
    _csrf: token, layout: 'cards', history_days: '90', orange_below: '100', red_below: '99', show_uptime: '1', show_response_time: '1',
  });
  const cardsPage = await req('GET', '/');
  assert.match(cardsPage.text, /<div class="cards">/);
  assert.match(cardsPage.text, /<svg class="spark"/, 'response graph from real checks');

  // back to defaults so other tests aren't affected
  await req('POST', '/admin/settings/display', {
    _csrf: token, history_days: '90', orange_below: '100', red_below: '99',
    slow_counts_as_up: '1', show_uptime: '1', show_response_time: '1', show_last_checked: '1', show_descriptions: '1',
  });
});

test('a service that failed recently shows as recovered', async () => {
  const token = await csrf('/admin/components');
  const c = await req('POST', '/admin/components', { _csrf: token, name: 'Bouncy', sort_order: '90', visible: '1' });
  const cid = /\/admin\/components\/(\d+)/.exec(c.location)[1];
  const m = await req('POST', '/admin/monitors', {
    _csrf: token, name: 'bouncy', component_id: cid, type: 'http', scope: 'public', target: `http://127.0.0.1:${targetPort}/bouncy`,
    method: 'GET', expected_status: '200-299', interval_s: '3600', timeout_ms: '2000', failure_threshold: '1', enabled: '1',
  });
  const id = /\/admin\/monitors\/(\d+)/.exec(m.location)[1];
  targetStatus = 503;
  await req('POST', `/admin/monitors/${id}/check`, { _csrf: token });
  targetStatus = 200;
  await req('POST', `/admin/monitors/${id}/check`, { _csrf: token });

  const api = JSON.parse((await req('GET', '/api/v1/status')).text);
  const b = api.components.find((x) => x.name === 'Bouncy');
  assert.equal(b.status, 'operational', 'API reports the live state');
  assert.ok(b.last_failure_at, 'API includes the last failure');
  const page = await req('GET', '/');
  assert.match(page.text, /class="component state-recovered"/);
  assert.match(page.text, /Up again\. Last failure/);

  await req('POST', `/admin/monitors/${id}/delete`, { _csrf: token });
  await req('POST', `/admin/components/${cid}/delete`, { _csrf: token });
});

test('heartbeat monitors are fed through their secret URL', async () => {
  const token = await csrf();
  const created = await req('POST', '/admin/monitors', {
    _csrf: token, name: 'nightly backup', type: 'push', scope: 'internal', target: 'ignored', interval_s: '3600', timeout_ms: '2000', failure_threshold: '1', enabled: '1',
  });
  assert.equal(created.status, 303, created.text);
  const id = Number(/\/admin\/monitors\/(\d+)/.exec(created.location)[1]);
  const page = await req('GET', `/admin/monitors/${id}`);
  const url = /\/api\/push\/([a-f0-9]{32})/.exec(page.text);
  assert.ok(url, 'detail page shows the heartbeat URL');

  // Nothing is overdue yet, so "Check now" records nothing.
  const check = await req('POST', `/admin/monitors/${id}/check`, { _csrf: token });
  assert.match(check.location, /push_waiting/);

  assert.equal((await fetch(`${BASE}/api/push/${url[1]}?ms=1500`)).status, 200);
  let m = await req('GET', `/admin/monitors/${id}`);
  assert.match(m.text, /1500 ms/);
  assert.equal((await fetch(`${BASE}/api/push/${url[1]}?status=down&msg=disk%20full`, { method: 'POST' })).status, 200);
  m = await req('GET', `/admin/monitors/${id}`);
  assert.match(m.text, /Reported down: disk full/);
  assert.equal((await fetch(`${BASE}/api/push/${'0'.repeat(32)}`)).status, 404);

  // A new URL replaces the old one.
  await req('POST', `/admin/monitors/${id}/push-token`, { _csrf: token });
  assert.equal((await fetch(`${BASE}/api/push/${url[1]}`)).status, 404);
  await req('POST', `/admin/monitors/${id}/delete`, { _csrf: token });
});

test('dns monitors validate their settings', async () => {
  const token = await csrf();
  const base = { _csrf: token, name: 'dns', type: 'dns', scope: 'public', interval_s: '60', timeout_ms: '2000', failure_threshold: '1', enabled: '1' };
  const bad = await req('POST', '/admin/monitors', { ...base, target: 'not a domain', dns_record_type: 'A', dns_server: 'dns.google' });
  assert.equal(bad.status, 422);
  assert.match(bad.text, /domain name/);
  assert.match(bad.text, /DNS server must be an IP/);
  const ok = await req('POST', '/admin/monitors', { ...base, enabled: '', target: 'Example.com', dns_record_type: 'MX', dns_server: '1.1.1.1', dns_expected: 'mail.example.com' });
  assert.equal(ok.status, 303);
  const id = Number(/\/admin\/monitors\/(\d+)/.exec(ok.location)[1]);
  const page = await req('GET', `/admin/monitors/${id}`);
  assert.match(page.text, /example\.com \(MX via 1\.1\.1\.1\)/);
  assert.match(page.text, /mail\.example\.com/);
  await req('POST', `/admin/monitors/${id}/delete`, { _csrf: token });
});

test('automatic incidents open after the delay and close on recovery', async () => {
  const token = await csrf();
  const c = await req('POST', '/admin/components', { _csrf: token, name: 'Photos', sort_order: '50', visible: '1' });
  const cid = Number(/\/admin\/components\/(\d+)/.exec(c.location)[1]);
  const created = await req('POST', '/admin/monitors', {
    _csrf: token, name: 'photos', component_id: String(cid), type: 'http', scope: 'public', target: `http://127.0.0.1:${targetPort}/photos`,
    method: 'GET', expected_status: '200-299', interval_s: '3600', timeout_ms: '2000', failure_threshold: '1', auto_incident_minutes: '5', enabled: '1',
  });
  const id = Number(/\/admin\/monitors\/(\d+)/.exec(created.location)[1]);
  const incidents = () => req('GET', '/api/v1/status').then((r) => JSON.parse(r.text).incidents.filter((i) => i.title === 'Photos is down'));

  targetStatus = 503;
  await req('POST', `/admin/monitors/${id}/check`, { _csrf: token });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await incidents()).length, 0, 'not before the delay');

  // Pretend it has been down for 10 minutes.
  const db = new DatabaseSync(path.join(dataDir, 'signalpost.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  db.prepare('UPDATE monitors SET state_since = ? WHERE id = ?').run(Date.now() - 10 * 60000, id);
  db.close();
  await req('POST', `/admin/monitors/${id}/check`, { _csrf: token });
  await new Promise((r) => setTimeout(r, 200));
  const open = await incidents();
  assert.equal(open.length, 1);
  assert.equal(open[0].impact, 'major');

  // Still down: no second incident.
  await req('POST', `/admin/monitors/${id}/check`, { _csrf: token });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await incidents()).length, 1);

  targetStatus = 200;
  await req('POST', `/admin/monitors/${id}/check`, { _csrf: token });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await incidents()).length, 0, 'resolved once it is back');
  const pub = await req('GET', `/incidents/${open[0].id}`);
  assert.match(pub.text, /Resolved automatically/);
  await req('POST', `/admin/monitors/${id}/delete`, { _csrf: token });
  await req('POST', `/admin/components/${cid}/delete`, { _csrf: token });
});

test('status badges', async () => {
  const overall = await fetch(`${BASE}/badge.svg?label=my%20status`);
  assert.equal(overall.status, 200);
  assert.match(overall.headers.get('content-type'), /image\/svg\+xml/);
  const svg = await overall.text();
  assert.match(svg, /my status/);
  const one = await fetch(`${BASE}/badge/${componentId}.svg?uptime=1`);
  assert.equal(one.status, 200);
  assert.match(await one.text(), /Files/);
  assert.equal((await fetch(`${BASE}/badge/99999.svg`)).status, 404);
  assert.match(await fetch(`${BASE}/badge.svg?label=%3Cscript%3E`).then((r) => r.text()), /&lt;script&gt;/);
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
