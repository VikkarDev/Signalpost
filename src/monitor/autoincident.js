// Incidents opened and resolved by the monitors themselves (opt-in per monitor).

import { get, run, tx } from '../db.js';
import { log } from '../lib/log.js';
import { formatDuration, formatTime } from '../lib/time.js';
import { notifyIncident } from '../notify/index.js';

function serviceName(m) {
  const comp = m.component_id ? get('SELECT name FROM components WHERE id = ?', m.component_id) : null;
  return comp ? comp.name : m.name;
}

/**
 * Call after every recorded check. Opens an incident once a monitor has been down for its
 * configured number of minutes, and resolves that incident when the monitor is back.
 */
export async function syncAutoIncident(rec, now = Date.now()) {
  const m = get('SELECT * FROM monitors WHERE id = ?', rec.monitor.id);
  if (!m) return;

  if (m.auto_incident_id) {
    const inc = get('SELECT id, status, resolved_at FROM incidents WHERE id = ?', m.auto_incident_id);
    if (!inc || inc.status === 'resolved') {
      // Someone resolved or deleted it by hand; a new outage may open a new one.
      if (m.state !== 'down') run('UPDATE monitors SET auto_incident_id = NULL WHERE id = ?', m.id);
      return;
    }
    if (m.state === 'up' || m.state === 'degraded') {
      const message = `${serviceName(m)} is responding again. Resolved automatically.`;
      tx(() => {
        run('INSERT INTO incident_updates (incident_id, status, message, created_at) VALUES (?, ?, ?, ?)', inc.id, 'resolved', message, now);
        run(`UPDATE incidents SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?`, now, now, inc.id);
        run('UPDATE monitors SET auto_incident_id = NULL WHERE id = ?', m.id);
      });
      log.info('automatic incident resolved', { incident: inc.id, monitor: m.name });
      await notifyIncident(inc.id, 'resolved', message);
    }
    return;
  }

  if (!m.auto_incident_minutes || m.state !== 'down' || !m.state_since || rec.inMaintenance) return;
  if (now - m.state_since < m.auto_incident_minutes * 60000) return;

  const name = serviceName(m);
  const message = `Our checks have been failing since ${formatTime(m.state_since)} (${formatDuration(now - m.state_since)}). This incident was opened automatically and will close when ${name} is back.`;
  const id = tx(() => {
    const iid = Number(
      run(`INSERT INTO incidents (title, status, impact, created_at, updated_at) VALUES (?, 'investigating', 'major', ?, ?)`, `${name} is down`, now, now)
        .lastInsertRowid,
    );
    if (m.component_id) run('INSERT INTO incident_components (incident_id, component_id) VALUES (?, ?)', iid, m.component_id);
    run(`INSERT INTO incident_updates (incident_id, status, message, created_at) VALUES (?, 'investigating', ?, ?)`, iid, message, now);
    run('UPDATE monitors SET auto_incident_id = ? WHERE id = ?', iid, m.id);
    return iid;
  });
  log.info('automatic incident opened', { incident: id, monitor: m.name });
  await notifyIncident(id, 'created', message);
}
