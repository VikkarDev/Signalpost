import { html, multiline } from '../lib/html.js';
import { formatDateTime, formatDay, relativeTime, lastDays, dayKey } from '../lib/time.js';
import { OVERALL_LABELS, COMPONENT_STATES, formatUptime } from '../status.js';
import { publicLayout, stateIcon, ago, historySvg } from './layout.js';

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

const INCIDENT_ROW = { critical: 'Major outage', major: 'Partial outage', minor: 'Degraded', none: 'Incident' };

/** [label, hours, minutes, measured] for the day popup; measured rows are estimated from check counts. */
function durationRow(label, ms, measured = false) {
  const mins = Math.max(1, Math.round(ms / 60000));
  return [label, Math.floor(mins / 60), mins % 60, measured ? 1 : 0];
}

/**
 * What the popup over one history bar shows; public/app.js turns it into HTML.
 * Short keys because there's one per bar: d date, u uptime, n note, r rows, i related incidents.
 */
function dayDetail(d) {
  const rows = [];
  for (const impact of ['critical', 'major', 'minor', 'none']) {
    if (d.incidentMs?.[impact] != null) rows.push(durationRow(INCIDENT_ROW[impact], d.incidentMs[impact]));
  }
  if (d.downMs) rows.push(durationRow('Down', d.downMs, true));
  if (d.slowMs) rows.push(durationRow('Slow', d.slowMs, true));
  if (d.maintenanceMs) rows.push(durationRow('Maintenance', d.maintenanceMs));
  const out = { d: formatDay(d.day) };
  if (d.uptime != null) out.u = formatUptime(d.uptime);
  if (rows.length) out.r = rows;
  else out.n = DAY_STATE_LABEL[d.state];
  if (d.incidents) out.i = d.incidents.map((i) => [i.id, i.title]);
  return out;
}

function bar(component) {
  const n = component.days.length;
  const label = `${component.name}: ${n}-day history${component.uptimeLabel ? `, ${component.uptimeLabel} uptime` : ''}`;
  const attrs = (d) => html` data-day="${JSON.stringify(dayDetail(d))}"`;
  if (n <= 30) return historySvg(component.days, { label, attrs });
  // Phones get the last 30 days only; a separate SVG keeps those bars as wide as possible.
  return html`${historySvg(component.days, { label, attrs, cls: 'bars-full' })}${historySvg(component.days.slice(-30), { label, attrs, cls: 'bars-recent' })}`;
}

function componentCell(c, display) {
  return html`<div class="component state-${c.state}">
    <div class="component-head">
      <span class="component-name">${c.name}</span>
      ${c.description ? html`<span class="help" tabindex="0" data-tip="${c.description}" aria-label="${c.description}">?</span>` : ''}
      <span class="state-icon" title="${stateTitle(c)}">${stateIcon(c.state)}</span>
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
        ? html`<span class="muted">${c.responseMs != null ? `${c.responseMs} ms` : ''}${c.responseMs != null && c.lastCheckAt ? ' · ' : ''}${c.lastCheckAt ? ago(c.lastCheckAt, 'checked ', c.lateAfterMs) : ''}</span>`
        : ''}
    </div>
  </div>`;
}

function stateTitle(c) {
  if (c.state === 'recovered') return `Up again. Last failure ${relativeTime(c.lastFailureAt)}.`;
  return c.stateLabel;
}

// "1 of 3 down · 1 slow", or "3 services" when nothing is going on.
function groupSummary(items) {
  const n = items.length;
  const count = (states) => items.filter((c) => states.includes(c.state)).length;
  const parts = [];
  const down = count(['major_outage', 'partial_outage']);
  const slow = count(['degraded']);
  const maint = count(['maintenance']);
  const recovered = count(['recovered']);
  if (down) parts.push(`${down} of ${n} down`);
  if (slow) parts.push(`${slow} slow`);
  if (maint) parts.push(`${maint} in maintenance`);
  if (recovered) parts.push(`${recovered} recovered recently`);
  return parts.length ? parts.join(' · ') : n === 1 ? '1 service' : `${n} services`;
}

// Compact layout: one row per component.
function componentRow(c, display) {
  const problem = c.state !== 'operational' && c.state !== 'unknown';
  return html`<div class="row state-${c.state}">
    <span class="dot" title="${stateTitle(c)}"></span>
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

// 24h response-time line for the cards layout. Failed buckets are marked along the bottom.
function sparkline(series) {
  if (!series || !series.some(Boolean)) return html`<div class="spark-empty muted small">No data yet</div>`;
  const W = 100;
  const H = 32;
  const step = W / (series.length - 1);
  const values = series.map((b) => (b && b.ms != null ? b.ms : null));
  const max = Math.max(1, ...values.filter((v) => v != null)) * 1.15;
  const y = (v) => (H - 2 - (v / max) * (H - 6)).toFixed(1);

  // break the line where there's no data
  const segments = [];
  let current = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (current.length) segments.push(current);
      current = [];
    } else current.push(`${(i * step).toFixed(1)},${y(v)}`);
  });
  if (current.length) segments.push(current);

  const downs = series.map((b, i) => (b && b.down ? i * step : null)).filter((x) => x != null);
  const latest = [...values].reverse().find((v) => v != null);
  return html`<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Response time, last 24 hours${latest != null ? `, latest ${latest} ms` : ''}">
    ${segments.map((pts) =>
      pts.length === 1
        ? html`<circle cx="${pts[0].split(',')[0]}" cy="${pts[0].split(',')[1]}" r="1" class="spark-dot"/>`
        : html`<polyline points="${pts.join(' ')}" class="spark-line" vector-effect="non-scaling-stroke"/>`,
    )}
    ${downs.map((x) => html`<rect x="${(x - step / 2).toFixed(1)}" y="${H - 3}" width="${step.toFixed(1)}" height="3" class="spark-down"/>`)}
  </svg>`;
}

function componentCard(c, display) {
  const ms = c.responseMs; // null when the latest check failed
  return html`<div class="svc-card state-${c.state}">
    <div class="svc-top">
      <span class="component-name">${c.name}</span>
      ${c.description ? html`<span class="help" tabindex="0" data-tip="${c.description}" aria-label="${c.description}">?</span>` : ''}
    </div>
    <div class="svc-status" title="${stateTitle(c)}"><span class="dot"></span>${c.stateLabel}</div>
    <div class="svc-stats">
      ${display.showUptime ? html`<span><strong>${c.uptimeLabel || '-'}</strong> uptime</span>` : ''}
      ${display.showResponseTime && ms != null ? html`<span><strong>${ms} ms</strong></span>` : ''}
    </div>
    ${display.showResponseTime ? sparkline(c.series) : bar({ ...c, days: c.days.slice(-30) })}
    <div class="svc-foot muted small">
      <span>${display.showResponseTime ? 'Last 24 hours' : 'Last 30 days'}</span>
      ${c.lastCheckAt ? html`<span>${ago(c.lastCheckAt, 'checked ', c.lateAfterMs)}</span>` : ''}
    </div>
  </div>`;
}

// Ungrouped components and groups, in the order their first component appears.
function componentSections(components, display) {
  const list = display.layout !== 'grid';
  const wrap = (items) => {
    if (display.layout === 'cards') return html`<div class="cards">${items.map((c) => componentCard(c, display))}</div>`;
    if (display.layout === 'list') return html`<div class="rows${display.showUptime ? '' : ' no-uptime'}">${items.map((c) => componentRow(c, display))}</div>`;
    return html`<div class="components">${items.map((c) => componentCell(c, display))}</div>`;
  };
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
        <span class="group-summary small">${groupSummary(s.items)}</span>
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

  const n = data.components.length;
  const affected = data.components.filter((c) => c.liveState !== 'operational' && c.liveState !== 'unknown').length;
  const summary = !n ? '' : affected ? `${affected} of ${n} ${n === 1 ? 'service' : 'services'} affected` : `${n} ${n === 1 ? 'service' : 'services'}`;

  const body = html`
  <div class="banner banner-${bannerState}" role="status">
    <span class="banner-icon">${stateIcon(bannerState)}</span>
    <div>
      <p class="banner-title">${OVERALL_LABELS[overall]}</p>
      <div class="banner-sub">${summary ? `${summary} · ` : ''}updated ${ago(data.generatedAt)}</div>
    </div>
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
  </section>`;

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

export { groupSummary as groupSummaryForTest };
