// User-tweakable settings for the radar.
// Everything here runs in the browser; there is no backend.

export const CONFIG = {
  // Fallback location used when the browser blocks/denies geolocation.
  // Defaults to central London. Change to your own coordinates.
  fallback: {
    lat: 51.5074,
    lon: -0.1278,
    label: 'London (fallback)',
  },

  // Try to use the browser's Geolocation API first. If false (or if it
  // fails), we use `fallback` above.
  useGeolocation: true,

  // Radar range in nautical miles (the outer ring). airplanes.live caps
  // a single /point query at 250 nm. Kept tight so the scope shows aircraft
  // that are genuinely overhead rather than every plane transiting the wider
  // region.
  rangeNm: 5,

  // How often to poll for new aircraft positions, in milliseconds. This is the
  // *slowest* cadence, used at the widest range. As the range shrinks the poll
  // rate speeds up toward `minPollIntervalMs` because aircraft cross a
  // zoomed-in scope much faster (see `pollIntervalForRange` in main.js).
  // airplanes.live asks for <= 1 request/second, so keep this >= 1000.
  pollIntervalMs: 8000,

  // Fastest poll cadence, used at the tightest range. Kept comfortably above
  // the API's 1 request/second guidance.
  minPollIntervalMs: 2000,

  // Drop aircraft we haven't seen a position for in this many seconds.
  staleAfterSec: 30,

  // How long a blip's phosphor glow lingers after the sweep pings it, in
  // seconds. Higher keeps contacts visible further into the gap between
  // sweeps. Keep it below the sweep period (~8s) so blips still fade toward
  // dark before the arm comes back around, rather than glowing the whole time.
  blipPersistenceSec: 7,

  // Ignore aircraft whose last ADS-B position fix is older than this many
  // seconds. airplanes.live keeps returning contacts with stale positions
  // (`seen_pos`); without this filter the scope fills up with planes that
  // aren't actually overhead *right now*.
  maxSeenPosSec: 15,

  // Only show aircraft above this barometric altitude (feet). Aircraft on the
  // ground are always hidden regardless of this value.
  minAltFt: 500,

  // Only show aircraft moving at least this fast (knots ground speed). Filters
  // out parked/idling contacts so the scope only shows planes actually flying.
  minGroundSpeedKt: 40,

  // ---- Sound (opt-in) ------------------------------------------------------
  // Radar ping on sweep-cross, synthesized with the Web Audio API (no asset
  // files). Muted by default so it's strictly opt-in via the speaker button;
  // the choice is remembered.
  soundEnabled: false,

  // ---- Auto-recovery -------------------------------------------------------
  // When a poll fails, retry with exponential backoff up to this ceiling (ms)
  // instead of hammering the API, then snap back to `pollIntervalMs` on the
  // next success.
  maxBackoffMs: 60000,
  // Flag the "last updated" readout as stale once this many poll intervals
  // have elapsed without a successful refresh.
  staleAfterIntervals: 2.5,
};
