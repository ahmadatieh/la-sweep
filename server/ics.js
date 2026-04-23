/**
 * Build an iCalendar (.ics) string for a sweep schedule.
 *
 * Why .ics instead of a Google Calendar render URL for biweekly routes?
 * Google's /calendar/render endpoint has a known bug where multi-ordinal
 * monthly recurrences like BYDAY=1WE,3WE collapse in the confirm UI to a
 * single ordinal ("Monthly on the first Wednesday"), even when the RRULE
 * itself is valid. Multi-RRULE events are rejected outright ("Does not
 * repeat"). The workaround is to hand the user an .ics file — Google,
 * Apple, and Outlook all preserve multi-ordinal RRULEs on import.
 *
 * The .ics embeds a VTIMEZONE for America/Los_Angeles so imports don't
 * drift across DST. DTSTART/DTEND are floating local times referencing
 * TZID; imports handle PST↔PDT correctly.
 */

import { parseAllowedWeeks } from './schedule.js';

const LA_TZ = 'America/Los_Angeles';

// iCalendar BYDAY codes indexed by Date#getDay convention (0=Sun..6=Sat).
const ICS_DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_FULL = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday',
];

/**
 * Minimal America/Los_Angeles VTIMEZONE block. PST/PDT transition rules
 * since 2007 (DST starts 2nd Sunday of March, ends 1st Sunday of November).
 */
const LA_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  `TZID:${LA_TZ}`,
  'BEGIN:STANDARD',
  'DTSTART:20071104T020000',
  'TZOFFSETFROM:-0700',
  'TZOFFSETTO:-0800',
  'TZNAME:PST',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:20070311T020000',
  'TZOFFSETFROM:-0800',
  'TZOFFSETTO:-0700',
  'TZNAME:PDT',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
];

/**
 * Escape a TEXT value per RFC 5545 §3.3.11. Commas and semicolons are
 * property separators in iCal, so they must be backslash-escaped inside
 * TEXT values like SUMMARY/LOCATION/DESCRIPTION.
 */
function icsEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Format a UTC Date as YYYYMMDDTHHMMSSZ (used by DTSTAMP).
 */
function toIcsUtc(date) {
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
 * Convert a UTC ISO string to a floating-local YYYYMMDDTHHMMSS string in
 * America/Los_Angeles — the format iCal expects with TZID references.
 */
function toIcsLocalLA(isoUtc) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: LA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(isoUtc)).map((p) => [p.type, p.value])
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return (
    `${parts.year}${parts.month}${parts.day}` +
    `T${hour}${parts.minute}${parts.second}`
  );
}

/**
 * Build the BYDAY list for the RRULE.
 *
 *   weekly route                    → ["WE"]
 *   biweekly "1 & 3" on Wednesday   → ["1WE", "3WE"]
 *   biweekly "2 & 4" on Thursday    → ["2TH", "4TH"]
 *
 * When a biweekly route has no parseable week ordinals (empty weeks field),
 * we fall back to FREQ=WEEKLY;INTERVAL=2 — still correct, just less pretty.
 */
function buildRRule(dayIndex, weeksRaw) {
  const code = ICS_DAY[dayIndex];
  if (!code) return null;

  const weeks = parseAllowedWeeks(weeksRaw);
  if (weeks.length === 0) {
    return `RRULE:FREQ=WEEKLY;BYDAY=${code}`;
  }
  // Multi-ordinal monthly — Google imports this correctly from .ics.
  const byday = weeks.map((w) => `${w}${code}`).join(',');
  return `RRULE:FREQ=MONTHLY;BYDAY=${byday}`;
}

function ordinal(n) {
  return { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' }[n] || `${n}`;
}

function cadenceLine(dayIndex, weeksRaw) {
  const dayName = DAY_FULL[dayIndex] || '';
  if (!dayName) return null;
  const weeks = parseAllowedWeeks(weeksRaw);
  if (weeks.length === 0) return `Repeats: every ${dayName}`;
  const parts = weeks.map(ordinal).join(' & ');
  return `Repeats: ${parts} ${dayName} of each month`;
}

/**
 * Build a complete VCALENDAR string (CRLF-delimited per RFC 5545) for the
 * given sweep schedule. The returned string is ready to be sent with
 * Content-Type: text/calendar.
 */
export function buildIcs({
  address = '',
  routeNo = '',
  boundaries = '',
  start,
  end,
  dayIndex,
  weeks = null,
  uidSeed = '',
}) {
  const rrule = dayIndex != null ? buildRRule(dayIndex, weeks) : null;
  const cadence = dayIndex != null ? cadenceLine(dayIndex, weeks) : null;

  const descriptionLines = [
    'Do not park here during this window.',
    '',
    `Address: ${address}`,
    routeNo ? `Route: ${routeNo}` : null,
    boundaries ? `Area: ${boundaries}` : null,
    cadence,
  ].filter(Boolean);

  // Stable-ish UID so reimports replace rather than duplicate. Falls back
  // to a random chunk if caller didn't provide a seed.
  const uid =
    `sweep-${(uidSeed || routeNo || 'route').replace(/\s+/g, '-')}` +
    `-${ICS_DAY[dayIndex] || 'x'}@la-sweep`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//la-sweep//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...LA_VTIMEZONE,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toIcsUtc(new Date())}`,
    `DTSTART;TZID=${LA_TZ}:${toIcsLocalLA(start)}`,
    `DTEND;TZID=${LA_TZ}:${toIcsLocalLA(end)}`,
    `SUMMARY:${icsEscape('Move car - LA street sweeping')}`,
    `LOCATION:${icsEscape(address)}`,
    `DESCRIPTION:${icsEscape(descriptionLines.join('\n'))}`,
    rrule,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);

  return lines.join('\r\n');
}
