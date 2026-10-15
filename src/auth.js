import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';
import { get, run, all } from './db.js';
import { log } from './lib/log.js';
import { parseCookies, isHttps, randomToken, sha256, timingSafeEqualStr, RateLimiter } from './lib/http.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 65536, r: 8, p: 1, keylen: 64 };
const SESSION_COOKIE = 'sp_session';
export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 160 * 1024 * 1024,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 160 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(key, expected);
}

// Used to keep login timing similar for unknown usernames.
let dummyHash = null;

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (pw.length > 256) return 'Password is too long.';
  if (/change_?me/i.test(pw)) return 'Password still contains the CHANGE_ME placeholder; choose a real password.';
  return null;
}

/** Create or reset the initial admin from ADMIN_USERNAME / ADMIN_PASSWORD. */
export async function bootstrapAdmin() {
  dummyHash = await hashPassword(randomToken(16));
  const count = get('SELECT COUNT(*) AS n FROM users').n;
  const username = config.adminUsername;
  const pw = config.adminPassword;

  if (count === 0) {
    if (!pw) {
      log.warn('no admin account exists yet; set ADMIN_PASSWORD (and optionally ADMIN_USERNAME) and restart the container');
      return;
    }
    const problem = validatePassword(pw);
    if (problem) {
      log.error('ADMIN_PASSWORD rejected; admin account not created', { reason: problem });
      return;
    }
    const now = Date.now();
    run('INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)', username, await hashPassword(pw), now, now);
    log.info('initial admin account created', { username });
    return;
  }

  if (config.adminResetPassword) {
    if (!pw || validatePassword(pw)) {
      log.error('ADMIN_RESET_PASSWORD is set but ADMIN_PASSWORD is missing or too short; nothing changed');
      return;
    }
    const now = Date.now();
    const existing = get('SELECT id FROM users WHERE username = ?', username);
    const hash = await hashPassword(pw);
    if (existing) {
      run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, now, existing.id);
      run('DELETE FROM sessions WHERE user_id = ?', existing.id);
    } else {
      run('INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)', username, hash, now, now);
    }
    log.warn('admin password reset from environment; remove ADMIN_RESET_PASSWORD now', { username });
  }
}

export function adminExists() {
  return get('SELECT COUNT(*) AS n FROM users').n > 0;
}

const ipFailures = new RateLimiter(config.loginMaxAttempts, config.loginWindowMinutes * 60000);
const userFailures = new RateLimiter(config.loginMaxAttempts * 2, config.loginWindowMinutes * 60000);

/**
 * Returns { user } on success, or { error, retryAfter? }.
 * Failed attempts are throttled per client IP and per username.
 */
export async function attemptLogin(username, password, ip) {
  const uname = String(username || '').trim().toLowerCase().slice(0, 100);
  if (ipFailures.count(ip) >= config.loginMaxAttempts || userFailures.count(uname) >= config.loginMaxAttempts * 2) {
    const retryAfter = Math.max(ipFailures.retryAfter(ip), userFailures.retryAfter(uname));
    log.warn('login throttled', { ip, username: uname });
    return { error: 'Too many failed attempts. Try again later.', retryAfter };
  }
  const user = get('SELECT * FROM users WHERE username = ?', uname);
  const ok = await verifyPassword(String(password || ''), user ? user.password_hash : dummyHash).catch(() => false);
  if (!user || !ok) {
    ipFailures.hit(ip);
    userFailures.hit(uname);
    log.warn('login failed', { ip, username: uname });
    return { error: 'Invalid username or password.' };
  }
  ipFailures.reset(ip);
  userFailures.reset(uname);
  run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), user.id);
  log.info('login succeeded', { ip, username: user.username });
  return { user };
}

function cookieAttrs(req, maxAgeSeconds) {
  const secure = config.cookieSecure === 'auto' ? isHttps(req) : config.cookieSecure;
  return [`Path=/`, 'HttpOnly', 'SameSite=Lax', secure ? 'Secure' : null, `Max-Age=${maxAgeSeconds}`]
    .filter(Boolean)
    .join('; ');
}

export function createSession(req, res, user, ip) {
  const token = randomToken(32);
  const now = Date.now();
  const ttl = config.sessionTtlHours * 3600000;
  run(
    `INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    sha256(token),
    user.id,
    randomToken(24),
    now,
    now,
    now + ttl,
    ip,
    String(req.headers['user-agent'] || '').slice(0, 300),
  );
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieAttrs(req, config.sessionTtlHours * 3600)}`);
}

/** Load the session for a request; returns { user, session } or null. Slides expiry forward. */
export function loadSession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token || token.length > 100) return null;
  const now = Date.now();
  const row = get(
    `SELECT s.*, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ? AND s.expires_at > ?`,
    sha256(token),
    now,
  );
  if (!row) return null;
  if (now - row.last_seen_at > 60000) {
    run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?', now, now + config.sessionTtlHours * 3600000, row.id_hash);
  }
  return { user: { id: row.user_id, username: row.username }, session: row };
}

export function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) run('DELETE FROM sessions WHERE id_hash = ?', sha256(token));
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieAttrs(req, 0)}`);
}

export function checkCsrf(session, token) {
  return Boolean(session && token && timingSafeEqualStr(session.csrf_token, token));
}

export async function changePassword(userId, current, next) {
  const user = get('SELECT * FROM users WHERE id = ?', userId);
  if (!user || !(await verifyPassword(current, user.password_hash))) return 'Current password is incorrect.';
  const problem = validatePassword(next);
  if (problem) return problem;
  run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(next), Date.now(), userId);
  return null;
}

export function revokeOtherSessions(userId, keepIdHash) {
  run('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?', userId, keepIdHash);
}

export function purgeExpiredSessions() {
  run('DELETE FROM sessions WHERE expires_at <= ?', Date.now());
}

export function listSessions(userId) {
  return all('SELECT id_hash, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC', userId);
}
