import { html, multiline } from '../lib/html.js';
import { formatDateTime, formatDay, relativeTime, lastDays, dayKey } from '../lib/time.js';
import { OVERALL_LABELS, COMPONENT_STATES, formatUptime } from '../status.js';
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
  const n = component.days.length;
  return html`<div class="bars" role="img" aria-label="${component.name}: ${n}-day history${component.uptimeLabel ? `, ${component.uptimeLabel} uptime` : ''}">
    ${component.days.map((d, i) => {
      const parts = [formatDay(d.day), DAY_STATE_LABEL[d.state]];
      if (d.uptime != null) parts.push(`${formatUptime(d.uptime)} uptime · ${d.checks} checks${d.down ? ` · ${d.down} failed` : ''}`);
      else if (d.checks && d.down) parts.push(`${d.down} of ${d.checks} checks failed`);
      if (d.maintenance) parts.push(`${d.maintenance} checks during maintenance`);
      if (d.incidents) for (const inc of d.incidents) parts.push(`Incident: ${inc.title}`);
      return html`<span class="bar bar-${d.state}${i < n - 30 ? ' bar-old' : ''}" data-tip="${parts.join('\n')}"></span>`;
    })}
  </div>`;
}

function componentCell(c, display) {
  return html`<div class="component state-${c.state}">
    <div class="component-head">
      <span class="component-name">${c.name}</span>
      ${c.description ? html`<span class="help" tabindex="0" data-tip="${c.description}" aria-label="${c.description}">?</span>` : ''}
      <span class="state-icon" title="${c.stateLabel}">${stateIcon(c.state)}</span>
    </div>
    ${bar(c)}
    <div class="bar-legend">
      <span class="legend-edge">${c.days.length > 30 ? html`<span class="d90">${c.days.length} days ago</span><span class="d30">30 days ago</span>` : '30 days ago'}</span>
      <span class="legend-line"></span>
      ${display.showUptime
        ? html`<span class="legend-uptime">${c.uptimeLabel ? `${c.uptimeLabel} uptime` : 'No data yet'}</span>
            <span class="legend-line"></span>`
        : ''}
      <span class="legend-edge">Today</span>
    </div>
    <div class="component-meta">
      <span class="component-state">${c.stateLabel}</span>
      ${c.lastCheckAt || c.responseMs != null
        ? html`<span class="muted">${[c.responseMs != null ? `${c.responseMs} ms` : null, c.lastCheckAt ? `checked ${relativeTime(c.lastCheckAt)}` : null].filter(Boolean).join(' · ')}</span>`
        : ''}
    </div>
  </div>`;
}

// Compact layout: one row per component.
function componentRow(c, display) {
  const problem = c.state !== 'operational' && c.state !== 'unknown';
  return html`<div class="row state-${c.state}">
    <span class="dot" title="${c.stateLabel}"></span>
    <span class="row-name">
      <span class="component-name">${c.name}</span>
      ${c.description ? html`<span class="help" tabindex="0" data-tip="${c.description}" aria-label="${c.description}">?</span>` : ''}
      ${problem ? html`<span class="row-state">${c.stateLabel}</span>` : ''}
    </span>
    ${bar(c)}
    ${display.showUptime
      ? html`<span class="row-uptime" title="Uptime over ${c.days.length} days">${c.uptimeLabel || 'No data'}</span>`
      : ''}
  </div>`;
}

// Ungrouped components and groups, in the order their first component appears.
function componentSections(components, display) {
  const list = display.layout === 'list';
  const wrap = (items) =>
    list
      ? html`<div class="rows${display.showUptime ? '' : ' no-uptime'}">${items.map((c) => componentRow(c, display))}</div>`
      : html`<div class="components">${items.map((c) => componentCell(c, display))}</div>`;
  const sections = [];
  const groups = new Map();
  for (const c of components) {
    if (!c.group) {
      const last = sections.at(-1);
      if (last && !last.name) last.items.push(c);
      else sections.push({ name: null, items: [c] });
    } else if (groups.has(c.group)) {
      groups.get(c.group).items.push(c);
    } else {
      const g = { name: c.group, items: [c] };
      groups.set(c.group, g);
      sections.push(g);
    }
  }
  return sections.map((s) => {
    if (!s.name) return wrap(s.items);
    const known = s.items.filter((c) => c.state !== 'unknown');
    const state = known.length
      ? known.reduce((a, c) => (COMPONENT_STATES[c.state].rank > COMPONENT_STATES[a].rank ? c.state : a), 'operational')
      : 'unknown';
    return html`<details class="group state-${state}" data-group="${s.name}" open>
      <summary class="group-head">
        <span class="group-name">${s.name}</span>
        <span class="muted small">${s.items.length === 1 ? '1 service' : `${s.items.length} services`}</span>
        ${list
          ? html`<span class="dot group-dot" title="${COMPONENT_STATES[state].label}"></span>`
          : html`<span class="state-icon" title="${COMPONENT_STATES[state].label}">${stateIcon(state)}</span>`}
      </summary>
      ${wrap(s.items)}
    </details>`;
  });
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
      ? componentSections(data.components, data.display)
      : html`<div class="empty">No services have been added yet.</div>`}
  </section>

  <section class="section" aria-labelledby="past">
    <h2 id="past" class="section-title">Past Incidents</h2>
    ${past.length
      ? pastDays.map((day) => {
          const items = past.filter((i) => dayKey(i.created_at) === day);
          return items.length
            ? html`<div class="past-day">
                <h3 class="past-day-title">${formatDay(day)}</h3>
                ${items.map((i) => incidentBlock(i))}
              </div>`
            : '';
        })
      : html`<p class="muted">No incidents in the past 7 days.</p>`}
  </section>
  <p class="muted small updated">Updated ${formatDateTime(data.generatedAt)}</p>`;

  return publicLayout({
    title: `${data.siteName}`,
    siteName: data.siteName,
    body,
    live: true,
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
