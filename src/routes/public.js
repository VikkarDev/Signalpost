import { config } from '../config.js';
import { escape } from '../lib/html.js';
import { getLogo } from '../branding.js';
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
        page: { name: d.siteName, updated_at: new Date(d.generatedAt).toISOString(), history_days: d.display.historyDays },
        status: { indicator: d.overall, description: OVERALL_LABELS[d.overall] },
        components: d.components.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description || null,
          group: c.group,
          status: c.liveState,
          last_failure_at: c.lastFailureAt ? new Date(c.lastFailureAt).toISOString() : null,
          uptime_percent: c.uptime === null ? null : Number((c.uptime * 100).toFixed(4)),
          // kept for older API users; only filled when the page shows 90 days
          uptime_90d: c.uptime === null || d.display.historyDays !== 90 ? null : Number((c.uptime * 100).toFixed(4)),
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

  // Atom feed of incidents and maintenance, for RSS readers and RSS-to-Discord bots.
  router.get('/feed.xml', (ctx) => {
    const base = config.publicUrl;
    const siteName = publicStatus().siteName;
    const entries = [
      ...all('SELECT * FROM incidents ORDER BY updated_at DESC LIMIT 30').map((i) => {
        const updates = incidentUpdates(i.id);
        const comps = incidentComponentNames(i.id).map((c) => c.name);
        const label = i.status[0].toUpperCase() + i.status.slice(1);
        const body =
          (comps.length ? `<p>Affects: ${escape(comps.join(', '))}</p>` : '') +
          updates
            .map((u) => `<p><strong>${escape(u.status)}</strong> (${escape(new Date(u.created_at).toISOString())}): ${escape(u.message).replace(/\r?\n/g, '<br>')}</p>`)
            .join('');
        return { id: `${base}/incidents/${i.id}`, link: `${base}/incidents/${i.id}`, title: `[${label}] ${i.title}`, published: i.created_at, updated: i.updated_at, body };
      }),
      ...all('SELECT * FROM maintenances ORDER BY updated_at DESC LIMIT 20').map((m) => ({
        id: `${base}/maintenance/${m.id}`,
        link: `${base}/`,
        title: `Maintenance: ${m.title}`,
        published: m.created_at,
        updated: m.updated_at,
        body: `<p>${escape(new Date(m.starts_at).toISOString())} to ${escape(new Date(m.ends_at).toISOString())}</p>${m.description ? `<p>${escape(m.description).replace(/\r?\n/g, '<br>')}</p>` : ''}`,
      })),
    ]
      .sort((a, b) => b.updated - a.updated)
      .slice(0, 40);
    const iso = (t) => new Date(t).toISOString();
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escape(siteName)}</title>
  <subtitle>Incidents and maintenance</subtitle>
  <link href="${escape(base)}/"/>
  <link rel="self" href="${escape(base)}/feed.xml"/>
  <id>${escape(base)}/feed.xml</id>
  <updated>${iso(entries[0]?.updated || Date.now())}</updated>
${entries
  .map(
    (e) => `  <entry>
    <title>${escape(e.title)}</title>
    <link href="${escape(e.link)}"/>
    <id>${escape(e.id)}</id>
    <published>${iso(e.published)}</published>
    <updated>${iso(e.updated)}</updated>
    <content type="html">${escape(e.body)}</content>
  </entry>`,
  )
  .join('\n')}
</feed>
`;
    const buf = Buffer.from(xml, 'utf8');
    ctx.res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=60' });
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : buf);
  });

  // Uploaded logo. SVGs get a sandboxing CSP so opening one directly can't run scripts.
  router.get('/logo', (ctx) => {
    const logo = getLogo();
    if (!logo) throw new HttpError(404, 'No logo set');
    ctx.res.writeHead(200, {
      'Content-Type': logo.type,
      'Content-Length': logo.body.length,
      'Cache-Control': ctx.query.get('v') === logo.version ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : logo.body);
  });

  // Container health check: process up, DB answering, scheduler not stopped.
  router.get('/healthz', (ctx) => {
    const ok = healthy() && !scheduler.stopping;
    sendJson(ctx.res, ok ? 200 : 503, { status: ok ? 'ok' : 'unhealthy' });
  });
}
