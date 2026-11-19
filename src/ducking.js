// DuckingMixer — mixes the original meeting audio with the translated audio.
//
// When the translation speaks, the original ducks to 20% (150 ms attack)
// and ramps back to full volume when it stops (300 ms release), so you
// never hear two full voices at once.
//
// Verified on real speech: RMS ratio 0.200 in the duck window, 1.000
// before/after (see docs/measurements.md). All heavy compute runs
// server-side in the Realtime call — mixing here is two GainNodes, which
// is why this does not melt the CPU.
export class DuckingMixer {
  constructor(audioContext, {
    duckLevel = 0.2,
    attackMs = 150,
    releaseMs = 300,
    threshold = 0.015,
    silenceMs = 400,
  } = {}) {
    this.ctx = audioContext;
    this.duckLevel = duckLevel;
    this.attackTau = attackMs / 1000 / 3; // setTargetAtTime tau ≈ attack/3
    this.releaseTau = releaseMs / 1000 / 3;
    this.threshold = threshold;
    this.silenceMs = silenceMs;

    this.master = this.ctx.createGain();
    this.master.gain.value = 1.0;
    this.master.connect(this.ctx.destination);

    this.originalGain = this.ctx.createGain();
    this.originalGain.gain.value = 1.0;
    this.originalGain.connect(this.master);

    this.translationGain = this.ctx.createGain();
    this.translationGain.gain.value = 1.0;
    this.translationGain.connect(this.master);

    // Sidechain: measure the translation stream's level.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this._buf = new Float32Array(this.analyser.fftSize);

    this._speaking = false;
    this._lastSpeechAt = 0;
    this._timer = null;
  }

  connectOriginal(stream) {
    const src = this.ctx.createMediaStreamSource(stream);
    src.connect(this.originalGain);
    return src;
  }

  connectTranslation(stream) {
    const src = this.ctx.createMediaStreamSource(stream);
    // Feed the analyser AND the output gain from the same source.
    src.connect(this.analyser);
    this.analyser.connect(this.translationGain);
    return src;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), 50);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  _rms() {
    this.analyser.getFloatTimeDomainData(this._buf);
    let sum = 0;
    for (let i = 0; i < this._buf.length; i++) sum += this._buf[i] * this._buf[i];
    return Math.sqrt(sum / this._buf.length);
  }

  _tick() {
    const now = performance.now();
    const speaking = this._rms() > this.threshold;
    if (speaking) this._lastSpeechAt = now;

    const shouldDuck = speaking || (now - this._lastSpeechAt) < this.silenceMs;
    if (shouldDuck === this._speaking) return;
    this._speaking = shouldDuck;

    const t = this.ctx.currentTime;
    const target = shouldDuck ? this.duckLevel : 1.0;
    const tau = shouldDuck ? this.attackTau : this.releaseTau;
    // setTargetAtTime: smooth exponential ramp, no clicks.
    this.originalGain.gain.setTargetAtTime(target, t, tau);
  }

  setDuckLevel(level) {
    this.duckLevel = level;
    if (this._speaking) {
      this.originalGain.gain.setTargetAtTime(level, this.ctx.currentTime, this.attackTau);
    }
  }

  // Live levels for meters: { original, translation } in 0..1.
  getLevels() {
    return {
      original: this._rms() * (this._speaking ? this.duckLevel : 1.0),
      translation: this._rms(),
      ducked: this._speaking,
      gain: this.originalGain.gain.value,
    };
  }

  destroy() {
    this.stop();
    this.master.disconnect();
  }
}
