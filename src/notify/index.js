// Alert rules -> Discord webhooks, SMTP email, ntfy and generic JSON webhooks.

import nodemailer from 'nodemailer';
import { config, smtpConfigured } from '../config.js';
import { all, get, run, getSetting } from '../db.js';
import { log } from '../lib/log.js';
import { formatDateTime, formatDuration } from '../lib/time.js';
import { diagnose } from '../status.js';

export const DISCORD_WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,30}\/[\w-]{20,200}$/;
// https://ntfy.sh/my-topic or a self-hosted server, possibly under a sub-path.
export const NTFY_TOPIC_RE = /^[\w-]{1,64}$/;
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

// ntfy priority (1-5) and tags (shown as emoji in the app) per kind of message.
const NTFY = {
  down: { priority: 5, tags: ['rotating_light'] },
  recovery: { priority: 3, tags: ['white_check_mark'] },
  degraded: { priority: 4, tags: ['warning'] },
  incident: { priority: 4, tags: ['warning'] },
  resolved: { priority: 3, tags: ['white_check_mark'] },
  maintenance: { priority: 3, tags: ['wrench'] },
  info: { priority: 3, tags: ['information_source'] },
};

const COLORS = { down: 0xd73a49, recovery: 0x2da44e, degraded: 0xdbab09, incident: 0xe36209, resolved: 0x2da44e, maintenance: 0x0969da, info: 0x6e7781 };

export function parseEmails(text) {
  const list = String(text || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = list.filter((e) => !EMAIL_RE.test(e) || e.length > 254);
  return { list, bad };
}

function httpUrl(text) {
  try {
    const u = new URL(text);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u : null;
  } catch {
    return null;
  }
}

/** Splits a topic URL into the server's publish endpoint and the topic name. */
export function ntfyEndpoint(target) {
  const u = httpUrl(target);
  if (!u || u.search || u.hash) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const topic = parts.pop();
  if (!topic || !NTFY_TOPIC_RE.test(topic)) return null;
  return { url: `${u.origin}/${parts.map((p) => `${p}/`).join('')}`, topic };
}

export function validateRuleTarget(channel, target) {
  if (channel === 'discord') {
    return DISCORD_WEBHOOK_RE.test(target) ? null : 'Enter a valid Discord webhook URL (https://discord.com/api/webhooks/…).';
  }
  if (channel === 'email') {
    const { list, bad } = parseEmails(target);
    if (!list.length) return 'Enter at least one email address.';
    if (bad.length) return `Invalid email address: ${bad[0]}`;
    if (list.length > 20) return 'At most 20 recipients per rule.';
    return null;
  }
  if (channel === 'ntfy') {
    return ntfyEndpoint(target) ? null : 'Enter the topic URL, e.g. https://ntfy.sh/my-servers (letters, digits, - and _ only).';
  }
  if (channel === 'webhook') {
    return httpUrl(target) ? null : 'Enter an http:// or https:// URL (put credentials in the token field, not the URL).';
  }
  return 'Unknown channel.';
}

const siteName = () => getSetting('site_name', config.siteNameDefault);

let transporter = null;
function mailer() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
  }
  return transporter;
}

async function sendDiscord(url, msg) {
  const body = JSON.stringify({
    username: siteName(),
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: msg.title.slice(0, 256),
        description: msg.text.slice(0, 4000),
        color: COLORS[msg.kind] ?? COLORS.info,
        url: msg.url,
        fields: (msg.fields || []).slice(0, 10).map((f) => ({ name: f.name.slice(0, 256), value: String(f.value).slice(0, 1024) || '—', inline: f.inline ?? true })),
        timestamp: new Date().toISOString(),
        footer: { text: siteName() },
      },
    ],
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (res.ok) return;
    if (res.status === 429 && attempt === 0) {
      const data = await res.json().catch(() => ({}));
      const wait = Math.min(10000, Math.ceil((Number(data.retry_after) || 1) * 1000));
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`Discord responded with HTTP ${res.status}`);
  }
}

async function postJson(url, payload, token, what) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`${what} responded with HTTP ${res.status}`);
}

async function sendNtfy(target, token, msg) {
  const { url, topic } = ntfyEndpoint(target);
  const style = NTFY[msg.kind] ?? NTFY.info;
  const lines = [msg.text, ...(msg.fields || []).map((f) => `${f.name}: ${f.value}`)].filter(Boolean);
  // JSON publishing instead of headers, so titles with non-ASCII characters work.
  await postJson(
    url,
    {
      topic,
      title: `${msg.title} · ${siteName()}`.slice(0, 250),
      message: lines.join('\n').slice(0, 4000),
      priority: style.priority,
      tags: style.tags,
      ...(msg.url ? { click: msg.url } : {}),
    },
    token,
    'ntfy',
  );
}

async function sendWebhook(target, token, msg, event) {
  await postJson(
    target,
    {
      site: siteName(),
      event,
      kind: msg.kind,
      title: msg.title,
      message: msg.text,
      url: msg.url || null,
      fields: Object.fromEntries((msg.fields || []).map((f) => [f.name, String(f.value)])),
      sent_at: new Date().toISOString(),
      // Slack and Mattermost incoming webhooks only read this one.
      text: [msg.title, msg.text].filter(Boolean).join('\n'),
    },
    token,
    'Webhook',
  );
}

async function sendEmail(recipients, msg) {
  if (!smtpConfigured()) throw new Error('SMTP is not configured (set SMTP_HOST and SMTP_FROM)');
  const lines = [msg.text, '', ...(msg.fields || []).map((f) => `${f.name}: ${f.value}`)];
  if (msg.url) lines.push('', msg.url);
  await mailer().sendMail({
    from: config.smtp.from,
    to: recipients.join(', '),
    subject: `[${siteName()}] ${msg.title}`,
    text: lines.join('\n'),
  });
}

async function deliver(rule, msg, { monitorId = null, event }) {
  let ok = true;
  let error = null;
  try {
    if (rule.channel === 'discord') await sendDiscord(rule.target, msg);
    else if (rule.channel === 'ntfy') await sendNtfy(rule.target, rule.token, msg);
    else if (rule.channel === 'webhook') await sendWebhook(rule.target, rule.token, msg, event);
    else await sendEmail(parseEmails(rule.target).list, msg);
  } catch (err) {
    ok = false;
    error = String(err.message || err).slice(0, 300);
    log.warn('alert delivery failed', { rule: rule.name, ruleId: rule.id, channel: rule.channel, event, error });
  }
  const now = Date.now();
  try {
    run('INSERT INTO alert_log (rule_id, monitor_id, event, sent_at, ok, error) VALUES (?, ?, ?, ?, ?, ?)', rule.id, monitorId, event, now, ok, error);
    run('UPDATE alert_rules SET last_sent_at = ?, last_error = ? WHERE id = ?', now, error, rule.id);
  } catch (err) {
    log.error('could not record alert result', { err });
  }
  if (ok) log.info('alert sent', { rule: rule.name, ruleId: rule.id, channel: rule.channel, event });
  return { ok, error };
}

function ruleMatchesComponents(rule, componentIds) {
  if (!rule.component_ids) return true;
  const wanted = rule.component_ids.split(',').map(Number).filter(Boolean);
  if (!wanted.length) return true;
  return componentIds.some((id) => wanted.includes(id));
}

function rulesFor(flag) {
  // `flag` is one of a fixed set of column names (never user input).
  return all(`SELECT * FROM alert_rules WHERE enabled = 1 AND ${flag} = 1`);
}

function monitorRules(flag, monitor) {
  return rulesFor(flag).filter(
    (r) => r.scopes.split(',').includes(monitor.scope) && ruleMatchesComponents(r, monitor.component_id ? [monitor.component_id] : []),
  );
}

function monitorFields(m) {
  const comp = m.component_id ? get('SELECT name FROM components WHERE id = ?', m.component_id) : null;
  return [
    { name: 'Monitor', value: m.name },
    { name: 'Component', value: comp ? comp.name : '—' },
    { name: 'Check', value: `${m.type === 'push' ? 'Heartbeat' : m.type.toUpperCase()} (${m.scope})` },
    { name: 'Target', value: m.type === 'tcp' ? `${m.target}:${m.port}` : m.target, inline: false },
  ];
}

function diagnosisFor(m) {
  if (!m.component_id) return null;
  const siblings = all('SELECT * FROM monitors WHERE component_id = ?', m.component_id);
  const canaries = all(`SELECT * FROM monitors WHERE scope = 'canary'`);
  return diagnose(siblings, canaries);
}

export async function notifyMonitorTransition(rec) {
  const { monitor: m, previousState: prev, newState: next } = rec;
  const adminUrl = `${config.publicUrl}/admin/monitors/${m.id}`;
  let event = null;
  if (next === 'down' && prev !== 'down') event = 'down';
  else if (prev === 'down' && (next === 'up' || next === 'degraded')) event = 'recovery';
  else if (next === 'degraded' && prev === 'up') event = 'degraded';

  if (event) {
    const flag = { down: 'on_down', recovery: 'on_recovery', degraded: 'on_degraded' }[event];
    const rules = monitorRules(flag, m);
    if (!rules.length) return;
    const diag = event === 'down' ? diagnosisFor(m) : null;
    const downtime = event === 'recovery' && rec.previousStateSince ? Date.now() - rec.previousStateSince : null;
    const msg = {
      kind: event,
      title:
        event === 'down' ? `${m.name} is down` : event === 'recovery' ? `${m.name} is back up` : `${m.name} is slow`,
      text:
        event === 'down'
          ? `${m.last_error || 'Check failed'}${diag ? `\n\n${diag.text}` : ''}`
          : event === 'recovery'
            ? downtime ? `Was down for ${formatDuration(downtime)}.` : 'Back to normal.'
            : `Responded in ${m.last_response_ms} ms (limit ${m.degraded_ms} ms).`,
      fields: [...monitorFields(m), { name: 'Time', value: formatDateTime(Date.now()) }],
      url: adminUrl,
    };
    await Promise.all(rules.map((r) => deliver(r, msg, { monitorId: m.id, event })));
    return;
  }

  // Reminders while a monitor stays down.
  if (next === 'down' && prev === 'down') {
    const now = Date.now();
    const rules = monitorRules('on_down', m).filter((r) => r.repeat_minutes > 0);
    for (const r of rules) {
      const last = get(
        `SELECT MAX(sent_at) AS t FROM alert_log WHERE rule_id = ? AND monitor_id = ? AND event IN ('down', 'reminder') AND ok = 1`,
        r.id,
        m.id,
      ).t;
      if (last && now - last < r.repeat_minutes * 60000) continue;
      if (!last && m.state_since && now - m.state_since < r.repeat_minutes * 60000) continue;
      await deliver(
        r,
        {
          kind: 'down',
          title: `${m.name} is still down`,
          text: `Down for ${formatDuration(now - (m.state_since || now))}. Last error: ${m.last_error || 'unknown'}`,
          fields: monitorFields(m),
          url: adminUrl,
        },
        { monitorId: m.id, event: 'reminder' },
      );
    }
  }
}

export async function notifyTlsExpiry(m, expiresAt) {
  const rules = monitorRules('on_tls_expiry', m);
  const now = Date.now();
  for (const r of rules) {
    const last = get(`SELECT MAX(sent_at) AS t FROM alert_log WHERE rule_id = ? AND monitor_id = ? AND event = 'tls_expiry'`, r.id, m.id).t;
    if (last && now - last < 24 * 3600000) continue;
    const days = Math.floor((expiresAt - now) / 86400000);
    await deliver(
      r,
      {
        kind: 'degraded',
        title: `TLS certificate for ${m.name} ${days < 0 ? 'has expired' : days === 1 ? 'expires tomorrow' : `expires in ${days} days`}`,
        text: `Certificate expiry: ${formatDateTime(expiresAt)}`,
        fields: monitorFields(m),
        url: `${config.publicUrl}/admin/monitors/${m.id}`,
      },
      { monitorId: m.id, event: 'tls_expiry' },
    );
  }
}

export async function notifyIncident(incidentId, kind, message) {
  const inc = get('SELECT * FROM incidents WHERE id = ?', incidentId);
  if (!inc) return;
  const compIds = all('SELECT component_id FROM incident_components WHERE incident_id = ?', incidentId).map((r) => r.component_id);
  const names = compIds.length
    ? all(`SELECT name FROM components WHERE id IN (${compIds.map(() => '?').join(',')})`, ...compIds).map((r) => r.name)
    : [];
  const rules = rulesFor('on_incident').filter((r) => !compIds.length || ruleMatchesComponents(r, compIds));
  const titles = { created: 'New incident', updated: 'Incident update', resolved: 'Incident resolved' };
  const msg = {
    kind: kind === 'resolved' ? 'resolved' : 'incident',
    title: `${titles[kind]}: ${inc.title}`,
    text: message || '',
    fields: [
      { name: 'Status', value: inc.status },
      { name: 'Impact', value: inc.impact },
      { name: 'Affected', value: names.join(', ') || '—', inline: false },
    ],
    url: `${config.publicUrl}/incidents/${inc.id}`,
  };
  await Promise.all(rules.map((r) => deliver(r, msg, { event: `incident_${kind}` })));
}

export async function notifyMaintenance(maintenanceId) {
  const mt = get('SELECT * FROM maintenances WHERE id = ?', maintenanceId);
  if (!mt) return;
  const compIds = all('SELECT component_id FROM maintenance_components WHERE maintenance_id = ?', maintenanceId).map((r) => r.component_id);
  const rules = rulesFor('on_maintenance').filter((r) => !compIds.length || ruleMatchesComponents(r, compIds));
  const msg = {
    kind: 'maintenance',
    title: `Scheduled maintenance: ${mt.title}`,
    text: mt.description || '',
    fields: [
      { name: 'Starts', value: formatDateTime(mt.starts_at) },
      { name: 'Ends', value: formatDateTime(mt.ends_at) },
    ],
    url: config.publicUrl,
  };
  await Promise.all(rules.map((r) => deliver(r, msg, { event: 'maintenance' })));
}

export async function sendTest(ruleId) {
  const rule = get('SELECT * FROM alert_rules WHERE id = ?', ruleId);
  if (!rule) return { ok: false, error: 'Rule not found' };
  return deliver(
    rule,
    {
      kind: 'info',
      title: 'Test notification',
      text: `Test message for alert rule "${rule.name}". If you can read this, delivery works.`,
      fields: [{ name: 'Time', value: formatDateTime(Date.now()) }],
      url: config.publicUrl,
    },
    { event: 'test' },
  );
}

export function closeMailer() {
  if (transporter) transporter.close();
  transporter = null;
}
