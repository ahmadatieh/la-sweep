/**
 * Schedule helpers: parsing times, computing the next occurrence of a weekly
 * sweep in America/Los_Angeles time, and building a Google Calendar "create
 * event" prefilled URL.
 *
 * All computations are done in Pacific time so daylight saving is handled
 * correctly without pulling in a timezone library.
 */

const LA_TZ = 'America/Los_Angeles';

/**
 * Parse a time string like "8:00 AM", "10:00 PM", or "08:00:00" into
 * { hour, minute } in 24-hour format. Returns null if unrecognized.
 */
export function parseTime(input) {
  if (!input) return null;
  const s = String(input).trim();

  // "8:00 AM" / "10:00 PM"
  const m12 = s.toUpperCase().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (m12) {
    let hour = Number(m12[1]);
    const minute = Number(m12[2]);
    const mer = m12[3];
    if (mer === 'PM' && hour < 12) hour += 12;
    if (mer === 'AM' && hour === 12) hour = 0;
    return { hour, minute };
  }

  // "08:00" or "08:00:00" (24-hour)
  const m24 = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m24) return { hour: Number(m24[1]), minute: Number(m24[2]) };

  return null;
}

/**
 * Extract year/month/day/hour/minute/weekday for the current moment in LA.
 * weekday: 0 = Sunday ... 6 = Saturday (matches Date#getDay).
 */
function laParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: LA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value])
  );
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // Intl returns "24" at midnight in hour12:false; normalize to 0.
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdayMap[parts.weekday],
  };
}

/**
 * Given a calendar Y/M/D/H/M in LA local time, return a UTC Date instant.
 * Handles DST by looking up the LA UTC offset for that specific instant.
 */
function laLocalToUtc(y, m, d, hh, mm) {
  // Interpret the given local wall-clock time in America/Los_Angeles and
  // return the corresponding UTC Date. Strategy:
  //   1. Pretend the local time is actually UTC (a "naive" instant).
  //   2. Look up LA's UTC offset for that instant (handles DST).
  //   3. Subtract the offset to get the real UTC instant.
  // LA's offset is negative (UTC-7 or UTC-8), so subtracting a negative
  // number adds hours, which is what we want.
  const iso = `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00Z`;
  const naive = new Date(iso);
  const offsetMinutes = laOffsetMinutes(naive);
  return new Date(naive.getTime() - offsetMinutes * 60 * 1000);
}

/**
 * Returns the minutes to add to a UTC instant to get its LA wall-clock time.
 * e.g. during PST returns -480, during PDT returns -420.
 */
function laOffsetMinutes(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: LA_TZ,
    timeZoneName: 'shortOffset',
  });
  const parts = fmt.formatToParts(date);
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT-8';
  // Examples: "GMT-7", "GMT-08:00"
  const m = tz.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return -480;
  const sign = m[1] === '+' ? 1 : -1;
  const hours = Number(m[2]);
  const mins = Number(m[3] || '0');
  return sign * (hours * 60 + mins);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Compute the next occurrence of a weekly sweep in LA time.
 *
 * @param {number} dayIndex 0=Sun..6=Sat (Date#getDay convention)
 * @param {string} startStr e.g. "8:00 AM"
 * @param {string} endStr   e.g. "10:00 AM"
 * @returns {{ start: string, end: string }} ISO strings in UTC
 */
export function nextOccurrence(dayIndex, startStr, endStr) {
  const startT = parseTime(startStr) || { hour: 8, minute: 0 };
  const endT =
    parseTime(endStr) || {
      hour: Math.min(23, startT.hour + 2),
      minute: startT.minute,
    };

  const now = laParts();

  // Days until the target weekday. If it's the same day, check whether the
  // sweep window has already ended in LA time — if so, bump to next week.
  let daysAhead = (dayIndex - now.weekday + 7) % 7;
  if (daysAhead === 0) {
    const nowMinutes = now.hour * 60 + now.minute;
    const endMinutes = endT.hour * 60 + endT.minute;
    if (nowMinutes >= endMinutes) daysAhead = 7;
  }

  // Compute LA-local Y/M/D for the target date.
  const laBase = new Date(Date.UTC(now.year, now.month - 1, now.day));
  laBase.setUTCDate(laBase.getUTCDate() + daysAhead);
  const ty = laBase.getUTCFullYear();
  const tm = laBase.getUTCMonth() + 1;
  const td = laBase.getUTCDate();

  const start = laLocalToUtc(ty, tm, td, startT.hour, startT.minute);
  const end = laLocalToUtc(ty, tm, td, endT.hour, endT.minute);

  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Format a Date as YYYYMMDDTHHMMSSZ (used by Google Calendar URL params).
 */
function toGcalStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

/**
 * Build a Google Calendar "create event" URL. Users click it and confirm;
 * no OAuth required.
 */
export function buildGcalUrl({ address, routeNo, boundaries, start, end }) {
  const dates = `${toGcalStamp(start)}/${toGcalStamp(end)}`;
  const detailsLines = [
    'Do not park here during this window.',
    '',
    `Address: ${address || ''}`,
    routeNo ? `Route: ${routeNo}` : null,
    boundaries ? `Area: ${boundaries}` : null,
  ].filter(Boolean);

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: 'Move car - LA street sweeping',
    dates,
    details: detailsLines.join('\n'),
    location: address || '',
    ctz: LA_TZ,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
