import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localInputToTs, tsToLocalInput, dayKey, lastDays } from '../src/lib/time.js';
import { parseExpectedStatus } from '../src/monitor/probes.js';
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

test('migration 3 keeps existing alert rules and their delivery log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalpost-mig-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  for (const m of migrations.filter((m) => m.version <= 2)) {
    old.exec(m.sql);
    old.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, 0);
  }
  old.exec(`INSERT INTO alert_rules (id, name, channel, target, created_at, updated_at) VALUES (7, 'mail', 'email', 'a@b.se', 0, 0);
    INSERT INTO alert_log (rule_id, event, sent_at, ok) VALUES (7, 'test', 1, 1);`);
  old.close();

  openDatabase(file);
  try {
    assert.equal(dbAll('SELECT * FROM alert_rules')[0].target, 'a@b.se');
    assert.equal(dbAll('SELECT * FROM alert_log WHERE rule_id = 7').length, 1);
    assert.equal(dbAll('PRAGMA foreign_keys')[0].foreign_keys, 1);
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
