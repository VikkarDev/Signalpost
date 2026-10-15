import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './lib/log.js';
import { migrations } from './migrations.js';

let db = null;

export function openDatabase(file = path.join(config.dataDir, 'signalpost.db')) {
  if (file !== ':memory:') {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      throw new Error(
        `Data directory ${dir} is not writable by the container user (uid ${process.getuid?.()}). ` +
          'Use the named Docker volume from docker-compose.yml, or give UID 1000 write access to your bind-mounted folder.',
      );
    }
  }
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate();
  return db;
}

export function closeDatabase() {
  if (db) {
    try {
      db.exec('PRAGMA optimize');
    } catch {
      /* best effort */
    }
    db.close();
    db = null;
  }
}

function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    log.info('applying database migration', { version: m.version, name: m.name });
    tx(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, Date.now());
    });
  }
  const latest = migrations.at(-1)?.version ?? 0;
  const newest = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v ?? 0;
  if (newest > latest) {
    throw new Error(`Database schema version ${newest} is newer than this application supports (${latest}). Use a newer image.`);
  }
}

// node:sqlite rejects `undefined` and booleans; normalise parameters.
function norm(params) {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

export function get(sql, ...params) {
  return stmt(sql).get(...norm(params));
}
export function all(sql, ...params) {
  return stmt(sql).all(...norm(params));
}
export function run(sql, ...params) {
  return stmt(sql).run(...norm(params));
}

let depth = 0;
export function tx(fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

export function healthy() {
  try {
    return get('SELECT 1 AS ok').ok === 1;
  } catch {
    return false;
  }
}

/** Write a consistent copy of the database to `dest` (used for admin backups). */
export function backupTo(dest) {
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  db.prepare('VACUUM INTO ?').run(dest);
}

export function getSetting(key, def = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : def;
}

export function setSetting(key, value) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    String(value),
  );
}
