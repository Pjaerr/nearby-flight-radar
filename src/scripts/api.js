// Data layer. Keyless, CORS-enabled public sources:
//   - airplanes.live -> live ADS-B positions around a point
//   - adsb.lol        -> callsign -> route (origin/dest), plausibility checked here
//   - vradarserver    -> airline ICAO code -> name (standing-data airlines.csv)
// All send `Access-Control-Allow-Origin: *`, so the browser calls them
// directly. No proxy, no API key, no backend.

const POSITIONS_BASE = 'https://api.airplanes.live/v2/point';
// Route lookup. adsb.lol's `/api/0/routeset` POST endpoint is position-aware but
// no longer sends CORS headers on its preflight, so a static site can't call it
// from the browser. Instead we hit the underlying vradarserver standing-data
// files directly (ODbL) \u2014 the same data adsb.lol's `GET /api/0/route/:callsign`
// just redirects to \u2014 which *are* CORS-enabled. They're laid out one JSON file
// per callsign under a two-letter shard: /routes/BA/BAW123.json.
//
// Those files are callsign-only (no server-side plausibility), so a callsign
// reused across different city pairs would otherwise resolve to the wrong
// flight. We recover the check locally: the files include each airport's
// lat/lon, so `isRoutePlausible()` rejects a route whose great-circle corridor
// the overhead aircraft is nowhere near (see below).
const ROUTES_BASE = 'https://vrs-standing-data.adsb.lol/routes';

// Half-width (nautical miles) of the great-circle corridor a contact must fall
// within for a callsign's route to be considered plausible. Generous on
// purpose: real flights deviate from the direct path for airways and weather,
// but a mislabelled/reused callsign is typically off by an entire ocean, so a
// loose corridor still rejects the gross mismatches without dropping legit
// flights that are merely off-track.
const ROUTE_CORRIDOR_NM = 250;
const EARTH_RADIUS_NM = 3440.065;

// Build the standing-data URL for a callsign: /routes/<first two chars>/<CS>.json.
function routeUrlFor(callsign) {
  const cs = callsign.toUpperCase();
  return `${ROUTES_BASE}/${encodeURIComponent(cs.slice(0, 2))}/${encodeURIComponent(cs)}.json`;
}

// ---- Airline code -> name lookup -----------------------------------------
// The route files carry only an ICAO airline *code* (e.g. "BAW"), not a
// readable name, and the positions feed doesn't send an owner/operator on the
// point endpoint \u2014 so without this, airline-style flights show up nameless.
// vradarserver's standing-data ships an `airlines.csv` (CC0, CORS-enabled,
// updated hourly) mapping that code to a name ("British Airways"). It's ~180 KB,
// so we fetch it at most once per session and cache the parsed map in
// localStorage for a week; individual resolved routes are themselves cached
// (see below), so a later session keeps its airline names even if this file is
// briefly unreachable.
const AIRLINES_URL =
  'https://raw.githubusercontent.com/vradarserver/standing-data/main/airlines/schema-01/airlines.csv';
const LS_AIRLINES_KEY = 'airlines';
const AIRLINES_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Resolved lookups once available, plus the in-flight load so concurrent
// route lookups share a single fetch rather than each pulling the CSV.
// airlineMap: code -> name (drives readable airline names on the radar).
// airlineIataMap: name/code -> IATA code (drives the passport's logos).
let airlineMap = null;
let airlineIataMap = null;
let airlineMapPromise = null;

// Split one CSV line into fields, honouring double-quoted fields that may
// contain commas or escaped ("") quotes \u2014 a handful of airline names do.
function parseCsvLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

// A few HTML entities leak into the source names (e.g. "Muller &amp; Co.").
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

// Normalize an airline display name into a stable lookup key (lower-case,
// single-spaced) so the logbook's stored name can be matched back to a code
// regardless of incidental spacing/case differences.
function normalizeAirlineName(name) {
  return (name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Parse the CSV text into two maps. Columns: Code,Name,ICAO,IATA,...
//   names: code -> display name, keyed by both ICAO and the leading Code column
//     (identical for the 3-letter airline codes routes use); ICAO wins on conflict.
//   iatas: -> IATA code, keyed by the normalized name plus the ICAO/Code, so a
//     logbook airline (stored by name) or a raw code can both resolve to a logo.
function parseAirlineCsv(text) {
  const names = new Map();
  const iatas = new Map();
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = parseCsvLine(line);
    const code = (cols[0] || '').trim().toUpperCase();
    const name = decodeEntities((cols[1] || '').trim());
    const icao = (cols[2] || '').trim().toUpperCase();
    const iata = (cols[3] || '').trim().toUpperCase();
    if (!name) continue;
    if (icao && !names.has(icao)) names.set(icao, name);
    if (code && !names.has(code)) names.set(code, name);
    // IATA airline codes are two alphanumerics (e.g. "BA", "U2").
    if (/^[A-Z0-9]{2}$/.test(iata)) {
      const nameKey = normalizeAirlineName(name);
      if (nameKey && !iatas.has(nameKey)) iatas.set(nameKey, iata);
      if (icao && !iatas.has(icao)) iatas.set(icao, iata);
      if (code && !iatas.has(code)) iatas.set(code, iata);
    }
  }
  return { names, iatas };
}

// Restore still-fresh maps from localStorage, or null when absent/expired.
// Both the name and IATA maps are stored together, so an older cache that
// predates the IATA map (no `i`) is treated as stale and refetched once.
function loadAirlineMapFromStorage() {
  try {
    const raw = localStorage.getItem(LS_AIRLINES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed && typeof parsed.e === 'number' && parsed.e > Date.now() &&
      parsed.m && typeof parsed.m === 'object' &&
      parsed.i && typeof parsed.i === 'object'
    ) {
      return {
        names: new Map(Object.entries(parsed.m)),
        iatas: new Map(Object.entries(parsed.i)),
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function persistAirlineMap(names, iatas) {
  try {
    const m = {};
    for (const [k, v] of names) m[k] = v;
    const i = {};
    for (const [k, v] of iatas) i[k] = v;
    localStorage.setItem(LS_AIRLINES_KEY, JSON.stringify({ e: Date.now() + AIRLINES_TTL_MS, m, i }));
  } catch {
    /* storage full or unavailable; ignore */
  }
}

// Resolve the shared airline maps: memory -> localStorage -> network (once).
// Returns the name map (or null) for compatibility with `airlineNameFor`, and
// populates the IATA map as a side effect. On failure it clears the in-flight
// promise so a later lookup retries rather than being stuck for the session.
async function ensureAirlineMap() {
  if (airlineMap) return airlineMap;
  const stored = loadAirlineMapFromStorage();
  if (stored) {
    airlineMap = stored.names;
    airlineIataMap = stored.iatas;
    return airlineMap;
  }
  if (!airlineMapPromise) {
    airlineMapPromise = (async () => {
      try {
        const res = await fetch(AIRLINES_URL, { headers: { Accept: 'text/csv' } });
        if (!res.ok) return null;
        const parsed = parseAirlineCsv(await res.text());
        if (parsed.names.size) {
          persistAirlineMap(parsed.names, parsed.iatas);
          return parsed;
        }
        return null;
      } catch {
        return null;
      }
    })();
  }
  const parsed = await airlineMapPromise;
  if (parsed) {
    airlineMap = parsed.names;
    airlineIataMap = parsed.iatas;
  } else {
    airlineMapPromise = null;
  }
  return airlineMap;
}

// Resolve an ICAO airline code (e.g. "BAW") to a display name, or null when the
// code is empty/unknown or the dataset couldn't be loaded. Never throws.
async function airlineNameFor(code) {
  const c = (code || '').trim().toUpperCase();
  if (!c) return null;
  const map = await ensureAirlineMap();
  return (map && map.get(c)) || null;
}

// ---- Airline logos (Daisycon public image endpoint) -----------------------
// The passport's Airlines logbook shows each carrier's logo. Daisycon serves
// airline logos by IATA code from a keyless, CORS-enabled image endpoint, so
// (like the aircraft photos) there's no API key, server or proxy involved. The
// logbook stores airlines by display name, so we resolve the name (or a raw
// ICAO/IATA code) to an IATA code via the same standing-data dataset used for
// names, then hand back a ready <img> URL. Returns null when the airline can't
// be mapped to an IATA code (e.g. cargo/military operators without one).
const AIRLINE_LOGO_BASE = 'https://images.daisycon.io/airline/';
const AIRLINE_LOGO_W = 120;
const AIRLINE_LOGO_H = 60;

export async function airlineLogoUrl(nameOrCode) {
  const raw = (nameOrCode || '').trim();
  if (!raw) return null;
  await ensureAirlineMap();
  if (!airlineIataMap) return null;
  const iata =
    airlineIataMap.get(normalizeAirlineName(raw)) ||
    airlineIataMap.get(raw.toUpperCase()) ||
    null;
  if (!iata) return null;
  const params = new URLSearchParams({
    width: String(AIRLINE_LOGO_W),
    height: String(AIRLINE_LOGO_H),
    iata,
  });
  return `${AIRLINE_LOGO_BASE}?${params.toString()}`;
}

// ---- Structured API errors -----------------------------------------------
// A typed error so the poller can treat rate limiting (HTTP 429) as its own
// gentle case \u2014 keep the contacts already on the scope and wait out the
// server-suggested cooldown \u2014 rather than a hard "data fetch failed".
export class ApiError extends Error {
  constructor(message, { status = 0, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    // Server-requested cooldown in ms (from the Retry-After header), or null.
    this.retryAfterMs = retryAfterMs;
    this.rateLimited = status === 429;
  }
}

// Parse an HTTP `Retry-After` header into milliseconds. It's either a
// delta-seconds count or an HTTP date; returns null when absent/unparseable.
function parseRetryAfter(res) {
  const h = res.headers.get('Retry-After');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(h);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

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

// Common ICAO type codes for rotorcraft, used as a fallback when the ADS-B
// emitter category is missing/wrong (many GA helicopters don't broadcast the
// A7 rotorcraft category). Not exhaustive — just the airframes that turn up
// most on a civilian feed (police/HEMS/news/offshore/private).
const HELI_TYPES = new Set([
  // Airbus / Eurocopter
  'EC20', 'EC25', 'EC30', 'EC35', 'EC45', 'EC55', 'EC75',
  'H120', 'H125', 'H130', 'H135', 'H140', 'H145', 'H155', 'H160', 'H175', 'H215', 'H225',
  'AS32', 'AS3B', 'AS50', 'AS55', 'AS65', 'A109', 'A119', 'A139', 'A169', 'A189',
  'GAZL', 'ALO2', 'ALO3', 'PUMA', 'SUCO',
  // Bell
  'B06', 'B06T', 'B429', 'B412', 'B407', 'B427', 'B430', 'B505', 'B47G', 'B222', 'B230', 'B412',
  // Robinson
  'R22', 'R44', 'R66',
  // Sikorsky
  'S76', 'S92', 'S61', 'S64', 'H60', 'UH60', 'S70',
  // MD / Hughes / Enstrom / Schweizer / Guimbal
  'H500', 'H269', 'EN28', 'EN48', 'S269', 'S300', 'CABR',
  // Leonardo / AgustaWestland (also covered above), Kamov, Mi, Boeing
  'AW09', 'AW19', 'AW39', 'AW89', 'AW69', 'KA32', 'MI8', 'MI17', 'MI2', 'EH10',
]);

// True when a contact is a helicopter/rotorcraft, so the radar can draw a
// helicopter icon rather than a fixed-wing silhouette. The ADS-B emitter
// category A7 (rotorcraft) is the reliable signal when present; otherwise fall
// back to a recognized rotorcraft ICAO type code. A contact broadcasting
// neither can't be identified and defaults to a plane.
function isRotorcraft(category, type) {
  if (category === 'A7') return true;
  return HELI_TYPES.has((type || '').toUpperCase());
}

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
// Exported so the passport's spotting logbooks can flag a rare catch even when
// it was collected before this session (e.g. backfilled from stored history).
export const RARE_TYPES = new Set([
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
  if (!res.ok) {
    throw new ApiError(`positions HTTP ${res.status}`, {
      status: res.status,
      retryAfterMs: res.status === 429 ? parseRetryAfter(res) : null,
    });
  }
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
      // Whether the contact is a helicopter/rotorcraft, so the radar draws a
      // helicopter icon instead of a fixed-wing silhouette. From the A7 emitter
      // category, or a recognized rotorcraft type code as a fallback.
      isRotor: isRotorcraft(a.category, type),
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
// expire so a callsign the route database didn't know yet (or one reused by a
// later flight) gets re-checked instead of being blank forever. Crucially,
// only a *definitive* miss ("unknown") is cached; a transient failure (rate
// limit, 5xx, network) and a position-dependent "not plausible" rejection are
// never cached, so they retry on the next sighting.

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

// Non-fetching lookup of an already-resolved route for a callsign, from the
// in-memory or localStorage cache. Returns the route (with airport city names
// and country codes) or null. Used by the passport to backfill readable route
// detail for older stored flights that predate storing those fields inline.
export function cachedRouteFor(callsign) {
  if (!callsign) return null;
  const now = Date.now();
  const mem = routeMemory.get(callsign);
  if (mem && mem.expires > now) return mem.value;
  const rec = routeStore[callsign];
  if (rec && typeof rec.e === 'number' && rec.e > now) return rec.v ?? null;
  return null;
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

// ---- Client-side route plausibility --------------------------------------
// The standing-data files are keyed on callsign alone, so a callsign reused
// across different city pairs resolves to whichever single route is on file.
// We guard against that here using the aircraft's live position and the airport
// coordinates in the file: a contact genuinely flying A->B sits near the
// great-circle path between them, whereas a mislabelled callsign lands the
// contact far from the corridor of the route it points at.

const toRad = (deg) => (deg * Math.PI) / 180;

// Great-circle (haversine) distance between two lat/lon points, in nm.
function haversineNm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Initial bearing (radians) from point 1 to point 2 along the great circle.
function initialBearing(lat1, lon1, lat2, lon2) {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return Math.atan2(y, x);
}

// Bearing from point 1 to point 2 in degrees (0-360).
function bearingDeg(lat1, lon1, lat2, lon2) {
  return (initialBearing(lat1, lon1, lat2, lon2) * 180) / Math.PI;
}

// Smallest absolute difference between two compass bearings, in degrees (0-180).
function angleDiff(a, b) {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

// Where does point P sit relative to leg A->B? Returns the perpendicular
// (cross-track) distance in nm and whether P projects roughly between A and B
// (along-track) within a corridor-sized margin, so contacts just short of / past
// an airport still count. `onLeg` is false when P is outside the corridor.
function legMetrics(pLat, pLon, aLat, aLon, bLat, bLon) {
  const legLen = haversineNm(aLat, aLon, bLat, bLon);
  if (legLen === 0) {
    const d = haversineNm(pLat, pLon, aLat, aLon);
    return { onLeg: d <= ROUTE_CORRIDOR_NM, crossTrack: d };
  }

  const distAP = haversineNm(aLat, aLon, pLat, pLon) / EARTH_RADIUS_NM; // angular
  const bearAP = initialBearing(aLat, aLon, pLat, pLon);
  const bearAB = initialBearing(aLat, aLon, bLat, bLon);

  const crossTrack = Math.abs(Math.asin(Math.sin(distAP) * Math.sin(bearAP - bearAB)) * EARTH_RADIUS_NM);
  if (crossTrack > ROUTE_CORRIDOR_NM) return { onLeg: false, crossTrack };

  // Along-track distance of P's projection from A, in nm. `acos` only yields the
  // magnitude, so restore the sign from the bearing delta: when P bears more
  // than 90 deg off the A->B heading it lies *behind* A (negative along-track),
  // which must be rejected rather than wrapping around the far side of the globe.
  const alongMag =
    Math.acos(Math.cos(distAP) / Math.cos(crossTrack / EARTH_RADIUS_NM)) * EARTH_RADIUS_NM;
  const alongTrack = Math.cos(bearAP - bearAB) < 0 ? -alongMag : alongMag;
  const onLeg = alongTrack >= -ROUTE_CORRIDOR_NM && alongTrack <= legLen + ROUTE_CORRIDOR_NM;
  return { onLeg, crossTrack };
}

// Legs whose cross-track distances are within this margin of each other are
// treated as a tie \u2014 typically the outbound and return legs of a round trip,
// which share one corridor \u2014 and the aircraft's heading decides between them.
const LEG_TIE_NM = 50;

// Pick the leg of a (possibly multi-stop / round-trip) route the contact is
// currently flying, so origin/destination reflect *this* leg rather than the
// whole rotation (e.g. STR->MAN->STR must resolve to MAN->STR, not STR->STR).
// Returns { origin, destination } airport records, or null when the contact
// isn't plausibly on any leg (a reused/mislabelled callsign).
function selectLeg(airports, lat, lon, track) {
  const candidates = [];
  for (let i = 0; i < airports.length - 1; i++) {
    const a = airports[i];
    const b = airports[i + 1];
    if (
      !(Number.isFinite(a?.lat) && Number.isFinite(a?.lon) &&
        Number.isFinite(b?.lat) && Number.isFinite(b?.lon))
    ) {
      continue;
    }
    const m = legMetrics(lat, lon, a.lat, a.lon, b.lat, b.lon);
    if (m.onLeg) candidates.push({ origin: a, destination: b, crossTrack: m.crossTrack });
  }
  if (candidates.length === 0) return null;

  const minCross = Math.min(...candidates.map((c) => c.crossTrack));
  const tied = candidates.filter((c) => c.crossTrack <= minCross + LEG_TIE_NM);

  // Single clear leg (or no usable heading): take the closest corridor.
  let chosen = tied[0];
  // Overlapping corridors: the aircraft is heading toward its real destination,
  // so prefer the leg whose arrival airport best matches the current track.
  if (Number.isFinite(track) && tied.length > 1) {
    let bestPenalty = Infinity;
    for (const c of tied) {
      const penalty = angleDiff(track, bearingDeg(lat, lon, c.destination.lat, c.destination.lon));
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        chosen = c;
      }
    }
  }
  return { origin: chosen.origin, destination: chosen.destination };
}

/**
 * Resolve a callsign to { origin, destination } (each with iata, icao,
 * municipality, name) or null if unknown. Needs the aircraft's live position
 * (lat, lon) to confirm the route is plausible for *this* contact rather than a
 * different flight sharing the callsign, and to pick the current leg of a
 * multi-stop/round-trip rotation. The optional `track` (heading in degrees)
 * disambiguates direction when the out and back legs share a corridor. Never
 * throws.
 */
export async function lookupRoute(callsign, lat, lon, track) {
  if (!callsign) return null;

  const now = Date.now();

  const mem = routeMemory.get(callsign);
  if (mem && mem.expires > now) return mem.value;

  const cached = readLocalStorage(callsign);
  if (cached && cached.expires > now) {
    routeMemory.set(callsign, cached);
    return cached.value;
  }

  // Plausibility needs the aircraft's live position; without a fix there's
  // nothing to disambiguate against, so bail (without caching) and let a later
  // poll with a position retry.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  try {
    const res = await fetch(routeUrlFor(callsign), { headers: { Accept: 'application/json' } });

    // 404 = no route on file for this callsign. That's a deterministic answer,
    // so cache the miss with its short TTL rather than re-asking every sighting.
    if (res.status === 404) {
      cacheRoute(callsign, null);
      return null;
    }
    // Other non-OK responses (rate limit, 5xx, edge hiccup) are transient:
    // don't cache, just retry on the next sighting.
    if (!res.ok) return null;

    const r = await res.json();
    const airports = Array.isArray(r?._airports) ? r._airports : [];

    // A malformed/incomplete record (fewer than two airports) is treated like a
    // miss: cache it so we don't re-fetch a file that can't yield a route.
    if (r?.airport_codes === 'unknown' || airports.length < 2) {
      cacheRoute(callsign, null);
      return null;
    }

    // Pick the leg the contact is actually flying. A null result means it isn't
    // near any leg's great-circle corridor \u2014 almost always a reused/aliased
    // callsign pointing at the wrong flight. Reject it, but *don't* cache:
    // plausibility is position-dependent, so a later, correctly-placed sighting
    // should re-check.
    const leg = selectLeg(airports, lat, lon, track);
    if (!leg) return null;

    const route = {
      // The file only carries an ICAO airline *code* (e.g. "BAW"); resolve it to
      // a readable name via the airlines dataset. Null when the code is missing
      // or the dataset is briefly unreachable \u2014 the display then falls back to
      // the operator/owner from the positions feed.
      airline: await airlineNameFor(r.airline_code),
      origin: pickAirport(leg.origin),
      destination: pickAirport(leg.destination),
    };
    cacheRoute(callsign, route);
    return route;
  } catch {
    // Network hiccup: don't poison the cache, just return null this time.
    return null;
  }
}

// One region-name resolver, reused for every airport. Turns an ISO 3166-1
// alpha-2 code into an English country name (e.g. "GB" -> "United Kingdom")
// for the passport and screen-reader text; the route API only gives the code.
const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();

function countryNameFromIso(iso) {
  if (!regionNames || !/^[A-Z]{2}$/.test(iso)) return '';
  try {
    return regionNames.of(iso) || '';
  } catch {
    return '';
  }
}

// ---- Aircraft photos (Planespotters public API) ---------------------------
// The passport's Aircraft logbook shows a small photo of each airframe/type.
// Planespotters.net offers a keyless, CORS-enabled public API that returns the
// latest photo for a registration (or hex/Mode-S address). It only works from a
// real browser context (the request must carry an `Origin`/`Referer` header,
// which `fetch` sets automatically), so there's no server or proxy involved.
//
// Terms of use we must honour (https://www.planespotters.net/photo/api):
//   - Load the image straight from the returned `thumbnail`/`thumbnail_large`
//     URLs in the user's browser; never re-host or rewrite them.
//   - Credit the photographer next to the image and link the thumbnail to the
//     photo's page via the `link` URL (a plain anchor). The UI layer does this.
//   - JSON responses may be cached for up to 24 hours.
const PHOTOS_BASE = 'https://api.planespotters.net/pub/photos';
const LS_PHOTOS_KEY = 'photos';
// Cache a found photo for the full 24h the terms allow; re-check a "no photo"
// answer sooner so a newly uploaded shot appears without a day-long wait.
const PHOTO_POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const PHOTO_NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;

// In-memory mirror of the consolidated localStorage entry, keyed by the lookup
// id (registration or "hex:<addr>"): { "G-XLEB": { v: <photo|null>, e: ms } }.
const photoMemory = new Map();
// In-flight fetches keyed the same way, so the passport re-rendering on each
// poll (or two rows sharing a representative reg) collapses onto one request.
const photoInFlight = new Map();

function loadPhotoStore() {
  const store = {};
  try {
    const raw = localStorage.getItem(LS_PHOTOS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const now = Date.now();
        for (const [key, rec] of Object.entries(parsed)) {
          if (rec && typeof rec.e === 'number' && rec.e > now) {
            store[key] = { v: rec.v ?? null, e: rec.e };
          }
        }
      }
    }
  } catch {
    /* ignore malformed cache */
  }
  return store;
}

const photoStore = loadPhotoStore();

function persistPhotoStore() {
  try {
    localStorage.setItem(LS_PHOTOS_KEY, JSON.stringify(photoStore));
  } catch {
    /* storage full or unavailable; ignore */
  }
}

function cachePhoto(key, value) {
  const expires = Date.now() + (value ? PHOTO_POSITIVE_TTL_MS : PHOTO_NEGATIVE_TTL_MS);
  photoMemory.set(key, { value, expires });
  photoStore[key] = { v: value ?? null, e: expires };
  persistPhotoStore();
}

// Reduce one Planespotters thumbnail object to { src, width, height }, or null
// when the shape is missing/unexpected. URLs are used verbatim per the terms.
function pickThumb(t) {
  const src = t && typeof t.src === 'string' ? t.src : '';
  if (!src) return null;
  const size = (t && t.size) || {};
  return {
    src,
    width: Number.isFinite(size.width) ? size.width : null,
    height: Number.isFinite(size.height) ? size.height : null,
  };
}

// Normalize the API's first photo into the shape the passport renders, or null
// when there's no usable photo.
function normalizePhoto(data) {
  const photo = data && Array.isArray(data.photos) ? data.photos[0] : null;
  if (!photo) return null;
  const thumb = pickThumb(photo.thumbnail);
  const large = pickThumb(photo.thumbnail_large) || thumb;
  if (!thumb) return null;
  return {
    thumb,
    large,
    link: typeof photo.link === 'string' ? photo.link : '',
    photographer: typeof photo.photographer === 'string' ? photo.photographer : '',
  };
}

/**
 * Fetch the latest Planespotters photo for an aircraft, looked up by
 * registration (default) or by hex/Mode-S address when `byHex` is true.
 * Returns { thumb, large, link, photographer } or null when no photo exists.
 * Results (including definitive "no photo" misses) are cached in memory and
 * localStorage; transient failures are not cached so a later view retries.
 * Never throws.
 */
export async function fetchAircraftPhoto(id, { byHex = false } = {}) {
  const raw = (id || '').trim();
  if (!raw) return null;
  const key = byHex ? `hex:${raw.toLowerCase()}` : raw.toUpperCase();

  const now = Date.now();
  const mem = photoMemory.get(key);
  if (mem && mem.expires > now) return mem.value;
  const rec = photoStore[key];
  if (rec && typeof rec.e === 'number' && rec.e > now) {
    photoMemory.set(key, { value: rec.v ?? null, expires: rec.e });
    return rec.v ?? null;
  }

  const pending = photoInFlight.get(key);
  if (pending) return pending;

  const path = byHex
    ? `${PHOTOS_BASE}/hex/${encodeURIComponent(raw.toLowerCase())}`
    : `${PHOTOS_BASE}/reg/${encodeURIComponent(raw.toUpperCase())}`;
  const promise = (async () => {
    try {
      const res = await fetch(path, { headers: { Accept: 'application/json' } });
      // Transient responses (rate limit, 5xx, the occasional 403 from a stripped
      // header): don't cache, just retry when the row is viewed again.
      if (!res.ok) return null;
      const data = await res.json();
      if (data && data.error) return null;
      const photo = normalizePhoto(data);
      cachePhoto(key, photo);
      return photo;
    } catch {
      return null;
    } finally {
      photoInFlight.delete(key);
    }
  })();
  photoInFlight.set(key, promise);
  return promise;
}

// Non-fetching lookup of an already-cached photo, so a re-render can paint a
// known thumbnail instantly without touching the network. Returns the photo,
// null for a cached miss, or undefined when nothing is cached yet.
export function cachedAircraftPhoto(id, { byHex = false } = {}) {
  const raw = (id || '').trim();
  if (!raw) return undefined;
  const key = byHex ? `hex:${raw.toLowerCase()}` : raw.toUpperCase();
  const now = Date.now();
  const mem = photoMemory.get(key);
  if (mem && mem.expires > now) return mem.value;
  const rec = photoStore[key];
  if (rec && typeof rec.e === 'number' && rec.e > now) return rec.v ?? null;
  return undefined;
}

// ---- Nearest-airport weather (Open-Meteo) --------------------------------
// The HUD shows current conditions for the nearest airport. aviationweather.gov
// (the natural METAR source) doesn't send CORS headers, so a browser-only
// static site can't read it directly \u2014 the same wall the route lookup hits with
// adsb.lol's routeset endpoint. Open-Meteo is keyless, CORS-enabled and
// worldwide, so we read current conditions from it (temperature, WMO weather
// code, wind) at the airport's coordinates instead. No proxy, no key, no
// backend, in keeping with the rest of the app.
const WEATHER_BASE = 'https://api.open-meteo.com/v1/forecast';

// WMO weather interpretation codes -> a short, HUD-friendly label. Grouped so
// nearby variants (e.g. the drizzle intensities) read the same at a glance.
// Reference: https://open-meteo.com/en/docs (WMO code table).
const WMO_CODES = {
  0: 'Clear',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light showers',
  81: 'Showers',
  82: 'Violent showers',
  85: 'Snow showers',
  86: 'Snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm',
  99: 'Thunderstorm',
};

export function weatherCodeLabel(code) {
  return WMO_CODES[code] || '';
}

/**
 * Fetch current conditions at (lat, lon) from Open-Meteo. Returns a normalized
 * object { tempC, weatherCode, condition, windKt, windDir, humidity } or null
 * on any failure. Never throws.
 */
export async function fetchWeather(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m',
    wind_speed_unit: 'kn',
    temperature_unit: 'celsius',
  });
  try {
    const res = await fetch(`${WEATHER_BASE}?${params}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const c = data && data.current;
    if (!c) return null;
    const code = typeof c.weather_code === 'number' ? c.weather_code : null;
    return {
      tempC: typeof c.temperature_2m === 'number' ? c.temperature_2m : null,
      weatherCode: code,
      condition: code != null ? weatherCodeLabel(code) : '',
      windKt: typeof c.wind_speed_10m === 'number' ? c.wind_speed_10m : null,
      windDir: typeof c.wind_direction_10m === 'number' ? c.wind_direction_10m : null,
      humidity: typeof c.relative_humidity_2m === 'number' ? c.relative_humidity_2m : null,
    };
  } catch {
    return null;
  }
}

// Normalize one airport from the route API's `_airports` array into the shape
// the radar renders (city + codes + country for the flag and passport).
function pickAirport(a) {
  const iso = (a.countryiso2 || '').toUpperCase();
  return {
    iata: a.iata || '',
    icao: a.icao || '',
    // The standing-data airport record calls the city field `location`.
    municipality: a.location || '',
    name: a.name || '',
    // Airport coordinates (from the standing-data file). Kept so the passport
    // can measure how far an origin is from your radar and the great-circle
    // length of a route (for the "farthest origin" / "longest route" stats).
    lat: Number.isFinite(a.lat) ? a.lat : null,
    lon: Number.isFinite(a.lon) ? a.lon : null,
    // ISO 3166-1 alpha-2 country code (e.g. "GB"), used to render a flag.
    countryIso: iso,
    // Human-readable country name (e.g. "United Kingdom"), used by the
    // passport map/list to label visited countries.
    countryName: countryNameFromIso(iso),
  };
}
