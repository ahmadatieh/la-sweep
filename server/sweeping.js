import { nextOccurrence, buildGcalUrl } from './schedule.js';

const GEOCODER_URL =
  'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const SOCRATA_URL = 'https://data.lacity.org/resource/krk7-ayq2.json';
const SOCRATA_COLUMNS_URL =
  'https://data.lacity.org/api/views/krk7-ayq2/columns.json';

// Geometry-like Socrata column types. Any one of these is a spatial column
// we can use with within_circle().
const GEOMETRY_RENDER_TYPES = new Set([
  'multiline', 'line', 'multilinestring',
  'multipolygon', 'polygon',
  'multipoint', 'point',
  'location',
]);

// Discovered once and cached for the life of the server.
let cachedGeomColumn = null;

async function getGeometryColumn() {
  if (cachedGeomColumn) return cachedGeomColumn;
  const res = await fetch(SOCRATA_COLUMNS_URL);
  if (!res.ok) {
    throw new Error(`Could not read LA dataset schema: ${res.status}`);
  }
  const cols = await res.json();
  const geom = cols.find((c) =>
    GEOMETRY_RENDER_TYPES.has(
      String(c.renderTypeName || c.dataTypeName || '').toLowerCase()
    )
  );
  if (!geom) {
    throw new Error(
      'No geometry column found in LA dataset (schema may have changed).'
    );
  }
  cachedGeomColumn = geom.fieldName;
  console.log(`[sweeping] discovered geometry column: ${cachedGeomColumn}`);
  return cachedGeomColumn;
}

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

export async function lookupAddress(address) {
  const location = await geocode(address);
  const routes = await findNearbyRoutes(location.lat, location.lng);

  const parsed = routes
    .map(parseRow)
    .filter((r) => r.dayAbbr && r.startTime && r.endTime);

  const enriched = parsed.map((r) => {
    const dayIndex = DAY_ABBR_TO_INDEX[r.dayAbbr.toUpperCase()];
    if (dayIndex == null) {
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

  // De-duplicate identical route+day+time rows and sort by soonest sweep.
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
    schedules,
    source: 'data.lacity.org krk7-ayq2 (Posted Street Sweeping Routes)',
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
 * Query the LA Socrata dataset for route segments near a point.
 * We expand the search radius progressively until we hit something or give up.
 */
async function findNearbyRoutes(lat, lng) {
  const geomCol = await getGeometryColumn();
  const radii = [25, 50, 100, 200];
  let loggedKeys = false;
  for (const radius of radii) {
    const where = `within_circle(${geomCol}, ${lat}, ${lng}, ${radius})`;
    const url = `${SOCRATA_URL}?$where=${encodeURIComponent(where)}&$limit=25`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `LA data portal returned ${res.status}: ${body.slice(0, 300)}`
      );
    }
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length > 0) {
      if (!loggedKeys) {
        console.log('[sweeping] row keys:', Object.keys(rows[0]));
        loggedKeys = true;
      }
      return rows;
    }
  }
  return [];
}

/**
 * Normalize a Socrata row into a stable shape. Field names on LA datasets have
 * shifted over the years, so we check a handful of likely column names.
 */
function parseRow(row) {
  const pick = (...names) => {
    for (const n of names) {
      if (row[n] != null && row[n] !== '') return row[n];
    }
    return '';
  };
  return {
    routeNo: String(pick('route_no', 'route', 'route_number', 'routeno')).trim(),
    dayAbbr: String(pick('weekday', 'day_of_week', 'day', 'dow')).trim(),
    startTime: String(pick('start_time', 'starttime', 'time_start', 'start')).trim(),
    endTime: String(pick('end_time', 'endtime', 'time_end', 'end')).trim(),
    boundaries: String(pick('boundaries', 'description', 'location_description')).trim(),
    councilDistrict: String(pick('cd', 'council_district', 'councildistrict')).trim(),
  };
}
