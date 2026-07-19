import { CONFIG } from "../config.js";

// Green phosphor radar renderer (vanilla canvas, no dependencies).
//
// Aircraft are plotted in polar coordinates using the distance/bearing that
// airplanes.live gives us relative to the center point. A sweep arm rotates
// continuously; when it passes over a blip the blip "pings" (flares bright)
// and its label (flight number + origin -> destination) shows, then both
// fade like real radar phosphor.

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// ---- Position interpolation (visual-only) ---------------------------------
// Blips are polled every few seconds; between ticks we lerp toward the latest
// fix and dead-reckon with ground speed + track so motion reads continuously.
// Polled `distanceNm` / `bearingDeg` stay the API truth for alerts and logging.

function lerpAngle(degA, degB, t) {
  const d = ((degB - degA + 540) % 360) - 180;
  return (degA + d * t + 360) % 360;
}

function polarToEnu(distanceNm, bearingDeg) {
  const rad = bearingDeg * DEG;
  return {
    e: distanceNm * Math.sin(rad),
    n: distanceNm * Math.cos(rad),
  };
}

function enuToPolar(e, n) {
  const distanceNm = Math.hypot(e, n);
  if (distanceNm < 1e-6) return { distanceNm: 0, bearingDeg: 0 };
  const bearingDeg = ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360;
  return { distanceNm, bearingDeg };
}

// Advance a center-relative polar position along a ground track for dt seconds.
function advancePolar(distanceNm, bearingDeg, trackDeg, speedKt, dtSec) {
  if (
    dtSec <= 0 ||
    typeof trackDeg !== "number" ||
    typeof speedKt !== "number" ||
    speedKt <= 0
  ) {
    return { distanceNm, bearingDeg };
  }
  const stepNm = speedKt * (dtSec / 3600);
  const tr = trackDeg * DEG;
  const { e, n } = polarToEnu(distanceNm, bearingDeg);
  return enuToPolar(e + Math.sin(tr) * stepNm, n + Math.cos(tr) * stepNm);
}

function interpolationActive() {
  if (!CONFIG.interpolationEnabled) return false;
  try {
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

// Cap the backing-store resolution on hi-DPI displays. A 3x phone or a Retina
// laptop paired with a slow GPU has to fill 9x/4x the pixels every frame, which
// is the usual cause of a choppy sweep. Rendering at up to 2x stays crisp while
// keeping the per-frame fill cost bounded on weaker hardware.
const MAX_DPR = 2;

// ---- Special-flight styling ----------------------------------------------
// Noteworthy contacts (emergency squawk, military, rare airframe) are drawn in
// a distinct colour and given a floor intensity so they linger and pulse
// between sweeps instead of fading out like ordinary traffic. Ordinary blips
// keep the classic green phosphor.
const PHOSPHOR_RGB = [150, 255, 190];

// ---- Phosphor trails -----------------------------------------------------
// Each contact keeps a short history of its plotted positions so we can draw a
// fading tail behind the blip, like the persistence smear on a real CRT scope.
// Positions arrive once per poll (every few seconds), so a handful of fixes
// spans a decent stretch of track without the tail growing unwieldy.
const TRAIL_MAX = 7;
// Peak opacity of the freshest trail segment (before the blip's sweep glow
// scales it down further). Additive blending and a soft bloom make this read
// as glowing phosphor rather than a flat line, so it stays subtle despite the
// modest value.
const TRAIL_ALPHA = 0.32;

function blipAccent(b) {
  const f = b.flags || {};
  if (f.emergency) {
    // Radio-failure reads amber; hijack/general-emergency read red.
    return f.emergency === "radio-failure"
      ? { rgb: [255, 190, 60], special: true }
      : { rgb: [255, 80, 80], special: true };
  }
  if (f.military) return { rgb: [255, 205, 70], special: true };
  if (f.rare) return { rgb: [120, 225, 255], special: true };
  return { rgb: PHOSPHOR_RGB, special: false };
}

function isSpecial(b) {
  const f = b.flags;
  return !!(f && (f.emergency || f.military || f.rare));
}

const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${a})`;

// Short uppercase tag shown at the top of a special contact's info card.
function specialTag(b) {
  const f = b.flags || {};
  if (f.emergency === "hijack") return "\u26a0 HIJACK";
  if (f.emergency === "radio-failure") return "\u26a0 NORDO";
  if (f.emergency) return "\u26a0 EMERGENCY";
  if (f.military) return "MILITARY";
  if (f.rare) return "RARE AIRCRAFT";
  return "";
}

// Turn an ISO 3166-1 alpha-2 country code (e.g. "GB") into its flag emoji by
// mapping each letter to its regional-indicator symbol. Returns '' for
// anything that isn't a valid two-letter code.
function flagEmoji(iso) {
  if (typeof iso !== "string" || iso.length !== 2) return "";
  const code = iso.toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";
  const base = 0x1f1e6; // regional indicator 'A'
  return String.fromCodePoint(
    base + (code.charCodeAt(0) - 65),
    base + (code.charCodeAt(1) - 65),
  );
}

const FONT_STACK =
  "'Share Tech Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const LABEL_FONT = `11px ${FONT_STACK}`;
const LABEL_FONT_BOLD = `bold 11px ${FONT_STACK}`;
// Smaller font for the route connector arrow so it reads as a thin link
// between the two airports rather than a full-weight line of text.
const LABEL_FONT_SMALL = `9px ${FONT_STACK}`;

// Vertical space each card line occupies. The connector arrow gets a much
// shorter slot so a centered "\u2193" between origin and destination barely
// adds any height compared with a full text line.
const LINE_H = 13;
const CONNECTOR_H = 9;
// Horizontal inner padding. Vertical padding is split evenly top and bottom so
// the block of centered lines sits symmetrically within the card border.
const CARD_PAD = 4;
const CARD_PAD_Y = 2;

// Pick the font for a card line based on its role.
function fontForLine(l) {
  if (l.connector) return LABEL_FONT_SMALL;
  return l.bold ? LABEL_FONT_BOLD : LABEL_FONT;
}

// Corporate suffixes/abbreviations that should stay fully upper-cased when we
// title-case an operator name (e.g. "acme leasing llc" -> "Acme Leasing LLC").
const OPERATOR_ACRONYMS = new Set([
  "LLC",
  "INC",
  "LTD",
  "PLC",
  "LLP",
  "LP",
  "PTY",
  "PTE",
  "CO",
  "CORP",
  "DAC",
  "AG",
  "SA",
  "SAS",
  "NV",
  "BV",
  "AB",
  "AS",
  "ASA",
  "OY",
  "KG",
  "DBA",
  "USA",
  "UK",
  "US",
  "UAE",
]);

// Raw operator/owner strings from airplanes.live arrive in mixed casing, often
// shouting in all-caps ("CAIQUEN LEASING LLC"). Title-case them for a calmer
// look on the wall display, but keep known corporate acronyms upper-cased.
function formatOperator(name) {
  return name
    .toLowerCase()
    .split(/\s+/)
    .map((word) => {
      const bare = word.replace(/[.,]/g, "");
      if (OPERATOR_ACRONYMS.has(bare.toUpperCase())) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

// Format one end of a route as "<flag> City (CODE)" so the place name reads
// clearly on a wall display, falling back to just the code (and dropping the
// flag) when we don't have a city name or a valid country code.
function formatAirport(ap) {
  const flag = flagEmoji(ap.countryIso);
  const code = ap.iata || ap.icao || "???";
  const place = ap.municipality || ap.name;
  const label = place ? `${place} (${code})` : code;
  return flag ? `${flag} ${label}` : label;
}

// Distance (nautical miles) at which the depth cue reaches full strength.
// The size/dimming falloff is based on a contact's *absolute* distance rather
// than its position within the current range, so a plane 2 nm away looks close
// whether the scope is set to 2 nm or 50 nm. At a tight range every contact is
// genuinely nearby and stays full size/brightness; only genuinely distant
// aircraft (approaching this many nm) shrink and dim.
const DEPTH_FULL_NM = 40;

// Vertical rates below this magnitude (ft/min) read as level flight rather
// than a climb or descent, so small sensor noise doesn't flip the arrow.
const LEVEL_FLIGHT_FPM = 100;

// Format altitude with a climb/descent indicator, e.g. "33,000 ft \u25b2".
// Returns '' when we have no altitude to show.
function formatAltitude(altFt, verticalRateFpm) {
  if (typeof altFt !== "number") return "";
  let arrow = "";
  if (typeof verticalRateFpm === "number") {
    if (verticalRateFpm > LEVEL_FLIGHT_FPM)
      arrow = " \u25b2"; // climbing
    else if (verticalRateFpm < -LEVEL_FLIGHT_FPM) arrow = " \u25bc"; // descending
  }
  return `${altFt.toLocaleString("en-US")} ft${arrow}`;
}

// ---- Screen-reader speech ------------------------------------------------
//
// The scope is painted on a <canvas>, which is invisible to assistive tech, so
// we build a plain-language sentence describing each contact. It carries the
// same facts as the on-screen card (flight id, airline, type, altitude, route)
// plus the polar position spoken as distance and a compass direction, so a
// screen-reader user gets an equivalent picture of what just appeared.

// 16-point compass names indexed by bearing (0 = North, clockwise).
const COMPASS_16 = [
  "north",
  "north-northeast",
  "northeast",
  "east-northeast",
  "east",
  "east-southeast",
  "southeast",
  "south-southeast",
  "south",
  "south-southwest",
  "southwest",
  "west-southwest",
  "west",
  "west-northwest",
  "northwest",
  "north-northwest",
];

// Turn a bearing/track in degrees into a spoken compass direction.
function compassDir(deg) {
  if (typeof deg !== "number" || Number.isNaN(deg)) return "";
  const i = Math.round(deg / 22.5);
  return COMPASS_16[((i % 16) + 16) % 16];
}

// Human-readable size bucket; 'medium' is left unspoken to keep sentences short.
const SIZE_SPEECH = { light: "light aircraft", heavy: "heavy aircraft" };

// Altitude phrase with a spoken climb/descent state, e.g.
// "at 33,000 feet, climbing". Returns '' when altitude is unknown.
function altitudeSpeech(altFt, verticalRateFpm) {
  if (typeof altFt !== "number") return "";
  let motion = "";
  if (typeof verticalRateFpm === "number") {
    if (verticalRateFpm > LEVEL_FLIGHT_FPM) motion = ", climbing";
    else if (verticalRateFpm < -LEVEL_FLIGHT_FPM) motion = ", descending";
  }
  return `at ${altFt.toLocaleString("en-US")} feet${motion}`;
}

// One end of a route as spoken text, e.g. "London (LHR), United Kingdom".
// Skips the flag emoji used on the visual card (screen readers announce those
// awkwardly) and prefers a readable place name plus airport code.
function airportSpeech(ap) {
  if (!ap) return "";
  const code = ap.iata || ap.icao || "";
  const place = ap.municipality || ap.name || code || "unknown location";
  const country = ap.countryName ? `, ${ap.countryName}` : "";
  return code && place !== code
    ? `${place} (${code})${country}`
    : `${place}${country}`;
}

// Build the full spoken description of a contact. Fields are omitted when
// unknown so the sentence stays natural rather than reading "unknown" a lot.
export function describeAircraft(b) {
  const parts = [];

  // Identity: prefer "<airline> flight <callsign>", falling back through the
  // callsign, registration, and finally the raw ADS-B hex.
  const callsign = (b.callsign || "").trim();
  // Prefer an explicit airline name from the route; otherwise use the
  // operator/owner from the positions feed (the route API gives only a code).
  const airlineName =
    (b.route && b.route.airline) ||
    (b.operator ? formatOperator(b.operator) : "");
  if (airlineName && callsign) {
    parts.push(`${airlineName} flight ${callsign}`);
  } else if (callsign) {
    parts.push(`Flight ${callsign}`);
  } else if (b.registration) {
    parts.push(`Aircraft ${b.registration}`);
  } else {
    parts.push(`Aircraft ${(b.hex || "").toUpperCase()}`);
  }

  // Noteworthy status, spoken up front so it isn't buried mid-sentence.
  const f = b.flags || {};
  if (f.emergency === "hijack") parts.push("squawking hijack");
  else if (f.emergency === "radio-failure")
    parts.push("squawking radio failure");
  else if (f.emergency) parts.push("squawking emergency");
  if (f.military) parts.push("military");
  else if (f.rare) parts.push("rare aircraft");

  // Type / size. For a helicopter, "helicopter" is more useful than a size
  // bucket, so it replaces the size descriptor.
  const model = b.model || b.type;
  const size = b.isRotor ? "helicopter" : SIZE_SPEECH[b.sizeClass];
  if (model && size) parts.push(`${model}, ${size}`);
  else if (model) parts.push(model);
  else if (size) parts.push(size);

  const alt = altitudeSpeech(b.altFt, b.verticalRateFpm);
  if (alt) parts.push(alt);

  // Polar position relative to the radar center.
  if (typeof b.distanceNm === "number" && typeof b.bearingDeg === "number") {
    const dist =
      b.distanceNm < 10
        ? b.distanceNm.toFixed(1)
        : String(Math.round(b.distanceNm));
    const dir = compassDir(b.bearingDeg);
    parts.push(`${dist} nautical miles to the ${dir}`);
  }

  if (typeof b.trackDeg === "number")
    parts.push(`heading ${compassDir(b.trackDeg)}`);
  if (typeof b.groundSpeedKt === "number")
    parts.push(`ground speed ${Math.round(b.groundSpeedKt)} knots`);

  // Route when known, otherwise the operator so the description isn't bare.
  if (b.route && b.route.origin && b.route.destination) {
    parts.push(
      `travelling from ${airportSpeech(b.route.origin)} to ${airportSpeech(b.route.destination)}`,
    );
  } else if (b.operator) {
    parts.push(`operated by ${formatOperator(b.operator)}`);
  }

  return `${parts.join(", ")}.`;
}

export class Radar {
  constructor(
    canvas,
    {
      rangeNm = 100,
      sweepPeriodSec = 8,
      persistenceSec = 6,
      labelCanvas = null,
      onAppear = null,
      onPing = null,
      onFocusChange = null,
    } = {},
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    // Optional separate canvas for the info cards. It lives above the circular
    // CRT mask and its overlays so cards are never clipped or dimmed. Falls
    // back to drawing labels on the main canvas when not provided.
    this.labelCanvas = labelCanvas;
    this.lctx = labelCanvas ? labelCanvas.getContext("2d") : null;
    this.rangeNm = rangeNm;
    this.sweepPeriodSec = sweepPeriodSec;
    this.persistenceSec = persistenceSec;
    // Called once, with the blip, the first time a contact appears on the scope
    // (i.e. the sweep flares it after its data is ready). Used to feed the
    // screen-reader live region so appearances are announced.
    this.onAppear = typeof onAppear === "function" ? onAppear : null;
    // Called with the blip each time the sweep passes over a ready contact.
    // Drives the opt-in radar "ping" sound effect.
    this.onPing = typeof onPing === "function" ? onPing : null;
    // Called with the focused blip when the user taps a contact to focus it,
    // and with null when focus is cleared (exit button, tapping empty scope,
    // or the contact leaving range). Drives the focus-mode UI in the page.
    this.onFocusChange =
      typeof onFocusChange === "function" ? onFocusChange : null;

    // Hex of the contact the user has "locked on". When set, only that contact
    // is drawn (everything else is hidden) and a bearing needle points to it.
    this.focusedHex = null;

    // Expected poll cadence (ms), used to time segment lerps when we don't yet
    // have two fixes. Updated by main.js when range or poll delay changes.
    this.expectedPollMs = CONFIG.pollIntervalMs;

    /** @type {Map<string, object>} keyed by aircraft hex */
    this.blips = new Map();

    // Static airport overlay drawn beneath the traffic: a subtle "map" of the
    // large/medium airports within range, each already annotated with its
    // polar position relative to the center (distanceNm + bearingDeg). Set via
    // setAirports() when the center or range changes; empty by default.
    /** @type {Array<object>} */
    this.airports = [];

    this.sweepAngle = 0; // radians, 0 = North, clockwise
    this.prevSweepAngle = 0;
    this.lastFrame = 0;
    // `running` is the caller's intent (start/stop). The loop only actually
    // animates when it's also on screen and the tab is visible, so a scope
    // scrolled out of view or a backgrounded tab stops burning frame budget
    // (which is what made scrolling janky while lots of contacts were lit).
    this.running = false;
    this._looping = false; // is a rAF currently scheduled/executing?
    this._docVisible = document.visibilityState !== "hidden";
    this._onScreen = true; // corrected immediately by the IntersectionObserver
    // Shared 0..1 oscillator used to pulse special contacts in unison.
    this.pulse = 0;

    this._resize = this._resize.bind(this);
    this._frame = this._frame.bind(this);
    window.addEventListener("resize", this._resize);
    this._resize();

    // Pause when the tab is hidden.
    this._onVisibility = () => {
      this._docVisible = document.visibilityState !== "hidden";
      this._maybeRun();
    };
    document.addEventListener("visibilitychange", this._onVisibility);

    // Pause when the scope is scrolled off screen. Falls back to always-on
    // when IntersectionObserver isn't available.
    if (typeof IntersectionObserver === "function") {
      this._io = new IntersectionObserver((entries) => {
        this._onScreen = entries.some((e) => e.isIntersecting);
        this._maybeRun();
      });
      this._io.observe(this.canvas);
    }

    // Tap/click a contact to focus it; tap empty space to exit. A hover pass
    // swaps the cursor to a pointer over a contact so it's obvious blips are
    // interactive.
    this._onClick = this._onClick.bind(this);
    this._onMove = this._onMove.bind(this);
    this.canvas.style.cursor = "crosshair";
    this.canvas.addEventListener("click", this._onClick);
    this.canvas.addEventListener("mousemove", this._onMove);
  }

  setRange(nm) {
    this.rangeNm = nm;
  }

  /** Hint the expected poll interval so segment lerps time correctly. */
  setExpectedPollInterval(ms) {
    if (typeof ms === "number" && ms > 0) this.expectedPollMs = ms;
  }

  // Display position for drawing / hit-testing (interpolated when enabled).
  _displayPos(b) {
    if (!b) return { d: 0, bearing: 0 };
    return {
      d: b.displayDistanceNm ?? b.distanceNm,
      bearing: b.displayBearingDeg ?? b.bearingDeg,
    };
  }

  // Seed or advance interpolation state when a polled fix arrives.
  _seedInterpolation(existing, a, now) {
    const d = a.distanceNm;
    const brg = a.bearingDeg;
    if (!existing) {
      return {
        fixDistanceNm: d,
        fixBearingDeg: brg,
        fixAtMs: now,
        prevDistanceNm: d,
        prevBearingDeg: brg,
        prevFixAtMs: now,
        displayDistanceNm: d,
        displayBearingDeg: brg,
      };
    }
    const hadFix =
      typeof existing.fixDistanceNm === "number" &&
      typeof existing.fixBearingDeg === "number";
    const moved =
      hadFix &&
      (existing.fixDistanceNm !== d || existing.fixBearingDeg !== brg);
    const state = {
      fixDistanceNm: d,
      fixBearingDeg: brg,
      fixAtMs: now,
      displayDistanceNm: existing.displayDistanceNm ?? d,
      displayBearingDeg: existing.displayBearingDeg ?? brg,
    };
    if (moved) {
      state.prevDistanceNm = existing.fixDistanceNm;
      state.prevBearingDeg = existing.fixBearingDeg;
      state.prevFixAtMs = existing.fixAtMs ?? now;
    } else {
      state.prevDistanceNm = existing.prevDistanceNm ?? d;
      state.prevBearingDeg = existing.prevBearingDeg ?? brg;
      state.prevFixAtMs = existing.prevFixAtMs ?? now;
    }
    return state;
  }

  // Per-frame visual position: segment lerp between fixes, then dead reckoning.
  _updateInterpolatedPositions(dt) {
    if (!interpolationActive()) {
      for (const b of this.blips.values()) {
        b.displayDistanceNm = b.fixDistanceNm ?? b.distanceNm;
        b.displayBearingDeg = b.fixBearingDeg ?? b.bearingDeg;
      }
      return;
    }

    const now = performance.now();
    const maxExtrap = CONFIG.interpolationMaxExtrapolateSec;
    const tau = CONFIG.interpolationCorrectionTauSec;
    const strength = Math.min(
      1,
      Math.max(0, CONFIG.interpolationStrength ?? 1),
    );
    const ease = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;

    for (const b of this.blips.values()) {
      const fixD = b.fixDistanceNm ?? b.distanceNm;
      const fixB = b.fixBearingDeg ?? b.bearingDeg;
      const fixAt = b.fixAtMs ?? now;
      const prevD = b.prevDistanceNm ?? fixD;
      const prevB = b.prevBearingDeg ?? fixB;
      const prevAt = b.prevFixAtMs ?? fixAt;

      let targetD = fixD;
      let targetB = fixB;

      const segMs = fixAt - prevAt;
      const segSec = segMs > 50 ? segMs / 1000 : this.expectedPollMs / 1000;
      const moved = prevD !== fixD || prevB !== fixB;

      if (moved && segMs > 50) {
        const t = Math.min(1, (now - prevAt) / 1000 / segSec);
        if (t < 1) {
          targetD = prevD + (fixD - prevD) * t;
          targetB = lerpAngle(prevB, fixB, t);
        } else {
          const extrapSec = Math.min(
            maxExtrap,
            Math.max(0, (now - fixAt) / 1000),
          );
          const adv = advancePolar(
            fixD,
            fixB,
            b.trackDeg,
            b.groundSpeedKt,
            extrapSec,
          );
          targetD = adv.distanceNm;
          targetB = adv.bearingDeg;
        }
      } else {
        const extrapSec = Math.min(
          maxExtrap,
          Math.max(0, (now - fixAt) / 1000),
        );
        const adv = advancePolar(
          fixD,
          fixB,
          b.trackDeg,
          b.groundSpeedKt,
          extrapSec,
        );
        targetD = adv.distanceNm;
        targetB = adv.bearingDeg;
      }

      // Pull the target back toward the last polled fix so motion stays
      // stepped and radar-like rather than a continuous glide.
      if (strength < 1) {
        targetD = fixD + (targetD - fixD) * strength;
        targetB = lerpAngle(fixB, targetB, strength);
      }

      const dispD = b.displayDistanceNm ?? fixD;
      const dispB = b.displayBearingDeg ?? fixB;
      b.displayDistanceNm = dispD + (targetD - dispD) * ease;
      b.displayBearingDeg = lerpAngle(dispB, targetB, ease);
    }
  }

  /**
   * Replace the airport overlay set. Each entry needs `distanceNm` and
   * `bearingDeg` (relative to the center) plus a display `iata`/`icao` code and
   * a `kind` ('L' large | 'M' medium). Pass [] to clear.
   */
  setAirports(list) {
    this.airports = Array.isArray(list) ? list : [];
  }

  /** Force a canvas resize (e.g. after toggling fullscreen layout). */
  resize() {
    this._resize();
  }

  /** Remove all tracked contacts (e.g. when the range changes). */
  clear() {
    this.blips.clear();
  }

  // ---- Focus mode --------------------------------------------------------
  // Lock the scope onto a single contact: everything else is hidden and a
  // bearing needle points to it, so the user can track one aircraft. Focus is
  // released automatically once the contact leaves range (see _frame).

  /** The currently focused blip, or null when not in focus mode. */
  get focused() {
    return this.focusedHex != null
      ? this.blips.get(this.focusedHex) || null
      : null;
  }

  /** Focus a contact by hex. No-op if the contact isn't currently tracked. */
  focus(hex) {
    const b = this.blips.get(hex);
    if (!b || this.focusedHex === hex) return;
    this.focusedHex = hex;
    this._emitFocus(b);
  }

  /** Leave focus mode. Safe to call when not focused. */
  clearFocus() {
    if (this.focusedHex == null) return;
    this.focusedHex = null;
    this._emitFocus(null);
  }

  _emitFocus(b) {
    if (!this.onFocusChange) return;
    try {
      this.onFocusChange(b);
    } catch {
      /* never let a listener break the render loop */
    }
  }

  // Map a client (mouse/touch) coordinate to the canvas's logical coordinate
  // space (CSS pixels, matching `this.size`), independent of DPR scaling.
  _clientToCanvas(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * this.size;
    const y = ((clientY - rect.top) / rect.height) * this.size;
    return { x, y };
  }

  // Return the ready contact nearest to a canvas coordinate within a small
  // tap radius, or null. Uses the same polar->cartesian mapping as _drawBlips
  // so the hit target lines up with what's drawn.
  _blipAt(clientX, clientY) {
    const { x, y } = this._clientToCanvas(clientX, clientY);
    const cx = this.size / 2;
    const cy = this.size / 2;
    const R = this.size / 2 - 22;
    const HIT_R = 20; // generous so small blips are easy to tap
    let best = null;
    let bestD2 = HIT_R * HIT_R;
    for (const b of this.blips.values()) {
      if (!this._isReady(b)) continue;
      const { d, bearing } = this._displayPos(b);
      const rr = Math.min(1, Math.max(0, d / this.rangeNm)) * R;
      const rad = bearing * DEG;
      const bx = cx + Math.sin(rad) * rr;
      const by = cy - Math.cos(rad) * rr;
      const d2 = (bx - x) ** 2 + (by - y) ** 2;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = b;
      }
    }
    return best;
  }

  _onClick(e) {
    const b = this._blipAt(e.clientX, e.clientY);
    // Tapping the already-focused contact toggles focus back off; tapping a
    // different contact switches to it; tapping empty scope exits.
    if (b && b.hex === this.focusedHex) this.clearFocus();
    else if (b) this.focus(b.hex);
    else this.clearFocus();
  }

  _onMove(e) {
    const b = this._blipAt(e.clientX, e.clientY);
    this.canvas.style.cursor = b
      ? "pointer"
      : this.focusedHex != null
        ? "default"
        : "crosshair";
  }

  /**
   * Merge a fresh list of aircraft into the blip set, preserving each blip's
   * current phosphor intensity so updates don't cause a visual reset.
   */
  update(aircraft) {
    const now = performance.now();
    for (const a of aircraft) {
      if (a.distanceNm == null || a.bearingDeg == null) continue;
      if (a.distanceNm > this.rangeNm) continue;
      const existing = this.blips.get(a.hex);
      const interp = this._seedInterpolation(existing, a, now);
      this.blips.set(a.hex, {
        ...a,
        ...interp,
        intensity: existing ? existing.intensity : 0,
        labelAlpha: existing ? existing.labelAlpha : 0,
        // Rolling history of plotted positions (polar, relative to center) for
        // the phosphor trail. Carried across updates and extended with the new
        // fix; a stationary/duplicate report doesn't add a point.
        trail: this._extendTrail(existing, a),
        // Preserve async-resolved route across position updates.
        route: existing ? existing.route : undefined,
        // A blip stays hidden until its route lookup has settled (found a
        // route or confirmed there is none), so it only appears once all its
        // info is ready. These flags are preserved so an in-flight lookup
        // isn't restarted, and a resolved blip doesn't revert to hidden.
        routeResolved: existing ? existing.routeResolved === true : false,
        routePending: existing ? existing.routePending === true : false,
        // Preserve the "already announced to screen readers" flag so a contact
        // is spoken once on appearance, not re-announced on every poll. It
        // resets naturally when a blip is pruned and later re-enters as a new
        // object.
        announced: existing ? existing.announced === true : false,
        lastUpdate: now,
      });
    }
  }

  // Extend a contact's position history with its latest fix, capped at
  // TRAIL_MAX. Stored in polar form (distance nm + bearing deg) so it maps to
  // the scope exactly the way the blip itself is plotted, and skips repeats so
  // a plane holding position doesn't pile up identical points.
  _extendTrail(existing, a) {
    const trail =
      existing && Array.isArray(existing.trail) ? existing.trail.slice() : [];
    const last = trail[trail.length - 1];
    if (!last || last.d !== a.distanceNm || last.b !== a.bearingDeg) {
      trail.push({ d: a.distanceNm, b: a.bearingDeg });
      if (trail.length > TRAIL_MAX) trail.shift();
    }
    return trail;
  }

  /** Remove blips we haven't heard about in `staleAfterSec`. */
  prune(staleAfterSec) {
    const cutoff = performance.now() - staleAfterSec * 1000;
    for (const [hex, b] of this.blips) {
      if (b.lastUpdate < cutoff) this.blips.delete(hex);
    }
  }

  start() {
    this.running = true;
    this._maybeRun();
  }

  stop() {
    this.running = false;
  }

  // The loop should animate only when the caller wants it running AND the
  // scope is visible (on screen and in a foregrounded tab).
  _shouldAnimate() {
    return this.running && this._docVisible && this._onScreen;
  }

  // Kick the render loop if it should be animating and isn't already. Resets
  // the frame clock so the first frame after a pause doesn't jump the sweep.
  _maybeRun() {
    if (this._looping || !this._shouldAnimate()) return;
    this._looping = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this._frame);
  }

  _resize() {
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    const size = Math.max(1, Math.min(rect.width, rect.height));
    this.canvas.width = Math.round(size * dpr);
    this.canvas.height = Math.round(size * dpr);
    // Keep the label layer pixel-for-pixel aligned with the radar canvas so
    // card coordinates map directly between the two.
    if (this.labelCanvas) {
      this.labelCanvas.width = Math.round(size * dpr);
      this.labelCanvas.height = Math.round(size * dpr);
    }
    this.dpr = dpr;
    this.size = size;
    // The background gradient is expensive to build and only depends on the
    // canvas size, so it's cached between frames and rebuilt only on resize.
    this._bgGrad = null;
  }

  _frame(ts) {
    if (!this._shouldAnimate()) {
      this._looping = false;
      return;
    }
    const dt = Math.min(0.1, (ts - this.lastFrame) / 1000);
    this.lastFrame = ts;

    // ~0.8 Hz pulse shared by all special contacts.
    this.pulse = 0.5 + 0.5 * Math.sin((ts / 1000) * TAU * 0.8);

    this.prevSweepAngle = this.sweepAngle;
    this.sweepAngle =
      (this.sweepAngle + (TAU / this.sweepPeriodSec) * dt) % TAU;

    // Drop focus the moment the locked contact leaves the scope: it's been
    // pruned (out of range / stale) or has drifted beyond the outer ring.
    if (this.focusedHex != null) {
      const f = this.blips.get(this.focusedHex);
      if (!f || f.distanceNm > this.rangeNm) this.clearFocus();
    }

    this._updateInterpolatedPositions(dt);
    this._pingCrossed();
    this._decay(dt);
    this._draw();

    requestAnimationFrame(this._frame);
  }

  // A blip is only drawn once its route lookup has settled, so the label is
  // complete the moment it first flares rather than starting as a dash.
  _isReady(b) {
    return b.routeResolved === true;
  }

  // Flare any blip the sweep passed over since last frame.
  _pingCrossed() {
    const from = this.prevSweepAngle;
    const to = this.sweepAngle;
    const wrapped = to < from; // sweep crossed the 0 (North) seam
    for (const b of this.blips.values()) {
      if (!this._isReady(b)) continue;
      const { bearing } = this._displayPos(b);
      const ang = (bearing * DEG) % TAU;
      const crossed = wrapped
        ? ang > from || ang <= to
        : ang > from && ang <= to;
      if (crossed) {
        b.intensity = 1;
        b.labelAlpha = 1;
        // The sweep just illuminated a contact: ping (opt-in SFX). Guarded by
        // a try/catch so a listener can never break the render loop. In focus
        // mode only the locked contact pings, so hidden traffic stays silent.
        if (
          this.onPing &&
          (this.focusedHex == null || b.hex === this.focusedHex)
        ) {
          try {
            this.onPing(b);
          } catch {
            /* ignore */
          }
        }
        // First time the sweep lights this contact up: it has now "appeared"
        // on the scope for a sighted user, so announce it for screen readers.
        if (!b.announced) {
          b.announced = true;
          if (this.onAppear) {
            try {
              this.onAppear(b);
            } catch {
              /* never let a listener break the render loop */
            }
          }
        }
      }
    }
  }

  _decay(dt) {
    const k = dt / this.persistenceSec;
    for (const b of this.blips.values()) {
      // The focused contact stays fully lit (blip + label) between sweeps so it
      // never fades out while the user is tracking it.
      if (this.focusedHex === b.hex) {
        b.intensity = 1;
        b.labelAlpha = 1;
        continue;
      }
      // Special contacts never fade all the way out: they hold a floor glow
      // (and keep their label up) so they stay conspicuous and pulse between
      // sweeps. Ordinary traffic decays to nothing as before.
      const special = isSpecial(b);
      const glowFloor = special ? 0.45 : 0;
      const labelFloor = special ? 0.6 : 0;
      b.intensity = Math.max(glowFloor, b.intensity - k);
      // Labels linger a touch longer than the blip glow.
      b.labelAlpha = Math.max(labelFloor, b.labelAlpha - k * 0.7);
    }
  }

  _draw() {
    const { ctx, lctx, size, dpr } = this;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const R = size / 2 - 22; // leave margin for range labels

    this._drawBackground(ctx, cx, cy, R);
    this._drawGrid(ctx, cx, cy, R);
    this._drawAirports(ctx, cx, cy, R);
    this._drawSweep(ctx, cx, cy, R);
    this._drawFocus(ctx, cx, cy, R);
    this._drawBlips(ctx, cx, cy, R);
    this._drawCenter(ctx, cx, cy);

    ctx.restore();

    // Info cards render on the dedicated overlay layer (above the circular CRT
    // mask and its scanline/glare overlays) when one is available, so they are
    // never clipped by the round edge or dimmed by the tube effects. When no
    // overlay exists they were already drawn on the main canvas above.
    if (lctx) {
      lctx.save();
      lctx.scale(dpr, dpr);
      lctx.clearRect(0, 0, size, size);
      this._drawLabels(lctx, cx, cy, R);
      lctx.restore();
    }
  }

  _drawBackground(ctx, cx, cy, R) {
    // Reuse the gradient across frames; it only changes when the canvas is
    // resized (which clears the cache in _resize).
    let g = this._bgGrad;
    if (!g) {
      g = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R);
      g.addColorStop(0, "rgba(9, 40, 20, 0.95)");
      g.addColorStop(1, "rgba(3, 15, 8, 0.98)");
      this._bgGrad = g;
    }
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fillStyle = g;
    ctx.fill();
  }

  _drawGrid(ctx, cx, cy, R) {
    ctx.strokeStyle = "rgba(0, 255, 120, 0.36)";
    ctx.fillStyle = "rgba(0, 255, 120, 0.65)";
    ctx.lineWidth = 1;
    ctx.font = `11px ${FONT_STACK}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    // Concentric range rings (4 rings) with nm labels.
    const rings = 4;
    for (let i = 1; i <= rings; i++) {
      const rr = (R * i) / rings;
      ctx.globalAlpha = i === rings ? 0.7 : 0.36;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 0.75;
      const nm = Math.round((this.rangeNm * i) / rings);
      ctx.fillText(`${nm}`, cx + 4, cy - rr);
    }
    ctx.globalAlpha = 1;

    // Cardinal spokes.
    ctx.strokeStyle = "rgba(0, 255, 120, 0.24)";
    for (let a = 0; a < 360; a += 30) {
      const rad = a * DEG;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.sin(rad) * R, cy - Math.cos(rad) * R);
      ctx.stroke();
    }

    // Compass labels.
    ctx.fillStyle = "rgba(0, 255, 120, 0.8)";
    ctx.font = `bold 13px ${FONT_STACK}`;
    ctx.textAlign = "center";
    const marks = [
      ["N", 0],
      ["E", 90],
      ["S", 180],
      ["W", 270],
    ];
    for (const [label, deg] of marks) {
      const rad = deg * DEG;
      const lx = cx + Math.sin(rad) * (R + 12);
      const ly = cy - Math.cos(rad) * (R + 12);
      ctx.fillText(label, lx, ly);
    }
  }

  // Subtle airport overlay: a simple aerodrome icon (a small circle with a
  // runway strip) at each airport's polar position, with a faint code label on
  // the nearest few so the map doesn't get cluttered. Drawn between the grid
  // and the sweep so it reads as part of the dim "map" beneath the traffic, and
  // the sweep wedge glides over it like a real PPI scope. Deliberately
  // low-contrast so it never competes with the aircraft blips.
  _drawAirports(ctx, cx, cy, R) {
    // Hidden in focus mode so nothing competes with the tracked contact.
    if (this.focusedHex != null) return;
    const list = this.airports;
    if (!list || list.length === 0) return;

    // Only the nearest handful get a text label; the rest are markers only.
    const LABEL_MAX = 7;
    // Airports just beyond the range are drawn a touch outside the outer ring
    // to make clear they're off-scope; cap the radius so an icon never spills
    // past the round tube edge.
    const maxR = cx - 3;

    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `9px ${FONT_STACK}`;

    for (let i = 0; i < list.length; i++) {
      const ap = list[i];
      if (
        typeof ap.distanceNm !== "number" ||
        typeof ap.bearingDeg !== "number"
      )
        continue;
      // Un-clamped radius so airports past the range sit beyond the outer ring.
      const rr = Math.max(0, ap.distanceNm / this.rangeNm) * R;
      if (rr > maxR) continue; // too far outside to show without clipping
      const rad = ap.bearingDeg * DEG;
      const x = cx + Math.sin(rad) * rr;
      const y = cy - Math.cos(rad) * rr;

      const outside = ap.distanceNm > this.rangeNm;
      const large = ap.kind === "L";
      const iconR = large ? 4.5 : 3.2;
      // Outside-range airports are dimmer so they read as "just off the scope".
      const alpha = (large ? 0.4 : 0.26) * (outside ? 0.6 : 1);

      // Simple aerodrome symbol: a small circle. In-range airports get a solid
      // ring plus a runway strip; outside-range ones get a dashed ring and no
      // strip, so it's obvious at a glance they aren't within your radar.
      ctx.strokeStyle = `rgba(0, 255, 120, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.setLineDash(outside ? [2, 2] : []);
      ctx.beginPath();
      ctx.arc(x, y, iconR, 0, TAU);
      ctx.stroke();
      if (!outside) {
        const rw = iconR + 2;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(x - rw * 0.7, y + rw * 0.7);
        ctx.lineTo(x + rw * 0.7, y - rw * 0.7);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      const code = ap.iata || ap.icao;
      if (code && i < LABEL_MAX) {
        ctx.fillStyle = `rgba(0, 255, 120, ${(large ? 0.5 : 0.34) * (outside ? 0.6 : 1)})`;
        ctx.fillText(code, x + iconR + 4, y);
      }
    }

    ctx.restore();
  }

  _drawSweep(ctx, cx, cy, R) {
    // Afterglow wedge trailing behind the leading edge.
    const trail = 0.5; // radians of glowing trail
    const steps = 24;
    for (let i = 0; i < steps; i++) {
      const a0 = this.sweepAngle - (trail * i) / steps;
      const a1 = this.sweepAngle - (trail * (i + 1)) / steps;
      const alpha = 0.2 * (1 - i / steps);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      // canvas angles: measured from +x axis, clockwise-positive with y-down.
      ctx.arc(cx, cy, R, a0 - Math.PI / 2, a1 - Math.PI / 2, true);
      ctx.closePath();
      ctx.fillStyle = `rgba(0, 255, 120, ${alpha})`;
      ctx.fill();
    }

    // Leading edge line.
    const ex = cx + Math.sin(this.sweepAngle) * R;
    const ey = cy - Math.cos(this.sweepAngle) * R;
    const grad = ctx.createLinearGradient(cx, cy, ex, ey);
    grad.addColorStop(0, "rgba(0, 255, 120, 0.1)");
    grad.addColorStop(1, "rgba(120, 255, 180, 0.9)");
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }

  // Focus-mode overlay: a bright bearing needle from the center out to the
  // outer ring pointing at the locked contact, a dashed ring at its current
  // distance, and a bearing readout at the tip. Drawn beneath the blip so the
  // aircraft icon and its reticle sit on top.
  _drawFocus(ctx, cx, cy, R) {
    const b = this.focused;
    if (!b) return;
    const { d, bearing } = this._displayPos(b);
    if (typeof bearing !== "number") return;

    // The expected flight path (origin behind, destination ahead) sits beneath
    // the bearing needle and the blip.
    this._drawFocusRoute(ctx, cx, cy, R);

    const rad = bearing * DEG;
    const dirX = Math.sin(rad);
    const dirY = -Math.cos(rad);
    const tipX = cx + dirX * R;
    const tipY = cy + dirY * R;
    const accent = [150, 255, 190];

    ctx.save();

    // Dashed range ring at the contact's current distance.
    const rr = Math.min(1, Math.max(0, d / this.rangeNm)) * R;
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = rgba(accent, 0.3);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);

    // Bearing needle with a soft phosphor bloom.
    ctx.strokeStyle = rgba(accent, 0.85);
    ctx.lineWidth = 2;
    ctx.shadowColor = rgba(accent, 0.8);
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Arrowhead at the outer ring.
    const ah = 9;
    const perpX = -dirY;
    const perpY = dirX;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(
      tipX - dirX * ah + perpX * ah * 0.5,
      tipY - dirY * ah + perpY * ah * 0.5,
    );
    ctx.lineTo(
      tipX - dirX * ah - perpX * ah * 0.5,
      tipY - dirY * ah - perpY * ah * 0.5,
    );
    ctx.closePath();
    ctx.fillStyle = rgba([180, 255, 210], 0.95);
    ctx.fill();

    // Bearing readout just outside the ring, e.g. "045\u00b0".
    const brg = Math.round(((bearing % 360) + 360) % 360) % 360;
    ctx.font = `bold 12px ${FONT_STACK}`;
    ctx.fillStyle = rgba([180, 255, 210], 0.95);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      `${String(brg).padStart(3, "0")}\u00b0`,
      cx + dirX * (R + 15),
      cy + dirY * (R + 15),
    );

    ctx.restore();
  }

  // Subtle course line for the focused contact: a best-guess continuation ahead
  // (a dashed ray along its current ground track to the scope edge). Clipped to
  // the tube and drawn dim so it reads as a faint course trace rather than
  // competing with the blip.
  _drawFocusRoute(ctx, cx, cy, R) {
    const b = this.focused;
    if (!b) return;
    const { d, bearing } = this._displayPos(b);
    if (typeof bearing !== "number") return;

    const rr = Math.min(1, Math.max(0, d / this.rangeNm)) * R;
    const rad = bearing * DEG;
    const px = cx + Math.sin(rad) * rr;
    const py = cy - Math.cos(rad) * rr;
    const accent = [150, 255, 190];

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.clip();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Best guess ahead: dashed ray from the plane along its ground track.
    if (typeof b.trackDeg === "number") {
      const dx = Math.sin(b.trackDeg * DEG);
      const dy = -Math.cos(b.trackDeg * DEG);
      const fx = px - cx;
      const fy = py - cy;
      const bq = 2 * (fx * dx + fy * dy);
      const cq = fx * fx + fy * fy - R * R;
      const disc = bq * bq - 4 * cq;
      if (disc >= 0) {
        const t = (-bq + Math.sqrt(disc)) / 2;
        if (t > 0) {
          ctx.setLineDash([4, 5]);
          ctx.strokeStyle = rgba(accent, 0.28);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px + dx * t, py + dy * t);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    ctx.restore();
  }

  // Corner-bracket targeting reticle drawn around the focused contact.
  _drawReticle(ctx, x, y, sizeFactor = 1) {
    const r = 15 * sizeFactor; // half-size of the bracket box
    const arm = 5; // length of each bracket leg
    ctx.save();
    ctx.strokeStyle = rgba([180, 255, 210], 0.9);
    ctx.lineWidth = 1.5;
    ctx.shadowColor = rgba([150, 255, 190], 0.7);
    ctx.shadowBlur = 6;
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(x + sx * r, y + sy * r - sy * arm);
      ctx.lineTo(x + sx * r, y + sy * r);
      ctx.lineTo(x + sx * r - sx * arm, y + sy * r);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawBlips(ctx, cx, cy, R) {
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const b of this.blips.values()) {
      // Hold the blip back until its route lookup has settled, so it never
      // appears with a placeholder dash that fills in a moment later.
      if (!this._isReady(b)) continue;
      // In focus mode every other contact is hidden.
      if (this.focusedHex != null && b.hex !== this.focusedHex) continue;
      const { d, bearing } = this._displayPos(b);
      // Plot position uses the fraction of the current range, so a contact
      // always sits at the correct ring regardless of the depth cue below.
      const rr = Math.min(1, Math.max(0, d / this.rangeNm)) * R;
      const rad = bearing * DEG;
      const x = cx + Math.sin(rad) * rr;
      const y = cy - Math.cos(rad) * rr;

      // Fake a little depth based on *absolute* distance, not ring position:
      // contacts far away (approaching DEPTH_FULL_NM) shrink slightly (down to
      // ~75%) and the sweep flares them a touch fainter (down to ~70%). At a
      // tight range every contact is genuinely close, so the factor stays near
      // 1 and nothing is dimmed/resized. A real PPI scope keeps blips the same
      // size but distant echoes are weaker, so the dimming is the authentic cue
      // and the size falloff is a subtle stylistic depth hint.
      const depthFrac = Math.min(1, Math.max(0, d / DEPTH_FULL_NM));
      const sizeFactor = 1 - 0.25 * depthFrac;
      const distDim = 1 - 0.3 * depthFrac;

      // Visibility is driven entirely by the sweep: a plane flares to full
      // glow when the arm passes it, then fades to nothing (invisible) until
      // the next ping. If it's still around when swept again, the cycle
      // repeats. Skip drawing once fully decayed.
      if (b.intensity <= 0.02) continue;
      const { rgb, special } = blipAccent(b);
      // Special contacts pulse in brightness; ordinary ones hold steady.
      const pulseMul = special ? 0.7 + 0.3 * this.pulse : 1;
      const glow = b.intensity * distDim * pulseMul;

      // Phosphor trail first, so the blip and its halo sit on top of the tail.
      this._drawTrail(ctx, cx, cy, R, b, glow, rgb);

      // Special traffic gets a slightly larger, colour-matched halo so it
      // reads as an alert rather than ordinary phosphor.
      const haloR = (12 + glow * 10) * sizeFactor * (special ? 1.25 : 1);
      const halo = ctx.createRadialGradient(x, y, 0, x, y, haloR);
      halo.addColorStop(0, rgba(rgb, 0.9 * glow));
      halo.addColorStop(1, rgba(rgb, 0));
      ctx.beginPath();
      ctx.arc(x, y, haloR, 0, TAU);
      ctx.fillStyle = halo;
      ctx.fill();

      this._drawPlane(
        ctx,
        x,
        y,
        b.trackDeg,
        glow,
        sizeFactor,
        b.sizeClass,
        rgb,
        b.isRotor,
      );

      // A targeting reticle brackets the focused contact so the lock-on reads
      // clearly even against the empty scope.
      if (b.hex === this.focusedHex) this._drawReticle(ctx, x, y, sizeFactor);

      // Label: flight number + route, fading with labelAlpha. When a dedicated
      // overlay layer exists, cards are drawn there instead (see _drawLabels)
      // so they sit above the CRT mask and overlays.
      if (!this.lctx && b.labelAlpha > 0.03) {
        this._drawLabel(ctx, b, x, y);
      }
    }
  }

  // Draw every visible info card onto the overlay layer. Cards are placed with
  // a lightweight collision-avoidance pass so that, when several aircraft
  // cluster together, a card tries not to sit on top of another plane or on
  // another card. This is "good enough" (greedy, a handful of candidate
  // offsets) rather than an exact layout solver.
  _drawLabels(ctx, cx, cy, R) {
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    // Collect the visible blips along with their plotted plane position and the
    // measured card size, so placement can reason about all of them at once.
    const items = [];
    for (const b of this.blips.values()) {
      if (!this._isReady(b)) continue;
      if (this.focusedHex != null && b.hex !== this.focusedHex) continue;
      if (b.intensity <= 0.02) continue;
      if (b.labelAlpha <= 0.03) continue;
      const { d, bearing } = this._displayPos(b);
      const rr = (d / this.rangeNm) * R;
      const rad = bearing * DEG;
      const x = cx + Math.sin(rad) * rr;
      const y = cy - Math.cos(rad) * rr;
      const { lines, w, h } = this._measureLabel(ctx, b);
      items.push({ b, x, y, lines, w, h });
    }

    // Every plane acts as an obstacle cards should avoid covering (its own
    // plane included, so a card never hides the aircraft it describes). A
    // roughly plane-and-halo sized box approximates each contact's footprint.
    const PLANE_R = 13;
    const planeRects = items.map((it) => ({
      x: it.x - PLANE_R,
      y: it.y - PLANE_R,
      w: PLANE_R * 2,
      h: PLANE_R * 2,
    }));

    // Place brighter (more recently pinged) cards first so, when something has
    // to overlap, the freshest contact gets the cleanest spot.
    items.sort((a, b) => b.b.labelAlpha - a.b.labelAlpha);

    const placed = [];
    for (const it of items) {
      const rect = this._placeLabel(it, planeRects, placed);
      it.rect = rect;
      placed.push(rect);
    }

    for (const it of items) {
      this._drawLabelBox(
        ctx,
        it.b,
        it.rect.x,
        it.rect.y,
        it.w,
        it.h,
        it.lines,
        it.x,
        it.y,
      );
    }
  }

  // Pick a card rectangle for one item by scoring a handful of candidate
  // offsets around the plane against the known obstacles (other planes and
  // already-placed cards) and keeping the least-overlapping one.
  _placeLabel(it, planeRects, placed) {
    const { x, y, w, h } = it;
    const gap = 10;
    // Candidate top-left corners, ordered by preference (right side reads most
    // naturally, then left, then below/above, then the diagonals).
    const candidates = [
      { x: x + gap, y: y - h / 2 },
      { x: x - gap - w, y: y - h / 2 },
      { x: x - w / 2, y: y + gap },
      { x: x - w / 2, y: y - gap - h },
      { x: x + gap, y: y + gap },
      { x: x + gap, y: y - gap - h },
      { x: x - gap - w, y: y + gap },
      { x: x - gap - w, y: y - gap - h },
    ];

    let best = null;
    let bestScore = Infinity;
    candidates.forEach((c, i) => {
      // Clamp fully inside the canvas; a clamp that shifts the box far from its
      // intended anchor is penalized so we don't favour a squashed placement.
      const lx = Math.max(0, Math.min(c.x, this.size - w));
      const ly = Math.max(0, Math.min(c.y, this.size - h));
      const rect = { x: lx, y: ly, w, h };
      const shift = Math.abs(lx - c.x) + Math.abs(ly - c.y);

      let score = shift * 0.5 + i * 0.01; // tiny tie-break toward preferred order
      for (const p of planeRects) score += this._overlapArea(rect, p) * 1.5;
      for (const q of placed) score += this._overlapArea(rect, q);

      if (score < bestScore) {
        bestScore = score;
        best = rect;
      }
    });
    return best;
  }

  // Area of the axis-aligned intersection of two rectangles (0 when disjoint).
  _overlapArea(a, b) {
    const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return ox * oy;
  }

  // Convert a polar position (distance nm + bearing deg) to canvas x/y using
  // the same range-fraction mapping as the blips, so a trail point lands
  // exactly where the contact sat when that fix arrived.
  _project(cx, cy, R, d, bearingDeg) {
    const rr = Math.min(1, Math.max(0, d / this.rangeNm)) * R;
    const rad = bearingDeg * DEG;
    return { x: cx + Math.sin(rad) * rr, y: cy - Math.cos(rad) * rr };
  }

  // Draw the fading phosphor tail behind a blip: a tapered smear through its
  // recent positions, brightest and thickest at the newest segment (nearest
  // the plane) and decaying toward the oldest fix. It's rendered as *emitted*
  // light (additive blending + a soft bloom halo) so it glows and blooms where
  // it overlaps like excited phosphor on a CRT, and the brightness falls off
  // quadratically with age to mimic the tube's exponential persistence decay.
  // The whole trail is scaled by the blip's current sweep glow so it flares and
  // fades with the contact rather than lingering as a static scribble.
  _drawTrail(ctx, cx, cy, R, b, glow, rgb) {
    const trail = b.trail;
    if (!trail || trail.length < 2 || glow <= 0.02) return;

    ctx.save();
    // Phosphor emits light, so overlapping glow should add up and bloom.
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const points = trail.map((p) => this._project(cx, cy, R, p.d, p.b));
    // Bridge the polled trail toward the display position (scaled by strength
    // so the tail doesn't outrun a subtly interpolated blip).
    const strength = Math.min(
      1,
      Math.max(0, CONFIG.interpolationStrength ?? 1),
    );
    const { d, bearing } = this._displayPos(b);
    const last = trail[trail.length - 1];
    if (strength > 0.05 && last && (last.d !== d || last.b !== bearing)) {
      const bridgeD = last.d + (d - last.d) * strength;
      const bridgeB = lerpAngle(last.b, bearing, strength);
      if (bridgeD !== last.d || bridgeB !== last.b) {
        points.push(this._project(cx, cy, R, bridgeD, bridgeB));
      }
    }
    const n = points.length;
    if (n < 2) {
      ctx.restore();
      return;
    }

    for (let i = 1; i < n; i++) {
      const ageFrac = i / (n - 1); // 0 (oldest) .. 1 (newest, at the plane)
      // Quadratic decay: brightness drops off quickly behind the blip.
      const a = TRAIL_ALPHA * ageFrac * ageFrac * glow;
      if (a <= 0.01) continue;
      ctx.strokeStyle = rgba(rgb, a);
      ctx.lineWidth = 0.6 + 1.8 * ageFrac;
      // Soft bloom around the hot core sells the glowing-gas look.
      ctx.shadowColor = rgba(rgb, a);
      ctx.shadowBlur = 5 * ageFrac;
      ctx.beginPath();
      ctx.moveTo(points[i - 1].x, points[i - 1].y);
      ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();
    }

    // A faint blooming node at each past fix softens the straight-line joints
    // and reads as the phosphor being re-excited at each sample. The newest
    // point is skipped: the blip's own halo already sits there.
    ctx.shadowBlur = 0;
    for (let i = 0; i < n - 1; i++) {
      const ageFrac = i / (n - 1);
      const a = TRAIL_ALPHA * 0.8 * ageFrac * ageFrac * glow;
      if (a <= 0.01) continue;
      const p = points[i];
      const r = 2.5 + 2.5 * ageFrac;
      const node = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      node.addColorStop(0, rgba(rgb, a));
      node.addColorStop(1, rgba(rgb, 0));
      ctx.fillStyle = node;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  // Draw a small top-down airplane silhouette centered at (x, y), rotated to
  // its ground track (degrees clockwise from North). Brightens with `glow`.
  // `sizeClass` ('light' | 'medium' | 'heavy') selects the icon shape and a
  // base size so a jumbo reads bigger than a light aircraft at a glance.
  // `isRotor` swaps in a helicopter symbol regardless of size bucket.
  _drawPlane(
    ctx,
    x,
    y,
    trackDeg,
    glow,
    sizeFactor = 1,
    sizeClass = "medium",
    rgb = PHOSPHOR_RGB,
    isRotor = false,
  ) {
    // Fade the plane entirely with the phosphor glow so it vanishes between
    // sweeps rather than lingering as a static dot. `sizeFactor` shrinks
    // contacts that are further from the center for a subtle depth cue.
    const alpha = glow;
    // Per-class base scale layered on top of the glow/distance scaling so the
    // three buckets stay distinguishable regardless of range or brightness.
    // Helicopters ignore the size bucket and use one consistent scale.
    const classScale = isRotor
      ? 0.9
      : sizeClass === "heavy"
        ? 1.4
        : sizeClass === "light"
          ? 0.62
          : 1;
    const scale = (0.85 + glow * 0.35) * sizeFactor * classScale;

    ctx.save();
    ctx.translate(x, y);
    // Canvas rotation is clockwise with y-down, and the silhouette below points
    // up (North), so rotating by the track angle aims the nose correctly.
    if (trackDeg != null) ctx.rotate(trackDeg * DEG);
    ctx.scale(scale, scale);

    if (isRotor) {
      // A helicopter draws its own body + rotor (mixed fill/stroke), so it
      // handles alpha itself and returns rather than sharing the plane fill.
      this._heliShape(ctx, alpha, glow, rgb);
      ctx.restore();
      return;
    }

    // Light aircraft get a straight-wing prop-plane silhouette; medium/heavy
    // share the swept-wing jet outline (size does the rest of the talking).
    if (sizeClass === "light") this._lightPath(ctx);
    else this._jetPath(ctx);

    ctx.fillStyle = rgba(rgb, alpha);
    ctx.fill();
    if (glow > 0.02) {
      // Lighten the accent for the outline so the silhouette keeps a crisp
      // hot edge in its own colour.
      const edge = rgb.map((c) => Math.min(255, c + 50));
      ctx.strokeStyle = rgba(edge, 0.8 * glow);
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
    ctx.restore();
  }

  // Top-down helicopter symbol, pointing North (up), drawn in the already
  // translated/rotated/scaled context set up by `_drawPlane`. A filled fuselage
  // with a tail boom and tail rotor, overlaid by two diagonally-crossed main
  // rotor blades. The diagonal blades read unmistakably as a helicopter and
  // never look like the horizontal wings of a fixed-wing icon.
  _heliShape(ctx, alpha, glow, rgb) {
    // Fuselage: a rounded body with a tail boom running aft to a small tail
    // rotor, built as one filled path.
    ctx.beginPath();
    ctx.ellipse(0, -1.5, 2.4, 4.6, 0, 0, TAU); // cabin/fuselage
    ctx.rect(-0.7, 2.5, 1.4, 6); // tail boom
    ctx.rect(-2.6, 8, 5.2, 1.2); // tail rotor
    ctx.fillStyle = rgba(rgb, alpha);
    ctx.fill();

    // Main rotor: two blades crossed on the diagonal, drawn as bright strokes
    // with round caps so they read as spinning blades over the cabin.
    const edge = rgb.map((c) => Math.min(255, c + 50));
    ctx.strokeStyle = rgba(edge, Math.max(0.35, 0.85 * glow));
    ctx.lineWidth = 1.1;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-6.5, -6.5);
    ctx.lineTo(6.5, 6.5);
    ctx.moveTo(6.5, -6.5);
    ctx.lineTo(-6.5, 6.5);
    ctx.stroke();
    // Rotor hub: a small bright dot at the centre of rotation.
    ctx.beginPath();
    ctx.arc(0, -1.5, 1, 0, TAU);
    ctx.fillStyle = rgba(edge, Math.max(0.4, 0.9 * glow));
    ctx.fill();
  }

  // Swept-wing airliner/jet silhouette, pointing North (up). Used for medium
  // and heavy contacts (heavy is simply drawn at a larger scale).
  _jetPath(ctx) {
    ctx.beginPath();
    ctx.moveTo(0, -9); // nose
    ctx.lineTo(1.6, -3.5);
    ctx.lineTo(1.6, -1);
    ctx.lineTo(9, 3); // right wing tip
    ctx.lineTo(9, 4.5);
    ctx.lineTo(1.4, 2);
    ctx.lineTo(1.2, 6);
    ctx.lineTo(4, 8.5); // right tailplane
    ctx.lineTo(4, 9.5);
    ctx.lineTo(0, 8);
    ctx.lineTo(-4, 9.5);
    ctx.lineTo(-4, 8.5);
    ctx.lineTo(-1.2, 6);
    ctx.lineTo(-1.4, 2);
    ctx.lineTo(-9, 4.5);
    ctx.lineTo(-9, 3);
    ctx.lineTo(-1.6, -1);
    ctx.lineTo(-1.6, -3.5);
    ctx.closePath();
  }

  // Straight-wing light/GA silhouette, pointing North (up). Wings sit near the
  // mid-fuselage and run square to the body so it reads as a small prop plane
  // rather than a jet.
  _lightPath(ctx) {
    ctx.beginPath();
    ctx.moveTo(0, -7); // nose
    ctx.lineTo(1, -2.5);
    ctx.lineTo(1, -0.6);
    ctx.lineTo(8, 0.2); // right wing tip (straight)
    ctx.lineTo(8, 1.4);
    ctx.lineTo(1, 1.2);
    ctx.lineTo(1, 5.5);
    ctx.lineTo(3.6, 7); // right tailplane
    ctx.lineTo(3.6, 7.8);
    ctx.lineTo(0, 6.6);
    ctx.lineTo(-3.6, 7.8);
    ctx.lineTo(-3.6, 7);
    ctx.lineTo(-1, 5.5);
    ctx.lineTo(-1, 1.2);
    ctx.lineTo(-8, 1.4);
    ctx.lineTo(-8, 0.2);
    ctx.lineTo(-1, -0.6);
    ctx.lineTo(-1, -2.5);
    ctx.closePath();
  }

  // Build the info-card text lines and measure the box they need. Kept
  // separate from drawing so the overlay layer can lay out several cards
  // before committing any of them to the canvas.
  _measureLabel(ctx, b) {
    // Line 1 is the flight id (bold). Line 2 is a compact summary: model code
    // + altitude with a climb/descent arrow, joined by a middle dot. When the
    // route is known, the origin and destination sit on their own lines (each
    // with a country flag and city name) separated by a centered "\u2193"
    // connector. That arrow gets a short half-height slot, so it sits neatly
    // between the two airports without costing a full extra line.
    const lines = [
      { text: b.callsign || b.registration || b.hex.toUpperCase(), bold: true },
    ];
    // Lead special contacts with a coloured status tag (e.g. "MILITARY").
    const tag = specialTag(b);
    if (tag) lines.unshift({ text: tag, bold: true, tag: true });
    // Name the operator: an explicit airline name from the route if present,
    // otherwise the operator/owner from the positions feed (the route API only
    // returns a code, e.g. "BAW"). Shown when known so bare cards stay compact.
    const airlineName =
      (b.route && b.route.airline) ||
      (b.operator ? formatOperator(b.operator) : "");
    if (airlineName) {
      lines.push({ text: airlineName });
    }
    // Prefer the short ICAO type code (e.g. "B763") to keep the line narrow;
    // fall back to the longer human-readable model only when it's missing.
    const model = b.type || b.model;
    const altLine = formatAltitude(b.altFt, b.verticalRateFpm);
    const summary = [model, altLine].filter(Boolean).join(" \u00b7 ");
    if (summary) lines.push({ text: summary });
    if (b.route) {
      lines.push({ text: formatAirport(b.route.origin) });
      lines.push({ text: "\u2193", center: true, connector: true });
      lines.push({ text: formatAirport(b.route.destination) });
    }

    for (const l of lines) {
      l.h = l.connector ? CONNECTOR_H : LINE_H;
    }

    // measureText is one of the most expensive canvas calls, and this runs for
    // every visible card on every animation frame. The card text only changes
    // when a poll brings new data, so cache the measured width/height against a
    // signature of the line contents and re-measure only when that changes.
    const sig = lines
      .map((l) => `${l.connector ? "c" : l.bold ? "b" : "n"}:${l.text}`)
      .join("|");
    if (b._labelSig === sig) {
      return { lines, w: b._labelW, h: b._labelH };
    }

    let w = 0;
    let contentH = 0;
    for (const l of lines) {
      contentH += l.h;
      ctx.font = fontForLine(l);
      w = Math.max(w, ctx.measureText(l.text).width);
    }
    w += CARD_PAD * 2;
    const h = contentH + CARD_PAD_Y * 2;

    b._labelSig = sig;
    b._labelW = w;
    b._labelH = h;
    return { lines, w, h };
  }

  // Simple single-card placement used by the fallback path (no overlay layer):
  // sit to the plane's right, flip left on right-edge overflow, then clamp.
  _drawLabel(ctx, b, x, y) {
    const { lines, w, h } = this._measureLabel(ctx, b);
    let lx = x + 8;
    let ly = y - h / 2;
    if (lx + w > this.size) lx = x - 8 - w;
    lx = Math.max(0, Math.min(lx, this.size - w));
    ly = Math.max(0, Math.min(ly, this.size - h));
    this._drawLabelBox(ctx, b, lx, ly, w, h, lines, x, y);
  }

  // Render one info card at a resolved position. When the card has been pushed
  // away from its plane (px, py) a faint leader line keeps the association
  // clear.
  _drawLabelBox(ctx, b, lx, ly, w, h, lines, px, py) {
    const a = b.labelAlpha;
    const { rgb, special } = blipAccent(b);

    this._drawLeader(ctx, lx, ly, w, h, px, py, a);

    ctx.fillStyle = `rgba(3, 20, 10, ${0.55 * a})`;
    ctx.fillRect(lx, ly, w, h);
    // Special contacts get a colour-matched, slightly stronger border.
    ctx.strokeStyle = special
      ? rgba(rgb, 0.75 * a)
      : `rgba(0, 255, 120, ${0.4 * a})`;
    ctx.lineWidth = special ? 1.4 : 1;
    ctx.strokeRect(lx, ly, w, h);

    // Lines can have differing heights (the connector arrow is shorter), so
    // advance a running y cursor rather than multiplying by a fixed line height.
    // Every line is vertically centered within its own slot so the leftover
    // leading is split evenly top and bottom, keeping the gaps between all
    // lines (and around the connector arrow) uniform.
    ctx.textBaseline = "middle";
    let y = ly + CARD_PAD_Y;
    for (const l of lines) {
      ctx.font = fontForLine(l);
      ctx.fillStyle = l.tag
        ? rgba(rgb, a)
        : l.bold
          ? `rgba(190, 255, 215, ${a})`
          : l.connector
            ? `rgba(120, 230, 160, ${0.7 * a})`
            : `rgba(120, 230, 160, ${a})`;
      const tx = l.center
        ? lx + (w - ctx.measureText(l.text).width) / 2
        : lx + CARD_PAD;
      ctx.fillText(l.text, tx, y + l.h / 2);
      y += l.h;
    }
  }

  // Draw a faint connector from the plane to the card, but only when the plane
  // sits outside the card (i.e. the card was displaced to dodge a collision).
  _drawLeader(ctx, lx, ly, w, h, px, py, a) {
    if (px == null || py == null) return;
    const inside = px >= lx && px <= lx + w && py >= ly && py <= ly + h;
    if (inside) return;
    // Aim at the point on the card border nearest the plane.
    const tx = Math.max(lx, Math.min(px, lx + w));
    const ty = Math.max(ly, Math.min(py, ly + h));
    const dx = tx - px;
    const dy = ty - py;
    if (dx * dx + dy * dy < 4) return; // essentially touching; skip
    ctx.strokeStyle = `rgba(0, 255, 120, ${0.28 * a})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(tx, ty);
    ctx.stroke();
  }

  _drawCenter(ctx, cx, cy) {
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, TAU);
    ctx.fillStyle = "rgba(180, 255, 210, 0.9)";
    ctx.fill();
  }

  get count() {
    return this.blips.size;
  }
}
