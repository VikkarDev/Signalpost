// Component status, uptime and history, all computed from stored check results.
// Days without any checks come back as 'nodata'.

import { all, get, getSetting } from './db.js';
import { config } from './config.js';
import { lastDays, dayKey, DAY_MS } from './lib/time.js';

export const HISTORY_DAYS = 90;

export const COMPONENT_STATES = {
  operational: { label: 'Operational', rank: 0 },
  maintenance: { label: 'Under maintenance', rank: 1 },
  degraded: { label: 'Degraded performance', rank: 2 },
  partial_outage: { label: 'Partial outage', rank: 3 },
  major_outage: { label: 'Major outage', rank: 4 },
  unknown: { label: 'No data yet', rank: -1 },
};

export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'];
export const INCIDENT_IMPACTS = ['none', 'minor', 'major', 'critical'];
const IMPACT_TO_STATE = { none: null, minor: 'degraded', major: 'partial_outage', critical: 'major_outage' };

function worse(a, b) {
  if (!a) return b;
  if (!b) return a;
  return COMPONENT_STATES[b].rank > COMPONENT_STATES[a].rank ? b : a;
}

/** Component ids that have a maintenance window active at `now`. */
export function maintenanceComponentIds(now = Date.now()) {
  return new Set(
    all(
      `SELECT DISTINCT mc.component_id AS id FROM maintenances m
       JOIN maintenance_components mc ON mc.maintenance_id = m.id
       WHERE m.starts_at <= ? AND m.ends_at > ?`,
      now,
      now,
    ).map((r) => r.id),
  );
}

/** Live state of a component from its (non-canary, enabled) monitors. */
export function liveComponentState(monitors) {
  const relevant = monitors.filter((m) => m.enabled && m.scope !== 'canary');
  const known = relevant.filter((m) => m.state !== 'unknown');
  if (!known.length) return 'unknown';
  const down = known.filter((m) => m.state === 'down');
  const publicMonitors = known.filter((m) => m.scope === 'public');
  if (down.length === known.length) return 'major_outage';
  if (publicMonitors.length && publicMonitors.every((m) => m.state === 'down')) return 'major_outage';
  if (down.length) return 'partial_outage';
  if (known.some((m) => m.state === 'degraded')) return 'degraded';
  return 'operational';
}

/**
 * Explain *where* a failure is, using internal vs public vs canary monitors.
 * Returns null when everything is fine.
 */
export function diagnose(monitors, canaries) {
  const rel = monitors.filter((m) => m.enabled && m.scope !== 'canary');
  const internal = rel.filter((m) => m.scope === 'internal');
  const pub = rel.filter((m) => m.scope === 'public');
  const internalDown = internal.some((m) => m.state === 'down');
  const pubDown = pub.filter((m) => m.state === 'down');
  const knownCanaries = canaries.filter((c) => c.enabled && c.state !== 'unknown');
  const canariesDown = knownCanaries.length > 0 && knownCanaries.every((c) => c.state === 'down');

  if (internalDown) {
    return { kind: 'application', text: 'Application failure: the internal check is failing, so the service itself is down or unhealthy.' };
  }
  if (!pubDown.length) return null;
  const errors = pubDown.map((m) => m.last_error || '').join(' ');
  if (canariesDown) {
    return { kind: 'internet', text: 'Internet connectivity problem at the NAS: all canary checks are failing too.' };
  }
  const internalUp = internal.length > 0 && internal.every((m) => m.state === 'up' || m.state === 'degraded');
  if (/DNS lookup failed/i.test(errors)) {
    return {
      kind: 'dns',
      text: internalUp
        ? 'DNS problem: the public hostname does not resolve, but the internal check is healthy.'
        : 'DNS problem: the public hostname does not resolve.',
    };
  }
  if (/Cloudflare/i.test(errors)) {
    return {
      kind: 'cloudflare',
      text: internalUp
        ? 'Cloudflare / tunnel problem: Cloudflare cannot reach the origin, but the internal check is healthy.'
        : 'Cloudflare reports it cannot reach the origin (tunnel or application down).',
    };
  }
  if (internalUp) {
    return { kind: 'edge', text: 'External path problem (Cloudflare tunnel, DNS or internet): the application itself is healthy internally.' };
  }
  return {
    kind: 'unknown',
    text: 'Unreachable via the public URL. Add an internal monitor for this component to tell application failures from network failures.',
  };
}

export const DISPLAY_DEFAULTS = Object.freeze({
  historyDays: 90,
  orangeBelow: 100,
  redBelow: 99,
  slowCountsAsUp: true,
  showUptime: true,
  showResponseTime: true,
  showLastChecked: true,
  showDescriptions: true,
  layout: 'grid',
});

/** Admin-configurable display options (Settings -> Display). */
export function displaySettings() {
  const num = (key, def) => {
    const v = Number(getSetting(key, ''));
    return getSetting(key) === null || !Number.isFinite(v) ? def : v;
  };
  const flag = (key, def) => {
    const v = getSetting(key);
    return v === null ? def : v === '1';
  };
  const d = DISPLAY_DEFAULTS;
  const historyDays = num('history_days', d.historyDays);
  return {
    historyDays: [30, 60, 90].includes(historyDays) ? historyDays : d.historyDays,
    orangeBelow: num('orange_below', d.orangeBelow),
    redBelow: num('red_below', d.redBelow),
    slowCountsAsUp: flag('slow_counts_as_up', d.slowCountsAsUp),
    showUptime: flag('show_uptime', d.showUptime),
    showResponseTime: flag('show_response_time', d.showResponseTime),
    showLastChecked: flag('show_last_checked', d.showLastChecked),
    showDescriptions: flag('show_descriptions', d.showDescriptions),
    layout: getSetting('layout') === 'list' ? 'list' : d.layout,
  };
}

const okCount = (r, opts) => r.up + (opts.slowCountsAsUp ? r.degraded : 0);

function dayState(d, opts) {
  const counted = d.up + d.degraded + d.down;
  if (!counted) return d.maintenance ? 'maintenance' : 'nodata';
  const pct = (okCount(d, opts) / counted) * 100;
  if (pct < opts.redBelow) return 'major_outage';
  if (pct < opts.orangeBelow) return 'partial_outage';
  return d.degraded ? 'degraded' : 'operational';
}

/** Per-day history and uptime over the period for a set of monitors. */
export function componentHistory(monitorIds, days = HISTORY_DAYS, now = Date.now(), opts = displaySettings()) {
  const dayList = lastDays(days, now);
  if (!monitorIds.length) {
    return { days: dayList.map((day) => ({ day, state: 'nodata' })), uptime: null };
  }
  const placeholders = monitorIds.map(() => '?').join(',');
  const rows = all(
    `SELECT monitor_id, day, up, degraded, down, maintenance, response_sum, response_count
     FROM daily_stats WHERE monitor_id IN (${placeholders}) AND day >= ?`,
    ...monitorIds,
    dayList[0],
  );
  const byDay = new Map();
  const perMonitor = new Map();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(r);
    const t = perMonitor.get(r.monitor_id) || { ok: 0, total: 0 };
    t.ok += okCount(r, opts);
    t.total += r.up + r.degraded + r.down;
    perMonitor.set(r.monitor_id, t);
  }

  const result = dayList.map((day) => {
    const list = byDay.get(day);
    if (!list) return { day, state: 'nodata' };
    // Worst monitor of the day determines the day's uptime and colour.
    let worst = null;
    let maintenance = 0;
    let checks = 0;
    let down = 0;
    for (const r of list) {
      maintenance += r.maintenance;
      const counted = r.up + r.degraded + r.down;
      checks += counted;
      down += r.down;
      if (!counted) continue;
      const ratio = okCount(r, opts) / counted;
      if (!worst || ratio < worst.ratio || (ratio === worst.ratio && r.degraded > worst.r.degraded)) worst = { ratio, r };
    }
    const state = worst ? dayState(worst.r, opts) : maintenance ? 'maintenance' : 'nodata';
    return {
      day,
      state,
      uptime: worst ? worst.ratio : null,
      checks,
      down,
      maintenance,
    };
  });

  let uptime = null;
  for (const t of perMonitor.values()) {
    if (!t.total) continue;
    const ratio = t.ok / t.total;
    uptime = uptime === null ? ratio : Math.min(uptime, ratio);
  }
  return { days: result, uptime };
}

export function formatUptime(ratio) {
  if (ratio === null || ratio === undefined) return null;
  const pct = ratio * 100;
  if (pct >= 99.995 && ratio < 1) return '99.99%';
  if (ratio === 1) return '100%';
  return `${(Math.floor(pct * 100) / 100).toFixed(2)}%`;
}

function activeIncidentsWithComponents() {
  const incidents = all(`SELECT * FROM incidents WHERE status != 'resolved' ORDER BY created_at DESC`);
  const links = all(
    `SELECT ic.incident_id, ic.component_id FROM incident_components ic
     JOIN incidents i ON i.id = ic.incident_id WHERE i.status != 'resolved'`,
  );
  for (const inc of incidents) inc.component_ids = links.filter((l) => l.incident_id === inc.id).map((l) => l.component_id);
  return incidents;
}

export function incidentUpdates(incidentId) {
  return all('SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at DESC, id DESC', incidentId);
}

export function incidentComponentNames(incidentId) {
  return all(
    `SELECT c.id, c.name FROM incident_components ic JOIN components c ON c.id = ic.component_id
     WHERE ic.incident_id = ? ORDER BY c.sort_order, c.name`,
    incidentId,
  );
}

/** Everything the public page and public API need. */
export function publicStatus(now = Date.now()) {
  const components = all('SELECT * FROM components WHERE visible = 1 ORDER BY sort_order, name');
  const monitors = all('SELECT * FROM monitors');
  const maint = maintenanceComponentIds(now);
  const active = activeIncidentsWithComponents();
  const opts = displaySettings();

  // Incidents per day (for history tooltips), limited to the visible window.
  const since = now - (opts.historyDays + 1) * DAY_MS;
  const recentIncidents = all(
    `SELECT i.id, i.title, i.impact, i.created_at, i.resolved_at, ic.component_id
     FROM incidents i JOIN incident_components ic ON ic.incident_id = i.id
     WHERE i.created_at >= ? OR i.resolved_at IS NULL OR i.resolved_at >= ?`,
    since,
    since,
  );

  const out = components.map((c) => {
    const ms = monitors.filter((m) => m.component_id === c.id && m.enabled);
    let state = liveComponentState(ms);
    if (maint.has(c.id)) state = state === 'unknown' || state === 'operational' ? 'maintenance' : state;
    for (const inc of active) {
      if (inc.component_ids.includes(c.id)) state = worse(state === 'unknown' ? null : state, IMPACT_TO_STATE[inc.impact]) || state;
    }
    const nonCanary = ms.filter((m) => m.scope !== 'canary');
    const history = componentHistory(nonCanary.map((m) => m.id), opts.historyDays, now, opts);

    if (!opts.showUptime) for (const d of history.days) d.uptime = null;
    const incs = recentIncidents.filter((i) => i.component_id === c.id);
    for (const d of history.days) {
      const dayIncs = incs.filter((i) => {
        const startDay = dayKey(i.created_at);
        const endDay = i.resolved_at ? dayKey(i.resolved_at) : dayKey(now);
        return d.day >= startDay && d.day <= endDay;
      });
      if (dayIncs.length) d.incidents = dayIncs.map((i) => ({ id: i.id, title: i.title, impact: i.impact }));
    }

    const primary = nonCanary.find((m) => m.scope === 'public' && m.last_check_at) || nonCanary.find((m) => m.last_check_at);
    return {
      id: c.id,
      name: c.name,
      description: opts.showDescriptions ? c.description : '',
      group: c.group_name || null,
      state,
      stateLabel: COMPONENT_STATES[state].label,
      uptime: opts.showUptime ? history.uptime : null,
      uptimeLabel: opts.showUptime ? formatUptime(history.uptime) : null,
      days: history.days,
      responseMs: opts.showResponseTime && primary ? primary.last_response_ms : null,
      lastCheckAt: opts.showLastChecked ? nonCanary.reduce((acc, m) => Math.max(acc, m.last_check_at || 0), 0) || null : null,
    };
  });

  let overall;
  if (!out.length) overall = 'none';
  else {
    const known = out.filter((c) => c.state !== 'unknown');
    if (!known.length) overall = 'unknown';
    else overall = known.reduce((acc, c) => worse(acc, c.state), 'operational');
  }

  const maintenances = all(
    `SELECT * FROM maintenances WHERE ends_at > ? ORDER BY starts_at ASC LIMIT 20`,
    now,
  ).map((m) => ({
    ...m,
    active: m.starts_at <= now,
    components: all(
      `SELECT c.name FROM maintenance_components mc JOIN components c ON c.id = mc.component_id
       WHERE mc.maintenance_id = ? ORDER BY c.sort_order, c.name`,
      m.id,
    ).map((r) => r.name),
  }));

  const activeIncidents = active.map((i) => ({
    ...i,
    updates: incidentUpdates(i.id),
    components: incidentComponentNames(i.id).map((c) => c.name),
  }));

  return {
    siteName: getSetting('site_name', config.siteNameDefault),
    heading: getSetting('heading', 'Services'),
    overall,
    components: out,
    activeIncidents,
    maintenances,
    generatedAt: now,
    display: opts,
  };
}

export const OVERALL_LABELS = {
  operational: 'All Systems Operational',
  degraded: 'Degraded Performance',
  partial_outage: 'Partial System Outage',
  major_outage: 'Major System Outage',
  maintenance: 'Scheduled Maintenance in Progress',
  unknown: 'Collecting data, no checks completed yet',
  none: 'No services configured yet',
};

/** Resolved incidents from the last `days` days, newest first. */
export function pastIncidents(days = 14, now = Date.now(), limit = 50) {
  return all(
    `SELECT * FROM incidents WHERE status = 'resolved' AND created_at >= ? ORDER BY created_at DESC LIMIT ?`,
    now - days * DAY_MS,
    limit,
  ).map((i) => ({ ...i, updates: incidentUpdates(i.id), components: incidentComponentNames(i.id).map((c) => c.name) }));
}

export function monitorUptime(monitorId, sinceDays, now = Date.now()) {
  const fromDay = lastDays(sinceDays, now)[0];
  const r = get(
    `SELECT SUM(up) AS up, SUM(degraded) AS degraded, SUM(down) AS down
     FROM daily_stats WHERE monitor_id = ? AND day >= ?`,
    monitorId,
    fromDay,
  );
  const total = (r.up || 0) + (r.degraded || 0) + (r.down || 0);
  return total ? okCount({ up: r.up || 0, degraded: r.degraded || 0 }, displaySettings()) / total : null;
}
