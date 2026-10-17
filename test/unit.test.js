import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localInputToTs, tsToLocalInput, dayKey, lastDays } from '../src/lib/time.js';
import { parseExpectedStatus, heartbeatProbe, dnsProbe } from '../src/monitor/probes.js';
import dgram from 'node:dgram';
import { liveComponentState, diagnose, formatUptime, coveredMs } from '../src/status.js';
import { html, raw } from '../src/lib/html.js';
import { DISCORD_WEBHOOK_RE, parseEmails, ntfyEndpoint, validateRuleTarget } from '../src/notify/index.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrations } from '../src/migrations.js';
import { openDatabase, closeDatabase, all as dbAll } from '../src/db.js';
import { ago } from '../src/views/layout.js';

test('timezone conversion round-trips, including DST', () => {
  const tz = 'Europe/Stockholm';
  assert.equal(new Date(localInputToTs('2026-07-01T12:00', tz)).toISOString(), '2026-07-01T10:00:00.000Z');
  assert.equal(new Date(localInputToTs('2026-01-15T12:00', tz)).toISOString(), '2026-01-15T11:00:00.000Z');
  assert.equal(tsToLocalInput(Date.parse('2026-03-29T01:30:00Z'), tz), '2026-03-29T03:30');
  assert.equal(dayKey(Date.parse('2026-06-30T22:30:00Z'), tz), '2026-07-01');
  assert.equal(localInputToTs('garbage', tz), null);
});

test('lastDays returns N consecutive days ending today', () => {
  const days = lastDays(90, Date.parse('2026-03-01T12:00:00Z'), 'UTC');
  assert.equal(days.length, 90);
  assert.equal(days.at(-1), '2026-03-01');
  assert.equal(days.at(-2), '2026-02-28');
});

test('expected status parsing', () => {
  const ok = parseExpectedStatus('200-299, 301,401');
  assert.ok(ok(204) && ok(301) && ok(401));
  assert.ok(!ok(302) && !ok(500));
  assert.throws(() => parseExpectedStatus('20x'));
  assert.throws(() => parseExpectedStatus('300-200'));
});

test('component state derivation', () => {
  const m = (scope, state) => ({ enabled: 1, scope, state });
  assert.equal(liveComponentState([]), 'unknown');
  assert.equal(liveComponentState([m('public', 'unknown')]), 'unknown');
  assert.equal(liveComponentState([m('public', 'up'), m('internal', 'up')]), 'operational');
  assert.equal(liveComponentState([m('public', 'degraded'), m('internal', 'up')]), 'degraded');
  assert.equal(liveComponentState([m('public', 'up'), m('internal', 'down')]), 'partial_outage');
  assert.equal(liveComponentState([m('public', 'down'), m('internal', 'up')]), 'major_outage');
  assert.equal(liveComponentState([m('canary', 'down'), m('public', 'up')]), 'operational');
});

test('diagnosis distinguishes application, edge, DNS and internet failures', () => {
  const m = (scope, state, last_error = null) => ({ enabled: 1, scope, state, last_error });
  const canUp = [m('canary', 'up')];
  const canDown = [m('canary', 'down')];
  assert.equal(diagnose([m('internal', 'down'), m('public', 'down')], canUp).kind, 'application');
  assert.equal(diagnose([m('internal', 'up'), m('public', 'down', 'Connection timed out')], canUp).kind, 'edge');
  assert.equal(diagnose([m('internal', 'up'), m('public', 'down', 'Cloudflare 530: origin/tunnel unavailable')], canUp).kind, 'cloudflare');
  assert.equal(diagnose([m('internal', 'up'), m('public', 'down', 'DNS lookup failed (host not found) (ENOTFOUND)')], canUp).kind, 'dns');
  assert.equal(diagnose([m('internal', 'up'), m('public', 'down')], canDown).kind, 'internet');
  assert.equal(diagnose([m('internal', 'up'), m('public', 'up')], canUp), null);
});

test('group header summary', async () => {
  const { groupSummaryForTest } = await import('../src/views/public.js');
  const c = (state) => ({ state });
  assert.equal(groupSummaryForTest([c('operational'), c('operational')]), '2 services');
  assert.equal(groupSummaryForTest([c('major_outage'), c('operational')]), '1 of 2 down');
  assert.equal(groupSummaryForTest([c('partial_outage'), c('degraded'), c('recovered')]), '1 of 3 down · 1 slow · 1 recovered recently');
});

test('uptime formatting never rounds up to 100%', () => {
  assert.equal(formatUptime(1), '100%');
  assert.equal(formatUptime(0.99999), '99.99%');
  assert.equal(formatUptime(0.98765), '98.76%');
  assert.equal(formatUptime(null), null);
});

test('html escaping', () => {
  assert.equal(String(html`<p>${'<b>&"'}</p>`), '<p>&lt;b&gt;&amp;&quot;</p>');
  assert.equal(String(html`<p>${raw('<b>')}</p>`), '<p><b></p>');
});

test('alert target validation', () => {
  assert.ok(DISCORD_WEBHOOK_RE.test('https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_-0123'));
  assert.ok(!DISCORD_WEBHOOK_RE.test('https://evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz'));
  assert.deepEqual(parseEmails('a@b.se, c@d.com').bad, []);
  assert.equal(parseEmails('not-an-email').bad.length, 1);
});

test('check times are flagged late once a check is overdue', () => {
  const fresh = String(ago(Date.now() - 30000, 'checked ', 150000));
  assert.match(fresh, /class="ago"/);
  assert.match(fresh, /data-late-after="150000"/);
  assert.match(String(ago(Date.now() - 600000, 'checked ', 150000)), /class="ago late"/);
  assert.doesNotMatch(String(ago(Date.now() - 600000)), /late/);
});

test('ntfy topic URLs split into server and topic', () => {
  assert.deepEqual(ntfyEndpoint('https://ntfy.sh/my-servers'), { url: 'https://ntfy.sh/', topic: 'my-servers' });
  assert.deepEqual(ntfyEndpoint('https://home.example/ntfy/alerts_1'), { url: 'https://home.example/ntfy/', topic: 'alerts_1' });
  assert.equal(ntfyEndpoint('https://ntfy.sh/'), null);
  assert.equal(ntfyEndpoint('https://ntfy.sh/bad topic'), null);
  assert.equal(ntfyEndpoint('https://user:pw@ntfy.sh/topic'), null);
  assert.equal(ntfyEndpoint('ftp://ntfy.sh/topic'), null);
  assert.equal(validateRuleTarget('webhook', 'https://hooks.example/x?y=1'), null);
  assert.ok(validateRuleTarget('webhook', 'javascript:alert(1)'));
});

test('migrations keep existing alert rules, monitors and their history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalpost-mig-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  for (const m of migrations.filter((m) => m.version <= 2)) {
    old.exec(m.sql);
    old.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, 0);
  }
  old.exec(`INSERT INTO alert_rules (id, name, channel, target, created_at, updated_at) VALUES (7, 'mail', 'email', 'a@b.se', 0, 0);
    INSERT INTO alert_log (rule_id, event, sent_at, ok) VALUES (7, 'test', 1, 1);
    INSERT INTO monitors (id, name, type, target, created_at, updated_at) VALUES (3, 'web', 'http', 'https://example.com', 0, 0);
    INSERT INTO checks (monitor_id, checked_at, status) VALUES (3, 1, 'up');
    INSERT INTO daily_stats (monitor_id, day, up) VALUES (3, '2026-01-01', 1);`);
  old.close();

  openDatabase(file);
  try {
    assert.equal(dbAll('SELECT * FROM alert_rules')[0].target, 'a@b.se');
    assert.equal(dbAll('SELECT * FROM alert_log WHERE rule_id = 7').length, 1);
    assert.equal(dbAll('PRAGMA foreign_keys')[0].foreign_keys, 1);
    // Migration 4 rebuilt the monitors table; its checks and daily totals are still attached.
    assert.equal(dbAll('SELECT name FROM monitors WHERE id = 3')[0].name, 'web');
    assert.equal(dbAll('SELECT COUNT(*) AS n FROM checks WHERE monitor_id = 3')[0].n, 1);
    assert.equal(dbAll('SELECT COUNT(*) AS n FROM daily_stats WHERE monitor_id = 3')[0].n, 1);
    // The new channels pass the CHECK constraint, and deleting a rule still cascades.
    dbAll(`INSERT INTO alert_rules (name, channel, target, created_at, updated_at) VALUES ('p', 'ntfy', 'https://ntfy.sh/x', 0, 0) RETURNING id`);
    dbAll('DELETE FROM alert_rules WHERE id = 7 RETURNING id');
    assert.equal(dbAll('SELECT * FROM alert_log').length, 0);
  } finally {
    closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlapping incidents on a day are only counted once', () => {
  assert.equal(coveredMs([[0, 50], [30, 80], [200, 300]], 0, 250), 130);
  assert.equal(coveredMs([[-100, 1000]], 0, 100), 100);
  assert.equal(coveredMs([[10, 20], [12, 15]], 0, 100), 10);
  assert.equal(coveredMs([], 0, 100), 0);
});

test('heartbeats are only missed once they are overdue', async () => {
  const now = Date.now();
  const m = { interval_s: 3600, updated_at: now - 7200000, last_push_at: now - 3000000 };
  assert.equal(await heartbeatProbe(m, now), null);
  const late = await heartbeatProbe({ ...m, last_push_at: now - 3600000 - 400000 }, now);
  assert.equal(late.ok, false);
  assert.match(late.error, /No heartbeat in the last 67 min/);
  // Editing or re-enabling the monitor restarts the clock.
  assert.equal(await heartbeatProbe({ ...m, last_push_at: now - 9e6, updated_at: now - 60000 }, now), null);
  assert.match((await heartbeatProbe({ ...m, last_push_at: null, updated_at: now - 9e6 }, now)).error, /No heartbeat yet/);
});

// Minimal DNS server: answers every A query with 192.0.2.7 and everything else with no records.
function fakeDns() {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (q, rinfo) => {
    let end = 12;
    while (q[end] !== 0) end += q[end] + 1;
    const qtype = q.readUInt16BE(end + 1);
    const question = q.subarray(12, end + 5);
    const header = Buffer.from(q.subarray(0, 12));
    header.writeUInt16BE(0x8180, 2); // response, recursion available, no error
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(qtype === 1 ? 1 : 0, 6);
    header.writeUInt32BE(0, 8);
    const answer = qtype === 1 ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 7]) : Buffer.alloc(0);
    sock.send(Buffer.concat([header, question, answer]), rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => sock.bind(0, '127.0.0.1', () => resolve(sock)));
}

test('dns checks compare the answer with what is expected', async () => {
  const sock = await fakeDns();
  const server = `127.0.0.1:${sock.address().port}`;
  const base = { target: 'example.test', dns_record_type: 'A', dns_server: server, timeout_ms: 2000 };
  try {
    assert.equal((await dnsProbe(base)).ok, true);
    assert.equal((await dnsProbe({ ...base, keyword: '192.0.2.7' })).ok, true);
    const wrong = await dnsProbe({ ...base, keyword: '192.0.2.8' });
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /Expected 192\.0\.2\.8 but got 192\.0\.2\.7/);
    const none = await dnsProbe({ ...base, dns_record_type: 'AAAA' });
    assert.equal(none.ok, false);
    assert.match(none.error, /No record of this type|ENODATA/);
  } finally {
    sock.close();
  }
});
