// Opt-in radar sound, synthesized entirely with the Web Audio API so there are
// no asset files to ship. Two sounds:
//   - ping()  a short sonar blip fired as the sweep crosses a contact
//   - chime() a soft two-note bell used to confirm sound has been enabled
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
  ping() {
    if (this.muted) return;
    const ctx = this._ensure();
    if (!ctx) return;
    const now = performance.now();
    if (now - this._lastPingAt < this._minPingGapMs) return;
    this._lastPingAt = now;

    const t = ctx.currentTime;

    // Bandpass keeps the tone tight and "electronic". Its centre frequency
    // tracks the oscillator's doppler glide so the resonance follows the pitch.
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1240;
    bp.Q.value = 6;

    // A single, extremely short echo tap — so tight (~18 ms) it fuses into the
    // dry blip as one sound rather than a perceptible double ping. Just adds a
    // touch of body.
    const delay = ctx.createDelay(0.1);
    delay.delayTime.value = 0.018;
    const echoGain = ctx.createGain();
    echoGain.gain.value = 0.14;
    delay.connect(echoGain).connect(this.master);

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
    // Dry signal straight to the master, plus a single tap into the echo.
    gain.connect(this.master);
    gain.connect(delay);

    osc.start(t);
    osc.stop(t + 0.77);
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
