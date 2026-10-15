import { html, multiline } from '../lib/html.js';
import { formatDateTime, formatTime, relativeTime, tsToLocalInput, formatDuration, formatDay } from '../lib/time.js';
import { formatUptime, COMPONENT_STATES, INCIDENT_STATUSES, INCIDENT_IMPACTS } from '../status.js';
import { adminLayout, VERSION } from './layout.js';
import { config } from '../config.js';

const csrfField = (csrf) => html`<input type="hidden" name="_csrf" value="${csrf}">`;

function postButton({ action, csrf, label, cls = 'btn', confirm = null, fields = {} }) {
  return html`<form method="post" action="${action}" class="inline"${confirm ? html` data-confirm="${confirm}"` : ''}>
    ${csrfField(csrf)}
    ${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    <button type="submit" class="${cls}">${label}</button>
  </form>`;
}

function field(label, control, hint = '', id = '') {
  return html`<div class="field"${id ? html` id="${id}"` : ''}>
    <label>${label}${control}</label>
    ${hint ? html`<p class="hint">${hint}</p>` : ''}
  </div>`;
}

function input(name, value, attrs = {}) {
  const extra = Object.entries(attrs)
    .filter(([, v]) => v !== false && v !== null && v !== undefined)
    .map(([k, v]) => (v === true ? html` ${k}` : html` ${k}="${v}"`));
  return html`<input name="${name}" value="${value ?? ''}"${extra}>`;
}

function select(name, options, selected, attrs = {}) {
  return html`<select name="${name}"${attrs.id ? html` id="${attrs.id}"` : ''}${attrs.multiple ? html` multiple size="${Math.min(8, Math.max(3, options.length))}"` : ''}>
    ${options.map(([v, l]) => {
      const sel = Array.isArray(selected) ? selected.map(String).includes(String(v)) : String(v) === String(selected ?? '');
      return html`<option value="${v}"${sel ? html` selected` : ''}>${l}</option>`;
    })}
  </select>`;
}

function checkbox(name, checked, label) {
  return html`<label class="check"><input type="checkbox" name="${name}" value="1"${checked ? html` checked` : ''}> ${label}</label>`;
}

function errors(list) {
  if (!list || !list.length) return '';
  return html`<div class="flash flash-error" role="alert"><ul>${list.map((e) => html`<li>${e}</li>`)}</ul></div>`;
}

export function stateBadge(state) {
  const label = { up: 'Up', degraded: 'Degraded', down: 'Down', unknown: 'Pending' }[state] || state;
  return html`<span class="badge badge-${state}">${label}</span>`;
}

function componentBadge(state) {
  return html`<span class="badge badge-c-${state}">${COMPONENT_STATES[state]?.label || state}</span>`;
}

function pct(r) {
  return formatUptime(r) ?? html`<span class="muted">no data</span>`;
}

const SCOPE_LABEL = { internal: 'Internal', public: 'Public', canary: 'Canary' };

// ---------------------------------------------------------------- login

export function loginPage({ error, adminMissing, username = '' }) {
  return adminLayout({
    title: 'Sign in',
    body: html`<div class="card narrow">
      <h1>Sign in</h1>
      ${adminMissing
        ? html`<div class="flash flash-warn">No admin account exists yet. Set <code>ADMIN_PASSWORD</code> (at least 12 characters) in the container's environment variables and restart the container. See the README.</div>`
        : ''}
      ${error ? html`<div class="flash flash-error" role="alert">${error}</div>` : ''}
      <form method="post" action="/admin/login" class="stack">
        ${field('Username', input('username', username, { autocomplete: 'username', required: true, maxlength: 100, autofocus: true }))}
        ${field('Password', input('password', '', { type: 'password', autocomplete: 'current-password', required: true, maxlength: 256 }))}
        <button type="submit" class="btn btn-primary">Sign in</button>
      </form>
    </div>`,
  });
}

// ---------------------------------------------------------------- dashboard

export function dashboardPage(ctx, { components, unassigned, canaries, totals }) {
  const monitorRow = (m) => html`<tr class="${m.enabled ? '' : 'disabled'}">
    <td class="c-name"><a href="/admin/monitors/${m.id}">${m.name}</a>${m.enabled ? '' : html` <span class="pill">disabled</span>`}</td>
    <td class="c-meta">${SCOPE_LABEL[m.scope]} ${m.type.toUpperCase()}</td>
    <td class="c-state">${m.enabled ? stateBadge(m.state) : html`<span class="badge">Off</span>`}</td>
    <td class="num c-meta">${m.last_response_ms != null ? `${m.last_response_ms} ms` : ''}</td>
    <td class="c-meta">${m.last_check_at ? relativeTime(m.last_check_at) : ''}</td>
    <td class="num c-meta c-labelled">${pct(m.uptime24h)}</td>
    <td class="num c-hide">${pct(m.uptime30d)}</td>
    <td class="err c-full">${m.state === 'down' || m.state === 'degraded' ? m.last_error : ''}</td>
  </tr>`;
  const table = (rows) => html`<div class="table-wrap"><table class="table compact dash">
    <thead><tr><th>Monitor</th><th>Kind</th><th>State</th><th class="num">Response</th><th>Checked</th><th class="num">24h</th><th class="num">30d</th><th>Last error</th></tr></thead>
    <tbody>${rows.map(monitorRow)}</tbody></table></div>`;

  return adminLayout({
    ...ctx,
    title: 'Dashboard',
    active: 'dashboard',
    body: html`
    <div class="page-head">
      <h1>Dashboard</h1>
      <div class="actions"><a class="btn btn-primary" href="/admin/monitors/new">New monitor</a></div>
    </div>
    ${totals.monitors
      ? html`<p class="summary">
          ${totals.down ? html`<span class="sum sum-down">${totals.down} down</span>` : ''}
          ${totals.degraded ? html`<span class="sum sum-degraded">${totals.degraded} slow</span>` : ''}
          <span class="sum sum-up">${totals.up} up</span>
          ${totals.unknown ? html`<span class="sum">${totals.unknown} pending</span>` : ''}
          <span class="muted">of ${totals.monitors} monitors</span>
        </p>`
      : ''}
    ${totals.monitors === 0
      ? html`<div class="card"><h2>Getting started</h2><ol>
          <li><a href="/admin/components/new">Create a component</a> for each service shown publicly (e.g. "Website").</li>
          <li><a href="/admin/monitors/new">Add monitors</a>: an <strong>internal</strong> check (e.g. <code>http://container-name:port</code>) and a <strong>public</strong> check (e.g. <code>https://app.example.com</code>) for each component.</li>
          <li>Add a <strong>canary</strong> or two (e.g. <code>https://1.1.1.1</code>). If those fail too, it's your internet connection and not your proxy.</li>
          <li><a href="/admin/alerts/new">Add an alert rule</a> for Discord or email.</li></ol></div>`
      : ''}
    ${components.map(
      (c) => html`<section class="card">
        <div class="card-head">
          <h2><a href="/admin/components/${c.id}">${c.name}</a> ${c.visible ? '' : html`<span class="pill">hidden</span>`}</h2>
          ${componentBadge(c.state)}
        </div>
        ${c.diagnosis ? html`<div class="diagnosis diagnosis-${c.diagnosis.kind}">${c.diagnosis.text}</div>` : ''}
        ${c.monitors.length ? table(c.monitors) : html`<p class="muted">No monitors attached. <a href="/admin/monitors/new?component_id=${c.id}">Add one</a>.</p>`}
      </section>`,
    )}
    ${canaries.length
      ? html`<section class="card"><div class="card-head"><h2>Canaries</h2></div>
          <p class="muted small">Sites that should always be up. When all of them fail, the server itself is offline.</p>
          ${table(canaries)}</section>`
      : ''}
    ${unassigned.length
      ? html`<section class="card"><div class="card-head"><h2>Monitors without a component</h2></div>
          <p class="muted small">Only visible here.</p>${table(unassigned)}</section>`
      : ''}`,
  });
}

// ---------------------------------------------------------------- monitors

export function monitorsPage(ctx, monitors) {
  return adminLayout({
    ...ctx,
    title: 'Monitors',
    active: 'monitors',
    body: html`
    <div class="page-head"><h1>Monitors</h1><div class="actions"><a class="btn btn-primary" href="/admin/monitors/new">New monitor</a></div></div>
    ${monitors.length
      ? html`<div class="table-wrap"><table class="table compact">
      <thead><tr><th>Name</th><th>Component</th><th>Kind</th><th>Target</th><th>Every</th><th>State</th><th></th></tr></thead>
      <tbody>${monitors.map(
        (m) => html`<tr class="${m.enabled ? '' : 'disabled'}">
          <td class="c-name"><a href="/admin/monitors/${m.id}">${m.name}</a></td>
          <td class="${m.component_name ? 'c-meta' : 'c-hide'}">${m.component_name || ''}</td>
          <td class="c-meta">${SCOPE_LABEL[m.scope]} ${m.type.toUpperCase()}</td>
          <td class="mono c-full">${m.type === 'tcp' ? `${m.target}:${m.port}` : m.target}</td>
          <td class="c-meta c-labelled">${formatDuration(m.interval_s * 1000)}</td>
          <td class="c-state">${m.enabled ? stateBadge(m.state) : html`<span class="badge">Off</span>`}</td>
          <td class="row-actions c-hide">
            <a href="/admin/monitors/${m.id}/edit">Edit</a>
            ${postButton({ action: `/admin/monitors/${m.id}/toggle`, csrf: ctx.csrf, label: m.enabled ? 'Disable' : 'Enable', cls: 'link-button' })}
          </td>
        </tr>`,
      )}</tbody></table></div>`
      : html`<div class="card"><p>No monitors yet.</p></div>`}`,
  });
}

export function monitorFormPage(ctx, { monitor, components, errorList, isNew }) {
  const m = monitor;
  const action = isNew ? '/admin/monitors' : `/admin/monitors/${m.id}`;
  return adminLayout({
    ...ctx,
    title: isNew ? 'New monitor' : `Edit ${m.name}`,
    active: 'monitors',
    body: html`
    <div class="page-head"><h1>${isNew ? 'New monitor' : `Edit monitor`}</h1></div>
    ${errors(errorList)}
    <form method="post" action="${action}" class="card form-grid" id="monitor-form">
      ${csrfField(ctx.csrf)}
      ${field('Name', input('name', m.name, { required: true, maxlength: 100 }))}
      ${field('Component', select('component_id', [['', 'None (admin only)'], ...components.map((c) => [c.id, c.name])], m.component_id))}
      ${field('Check type', select('type', [['http', 'HTTP / HTTPS'], ['tcp', 'TCP port'], ['ping', 'Ping (ICMP)']], m.type, { id: 'type-select' }))}
      ${field(
        'Scope',
        select('scope', [['public', 'Public (through the internet / your proxy)'], ['internal', 'Internal (directly to the container or LAN host)'], ['canary', 'Canary (internet connectivity reference)']], m.scope),
        'Tip: add both an internal and a public monitor per service.',
      )}
      ${field(
        'Target',
        input('target', m.target, { required: true, maxlength: 2000, placeholder: 'https://app.example.com  or  my-container  or  192.168.1.10', spellcheck: 'false' }),
        'HTTP: full URL. TCP and ping: host name or IP. Containers on the same Docker network can be reached by name.',
      )}
      ${field('Port', input('port', m.port, { type: 'number', min: 1, max: 65535 }), 'TCP checks only.', 'f-port')}
      ${field('HTTP method', select('method', [['GET', 'GET'], ['HEAD', 'HEAD']], m.method), '', 'f-method')}
      ${field('Expected status codes', input('expected_status', m.expected_status, { maxlength: 100, placeholder: '200-399' }), 'Comma-separated codes or ranges, e.g. 200-299,301,401.', 'f-status')}
      ${field('Body must contain', input('keyword', m.keyword, { maxlength: 200 }), 'Optional keyword check (GET only, first 1 MB).', 'f-keyword')}
      <div class="field" id="f-http-flags">
        ${checkbox('follow_redirects', m.follow_redirects, 'Follow redirects (up to 5)')}
        ${checkbox('ignore_tls', m.ignore_tls, 'Ignore TLS certificate errors (self-signed internal services)')}
      </div>
      ${field('Check interval (seconds)', input('interval_s', m.interval_s, { type: 'number', min: config.minCheckIntervalSeconds, max: 86400, required: true }))}
      ${field('Timeout (milliseconds)', input('timeout_ms', m.timeout_ms, { type: 'number', min: 500, max: 60000, required: true }))}
      ${field('Degraded above (milliseconds)', input('degraded_ms', m.degraded_ms, { type: 'number', min: 1, max: 600000 }), 'Optional. Successful checks slower than this count as degraded.')}
      ${field('Failures before "down"', input('failure_threshold', m.failure_threshold, { type: 'number', min: 1, max: 20, required: true }), 'Consecutive failed checks needed before the monitor is marked down and alerts fire. Every failed check still counts against uptime.')}
      <div class="field">${checkbox('enabled', m.enabled, 'Enabled')}</div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">${isNew ? 'Create monitor' : 'Save changes'}</button>
        <a class="btn" href="${isNew ? '/admin/monitors' : `/admin/monitors/${m.id}`}">Cancel</a>
      </div>
    </form>`,
  });
}

export function monitorDetailPage(ctx, { monitor: m, component, checks, uptime, history }) {
  return adminLayout({
    ...ctx,
    title: m.name,
    active: 'monitors',
    body: html`
    <div class="page-head">
      <h1>${m.name} ${m.enabled ? stateBadge(m.state) : html`<span class="badge">Disabled</span>`}</h1>
      <div class="actions">
        ${postButton({ action: `/admin/monitors/${m.id}/check`, csrf: ctx.csrf, label: 'Check now' })}
        <a class="btn" href="/admin/monitors/${m.id}/edit">Edit</a>
        ${postButton({ action: `/admin/monitors/${m.id}/toggle`, csrf: ctx.csrf, label: m.enabled ? 'Disable' : 'Enable' })}
        ${postButton({ action: `/admin/monitors/${m.id}/delete`, csrf: ctx.csrf, label: 'Delete', cls: 'btn btn-danger', confirm: `Delete monitor "${m.name}" and all of its history?` })}
      </div>
    </div>
    <div class="card">
      <dl class="facts">
        <dt>Target</dt><dd class="mono">${m.type === 'tcp' ? `${m.target}:${m.port}` : m.target}</dd>
        <dt>Check</dt><dd>${SCOPE_LABEL[m.scope]} ${m.type.toUpperCase()}, every ${formatDuration(m.interval_s * 1000)}, ${m.timeout_ms / 1000}s timeout</dd>
        <dt>Component</dt><dd>${component ? html`<a href="/admin/components/${component.id}">${component.name}</a>` : '—'}</dd>
        <dt>State since</dt><dd>${m.state_since ? html`${formatDateTime(m.state_since)} (${relativeTime(m.state_since)})` : '—'}</dd>
        <dt>Last check</dt><dd>${m.last_check_at ? html`${relativeTime(m.last_check_at)}${m.last_response_ms != null ? `, ${m.last_response_ms} ms` : ''}${m.last_status_code ? `, HTTP ${m.last_status_code}` : ''}` : 'never'}</dd>
        ${m.last_error ? html`<dt>Last error</dt><dd class="err">${m.last_error}</dd>` : ''}
        ${m.tls_expires_at ? html`<dt>TLS certificate</dt><dd>expires ${formatDateTime(m.tls_expires_at)}</dd>` : ''}
        <dt>Uptime</dt><dd class="uptimes"><span>24h ${pct(uptime.d1)}</span><span>7d ${pct(uptime.d7)}</span><span>30d ${pct(uptime.d30)}</span><span>90d ${pct(uptime.d90)}</span></dd>
      </dl>
    </div>
    <div class="card">
      <h2>90 days</h2>
      <div class="bars bars-admin">${history.days.map(
        (d) => html`<span class="bar bar-${d.state}" data-tip="${formatDay(d.day)}\n${d.uptime != null ? `${formatUptime(d.uptime)} uptime · ${d.checks} checks · ${d.down} failed` : 'No data'}"></span>`,
      )}</div>
    </div>
    <div class="card">
      <h2>Recent checks</h2>
      ${checks.length
        ? html`<div class="table-wrap"><table class="table compact">
        <thead><tr><th>Time</th><th>Result</th><th class="num">Response</th><th>HTTP</th><th>Error</th></tr></thead>
        <tbody>${checks.map(
          (c) => html`<tr><td class="c-name">${formatTime(c.checked_at)}</td><td class="c-state">${stateBadge(c.status)}${c.in_maintenance ? html` <span class="pill">maint.</span>` : ''}</td>
          <td class="num c-meta">${c.response_ms != null ? `${c.response_ms} ms` : ''}</td><td class="c-meta">${c.status_code ? `HTTP ${c.status_code}` : ''}</td><td class="err c-full">${c.error || ''}</td></tr>`,
        )}</tbody></table></div>`
        : html`<p class="muted">No checks recorded yet.</p>`}
    </div>`,
  });
}

// ---------------------------------------------------------------- components

export function componentsPage(ctx, components) {
  return adminLayout({
    ...ctx,
    title: 'Components',
    active: 'components',
    body: html`
    <div class="page-head"><h1>Components</h1><div class="actions"><a class="btn btn-primary" href="/admin/components/new">New component</a></div></div>
    <p class="muted">Components are the services shown on the public status page. Their status is derived from the monitors attached to them.</p>
    ${components.length
      ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Order</th><th>Name</th><th>Group</th><th>Monitors</th><th>Public</th><th></th></tr></thead>
      <tbody>${components.map(
        (c) => html`<tr>
          <td>${c.sort_order}</td>
          <td><a href="/admin/components/${c.id}">${c.name}</a><div class="muted small">${c.description}</div></td>
          <td>${c.group_name}</td>
          <td>${c.monitor_count}</td>
          <td>${c.visible ? 'Visible' : html`<span class="pill">hidden</span>`}</td>
          <td class="row-actions">
            ${postButton({ action: `/admin/components/${c.id}/move`, csrf: ctx.csrf, label: '↑', cls: 'link-button', fields: { dir: 'up' } })}
            ${postButton({ action: `/admin/components/${c.id}/move`, csrf: ctx.csrf, label: '↓', cls: 'link-button', fields: { dir: 'down' } })}
          </td>
        </tr>`,
      )}</tbody></table></div>`
      : html`<div class="card"><p>No components yet.</p></div>`}`,
  });
}

export function componentFormPage(ctx, { component: c, groups = [], errorList, isNew, monitors = [] }) {
  return adminLayout({
    ...ctx,
    title: isNew ? 'New component' : c.name,
    active: 'components',
    body: html`
    <div class="page-head"><h1>${isNew ? 'New component' : `Component: ${c.name}`}</h1>
      ${isNew ? '' : html`<div class="actions">${postButton({ action: `/admin/components/${c.id}/delete`, csrf: ctx.csrf, label: 'Delete', cls: 'btn btn-danger', confirm: `Delete component "${c.name}"? Its monitors are kept but detached.` })}</div>`}
    </div>
    ${errors(errorList)}
    <form method="post" action="${isNew ? '/admin/components' : `/admin/components/${c.id}`}" class="card form-grid">
      ${csrfField(ctx.csrf)}
      ${field('Name', input('name', c.name, { required: true, maxlength: 80 }), 'Shown publicly, e.g. "Files" or "Website".')}
      ${field('Description', input('description', c.description, { maxlength: 300 }), 'Optional. Shown in the "?" tooltip on the public page.')}
      ${field('Group', input('group_name', c.group_name, { maxlength: 60, list: 'group-list', autocomplete: 'off' }), 'Optional. Components with the same group are shown together in a collapsible section.')}
      <datalist id="group-list">${groups.map((g) => html`<option value="${g}">`)}</datalist>
      ${field('Sort order', input('sort_order', c.sort_order, { type: 'number', min: -1000, max: 100000 }))}
      <div class="field">${checkbox('visible', c.visible, 'Show on the public status page')}</div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${isNew ? 'Create' : 'Save'}</button> <a class="btn" href="/admin/components">Cancel</a></div>
    </form>
    ${isNew
      ? ''
      : html`<div class="card"><h2>Monitors</h2>
        ${monitors.length ? html`<ul>${monitors.map((m) => html`<li><a href="/admin/monitors/${m.id}">${m.name}</a> · ${SCOPE_LABEL[m.scope]} ${m.type.toUpperCase()} ${stateBadge(m.state)}</li>`)}</ul>` : html`<p class="muted">None.</p>`}
        <a class="btn" href="/admin/monitors/new?component_id=${c.id}">Add monitor</a></div>`}`,
  });
}

// ---------------------------------------------------------------- incidents

const STATUS_OPTS = INCIDENT_STATUSES.map((s) => [s, s[0].toUpperCase() + s.slice(1)]);
const IMPACT_OPTS = [
  ['none', 'None (informational)'],
  ['minor', 'Minor (shows as degraded)'],
  ['major', 'Major (shows as partial outage)'],
  ['critical', 'Critical (shows as major outage)'],
];

export function incidentsPage(ctx, incidents) {
  return adminLayout({
    ...ctx,
    title: 'Incidents',
    active: 'incidents',
    body: html`
    <div class="page-head"><h1>Incidents</h1><div class="actions"><a class="btn btn-primary" href="/admin/incidents/new">Report incident</a></div></div>
    ${incidents.length
      ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Title</th><th>Status</th><th>Impact</th><th>Started</th><th>Duration</th></tr></thead>
      <tbody>${incidents.map(
        (i) => html`<tr><td><a href="/admin/incidents/${i.id}">${i.title}</a></td>
        <td><span class="badge badge-inc-${i.status}">${i.status}</span></td><td>${i.impact}</td>
        <td>${formatDateTime(i.created_at)}</td><td>${formatDuration((i.resolved_at || Date.now()) - i.created_at)}</td></tr>`,
      )}</tbody></table></div>`
      : html`<div class="card"><p>No incidents recorded.</p></div>`}`,
  });
}

export function incidentNewPage(ctx, { components, values, errorList }) {
  return adminLayout({
    ...ctx,
    title: 'Report incident',
    active: 'incidents',
    body: html`
    <div class="page-head"><h1>Report incident</h1></div>
    ${errors(errorList)}
    <form method="post" action="/admin/incidents" class="card form-grid">
      ${csrfField(ctx.csrf)}
      ${field('Title', input('title', values.title, { required: true, maxlength: 200 }))}
      ${field('Status', select('status', STATUS_OPTS.filter(([s]) => s !== 'resolved'), values.status))}
      ${field('Impact', select('impact', IMPACT_OPTS, values.impact))}
      ${field('Affected components', select('component_ids', components.map((c) => [c.id, c.name]), values.component_ids, { multiple: true }), 'Hold Ctrl/⌘ to select several.')}
      ${field('Message', html`<textarea name="message" rows="5" maxlength="5000" required>${values.message || ''}</textarea>`, 'Shown publicly as the first update.')}
      <div class="field">${checkbox('notify', values.notify ?? true, 'Send notifications to alert rules with incident alerts enabled')}</div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Publish incident</button> <a class="btn" href="/admin/incidents">Cancel</a></div>
    </form>`,
  });
}

export function incidentDetailPage(ctx, { incident: i, updates, components, selected, errorList }) {
  return adminLayout({
    ...ctx,
    title: i.title,
    active: 'incidents',
    body: html`
    <div class="page-head">
      <h1>${i.title} <span class="badge badge-inc-${i.status}">${i.status}</span></h1>
      <div class="actions">
        <a class="btn" href="/incidents/${i.id}" target="_blank" rel="noopener">Public page ↗</a>
        ${postButton({ action: `/admin/incidents/${i.id}/delete`, csrf: ctx.csrf, label: 'Delete', cls: 'btn btn-danger', confirm: 'Delete this incident permanently?' })}
      </div>
    </div>
    ${errors(errorList)}
    <div class="two-col">
      <form method="post" action="/admin/incidents/${i.id}/updates" class="card form-grid">
        <h2>Post an update</h2>
        ${csrfField(ctx.csrf)}
        ${field('New status', select('status', STATUS_OPTS, i.status === 'resolved' ? 'resolved' : i.status))}
        ${field('Message', html`<textarea name="message" rows="4" maxlength="5000" required></textarea>`)}
        <div class="field">${checkbox('notify', true, 'Send notifications')}</div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Post update</button></div>
      </form>
      <form method="post" action="/admin/incidents/${i.id}" class="card form-grid">
        <h2>Details</h2>
        ${csrfField(ctx.csrf)}
        ${field('Title', input('title', i.title, { required: true, maxlength: 200 }))}
        ${field('Impact', select('impact', IMPACT_OPTS, i.impact))}
        ${field('Affected components', select('component_ids', components.map((c) => [c.id, c.name]), selected, { multiple: true }))}
        <div class="form-actions"><button class="btn" type="submit">Save details</button></div>
      </form>
    </div>
    <div class="card">
      <h2>Timeline</h2>
      ${updates.map(
        (u) => html`<div class="incident-update"><p><strong>${u.status[0].toUpperCase() + u.status.slice(1)}</strong> - ${multiline(u.message)}</p>
          <p class="muted small">${formatDateTime(u.created_at)}
          ${postButton({ action: `/admin/incidents/${i.id}/updates/${u.id}/delete`, csrf: ctx.csrf, label: 'delete', cls: 'link-button small', confirm: 'Delete this update?' })}</p></div>`,
      )}
    </div>`,
  });
}

// ---------------------------------------------------------------- maintenance

export function maintenancePage(ctx, items) {
  const now = Date.now();
  return adminLayout({
    ...ctx,
    title: 'Maintenance',
    active: 'maintenance',
    body: html`
    <div class="page-head"><h1>Maintenance windows</h1><div class="actions"><a class="btn btn-primary" href="/admin/maintenance/new">Schedule maintenance</a></div></div>
    <p class="muted">During a window, checks for the selected components still run but are excluded from uptime, the components show "Under maintenance", and down alerts are suppressed. Times are in ${config.timezone}.</p>
    ${items.length
      ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Title</th><th>Components</th><th>Starts</th><th>Ends</th><th>State</th></tr></thead>
      <tbody>${items.map(
        (m) => html`<tr><td><a href="/admin/maintenance/${m.id}">${m.title}</a></td><td>${m.components}</td>
        <td>${formatDateTime(m.starts_at)}</td><td>${formatDateTime(m.ends_at)}</td>
        <td>${m.ends_at <= now ? 'Completed' : m.starts_at <= now ? html`<span class="badge badge-c-maintenance">Active</span>` : 'Scheduled'}</td></tr>`,
      )}</tbody></table></div>`
      : html`<div class="card"><p>No maintenance windows.</p></div>`}`,
  });
}

export function maintenanceFormPage(ctx, { item, components, selected, errorList, isNew }) {
  return adminLayout({
    ...ctx,
    title: isNew ? 'Schedule maintenance' : item.title,
    active: 'maintenance',
    body: html`
    <div class="page-head"><h1>${isNew ? 'Schedule maintenance' : 'Edit maintenance'}</h1>
      ${isNew ? '' : html`<div class="actions">${postButton({ action: `/admin/maintenance/${item.id}/delete`, csrf: ctx.csrf, label: 'Delete', cls: 'btn btn-danger', confirm: 'Delete this maintenance window?' })}</div>`}
    </div>
    ${errors(errorList)}
    <form method="post" action="${isNew ? '/admin/maintenance' : `/admin/maintenance/${item.id}`}" class="card form-grid">
      ${csrfField(ctx.csrf)}
      ${field('Title', input('title', item.title, { required: true, maxlength: 200 }))}
      ${field('Description', html`<textarea name="description" rows="3" maxlength="5000">${item.description || ''}</textarea>`, 'Shown publicly.')}
      ${field(`Starts (${config.timezone})`, input('starts_at', typeof item.starts_at === 'number' ? tsToLocalInput(item.starts_at) : item.starts_at, { type: 'datetime-local', required: true }))}
      ${field(`Ends (${config.timezone})`, input('ends_at', typeof item.ends_at === 'number' ? tsToLocalInput(item.ends_at) : item.ends_at, { type: 'datetime-local', required: true }))}
      ${field('Affected components', select('component_ids', components.map((c) => [c.id, c.name]), selected, { multiple: true }), 'Hold Ctrl/⌘ to select several.')}
      ${isNew ? html`<div class="field">${checkbox('notify', true, 'Notify alert rules that have maintenance alerts enabled')}</div>` : ''}
      <div class="form-actions"><button class="btn btn-primary" type="submit">Save</button> <a class="btn" href="/admin/maintenance">Cancel</a></div>
    </form>`,
  });
}

// ---------------------------------------------------------------- alerts

export function alertsPage(ctx, { rules, smtpOk, recent }) {
  return adminLayout({
    ...ctx,
    title: 'Alerts',
    active: 'alerts',
    body: html`
    <div class="page-head"><h1>Alert rules</h1><div class="actions"><a class="btn btn-primary" href="/admin/alerts/new">New rule</a></div></div>
    ${smtpOk ? '' : html`<div class="flash flash-warn">Email is not configured. Set <code>SMTP_HOST</code>, <code>SMTP_FROM</code> (and usually <code>SMTP_USER</code>/<code>SMTP_PASSWORD</code>) to enable email rules.</div>`}
    ${rules.length
      ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Name</th><th>Channel</th><th>Events</th><th>Last sent</th><th></th></tr></thead>
      <tbody>${rules.map(
        (r) => html`<tr class="${r.enabled ? '' : 'disabled'}"><td><a href="/admin/alerts/${r.id}">${r.name}</a>${r.enabled ? '' : html` <span class="pill">disabled</span>`}</td>
        <td>${r.channel === 'discord' ? 'Discord' : 'Email'}</td>
        <td class="small">${[r.on_down && 'down', r.on_recovery && 'recovery', r.on_degraded && 'degraded', r.on_incident && 'incidents', r.on_maintenance && 'maintenance', r.on_tls_expiry && 'TLS expiry'].filter(Boolean).join(', ')}${r.repeat_minutes ? ` · repeat ${r.repeat_minutes} min` : ''}</td>
        <td>${r.last_sent_at ? relativeTime(r.last_sent_at) : '—'}${r.last_error ? html`<div class="err small">${r.last_error}</div>` : ''}</td>
        <td class="row-actions">${postButton({ action: `/admin/alerts/${r.id}/test`, csrf: ctx.csrf, label: 'Send test', cls: 'link-button' })}</td></tr>`,
      )}</tbody></table></div>`
      : html`<div class="card"><p>No alert rules yet.</p></div>`}
    <div class="card"><h2>Recent deliveries</h2>
      ${recent.length
        ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Time</th><th>Rule</th><th>Event</th><th>Monitor</th><th>Result</th></tr></thead>
        <tbody>${recent.map((a) => html`<tr><td>${formatDateTime(a.sent_at)}</td><td>${a.rule_name || '—'}</td><td>${a.event}</td><td>${a.monitor_name || '—'}</td>
        <td>${a.ok ? html`<span class="badge badge-up">sent</span>` : html`<span class="badge badge-down">failed</span> <span class="err small">${a.error}</span>`}</td></tr>`)}</tbody></table></div>`
        : html`<p class="muted">Nothing sent yet.</p>`}
    </div>`,
  });
}

export function alertFormPage(ctx, { rule: r, components, errorList, isNew }) {
  const scopes = String(r.scopes || '').split(',');
  const comps = r.component_ids ? String(r.component_ids).split(',') : [];
  return adminLayout({
    ...ctx,
    title: isNew ? 'New alert rule' : r.name,
    active: 'alerts',
    body: html`
    <div class="page-head"><h1>${isNew ? 'New alert rule' : `Alert rule: ${r.name}`}</h1>
      ${isNew ? '' : html`<div class="actions">
        ${postButton({ action: `/admin/alerts/${r.id}/test`, csrf: ctx.csrf, label: 'Send test' })}
        ${postButton({ action: `/admin/alerts/${r.id}/delete`, csrf: ctx.csrf, label: 'Delete', cls: 'btn btn-danger', confirm: 'Delete this alert rule?' })}</div>`}
    </div>
    ${errors(errorList)}
    <form method="post" action="${isNew ? '/admin/alerts' : `/admin/alerts/${r.id}`}" class="card form-grid">
      ${csrfField(ctx.csrf)}
      ${field('Name', input('name', r.name, { required: true, maxlength: 100 }))}
      ${field('Channel', select('channel', [['discord', 'Discord webhook'], ['email', 'Email (SMTP)']], r.channel))}
      ${field(
        'Destination',
        input('target', isNew ? r.target : '', { maxlength: 2000, placeholder: isNew ? 'https://discord.com/api/webhooks/…  or  ops@example.com, me@example.com' : 'Leave blank to keep the current destination', spellcheck: 'false', autocomplete: 'off' }),
        isNew ? 'Discord: webhook URL (Server settings → Integrations → Webhooks). Email: comma-separated addresses.' : html`Current: <code>${r.masked_target}</code>`,
      )}
      <fieldset class="field"><legend>Send when</legend>
        ${checkbox('on_down', r.on_down, 'A monitor goes down')}
        ${checkbox('on_recovery', r.on_recovery, 'A monitor recovers')}
        ${checkbox('on_degraded', r.on_degraded, 'A monitor becomes degraded (slow)')}
        ${checkbox('on_incident', r.on_incident, 'An incident is created, updated or resolved')}
        ${checkbox('on_maintenance', r.on_maintenance, 'Maintenance is scheduled')}
        ${checkbox('on_tls_expiry', r.on_tls_expiry, 'A TLS certificate expires within 14 days (max once a day)')}
      </fieldset>
      <fieldset class="field"><legend>Monitor scopes</legend>
        ${checkbox('scope_internal', scopes.includes('internal'), 'Internal checks')}
        ${checkbox('scope_public', scopes.includes('public'), 'Public checks')}
        ${checkbox('scope_canary', scopes.includes('canary'), 'Canary checks')}
      </fieldset>
      ${field('Only for components', select('component_ids', components.map((c) => [c.id, c.name]), comps, { multiple: true }), 'Leave empty for all components (monitors without a component only match "all").')}
      ${field('Repeat while down (minutes)', input('repeat_minutes', r.repeat_minutes, { type: 'number', min: 0, max: 10080 }), '0 = alert once per outage.')}
      <div class="field">${checkbox('enabled', r.enabled, 'Enabled')}</div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Save</button> <a class="btn" href="/admin/alerts">Cancel</a></div>
    </form>`,
  });
}

// ---------------------------------------------------------------- settings

export function settingsPage(ctx, { siteName, heading, footerLinks, logoVersion, display, sessions, info, errorList }) {
  return adminLayout({
    ...ctx,
    title: 'Settings',
    active: 'settings',
    body: html`
    <div class="page-head"><h1>Settings</h1></div>
    ${errors(errorList)}
    <div class="two-col">
      <form method="post" action="/admin/settings" class="card form-grid">
        <h2>Status page</h2>
        ${csrfField(ctx.csrf)}
        ${field('Site name', input('site_name', siteName, { required: true, maxlength: 60 }))}
        ${field('Heading', input('heading', heading, { required: true, maxlength: 80 }), 'Shown as "Current Status: <heading>".')}
        ${field('Footer links', html`<textarea name="footer_links" rows="3" maxlength="3000" placeholder="Website | https://example.com">${footerLinks}</textarea>`, 'One per line: Label | https://... (up to 6).')}
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save</button></div>
      </form>
      <form method="post" action="/admin/password" class="card form-grid">
        <h2>Change password</h2>
        ${csrfField(ctx.csrf)}
        ${field('Current password', input('current', '', { type: 'password', required: true, autocomplete: 'current-password' }))}
        ${field('New password', input('next', '', { type: 'password', required: true, minlength: 12, autocomplete: 'new-password' }), 'At least 12 characters.')}
        ${field('Repeat new password', input('confirm', '', { type: 'password', required: true, minlength: 12, autocomplete: 'new-password' }))}
        <div class="form-actions"><button class="btn btn-primary" type="submit">Change password</button></div>
        <p class="hint">Changing the password signs out all other sessions.</p>
      </form>
    </div>
    <form method="post" action="/admin/settings/display" class="card form-grid">
      <h2>Display</h2>
      ${csrfField(ctx.csrf)}
      ${field('History on the status page', select('history_days', [[30, '30 days'], [60, '60 days'], [90, '90 days']], display.historyDays))}
      <div class="field-row">
        ${field('Orange below (%)', input('orange_below', display.orangeBelow, { type: 'number', min: 0, max: 100, step: '0.01', required: true }), '100 = any failed check')}
        ${field('Red below (%)', input('red_below', display.redBelow, { type: 'number', min: 0, max: 100, step: '0.01', required: true }))}
      </div>
      <p class="hint">A day's bar turns orange or red when that day's uptime drops below these values.</p>
      <div class="field">${checkbox('slow_counts_as_up', display.slowCountsAsUp, 'Count slow responses as up')}</div>
      <fieldset class="field"><legend>Show on the public page</legend>
        ${checkbox('show_uptime', display.showUptime, 'Uptime percentage')}
        ${checkbox('show_response_time', display.showResponseTime, 'Response time')}
        ${checkbox('show_last_checked', display.showLastChecked, '"Checked x ago"')}
        ${checkbox('show_descriptions', display.showDescriptions, 'Component descriptions (? icon)')}
      </fieldset>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Save</button></div>
    </form>
    <div class="card">
      <h2>Logo</h2>
      <div class="logo-row">
        ${logoVersion
          ? html`<img class="logo-preview" src="/logo?v=${logoVersion}" alt="Current logo">`
          : html`<span class="muted">No logo uploaded. The default icon is used.</span>`}
      </div>
      <form method="post" action="/admin/branding/logo" enctype="multipart/form-data" class="logo-form">
        ${csrfField(ctx.csrf)}
        <input type="file" name="logo" accept="image/png,image/jpeg,image/webp,image/svg+xml" required>
        <button type="submit" class="btn">Upload</button>
      </form>
      <p class="hint">PNG, JPEG, WebP or SVG, up to 256 KB. Square images work best. Also used as the favicon.</p>
      ${logoVersion ? postButton({ action: '/admin/branding/logo/delete', csrf: ctx.csrf, label: 'Remove logo', cls: 'link-button' }) : ''}
    </div>
    <div class="card">
      <h2>Backup</h2>
      <p>Download a consistent copy of the SQLite database (monitors, history, incidents, settings). Alert destinations are included, so store it safely.</p>
      ${postButton({ action: '/admin/backup', csrf: ctx.csrf, label: 'Download database backup' })}
    </div>
    <div class="card">
      <h2>Active sessions</h2>
      <div class="table-wrap"><table class="table"><thead><tr><th>Signed in</th><th>Last seen</th><th>IP</th><th>Browser</th></tr></thead>
      <tbody>${sessions.map((s) => html`<tr><td>${formatDateTime(s.created_at)}${s.current ? html` <span class="pill">this session</span>` : ''}</td><td>${relativeTime(s.last_seen_at)}</td><td>${s.ip}</td><td class="small">${s.user_agent}</td></tr>`)}</tbody></table></div>
      ${postButton({ action: '/admin/sessions/revoke', csrf: ctx.csrf, label: 'Sign out all other sessions' })}
    </div>
    <div class="card">
      <h2>System</h2>
      <dl class="facts">
        <dt>Version</dt><dd>${VERSION} · Node ${process.versions.node} · SQLite ${info.sqlite}</dd>
        <dt>Public URL</dt><dd>${config.publicUrl}</dd>
        <dt>Timezone</dt><dd>${config.timezone}</dd>
        <dt>Database</dt><dd>${info.dbSize} · ${info.checkCount} raw checks kept for ${config.rawRetentionDays} days, daily stats for ${config.dailyRetentionDays} days</dd>
        <dt>Email (SMTP)</dt><dd>${info.smtp}</dd>
        <dt>Uptime</dt><dd>${formatDuration(process.uptime() * 1000)}</dd>
      </dl>
    </div>`,
  });
}
