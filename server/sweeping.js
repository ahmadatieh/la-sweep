import { nextOccurrence, buildGcalUrl } from './schedule.js';

const GEOCODER_URL =
  'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const SOCRATA_URL = 'https://data.lacity.org/resource/krk7-ayq2.json';

/**
 * The LA open-data Socrata dataset `krk7-ayq2` ("Posted Street Sweeping
 * Routes") no longer carries a geometry column. We used to do a spatial
 * `within_circle()` query; that endpoint now 400s with "No such column: the_geom".
 *
 * Fallback strategy: geocode the address, extract the street name, and ask
 * Socrata for rows whose `boundaries` description mentions that street. This
 * returns the routes whose polygon boundary *touches* the user's street.
 * Imperfect (a user on a side-street inside a polygon won't match) but it's
 * the best we can do without geometry. The UI disclaims this.
 */

/**
 * Map of common day-abbreviation variants used in the LA dataset to a
 * weekday index compatible with JavaScript's Date#getDay:
 *   0 = Sunday, 1 = Monday, ... 6 = Saturday.
 */
const DAY_ABBR_TO_INDEX = {
  SUN: 0, SU: 0,
  MON: 1, M: 1,
  TUE: 2, TU: 2, TUES: 2,
  WED: 3, W: 3, WE: 3,
  THU: 4, TH: 4, THUR: 4, THURS: 4,
  FRI: 5, F: 5, FR: 5,
  SAT: 6, SA: 6,
};

// Common street-type suffixes we'll strip when reducing an address to its
// "core" street name. Kept broad so we match what the Census geocoder returns.
const STREET_SUFFIXES = new Set([
  'BLVD', 'BL', 'BOULEVARD',
  'AVE', 'AV', 'AVENUE',
  'ST', 'STREET',
  'DR', 'DRIVE',
  'RD', 'ROAD',
  'PL', 'PLACE',
  'WAY', 'WY',
  'CT', 'COURT',
  'LN', 'LANE',
  'CIR', 'CIRCLE',
  'PKWY', 'PARKWAY',
  'HWY', 'HIGHWAY',
  'TER', 'TERRACE',
  'TRL', 'TRAIL',
  'SQ', 'SQUARE',
  'ALY', 'ALLEY',
  'FWY', 'FREEWAY',
]);

const DIRECTIONALS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

export async function lookupAddress(address) {
  const location = await geocode(address);
  const streetName = extractStreetName(location.matchedAddress);

  if (!streetName) {
    return {
      input: address,
      matchedAddress: location.matchedAddress,
      coordinates: { lat: location.lat, lng: location.lng },
      schedules: [],
      streetName: null,
      source: 'data.lacity.org krk7-ayq2 (Posted Street Sweeping Routes)',
      note: "Couldn't extract a street name from the matched address.",
    };
  }

  const routes = await findRoutesByStreetName(streetName);

  const parsed = routes.map(parseRow).filter((r) => r.startTime && r.endTime);

  const enriched = parsed.map((r) => {
    const dayIndex =
      r.dayAbbr && DAY_ABBR_TO_INDEX[r.dayAbbr.toUpperCase()] != null
        ? DAY_ABBR_TO_INDEX[r.dayAbbr.toUpperCase()]
        : null;

    if (dayIndex == null) {
      // Dataset doesn't currently expose day-of-week, so we can't compute a
      // next occurrence or a calendar link. The UI shows the route/time and
      // tells the user to confirm with the posted sign.
      return { ...r, dayIndex: null, nextSweep: null, gcalUrl: null };
    }

    const next = nextOccurrence(dayIndex, r.startTime, r.endTime);
    const gcalUrl = buildGcalUrl({
      address: location.matchedAddress,
      routeNo: r.routeNo,
      boundaries: r.boundaries,
      start: next.start,
      end: next.end,
    });
    return { ...r, dayIndex, nextSweep: next, gcalUrl };
  });

  // De-duplicate identical route+day+time rows and sort by soonest sweep
  // (rows without a known day sink to the bottom).
  const uniqMap = new Map();
  for (const row of enriched) {
    const key = `${row.routeNo}|${row.dayAbbr}|${row.startTime}|${row.endTime}`;
    if (!uniqMap.has(key)) uniqMap.set(key, row);
  }
  const schedules = [...uniqMap.values()].sort((a, b) => {
    const ta = a.nextSweep ? Date.parse(a.nextSweep.start) : Infinity;
    const tb = b.nextSweep ? Date.parse(b.nextSweep.start) : Infinity;
    return ta - tb;
  });

  return {
    input: address,
    matchedAddress: location.matchedAddress,
    coordinates: { lat: location.lat, lng: location.lng },
    streetName,
    schedules,
    source: 'data.lacity.org krk7-ayq2 (Posted Street Sweeping Routes)',
    matchMode: 'street-name-text-match',
  };
}

/**
 * Geocode a one-line address using the US Census Geocoder (free, no API key).
 */
async function geocode(address) {
  const params = new URLSearchParams({
    address,
    benchmark: 'Public_AR_Current',
    format: 'json',
  });
  const res = await fetch(`${GEOCODER_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`Geocoder returned ${res.status}`);
  const data = await res.json();
  const match = data?.result?.addressMatches?.[0];
  if (!match) {
    throw new Error(
      `Could not geocode "${address}". Try a more complete address (e.g. "123 Main St, Los Angeles, CA").`
    );
  }
  return {
    lat: Number(match.coordinates.y),
    lng: Number(match.coordinates.x),
    matchedAddress: match.matchedAddress,
  };
}

/**
 * Reduce a matched address like "1234 N SUNSET BLVD, LOS ANGELES, CA, 90026"
 * to its core street name "SUNSET", which is what we'll search for in the
 * `boundaries` field. Returns null if we can't find anything.
 *
 * We keep only the "core" name token(s), dropping the house number, any
 * leading directional (N/S/E/W), and the trailing suffix (BLVD/AVE/etc.).
 * Streets with multi-word names like "LAUREL CYN BL" keep "LAUREL CYN",
 * which is how the LA dataset abbreviates them in boundary descriptions.
 */
export function extractStreetName(matchedAddress) {
  if (!matchedAddress) return null;
  const firstPart = String(matchedAddress).split(',')[0] || '';

  // Tokenize; strip the leading house number if present.
  let tokens = firstPart.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (tokens.length && /^\d[-\dA-Z]*$/.test(tokens[0])) {
    tokens = tokens.slice(1);
  }
  // Optional leading directional.
  if (tokens.length && DIRECTIONALS.has(tokens[0])) {
    tokens = tokens.slice(1);
  }
  // Strip trailing suffix (allow a trailing directional too, e.g. "1ST ST W").
  if (tokens.length > 1 && DIRECTIONALS.has(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
  }
  if (tokens.length > 1) {
    const last = tokens[tokens.length - 1].replace(/\.$/, '');
    if (STREET_SUFFIXES.has(last)) {
      tokens = tokens.slice(0, -1);
    }
  }

  const core = tokens.join(' ').trim();
  return core || null;
}

/**
 * Query Socrata for routes whose `boundaries` field contains the street name.
 *
 * We use SoQL `like` with wildcards to substring-match against the uppercased
 * boundary text. Example:
 *   $where=upper(boundaries) like '%SUNSET%'
 */
async function findRoutesByStreetName(streetName) {
  const needle = streetName.toUpperCase().replace(/[%_']/g, ' ').trim();
  if (!needle) return [];

  const where = `upper(boundaries) like '%${needle}%'`;
  const url = `${SOCRATA_URL}?$where=${encodeURIComponent(where)}&$limit=50`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `LA data portal returned ${res.status}: ${body.slice(0, 300)}`
    );
  }
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  if (rows.length > 0) {
    console.log(
      `[sweeping] matched ${rows.length} routes for "${needle}". Sample keys:`,
      Object.keys(rows[0])
    );
  }
  return rows;
}

/**
 * Normalize a Socrata row into a stable shape. Field names on LA datasets have
 * shifted over the years, so we check a handful of likely column names for
 * each logical field. Day-of-week may be absent entirely; that's handled in
 * the caller.
 */
function parseRow(row) {
  const pick = (...names) => {
    for (const n of names) {
      if (row[n] != null && row[n] !== '') return row[n];
    }
    return '';
  };
  return {
    routeNo: String(pick('route_no', 'route', 'route_number', 'routeno'))
      .replace(/^\*\s*/, '') // some rows prefix with "* " for special routes
      .trim(),
    dayAbbr: String(pick('weekday', 'day_of_week', 'day', 'dow')).trim(),
    startTime: String(pick('time_start', 'start_time', 'starttime', 'start')).trim(),
    endTime: String(pick('time_end', 'end_time', 'endtime', 'end')).trim(),
    boundaries: String(pick('boundaries', 'description', 'location_description')).trim(),
    councilDistrict: String(pick('cd', 'council_district', 'councildistrict')).trim(),
  };
}
