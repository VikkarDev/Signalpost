// Ordered, append-only list of schema migrations.
// Never edit a migration that has shipped; add a new one with the next version number.
// Each migration runs inside a transaction and is recorded in schema_migrations.
// All timestamps are integer milliseconds since the Unix epoch (UTC).

export const migrations = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE components (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE monitors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  component_id INTEGER REFERENCES components(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('http', 'tcp', 'ping')),
  scope TEXT NOT NULL DEFAULT 'public' CHECK (scope IN ('internal', 'public', 'canary')),
  target TEXT NOT NULL,
  port INTEGER,
  method TEXT NOT NULL DEFAULT 'GET',
  expected_status TEXT NOT NULL DEFAULT '200-399',
  keyword TEXT,
  ignore_tls INTEGER NOT NULL DEFAULT 0,
  follow_redirects INTEGER NOT NULL DEFAULT 1,
  interval_s INTEGER NOT NULL DEFAULT 60,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  degraded_ms INTEGER,
  failure_threshold INTEGER NOT NULL DEFAULT 2,
  enabled INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('up', 'degraded', 'down', 'unknown')),
  state_since INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  last_response_ms INTEGER,
  last_status_code INTEGER,
  last_error TEXT,
  tls_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_monitors_component ON monitors(component_id);

CREATE TABLE checks (
  id INTEGER PRIMARY KEY,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  checked_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('up', 'degraded', 'down')),
  response_ms INTEGER,
  status_code INTEGER,
  error TEXT,
  in_maintenance INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_checks_monitor_time ON checks(monitor_id, checked_at);
CREATE INDEX idx_checks_time ON checks(checked_at);

-- One row per monitor per calendar day (in STATUS_TIMEZONE), updated on every check.
CREATE TABLE daily_stats (
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  up INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  down INTEGER NOT NULL DEFAULT 0,
  maintenance INTEGER NOT NULL DEFAULT 0,
  response_sum INTEGER NOT NULL DEFAULT 0,
  response_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (monitor_id, day)
);

CREATE TABLE incidents (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  impact TEXT NOT NULL CHECK (impact IN ('none', 'minor', 'major', 'critical')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX idx_incidents_created ON incidents(created_at);

CREATE TABLE incident_components (
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  PRIMARY KEY (incident_id, component_id)
);

CREATE TABLE incident_updates (
  id INTEGER PRIMARY KEY,
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_incident_updates_incident ON incident_updates(incident_id, created_at);

CREATE TABLE maintenances (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_maintenances_window ON maintenances(starts_at, ends_at);

CREATE TABLE maintenance_components (
  maintenance_id INTEGER NOT NULL REFERENCES maintenances(id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  PRIMARY KEY (maintenance_id, component_id)
);

CREATE TABLE alert_rules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('discord', 'email')),
  target TEXT NOT NULL,
  on_down INTEGER NOT NULL DEFAULT 1,
  on_recovery INTEGER NOT NULL DEFAULT 1,
  on_degraded INTEGER NOT NULL DEFAULT 0,
  on_incident INTEGER NOT NULL DEFAULT 1,
  on_maintenance INTEGER NOT NULL DEFAULT 0,
  on_tls_expiry INTEGER NOT NULL DEFAULT 1,
  scopes TEXT NOT NULL DEFAULT 'internal,public,canary',
  component_ids TEXT,
  repeat_minutes INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sent_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE alert_log (
  id INTEGER PRIMARY KEY,
  rule_id INTEGER REFERENCES alert_rules(id) ON DELETE CASCADE,
  monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX idx_alert_log_rule_monitor ON alert_log(rule_id, monitor_id, event, sent_at);
CREATE INDEX idx_alert_log_time ON alert_log(sent_at);
`,
  },
  {
    version: 2,
    name: 'component groups',
    sql: `ALTER TABLE components ADD COLUMN group_name TEXT NOT NULL DEFAULT '';`,
  },
  {
    version: 3,
    name: 'ntfy and webhook alerts',
    // SQLite can't change a CHECK constraint, so the table is rebuilt. Foreign keys are
    // off while migrations run (see db.js), so alert_log rows survive the DROP.
    sql: `
CREATE TABLE alert_rules_new (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('discord', 'email', 'ntfy', 'webhook')),
  target TEXT NOT NULL,
  token TEXT,
  on_down INTEGER NOT NULL DEFAULT 1,
  on_recovery INTEGER NOT NULL DEFAULT 1,
  on_degraded INTEGER NOT NULL DEFAULT 0,
  on_incident INTEGER NOT NULL DEFAULT 1,
  on_maintenance INTEGER NOT NULL DEFAULT 0,
  on_tls_expiry INTEGER NOT NULL DEFAULT 1,
  scopes TEXT NOT NULL DEFAULT 'internal,public,canary',
  component_ids TEXT,
  repeat_minutes INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sent_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO alert_rules_new (id, name, channel, target, on_down, on_recovery, on_degraded, on_incident, on_maintenance,
  on_tls_expiry, scopes, component_ids, repeat_minutes, enabled, last_sent_at, last_error, created_at, updated_at)
SELECT id, name, channel, target, on_down, on_recovery, on_degraded, on_incident, on_maintenance,
  on_tls_expiry, scopes, component_ids, repeat_minutes, enabled, last_sent_at, last_error, created_at, updated_at
FROM alert_rules;
DROP TABLE alert_rules;
ALTER TABLE alert_rules_new RENAME TO alert_rules;
`,
  },
  {
    version: 4,
    name: 'dns and heartbeat checks, automatic incidents',
    // Rebuilt for the wider type CHECK; see migration 3 for why that's safe.
    sql: `
CREATE TABLE monitors_new (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  component_id INTEGER REFERENCES components(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('http', 'tcp', 'ping', 'dns', 'push')),
  scope TEXT NOT NULL DEFAULT 'public' CHECK (scope IN ('internal', 'public', 'canary')),
  target TEXT NOT NULL,
  port INTEGER,
  method TEXT NOT NULL DEFAULT 'GET',
  expected_status TEXT NOT NULL DEFAULT '200-399',
  keyword TEXT,
  ignore_tls INTEGER NOT NULL DEFAULT 0,
  follow_redirects INTEGER NOT NULL DEFAULT 1,
  interval_s INTEGER NOT NULL DEFAULT 60,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  degraded_ms INTEGER,
  failure_threshold INTEGER NOT NULL DEFAULT 2,
  enabled INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('up', 'degraded', 'down', 'unknown')),
  state_since INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  last_response_ms INTEGER,
  last_status_code INTEGER,
  last_error TEXT,
  tls_expires_at INTEGER,
  dns_record_type TEXT,
  dns_server TEXT,
  push_token TEXT UNIQUE,
  last_push_at INTEGER,
  auto_incident_minutes INTEGER,
  auto_incident_id INTEGER REFERENCES incidents(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO monitors_new (id, name, component_id, type, scope, target, port, method, expected_status, keyword, ignore_tls, follow_redirects, interval_s, timeout_ms, degraded_ms, failure_threshold, enabled, state, state_since, consecutive_failures, last_check_at, last_response_ms, last_status_code, last_error, tls_expires_at, created_at, updated_at)
SELECT id, name, component_id, type, scope, target, port, method, expected_status, keyword, ignore_tls, follow_redirects, interval_s, timeout_ms, degraded_ms, failure_threshold, enabled, state, state_since, consecutive_failures, last_check_at, last_response_ms, last_status_code, last_error, tls_expires_at, created_at, updated_at FROM monitors;
DROP TABLE monitors;
ALTER TABLE monitors_new RENAME TO monitors;
CREATE INDEX idx_monitors_component ON monitors(component_id);
`,
  },
];
