import fs from 'node:fs';
import path from 'node:path';
import { config, smtpConfigured } from '../config.js';
import { all, get, run, tx, getSetting, setSetting, backupTo } from '../db.js';
import { log } from '../lib/log.js';
import { sendHtml, redirect, HttpError, readForm } from '../lib/http.js';
import { localInputToTs } from '../lib/time.js';
import {
  loadSession,
  attemptLogin,
  createSession,
  destroySession,
  checkCsrf,
  adminExists,
  changePassword,
  revokeOtherSessions,
  listSessions,
} from '../auth.js';
import { scheduler } from '../monitor/engine.js';
import { parseExpectedStatus, HOST_RE } from '../monitor/probes.js';
import { liveComponentState, diagnose, monitorUptime, componentHistory, displaySettings, INCIDENT_STATUSES, INCIDENT_IMPACTS } from '../status.js';
import { notifyIncident, notifyMaintenance, sendTest, validateRuleTarget } from '../notify/index.js';
import { saveLogo, removeLogo, branding, saveFooterLinks } from '../branding.js';
import * as V from '../views/admin.js';

const FLASH = {
  saved: ['ok', 'Saved.'],
  created: ['ok', 'Created.'],
  deleted: ['ok', 'Deleted.'],
  checked: ['ok', 'Check completed.'],
  test_sent: ['ok', 'Test notification sent.'],
  test_failed: ['error', 'Test notification failed. The error is shown in the rules table.'],
  password: ['ok', 'Password changed. Other sessions were signed out.'],
  revoked: ['ok', 'All other sessions were signed out.'],
  posted: ['ok', 'Update posted.'],
  logo: ['ok', 'Logo updated.'],
  logo_removed: ['ok', 'Logo removed.'],
};

// ------------------------------------------------------------------ helpers

function str(form, key, max = 1000) {
  const v = form[key];
  return (Array.isArray(v) ? v[0] : v ?? '').toString().trim().slice(0, max);
}
function bool(form, key) {
  return str(form, key) === '1';
}
function intOrNull(form, key) {
  const s = str(form, key, 20);
  if (s === '') return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : NaN;
}
function idList(form, key) {
  const v = form[key];
  const arr = v === undefined ? [] : [].concat(v);
  return [...new Set(arr.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}
function idParam(ctx) {
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
  return id;
}
function mustGet(sql, id) {
  const row = get(sql, id);
  if (!row) throw new HttpError(404, 'Not found');
  return row;
}
function view(ctx) {
  const code = ctx.query.get('ok') || ctx.query.get('err');
  const f = code && FLASH[code];
  return { user: ctx.user, csrf: ctx.session.csrf_token, flash: f ? { type: f[0], text: f[1] } : null };
}
function existingComponentIds(ids) {
  if (!ids.length) return [];
  return all(`SELECT id FROM components WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).map((r) => r.id);
}
function components() {
  return all('SELECT * FROM components ORDER BY sort_order, name');
}

/** Wrap a handler: require a valid session; for POST also parse the form and verify CSRF. */
function auth(handler, formOptions = {}) {
  return async (ctx) => {
    const s = loadSession(ctx.req);
    if (!s) {
      if (ctx.req.method === 'GET') return redirect(ctx.res, `/admin/login?next=${encodeURIComponent(ctx.url.pathname)}`);
      throw new HttpError(401, 'Your session has expired. Please sign in again.');
    }
    ctx.user = s.user;
    ctx.session = s.session;
    if (ctx.req.method === 'POST') {
      ctx.form = await readForm(ctx.req, formOptions);
      if (!checkCsrf(ctx.session, str(ctx.form, '_csrf', 200))) {
        log.warn('csrf validation failed', { ip: ctx.ip, path: ctx.url.pathname });
        throw new HttpError(403, 'Invalid or missing form token. Reload the page and try again.');
      }
    }
    return handler(ctx);
  };
}

// ------------------------------------------------------------------ validation

const MONITOR_DEFAULTS = {
  name: '',
  component_id: null,
  type: 'http',
  scope: 'public',
  target: '',
  port: null,
  method: 'GET',
  expected_status: '200-399',
  keyword: '',
  ignore_tls: 0,
  follow_redirects: 1,
  interval_s: 60,
  timeout_ms: 10000,
  degraded_ms: null,
  failure_threshold: 2,
  enabled: 1,
};

function parseMonitor(form) {
  const errs = [];
  const m = {
    name: str(form, 'name', 100),
    component_id: intOrNull(form, 'component_id'),
    type: str(form, 'type', 10),
    scope: str(form, 'scope', 10),
    target: str(form, 'target', 2000),
    port: intOrNull(form, 'port'),
    method: str(form, 'method', 10) === 'HEAD' ? 'HEAD' : 'GET',
    expected_status: str(form, 'expected_status', 100) || '200-399',
    keyword: str(form, 'keyword', 200) || null,
    ignore_tls: bool(form, 'ignore_tls') ? 1 : 0,
    follow_redirects: bool(form, 'follow_redirects') ? 1 : 0,
    interval_s: intOrNull(form, 'interval_s'),
    timeout_ms: intOrNull(form, 'timeout_ms'),
    degraded_ms: intOrNull(form, 'degraded_ms'),
    failure_threshold: intOrNull(form, 'failure_threshold'),
    enabled: bool(form, 'enabled') ? 1 : 0,
  };
  if (!m.name) errs.push('Name is required.');
  if (!['http', 'tcp', 'ping'].includes(m.type)) errs.push('Choose a check type.');
  if (!['internal', 'public', 'canary'].includes(m.scope)) errs.push('Choose a scope.');
  if (m.component_id !== null && !get('SELECT id FROM components WHERE id = ?', m.component_id)) errs.push('Component does not exist.');
  if (m.type === 'http') {
    try {
      const u = new URL(m.target);
      if (!['http:', 'https:'].includes(u.protocol)) errs.push('URL must start with http:// or https://.');
      if (u.username || u.password) errs.push('Do not put credentials in the URL.');
    } catch {
      errs.push('Target must be a full URL, e.g. https://example.com.');
    }
    try {
      parseExpectedStatus(m.expected_status);
    } catch (e) {
      errs.push(e.message);
    }
    m.port = null;
  } else {
    if (!HOST_RE.test(m.target) || m.target.startsWith('-')) errs.push('Target must be a host name or IP address (no scheme or path).');
    m.keyword = null;
    if (m.type === 'tcp' && (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535)) errs.push('TCP checks need a port between 1 and 65535.');
    if (m.type === 'ping') m.port = null;
  }
  if (!Number.isInteger(m.interval_s) || m.interval_s < config.minCheckIntervalSeconds || m.interval_s > 86400) {
    errs.push(`Interval must be between ${config.minCheckIntervalSeconds} and 86400 seconds.`);
  }
  if (!Number.isInteger(m.timeout_ms) || m.timeout_ms < 500 || m.timeout_ms > 60000) errs.push('Timeout must be between 500 and 60000 ms.');
  else if (Number.isInteger(m.interval_s) && m.timeout_ms >= m.interval_s * 1000) errs.push('Timeout must be shorter than the interval.');
  if (m.degraded_ms !== null && (!Number.isInteger(m.degraded_ms) || m.degraded_ms < 1 || m.degraded_ms > 600000)) errs.push('Degraded threshold must be a positive number of ms.');
  if (!Number.isInteger(m.failure_threshold) || m.failure_threshold < 1 || m.failure_threshold > 20) errs.push('Failures before down must be 1–20.');
  return { m, errs };
}

function parseRule(form, isNew) {
  const errs = [];
  const r = {
    name: str(form, 'name', 100),
    channel: str(form, 'channel', 10),
    target: str(form, 'target', 2000),
    on_down: bool(form, 'on_down') ? 1 : 0,
    on_recovery: bool(form, 'on_recovery') ? 1 : 0,
    on_degraded: bool(form, 'on_degraded') ? 1 : 0,
    on_incident: bool(form, 'on_incident') ? 1 : 0,
    on_maintenance: bool(form, 'on_maintenance') ? 1 : 0,
    on_tls_expiry: bool(form, 'on_tls_expiry') ? 1 : 0,
    scopes: ['internal', 'public', 'canary'].filter((s) => bool(form, `scope_${s}`)).join(','),
    component_ids: existingComponentIds(idList(form, 'component_ids')).join(',') || null,
    repeat_minutes: intOrNull(form, 'repeat_minutes') ?? 0,
    enabled: bool(form, 'enabled') ? 1 : 0,
  };
  if (!r.name) errs.push('Name is required.');
  if (!['discord', 'email'].includes(r.channel)) errs.push('Choose a channel.');
  else if (isNew || r.target) {
    const problem = validateRuleTarget(r.channel, r.target);
    if (problem) errs.push(problem);
  }
  if (!r.scopes) errs.push('Select at least one monitor scope.');
  if (!Number.isInteger(r.repeat_minutes) || r.repeat_minutes < 0 || r.repeat_minutes > 10080) errs.push('Repeat must be 0–10080 minutes.');
  return { r, errs };
}

function maskTarget(rule) {
  if (rule.channel === 'discord') return rule.target.replace(/\/[\w-]+$/, '/••••••••');
  return rule.target;
}

// ------------------------------------------------------------------ routes

export function registerAdmin(router) {
  // ---------- auth
  router.get('/admin/login', (ctx) => {
    if (loadSession(ctx.req)) return redirect(ctx.res, '/admin');
    sendHtml(ctx.res, 200, V.loginPage({ adminMissing: !adminExists() }));
  });

  router.post('/admin/login', async (ctx) => {
    const form = await readForm(ctx.req);
    const username = str(form, 'username', 100);
    const result = await attemptLogin(username, str(form, 'password', 256), ctx.ip);
    if (result.error) {
      const headers = result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {};
      return sendHtml(ctx.res, result.retryAfter ? 429 : 401, V.loginPage({ error: result.error, username, adminMissing: !adminExists() }), headers);
    }
    createSession(ctx.req, ctx.res, result.user, ctx.ip);
    const next = ctx.query.get('next') || '';
    redirect(ctx.res, next.startsWith('/admin') ? next : '/admin');
  });

  router.post(
    '/admin/logout',
    auth((ctx) => {
      destroySession(ctx.req, ctx.res);
      redirect(ctx.res, '/admin/login');
    }),
  );

  // ---------- dashboard
  router.get(
    '/admin',
    auth((ctx) => {
      const monitors = all('SELECT * FROM monitors ORDER BY name');
      for (const m of monitors) {
        m.uptime24h = monitorUptime(m.id, 1);
        m.uptime30d = monitorUptime(m.id, 30);
      }
      const canaries = monitors.filter((m) => m.scope === 'canary');
      const comps = components().map((c) => {
        const ms = monitors.filter((m) => m.component_id === c.id && m.scope !== 'canary');
        return { ...c, monitors: ms, state: liveComponentState(ms), diagnosis: diagnose(ms, canaries) };
      });
      const enabled = monitors.filter((m) => m.enabled);
      const totals = {
        monitors: monitors.length,
        up: enabled.filter((m) => m.state === 'up').length,
        degraded: enabled.filter((m) => m.state === 'degraded').length,
        down: enabled.filter((m) => m.state === 'down').length,
        unknown: enabled.filter((m) => m.state === 'unknown').length,
      };
      sendHtml(
        ctx.res,
        200,
        V.dashboardPage(view(ctx), {
          components: comps,
          canaries,
          unassigned: monitors.filter((m) => !m.component_id && m.scope !== 'canary'),
          totals,
        }),
      );
    }),
  );

  // ---------- monitors
  router.get(
    '/admin/monitors',
    auth((ctx) => {
      const rows = all('SELECT m.*, c.name AS component_name FROM monitors m LEFT JOIN components c ON c.id = m.component_id ORDER BY c.sort_order, c.name, m.name');
      sendHtml(ctx.res, 200, V.monitorsPage(view(ctx), rows));
    }),
  );

  router.get(
    '/admin/monitors/new',
    auth((ctx) => {
      const cid = Number(ctx.query.get('component_id')) || null;
      sendHtml(ctx.res, 200, V.monitorFormPage(view(ctx), { monitor: { ...MONITOR_DEFAULTS, component_id: cid }, components: components(), isNew: true }));
    }),
  );

  router.post(
    '/admin/monitors',
    auth((ctx) => {
      const { m, errs } = parseMonitor(ctx.form);
      if (errs.length) return sendHtml(ctx.res, 422, V.monitorFormPage(view(ctx), { monitor: m, components: components(), errorList: errs, isNew: true }));
      const now = Date.now();
      const { lastInsertRowid } = run(
        `INSERT INTO monitors (name, component_id, type, scope, target, port, method, expected_status, keyword, ignore_tls,
           follow_redirects, interval_s, timeout_ms, degraded_ms, failure_threshold, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.name, m.component_id, m.type, m.scope, m.target, m.port, m.method, m.expected_status, m.keyword, m.ignore_tls,
        m.follow_redirects, m.interval_s, m.timeout_ms, m.degraded_ms, m.failure_threshold, m.enabled, now, now,
      );
      const id = Number(lastInsertRowid);
      scheduler.reload(id);
      log.info('monitor created', { id, name: m.name, by: ctx.user.username });
      redirect(ctx.res, `/admin/monitors/${id}?ok=created`);
    }),
  );

  router.get(
    '/admin/monitors/:id',
    auth((ctx) => {
      const id = idParam(ctx);
      const m = mustGet('SELECT * FROM monitors WHERE id = ?', id);
      sendHtml(
        ctx.res,
        200,
        V.monitorDetailPage(view(ctx), {
          monitor: m,
          component: m.component_id ? get('SELECT id, name FROM components WHERE id = ?', m.component_id) : null,
          checks: all('SELECT * FROM checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 50', id),
          uptime: { d1: monitorUptime(id, 1), d7: monitorUptime(id, 7), d30: monitorUptime(id, 30), d90: monitorUptime(id, 90) },
          history: componentHistory([id]),
        }),
      );
    }),
  );

  router.get(
    '/admin/monitors/:id/edit',
    auth((ctx) => {
      const m = mustGet('SELECT * FROM monitors WHERE id = ?', idParam(ctx));
      sendHtml(ctx.res, 200, V.monitorFormPage(view(ctx), { monitor: m, components: components(), isNew: false }));
    }),
  );

  router.post(
    '/admin/monitors/:id',
    auth((ctx) => {
      const id = idParam(ctx);
      const existing = mustGet('SELECT * FROM monitors WHERE id = ?', id);
      const { m, errs } = parseMonitor(ctx.form);
      if (errs.length) {
        return sendHtml(ctx.res, 422, V.monitorFormPage(view(ctx), { monitor: { ...m, id }, components: components(), errorList: errs, isNew: false }));
      }
      // If what is being checked changed, the previous state no longer applies.
      const targetChanged = existing.type !== m.type || existing.target !== m.target || existing.port !== m.port;
      run(
        `UPDATE monitors SET name = ?, component_id = ?, type = ?, scope = ?, target = ?, port = ?, method = ?, expected_status = ?,
           keyword = ?, ignore_tls = ?, follow_redirects = ?, interval_s = ?, timeout_ms = ?, degraded_ms = ?, failure_threshold = ?,
           enabled = ?, updated_at = ?${targetChanged ? ", state = 'unknown', state_since = NULL, consecutive_failures = 0, tls_expires_at = NULL" : ''}
         WHERE id = ?`,
        m.name, m.component_id, m.type, m.scope, m.target, m.port, m.method, m.expected_status, m.keyword, m.ignore_tls,
        m.follow_redirects, m.interval_s, m.timeout_ms, m.degraded_ms, m.failure_threshold, m.enabled, Date.now(), id,
      );
      if (!m.enabled) run(`UPDATE monitors SET state = 'unknown', state_since = NULL, consecutive_failures = 0 WHERE id = ?`, id);
      scheduler.reload(id);
      log.info('monitor updated', { id, name: m.name, by: ctx.user.username });
      redirect(ctx.res, `/admin/monitors/${id}?ok=saved`);
    }),
  );

  router.post(
    '/admin/monitors/:id/toggle',
    auth((ctx) => {
      const id = idParam(ctx);
      const m = mustGet('SELECT * FROM monitors WHERE id = ?', id);
      if (m.enabled) run(`UPDATE monitors SET enabled = 0, state = 'unknown', state_since = NULL, consecutive_failures = 0, updated_at = ? WHERE id = ?`, Date.now(), id);
      else run('UPDATE monitors SET enabled = 1, updated_at = ? WHERE id = ?', Date.now(), id);
      scheduler.reload(id);
      log.info(m.enabled ? 'monitor disabled' : 'monitor enabled', { id, by: ctx.user.username });
      const back = ctx.req.headers.referer?.includes('/admin/monitors/') ? `/admin/monitors/${id}` : '/admin/monitors';
      redirect(ctx.res, `${back}?ok=saved`);
    }),
  );

  router.post(
    '/admin/monitors/:id/check',
    auth(async (ctx) => {
      const id = idParam(ctx);
      mustGet('SELECT id FROM monitors WHERE id = ?', id);
      await scheduler.checkNow(id);
      redirect(ctx.res, `/admin/monitors/${id}?ok=checked`);
    }),
  );

  router.post(
    '/admin/monitors/:id/delete',
    auth((ctx) => {
      const id = idParam(ctx);
      const m = mustGet('SELECT * FROM monitors WHERE id = ?', id);
      scheduler.remove(id);
      run('DELETE FROM monitors WHERE id = ?', id);
      log.info('monitor deleted', { id, name: m.name, by: ctx.user.username });
      redirect(ctx.res, '/admin/monitors?ok=deleted');
    }),
  );

  // ---------- components
  router.get(
    '/admin/components',
    auth((ctx) => {
      const rows = all('SELECT c.*, (SELECT COUNT(*) FROM monitors m WHERE m.component_id = c.id) AS monitor_count FROM components c ORDER BY sort_order, name');
      sendHtml(ctx.res, 200, V.componentsPage(view(ctx), rows));
    }),
  );

  router.get(
    '/admin/components/new',
    auth((ctx) => {
      const next = (get('SELECT MAX(sort_order) AS s FROM components').s ?? 0) + 10;
      sendHtml(ctx.res, 200, V.componentFormPage(view(ctx), { component: { name: '', description: '', group_name: '', sort_order: next, visible: 1 }, groups: groupNames(), isNew: true }));
    }),
  );

  const groupNames = () => all("SELECT DISTINCT group_name AS g FROM components WHERE group_name != '' ORDER BY g").map((r) => r.g);

  const parseComponent = (form) => {
    const c = {
      name: str(form, 'name', 80),
      description: str(form, 'description', 300),
      group_name: str(form, 'group_name', 60),
      sort_order: intOrNull(form, 'sort_order') ?? 0,
      visible: bool(form, 'visible') ? 1 : 0,
    };
    const errs = [];
    if (!c.name) errs.push('Name is required.');
    if (!Number.isInteger(c.sort_order)) errs.push('Sort order must be a whole number.');
    return { c, errs };
  };

  router.post(
    '/admin/components',
    auth((ctx) => {
      const { c, errs } = parseComponent(ctx.form);
      if (errs.length) return sendHtml(ctx.res, 422, V.componentFormPage(view(ctx), { component: c, groups: groupNames(), errorList: errs, isNew: true }));
      const now = Date.now();
      const { lastInsertRowid } = run(
        'INSERT INTO components (name, description, group_name, sort_order, visible, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        c.name, c.description, c.group_name, c.sort_order, c.visible, now, now,
      );
      log.info('component created', { id: Number(lastInsertRowid), name: c.name, by: ctx.user.username });
      redirect(ctx.res, `/admin/components/${lastInsertRowid}?ok=created`);
    }),
  );

  router.get(
    '/admin/components/:id',
    auth((ctx) => {
      const id = idParam(ctx);
      const c = mustGet('SELECT * FROM components WHERE id = ?', id);
      const monitors = all('SELECT * FROM monitors WHERE component_id = ? ORDER BY name', id);
      sendHtml(ctx.res, 200, V.componentFormPage(view(ctx), { component: c, groups: groupNames(), isNew: false, monitors }));
    }),
  );

  router.post(
    '/admin/components/:id',
    auth((ctx) => {
      const id = idParam(ctx);
      mustGet('SELECT id FROM components WHERE id = ?', id);
      const { c, errs } = parseComponent(ctx.form);
      if (errs.length) return sendHtml(ctx.res, 422, V.componentFormPage(view(ctx), { component: { ...c, id }, groups: groupNames(), errorList: errs, isNew: false }));
      run(
        'UPDATE components SET name = ?, description = ?, group_name = ?, sort_order = ?, visible = ?, updated_at = ? WHERE id = ?',
        c.name, c.description, c.group_name, c.sort_order, c.visible, Date.now(), id,
      );
      redirect(ctx.res, `/admin/components/${id}?ok=saved`);
    }),
  );

  router.post(
    '/admin/components/:id/move',
    auth((ctx) => {
      const id = idParam(ctx);
      const list = components();
      const idx = list.findIndex((c) => c.id === id);
      if (idx < 0) throw new HttpError(404, 'Not found');
      const swap = str(ctx.form, 'dir') === 'up' ? idx - 1 : idx + 1;
      if (swap >= 0 && swap < list.length) {
        [list[idx], list[swap]] = [list[swap], list[idx]];
        tx(() => list.forEach((c, i) => run('UPDATE components SET sort_order = ? WHERE id = ?', (i + 1) * 10, c.id)));
      }
      redirect(ctx.res, '/admin/components');
    }),
  );

  router.post(
    '/admin/components/:id/delete',
    auth((ctx) => {
      const id = idParam(ctx);
      const c = mustGet('SELECT * FROM components WHERE id = ?', id);
      run('DELETE FROM components WHERE id = ?', id);
      log.info('component deleted', { id, name: c.name, by: ctx.user.username });
      redirect(ctx.res, '/admin/components?ok=deleted');
    }),
  );

  // ---------- incidents
  router.get(
    '/admin/incidents',
    auth((ctx) => {
      sendHtml(ctx.res, 200, V.incidentsPage(view(ctx), all('SELECT * FROM incidents ORDER BY (status = \'resolved\'), created_at DESC LIMIT 200')));
    }),
  );

  router.get(
    '/admin/incidents/new',
    auth((ctx) => {
      sendHtml(ctx.res, 200, V.incidentNewPage(view(ctx), { components: components(), values: { status: 'investigating', impact: 'minor', component_ids: [] } }));
    }),
  );

  router.post(
    '/admin/incidents',
    auth((ctx) => {
      const f = ctx.form;
      const values = {
        title: str(f, 'title', 200),
        status: str(f, 'status', 20),
        impact: str(f, 'impact', 20),
        message: str(f, 'message', 5000),
        component_ids: existingComponentIds(idList(f, 'component_ids')),
        notify: bool(f, 'notify'),
      };
      const errs = [];
      if (!values.title) errs.push('Title is required.');
      if (!INCIDENT_STATUSES.includes(values.status) || values.status === 'resolved') errs.push('Choose a status.');
      if (!INCIDENT_IMPACTS.includes(values.impact)) errs.push('Choose an impact.');
      if (!values.message) errs.push('A message is required.');
      if (errs.length) return sendHtml(ctx.res, 422, V.incidentNewPage(view(ctx), { components: components(), values, errorList: errs }));
      const now = Date.now();
      const id = tx(() => {
        const iid = Number(
          run('INSERT INTO incidents (title, status, impact, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', values.title, values.status, values.impact, now, now)
            .lastInsertRowid,
        );
        for (const cid of values.component_ids) run('INSERT INTO incident_components (incident_id, component_id) VALUES (?, ?)', iid, cid);
        run('INSERT INTO incident_updates (incident_id, status, message, created_at) VALUES (?, ?, ?, ?)', iid, values.status, values.message, now);
        return iid;
      });
      log.info('incident created', { id, title: values.title, by: ctx.user.username });
      if (values.notify) notifyIncident(id, 'created', values.message).catch((err) => log.error('incident notification failed', { err }));
      redirect(ctx.res, `/admin/incidents/${id}?ok=created`);
    }),
  );

  const incidentView = (ctx, id, errorList) => {
    const incident = mustGet('SELECT * FROM incidents WHERE id = ?', id);
    return V.incidentDetailPage(view(ctx), {
      incident,
      updates: all('SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at DESC, id DESC', id),
      components: components(),
      selected: all('SELECT component_id FROM incident_components WHERE incident_id = ?', id).map((r) => r.component_id),
      errorList,
    });
  };

  router.get(
    '/admin/incidents/:id',
    auth((ctx) => sendHtml(ctx.res, 200, incidentView(ctx, idParam(ctx)))),
  );

  router.post(
    '/admin/incidents/:id',
    auth((ctx) => {
      const id = idParam(ctx);
      mustGet('SELECT id FROM incidents WHERE id = ?', id);
      const title = str(ctx.form, 'title', 200);
      const impact = str(ctx.form, 'impact', 20);
      const errs = [];
      if (!title) errs.push('Title is required.');
      if (!INCIDENT_IMPACTS.includes(impact)) errs.push('Choose an impact.');
      if (errs.length) return sendHtml(ctx.res, 422, incidentView(ctx, id, errs));
      const ids = existingComponentIds(idList(ctx.form, 'component_ids'));
      tx(() => {
        run('UPDATE incidents SET title = ?, impact = ?, updated_at = ? WHERE id = ?', title, impact, Date.now(), id);
        run('DELETE FROM incident_components WHERE incident_id = ?', id);
        for (const cid of ids) run('INSERT INTO incident_components (incident_id, component_id) VALUES (?, ?)', id, cid);
      });
      redirect(ctx.res, `/admin/incidents/${id}?ok=saved`);
    }),
  );

  router.post(
    '/admin/incidents/:id/updates',
    auth((ctx) => {
      const id = idParam(ctx);
      const inc = mustGet('SELECT * FROM incidents WHERE id = ?', id);
      const status = str(ctx.form, 'status', 20);
      const message = str(ctx.form, 'message', 5000);
      const errs = [];
      if (!INCIDENT_STATUSES.includes(status)) errs.push('Choose a status.');
      if (!message) errs.push('A message is required.');
      if (errs.length) return sendHtml(ctx.res, 422, incidentView(ctx, id, errs));
      const now = Date.now();
      tx(() => {
        run('INSERT INTO incident_updates (incident_id, status, message, created_at) VALUES (?, ?, ?, ?)', id, status, message, now);
        const resolvedAt = status === 'resolved' ? (inc.resolved_at ?? now) : null;
        run('UPDATE incidents SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?', status, resolvedAt, now, id);
      });
      log.info('incident updated', { id, status, by: ctx.user.username });
      if (bool(ctx.form, 'notify')) {
        notifyIncident(id, status === 'resolved' ? 'resolved' : 'updated', message).catch((err) => log.error('incident notification failed', { err }));
      }
      redirect(ctx.res, `/admin/incidents/${id}?ok=posted`);
    }),
  );

  router.post(
    '/admin/incidents/:id/updates/:uid/delete',
    auth((ctx) => {
      const id = idParam(ctx);
      const uid = Number(ctx.params.uid);
      tx(() => {
        run('DELETE FROM incident_updates WHERE id = ? AND incident_id = ?', uid, id);
        // Keep the incident's status consistent with its latest remaining update.
        const latest = get('SELECT status, created_at FROM incident_updates WHERE incident_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', id);
        if (latest) {
          run('UPDATE incidents SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?', latest.status, latest.status === 'resolved' ? latest.created_at : null, Date.now(), id);
        }
      });
      redirect(ctx.res, `/admin/incidents/${id}?ok=deleted`);
    }),
  );

  router.post(
    '/admin/incidents/:id/delete',
    auth((ctx) => {
      const id = idParam(ctx);
      mustGet('SELECT id FROM incidents WHERE id = ?', id);
      run('DELETE FROM incidents WHERE id = ?', id);
      log.info('incident deleted', { id, by: ctx.user.username });
      redirect(ctx.res, '/admin/incidents?ok=deleted');
    }),
  );

  // ---------- maintenance
  router.get(
    '/admin/maintenance',
    auth((ctx) => {
      const items = all('SELECT * FROM maintenances ORDER BY (ends_at < ?), starts_at DESC LIMIT 200', Date.now()).map((m) => ({
        ...m,
        components: all('SELECT c.name FROM maintenance_components mc JOIN components c ON c.id = mc.component_id WHERE mc.maintenance_id = ?', m.id)
          .map((r) => r.name)
          .join(', '),
      }));
      sendHtml(ctx.res, 200, V.maintenancePage(view(ctx), items));
    }),
  );

  router.get(
    '/admin/maintenance/new',
    auth((ctx) => {
      const start = Math.ceil(Date.now() / 3600000) * 3600000;
      sendHtml(ctx.res, 200, V.maintenanceFormPage(view(ctx), { item: { title: '', description: '', starts_at: start, ends_at: start + 3600000 }, components: components(), selected: [], isNew: true }));
    }),
  );

  const parseMaintenance = (form) => {
    const item = {
      title: str(form, 'title', 200),
      description: str(form, 'description', 5000),
      starts_at: localInputToTs(str(form, 'starts_at', 30)),
      ends_at: localInputToTs(str(form, 'ends_at', 30)),
    };
    const selected = existingComponentIds(idList(form, 'component_ids'));
    const errs = [];
    if (!item.title) errs.push('Title is required.');
    if (item.starts_at === null) errs.push('Start time is invalid.');
    if (item.ends_at === null) errs.push('End time is invalid.');
    if (item.starts_at !== null && item.ends_at !== null && item.ends_at <= item.starts_at) errs.push('End must be after start.');
    if (!selected.length) errs.push('Select at least one affected component.');
    if (item.starts_at === null) item.starts_at = str(form, 'starts_at', 30);
    if (item.ends_at === null) item.ends_at = str(form, 'ends_at', 30);
    return { item, selected, errs };
  };

  router.post(
    '/admin/maintenance',
    auth((ctx) => {
      const { item, selected, errs } = parseMaintenance(ctx.form);
      if (errs.length) return sendHtml(ctx.res, 422, V.maintenanceFormPage(view(ctx), { item, components: components(), selected, errorList: errs, isNew: true }));
      const now = Date.now();
      const id = tx(() => {
        const mid = Number(
          run('INSERT INTO maintenances (title, description, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', item.title, item.description, item.starts_at, item.ends_at, now, now)
            .lastInsertRowid,
        );
        for (const cid of selected) run('INSERT INTO maintenance_components (maintenance_id, component_id) VALUES (?, ?)', mid, cid);
        return mid;
      });
      log.info('maintenance scheduled', { id, title: item.title, by: ctx.user.username });
      if (bool(ctx.form, 'notify')) notifyMaintenance(id).catch((err) => log.error('maintenance notification failed', { err }));
      redirect(ctx.res, '/admin/maintenance?ok=created');
    }),
  );

  router.get(
    '/admin/maintenance/:id',
    auth((ctx) => {
      const id = idParam(ctx);
      const item = mustGet('SELECT * FROM maintenances WHERE id = ?', id);
      const selected = all('SELECT component_id FROM maintenance_components WHERE maintenance_id = ?', id).map((r) => r.component_id);
      sendHtml(ctx.res, 200, V.maintenanceFormPage(view(ctx), { item, components: components(), selected, isNew: false }));
    }),
  );

  router.post(
    '/admin/maintenance/:id',
    auth((ctx) => {
      const id = idParam(ctx);
      mustGet('SELECT id FROM maintenances WHERE id = ?', id);
      const { item, selected, errs } = parseMaintenance(ctx.form);
      if (errs.length) return sendHtml(ctx.res, 422, V.maintenanceFormPage(view(ctx), { item: { ...item, id }, components: components(), selected, errorList: errs, isNew: false }));
      tx(() => {
        run('UPDATE maintenances SET title = ?, description = ?, starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?', item.title, item.description, item.starts_at, item.ends_at, Date.now(), id);
        run('DELETE FROM maintenance_components WHERE maintenance_id = ?', id);
        for (const cid of selected) run('INSERT INTO maintenance_components (maintenance_id, component_id) VALUES (?, ?)', id, cid);
      });
      redirect(ctx.res, '/admin/maintenance?ok=saved');
    }),
  );

  router.post(
    '/admin/maintenance/:id/delete',
    auth((ctx) => {
      const id = idParam(ctx);
      run('DELETE FROM maintenances WHERE id = ?', id);
      redirect(ctx.res, '/admin/maintenance?ok=deleted');
    }),
  );

  // ---------- alerts
  router.get(
    '/admin/alerts',
    auth((ctx) => {
      const recent = all(
        `SELECT a.*, r.name AS rule_name, m.name AS monitor_name FROM alert_log a
         LEFT JOIN alert_rules r ON r.id = a.rule_id LEFT JOIN monitors m ON m.id = a.monitor_id
         ORDER BY a.sent_at DESC LIMIT 25`,
      );
      sendHtml(ctx.res, 200, V.alertsPage(view(ctx), { rules: all('SELECT * FROM alert_rules ORDER BY name'), smtpOk: smtpConfigured(), recent }));
    }),
  );

  router.get(
    '/admin/alerts/new',
    auth((ctx) => {
      const rule = { name: '', channel: 'discord', target: '', on_down: 1, on_recovery: 1, on_degraded: 0, on_incident: 1, on_maintenance: 0, on_tls_expiry: 1, scopes: 'internal,public,canary', component_ids: null, repeat_minutes: 0, enabled: 1 };
      sendHtml(ctx.res, 200, V.alertFormPage(view(ctx), { rule, components: components(), isNew: true }));
    }),
  );

  router.post(
    '/admin/alerts',
    auth((ctx) => {
      const { r, errs } = parseRule(ctx.form, true);
      if (errs.length) return sendHtml(ctx.res, 422, V.alertFormPage(view(ctx), { rule: r, components: components(), errorList: errs, isNew: true }));
      const now = Date.now();
      const { lastInsertRowid } = run(
        `INSERT INTO alert_rules (name, channel, target, on_down, on_recovery, on_degraded, on_incident, on_maintenance, on_tls_expiry,
           scopes, component_ids, repeat_minutes, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r.name, r.channel, r.target, r.on_down, r.on_recovery, r.on_degraded, r.on_incident, r.on_maintenance, r.on_tls_expiry,
        r.scopes, r.component_ids, r.repeat_minutes, r.enabled, now, now,
      );
      log.info('alert rule created', { id: Number(lastInsertRowid), channel: r.channel, by: ctx.user.username });
      redirect(ctx.res, '/admin/alerts?ok=created');
    }),
  );

  router.get(
    '/admin/alerts/:id',
    auth((ctx) => {
      const rule = mustGet('SELECT * FROM alert_rules WHERE id = ?', idParam(ctx));
      sendHtml(ctx.res, 200, V.alertFormPage(view(ctx), { rule: { ...rule, masked_target: maskTarget(rule) }, components: components(), isNew: false }));
    }),
  );

  router.post(
    '/admin/alerts/:id',
    auth((ctx) => {
      const id = idParam(ctx);
      const existing = mustGet('SELECT * FROM alert_rules WHERE id = ?', id);
      const { r, errs } = parseRule(ctx.form, false);
      if (!r.target && r.channel !== existing.channel) errs.push('Enter a destination when changing the channel.');
      if (errs.length) {
        return sendHtml(ctx.res, 422, V.alertFormPage(view(ctx), { rule: { ...r, id, masked_target: maskTarget(existing) }, components: components(), errorList: errs, isNew: false }));
      }
      run(
        `UPDATE alert_rules SET name = ?, channel = ?, target = ?, on_down = ?, on_recovery = ?, on_degraded = ?, on_incident = ?, on_maintenance = ?,
           on_tls_expiry = ?, scopes = ?, component_ids = ?, repeat_minutes = ?, enabled = ?, updated_at = ? WHERE id = ?`,
        r.name, r.channel, r.target || existing.target, r.on_down, r.on_recovery, r.on_degraded, r.on_incident, r.on_maintenance,
        r.on_tls_expiry, r.scopes, r.component_ids, r.repeat_minutes, r.enabled, Date.now(), id,
      );
      redirect(ctx.res, '/admin/alerts?ok=saved');
    }),
  );

  router.post(
    '/admin/alerts/:id/test',
    auth(async (ctx) => {
      const id = idParam(ctx);
      mustGet('SELECT id FROM alert_rules WHERE id = ?', id);
      const result = await sendTest(id);
      redirect(ctx.res, `/admin/alerts?${result.ok ? 'ok=test_sent' : 'err=test_failed'}`);
    }),
  );

  router.post(
    '/admin/alerts/:id/delete',
    auth((ctx) => {
      run('DELETE FROM alert_rules WHERE id = ?', idParam(ctx));
      redirect(ctx.res, '/admin/alerts?ok=deleted');
    }),
  );

  // ---------- settings
  const settingsView = (ctx, errorList, footerLinksText) => {
    let dbSize = 'unknown';
    try {
      const file = path.join(config.dataDir, 'signalpost.db');
      const bytes = fs.statSync(file).size + (fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0);
      dbSize = `${(bytes / 1048576).toFixed(1)} MB`;
    } catch {
      /* ignore */
    }
    return V.settingsPage(view(ctx), {
      siteName: getSetting('site_name', config.siteNameDefault),
      heading: getSetting('heading', 'Services'),
      footerLinks: footerLinksText ?? getSetting('footer_links', ''),
      logoVersion: branding().logoVersion,
      display: displaySettings(),
      sessions: listSessions(ctx.user.id).map((s) => ({ ...s, current: s.id_hash === ctx.session.id_hash })),
      info: {
        sqlite: get('SELECT sqlite_version() AS v').v,
        dbSize,
        checkCount: get('SELECT COUNT(*) AS n FROM checks').n,
        smtp: smtpConfigured() ? `${config.smtp.host}:${config.smtp.port} as ${config.smtp.from}` : 'not configured',
      },
      errorList,
    });
  };

  router.get(
    '/admin/settings',
    auth((ctx) => sendHtml(ctx.res, 200, settingsView(ctx))),
  );

  router.post(
    '/admin/settings',
    auth((ctx) => {
      const siteName = str(ctx.form, 'site_name', 60);
      const heading = str(ctx.form, 'heading', 80);
      const footerLinks = str(ctx.form, 'footer_links', 3000);
      if (!siteName || !heading) return sendHtml(ctx.res, 422, settingsView(ctx, ['Site name and heading are required.'], footerLinks));
      const linkErrors = saveFooterLinks(footerLinks);
      if (linkErrors.length) return sendHtml(ctx.res, 422, settingsView(ctx, linkErrors, footerLinks));
      setSetting('site_name', siteName);
      setSetting('heading', heading);
      redirect(ctx.res, '/admin/settings?ok=saved');
    }),
  );

  router.post(
    '/admin/settings/display',
    auth((ctx) => {
      const f = ctx.form;
      const historyDays = Number(str(f, 'history_days', 4));
      const orange = Number(str(f, 'orange_below', 10));
      const red = Number(str(f, 'red_below', 10));
      const errs = [];
      if (![30, 60, 90].includes(historyDays)) errs.push('History must be 30, 60 or 90 days.');
      if (!Number.isFinite(orange) || orange < 0 || orange > 100) errs.push('"Orange below" must be between 0 and 100.');
      if (!Number.isFinite(red) || red < 0 || red > 100) errs.push('"Red below" must be between 0 and 100.');
      if (!errs.length && red > orange) errs.push('"Red below" can\'t be higher than "Orange below".');
      if (errs.length) return sendHtml(ctx.res, 422, settingsView(ctx, errs));
      setSetting('layout', ['list', 'cards'].includes(str(f, 'layout', 10)) ? str(f, 'layout', 10) : 'grid');
      setSetting('history_days', historyDays);
      const rawHours = str(f, 'recovered_hours', 3);
      const recoveredHours = rawHours === '' ? 3 : Number(rawHours);
      setSetting('recovered_hours', [0, 1, 3, 6, 12, 24].includes(recoveredHours) ? recoveredHours : 3);
      setSetting('orange_below', orange);
      setSetting('red_below', red);
      for (const key of ['slow_counts_as_up', 'show_uptime', 'show_response_time', 'show_last_checked', 'show_descriptions']) {
        setSetting(key, bool(f, key) ? '1' : '0');
      }
      redirect(ctx.res, '/admin/settings?ok=saved');
    }),
  );

  router.post(
    '/admin/branding/logo',
    auth(
      (ctx) => {
        const file = ctx.form._files?.logo;
        const problem = saveLogo(file?.data);
        if (problem) return sendHtml(ctx.res, 422, settingsView(ctx, [problem]));
        log.info('logo updated', { by: ctx.user.username, bytes: file.data.length });
        redirect(ctx.res, '/admin/settings?ok=logo');
      },
      { allowFiles: true, maxBytes: 400 * 1024 },
    ),
  );

  router.post(
    '/admin/branding/logo/delete',
    auth((ctx) => {
      removeLogo();
      redirect(ctx.res, '/admin/settings?ok=logo_removed');
    }),
  );

  router.post(
    '/admin/password',
    auth(async (ctx) => {
      const next = str(ctx.form, 'next', 256);
      if (next !== str(ctx.form, 'confirm', 256)) return sendHtml(ctx.res, 422, settingsView(ctx, ['New passwords do not match.']));
      const problem = await changePassword(ctx.user.id, str(ctx.form, 'current', 256), next);
      if (problem) return sendHtml(ctx.res, 422, settingsView(ctx, [problem]));
      revokeOtherSessions(ctx.user.id, ctx.session.id_hash);
      log.info('password changed', { username: ctx.user.username, ip: ctx.ip });
      redirect(ctx.res, '/admin/settings?ok=password');
    }),
  );

  router.post(
    '/admin/sessions/revoke',
    auth((ctx) => {
      revokeOtherSessions(ctx.user.id, ctx.session.id_hash);
      redirect(ctx.res, '/admin/settings?ok=revoked');
    }),
  );

  router.post(
    '/admin/backup',
    auth((ctx) => {
      const tmp = path.join(config.dataDir, `.backup-${process.pid}-${Date.now()}.db`);
      backupTo(tmp);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const stat = fs.statSync(tmp);
      ctx.res.writeHead(200, {
        'Content-Type': 'application/vnd.sqlite3',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="signalpost-${stamp}.db"`,
        'Cache-Control': 'no-store',
      });
      const stream = fs.createReadStream(tmp);
      stream.pipe(ctx.res);
      const cleanup = () => fs.rm(tmp, { force: true }, () => {});
      stream.on('close', cleanup);
      stream.on('error', cleanup);
      log.info('database backup downloaded', { by: ctx.user.username, ip: ctx.ip });
    }),
  );
}
