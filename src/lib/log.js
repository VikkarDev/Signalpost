// JSON logs, one object per line on stdout/stderr. Easy to read in `docker logs` and easy to ship elsewhere.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function serializeError(err) {
  if (!(err instanceof Error)) return err;
  return { name: err.name, message: err.message, code: err.code, stack: err.stack };
}

function write(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const entry = { ts: new Date().toISOString(), level, msg };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      entry[k] = v instanceof Error ? serializeError(v) : v;
    }
  }
  const line = JSON.stringify(entry) + '\n';
  if (LEVELS[level] >= LEVELS.warn) process.stderr.write(line);
  else process.stdout.write(line);
}

export const log = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};
