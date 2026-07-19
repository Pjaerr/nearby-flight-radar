import { CONFIG } from '../config.js';
import { Radar, describeAircraft } from './radar.js';
import { fetchNearbyAircraft, lookupRoute, cachedRouteFor, RARE_TYPES } from './api.js';
import { RadarAudio } from './audio.js';

const SLIDER_MAX = 50; // nm; airplanes.live caps a /point query at 250 nm
const NM_TO_M = 1852;
const LS_RANGE_KEY = 'rangeNm';
const LS_CENTER_KEY = 'centerLoc';
const LS_PASSPORT_KEY = 'passportCountries';
const LS_SOUND_KEY = 'soundOn';
// World country polygons for the passport map. Natural Earth 1:110m via the
// keyless, CORS-enabled jsDelivr CDN. Loaded on demand when the modal opens.
const WORLD_GEOJSON_URL =
  'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_admin_0_countries.geojson';
// A single seamless landmass layer (continents + islands as one geometry).
// Country polygons in the file above are simplified per-feature and don't share
// exact borders, so painting them directly leaves visible slivers between
// neighbours. We draw this gap-free land as the black base instead, then paint
// only visited countries on top.
const LAND_GEOJSON_URL =
  'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_land.geojson';
const els = {
  canvas: document.getElementById('radar'),
  labelCanvas: document.getElementById('radar-labels'),
  location: document.getElementById('stat-location'),
  range: document.getElementById('stat-range'),
  status: document.getElementById('status'),
  rangeEdit: document.getElementById('range-edit'),
  modal: document.getElementById('range-modal'),
  modalClose: document.getElementById('range-close'),
  map: document.getElementById('range-map'),
  slider: document.getElementById('range-slider'),
  rangeValue: document.getElementById('range-value'),
  fullscreen: document.getElementById('fullscreen-btn'),
  sound: document.getElementById('sound-btn'),
  apply: document.getElementById('range-apply'),
  // Dev / demo panel.
  devPanel: document.getElementById('dev-panel'),
  devClose: document.getElementById('dev-close'),
  devToggle: document.getElementById('dev-toggle'),
  // Location picker
  centerEdit: document.getElementById('center-edit'),
  centerModal: document.getElementById('center-modal'),
  centerClose: document.getElementById('center-close'),
  centerMap: document.getElementById('center-map'),
  centerSearch: document.getElementById('center-search'),
  centerSearchBtn: document.getElementById('center-search-btn'),
  centerGeo: document.getElementById('center-geo'),
  centerValue: document.getElementById('center-value'),
  centerApply: document.getElementById('center-apply'),
  centerHint: document.getElementById('center-hint'),
  // Passport (countries seen) modal
  passportBtn: document.getElementById('passport-btn'),
  passportModal: document.getElementById('passport-modal'),
  passportClose: document.getElementById('passport-close'),
  passportMap: document.getElementById('passport-map'),
  passportList: document.getElementById('passport-list'),
  passportReset: document.getElementById('passport-reset'),
  passportTabs: document.getElementById('passport-tabs'),
  passportCountryDetail: document.getElementById('passport-country-detail'),
  // Tab panels + their content mounts.
  tabCountries: document.getElementById('tab-countries'),
  tabAircraft: document.getElementById('tab-aircraft'),
  tabAirlines: document.getElementById('tab-airlines'),
  tabBadges: document.getElementById('tab-badges'),
  tabStats: document.getElementById('tab-stats'),
  aircraftHead: document.getElementById('aircraft-head'),
  aircraftBody: document.getElementById('aircraft-body'),
  aircraftGroupBy: document.getElementById('aircraft-groupby'),
  airlinesBody: document.getElementById('airlines-body'),
  badgesGrid: document.getElementById('badges-grid'),
  statsBody: document.getElementById('stats-body'),
  // Screen-reader regions: a polite live log and a mirrored aircraft list.
  srLive: document.getElementById('sr-live'),
  srList: document.getElementById('sr-aircraft-list'),
  srEmpty: document.getElementById('sr-aircraft-empty'),
};

// ---- Screen-reader announcements ------------------------------------------
//
// Appends each new contact's description to a polite `role="log"` live region
// so assistive tech reads it out as the aircraft appears on the scope. Old
// entries are trimmed so the region doesn't grow unbounded over a long session.
const SR_MAX_LOG = 8;

// Appearances are signalled by the radar's sweep, which runs inside the
// requestAnimationFrame render loop. Building the description string and
// mutating the live-region DOM synchronously there blows the frame budget on
// slower hardware, producing a visible hitch exactly when a contact appears.
// So we queue the raw blips and flush them off the render critical path (on
// idle time), coalescing several appearances from one sweep into a single DOM
// write via a document fragment.
const announceQueue = [];
let announceScheduled = false;
const scheduleIdle =
  typeof window.requestIdleCallback === 'function'
    ? (fn) => window.requestIdleCallback(fn, { timeout: 500 })
    : (fn) => setTimeout(fn, 0);

function flushAnnouncements() {
  announceScheduled = false;
  if (!els.srLive || announceQueue.length === 0) return;
  const frag = document.createDocumentFragment();
  for (const b of announceQueue) {
    const msg = describeAircraft(b);
    if (!msg) continue;
    const p = document.createElement('p');
    p.textContent = msg;
    frag.appendChild(p);
  }
  announceQueue.length = 0;
  els.srLive.appendChild(frag);
  while (els.srLive.childElementCount > SR_MAX_LOG) {
    els.srLive.removeChild(els.srLive.firstElementChild);
  }
}

// Called from the radar's onAppear (inside the render frame): do no DOM work
// here, just enqueue and schedule a flush.
function announce(blip) {
  if (!blip) return;
  announceQueue.push(blip);
  if (announceScheduled) return;
  announceScheduled = true;
  scheduleIdle(flushAnnouncements);
}

// Rebuild the always-current, navigable list of contacts on the scope. Mirrors
// the blips a sighted user can see (those whose data is ready), nearest first,
// so a screen-reader user can review the radar on demand rather than only
// catching the momentary live announcement.
function updateAircraftList() {
  if (!els.srList) return;
  const ready = [...radar.blips.values()].filter((b) => b.routeResolved === true);
  ready.sort((a, b) => (a.distanceNm ?? Infinity) - (b.distanceNm ?? Infinity));

  els.srList.innerHTML = '';
  if (els.srEmpty) els.srEmpty.hidden = ready.length > 0;
  for (const b of ready) {
    const li = document.createElement('li');
    li.textContent = describeAircraft(b);
    els.srList.appendChild(li);
  }
}

// Opt-in sound. Muted unless the user previously enabled it.
function loadSoundPref() {
  try {
    const v = localStorage.getItem(LS_SOUND_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    /* ignore */
  }
  return CONFIG.soundEnabled === true;
}

const audio = new RadarAudio({ muted: !loadSoundPref() });

let currentRange = loadSavedRange();
const radar = new Radar(els.canvas, {
  rangeNm: currentRange,
  persistenceSec: CONFIG.blipPersistenceSec,
  labelCanvas: els.labelCanvas,
  onAppear: (b) => {
    announce(b);
    // Log the contact into the passport's spotting books + stats (deferred to
    // idle so the render frame stays smooth).
    queueSighting(b);
  },
  // Radar ping as the sweep crosses a contact (no-op while muted).
  onPing: () => audio.ping(),
});
radar.start();
els.range.textContent = `${currentRange} nm`;

let center = { ...CONFIG.fallback };

function loadSavedCenter() {
  try {
    const raw = localStorage.getItem(LS_CENTER_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (Number.isFinite(v?.lat) && Number.isFinite(v?.lon)) {
      return {
        lat: v.lat,
        lon: v.lon,
        label: v.label || `${v.lat.toFixed(3)}, ${v.lon.toFixed(3)}`,
        short: v.short,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveCenter(c) {
  try {
    localStorage.setItem(LS_CENTER_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

function loadSavedRange() {
  try {
    const v = parseInt(localStorage.getItem(LS_RANGE_KEY), 10);
    if (Number.isFinite(v) && v >= 1 && v <= SLIDER_MAX) return v;
  } catch {
    /* ignore */
  }
  return CONFIG.rangeNm;
}

// ---- Passport: everything that has crossed the radar ----------------------
//
// The passport is the app's persistent "spotting logbook". It records four
// collections plus a handful of standout records, all in one localStorage
// entry (schema v3):
//   {
//     v: 3,
//     countries: { "GB": { n, c, first, last, flights: [ {t,cs,reg,ty,op,md,role,from,to} ] } },
//     types:     { "A388": { n:"AIRBUS A380-800", c, first, last, rare, mil, size } },
//     airlines:  { "British Airways": { c, first, last } },
//     regs:      { "G-XLEB": { c, first, last, ty, rare, mil } },
//     records: {
//       highestAlt:    { altFt, cs, reg, ty, t },
//       longestRoute:  { nm, from, to, cs, t },
//       firstMilitary: { t, cs, ty },
//       emergency7700: { t, cs },
//       nightOwl:      { t, cs },
//     }
//   }
// Countries drive the world map + day grouping (as before); the type/airline/
// registration books drive the spotting-log tabs; the records drive badges and
// the session/day stats panel.

// Keep per-country flight history bounded so localStorage can't grow forever.
const MAX_FLIGHTS_PER_COUNTRY = 50;

// Latitude of the Arctic Circle (~66°34' N). A route with an endpoint at or
// north of this touches the Arctic.
const ARCTIC_LAT = 66.5622;

// Great-circle distance between two lat/lon points, in nautical miles. Used to
// measure how far an origin airport is and the length of a route.
const NM_EARTH_RADIUS = 3440.065;
function haversineNm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return NM_EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 16-point compass names indexed by bearing (0 = North, clockwise).
const COMPASS_16 = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];
function compassDir(deg) {
  if (typeof deg !== 'number' || Number.isNaN(deg)) return '';
  const i = Math.round(deg / 22.5);
  return COMPASS_16[((i % 16) + 16) % 16];
}

const isRareType = (ty) => RARE_TYPES.has((ty || '').toUpperCase());

function emptyRecords() {
  return {
    highestAlt: null,
    longestRoute: null,
    firstMilitary: null,
    emergency7700: null,
    nightOwl: null,
    // Tier 2 records (added later; migratePassport backfills nulls for older
    // saves via the { ...emptyRecords(), ...raw.records } spread).
    hijack7500: null,
    radioFail7600: null,
    earlyBird: null,
    lowestAlt: null,
    closest: null,
    fastest: null,
    homebound: null,
    arctic: null,
  };
}

function emptyPassport() {
  return { v: 3, countries: {}, types: {}, airlines: {}, regs: {}, records: emptyRecords() };
}

// Bring any older/legacy shape up to the current v3 schema. v2 kept only
// countries (with per-flight detail); we preserve those and rebuild the type/
// airline/registration books by replaying the stored flights so returning
// users see a populated logbook immediately.
function migratePassport(raw) {
  if (!raw || typeof raw !== 'object') return emptyPassport();

  let countries;
  if (raw.countries && typeof raw.countries === 'object') {
    countries = raw.countries;
  } else {
    // Legacy shape: { "GB": { c, n, t }, ... } keyed directly by ISO code.
    countries = {};
    for (const [code, e] of Object.entries(raw)) {
      if (!e || typeof e !== 'object') continue;
      const iso = code.toUpperCase();
      if (!/^[A-Z]{2}$/.test(iso)) continue;
      const t = typeof e.t === 'number' ? e.t : Date.now();
      countries[iso] = { n: e.n || '', c: typeof e.c === 'number' ? e.c : 1, first: t, last: t, flights: [] };
    }
  }

  if (raw.v === 3) {
    return {
      v: 3,
      countries,
      types: raw.types && typeof raw.types === 'object' ? raw.types : {},
      airlines: raw.airlines && typeof raw.airlines === 'object' ? raw.airlines : {},
      regs: raw.regs && typeof raw.regs === 'object' ? raw.regs : {},
      records: { ...emptyRecords(), ...(raw.records || {}) },
    };
  }

  // v2 (or legacy) -> v3: keep countries, rebuild the logbooks from flights.
  const p = { v: 3, countries, types: {}, airlines: {}, regs: {}, records: emptyRecords() };
  backfillLogbooks(p);
  return p;
}

// Replay every stored country flight into the type/airline/registration books.
// Each flight is recorded twice (origin + destination roles), so dedupe on a
// per-flight signature to avoid double-counting.
function backfillLogbooks(p) {
  const seen = new Set();
  for (const entry of Object.values(p.countries)) {
    const flights = Array.isArray(entry.flights) ? entry.flights : [];
    for (const fl of flights) {
      const sig = `${fl.t}|${fl.cs}|${fl.reg}|${fl.ty}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const t = typeof fl.t === 'number' ? fl.t : Date.now();
      logType(p, fl.ty, fl.md, { rare: isRareType(fl.ty), mil: false, size: '' }, t);
      logAirline(p, fl.op, t);
      logReg(p, fl.reg, fl.ty, { rare: isRareType(fl.ty), mil: false }, t);
    }
  }
}

// ---- Logbook writers (shared by live recording and backfill) --------------

function logType(p, ty, model, meta, t) {
  const code = (ty || '').toUpperCase();
  if (!code) return;
  const e = p.types[code] || { n: '', c: 0, first: t, last: t, rare: false, mil: false, size: '' };
  e.c += 1;
  e.last = Math.max(e.last || 0, t);
  if (!e.first || t < e.first) e.first = t;
  if (model && !e.n) e.n = model;
  if (meta) {
    e.rare = e.rare || !!meta.rare;
    e.mil = e.mil || !!meta.mil;
    if (meta.size) e.size = meta.size;
  }
  p.types[code] = e;
}

function logAirline(p, name, t) {
  const key = (name || '').trim();
  if (!key) return;
  const e = p.airlines[key] || { c: 0, first: t, last: t };
  e.c += 1;
  e.last = Math.max(e.last || 0, t);
  if (!e.first || t < e.first) e.first = t;
  p.airlines[key] = e;
}

function logReg(p, reg, ty, meta, t) {
  const key = (reg || '').toUpperCase();
  if (!key) return;
  const e = p.regs[key] || { c: 0, first: t, last: t, ty: '', rare: false, mil: false };
  e.c += 1;
  e.last = Math.max(e.last || 0, t);
  if (!e.first || t < e.first) e.first = t;
  if (ty && !e.ty) e.ty = (ty || '').toUpperCase();
  if (meta) {
    e.rare = e.rare || !!meta.rare;
    e.mil = e.mil || !!meta.mil;
  }
  p.regs[key] = e;
}

function loadPassport() {
  try {
    const raw = localStorage.getItem(LS_PASSPORT_KEY);
    if (!raw) return emptyPassport();
    return migratePassport(JSON.parse(raw));
  } catch {
    return emptyPassport();
  }
}

let passport = loadPassport();

function savePassport() {
  try {
    localStorage.setItem(LS_PASSPORT_KEY, JSON.stringify(passport));
  } catch {
    /* ignore */
  }
}

// Record one sighting of a country from a route endpoint, optionally storing
// the specific flight that visited it. Returns true when a valid two-letter
// code was stored so the caller knows to persist.
function recordCountry(iso, name, flight) {
  const code = (iso || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return false;
  const now = Date.now();
  const entry = passport.countries[code] || { n: '', c: 0, first: now, last: now, flights: [] };
  entry.c += 1;
  entry.last = now;
  if (!entry.first) entry.first = now;
  if (name && !entry.n) entry.n = name;
  if (!Array.isArray(entry.flights)) entry.flights = [];
  if (flight) {
    entry.flights.push(flight);
    // Drop the oldest records once we exceed the cap.
    if (entry.flights.length > MAX_FLIGHTS_PER_COUNTRY) {
      entry.flights.splice(0, entry.flights.length - MAX_FLIGHTS_PER_COUNTRY);
    }
  }
  passport.countries[code] = entry;
  return true;
}

// Pull both endpoints of a resolved route into the passport, persisting once.
// `aircraft` (the live blip/contact) supplies the flight-level detail stored
// against each country.
function recordRouteCountries(route, aircraft) {
  if (!route) return;
  const o = route.origin;
  const d = route.destination;
  const endpointCode = (ap) => (ap ? ap.iata || ap.icao || ap.municipality || ap.countryIso || '' : '');
  // City/airport name for a human-readable route (e.g. "London" or "Heathrow").
  const endpointCity = (ap) => (ap ? ap.municipality || ap.name || '' : '');
  const base = {
    t: Date.now(),
    cs: (aircraft && aircraft.callsign) || '',
    reg: (aircraft && aircraft.registration) || '',
    ty: (aircraft && aircraft.type) || '',
    op: (aircraft && aircraft.operator) || '',
    md: (aircraft && aircraft.model) || '',
    from: endpointCode(o),
    to: endpointCode(d),
    // Names for a readable route line; codes above stay for the compact form.
    fromCity: endpointCity(o),
    toCity: endpointCity(d),
    // Country codes so the detail list can show a flag for each endpoint.
    fromIso: (o && o.countryIso) || '',
    toIso: (d && d.countryIso) || '',
  };
  let changed = false;
  if (o) changed = recordCountry(o.countryIso, o.countryName, { ...base, role: 'o' }) || changed;
  if (d) changed = recordCountry(d.countryIso, d.countryName, { ...base, role: 'd' }) || changed;
  if (changed) savePassport();
}

// ---- Session stats (in-memory, reset each page load) ----------------------
//
// Complements the persisted day-grouping: a live tally of what this session has
// caught. Bounded so a wall-mounted display running for days can't grow it
// without limit.
const MAX_SESSION_SIGHTINGS = 1000;
const session = { start: Date.now(), total: 0, sightings: [] };

// Snapshot of the country ISOs already collected when this session began. Lets
// the Session Stats panel tell which countries — and which continent badges —
// are genuinely new this session rather than carried over from a past visit.
let sessionStartCountryIsos = new Set(Object.keys(passport.countries));

// Live tally of badges earned *during* this session. `baseline` is the set of
// badge ids already earned before the session started; anything that becomes
// earned afterwards lands in `earned` (in the order it happened) so the panel
// can celebrate it.
const sessionBadge = { baseline: new Set(), earned: [], earnedIds: new Set(), seeded: false };

// The ids of continent-completion badges that are already complete given a
// particular set of collected countries. Used to baseline continents from the
// session's *starting* countries even though computeBadges() can only produce
// continent badges once the map data (continentIndex) has loaded.
function continentBadgeIdsCompleteAt(isoSet) {
  const ids = new Set();
  if (!continentIndex) return ids;
  for (const cont of continentIndex) {
    const need = cont.isos.size;
    if (!need) continue;
    let have = 0;
    for (const iso of cont.isos) if (isoSet.has(iso)) have += 1;
    if (have >= need) ids.add(`continent-${cont.name.toLowerCase().replace(/\s+/g, '-')}`);
  }
  return ids;
}

// Reconcile the session badge tally with the current passport. Idempotent:
// safe to call on every passport change. On the first call it establishes the
// pre-session baseline; on later calls it records any newly earned badge.
function syncSessionBadges() {
  const badges = computeBadges();
  if (!sessionBadge.seeded) {
    for (const b of badges) {
      if (b.earned && !b.id.startsWith('continent-')) sessionBadge.baseline.add(b.id);
    }
    sessionBadge.seeded = true;
  }
  // Continent badges only exist once map data loads, so keep baselining the
  // ones that were already complete from the session's starting countries.
  for (const id of continentBadgeIdsCompleteAt(sessionStartCountryIsos)) sessionBadge.baseline.add(id);

  for (const b of badges) {
    if (!b.earned) continue;
    if (sessionBadge.baseline.has(b.id)) continue;
    if (sessionBadge.earnedIds.has(b.id)) continue;
    sessionBadge.earnedIds.add(b.id);
    sessionBadge.earned.push({ id: b.id, name: b.name, detail: b.detail || '', t: Date.now() });
  }
}

// Operator-name tidy: mirror the radar's title-casing so the airline book and
// stats read the same as the on-scope cards ("BRITISH AIRWAYS" -> "British
// Airways"). Kept local (radar's copy isn't exported).
const OP_ACRONYMS = new Set(['LLC', 'INC', 'LTD', 'PLC', 'LLP', 'LP', 'CO', 'CORP', 'AG', 'SA', 'NV', 'BV', 'AB', 'AS', 'USA', 'UK', 'US', 'UAE']);
function tidyOperator(name) {
  return (name || '')
    .toLowerCase()
    .split(/\s+/)
    .map((w) => {
      const bare = w.replace(/[.,]/g, '');
      if (OP_ACRONYMS.has(bare.toUpperCase())) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ')
    .trim();
}

// The airline label for a contact: an explicit route airline if present, else
// the tidied operator/owner from the positions feed.
function airlineOf(b) {
  if (b.route && b.route.airline) return b.route.airline;
  return b.operator ? tidyOperator(b.operator) : '';
}

// A "rarity score" so the stats panel can surface the standout catch. Higher is
// rarer: emergencies top the list, then rare airframes, military, and finally
// ordinary traffic ranked by how seldom its type has been seen.
function rarityScore(s) {
  if (s.emergency) return 1000;
  if (s.rare) return 500;
  if (s.mil) return 300;
  const seen = (passport.types[s.ty] && passport.types[s.ty].c) || 1;
  return 100 / seen;
}

// Record everything about one contact the first time it appears on the scope:
// its type, airline and registration into the logbooks, any standout records,
// and a lightweight session-stats entry. Called (off the render path) once per
// appearance. Returns true when the persistent passport changed.
function recordOneSighting(b) {
  if (!b) return false;
  const now = Date.now();
  const ty = (b.type || '').toUpperCase();
  const rare = !!(b.flags && b.flags.rare);
  const mil = !!(b.flags && b.flags.military);
  const emergency = (b.flags && b.flags.emergency) || null;
  const airline = airlineOf(b);
  const reg = (b.registration || '').toUpperCase();

  // Session tally (in-memory only).
  const o = b.route && b.route.origin;
  let originDistNm = null;
  if (o && Number.isFinite(o.lat) && Number.isFinite(o.lon)) {
    originDistNm = haversineNm(center.lat, center.lon, o.lat, o.lon);
  }
  session.total += 1;
  session.sightings.push({
    t: now,
    ty,
    model: b.model || '',
    airline,
    reg,
    bearing: typeof b.bearingDeg === 'number' ? b.bearingDeg : null,
    distanceNm: typeof b.distanceNm === 'number' ? b.distanceNm : null,
    altFt: typeof b.altFt === 'number' ? b.altFt : null,
    rare,
    mil,
    emergency,
    origin: o ? { name: o.municipality || o.name || o.iata || o.icao || '', iso: o.countryIso || '' } : null,
    originDistNm,
  });
  if (session.sightings.length > MAX_SESSION_SIGHTINGS) {
    session.sightings.splice(0, session.sightings.length - MAX_SESSION_SIGHTINGS);
  }

  // Persistent logbooks + records.
  logType(passport, ty, b.model, { rare, mil, size: b.sizeClass }, now);
  logAirline(passport, airline, now);
  logReg(passport, reg, ty, { rare, mil }, now);

  const rec = passport.records;
  if (typeof b.altFt === 'number' && (!rec.highestAlt || b.altFt > rec.highestAlt.altFt)) {
    rec.highestAlt = { altFt: b.altFt, cs: b.callsign || '', reg, ty, t: now };
  }
  if (mil && !rec.firstMilitary) rec.firstMilitary = { t: now, cs: b.callsign || '', ty };
  if (emergency === 'emergency' && !rec.emergency7700) rec.emergency7700 = { t: now, cs: b.callsign || '' };
  if (emergency === 'hijack' && !rec.hijack7500) rec.hijack7500 = { t: now, cs: b.callsign || '' };
  if (emergency === 'radio-failure' && !rec.radioFail7600) rec.radioFail7600 = { t: now, cs: b.callsign || '' };
  const hr = new Date(now).getHours();
  if ((hr >= 22 || hr < 5) && !rec.nightOwl) rec.nightOwl = { t: now, cs: b.callsign || '' };
  if (hr >= 5 && hr < 7 && !rec.earlyBird) rec.earlyBird = { t: now, cs: b.callsign || '' };

  // Lowest airborne contact. Guard against transponders reporting 0 ft on the
  // ground so the record reflects a genuine low overflight.
  if (typeof b.altFt === 'number' && b.altFt > 0 && (!rec.lowestAlt || b.altFt < rec.lowestAlt.altFt)) {
    rec.lowestAlt = { altFt: b.altFt, cs: b.callsign || '', reg, ty, t: now };
  }
  // Closest approach to the radar centre.
  if (typeof b.distanceNm === 'number' && b.distanceNm >= 0 && (!rec.closest || b.distanceNm < rec.closest.nm)) {
    rec.closest = { nm: b.distanceNm, cs: b.callsign || '', reg, ty, t: now };
  }
  // Fastest ground speed (jet-stream tailwinds can push this well past cruise).
  if (typeof b.groundSpeedKt === 'number' && (!rec.fastest || b.groundSpeedKt > rec.fastest.kt)) {
    rec.fastest = { kt: b.groundSpeedKt, cs: b.callsign || '', reg, ty, t: now };
  }

  const d = b.route && b.route.destination;
  // Domestic flight witnessed: both endpoints resolve to the same country.
  if (!rec.homebound && o && d && o.countryIso && d.countryIso && o.countryIso === d.countryIso) {
    rec.homebound = { iso: o.countryIso, name: o.countryName || d.countryName || '', cs: b.callsign || '', t: now };
  }
  // A route touching the Arctic Circle (either endpoint at or above 66.56°N).
  if (!rec.arctic) {
    const arcticEnd =
      o && Number.isFinite(o.lat) && o.lat >= ARCTIC_LAT ? o :
      d && Number.isFinite(d.lat) && d.lat >= ARCTIC_LAT ? d : null;
    if (arcticEnd) {
      const place = arcticEnd.municipality || arcticEnd.name || arcticEnd.iata || arcticEnd.icao || arcticEnd.countryName || 'the Arctic';
      rec.arctic = { place, cs: b.callsign || '', t: now };
    }
  }
  if (o && d && Number.isFinite(o.lat) && Number.isFinite(o.lon) && Number.isFinite(d.lat) && Number.isFinite(d.lon)) {
    const nm = haversineNm(o.lat, o.lon, d.lat, d.lon);
    if (!rec.longestRoute || nm > rec.longestRoute.nm) {
      rec.longestRoute = {
        nm,
        from: o.iata || o.icao || '?',
        to: d.iata || d.icao || '?',
        cs: b.callsign || '',
        t: now,
      };
    }
  }
  return true;
}

// Appearances fire inside the radar's render frame; defer the logbook write
// (and its localStorage serialize) to idle time so we never hitch the sweep.
const sightingQueue = [];
let sightingScheduled = false;
function queueSighting(b) {
  if (!b) return;
  sightingQueue.push(b);
  if (sightingScheduled) return;
  sightingScheduled = true;
  scheduleIdle(flushSightings);
}
function flushSightings() {
  sightingScheduled = false;
  if (sightingQueue.length === 0) return;
  let changed = false;
  for (const b of sightingQueue) changed = recordOneSighting(b) || changed;
  sightingQueue.length = 0;
  if (changed) {
    savePassport();
    syncSessionBadges();
  }
  // If the passport modal is open, keep its live tabs fresh.
  if (!els.passportModal.hidden) refreshOpenPassportTab();
}

function setStatus(msg, kind = 'info') {
  els.status.textContent = msg;
  els.status.dataset.kind = kind;
}

function coordStr(lat, lon) {
  return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
}

// Builds a display label from a place name plus coordinates, e.g.
// "London · 51.507, -0.128". Falls back to bare coordinates when no name.
function labelWithCoords(lat, lon, name) {
  const coords = coordStr(lat, lon);
  return name ? `${name} \u00b7 ${coords}` : coords;
}

// The compact label shown in the main HUD center box. Prefers a `short` name
// (e.g. "My location") when present, otherwise the full label.
function hudLabel(c) {
  return c.short || c.label;
}

// Wraps the callback-based Geolocation API in a promise and returns a
// normalized center object.
function getGeolocation() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation unavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          label: `My Location (${coordStr(pos.coords.latitude, pos.coords.longitude)})`,
          short: 'My location',
        }),
      reject,
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  });
}

async function resolveLocation() {
  if (!CONFIG.useGeolocation || !('geolocation' in navigator)) {
    els.location.textContent = center.label;
    return;
  }
  setStatus('Requesting your location\u2026');
  try {
    center = await getGeolocation();
    els.location.textContent = hudLabel(center);
  } catch {
    els.location.textContent = `${center.label}`;
    setStatus('Location denied \u2014 using fallback.', 'warn');
  }
}

// ---- Range picker (Leaflet + OpenStreetMap, loaded on demand) -------------

const LEAFLET_VER = '1.9.4';
let leafletPromise;

function loadLeaflet() {
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `https://unpkg.com/leaflet@${LEAFLET_VER}/dist/leaflet.css`;
    document.head.appendChild(css);

    const js = document.createElement('script');
    js.src = `https://unpkg.com/leaflet@${LEAFLET_VER}/dist/leaflet.js`;
    js.onload = () => resolve(window.L);
    js.onerror = () => reject(new Error('Failed to load map library'));
    document.head.appendChild(js);
  });
  return leafletPromise;
}

let map;
let rangeCircle;
let centerMarker;
let draftRange = currentRange;

function fitToCircle() {
  if (map && rangeCircle) map.fitBounds(rangeCircle.getBounds(), { padding: [24, 24] });
}

function setDraftRange(nm) {
  draftRange = Math.max(1, Math.min(SLIDER_MAX, Math.round(nm)));
  els.slider.value = String(draftRange);
  els.rangeValue.textContent = `${draftRange} nm`;
  if (rangeCircle) rangeCircle.setRadius(draftRange * NM_TO_M);
}

async function openRangePicker() {
  els.modal.hidden = false;
  setDraftRange(currentRange);

  let L;
  try {
    L = await loadLeaflet();
  } catch {
    setStatus('Map failed to load. Check your connection.', 'error');
    els.modal.hidden = true;
    return;
  }
  // Modal may have been closed again while the library loaded.
  if (els.modal.hidden) return;

  const latlng = [center.lat, center.lon];
  if (!map) {
    // A view must be set before adding layers, otherwise Leaflet has no
    // zoom/center to project against and throws. fitToCircle() reframes below.
    map = L.map(els.map, { zoomControl: true, attributionControl: true }).setView(latlng, 11);
    L.tileLayer(`https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`, {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    centerMarker = L.circleMarker(latlng, {
      radius: 5,
      color: '#baffd7',
      weight: 2,
      fillColor: '#00ff78',
      fillOpacity: 1,
    }).addTo(map);
    rangeCircle = L.circle(latlng, {
      radius: currentRange * NM_TO_M,
      color: '#00ff78',
      weight: 2,
      fillColor: '#00ff78',
      fillOpacity: 0.12,
    }).addTo(map);
    // Click the map to set the radius to the distance from your location.
    map.on('click', (e) => {
      const distM = map.distance(e.latlng, latlng);
      setDraftRange(distM / NM_TO_M);
    });
  } else {
    map.setView(latlng, map.getZoom());
    centerMarker.setLatLng(latlng);
    rangeCircle.setLatLng(latlng);
  }

  setDraftRange(currentRange);
  // The map container was hidden until now, so Leaflet needs a nudge to
  // recalculate its size before we frame the circle.
  setTimeout(() => {
    map.invalidateSize();
    fitToCircle();
  }, 60);
}

function closeRangePicker() {
  els.modal.hidden = true;
}

function applyRange(nm) {
  currentRange = Math.max(1, Math.min(SLIDER_MAX, Math.round(nm)));
  radar.setRange(currentRange);
  radar.clear(); // drop contacts outside the new range; poll repopulates
  updateAircraftList();
  els.range.textContent = `${currentRange} nm`;
  try {
    localStorage.setItem(LS_RANGE_KEY, String(currentRange));
  } catch {
    /* ignore */
  }
  // Give immediate feedback that the new (wider/narrower) range took effect,
  // then fetch straight away instead of waiting for the next poll tick. Reset
  // the polling clock so the scheduled poll doesn't double-fire right after.
  setStatus(`Scanning ${currentRange} nm\u2026`, 'info');
  restartPolling();
}

function wireRangePicker() {
  els.rangeEdit.addEventListener('click', openRangePicker);
  els.modalClose.addEventListener('click', closeRangePicker);
  els.slider.addEventListener('input', () => setDraftRange(Number(els.slider.value)));
  els.apply.addEventListener('click', () => {
    applyRange(draftRange);
    closeRangePicker();
  });
  // Close when clicking the backdrop or pressing Escape.
  els.modal.addEventListener('click', (e) => {
    if (e.target === els.modal) closeRangePicker();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!els.modal.hidden) closeRangePicker();
    if (!els.centerModal.hidden) closeCenterPicker();
    if (!els.passportModal.hidden) closePassport();
  });
}

// ---- Location picker (choose your own center) -----------------------------
//
// Lets the user override the radar center by using the browser's geolocation,
// typing "lat, lon" coordinates, searching a place name (geocoded via the
// keyless OpenStreetMap Nominatim service), or clicking the map. The choice is
// persisted so it survives reloads and takes precedence over auto-geolocation.

const CENTER_HINT_DEFAULT = 'Search, or click the map to set your center.';
let centerMap;
let centerMapMarker;
let draftCenter = { ...center };

function setCenterHint(msg, isError = false) {
  els.centerHint.textContent = msg;
  els.centerHint.style.color = isError ? '#ff8a8a' : '';
}

function setDraftCenter(lat, lon, label) {
  draftCenter = {
    lat,
    lon,
    label: label || `${lat.toFixed(3)}, ${lon.toFixed(3)}`,
  };
  els.centerValue.textContent = draftCenter.label;
  if (centerMapMarker) centerMapMarker.setLatLng([lat, lon]);
}

// Accepts "51.5, -0.12" style coordinate pairs. Returns null when the string
// isn't a valid lat/lon so the caller can fall back to a place-name search.
function parseLatLon(s) {
  const m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Search failed');
  const data = await res.json();
  if (!data.length) throw new Error('No match found');
  const hit = data[0];
  const lat = parseFloat(hit.lat);
  const lon = parseFloat(hit.lon);
  // display_name is long; keep the first couple of components readable.
  const name = hit.display_name.split(',').slice(0, 2).join(',').trim();
  return { lat, lon, label: labelWithCoords(lat, lon, name) };
}

async function handleCenterSearch() {
  const q = els.centerSearch.value.trim();
  if (!q) return;

  const coords = parseLatLon(q);
  if (coords) {
    setDraftCenter(coords.lat, coords.lon);
    centerMap?.setView([coords.lat, coords.lon], 11);
    setCenterHint(CENTER_HINT_DEFAULT);
    return;
  }

  setCenterHint('Searching\u2026');
  try {
    const r = await geocode(q);
    setDraftCenter(r.lat, r.lon, r.label);
    centerMap?.setView([r.lat, r.lon], 11);
    setCenterHint(CENTER_HINT_DEFAULT);
  } catch (err) {
    setCenterHint(`Couldn't find that: ${err.message}.`, true);
  }
}

async function useMyLocation() {
  setCenterHint('Requesting your location\u2026');
  try {
    const c = await getGeolocation();
    setDraftCenter(c.lat, c.lon, c.label);
    centerMap?.setView([c.lat, c.lon], 11);
    setCenterHint(CENTER_HINT_DEFAULT);
  } catch {
    setCenterHint('Location unavailable or denied.', true);
  }
}

async function openCenterPicker() {
  els.centerModal.hidden = false;
  els.centerSearch.value = '';
  setCenterHint(CENTER_HINT_DEFAULT);
  setDraftCenter(center.lat, center.lon, center.label);

  let L;
  try {
    L = await loadLeaflet();
  } catch {
    setStatus('Map failed to load. Check your connection.', 'error');
    els.centerModal.hidden = true;
    return;
  }
  if (els.centerModal.hidden) return;

  const latlng = [draftCenter.lat, draftCenter.lon];
  if (!centerMap) {
    centerMap = L.map(els.centerMap, { zoomControl: true, attributionControl: true }).setView(latlng, 11);
    L.tileLayer(`https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`, {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(centerMap);
    centerMapMarker = L.circleMarker(latlng, {
      radius: 6,
      color: '#baffd7',
      weight: 2,
      fillColor: '#00ff78',
      fillOpacity: 1,
    }).addTo(centerMap);
    // Click anywhere on the map to drop the center there.
    centerMap.on('click', (e) => setDraftCenter(e.latlng.lat, e.latlng.lng));
  } else {
    centerMap.setView(latlng, centerMap.getZoom());
    centerMapMarker.setLatLng(latlng);
  }

  // The container was hidden until now, so Leaflet must re-measure it.
  setTimeout(() => centerMap.invalidateSize(), 60);
}

function closeCenterPicker() {
  els.centerModal.hidden = true;
}

function applyCenter(c) {
  center = { ...c };
  els.location.textContent = hudLabel(center);
  saveCenter(center);
  radar.clear(); // drop contacts from the old area; poll repopulates
  updateAircraftList();
  setStatus('Scanning new area\u2026', 'info');
  restartPolling();
}

function wireCenterPicker() {
  els.centerEdit.addEventListener('click', openCenterPicker);
  els.centerClose.addEventListener('click', closeCenterPicker);
  els.centerSearchBtn.addEventListener('click', handleCenterSearch);
  els.centerSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCenterSearch();
    }
  });
  els.centerGeo.addEventListener('click', useMyLocation);
  els.centerApply.addEventListener('click', () => {
    applyCenter(draftCenter);
    closeCenterPicker();
  });
  els.centerModal.addEventListener('click', (e) => {
    if (e.target === els.centerModal) closeCenterPicker();
  });
}

// ---- Passport map (world map of countries seen) ---------------------------
//
// Opens a modal with a dark world map where every country a flight has come
// from or gone to lights up green. Country polygons are Natural Earth data
// loaded on demand; the highlight set comes from the passport in localStorage.

function loadGeo(url, cacheRef) {
  if (cacheRef.p) return cacheRef.p;
  cacheRef.p = fetch(url, { headers: { Accept: 'application/json' } })
    .then((r) => {
      if (!r.ok) throw new Error(`map data HTTP ${r.status}`);
      return r.json();
    })
    .catch((err) => {
      // Let a later open retry rather than caching the rejection forever.
      cacheRef.p = undefined;
      throw err;
    });
  return cacheRef.p;
}

const worldGeoCache = {};
const landGeoCache = {};
const loadWorldGeo = () => loadGeo(WORLD_GEOJSON_URL, worldGeoCache);
const loadLandGeo = () => loadGeo(LAND_GEOJSON_URL, landGeoCache);

// Turn an ISO 3166-1 alpha-2 code into its flag emoji (e.g. "GB" -> flag).
function flagEmoji(iso) {
  const code = (iso || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  const base = 0x1f1e6; // regional indicator 'A'
  return String.fromCodePoint(base + code.charCodeAt(0) - 65, base + code.charCodeAt(1) - 65);
}

// Natural Earth marks a few countries with ISO_A2 "-99"; ISO_A2_EH fills those
// in, so prefer it and fall back to the plain code.
function featureIso2(props) {
  const eh = props.ISO_A2_EH;
  const a2 = props.ISO_A2;
  const code = eh && eh !== '-99' ? eh : a2;
  return (code || '').toUpperCase();
}

// Continent -> set of collectable country ISO codes, derived from the same
// Natural Earth dataset that paints the map. Building it from the map data (via
// each feature's CONTINENT property) keeps the "every country" target exactly in
// step with what can actually light up, so a continent badge is genuinely
// completable. Built once the world geo loads; null until then.
let continentIndex = null;
// Continent display order + the two CONTINENT values with no collectable
// countries (skipped).
const CONTINENT_ORDER = ['Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania'];
const CONTINENT_SKIP = new Set(['Antarctica', 'Seven seas (open ocean)']);

function buildContinentIndex(geo) {
  const groups = new Map();
  for (const f of (geo && geo.features) || []) {
    const props = f.properties || {};
    const cont = props.CONTINENT || '';
    if (!cont || CONTINENT_SKIP.has(cont)) continue;
    const iso = featureIso2(props);
    if (!/^[A-Z]{2}$/.test(iso)) continue;
    if (!groups.has(cont)) groups.set(cont, new Set());
    groups.get(cont).add(iso);
  }
  const ordered = [];
  for (const name of CONTINENT_ORDER) {
    if (groups.has(name)) ordered.push({ name, isos: groups.get(name) });
  }
  // Any continent the dataset reports that we didn't pre-order (defensive).
  for (const [name, isos] of groups) {
    if (!CONTINENT_ORDER.includes(name)) ordered.push({ name, isos });
  }
  return ordered;
}

// Seamless black land base with a faint green coastline. Drawn once from the
// single-geometry land dataset, so there are no gaps between countries.
const LAND_STYLE = {
  color: 'rgba(0, 255, 120, 0.35)',
  weight: 0.6,
  fillColor: '#000000',
  fillOpacity: 1,
};

// Map a flight count to a fill opacity. A single sighting is deliberately very
// faint, and the glow brightens with each additional flight along a gentle
// saturating curve, so there's plenty of headroom before a country maxes out.
function fillOpacityForCount(c) {
  if (!c || c <= 0) return 0;
  const min = 0.1;
  const max = 0.9;
  const K = 18; // larger -> slower brightening (more "room to manoeuvre")
  const t = 1 - 1 / (1 + c / K);
  return min + (max - min) * t;
}

// Country layer sits on top of the land base and only paints visited countries
// green, brighter the more flights have covered them. Unvisited countries stay
// invisible (but still hoverable for tooltips) so the simplified, non-shared
// country borders never show as slivers.
function styleForFeature(feature) {
  const iso = featureIso2(feature.properties);
  const entry = iso ? passport.countries[iso] : null;
  const c = entry ? entry.c : 0;
  const isSel = iso && iso === selectedIso;
  if (c > 0) {
    const op = fillOpacityForCount(c);
    // The outline tracks the fill but stays a touch brighter and subtle. The
    // selected country gets a bright, thick halo so it stands out on the map.
    const strokeAlpha = isSel ? 1 : Math.min(0.9, 0.18 + op * 0.6);
    return {
      stroke: true,
      color: isSel ? '#eafff2' : `rgba(125, 255, 180, ${strokeAlpha.toFixed(3)})`,
      weight: isSel ? 2.2 : 0.8,
      fill: true,
      fillColor: '#00ff78',
      fillOpacity: isSel ? Math.min(0.95, op + 0.2) : op,
    };
  }
  // Unvisited: invisible, but a selected-yet-unvisited case can't happen since
  // selection is gated on a recorded country.
  return { stroke: false, fill: true, fillColor: '#000000', fillOpacity: 0 };
}

let passportMap;
let passportGeoLayer;
let passportLandLayer;

// Default framing for the passport world map: centred, fully zoomed out. Used
// both when the map is first created and when a country selection is cleared.
const PASSPORT_HOME_CENTER = [25, 0];
const PASSPORT_HOME_ZOOM = 1;

// Local calendar-day key (YYYY-MM-DD) for grouping sightings by the day they
// were collected.
function dayKeyOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Friendly heading for a day key: "Today"/"Yesterday", else e.g. "Mon 7 Jul".
function dayLabelOf(key) {
  const now = Date.now();
  if (key === dayKeyOf(now)) return 'Today';
  if (key === dayKeyOf(now - 86400000)) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

// One flight record -> a compact one-liner, e.g. "BA123 · G-XLEB · A320 · LHR->JFK".
function flightLine(fl) {
  const parts = [];
  if (fl.cs) parts.push(fl.cs);
  if (fl.reg) parts.push(fl.reg);
  if (fl.ty) parts.push(fl.ty);
  const from = fl.from || '?';
  const to = fl.to || '?';
  if (fl.from || fl.to) parts.push(`${from}\u2192${to}`);
  return parts.join(' \u00b7 ') || 'flight';
}

// Tooltip/title text summarising the flights recorded for a country on a day.
function flightsTitle(name, flights, count) {
  const header = `${name} \u2014 ${count} flight${count === 1 ? '' : 's'}`;
  if (!flights || !flights.length) return header;
  const lines = flights
    .slice()
    .reverse()
    .slice(0, 8)
    .map((fl) => `\u2022 ${flightLine(fl)}`);
  const more = flights.length > 8 ? `\n\u2026and ${flights.length - 8} more` : '';
  return `${header}\n${lines.join('\n')}${more}`;
}

// Group every recorded sighting by the day it happened. Returns days newest
// first, each with the countries collected that day (with their per-day flight
// counts and records).
function buildPassportDays() {
  const map = new Map(); // dayKey -> Map(iso -> { iso, name, count, flights })
  const ensure = (key, iso, name) => {
    let day = map.get(key);
    if (!day) {
      day = new Map();
      map.set(key, day);
    }
    let c = day.get(iso);
    if (!c) {
      c = { iso, name: name || iso, count: 0, flights: [] };
      day.set(iso, c);
    }
    return c;
  };

  for (const [iso, entry] of Object.entries(passport.countries)) {
    const flights = Array.isArray(entry.flights) ? entry.flights : [];
    if (flights.length) {
      for (const fl of flights) {
        const c = ensure(dayKeyOf(fl.t || entry.last || Date.now()), iso, entry.n);
        c.count += 1;
        c.flights.push(fl);
      }
    } else {
      // Legacy/migrated entry with no per-flight detail: place its whole count
      // on its last-seen day.
      const c = ensure(dayKeyOf(entry.last || entry.first || Date.now()), iso, entry.n);
      c.count += entry.c || 1;
    }
  }

  return [...map.entries()]
    .map(([key, isoMap]) => ({
      key,
      label: dayLabelOf(key),
      countries: [...isoMap.values()].sort((a, b) => b.count - a.count || a.iso.localeCompare(b.iso)),
    }))
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

// A friendly "first seen" label, e.g. "Today" / "Mon 7 Jul".
function seenLabel(t) {
  if (!t) return '';
  return dayLabelOf(dayKeyOf(t));
}

// Small DOM builders so data-derived text (airline names, registrations) is set
// via textContent and can never inject markup.
function makeCell(text, className) {
  const td = document.createElement('td');
  td.textContent = text == null ? '' : String(text);
  if (className) td.className = className;
  return td;
}

// A compact rarity/kind tag used across the logbook tables.
function rarityTagCell(rare, mil) {
  const td = document.createElement('td');
  td.className = 'log-tag-cell';
  if (mil) {
    const s = document.createElement('span');
    s.className = 'log-tag tag-mil';
    s.textContent = 'MIL';
    td.appendChild(s);
  }
  if (rare) {
    const s = document.createElement('span');
    s.className = 'log-tag tag-rare';
    s.textContent = 'RARE';
    td.appendChild(s);
  }
  return td;
}

// Currently-selected country (ISO) in the Countries tab, and which tab is live.
let selectedIso = null;
let activePassportTab = 'countries';

// Refresh the count readout and the day-grouped country list (Countries tab).
function renderPassportStats() {
  const codes = Object.keys(passport.countries);

  els.passportList.innerHTML = '';
  if (!codes.length) {
    const empty = document.createElement('p');
    empty.className = 'passport-empty';
    empty.textContent = 'No countries yet. Leave the radar running to collect them.';
    els.passportList.appendChild(empty);
    renderCountryDetail(selectedIso);
    return;
  }

  for (const day of buildPassportDays()) {
    const section = document.createElement('div');
    section.className = 'passport-day';

    const head = document.createElement('div');
    head.className = 'passport-day-head';
    const n = day.countries.length;
    head.textContent = `${day.label} \u00b7 ${n} countr${n === 1 ? 'y' : 'ies'}`;
    section.appendChild(head);

    const chips = document.createElement('div');
    chips.className = 'passport-day-chips';
    for (const c of day.countries) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'passport-chip';
      chip.dataset.iso = c.iso;
      if (c.iso === selectedIso) chip.classList.add('is-selected');
      const f = flagEmoji(c.iso);
      chip.textContent = `${f ? `${f} ` : ''}${c.name || c.iso} \u00b7 ${c.count}`;
      chip.title = flightsTitle(c.name || c.iso, c.flights, c.count);
      chips.appendChild(chip);
    }
    section.appendChild(chips);
    els.passportList.appendChild(section);
  }
  renderCountryDetail(selectedIso);
}

// Render the detail panel for the selected country (its recent flights), or a
// prompt when nothing is selected. Replaces the need to hover the map.
function renderCountryDetail(iso) {
  const el = els.passportCountryDetail;
  if (!el) return;
  el.innerHTML = '';
  const entry = iso ? passport.countries[iso] : null;
  if (!entry) {
    const p = document.createElement('p');
    p.className = 'passport-hint';
    p.textContent = 'Select a country on the map or a chip below to see its flights.';
    el.appendChild(p);
    return;
  }

  const name = entry.n || iso;
  const head = document.createElement('div');
  head.className = 'country-detail-head';
  const title = document.createElement('span');
  title.className = 'country-detail-title';
  const flag = flagEmoji(iso);
  title.textContent = `${flag ? `${flag} ` : ''}${name}`;
  const meta = document.createElement('span');
  meta.className = 'country-detail-meta';
  meta.textContent = `${entry.c} flight${entry.c === 1 ? '' : 's'} \u00b7 first ${seenLabel(entry.first)}`;
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'country-detail-clear';
  clear.setAttribute('aria-label', 'Clear selection');
  clear.title = 'Clear selection';
  clear.textContent = '\u00d7';
  clear.addEventListener('click', clearCountrySelection);
  head.appendChild(title);
  head.appendChild(meta);
  head.appendChild(clear);
  el.appendChild(head);

  const flights = Array.isArray(entry.flights) ? entry.flights.slice().reverse() : [];
  if (!flights.length) {
    const p = document.createElement('p');
    p.className = 'passport-hint';
    p.textContent = 'No per-flight detail recorded for this country.';
    el.appendChild(p);
    return;
  }
  const list = document.createElement('ul');
  list.className = 'country-flight-list';
  for (const fl of flights.slice(0, 12)) {
    list.appendChild(renderCountryFlight(fl, iso));
  }
  el.appendChild(list);
}

// Readable label for one route endpoint: "London (LHR)" when both a name and a
// code are known, otherwise whichever we have. Prefixed with a country flag
// when available.
function endpointLabel(city, code, iso) {
  const flag = flagEmoji(iso);
  let text;
  if (city && code && city.toUpperCase() !== code.toUpperCase()) text = `${city} (${code})`;
  else text = city || code || 'Unknown';
  return flag ? `${flag} ${text}` : text;
}

// Short local time (e.g. "14:32") for a flight's timestamp.
function flightTime(t) {
  if (!t) return '';
  try {
    return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// Build a structured, human-readable entry for one flight in the country detail
// panel. Leads with the route (city + code, with flags), then a secondary line
// of identity/type. The endpoint matching the selected country is highlighted.
function renderCountryFlight(fl, iso) {
  const li = document.createElement('li');
  li.className = 'cflight';

  // Older records stored only airport codes. If the city names/flags are
  // missing, try to recover them from the cached route for this callsign so
  // the readable form still shows for flights collected before the change.
  let { fromCity, toCity, fromIso, toIso } = fl;
  if ((!fromCity || !toCity || !fromIso || !toIso) && fl.cs) {
    const r = cachedRouteFor(fl.cs);
    if (r && r.origin && r.destination) {
      fromCity = fromCity || r.origin.municipality || r.origin.name || '';
      toCity = toCity || r.destination.municipality || r.destination.name || '';
      fromIso = fromIso || r.origin.countryIso || '';
      toIso = toIso || r.destination.countryIso || '';
    }
  }

  const routeRow = document.createElement('div');
  routeRow.className = 'cflight-route';
  const from = document.createElement('span');
  from.className = 'cflight-place';
  if (fromIso && fromIso === iso) from.classList.add('is-here');
  from.textContent = endpointLabel(fromCity, fl.from, fromIso);
  const arrow = document.createElement('span');
  arrow.className = 'cflight-arrow';
  arrow.textContent = '\u2192';
  const to = document.createElement('span');
  to.className = 'cflight-place';
  if (toIso && toIso === iso) to.classList.add('is-here');
  to.textContent = endpointLabel(toCity, fl.to, toIso);
  routeRow.appendChild(from);
  routeRow.appendChild(arrow);
  routeRow.appendChild(to);
  li.appendChild(routeRow);

  // Secondary line: flight id, airline, aircraft type/model, tail, time.
  const meta = [];
  if (fl.cs) meta.push(fl.cs);
  const airline = fl.op ? tidyOperator(fl.op) : '';
  if (airline) meta.push(airline);
  const aircraft = fl.md || fl.ty;
  if (aircraft) meta.push(aircraft);
  if (fl.reg) meta.push(fl.reg);
  const time = flightTime(fl.t);
  if (time) meta.push(time);
  if (meta.length) {
    const metaRow = document.createElement('div');
    metaRow.className = 'cflight-meta';
    metaRow.textContent = meta.join(' \u00b7 ');
    li.appendChild(metaRow);
  }
  return li;
}

// Find the map polygon layer for an ISO code (used to sync map <-> chip clicks).
function findLayerForIso(iso) {
  if (!passportGeoLayer) return null;
  let found = null;
  passportGeoLayer.eachLayer((layer) => {
    if (found) return;
    if (featureIso2(layer.feature.properties) === iso) found = layer;
  });
  return found;
}

// Deselect the pinned country: clear the detail panel and drop the map/chip
// highlight so the user can back out of a selection.
function clearCountrySelection() {
  selectedIso = null;
  renderCountryDetail(null);
  for (const chip of els.passportList.querySelectorAll('.passport-chip')) {
    chip.classList.remove('is-selected');
  }
  if (passportGeoLayer) passportGeoLayer.setStyle(styleForFeature);
  // Reverse the fitBounds zoom-in from selectCountry so backing out returns to
  // the full world view.
  if (passportMap) passportMap.flyTo(PASSPORT_HOME_CENTER, PASSPORT_HOME_ZOOM, { duration: 0.6 });
}

// Select a country: update the detail panel, restyle the map to highlight it,
// and frame it. Safe to call before the map/layer exists.
function selectCountry(iso, { pan = false } = {}) {
  if (!iso || !passport.countries[iso]) return;
  selectedIso = iso;
  renderCountryDetail(iso);
  // Keep the day chips' selected state in sync.
  for (const chip of els.passportList.querySelectorAll('.passport-chip')) {
    chip.classList.toggle('is-selected', chip.dataset.iso === iso);
  }
  if (passportGeoLayer) passportGeoLayer.setStyle(styleForFeature);
  const layer = findLayerForIso(iso);
  if (layer) {
    layer.bringToFront();
    if (pan && passportMap && layer.getBounds) {
      try {
        passportMap.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 5 });
      } catch {
        /* some multipolygons throw on tiny bounds; ignore */
      }
    }
  }
}

// ---- Logbook tabs: aircraft (types / registrations) + airlines ------------

// Turn a keyed logbook object into an array of rows sorted by sightings desc.
function logbookRows(book) {
  return Object.entries(book)
    .map(([key, e]) => ({ key, ...e }))
    .sort((a, b) => b.c - a.c || (b.last || 0) - (a.last || 0));
}

function renderEmptyRow(tbody, cols, msg) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = cols;
  td.className = 'log-empty';
  td.textContent = msg;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

// Build a header row from a list of column labels; the "Seen" count column is
// right-aligned to match the body cells.
function renderLogHead(thead, labels) {
  thead.innerHTML = '';
  const tr = document.createElement('tr');
  labels.forEach((label, i) => {
    const th = document.createElement('th');
    th.textContent = label;
    if (i === labels.length - 1) th.className = 'log-count';
    tr.appendChild(th);
  });
  thead.appendChild(tr);
}

// The Aircraft tab is one table that groups either by aircraft type (model) or
// by individual registration (tail). Both views share the same columns
// (identifier, secondary label, rarity, count) so switching only reframes the
// data rather than changing the layout.
let aircraftGroupBy = 'type';

function renderAircraftTab() {
  const head = els.aircraftHead;
  const tbody = els.aircraftBody;
  if (!tbody) return;

  const byType = aircraftGroupBy !== 'reg';
  if (head) {
    renderLogHead(head, byType ? ['Type', 'Model', 'Rarity', 'Seen'] : ['Registration', 'Type', 'Rarity', 'Seen']);
  }

  tbody.innerHTML = '';
  const rows = logbookRows(byType ? passport.types : passport.regs);
  if (!rows.length) {
    renderEmptyRow(tbody, 4, byType ? 'No aircraft types logged yet.' : 'No registrations logged yet.');
    return;
  }
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.appendChild(makeCell(r.key, 'log-code'));
    tr.appendChild(makeCell((byType ? r.n : r.ty) || '\u2014', 'log-name'));
    tr.appendChild(rarityTagCell(r.rare, r.mil));
    tr.appendChild(makeCell(r.c, 'log-count'));
    tbody.appendChild(tr);
  }
}

function renderAirlinesTab() {
  const tbody = els.airlinesBody;
  if (!tbody) return;
  tbody.innerHTML = '';
  const rows = logbookRows(passport.airlines);
  if (!rows.length) {
    renderEmptyRow(tbody, 3, 'No airlines logged yet.');
    return;
  }
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.appendChild(makeCell(r.key, 'log-name'));
    tr.appendChild(makeCell(seenLabel(r.first), 'log-first'));
    tr.appendChild(makeCell(r.c, 'log-count'));
    tbody.appendChild(tr);
  }
}

// ---- Badges ---------------------------------------------------------------

// Derive the full badge set purely from stored data. Each badge is earned or
// locked, with a detail line (earned) or a hint (locked).
// Highest count (and its key) across a logbook, so "seen N times" badges can
// name the standout tail/airline. Returns { key, count }.
function topEntry(book) {
  let key = '';
  let count = 0;
  for (const [k, e] of Object.entries(book || {})) {
    if (e && e.c > count) {
      count = e.c;
      key = k;
    }
  }
  return { key, count };
}

function computeBadges() {
  const p = passport;
  const rec = p.records || {};
  const a380 = p.types.A388;
  const countryCount = Object.keys(p.countries).length;
  const typeCount = Object.keys(p.types).length;
  const regCount = Object.keys(p.regs).length;
  const airlineCount = Object.keys(p.airlines).length;
  const lr = rec.longestRoute;
  const ha = rec.highestAlt;

  // Derived collection facts.
  const topReg = topEntry(p.regs);
  const topAirline = topEntry(p.airlines);
  const typeVals = Object.values(p.types);
  const hasRare = typeVals.some((t) => t.rare);
  const hasHeavy = typeVals.some((t) => t.size === 'heavy');
  const hasLight = typeVals.some((t) => t.size === 'light');

  // Iconic airframes (keyed by ICAO type code in the type logbook).
  const has747 = Object.keys(p.types).some((k) => k.startsWith('B74'));
  const antonov = p.types.A124 || p.types.A225;
  const WARBIRDS = ['SPIT', 'LANC', 'P51', 'B17', 'MOSQ'];
  const warbird = WARBIRDS.find((k) => p.types[k]);

  // Record-threshold helpers.
  const low = rec.lowestAlt;
  const close = rec.closest;
  const fast = rec.fastest;
  const MILE_HIGH_FT = 43000;
  const LONG_NM = 3000;
  const ULTRA_NM = 5000;
  const DECK_FT = 2000;
  const CLOSE_NM = 2;
  const FAST_KT = 550;

  // Tiered milestone helper. `hint` is the timeless description (shown in both
  // states); `progress` is the live count shown only while locked.
  const tier = (id, name, have, need, unit) => ({
    id,
    name,
    earned: have >= need,
    hint: `Reach ${need.toLocaleString()} ${unit}`,
    detail: have >= need ? `${have.toLocaleString()} ${unit}` : '',
    progress: have >= need ? '' : `${have.toLocaleString()} / ${need.toLocaleString()} ${unit}`,
  });

  // One badge per continent, earned once every collectable country in it has
  // been seen. Only available after the map data (continentIndex) has loaded.
  const continentBadges = (continentIndex || []).map((cont) => {
    const need = cont.isos.size;
    let have = 0;
    for (const iso of cont.isos) if (p.countries[iso]) have += 1;
    const done = need > 0 && have >= need;
    return {
      id: `continent-${cont.name.toLowerCase().replace(/\s+/g, '-')}`,
      name: `${cont.name} Complete`,
      earned: done,
      detail: done ? `All ${need} countries` : '',
      hint: `See a flight from every country in ${cont.name}`,
      progress: done ? '' : `${have} / ${need} countries`,
    };
  });

  return [
    // ---- First-contact / event badges (existing) --------------------------
    {
      id: 'a380',
      name: 'First A380',
      earned: !!a380,
      detail: a380 ? `Seen ${a380.c}\u00d7 \u00b7 ${seenLabel(a380.first)}` : '',
      hint: 'Spot an Airbus A380',
    },
    {
      id: 'military',
      name: 'First Military',
      earned: !!rec.firstMilitary,
      detail: rec.firstMilitary ? `${rec.firstMilitary.cs || rec.firstMilitary.ty || 'contact'} \u00b7 ${seenLabel(rec.firstMilitary.t)}` : '',
      hint: 'Catch a military aircraft',
    },
    {
      id: 'e7700',
      name: '7700 Witnessed',
      earned: !!rec.emergency7700,
      detail: rec.emergency7700 ? `${rec.emergency7700.cs || 'squawk 7700'} \u00b7 ${seenLabel(rec.emergency7700.t)}` : '',
      hint: 'Witness a 7700 emergency squawk',
    },
    {
      id: 'e7500',
      name: '7500 Hijack',
      earned: !!rec.hijack7500,
      detail: rec.hijack7500 ? `${rec.hijack7500.cs || 'squawk 7500'} \u00b7 ${seenLabel(rec.hijack7500.t)}` : '',
      hint: 'Witness a 7500 hijack squawk',
    },
    {
      id: 'e7600',
      name: '7600 Radio Failure',
      earned: !!rec.radioFail7600,
      detail: rec.radioFail7600 ? `${rec.radioFail7600.cs || 'squawk 7600'} \u00b7 ${seenLabel(rec.radioFail7600.t)}` : '',
      hint: 'Witness a 7600 radio-failure squawk',
    },
    {
      id: 'night',
      name: 'Night Owl',
      earned: !!rec.nightOwl,
      detail: rec.nightOwl ? `${rec.nightOwl.cs || 'contact'} \u00b7 ${seenLabel(rec.nightOwl.t)}` : '',
      hint: 'Spot a flight between 10pm and 5am',
    },
    {
      id: 'earlybird',
      name: 'Early Bird',
      earned: !!rec.earlyBird,
      detail: rec.earlyBird ? `${rec.earlyBird.cs || 'contact'} \u00b7 ${seenLabel(rec.earlyBird.t)}` : '',
      hint: 'Spot a flight between 5am and 7am',
    },
    {
      id: 'homebound',
      name: 'Homebound',
      earned: !!rec.homebound,
      detail: rec.homebound ? `${rec.homebound.name || rec.homebound.iso} domestic \u00b7 ${rec.homebound.cs || 'contact'}`.trim() : '',
      hint: 'See a domestic flight (same country both ends)',
    },
    {
      id: 'arctic',
      name: 'Arctic Circle',
      earned: !!rec.arctic,
      detail: rec.arctic ? `${rec.arctic.place} \u00b7 ${seenLabel(rec.arctic.t)}` : '',
      hint: 'See a route reaching the Arctic Circle',
    },

    // ---- Record badges ----------------------------------------------------
    {
      id: 'longroute',
      name: 'Longest Route',
      earned: !!lr,
      detail: lr ? `${lr.from}\u2192${lr.to} \u00b7 ${Math.round(lr.nm).toLocaleString()} nm` : '',
      hint: 'See a long-haul route end to end',
    },
    {
      id: 'longhauler',
      name: 'Long Hauler',
      earned: !!lr && lr.nm >= LONG_NM,
      detail: lr && lr.nm >= LONG_NM ? `${lr.from}\u2192${lr.to} \u00b7 ${Math.round(lr.nm).toLocaleString()} nm` : '',
      hint: `See a route of ${LONG_NM.toLocaleString()}+ nm`,
      progress: lr && lr.nm < LONG_NM ? `best ${Math.round(lr.nm).toLocaleString()} nm` : '',
    },
    {
      id: 'ultrahauler',
      name: 'Ultra Long Hauler',
      earned: !!lr && lr.nm >= ULTRA_NM,
      detail: lr && lr.nm >= ULTRA_NM ? `${lr.from}\u2192${lr.to} \u00b7 ${Math.round(lr.nm).toLocaleString()} nm` : '',
      hint: `See a route of ${ULTRA_NM.toLocaleString()}+ nm`,
      progress: lr && lr.nm < ULTRA_NM ? `best ${Math.round(lr.nm).toLocaleString()} nm` : '',
    },
    {
      id: 'highest',
      name: 'Highest Contact',
      earned: !!ha,
      detail: ha ? `${ha.altFt.toLocaleString()} ft \u00b7 ${ha.ty || ha.cs || ''}`.trim() : '',
      hint: 'Track a very high-altitude contact',
    },
    {
      id: 'milehigh',
      name: 'Flight Level 430',
      earned: !!ha && ha.altFt >= MILE_HIGH_FT,
      detail: ha && ha.altFt >= MILE_HIGH_FT ? `${ha.altFt.toLocaleString()} ft \u00b7 ${ha.ty || ha.cs || ''}`.trim() : '',
      hint: `Track a contact at ${MILE_HIGH_FT.toLocaleString()}+ ft`,
      progress: ha && ha.altFt < MILE_HIGH_FT ? `best ${ha.altFt.toLocaleString()} ft` : '',
    },
    {
      id: 'ondeck',
      name: 'On the Deck',
      earned: !!low && low.altFt <= DECK_FT,
      detail: low && low.altFt <= DECK_FT ? `${low.altFt.toLocaleString()} ft \u00b7 ${low.ty || low.cs || ''}`.trim() : '',
      hint: `Track a contact at ${DECK_FT.toLocaleString()} ft or lower`,
      progress: low && low.altFt > DECK_FT ? `lowest ${low.altFt.toLocaleString()} ft` : '',
    },
    {
      id: 'closecall',
      name: 'Close Call',
      earned: !!close && close.nm <= CLOSE_NM,
      detail: close && close.nm <= CLOSE_NM ? `${close.nm.toFixed(1)} nm \u00b7 ${close.ty || close.cs || ''}`.trim() : '',
      hint: `Have a contact pass within ${CLOSE_NM} nm`,
      progress: close && close.nm > CLOSE_NM ? `closest ${close.nm.toFixed(1)} nm` : '',
    },
    {
      id: 'speeddemon',
      name: 'Speed Demon',
      earned: !!fast && fast.kt >= FAST_KT,
      detail: fast && fast.kt >= FAST_KT ? `${Math.round(fast.kt).toLocaleString()} kt \u00b7 ${fast.ty || fast.cs || ''}`.trim() : '',
      hint: `Catch a contact at ${FAST_KT}+ kt`,
      progress: fast && fast.kt < FAST_KT ? `fastest ${Math.round(fast.kt)} kt` : '',
    },

    // ---- Collection milestones -------------------------------------------
    {
      id: 'globetrotter',
      name: 'Globetrotter',
      earned: countryCount >= 10,
      detail: countryCount >= 10 ? `${countryCount} countries` : '',
      hint: 'Collect 10 countries',
      progress: countryCount < 10 ? `${countryCount} / 10 countries` : '',
    },
    tier('globetrotter2', 'Globetrotter II', countryCount, 25, 'countries'),
    tier('globetrotter3', 'Globetrotter III', countryCount, 50, 'countries'),
    {
      id: 'spotter',
      name: 'Type Spotter',
      earned: typeCount >= 20,
      detail: typeCount >= 20 ? `${typeCount} types` : '',
      hint: 'Log 20 aircraft types',
      progress: typeCount < 20 ? `${typeCount} / 20 types` : '',
    },
    tier('typehunter', 'Type Hunter', typeCount, 50, 'types'),
    tier('typemaster', 'Type Master', typeCount, 100, 'types'),
    {
      id: 'fleet',
      name: 'Fleet Tracker',
      earned: regCount >= 50,
      detail: regCount >= 50 ? `${regCount} tails` : '',
      hint: 'Log 50 registrations',
      progress: regCount < 50 ? `${regCount} / 50 tails` : '',
    },
    tier('tailchaser', 'Tail Chaser', regCount, 100, 'tails'),
    tier('spotterspotter', "Spotter's Spotter", regCount, 250, 'tails'),
    tier('airlinebuff', 'Airline Buff', airlineCount, 15, 'airlines'),
    tier('alliance', 'Alliance', airlineCount, 30, 'airlines'),
    {
      id: 'frequentflyer',
      name: 'Frequent Flyer',
      earned: topReg.count >= 5,
      detail: topReg.count >= 5 ? `${topReg.key} seen ${topReg.count}\u00d7` : '',
      hint: 'See one tail 5 times',
      progress: topReg.count && topReg.count < 5 ? `best ${topReg.count}\u00d7` : '',
    },
    {
      id: 'loyaltycard',
      name: 'Loyalty Card',
      earned: topAirline.count >= 25,
      detail: topAirline.count >= 25 ? `${topAirline.key} \u00d7${topAirline.count}` : '',
      hint: 'See one airline 25 times',
      progress: topAirline.count && topAirline.count < 25 ? `best ${topAirline.count}\u00d7` : '',
    },

    // ---- Rarity / iconic --------------------------------------------------
    {
      id: 'rarebird',
      name: 'Rare Bird',
      earned: hasRare,
      detail: hasRare ? `${typeVals.filter((t) => t.rare).length} rare type(s) logged` : '',
      hint: 'Log a rare / iconic airframe',
    },
    {
      id: 'heavymetal',
      name: 'Heavy Metal',
      earned: hasHeavy,
      detail: hasHeavy ? 'Logged a heavy aircraft' : '',
      hint: 'Log a heavy (wide-body) aircraft',
    },
    {
      id: 'featherweight',
      name: 'Featherweight',
      earned: hasLight,
      detail: hasLight ? 'Logged a light aircraft' : '',
      hint: 'Log a light aircraft',
    },
    {
      id: 'queenofskies',
      name: 'Queen of the Skies',
      earned: has747,
      detail: has747 ? 'Boeing 747 family logged' : '',
      hint: 'Log any Boeing 747',
    },
    {
      id: 'antonov',
      name: 'Antonov Heavy',
      earned: !!antonov,
      detail: antonov ? `Seen ${antonov.c}\u00d7 \u00b7 ${seenLabel(antonov.first)}` : '',
      hint: 'Log an Antonov An-124 or An-225',
    },
    {
      id: 'warbird',
      name: 'Warbird',
      earned: !!warbird,
      detail: warbird ? `${warbird} logged` : '',
      hint: 'Log a WWII-era warbird',
    },

    // ---- Continent completion (needs loaded map data) ---------------------
    ...continentBadges,
  ];
}

function renderBadgesTab() {
  const grid = els.badgesGrid;
  if (!grid) return;
  grid.innerHTML = '';
  const badges = computeBadges();
  const earned = badges.filter((b) => b.earned).length;
  const head = document.createElement('div');
  head.className = 'badges-head';
  head.textContent = `${earned} / ${badges.length} badges earned`;
  grid.appendChild(head);

  const wrap = document.createElement('div');
  wrap.className = 'badges-wrap';
  for (const b of badges) {
    const tile = document.createElement('div');
    tile.className = `badge${b.earned ? ' is-earned' : ' is-locked'}`;
    const star = document.createElement('span');
    star.className = 'badge-star';
    star.textContent = b.earned ? '\u2605' : '\u2606';
    const name = document.createElement('span');
    name.className = 'badge-name';
    name.textContent = b.name;
    // Timeless description of what the badge is (shown in both states).
    const desc = document.createElement('span');
    desc.className = 'badge-desc';
    desc.textContent = b.hint;
    tile.appendChild(star);
    tile.appendChild(name);
    tile.appendChild(desc);
    // Second line: the achievement detail when earned, else progress-so-far.
    const line = b.earned ? b.detail : b.progress;
    if (line) {
      const detail = document.createElement('span');
      detail.className = 'badge-detail';
      detail.textContent = line;
      tile.appendChild(detail);
    }
    wrap.appendChild(tile);
  }
  grid.appendChild(wrap);
}

// ---- Session stats --------------------------------------------------------

// Short wall-clock time, e.g. "14:32". Used for "first tracked / latest" lines.
function fmtClock(t) {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Most frequent non-empty value in a list, plus how often it occurred.
function modeOf(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let key = '';
  let count = 0;
  for (const [k, c] of counts) if (c > count) { count = c; key = k; }
  return { key, count };
}

function renderStatsTab() {
  const body = els.statsBody;
  if (!body) return;
  syncSessionBadges();
  body.innerHTML = '';

  const s = session.sightings;

  // Nothing caught yet: a friendly holding message beats a wall of zeroes.
  if (session.total === 0) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = 'No contacts yet this session. Everything you catch will be tallied here live \u2014 keep the scope running.';
    body.appendChild(empty);
    return;
  }

  // ---- Small DOM helpers -------------------------------------------------
  const addSection = (title, count) => {
    const sec = document.createElement('section');
    sec.className = 'session-section';
    const h = document.createElement('h3');
    h.className = 'session-section-title';
    h.textContent = count == null ? title : `${title} (${count})`;
    sec.appendChild(h);
    body.appendChild(sec);
    return sec;
  };
  const addRows = (sec, rows) => {
    const list = document.createElement('div');
    list.className = 'session-rows';
    for (const r of rows) {
      if (!r || !r.value) continue;
      const row = document.createElement('div');
      row.className = 'session-row';
      const l = document.createElement('span');
      l.className = 'session-row-label';
      l.textContent = r.label;
      const v = document.createElement('span');
      v.className = 'session-row-value';
      v.textContent = r.value;
      if (r.tag) {
        const tag = document.createElement('span');
        tag.className = `session-tag session-tag-${r.tag.toLowerCase()}`;
        tag.textContent = r.tag;
        v.appendChild(tag);
      }
      row.append(l, v);
      list.appendChild(row);
    }
    if (list.children.length) sec.appendChild(list);
  };

  // ---- Derived figures ---------------------------------------------------
  const now = Date.now();
  const elapsedMs = Math.max(0, now - session.start);
  const mins = Math.round(elapsedMs / 60000);
  const dur = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  const perHour = session.total / Math.max(1 / 60, elapsedMs / 3600000);
  const rateStr = perHour >= 10 ? String(Math.round(perHour)) : perHour.toFixed(1);

  const uniqTypes = new Set(s.map((it) => it.ty).filter(Boolean));
  const uniqAirlines = new Set(s.map((it) => it.airline).filter(Boolean));
  const uniqCountries = new Set(s.map((it) => it.origin && it.origin.iso).filter(Boolean));
  const newCountryIsos = [...uniqCountries].filter((iso) => !sessionStartCountryIsos.has(iso));

  // Busiest bearing (most common 16-point compass sector).
  const hist = new Array(16).fill(0);
  for (const it of s) {
    if (typeof it.bearing === 'number') hist[((Math.round(it.bearing / 22.5) % 16) + 16) % 16] += 1;
  }
  let bestI = -1;
  for (let i = 0; i < 16; i++) if (hist[i] > (bestI < 0 ? 0 : hist[bestI])) bestI = i;

  // Standouts across the session's sightings.
  let far = null;
  let closest = null;
  let highest = null;
  let rarest = null;
  let rarestScore = -Infinity;
  for (const it of s) {
    if (it.originDistNm != null && (!far || it.originDistNm > far.originDistNm)) far = it;
    if (typeof it.distanceNm === 'number' && it.distanceNm >= 0 && (!closest || it.distanceNm < closest.distanceNm)) closest = it;
    if (typeof it.altFt === 'number' && (!highest || it.altFt > highest.altFt)) highest = it;
    const sc = rarityScore(it);
    if (sc > rarestScore) { rarestScore = sc; rarest = it; }
  }

  const typeMode = modeOf(s.map((it) => it.ty));
  const airlineMode = modeOf(s.map((it) => it.airline));

  const milCount = s.filter((it) => it.mil).length;
  const rareCount = s.filter((it) => it.rare).length;
  const emgCount = s.filter((it) => it.emergency).length;

  const nameOf = (it) => (it && (it.model || it.ty || it.airline || it.reg)) || 'contact';
  const contactWord = (n) => `${n} contact${n === 1 ? '' : 's'}`;

  // ---- Section: the headline numbers ------------------------------------
  const heroSec = addSection('This session');
  const hero = document.createElement('div');
  hero.className = 'session-hero';
  const heroCards = [
    { value: String(session.total), label: 'Contacts' },
    { value: dur, label: 'On watch' },
    { value: `${rateStr}/hr`, label: 'Contact rate' },
    { value: String(uniqTypes.size), label: 'Aircraft types' },
    { value: String(uniqAirlines.size), label: 'Airlines' },
    { value: String(uniqCountries.size), label: 'Origin countries' },
  ];
  for (const c of heroCards) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    const v = document.createElement('div');
    v.className = 'stat-value';
    v.textContent = c.value;
    const l = document.createElement('div');
    l.className = 'stat-label';
    l.textContent = c.label;
    card.append(v, l);
    hero.appendChild(card);
  }
  heroSec.appendChild(hero);

  // ---- Section: the standout catches ------------------------------------
  const highSec = addSection('Highlights');
  addRows(highSec, [
    {
      label: 'Rarest catch',
      value: rarest ? nameOf(rarest) : '',
      tag: rarest ? (rarest.emergency ? 'EMERGENCY' : rarest.rare ? 'RARE' : rarest.mil ? 'MIL' : '') : '',
    },
    { label: 'Most-seen type', value: typeMode.key ? `${typeMode.key} \u00d7${typeMode.count}` : '' },
    { label: 'Most-seen airline', value: airlineMode.key ? `${airlineMode.key} \u00d7${airlineMode.count}` : '' },
    { label: 'Busiest bearing', value: bestI >= 0 ? `${COMPASS_16[bestI]} \u00b7 ${contactWord(hist[bestI])}` : '' },
    { label: 'Farthest origin', value: far ? `${far.origin?.name || '\u2014'} \u00b7 ${Math.round(far.originDistNm).toLocaleString()} nm` : '' },
    { label: 'Closest pass', value: closest ? `${closest.distanceNm.toFixed(1)} nm \u00b7 ${nameOf(closest)}` : '' },
    { label: 'Highest contact', value: highest ? `${highest.altFt.toLocaleString()} ft \u00b7 ${nameOf(highest)}` : '' },
  ]);

  // ---- Section: activity texture ----------------------------------------
  const actSec = addSection('Activity');
  let specialVal = '';
  if (milCount || rareCount || emgCount) {
    specialVal = [
      milCount ? `${milCount} military` : '',
      rareCount ? `${rareCount} rare` : '',
      emgCount ? `${emgCount} emergency` : '',
    ].filter(Boolean).join(' \u00b7 ');
  } else {
    specialVal = 'None';
  }
  let newCountriesVal = '';
  if (newCountryIsos.length) {
    const names = newCountryIsos
      .map((iso) => (passport.countries[iso] && passport.countries[iso].n) || iso)
      .slice(0, 4);
    const extra = newCountryIsos.length - names.length;
    newCountriesVal = `${newCountryIsos.length} \u00b7 ${names.join(', ')}${extra > 0 ? ` +${extra}` : ''}`;
  } else {
    newCountriesVal = 'None new';
  }
  addRows(actSec, [
    { label: 'First tracked', value: s.length ? fmtClock(s[0].t) : '' },
    { label: 'Latest contact', value: s.length ? fmtClock(s[s.length - 1].t) : '' },
    { label: 'Special contacts', value: specialVal },
    { label: 'New countries', value: newCountriesVal },
  ]);

  // ---- Section: badges earned this session ------------------------------
  const badgeSec = addSection('Badges collected this session', sessionBadge.earned.length);
  if (sessionBadge.earned.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'session-empty session-empty-inline';
    empty.textContent = 'No new badges yet \u2014 rare types, records and milestones you unlock now will appear here.';
    badgeSec.appendChild(empty);
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'session-badges';
    // Most recent first so the latest unlock leads.
    for (const b of [...sessionBadge.earned].reverse()) {
      const tile = document.createElement('div');
      tile.className = 'badge is-earned';
      const star = document.createElement('span');
      star.className = 'badge-star';
      star.textContent = '\u2605';
      const name = document.createElement('span');
      name.className = 'badge-name';
      name.textContent = b.name;
      tile.append(star, name);
      if (b.detail) {
        const detail = document.createElement('span');
        detail.className = 'badge-detail';
        detail.textContent = b.detail;
        tile.appendChild(detail);
      }
      const when = document.createElement('span');
      when.className = 'badge-when';
      when.textContent = `Earned ${fmtClock(b.t)}`;
      tile.appendChild(when);
      wrap.appendChild(tile);
    }
    badgeSec.appendChild(wrap);
  }
}

// ---- Tab switching --------------------------------------------------------

const PASSPORT_PANELS = {
  countries: 'tabCountries',
  aircraft: 'tabAircraft',
  airlines: 'tabAirlines',
  badges: 'tabBadges',
  stats: 'tabStats',
};

// Render whichever tab is active. Called on open and on live updates.
function refreshOpenPassportTab() {
  switch (activePassportTab) {
    case 'countries':
      renderPassportStats();
      if (passportGeoLayer) passportGeoLayer.setStyle(styleForFeature);
      break;
    case 'aircraft':
      renderAircraftTab();
      break;
    case 'airlines':
      renderAirlinesTab();
      break;
    case 'badges':
      renderBadgesTab();
      break;
    case 'stats':
      renderStatsTab();
      break;
  }
}

function showPassportTab(name) {
  if (!PASSPORT_PANELS[name]) name = 'countries';
  activePassportTab = name;
  // Toggle tab buttons + panels.
  for (const btn of els.passportTabs.querySelectorAll('[data-tab]')) {
    const on = btn.dataset.tab === name;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', String(on));
  }
  for (const [tab, elKey] of Object.entries(PASSPORT_PANELS)) {
    const panel = els[elKey];
    if (panel) panel.hidden = tab !== name;
  }
  refreshOpenPassportTab();
  // The map lives in the Countries panel and can't measure itself while hidden,
  // so re-measure whenever that tab becomes visible.
  if (name === 'countries' && passportMap) {
    setTimeout(() => passportMap.invalidateSize(), 40);
  }
}

async function openPassport() {
  els.passportModal.hidden = false;
  showPassportTab(activePassportTab);

  let L;
  try {
    L = await loadLeaflet();
  } catch {
    setStatus('Map failed to load. Check your connection.', 'error');
    els.passportModal.hidden = true;
    return;
  }
  if (els.passportModal.hidden) return;

  if (!passportMap) {
    passportMap = L.map(els.passportMap, {
      zoomControl: true,
      attributionControl: false,
      worldCopyJump: false,
      minZoom: 1,
      maxZoom: 6,
    }).setView(PASSPORT_HOME_CENTER, PASSPORT_HOME_ZOOM);
    passportMap.setMaxBounds([
      [-85, -180],
      [85, 180],
    ]);
  }

  let land;
  let geo;
  try {
    [land, geo] = await Promise.all([loadLandGeo(), loadWorldGeo()]);
  } catch {
    setStatus('Country map data failed to load.', 'error');
  }
  if (els.passportModal.hidden) return;

  // Derive continent membership from the freshly loaded country data so the
  // continent-completion badges can compute. Refresh the badges view if it's
  // the tab currently showing (it renders before the async geo arrives).
  if (geo && !continentIndex) {
    continentIndex = buildContinentIndex(geo);
    // Now that continent badges can compute, fold any session-completed ones
    // into the live tally (baselining those already complete at session start).
    syncSessionBadges();
    if (activePassportTab === 'badges') renderBadgesTab();
  }

  // Seamless black land base first, so the country layer above never reveals
  // gaps between neighbouring polygons.
  if (land && !passportLandLayer) {
    passportLandLayer = L.geoJSON(land, { style: LAND_STYLE, interactive: false }).addTo(passportMap);
  }

  if (geo && !passportGeoLayer) {
    passportGeoLayer = L.geoJSON(geo, {
      style: styleForFeature,
      onEachFeature: (feature, layer) => {
        const iso = featureIso2(feature.properties);
        const props = feature.properties;
        const name = props.NAME || props.ADMIN || props.NAME_LONG || iso;
        const entry = iso ? passport.countries[iso] : null;
        let tip = `${name} \u2014 not seen yet`;
        if (entry) {
          const latest = entry.flights && entry.flights.length ? entry.flights[entry.flights.length - 1] : null;
          tip = `${name} \u2014 ${entry.c} flight${entry.c === 1 ? '' : 's'}`;
          if (latest) tip += `<br><span class="tip-flight">${flightLine(latest)}</span>`;
          tip += '<br><span class="tip-hint">click for details</span>';
        }
        layer.bindTooltip(tip, { sticky: true });
        // Click a visited country to pin its flights in the detail panel below
        // the map, so the data is available without keeping the pointer on it.
        if (entry) {
          layer.on('click', () => selectCountry(iso));
        }
      },
    }).addTo(passportMap);
  } else if (passportGeoLayer) {
    // Reflect any new sightings collected since the layer was built.
    passportGeoLayer.setStyle(styleForFeature);
  }

  // The container was hidden until now, so Leaflet must re-measure it.
  setTimeout(() => passportMap.invalidateSize(), 60);
}

function closePassport() {
  els.passportModal.hidden = true;
}

function resetPassport() {
  passport = emptyPassport();
  savePassport();
  selectedIso = null;
  // Also clear the in-memory session tally so the stats panel starts fresh.
  session.total = 0;
  session.sightings.length = 0;
  session.start = Date.now();
  // Reset session badge/country tracking against the now-empty passport.
  sessionStartCountryIsos = new Set();
  sessionBadge.baseline.clear();
  sessionBadge.earned.length = 0;
  sessionBadge.earnedIds.clear();
  sessionBadge.seeded = false;
  syncSessionBadges();
  refreshOpenPassportTab();
  if (passportGeoLayer) passportGeoLayer.setStyle(styleForFeature);
}

function wirePassport() {
  els.passportBtn.addEventListener('click', openPassport);
  els.passportClose.addEventListener('click', closePassport);
  els.passportReset.addEventListener('click', () => {
    if (window.confirm('Clear your entire passport \u2014 every country, aircraft type, airline, registration and badge? This cannot be undone.')) {
      resetPassport();
    }
  });
  els.passportModal.addEventListener('click', (e) => {
    if (e.target === els.passportModal) closePassport();
  });
  // Tab bar.
  els.passportTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) showPassportTab(btn.dataset.tab);
  });
  // Aircraft tab: toggle between grouping by type and by registration.
  if (els.aircraftGroupBy) {
    els.aircraftGroupBy.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-group]');
      if (!btn || btn.dataset.group === aircraftGroupBy) return;
      aircraftGroupBy = btn.dataset.group;
      for (const b of els.aircraftGroupBy.querySelectorAll('[data-group]')) {
        const on = b.dataset.group === aircraftGroupBy;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      }
      renderAircraftTab();
    });
  }
  // Clicking a day chip selects that country (mirrors a map click) and, on the
  // Countries tab, frames it on the map.
  els.passportList.addEventListener('click', (e) => {
    const chip = e.target.closest('.passport-chip');
    if (!chip || !chip.dataset.iso) return;
    // Clicking the country that's already pinned toggles the selection off.
    if (chip.dataset.iso === selectedIso) clearCountrySelection();
    else selectCountry(chip.dataset.iso, { pan: true });
  });
}

// ---- Fullscreen / immersive wall mode -------------------------------------
//
// Expands the radar almost edge to edge and hides the HUD boxes. Uses the
// native Fullscreen API where available (so browser chrome disappears too on a
// wall-mounted tablet) and falls back to a viewport-filling CSS layout.

function isImmersive() {
  return document.body.classList.contains('immersive');
}

function syncImmersive(on) {
  document.body.classList.toggle('immersive', on);
  els.fullscreen.setAttribute('aria-pressed', String(on));
  els.fullscreen.title = on ? 'Exit fullscreen' : 'Fullscreen';
  // The radar's CSS size just changed; nudge the canvas to re-measure.
  radar.resize();
}

async function toggleFullscreen() {
  const goImmersive = !isImmersive();
  if (goImmersive) {
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      /* fall back to CSS-only immersive layout */
    }
    syncImmersive(true);
  } else {
    try {
      if (document.fullscreenElement) await document.exitFullscreen?.();
    } catch {
      /* ignore */
    }
    syncImmersive(false);
  }
}

function wireFullscreen() {
  els.fullscreen.addEventListener('click', toggleFullscreen);
  // Keep our state in sync when the user leaves fullscreen via Esc or the OS.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && isImmersive()) syncImmersive(false);
  });
}

// ---- Sound toggle ---------------------------------------------------------
//
// Sound is off by default. The button both flips the mute state and, on the
// first enable, warms up the AudioContext under the user gesture so the
// autoplay policy is satisfied.

function syncSoundButton() {
  const on = audio.enabled;
  els.sound.setAttribute('aria-pressed', String(on));
  els.sound.title = on ? 'Mute sound' : 'Enable sound';
}

function setSound(on) {
  audio.setMuted(!on);
  try {
    localStorage.setItem(LS_SOUND_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
  syncSoundButton();
  // A gentle chime confirms sound is now on.
  if (on) audio.chime();
}

function wireSound() {
  syncSoundButton();
  els.sound.addEventListener('click', () => setSound(!audio.enabled));
}

// ---- Screen wake lock -----------------------------------------------------
//
// Keep the display awake on a wall-mounted tablet. The lock is dropped
// whenever the tab is hidden, so we re-acquire it when the page becomes
// visible again.

let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    // Denied (e.g. low battery) or unsupported; not fatal.
    wakeLock = null;
  }
}

function wireWakeLock() {
  requestWakeLock();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!wakeLock) requestWakeLock();
      // A hidden tab may have missed several polls; catch up immediately.
      if (Date.now() - lastUpdateAt > pollIntervalForRange(currentRange)) restartPolling();
    }
  });
}

// ---- Dev / demo harness ---------------------------------------------------
//
// Injects synthetic contacts straight into the radar so special-flight
// highlighting can be previewed without any real traffic.
// Enabled by loading the page with `?dev`
// in the URL, or by pressing the "D" key. Purely a development aid; it never
// runs unless explicitly opened, and demo blips are tagged so they bypass the
// network route lookup.

let demoSeq = 0;
const demoBlips = new Map(); // hex -> synthetic aircraft

// Compact airport builder matching the shape api.js produces, so demo routes
// render on cards and feed the passport. Coordinates are included so demo
// flights also drive the distance-based stats/badges (farthest origin, longest
// route).
function demoAirport(iata, icao, municipality, name, countryIso, countryName, lat, lon) {
  return { iata, icao, municipality, name, countryIso, countryName, lat, lon };
}

// Build one synthetic aircraft for the given preset. Placed close in at a
// random bearing.
function makeDemoAircraft(kind) {
  const base = {
    hex: `DEMO${(demoSeq++).toString(16).padStart(4, '0')}`,
    _demo: true,
    callsign: '',
    registration: '',
    type: '',
    model: '',
    category: '',
    squawk: '',
    sizeClass: 'medium',
    operator: '',
    route: null,
    flags: { emergency: null, military: false, rare: false },
    distanceNm: 1.2,
    bearingDeg: Math.round(Math.random() * 360),
    altFt: 6000,
    verticalRateFpm: 0,
    onGround: false,
    groundSpeedKt: 240,
    trackDeg: Math.round(Math.random() * 360),
    lat: null,
    lon: null,
    seenPosSec: 0,
  };

  switch (kind) {
    case 'heavy':
      return {
        ...base,
        callsign: 'BAW117',
        registration: 'G-STBA',
        type: 'B77W',
        model: 'BOEING 777-300ER',
        sizeClass: 'heavy',
        altFt: 11500,
        verticalRateFpm: 1600,
        route: {
          airline: 'British Airways',
          origin: demoAirport('LHR', 'EGLL', 'London', 'Heathrow', 'GB', 'United Kingdom', 51.4706, -0.4619),
          destination: demoAirport('JFK', 'KJFK', 'New York', 'John F Kennedy Intl', 'US', 'United States', 40.6413, -73.7781),
        },
      };
    case 'rare':
      return {
        ...base,
        callsign: 'UAE7',
        registration: 'A6-EUA',
        type: 'A388',
        model: 'AIRBUS A380-800',
        sizeClass: 'heavy',
        altFt: 15200,
        verticalRateFpm: -900,
        flags: { emergency: null, military: false, rare: true },
        route: {
          airline: 'Emirates',
          origin: demoAirport('DXB', 'OMDB', 'Dubai', 'Dubai Intl', 'AE', 'United Arab Emirates', 25.2532, 55.3657),
          destination: demoAirport('LHR', 'EGLL', 'London', 'Heathrow', 'GB', 'United Kingdom', 51.4706, -0.4619),
        },
      };
    case 'military':
      return {
        ...base,
        callsign: 'RCH476',
        registration: '08-8191',
        type: 'C17',
        model: 'BOEING C-17 GLOBEMASTER III',
        sizeClass: 'heavy',
        altFt: 8000,
        verticalRateFpm: -400,
        operator: 'United States Air Force',
        flags: { emergency: null, military: true, rare: false },
      };
    case 'emergency':
      return {
        ...base,
        callsign: 'AAL2019',
        registration: 'N803AL',
        type: 'A21N',
        model: 'AIRBUS A321neo',
        squawk: '7700',
        altFt: 4200,
        verticalRateFpm: -1200,
        flags: { emergency: 'emergency', military: false, rare: false },
        route: {
          airline: 'American Airlines',
          origin: demoAirport('MIA', 'KMIA', 'Miami', 'Miami Intl', 'US', 'United States', 25.7959, -80.2870),
          destination: demoAirport('BOS', 'KBOS', 'Boston', 'Logan Intl', 'US', 'United States', 42.3656, -71.0096),
        },
      };
    case 'radio':
      return {
        ...base,
        callsign: 'DLH8AT',
        registration: 'D-AIMA',
        type: 'A320',
        model: 'AIRBUS A320',
        squawk: '7600',
        altFt: 5200,
        flags: { emergency: 'radio-failure', military: false, rare: false },
        route: {
          airline: 'Lufthansa',
          origin: demoAirport('FRA', 'EDDF', 'Frankfurt', 'Frankfurt am Main', 'DE', 'Germany', 50.0379, 8.5622),
          destination: demoAirport('LHR', 'EGLL', 'London', 'Heathrow', 'GB', 'United Kingdom', 51.4706, -0.4619),
        },
      };
    case 'hijack':
      return {
        ...base,
        callsign: 'DEMO7500',
        registration: 'XX-HIJ',
        type: 'B738',
        model: 'BOEING 737-800',
        squawk: '7500',
        altFt: 9000,
        flags: { emergency: 'hijack', military: false, rare: false },
      };
    case 'light':
    default:
      return {
        ...base,
        callsign: '',
        registration: 'N512DV',
        type: 'C172',
        model: 'CESSNA 172',
        sizeClass: 'light',
        altFt: 2200,
        groundSpeedKt: 110,
        distanceNm: 1.6,
        operator: 'Private Owner',
      };
  }
}

// Insert a demo aircraft as a ready blip (route already known, so it bypasses
// the network lookup).
function spawnDemo(kind) {
  const a = makeDemoAircraft(kind);
  demoBlips.set(a.hex, a);
  radar.blips.set(a.hex, {
    ...a,
    intensity: 0,
    labelAlpha: 0,
    routeResolved: true,
    routePending: false,
    announced: false,
    lastUpdate: performance.now(),
  });
  if (a.route) recordRouteCountries(a.route, a);
  updateAircraftList();
}

// Remove every demo contact.
function clearDemo() {
  for (const hex of demoBlips.keys()) radar.blips.delete(hex);
  demoBlips.clear();
  updateAircraftList();
}

// Keep demo blips from being pruned by re-stamping them each heartbeat, and
// re-add any that a range/center change cleared off the scope.
function keepDemoAlive() {
  if (demoBlips.size === 0) return;
  const now = performance.now();
  for (const [hex, a] of demoBlips) {
    const b = radar.blips.get(hex);
    if (b) {
      b.lastUpdate = now;
    } else {
      radar.blips.set(hex, {
        ...a,
        intensity: 0,
        labelAlpha: 0,
        routeResolved: true,
        routePending: false,
        announced: false,
        lastUpdate: now,
      });
    }
  }
}

function wireDev() {
  const devOn = new URLSearchParams(location.search).has('dev');
  if (devOn) els.devPanel.hidden = false;

  els.devClose.addEventListener('click', () => {
    els.devPanel.hidden = true;
  });

  // The toolbox button toggles the panel open/closed.
  els.devToggle.addEventListener('click', () => {
    els.devPanel.hidden = !els.devPanel.hidden;
    els.devToggle.setAttribute('aria-pressed', String(!els.devPanel.hidden));
  });

  // Toggle the panel with "D", unless the user is typing in a field.
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'd' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    els.devPanel.hidden = !els.devPanel.hidden;
  });

  els.devPanel.addEventListener('click', (e) => {
    const spawn = e.target.closest('[data-demo]');
    if (spawn) {
      spawnDemo(spawn.dataset.demo);
      return;
    }
    const action = e.target.closest('[data-demo-action]');
    if (!action) return;
    if (action.dataset.demoAction === 'clear') clearDemo();
  });
}

// ---- Freshness tracking ---------------------------------------------------

let lastUpdateAt = 0;

// One-second heartbeat: keeps any demo contacts alive so they aren't pruned.
function tick() {
  keepDemoAlive();
}

// ---- Polling with exponential backoff -------------------------------------

let pollTimer = null;

// Poll cadence scales with the current range: at the widest range we use the
// full `pollIntervalMs`, and it ramps down linearly to `minPollIntervalMs` at
// the tightest range. Zoomed in, aircraft sweep across the scope quickly, so
// more frequent updates keep their motion smooth; zoomed out they crawl and a
// slower poll is plenty (and kinder to the API).
function pollIntervalForRange(rangeNm) {
  const min = CONFIG.minPollIntervalMs;
  const max = CONFIG.pollIntervalMs;
  if (max <= min) return max;
  const frac = (Math.max(1, rangeNm) - 1) / (SLIDER_MAX - 1);
  return Math.round(min + (max - min) * Math.min(1, Math.max(0, frac)));
}

let pollDelay = pollIntervalForRange(currentRange);

function scheduleNextPoll(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(runPoll, delay);
}

// Run one poll, then schedule the next: back to the normal cadence on success,
// or an exponentially growing delay (capped) on failure so we don't hammer a
// struggling API. A 429 (rate limited) is handled gently \u2014 the contacts already
// on the scope stay put (poll leaves them untouched on failure) and we wait out
// the server's requested cooldown before trying again.
async function runPoll() {
  const err = await poll();
  if (!err) {
    pollDelay = pollIntervalForRange(currentRange);
  } else {
    // Exponential backoff, floored at the range's normal cadence and capped so
    // we keep checking periodically.
    let delay = Math.min(CONFIG.maxBackoffMs, Math.max(pollIntervalForRange(currentRange), pollDelay * 2));
    if (err.rateLimited) {
      // Honor an explicit Retry-After even if it exceeds our usual ceiling:
      // the server told us exactly how long to wait, so respect it rather than
      // poking it again early and risking another 429.
      if (err.retryAfterMs != null) delay = Math.max(delay, err.retryAfterMs);
      const secs = Math.round(delay / 1000);
      setStatus(`Rate limited by airplanes.live \u2014 holding contacts, retrying in ${secs}s\u2026`, 'warn');
    } else {
      const secs = Math.round(delay / 1000);
      setStatus(`Data fetch failed: ${err.message}. Retrying in ${secs}s\u2026`, 'error');
    }
    pollDelay = delay;
  }
  scheduleNextPoll(pollDelay);
}

// Poll now and reset the backoff. Used at startup and after a manual range or
// location change so there's instant feedback.
function restartPolling() {
  clearTimeout(pollTimer);
  pollDelay = pollIntervalForRange(currentRange);
  runPoll();
}

// Returns null on a successful fetch, or the error on failure (so runPoll can
// back off and message appropriately). On failure it deliberately leaves the
// current blips untouched \u2014 no update, no prune \u2014 so the contacts already on
// the scope stay visible (and keep flaring under the sweep) while we wait out
// a transient outage or rate limit. Never throws.
async function poll() {
  try {
    const aircraft = await fetchNearbyAircraft(center.lat, center.lon, currentRange);
    const visible = aircraft.filter((a) => {
      if (a.distanceNm == null || a.bearingDeg == null) return false;
      // Airborne only \u2014 never plot ground traffic.
      if (a.onGround) return false;
      // Drop contacts whose last position fix is stale so the scope only shows
      // aircraft that are actually overhead right now.
      if (CONFIG.maxSeenPosSec > 0 && a.seenPosSec > CONFIG.maxSeenPosSec) return false;
      if (CONFIG.minAltFt > 0 && (a.altFt ?? 0) < CONFIG.minAltFt) return false;
      // Must actually be moving through the air, not parked/idling.
      if (CONFIG.minGroundSpeedKt > 0 && (a.groundSpeedKt ?? 0) < CONFIG.minGroundSpeedKt) return false;
      return true;
    });

    radar.update(visible);
    radar.prune(CONFIG.staleAfterSec);
    updateAircraftList();

    lastUpdateAt = Date.now();

    setStatus('', 'ok');

    // Resolve routes lazily for airline-style callsigns. lookupRoute caches,
    // so this is cheap after the first sighting. Attach the result back onto
    // the live blip so the radar can label it. A blip stays hidden until this
    // settles (see radar `_isReady`), so it only appears once both the
    // position and its route are known and the label is complete.
    for (const a of visible) {
      const blip = radar.blips.get(a.hex);
      if (!blip || blip.routeResolved || blip.routePending) continue;

      // No callsign means there's nothing to look up; all available info is
      // already present, so mark it ready right away.
      if (!a.callsign) {
        blip.route = null;
        blip.routeResolved = true;
        continue;
      }

      blip.routePending = true; // guard against refetching every poll
      // Pass the live position (to confirm the route is plausible for this
      // contact and reject a reused/aliased callsign) plus the heading (to pick
      // the current leg/direction of a round-trip rotation).
      lookupRoute(a.callsign, a.lat, a.lon, a.trackDeg).then((route) => {
        const b = radar.blips.get(a.hex);
        if (!b) return;
        b.route = route;
        b.routeResolved = true;
        b.routePending = false;
        // Stamp the origin/destination countries (and this flight's detail)
        // into the passport. The guard above means this fires once per blip
        // appearance, not every poll.
        recordRouteCountries(route, b);
        // The contact just became ready (and thus eligible for the scope and
        // the text list), so refresh the accessible list to include it.
        updateAircraftList();
      });
    }
    return null;
  } catch (err) {
    // Leave the existing contacts on the scope; runPoll decides the backoff and
    // surfaces the right message based on the error (rate limit vs. hard fail).
    return err;
  }
}

(async function init() {
  wireRangePicker();
  wireCenterPicker();
  wirePassport();
  wireFullscreen();
  wireSound();
  wireWakeLock();
  wireDev();
  // Establish the pre-session badge baseline before any contacts roll in, so
  // only badges earned during this session get celebrated in the panel.
  syncSessionBadges();
  // A location the user picked before takes precedence over auto-geolocation.
  const saved = loadSavedCenter();
  if (saved) {
    center = saved;
    els.location.textContent = hudLabel(center);
  } else {
    await resolveLocation();
  }
  restartPolling();
  setInterval(tick, 1000);
})();
