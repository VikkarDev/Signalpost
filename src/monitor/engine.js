// Check scheduler and result recording.

import { config } from '../config.js';
import { get, all, run, tx } from '../db.js';
import { log } from '../lib/log.js';
import { dayKey, DAY_MS } from '../lib/time.js';
import { runProbe } from './probes.js';
import { notifyMonitorTransition, notifyTlsExpiry } from '../notify/index.js';
import { maintenanceComponentIds } from '../status.js';
import { syncAutoIncident } from './autoincident.js';

const TLS_WARN_DAYS = 14;

/**
 * Persist one probe result: raw check row, daily aggregate, and monitor state.
 * Returns { monitor (updated), previousState, newState, inMaintenance }.
 */
export function recordCheck(monitorId, result, now = Date.now()) {
  return tx(() => {
    const m = get('SELECT * FROM monitors WHERE id = ?', monitorId);
    if (!m) return null;
    const inMaintenance = m.component_id != null && maintenanceComponentIds(now).has(m.component_id);

    let status;
    if (!result.ok) status = 'down';
    else if (m.degraded_ms && result.responseMs != null && result.responseMs > m.degraded_ms) status = 'degraded';
    else status = 'up';

    const failures = status === 'down' ? m.consecutive_failures + 1 : 0;
    let newState;
    if (status !== 'down') newState = status;
    else if (failures >= m.failure_threshold) newState = 'down';
    else newState = m.state; // not enough consecutive failures yet

    const error = result.error ? String(result.error).slice(0, 500) : null;
    run(
      `INSERT INTO checks (monitor_id, checked_at, status, response_ms, status_code, error, in_maintenance)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      m.id,
      now,
      status,
      result.responseMs ?? null,
      result.statusCode ?? null,
      error,
      inMaintenance ? 1 : 0,
    );

    const day = dayKey(now);
    const col = inMaintenance ? 'maintenance' : status; // whitelisted column names only
    const hasRt = !inMaintenance && result.ok && result.responseMs != null;
    run(
      `INSERT INTO daily_stats (monitor_id, day, ${col}, response_sum, response_count)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(monitor_id, day) DO UPDATE SET
         ${col} = ${col} + 1,
         response_sum = response_sum + excluded.response_sum,
         response_count = response_count + excluded.response_count`,
      m.id,
      day,
      hasRt ? result.responseMs : 0,
      hasRt ? 1 : 0,
    );

    const stateSince = newState !== m.state ? now : m.state_since;
    run(
      `UPDATE monitors SET state = ?, state_since = ?, consecutive_failures = ?, last_check_at = ?,
         last_response_ms = ?, last_status_code = ?, last_error = ?, tls_expires_at = COALESCE(?, tls_expires_at)
       WHERE id = ?`,
      newState,
      stateSince,
      failures,
      now,
      result.responseMs ?? null,
      result.statusCode ?? null,
      error,
      result.tlsExpiresAt ?? null,
      m.id,
    );

    return {
      monitor: { ...m, state: newState, state_since: stateSince, last_error: error, last_response_ms: result.responseMs },
      previousState: m.state,
      previousStateSince: m.state_since,
      newState,
      inMaintenance,
      tlsExpiresAt: result.tlsExpiresAt,
    };
  });
}

class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise((r) => this.queue.push(r));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export class Scheduler {
  constructor() {
    this.timers = new Map();
    this.inFlight = new Set();
    this.sem = new Semaphore(config.maxConcurrentChecks);
    this.stopping = false;
    this.housekeepingTimer = null;
  }

  start() {
    const monitors = all('SELECT id, interval_s FROM monitors WHERE enabled = 1');
    for (const m of monitors) {
      // Spread initial checks out so a restart doesn't fire everything at once.
      this.schedule(m.id, Math.random() * Math.min(m.interval_s * 1000, 15000));
    }
    this.housekeepingTimer = setInterval(() => this.housekeeping(), 3600000);
    this.housekeepingTimer.unref();
    setTimeout(() => this.housekeeping(), 30000).unref();
    log.info('scheduler started', { monitors: monitors.length, maxConcurrent: config.maxConcurrentChecks });
  }

  schedule(id, delayMs) {
    if (this.stopping) return;
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => this.execute(id), Math.max(0, delayMs)),
    );
  }

  /** Call after a monitor is created, edited, enabled or disabled. */
  reload(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const m = get('SELECT enabled FROM monitors WHERE id = ?', id);
    if (m && m.enabled) this.schedule(id, 1000);
  }

  remove(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  /** Run a check immediately (admin "Check now"); resolves with the record result. */
  async checkNow(id) {
    return this.execute(id, { manual: true });
  }

  async execute(id, { manual = false } = {}) {
    if (this.stopping) return null;
    const work = (async () => {
      await this.sem.acquire();
      try {
        const m = get('SELECT * FROM monitors WHERE id = ?', id);
        if (!m || (!m.enabled && !manual)) return null;
        let result;
        try {
          result = await runProbe(m);
        } catch (err) {
          result = { ok: false, responseMs: null, error: `Internal probe error: ${err.message}` };
        }
        if (result === null) return null; // heartbeat monitor that isn't overdue: nothing to record
        const rec = recordCheck(id, result);
        if (!rec) return null;
        log.debug('check completed', { monitor: m.name, id, ok: result.ok, ms: result.responseMs, error: result.error });
        if (rec.previousState !== rec.newState) {
          log.info('monitor state changed', {
            monitor: m.name,
            id,
            from: rec.previousState,
            to: rec.newState,
            error: rec.monitor.last_error,
          });
        }
        this.afterCheck(rec).catch((err) => log.error('notification dispatch failed', { err }));
        return rec;
      } finally {
        this.sem.release();
      }
    })();
    this.inFlight.add(work);
    try {
      return await work;
    } catch (err) {
      log.error('check failed unexpectedly', { id, err });
      return null;
    } finally {
      this.inFlight.delete(work);
      if (!manual && !this.stopping) {
        const m = get('SELECT interval_s, enabled FROM monitors WHERE id = ?', id);
        if (m && m.enabled) this.schedule(id, m.interval_s * 1000);
        else this.timers.delete(id);
      }
    }
  }

  /** A heartbeat arrived at /api/push/<token>. */
  async recordPush(m, result) {
    const now = Date.now();
    run('UPDATE monitors SET last_push_at = ? WHERE id = ?', now, m.id);
    const rec = recordCheck(m.id, result, now);
    if (rec && rec.previousState !== rec.newState) {
      log.info('monitor state changed', { monitor: m.name, id: m.id, from: rec.previousState, to: rec.newState, error: rec.monitor.last_error });
    }
    if (rec) this.afterCheck(rec).catch((err) => log.error('notification dispatch failed', { err }));
    return rec;
  }

  async afterCheck(rec) {
    await syncAutoIncident(rec).catch((err) => log.error('automatic incident failed', { err }));
    if (rec.inMaintenance) return; // alerts are suppressed during maintenance
    await notifyMonitorTransition(rec);
    if (rec.tlsExpiresAt && rec.tlsExpiresAt - Date.now() < TLS_WARN_DAYS * DAY_MS) {
      await notifyTlsExpiry(rec.monitor, rec.tlsExpiresAt);
    }
  }

  housekeeping() {
    try {
      const now = Date.now();
      const rawCut = now - config.rawRetentionDays * DAY_MS;
      const dailyCut = dayKey(now - config.dailyRetentionDays * DAY_MS);
      const c = run('DELETE FROM checks WHERE checked_at < ?', rawCut).changes;
      const d = run('DELETE FROM daily_stats WHERE day < ?', dailyCut).changes;
      run('DELETE FROM alert_log WHERE sent_at < ?', now - 90 * DAY_MS);
      run('DELETE FROM sessions WHERE expires_at <= ?', now);
      log.info('housekeeping completed', { prunedChecks: Number(c), prunedDays: Number(d) });
    } catch (err) {
      log.error('housekeeping failed', { err });
    }
  }

  async stop(timeoutMs) {
    this.stopping = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    clearInterval(this.housekeepingTimer);
    if (this.inFlight.size) {
      log.info('waiting for in-flight checks', { count: this.inFlight.size });
      await Promise.race([Promise.allSettled([...this.inFlight]), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
    }
  }
}

export const scheduler = new Scheduler();
