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
 * Parse a time string into { hour, minute } in 24-hour format. Handles the
 * formats the LA datasets throw at us:
 *   "8:00 AM", "10:00PM"         (with minutes + meridiem)
 *   "1 pm", "10 AM", "12 am"     (no minutes, lowercase fine, space optional)
 *   "08:00", "08:00:00"          (24-hour)
 * Returns null if unrecognized.
 */
export function parseTime(input) {
  if (!input) return null;
  const s = String(input).trim().toUpperCase();

  // "8:00 AM" / "10:00PM" — with minutes + meridiem
  const mMin = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (mMin) {
    let hour = Number(mMin[1]);
    const minute = Number(mMin[2]);
    const mer = mMin[3];
    if (mer === 'PM' && hour < 12) hour += 12;
    if (mer === 'AM' && hour === 12) hour = 0;
    return { hour, minute };
  }

  // "1 PM" / "10AM" — no minutes, meridiem only
  const mHourOnly = s.match(/^(\d{1,2})\s*(AM|PM)$/);
  if (mHourOnly) {
    let hour = Number(mHourOnly[1]);
    const mer = mHourOnly[2];
    if (mer === 'PM' && hour < 12) hour += 12;
    if (mer === 'AM' && hour === 12) hour = 0;
    return { hour, minute: 0 };
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
 * Which week-of-the-month is a given day-of-month? ("1st Thursday" = 1, etc.)
 * LA's dataset tags biweekly routes as "1 & 3" (the 1st & 3rd occurrence of
 * that weekday in the month) and "2 & 4" (2nd & 4th), which is exactly the
 * same as Math.ceil(dayOfMonth / 7).
 */
function nthWeekdayOfMonth(dayOfMonth) {
  return Math.ceil(dayOfMonth / 7);
}

/**
 * Parse a "weeks" string from the LA dataset into a sorted list of allowed
 * week ordinals. "1 & 3" → [1, 3]. Garbage / empty → [] (treat as weekly).
 */
export function parseAllowedWeeks(weeks) {
  if (!weeks) return [];
  const nums = String(weeks).match(/\d+/g);
  if (!nums) return [];
  return [
    ...new Set(nums.map(Number).filter((n) => n >= 1 && n <= 5)),
  ].sort((a, b) => a - b);
}

/**
 * Compute the next occurrence of a sweep in LA time. Respects the biweekly
 * "weeks" flag — e.g. a "weeks 1 & 3" Thursday route skips over the 2nd,
 * 4th, and 5th Thursdays of the month.
 *
 * @param {number} dayIndex 0=Sun..6=Sat (Date#getDay convention)
 * @param {string} startStr e.g. "8:00 AM"
 * @param {string} endStr   e.g. "10:00 AM"
 * @param {string|null} weeks e.g. "1 & 3" or null for weekly
 * @returns {{ start: string, end: string }} ISO strings in UTC
 */
export function nextOccurrence(dayIndex, startStr, endStr, weeks = null) {
  const startT = parseTime(startStr) || { hour: 8, minute: 0 };
  const endT =
    parseTime(endStr) || {
      hour: Math.min(23, startT.hour + 2),
      minute: startT.minute,
    };

  const allowedWeeks = parseAllowedWeeks(weeks);
  const now = laParts();

  // Start searching from the next instance of this weekday (today if it
  // hasn't passed).
  let daysAhead = (dayIndex - now.weekday + 7) % 7;
  if (daysAhead === 0) {
    const nowMinutes = now.hour * 60 + now.minute;
    const endMinutes = endT.hour * 60 + endT.minute;
    if (nowMinutes >= endMinutes) daysAhead = 7;
  }

  const laBase = new Date(Date.UTC(now.year, now.month - 1, now.day));
  laBase.setUTCDate(laBase.getUTCDate() + daysAhead);

  // If this is a biweekly route, walk forward 7 days at a time until we
  // land on an allowed week-of-month. Bounded at ~3 months so we can never
  // loop forever on malformed data.
  if (allowedWeeks.length > 0) {
    for (let guard = 0; guard < 15; guard++) {
      const n = nthWeekdayOfMonth(laBase.getUTCDate());
      if (allowedWeeks.includes(n)) break;
      laBase.setUTCDate(laBase.getUTCDate() + 7);
    }
  }

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

// iCalendar BYDAY codes indexed by Date#getDay convention (0=Sun..6=Sat).
const RRULE_DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Build an iCal RRULE for a *weekly* sweep (single BYDAY, no ordinals).
 * Google Calendar's /render endpoint displays this correctly as
 * "Weekly on Wednesday".
 *
 * Biweekly routes do NOT use this — they go through the .ics endpoint,
 * where a proper FREQ=MONTHLY;BYDAY=1WE,3WE rule can be expressed
 * (Google's /render UI silently collapses multi-ordinal rules to a single
 * ordinal label, so we avoid that code path entirely for biweekly).
 */
function buildWeeklyRRule(dayIndex) {
  const code = RRULE_DAY[dayIndex];
  if (!code) return null;
  return `RRULE:FREQ=WEEKLY;BYDAY=${code}`;
}

/**
 * Human-readable cadence string for the event description. Matches the
 * RRULE so the two tell the same story.
 */
function cadenceDescription(dayIndex, weeks) {
  const dayName =
    ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dayIndex] || '';
  if (weeks) {
    const nums = String(weeks).match(/\d+/g) || [];
    if (nums.length > 0) {
      const ordinal = (n) =>
        ({ 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' }[n] || `${n}`);
      const parts = nums.map(ordinal).join(' & ');
      return `Repeats: ${parts} ${dayName} of each month`;
    }
  }
  return dayName ? `Repeats: Every ${dayName}` : null;
}

/**
 * Build the "Add to Calendar" URL for a sweep schedule.
 *
 * Weekly routes get a Google Calendar /render URL with an inline RRULE —
 * one click, no download, shows up in the user's tab.
 *
 * Biweekly routes get a URL pointing at our own /api/calendar.ics
 * endpoint. Clicking it downloads a tiny file which, when opened, imports
 * into Google Calendar / Apple Calendar / Outlook with a proper
 * FREQ=MONTHLY;BYDAY=1WE,3WE rule — the one thing Google's /render UI
 * can't express correctly.
 */
export function buildGcalUrl({
  address,
  routeNo,
  boundaries,
  start,
  end,
  dayIndex,
  weeks = null,
  baseUrl = '',
}) {
  const isBiweekly = parseAllowedWeeks(weeks).length > 0;
  if (isBiweekly) {
    return buildIcsDownloadUrl({
      address, routeNo, boundaries, start, end, dayIndex, weeks, baseUrl,
    });
  }

  const dates = `${toGcalStamp(start)}/${toGcalStamp(end)}`;
  const cadence = dayIndex != null ? cadenceDescription(dayIndex, weeks) : null;
  const detailsLines = [
    'Do not park here during this window.',
    '',
    `Address: ${address || ''}`,
    routeNo ? `Route: ${routeNo}` : null,
    boundaries ? `Area: ${boundaries}` : null,
    cadence,
  ].filter(Boolean);

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: 'Move car - LA street sweeping',
    dates,
    details: detailsLines.join('\n'),
    location: address || '',
    ctz: LA_TZ,
  });

  let url = `https://calendar.google.com/calendar/render?${params.toString()}`;
  // Append recur raw — Google's parser handles unencoded RRULE characters
  // fine, while percent-encoded versions sometimes confuse its UI parser.
  const rrule = dayIndex != null ? buildWeeklyRRule(dayIndex) : null;
  if (rrule) url += `&recur=${rrule.replace(/ /g, '%20')}`;
  return url;
}

/**
 * Build an absolute URL to our /api/calendar.ics endpoint, carrying all
 * the event state in query params. The endpoint is stateless — no DB
 * lookup, no session — so the URL is self-contained.
 *
 * baseUrl is derived from the incoming /api/lookup request so the link
 * points back at whichever host the backend is running on (Render prod,
 * local dev, preview deploys). If baseUrl is empty we fall back to a
 * relative URL which works in local dev via the Vite proxy.
 */
function buildIcsDownloadUrl({
  address, routeNo, boundaries, start, end, dayIndex, weeks, baseUrl,
}) {
  const params = new URLSearchParams({
    address: address || '',
    routeNo: routeNo || '',
    boundaries: boundaries || '',
    start: typeof start === 'string' ? start : new Date(start).toISOString(),
    end: typeof end === 'string' ? end : new Date(end).toISOString(),
    dayIndex: String(dayIndex ?? ''),
    weeks: weeks || '',
  });
  const prefix = (baseUrl || '').replace(/\/+$/, '');
  return `${prefix}/api/calendar.ics?${params.toString()}`;
}
