// Opt-in radar sound, synthesized entirely with the Web Audio API so there are
// no asset files to ship. Three sounds:
//   - ping()     a short sonar blip fired as the sweep crosses a contact
//   - overhead() the same blip in a rapid burst — the "look up NOW" alert for a
//                contact passing almost directly overhead
//   - chime()    a soft two-note bell used to confirm sound has been enabled
//
// Muted by default. The AudioContext is created lazily on the first unmute
// (which happens from a user click) so browser autoplay policies are satisfied.

export class RadarAudio {
  constructor({ muted = true } = {}) {
    this.muted = muted;
    /** @type {AudioContext|null} */
    this.ctx = null;
    // Master gain lets us keep the whole thing gentle and easy to duck.
    this.master = null;
    // Throttle pings so a dense scope doesn't turn into a machine-gun rattle.
    this._lastPingAt = 0;
    this._minPingGapMs = 110;
    // How hard a contact can be pushed to one side. Just under 1 so even a
    // dead-abeam ping keeps a whisper in the far ear rather than going silent.
    this._maxPan = 0.9;
  }

  // Create (or resume) the AudioContext. Returns null when Web Audio is
  // unavailable. Safe to call repeatedly.
  _ensure() {
    if (this.ctx == null) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    // Browsers start the context suspended until a user gesture resumes it.
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  get enabled() {
    return !this.muted;
  }

  // Toggle sound. Unmuting warms up the AudioContext under the triggering
  // gesture so later sounds play without a first-hit delay.
  setMuted(muted) {
    this.muted = muted;
    if (!muted) this._ensure();
  }

  // A crisp air-traffic-scope "blip": a bright, tight tone with a snappy attack
  // and a short decay, plus just a whisper of echo for a sense of space (not
  // the deep, cavernous sonar ring). Cheap enough to fire on every sweep-cross.
  //
  // `bearingDeg` (compass bearing of the contact, 0 = North, 90 = East) places
  // the blip in the stereo field so a plane at 3 o'clock sounds off to the
  // right. Omitted / non-finite bearings play dead centre.
  ping(bearingDeg) {
    if (this.muted) return;
    const ctx = this._ensure();
    if (!ctx) return;
    const now = performance.now();
    if (now - this._lastPingAt < this._minPingGapMs) return;
    this._lastPingAt = now;
    this._blip(ctx.currentTime, this._panFor(bearingDeg));
  }

  // Map a compass bearing to a stereo pan position in [-1, +1]. East (90 deg)
  // is hard right, West (270 deg) is hard left, North/South are centred — i.e.
  // sin(bearing) — matching how the contact sits on the scope relative to you.
  // Capped just short of a fully silent ear so panned blips still feel natural.
  _panFor(bearingDeg) {
    if (typeof bearingDeg !== 'number' || !Number.isFinite(bearingDeg)) return 0;
    return Math.sin(bearingDeg * Math.PI / 180) * this._maxPan;
  }

  // The overhead / zenith alert: the exact same blip, but fired several times
  // in rapid succession — the audible "look up NOW" nudge for a contact passing
  // almost directly over you. Deliberately not a new, jarring sound; just the
  // familiar ping, urgent. Bypasses the sweep-cross throttle by scheduling the
  // repeats ahead on the AudioContext clock.
  overhead() {
    if (this.muted) return;
    const ctx = this._ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const count = 4;
    const gap = 0.14; // seconds between blips — tight enough to read as a burst
    for (let i = 0; i < count; i++) this._blip(t + i * gap);
    // Keep the sweep-cross throttle in sync so a coincident sweep ping doesn't
    // pile straight on top of the burst.
    this._lastPingAt = performance.now() + count * gap * 1000;
  }

  // Build one blip tone starting at AudioContext time `t`. Shared by the single
  // sweep-cross ping and the rapid overhead burst. `pan` places the whole blip
  // (dry + echo) in the stereo field, -1 (hard left) .. +1 (hard right).
  _blip(t, pan = 0) {
    const ctx = this.ctx;
    if (!ctx) return;

    // A per-blip stereo panner sits between the blip and the master so this
    // contact's bearing decides which ear it lands in. Falls back to routing
    // straight to the master where StereoPanner isn't available.
    const panner = this._makePanner(pan);
    const out = panner || this.master;

    // Bandpass keeps the tone tight and "electronic". Its centre frequency
    // tracks the oscillator's doppler glide so the resonance follows the pitch.
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1240;
    bp.Q.value = 6;

    // A single, extremely short echo tap — so tight (~18 ms) it fuses into the
    // dry blip as one sound rather than a perceptible double ping. Just adds a
    // touch of body. Routed through the same panner so the echo stays on the
    // contact's side rather than smearing back to centre.
    const delay = ctx.createDelay(0.1);
    delay.delayTime.value = 0.018;
    const echoGain = ctx.createGain();
    echoGain.gain.value = 0.14;
    delay.connect(echoGain).connect(out);

    // The dry blip. A gentle doppler arc — pitch eases up as the sweep reaches
    // the contact, then glides down as it passes — plus a soft swell-in attack
    // makes it "drag" past rather than snap.
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1260, t);
    // Just a whisper of downward drift — enough to feel movement, not a glide.
    osc.frequency.linearRampToValueAtTime(1230, t + 0.7);
    gain.gain.setValueAtTime(0.0001, t);
    // Softer, swelling attack so the tone slurs in as the beam arrives.
    gain.gain.exponentialRampToValueAtTime(0.28, t + 0.045);
    // Long, smooth exponential tail so the tone rings out and drags away.
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.72);

    osc.connect(bp).connect(gain);
    // Dry signal to the (panned) output, plus a single tap into the echo.
    gain.connect(out);
    gain.connect(delay);
    // Panner feeds the master; skip when we fell back to routing to master.
    if (panner) panner.connect(this.master);

    osc.start(t);
    osc.stop(t + 0.77);
  }

  // Create a StereoPannerNode set to `pan` (-1..+1). Returns null when the
  // node is unsupported or the pan is effectively centre, in which case the
  // caller just routes to the master unpanned.
  _makePanner(pan) {
    const ctx = this.ctx;
    if (!ctx || !ctx.createStereoPanner) return null;
    if (!pan) return null;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    return panner;
  }

  // A soft, bell-like two-note rise used to confirm sound has been enabled. A
  // pair of detuned partials per note with a gentle envelope keeps it warm.
  chime() {
    if (this.muted) return;
    const ctx = this._ensure();
    if (!ctx) return;

    const t0 = ctx.currentTime;
    // A perfect-fifth-ish rise (E5 -> B5) reads as a pleasant "ding-dong".
    this._bell(659.25, t0, 0.9);
    this._bell(987.77, t0 + 0.16, 1.1);
  }

  _bell(freq, at, dur) {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    gain.connect(this.master);

    // Fundamental plus a quiet, slightly detuned octave for a metallic sheen.
    const partials = [
      { f: freq, type: 'sine', g: 1 },
      { f: freq * 2.0, type: 'sine', g: 0.28 },
    ];
    for (const p of partials) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = p.g;
      osc.type = p.type;
      osc.frequency.value = p.f;
      osc.connect(g).connect(gain);
      osc.start(at);
      osc.stop(at + dur + 0.05);
    }
  }
}
