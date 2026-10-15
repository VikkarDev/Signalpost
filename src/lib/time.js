import { config } from '../config.js';

const DAY_MS = 86400000;
const partsCache = new Map();

function formatter(tz) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    partsCache.set(tz, f);
  }
  return f;
}

function wallParts(ts, tz) {
  const out = {};
  for (const p of formatter(tz).formatToParts(new Date(ts))) out[p.type] = p.value;
  return out;
}

/** Calendar day (YYYY-MM-DD) of a timestamp in the status timezone. */
export function dayKey(ts, tz = config.timezone) {
  const p = wallParts(ts, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The last `n` calendar days ending today, oldest first. */
export function lastDays(n, now = Date.now(), tz = config.timezone) {
  const today = dayKey(now, tz);
  const [y, m, d] = today.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d);
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    days.push(new Date(base - i * DAY_MS).toISOString().slice(0, 10));
  }
  return days;
}

function offsetMs(ts, tz) {
  const p = wallParts(ts, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Convert a `datetime-local` value (wall-clock time in tz) to a UTC timestamp. */
export function localInputToTs(value, tz = config.timezone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || '').trim());
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let ts = guess - offsetMs(guess, tz);
  // Second pass corrects for DST transitions between guess and result.
  ts = guess - offsetMs(ts, tz);
  return ts;
}

/** Format a timestamp as a `datetime-local` value in tz. */
export function tsToLocalInput(ts, tz = config.timezone) {
  if (!ts) return '';
  const p = wallParts(ts, tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

const timeFmt = new Map();
/** Short form for tables: "17:29" today, otherwise "14 Oct 17:29". */
export function formatTime(ts, tz = config.timezone, now = Date.now()) {
  let f = timeFmt.get(tz);
  if (!f) {
    f = {
      time: new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      date: new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
    };
    timeFmt.set(tz, f);
  }
  return dayKey(ts, tz) === dayKey(now, tz) ? f.time.format(new Date(ts)) : f.date.format(new Date(ts));
}

const displayFmt = new Map();
export function formatDateTime(ts, tz = config.timezone) {
  if (!ts) return '—';
  let f = displayFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
    displayFmt.set(tz, f);
  }
  return f.format(new Date(ts));
}

export function formatDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function relativeTime(ts, now = Date.now()) {
  if (!ts) return 'never';
  const s = Math.round((now - ts) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function formatDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}

export { DAY_MS };
