import { all, get, healthy } from '../db.js';
import { sendHtml, sendJson, HttpError } from '../lib/http.js';
import { publicStatus, pastIncidents, incidentUpdates, incidentComponentNames, OVERALL_LABELS } from '../status.js';
import { statusPage, incidentPage, historyPage } from '../views/public.js';
import { scheduler } from '../monitor/engine.js';

export function registerPublic(router) {
  router.get('/', (ctx) => {
    const data = publicStatus();
    sendHtml(ctx.res, 200, statusPage(data, pastIncidents(7)));
  });

  router.get('/incidents/:id', (ctx) => {
    const id = Number(ctx.params.id);
    const inc = Number.isInteger(id) ? get('SELECT * FROM incidents WHERE id = ?', id) : null;
    if (!inc) throw new HttpError(404, 'Incident not found');
    const full = { ...inc, updates: incidentUpdates(id), components: incidentComponentNames(id).map((c) => c.name) };
    sendHtml(ctx.res, 200, incidentPage(publicStatus().siteName, full));
  });

  router.get('/history', (ctx) => {
    const page = Math.max(1, Math.min(1000, Number.parseInt(ctx.query.get('page') || '1', 10) || 1));
    const per = 20;
    const rows = all('SELECT * FROM incidents ORDER BY created_at DESC LIMIT ? OFFSET ?', per + 1, (page - 1) * per);
    const items = rows.slice(0, per).map((i) => ({ ...i, updates: incidentUpdates(i.id), components: incidentComponentNames(i.id).map((c) => c.name) }));
    sendHtml(ctx.res, 200, historyPage(publicStatus().siteName, items, page, rows.length > per));
  });

  // Read-only public JSON. Exposes only component-level data (no internal hostnames or error text).
  router.get('/api/v1/status', (ctx) => {
    const d = publicStatus();
    sendJson(
      ctx.res,
      200,
      {
        page: { name: d.siteName, updated_at: new Date(d.generatedAt).toISOString() },
        status: { indicator: d.overall, description: OVERALL_LABELS[d.overall] },
        components: d.components.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description || null,
          status: c.state,
          uptime_90d: c.uptime === null ? null : Number((c.uptime * 100).toFixed(4)),
          response_ms: c.responseMs,
          last_checked_at: c.lastCheckAt ? new Date(c.lastCheckAt).toISOString() : null,
          history: c.days.map((x) => ({ day: x.day, status: x.state, uptime: x.uptime == null ? null : Number((x.uptime * 100).toFixed(4)) })),
        })),
        incidents: d.activeIncidents.map((i) => ({
          id: i.id,
          title: i.title,
          status: i.status,
          impact: i.impact,
          created_at: new Date(i.created_at).toISOString(),
          components: i.components,
          updates: i.updates.map((u) => ({ status: u.status, message: u.message, created_at: new Date(u.created_at).toISOString() })),
        })),
        maintenance: d.maintenances.map((m) => ({
          id: m.id,
          title: m.title,
          description: m.description,
          starts_at: new Date(m.starts_at).toISOString(),
          ends_at: new Date(m.ends_at).toISOString(),
          active: m.active,
          components: m.components,
        })),
      },
      { 'Access-Control-Allow-Origin': '*' },
    );
  });

  // Container health check: process up, DB answering, scheduler not stopped.
  router.get('/healthz', (ctx) => {
    const ok = healthy() && !scheduler.stopping;
    sendJson(ctx.res, ok ? 200 : 503, { status: ok ? 'ok' : 'unhealthy' });
  });
}
