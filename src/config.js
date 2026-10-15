// Configuration is read from environment variables only. See README.md for the full list.

function str(name, def = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v.trim();
}

function int(name, def, min = -Infinity, max = Infinity) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`Environment variable ${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

function bool(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function cookieSecure() {
  const v = str('COOKIE_SECURE', 'auto').toLowerCase();
  if (v === 'auto') return 'auto';
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    throw new Error(`Invalid timezone "${tz}". Use an IANA name such as Europe/Stockholm.`);
  }
}

export const config = Object.freeze({
  port: int('PORT', 3000, 1, 65535),
  host: str('HOST', '0.0.0.0'),
  dataDir: str('DATA_DIR', '/data'),
  publicUrl: str('PUBLIC_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  timezone: validTimezone(str('STATUS_TIMEZONE', str('TZ', 'UTC'))),
  logLevel: str('LOG_LEVEL', 'info').toLowerCase(),

  adminUsername: str('ADMIN_USERNAME', 'admin'),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  adminResetPassword: bool('ADMIN_RESET_PASSWORD', false),

  sessionTtlHours: int('SESSION_TTL_HOURS', 12, 1, 24 * 30),
  cookieSecure: cookieSecure(),
  trustProxy: bool('TRUST_PROXY', true),

  loginMaxAttempts: int('LOGIN_MAX_ATTEMPTS', 5, 1, 100),
  loginWindowMinutes: int('LOGIN_WINDOW_MINUTES', 15, 1, 1440),
  publicRateLimitPerMinute: int('PUBLIC_RATE_LIMIT_PER_MINUTE', 120, 10, 100000),

  maxConcurrentChecks: int('MAX_CONCURRENT_CHECKS', 8, 1, 100),
  minCheckIntervalSeconds: int('MIN_CHECK_INTERVAL_SECONDS', 20, 5, 3600),
  rawRetentionDays: int('RAW_RETENTION_DAYS', 14, 1, 400),
  dailyRetentionDays: int('DAILY_RETENTION_DAYS', 400, 91, 5000),

  smtp: Object.freeze({
    host: str('SMTP_HOST'),
    port: int('SMTP_PORT', 587, 1, 65535),
    secure: bool('SMTP_SECURE', false),
    user: str('SMTP_USER'),
    pass: process.env.SMTP_PASSWORD || '',
    from: str('SMTP_FROM'),
  }),

  siteNameDefault: str('SITE_NAME', 'Status'),
  shutdownTimeoutMs: int('SHUTDOWN_TIMEOUT_MS', 10000, 1000, 120000),
});

export function smtpConfigured() {
  return Boolean(config.smtp.host && config.smtp.from);
}
