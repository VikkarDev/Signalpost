import { html, multiline } from '../lib/html.js';
import { formatDateTime, formatDay, relativeTime, lastDays, dayKey } from '../lib/time.js';
import { OVERALL_LABELS, HISTORY_DAYS, formatUptime } from '../status.js';
import { publicLayout, stateIcon } from './layout.js';

const STATUS_LABEL = { investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved' };
const IMPACT_CLASS = { none: 'impact-none', minor: 'impact-minor', major: 'impact-major', critical: 'impact-critical' };

const DAY_STATE_LABEL = {
  operational: 'No downtime recorded',
  degraded: 'Degraded performance',
  partial_outage: 'Partial outage',
  major_outage: 'Major outage',
  maintenance: 'Maintenance',
  nodata: 'No data',
};

function bar(component) {
  return html`<div class="bars" role="img" aria-label="${component.name}: ${HISTORY_DAYS}-day history, ${component.uptimeLabel ? `${component.uptimeLabel} uptime` : 'no data yet'}">
    ${component.days.map((d, i) => {
      const parts = [formatDay(d.day), DAY_STATE_LABEL[d.state]];
      if (d.uptime != null) parts.push(`${formatUptime(d.uptime)} uptime · ${d.checks} checks${d.down ? ` · ${d.down} failed` : ''}`);
      if (d.maintenance) parts.push(`${d.maintenance} checks during maintenance`);
      if (d.incidents) for (const inc of d.incidents) parts.push(`Incident: ${inc.title}`);
      return html`<span class="bar bar-${d.state}${i < HISTORY_DAYS - 30 ? ' bar-old' : ''}" data-tip="${parts.join('\n')}"></span>`;
    })}
  </div>`;
}

function componentCell(c) {
  return html`<div class="component state-${c.state}">
    <div class="component-head">
      <span class="component-name">${c.name}</span>
      ${c.description ? html`<span class="help" tabindex="0" data-tip="${c.description}" aria-label="${c.description}">?</span>` : ''}
      <span class="state-icon" title="${c.stateLabel}">${stateIcon(c.state)}</span>
    </div>
    ${bar(c)}
    <div class="bar-legend">
      <span class="legend-edge"><span class="d90">${HISTORY_DAYS} days ago</span><span class="d30">30 days ago</span></span>
      <span class="legend-line"></span>
      <span class="legend-uptime">${c.uptimeLabel ? `${c.uptimeLabel} uptime` : 'No data yet'}</span>
      <span class="legend-line"></span>
      <span class="legend-edge">Today</span>
    </div>
    <div class="component-meta">
      <span class="component-state">${c.stateLabel}</span>
      ${c.lastCheckAt
        ? html`<span class="muted">${c.responseMs != null ? `${c.responseMs} ms · ` : ''}checked ${relativeTime(c.lastCheckAt)}</span>`
        : ''}
    </div>
  </div>`;
}

function incidentBlock(inc, { link = true } = {}) {
  return html`<article class="incident ${IMPACT_CLASS[inc.impact]}">
    <h3>${link ? html`<a href="/incidents/${inc.id}">${inc.title}</a>` : inc.title}</h3>
    ${inc.components?.length ? html`<p class="muted small">Affects: ${inc.components.join(', ')}</p>` : ''}
    ${inc.updates.map(
      (u) => html`<div class="incident-update">
        <p><strong>${STATUS_LABEL[u.status]}</strong> - ${multiline(u.message)}</p>
        <p class="muted small"><time datetime="${new Date(u.created_at).toISOString()}">${formatDateTime(u.created_at)}</time></p>
      </div>`,
    )}
  </article>`;
}

export function statusPage(data, past) {
  const overall = data.overall;
  const bannerState = overall === 'none' || overall === 'unknown' ? 'unknown' : overall;
  const pastDays = lastDays(7).reverse();

  const body = html`
  <div class="banner banner-${bannerState}" role="status">
    <span class="banner-icon">${stateIcon(bannerState)}</span>
    <span>${OVERALL_LABELS[overall]}</span>
  </div>

  ${data.activeIncidents.length
    ? html`<section class="section" aria-labelledby="active-incidents">
        <h2 id="active-incidents" class="section-title">Active incidents</h2>
        ${data.activeIncidents.map((i) => incidentBlock(i))}
      </section>`
    : ''}

  ${data.maintenances.length
    ? html`<section class="section" aria-labelledby="maint">
        <h2 id="maint" class="section-title">${data.maintenances.some((m) => m.active) ? 'Maintenance' : 'Scheduled maintenance'}</h2>
        ${data.maintenances.map(
          (m) => html`<article class="incident maintenance-item">
            <h3>${m.title} ${m.active ? html`<span class="pill pill-maintenance">In progress</span>` : html`<span class="pill">Scheduled</span>`}</h3>
            ${m.description ? html`<p>${multiline(m.description)}</p>` : ''}
            <p class="muted small">${formatDateTime(m.starts_at)} → ${formatDateTime(m.ends_at)}${m.components.length ? html` · Affects: ${m.components.join(', ')}` : ''}</p>
          </article>`,
        )}
      </section>`
    : ''}

  <section class="section" aria-labelledby="current">
    <h1 id="current" class="page-title">Current Status: ${data.heading}</h1>
    ${data.components.length
      ? html`<div class="components">${data.components.map(componentCell)}</div>`
      : html`<div class="empty">No services have been added yet.</div>`}
    <p class="legend-key muted small">
      <span class="key key-operational"></span> Operational
      <span class="key key-degraded"></span> Degraded
      <span class="key key-partial_outage"></span> Partial outage
      <span class="key key-major_outage"></span> Major outage
      <span class="key key-maintenance"></span> Maintenance
      <span class="key key-nodata"></span> No data
    </p>
  </section>

  <section class="section" aria-labelledby="past">
    <h2 id="past" class="section-title">Past Incidents</h2>
    ${pastDays.map((day) => {
      const items = past.filter((i) => dayKey(i.created_at) === day);
      return html`<div class="past-day">
        <h3 class="past-day-title">${formatDay(day)}</h3>
        ${items.length ? items.map((i) => incidentBlock(i)) : html`<p class="muted">No incidents reported.</p>`}
      </div>`;
    })}
    <p><a href="/history">← Incident history</a></p>
  </section>
  <p class="muted small updated">Last updated ${formatDateTime(data.generatedAt)} · refreshes automatically</p>`;

  return publicLayout({
    title: `${data.siteName}`,
    siteName: data.siteName,
    body,
    refresh: true,
    description: `${OVERALL_LABELS[overall]}. Live service status.`,
  });
}

export function incidentPage(siteName, inc) {
  const body = html`
    <p><a href="/">← Current status</a></p>
    <h1 class="page-title">${inc.title}</h1>
    <p class="muted">
      ${inc.status === 'resolved' ? html`<span class="pill pill-operational">Resolved</span>` : html`<span class="pill pill-major_outage">${STATUS_LABEL[inc.status]}</span>`}
      Impact: ${inc.impact} · Started ${formatDateTime(inc.created_at)}${inc.resolved_at ? ` · Resolved ${formatDateTime(inc.resolved_at)}` : ''}
    </p>
    ${incidentBlock(inc, { link: false })}`;
  return publicLayout({ title: `${inc.title} · ${siteName}`, siteName, body });
}

export function historyPage(siteName, incidents, page, hasMore) {
  const body = html`
    <p><a href="/">← Current status</a></p>
    <h1 class="page-title">Incident history</h1>
    ${incidents.length ? incidents.map((i) => incidentBlock(i)) : html`<p class="muted">No incidents have been recorded.</p>`}
    <nav class="pager">
      ${page > 1 ? html`<a href="/history?page=${page - 1}">← Newer</a>` : ''}
      ${hasMore ? html`<a href="/history?page=${page + 1}">Older →</a>` : ''}
    </nav>`;
  return publicLayout({ title: `Incident history · ${siteName}`, siteName, body });
}

export function errorPage(status, message) {
  return publicLayout({
    title: `${status}`,
    siteName: 'Status',
    body: html`<div class="error-page"><h1 class="page-title">${status}</h1><p>${message}</p><p><a href="/">Go to the status page</a></p></div>`,
  });
}
