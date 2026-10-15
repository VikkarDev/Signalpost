import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localInputToTs, tsToLocalInput, dayKey, lastDays } from '../src/lib/time.js';
import { parseExpectedStatus } from '../src/monitor/probes.js';
import { liveComponentState, diagnose, formatUptime } from '../src/status.js';
import { html, raw } from '../src/lib/html.js';
import { DISCORD_WEBHOOK_RE, parseEmails } from '../src/notify/index.js';

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
