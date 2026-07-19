import { CONFIG } from '../config.js';
import { Radar, describeAircraft } from './radar.js';
import { fetchNearbyAircraft, lookupRoute } from './api.js';
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
// Rough total of sovereign countries, shown as the passport denominator.
const WORLD_COUNTRY_TOTAL = 195;

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
  passportCount: document.getElementById('passport-count'),
  passportList: document.getElementById('passport-list'),
  passportReset: document.getElementById('passport-reset'),
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
  labelCanvas: els.labelCanvas,
  onAppear: (b) => announce(b),
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

// ---- Passport: countries whose flights have crossed the radar ------------
//
// Every resolved route's origin/destination country is recorded, along with
// the specific flight that visited it. Stored in localStorage (schema v2) as:
//   {
//     v: 2,
//     countries: {
//       "GB": {
//         n: "United Kingdom",
//         c: 12,                 // total sightings -> drives map brightness
//         first: <ms>, last: <ms>,
//         flights: [             // specific flights, capped, newest last
//           { t, cs, reg, ty, op, md, role: 'o'|'d', from: 'LHR', to: 'JFK' }
//         ]
//       }
//     }
//   }
// The passport modal reads this to shade a world map (faint -> bright with
// more flights) and to list countries grouped by the day they were collected.

// Keep per-country flight history bounded so localStorage can't grow forever.
const MAX_FLIGHTS_PER_COUNTRY = 50;

function emptyPassport() {
  return { v: 2, countries: {} };
}

// Bring any older/legacy shape up to the current v2 schema.
function migratePassport(raw) {
  if (!raw || typeof raw !== 'object') return emptyPassport();
  if (raw.v === 2 && raw.countries && typeof raw.countries === 'object') {
    return raw;
  }
  // Legacy shape: { "GB": { c, n, t }, ... } keyed directly by ISO code. We
  // can't recover per-flight detail, but we preserve counts and last-seen so
  // the map brightness and day grouping stay meaningful.
  const countries = {};
  for (const [code, e] of Object.entries(raw)) {
    if (!e || typeof e !== 'object') continue;
    const iso = code.toUpperCase();
    if (!/^[A-Z]{2}$/.test(iso)) continue;
    const t = typeof e.t === 'number' ? e.t : Date.now();
    countries[iso] = {
      n: e.n || '',
      c: typeof e.c === 'number' ? e.c : 1,
      first: t,
      last: t,
      flights: [],
    };
  }
  return { v: 2, countries };
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
  const base = {
    t: Date.now(),
    cs: (aircraft && aircraft.callsign) || '',
    reg: (aircraft && aircraft.registration) || '',
    ty: (aircraft && aircraft.type) || '',
    op: (aircraft && aircraft.operator) || '',
    md: (aircraft && aircraft.model) || '',
    from: endpointCode(o),
    to: endpointCode(d),
  };
  let changed = false;
  if (o) changed = recordCountry(o.countryIso, o.countryName, { ...base, role: 'o' }) || changed;
  if (d) changed = recordCountry(d.countryIso, d.countryName, { ...base, role: 'd' }) || changed;
  if (changed) savePassport();
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
  if (c > 0) {
    const op = fillOpacityForCount(c);
    // The outline tracks the fill but stays a touch brighter and subtle.
    const strokeAlpha = Math.min(0.9, 0.18 + op * 0.6);
    return {
      stroke: true,
      color: `rgba(125, 255, 180, ${strokeAlpha.toFixed(3)})`,
      weight: 0.8,
      fill: true,
      fillColor: '#00ff78',
      fillOpacity: op,
    };
  }
  return { stroke: false, fill: true, fillColor: '#000000', fillOpacity: 0 };
}

let passportMap;
let passportGeoLayer;
let passportLandLayer;

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

// Refresh the count readout and the day-grouped country list.
function renderPassportStats() {
  const codes = Object.keys(passport.countries);
  els.passportCount.textContent = `${codes.length} / ${WORLD_COUNTRY_TOTAL} countries`;

  els.passportList.innerHTML = '';
  if (!codes.length) {
    const empty = document.createElement('p');
    empty.className = 'passport-empty';
    empty.textContent = 'No countries yet. Leave the radar running to collect them.';
    els.passportList.appendChild(empty);
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
      const chip = document.createElement('span');
      chip.className = 'passport-chip';
      const f = flagEmoji(c.iso);
      chip.textContent = `${f ? `${f} ` : ''}${c.name || c.iso} \u00b7 ${c.count}`;
      chip.title = flightsTitle(c.name || c.iso, c.flights, c.count);
      chips.appendChild(chip);
    }
    section.appendChild(chips);
    els.passportList.appendChild(section);
  }
}

async function openPassport() {
  els.passportModal.hidden = false;
  renderPassportStats();

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
    }).setView([25, 0], 1);
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
        }
        layer.bindTooltip(tip, { sticky: true });
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
  renderPassportStats();
  if (passportGeoLayer) passportGeoLayer.setStyle(styleForFeature);
}

function wirePassport() {
  els.passportBtn.addEventListener('click', openPassport);
  els.passportClose.addEventListener('click', closePassport);
  els.passportReset.addEventListener('click', () => {
    if (window.confirm('Clear every collected country? This cannot be undone.')) {
      resetPassport();
    }
  });
  els.passportModal.addEventListener('click', (e) => {
    if (e.target === els.passportModal) closePassport();
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
// render on cards and feed the passport.
function demoAirport(iata, icao, municipality, name, countryIso, countryName) {
  return { iata, icao, municipality, name, countryIso, countryName };
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
          origin: demoAirport('LHR', 'EGLL', 'London', 'Heathrow', 'GB', 'United Kingdom'),
          destination: demoAirport('JFK', 'KJFK', 'New York', 'John F Kennedy Intl', 'US', 'United States'),
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
          origin: demoAirport('DXB', 'OMDB', 'Dubai', 'Dubai Intl', 'AE', 'United Arab Emirates'),
          destination: demoAirport('LHR', 'EGLL', 'London', 'Heathrow', 'GB', 'United Kingdom'),
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
          origin: demoAirport('MIA', 'KMIA', 'Miami', 'Miami Intl', 'US', 'United States'),
          destination: demoAirport('BOS', 'KBOS', 'Boston', 'Logan Intl', 'US', 'United States'),
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
          origin: demoAirport('FRA', 'EDDF', 'Frankfurt', 'Frankfurt am Main', 'DE', 'Germany'),
          destination: demoAirport('LHR', 'EGLL', 'London', 'Heathrow', 'GB', 'United Kingdom'),
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
      // Pass the live position so the route API can confirm the route is
      // plausible for this contact (and reject a reused/aliased callsign).
      lookupRoute(a.callsign, a.lat, a.lon).then((route) => {
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
