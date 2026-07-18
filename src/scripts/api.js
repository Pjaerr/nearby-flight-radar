// Data layer. Two keyless, CORS-enabled public APIs:
//   - airplanes.live  -> live ADS-B positions around a point
//   - adsbdb.com      -> callsign -> departure/arrival airports
// Both send `Access-Control-Allow-Origin: *`, so the browser calls them
// directly. No proxy, no API key, no backend.

const POSITIONS_BASE = 'https://api.airplanes.live/v2/point';
const ROUTE_BASE = 'https://api.adsbdb.com/v0/callsign';

// ---- Aircraft size classification ----------------------------------------
// Buckets every contact into a rough physical size so the radar can draw a
// bigger icon for an airliner than for a light private plane. We keep this to
// three buckets on purpose ('light' | 'medium' | 'heavy'); the goal is a
// glanceable size cue, not an exact type identification.

// A handful of common ICAO type codes used as a fallback when the ADS-B wake
// category is missing. Anything unknown defaults to 'medium'.
const HEAVY_TYPES = new Set([
  // Airbus widebodies
  'A306', 'A30B', 'A310', 'A332', 'A333', 'A337', 'A338', 'A339',
  'A342', 'A343', 'A345', 'A346', 'A359', 'A35K', 'A388',
  // Boeing widebodies + 747s
  'B741', 'B742', 'B743', 'B744', 'B748', 'B74S', 'B74R',
  'B762', 'B763', 'B764', 'B772', 'B77L', 'B773', 'B77W',
  'B788', 'B789', 'B78X', 'B752', 'B753',
  // Others / freighters / large military
  'MD11', 'IL96', 'A124', 'A225', 'C5M', 'C17', 'K35R', 'B52',
]);

const LIGHT_TYPES = new Set([
  // Cessna singles
  'C150', 'C152', 'C162', 'C170', 'C172', 'C175', 'C177', 'C182',
  'C185', 'C205', 'C206', 'C207', 'C210',
  // Piper
  'P28A', 'P28B', 'P28R', 'P28T', 'PA18', 'PA24', 'PA28', 'PA32',
  'PA34', 'PA38', 'PA44', 'PA46',
  // Cirrus / Diamond / Beech singles & light twins
  'SR20', 'SR22', 'S22T', 'DA20', 'DA40', 'DA42', 'DA62',
  'BE33', 'BE35', 'BE36', 'BE58', 'BE76',
  // Grumman / Mooney / Robin / gliders / microlights
  'AA5', 'M20P', 'M20T', 'DR40', 'RV6', 'RV7', 'RV8', 'RV9', 'RV10',
  'GLID', 'ULAC', 'GLST',
]);

// ADS-B emitter/wake category (A1-A7). A1/A2 are light & small aircraft, A5 is
// "heavy" (>300k lb); A3/A4 sit in the middle (narrowbodies, B757). A7 is
// rotorcraft, which we treat as light for size purposes.
function categoryToSize(cat) {
  switch (cat) {
    case 'A1':
    case 'A2':
    case 'A7':
      return 'light';
    case 'A5':
      return 'heavy';
    case 'A3':
    case 'A4':
      return 'medium';
    default:
      return null;
  }
}

function classifySize(category, type) {
  const byCat = categoryToSize(category);
  if (byCat) return byCat;
  const t = (type || '').toUpperCase();
  if (HEAVY_TYPES.has(t)) return 'heavy';
  if (LIGHT_TYPES.has(t)) return 'light';
  return 'medium';
}

// ---- Special-flight classification ---------------------------------------
// Flags a contact as noteworthy so the radar can highlight it (distinct
// colour + pulse). Three independent signals: transponder emergency codes,
// military operators, and a short list of rare/iconic airframes.

// Emergency squawk codes are an international standard: 7500 = unlawful
// interference (hijack), 7600 = radio failure, 7700 = general emergency.
const EMERGENCY_SQUAWKS = {
  7500: 'hijack',
  7600: 'radio-failure',
  7700: 'emergency',
};

// Heuristic military callsign prefixes (ICAO three-letter + common tactical
// call signs). Not exhaustive, but catches the bulk of NATO/allied traffic
// that shows up on a civilian ADS-B feed.
const MIL_CALLSIGN_RE =
  /^(RCH|RRR|RFR|CFC|CTM|NATO|FAF|IAM|GAF|BAF|MMF|NAF|RSF|ASY|LAGR|HERKY|RESCUE|PAT|EVAC|BOXER|DOOM|REACH|ASCOT|COBRA|VVIP|IRON|SLAM|SNAKE|VADER|GRZLY|HOBO|ROVER|TROLL|BLADE|KNIFE|SHELL|QUID|NOBLE)/i;

// Rare / iconic airframes worth calling out regardless of how close they are.
const RARE_TYPES = new Set([
  'A388', // A380 superjumbo
  'A124', 'A225', // Antonov An-124 / An-225
  'B52', 'C5M', 'C17', 'A400', // large military transports/bombers
  'CONC', // Concorde
  'SR71', 'U2', // high-altitude recon
  'BLCF', // 747 Dreamlifter
  'B74S', 'B74R', // 747SP / shuttle carrier
  'SPIT', 'LANC', 'P51', 'B17', 'MOSQ', // warbirds
]);

// airplanes.live sets bit 0 of `dbFlags` for aircraft in its military
// database. Combine that with the callsign heuristic above.
function isMilitary(callsign, dbFlags) {
  if (typeof dbFlags === 'number' && (dbFlags & 1) === 1) return true;
  return MIL_CALLSIGN_RE.test((callsign || '').trim());
}

function classifyFlags(callsign, type, squawk, dbFlags) {
  const sq = parseInt(squawk, 10);
  return {
    emergency: EMERGENCY_SQUAWKS[sq] || null,
    military: isMilitary(callsign, dbFlags),
    rare: RARE_TYPES.has((type || '').toUpperCase()),
  };
}

/**
 * Fetch aircraft within `rangeNm` nautical miles of (lat, lon).
 * Returns a normalized array. airplanes.live conveniently gives us each
 * aircraft's distance (`dst`, nm) and bearing (`dir`, deg) from the query
 * point already, which is exactly what a radar needs.
 */
export async function fetchNearbyAircraft(lat, lon, rangeNm) {
  const radius = Math.min(Math.max(Math.round(rangeNm), 1), 250);
  const url = `${POSITIONS_BASE}/${lat}/${lon}/${radius}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`positions HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data.ac) ? data.ac : [];

  return list.map((a) => {
    const callsign = (a.flight || '').trim();
    const onGround = a.alt_baro === 'ground';
    const type = a.t || '';
    const squawk = (a.squawk || '').trim();
    return {
      hex: a.hex,
      callsign,
      registration: a.r || '',
      type,
      // Raw ADS-B emitter/wake category (e.g. "A5") kept for reference.
      category: a.category || '',
      // Transponder squawk code as a string (e.g. "7700"), used to detect
      // emergency codes for highlighting.
      squawk,
      // Noteworthy-flight signals: emergency squawk, military operator, rare
      // airframe. Drives the distinct colour/pulse on the scope.
      flags: classifyFlags(callsign, type, squawk, a.dbFlags),
      // Rough physical size bucket ('light' | 'medium' | 'heavy') used to pick
      // a plane icon so a jumbo reads bigger than a Cessna at a glance. Derived
      // from the ADS-B wake category when present, else the ICAO type code.
      sizeClass: classifySize(a.category, type),
      // Human-readable model, e.g. "BOEING 767-300". Falls back to the ICAO
      // type code at display time when this is absent.
      model: a.desc || '',
      // Owner/operator, e.g. "British Airways". Shown on the card when we have
      // no route to display so those contacts aren't left bare.
      operator: a.ownOp || '',
      // Radar coordinates relative to the center point.
      distanceNm: typeof a.dst === 'number' ? a.dst : null,
      bearingDeg: typeof a.dir === 'number' ? a.dir : null,
      // Extras for labels / styling.
      altFt: onGround ? 0 : (typeof a.alt_baro === 'number' ? a.alt_baro : null),
      // Barometric vertical rate (ft/min); drives the climb/descent arrow.
      // Falls back to the geometric rate when the barometric one is missing.
      verticalRateFpm:
        typeof a.baro_rate === 'number'
          ? a.baro_rate
          : typeof a.geom_rate === 'number'
            ? a.geom_rate
            : null,
      onGround,
      groundSpeedKt: typeof a.gs === 'number' ? a.gs : null,
      trackDeg: typeof a.track === 'number' ? a.track : null,
      lat: typeof a.lat === 'number' ? a.lat : null,
      lon: typeof a.lon === 'number' ? a.lon : null,
      seenPosSec: typeof a.seen_pos === 'number' ? a.seen_pos : 0,
    };
  });
}

// ---- Route lookup with caching -------------------------------------------
// Cached in an in-memory Map for the session plus localStorage so labels
// appear instantly across reloads. Both hits and misses are cached with a
// TTL: a found route is stable for a while, but a "no route" answer must
// expire so a callsign adsbdb didn't know yet (or one reused by a later
// flight) gets re-checked instead of being blank forever. Crucially, only a
// *definitive* miss is cached; a transient failure (rate limit, 5xx, network)
// is never cached, so it retries on the next sighting.

const routeMemory = new Map(); // callsign -> { value: route|null, expires: ms }
// All cached routes live under one consolidated localStorage entry, an object
// keyed by callsign: { "BAW123": { v: <route|null>, e: <expiryMs> }, ... }.
// This replaces the previous scheme that wrote a separate `route3:<callsign>`
// entry per flight.
const LS_ROUTES_KEY = 'routes';
// A found route is stable enough to reuse for a day; a miss is re-checked
// every few hours in case the route data lands or the callsign is reassigned.
const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 3 * 60 * 60 * 1000;

function ttlFor(value) {
  return value == null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
}

// Remove the legacy per-callsign entries from the old caching scheme so they
// don't linger in localStorage after the migration to a single entry.
function cleanupLegacyRouteKeys() {
  try {
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('route3:') || k.startsWith('route2:') || k.startsWith('route:'))) {
        stale.push(k);
      }
    }
    for (const k of stale) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

// Parse the consolidated store once at startup, dropping malformed or expired
// records so the single entry doesn't grow without bound across sessions.
function loadRouteStore() {
  let store = {};
  try {
    const raw = localStorage.getItem(LS_ROUTES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const now = Date.now();
        for (const [callsign, rec] of Object.entries(parsed)) {
          if (rec && typeof rec.e === 'number' && rec.e > now) {
            store[callsign] = { v: rec.v ?? null, e: rec.e };
          }
        }
      }
    }
  } catch {
    store = {};
  }
  cleanupLegacyRouteKeys();
  return store;
}

// In-memory mirror of the single localStorage entry; the source of truth for
// reads and writes during the session.
const routeStore = loadRouteStore();

function persistRouteStore() {
  try {
    localStorage.setItem(LS_ROUTES_KEY, JSON.stringify(routeStore));
  } catch {
    /* storage full or unavailable; ignore */
  }
}

// Returns { value, expires } | undefined (undefined = nothing usable cached).
function readLocalStorage(callsign) {
  const rec = routeStore[callsign];
  if (!rec || typeof rec.e !== 'number') return undefined;
  return { value: rec.v ?? null, expires: rec.e };
}

function writeLocalStorage(callsign, value, expires) {
  routeStore[callsign] = { v: value ?? null, e: expires };
  persistRouteStore();
}

// Cache a resolved value (a route, or null for a definitive miss) in memory
// and localStorage with an appropriate TTL.
function cacheRoute(callsign, value) {
  const expires = Date.now() + ttlFor(value);
  routeMemory.set(callsign, { value, expires });
  writeLocalStorage(callsign, value, expires);
}

/**
 * Resolve a callsign to { origin, destination } (each with iata, icao,
 * municipality, name) or null if unknown. Never throws.
 */
export async function lookupRoute(callsign) {
  if (!callsign) return null;

  const now = Date.now();

  const mem = routeMemory.get(callsign);
  if (mem && mem.expires > now) return mem.value;

  const cached = readLocalStorage(callsign);
  if (cached && cached.expires > now) {
    routeMemory.set(callsign, cached);
    return cached.value;
  }

  try {
    const res = await fetch(`${ROUTE_BASE}/${encodeURIComponent(callsign)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      // 404 (unknown callsign) and 400 (malformed callsign) are deterministic
      // for this callsign, so cache the miss with its short TTL. Anything else
      // (429 rate limit, 5xx, etc.) is transient: don't cache, retry later.
      if (res.status === 404 || res.status === 400) cacheRoute(callsign, null);
      return null;
    }
    const data = await res.json();
    const fr = data && data.response && data.response.flightroute;
    if (!fr || !fr.origin || !fr.destination) {
      cacheRoute(callsign, null);
      return null;
    }
    const route = {
      airline: fr.airline ? fr.airline.name : null,
      origin: pickAirport(fr.origin),
      destination: pickAirport(fr.destination),
    };
    cacheRoute(callsign, route);
    return route;
  } catch {
    // Network hiccup: don't poison the cache, just return null this time.
    return null;
  }
}

function pickAirport(a) {
  return {
    iata: a.iata_code || '',
    icao: a.icao_code || '',
    municipality: a.municipality || '',
    name: a.name || '',
    // ISO 3166-1 alpha-2 country code (e.g. "GB"), used to render a flag.
    countryIso: a.country_iso_name || '',
    // Human-readable country name (e.g. "United Kingdom"), used by the
    // passport map/list to label visited countries.
    countryName: a.country_name || '',
  };
}
