// Bundled airport data layer. A curated subset of the OurAirports database
// (https://ourairports.com, public domain) ships with the app as
// `src/data/airports.json`: every large and medium airport worldwide with its
// ICAO/IATA codes, name, city and coordinates. It's loaded via a dynamic
// import so the ~170 KB (gzipped) dataset lands in its own lazy chunk rather
// than the initial bundle. The radar draws a subtle overlay of airports near
// the center from it. No network request to a third party is involved; the
// data is part of the static build.

const EARTH_RADIUS_NM = 3440.065;
const toRad = (d) => (d * Math.PI) / 180;

// One nautical mile is 1/60 of a degree of latitude, so a range in nm maps to
// this many degrees of latitude. Used for a cheap bounding-box pre-filter
// before the (more expensive) great-circle test.
const DEG_PER_NM_LAT = 1 / 60;

let airportsPromise = null;

// Kick off (or reuse) the dataset load. The dynamic import is code-split by the
// bundler, so the JSON is fetched and parsed once and cached by the module
// system for the rest of the session. Returns [] if the chunk can't be loaded
// (and clears the cached promise so a later call retries).
export function loadAirports() {
  if (!airportsPromise) {
    airportsPromise = import('../data/airports.json')
      .then((m) => (Array.isArray(m.default) ? m.default : []))
      .catch(() => {
        airportsPromise = null;
        return [];
      });
  }
  return airportsPromise;
}

// Great-circle (haversine) distance between two lat/lon points, in nm.
function haversineNm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Initial bearing from point 1 to point 2, in degrees (0-360, 0 = North).
function bearingDeg(lat1, lon1, lat2, lon2) {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI + 360;
}

// A short display code for an airport: IATA when present (most recognizable),
// else the ICAO ident.
export function airportCode(a) {
  return (a && (a.iata || a.icao)) || '';
}

/**
 * Airports within `rangeNm` of (lat, lon), each annotated with its polar
 * position relative to that center (distanceNm + bearingDeg) so the radar can
 * plot them exactly the way it plots aircraft. Sorted nearest-first. Never
 * throws; returns [] if the dataset is unavailable.
 */
export async function airportsWithin(lat, lon, rangeNm) {
  const all = await loadAirports();
  if (!all.length) return [];
  // Generous latitude window for the cheap reject (a degree of longitude
  // shrinks toward the poles, so we only gate on latitude and let the exact
  // great-circle test below do the rest).
  const latWindow = rangeNm * DEG_PER_NM_LAT + 0.5;
  const out = [];
  for (const a of all) {
    if (Math.abs(a.lat - lat) > latWindow) continue;
    const d = haversineNm(lat, lon, a.lat, a.lon);
    if (d <= rangeNm) {
      out.push({ ...a, distanceNm: d, bearingDeg: bearingDeg(lat, lon, a.lat, a.lon) });
    }
  }
  out.sort((p, q) => p.distanceNm - q.distanceNm);
  return out;
}
