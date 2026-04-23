import { nextOccurrence, buildGcalUrl } from './schedule.js';

const GEOCODER_URL =
  'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

/**
 * LA's authoritative Posted Street Sweeping Routes layer, hosted on ArcGIS
 * Online. Has polygon geometry for every route, so we can do a real
 * point-in-polygon query and return only the route(s) that actually contain
 * the user's address.
 *
 * Item: https://www.arcgis.com/home/item.html?id=0e16fa641a0846a3ae29bffb150314dc
 * Fields: Route, Posted_Day, Day_Short, Posted_Time, Boundaries, Weeks,
 *         Odd_Even, Maint_District, MD_Name, Maint_Area, ...
 */
const ARCGIS_QUERY_URL =
  'https://services1.arcgis.com/PTh9WC0Sf2WS7AAq/ArcGIS/rest/services/' +
  'Posted_Street_Sweeping_Routes_Update/FeatureServer/0/query';

// Map "Friday"/"Mon"/"TU" etc. to JS weekday index (0=Sun..6=Sat).
const DAY_TO_INDEX = {
  SUNDAY: 0, SUN: 0, SU: 0,
  MONDAY: 1, MON: 1, M: 1,
  TUESDAY: 2, TUES: 2, TUE: 2, TU: 2, T: 2,
  WEDNESDAY: 3, WED: 3, WE: 3, W: 3,
  THURSDAY: 4, THURS: 4, THUR: 4, THU: 4, TH: 4,
  FRIDAY: 5, FRI: 5, FR: 5, F: 5,
  SATURDAY: 6, SAT: 6, SA: 6,
};

export async function lookupAddress(address) {
  const location = await geocode(address);
  const features = await findRoutesAtPoint(location.lat, location.lng);

  // Each ArcGIS feature can describe a route that runs on one day ("Friday")
  // or multiple ("Monday to Friday"). Expand each feature into one schedule
  // per day so the UI can show a clean list with a calendar button per day.
  const schedules = [];
  for (const f of features) {
    const parsed = parseFeature(f);
    if (!parsed) continue;
    for (const dayIndex of parsed.dayIndexes) {
      const next = nextOccurrence(
        dayIndex,
        parsed.startTime,
        parsed.endTime
      );
      const gcalUrl = buildGcalUrl({
        address: location.matchedAddress,
        routeNo: parsed.routeNo,
        boundaries: parsed.boundaries,
        start: next.start,
        end: next.end,
      });
      schedules.push({
        routeNo: parsed.routeNo,
        dayIndex,
        dayAbbr: abbrFor(dayIndex),
        dayName: nameFor(dayIndex),
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        boundaries: parsed.boundaries,
        weeks: parsed.weeks,
        oddEven: parsed.oddEven,
        maintDistrict: parsed.maintDistrict,
        // Real Council District if the layer exposes one, otherwise empty.
        // (maintDistrict is a Bureau of Street Services maintenance code like
        // "112" — not a council district, so we no longer alias it here.)
        councilDistrict: parsed.councilDistrict || '',
        nextSweep: next,
        gcalUrl,
      });
    }
  }

  // Sort by soonest sweep.
  schedules.sort((a, b) => Date.parse(a.nextSweep.start) - Date.parse(b.nextSweep.start));

  return {
    input: address,
    matchedAddress: location.matchedAddress,
    coordinates: { lat: location.lat, lng: location.lng },
    schedules,
    source:
      'ArcGIS — Posted_Street_Sweeping_Routes_Update/FeatureServer/0 ' +
      '(point-in-polygon)',
    matchMode: 'spatial-intersects',
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
 * Ask the ArcGIS layer for the route polygon(s) that contain (lat, lng).
 * Returns an array of feature objects ({ attributes: { ... } }).
 */
async function findRoutesAtPoint(lat, lng) {
  const params = new URLSearchParams({
    f: 'json',
    where: '1=1',
    geometry: JSON.stringify({ x: lng, y: lat }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'false',
  });

  const url = `${ARCGIS_QUERY_URL}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `ArcGIS layer returned ${res.status}: ${body.slice(0, 300)}`
    );
  }
  const data = await res.json();
  if (data?.error) {
    throw new Error(`ArcGIS error: ${data.error.message || 'unknown'}`);
  }
  const features = Array.isArray(data?.features) ? data.features : [];
  if (features.length > 0) {
    console.log(
      `[sweeping] ${features.length} route polygon(s) at (${lat.toFixed(4)}, ${lng.toFixed(4)})`
    );
    // One-time log of attribute keys so we can see which fields the ArcGIS
    // layer actually exposes (handy for spotting Council District / CD).
    if (!loggedAttributeKeysOnce) {
      loggedAttributeKeysOnce = true;
      const keys = Object.keys(features[0]?.attributes || {});
      console.log(`[sweeping] feature attribute keys: ${keys.join(', ')}`);
    }
  }
  return features;
}

let loggedAttributeKeysOnce = false;

/**
 * Take a raw ArcGIS feature and pull out the fields we need. Returns null if
 * something critical is missing (day or time).
 *
 * Notes:
 * - `Posted_Day` is human-readable ("Friday", "Monday to Friday"); `Day_Short`
 *   is abbreviated ("F", "M") and is the more reliable source when present.
 * - `Posted_Time` looks like "8:00 AM - 10:00 AM" — we split on the dash.
 */
function parseFeature(feature) {
  const a = feature?.attributes || {};
  const timeRaw = String(a.Posted_Time || '').trim();
  if (!timeRaw) return null;

  const [startRaw, endRaw] = splitTimeRange(timeRaw);
  if (!startRaw || !endRaw) return null;

  const dayIndexes = resolveDayIndexes(a.Day_Short, a.Posted_Day);
  if (dayIndexes.length === 0) return null;

  // ArcGIS stores "Route" as "12P125 M" (route number + day suffix). Strip
  // the day suffix so routeNo is clean — the day is already in dayAbbr.
  const routeNoRaw = String(a.Route || '').trim();
  const routeNo = routeNoRaw
    .replace(/\s+(SUN|MON|TUES|TUE|THURS|THUR|THU|WED|FRI|SAT|SU|TU|TH|WE|FR|SA|M|W|F)\.?\s*$/i, '')
    .trim();

  // Probe likely council-district field names. The layer's attribute keys
  // are logged on first request so we can see what's available. If nothing
  // matches we leave it empty rather than guessing.
  const councilDistrict = String(
    a.Council_District ?? a.CouncilDistrict ?? a.CD ?? a.Cd ?? a.CD_NUMBER ?? ''
  ).trim();

  return {
    routeNo,
    boundaries: String(a.Boundaries || '').trim(),
    weeks: String(a.Weeks || '').trim() || null,
    oddEven: String(a.Odd_Even || '').trim() || null,
    maintDistrict: String(a.Maint_District || '').trim() || null,
    councilDistrict: councilDistrict || null,
    startTime: startRaw,
    endTime: endRaw,
    dayIndexes,
  };
}

/**
 * Split strings like "8:00 AM - 10:00 AM" or "10:00 AM–12:00 PM" (note the
 * en-dash variant) into ["8:00 AM", "10:00 AM"]. Forgiving of extra spaces.
 */
function splitTimeRange(raw) {
  const parts = String(raw).split(/\s*[-–—]\s*/);
  if (parts.length < 2) return [null, null];
  return [parts[0].trim(), parts.slice(1).join('-').trim()];
}

/**
 * Resolve day-of-week into an array of weekday indexes. Handles:
 *   Day_Short = "F"           → [5]
 *   Day_Short = "M", "Tu"     → [1], [2]
 *   Posted_Day = "Friday"     → [5]
 *   Posted_Day = "Monday to Friday" → [1, 2, 3, 4, 5]
 *   Posted_Day = "Mon, Wed"   → [1, 3]
 * Returns [] if we can't recognize anything.
 */
function resolveDayIndexes(dayShort, postedDay) {
  const short = String(dayShort || '').trim().toUpperCase();
  if (short && DAY_TO_INDEX[short] != null) {
    return [DAY_TO_INDEX[short]];
  }

  const full = String(postedDay || '').trim();
  if (!full) return [];

  // Range like "Monday to Friday" or "Monday - Wednesday".
  const rangeMatch = full.match(
    /^\s*([A-Za-z]+)\s+(?:to|through|-|–)\s+([A-Za-z]+)\s*$/i
  );
  if (rangeMatch) {
    const from = DAY_TO_INDEX[rangeMatch[1].toUpperCase()];
    const to = DAY_TO_INDEX[rangeMatch[2].toUpperCase()];
    if (from != null && to != null) {
      const out = [];
      // Walk forward through the week; handles wraparound if anyone ever
      // puts "Friday to Monday", though that's unlikely in this dataset.
      let i = from;
      for (let guard = 0; guard < 7; guard++) {
        out.push(i);
        if (i === to) break;
        i = (i + 1) % 7;
      }
      return out;
    }
  }

  // Comma/slash/ampersand-separated list like "Mon, Wed & Fri".
  const parts = full.split(/[,/&]|\band\b/i).map((s) => s.trim()).filter(Boolean);
  const indexes = parts
    .map((p) => DAY_TO_INDEX[p.toUpperCase()])
    .filter((v) => v != null);
  if (indexes.length > 0) return [...new Set(indexes)];

  // Single day.
  if (DAY_TO_INDEX[full.toUpperCase()] != null) {
    return [DAY_TO_INDEX[full.toUpperCase()]];
  }

  return [];
}

function abbrFor(idx) {
  return ['Su', 'M', 'Tu', 'W', 'Th', 'F', 'Sa'][idx] || '';
}

function nameFor(idx) {
  return [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday',
    'Thursday', 'Friday', 'Saturday',
  ][idx] || '';
}
