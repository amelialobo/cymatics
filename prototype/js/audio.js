/* CYMATICS — audio engine
 * Three sources (microphone, file, tone generator) feed one analyser.
 * analyze() turns the analyser output into the features that drive the plate.
 */
(function (global) {
  'use strict';

  const FFT_SIZE = 4096;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.source = null; // 'mic' | 'file' | 'tone' | null
      this.tone = { freq: 220, type: 'sine', amp: 0.5, monitor: true, running: false };
      this.file = { el: null, node: null, mon: null, url: null, name: '', volume: 0.8 };
      this.mic = { stream: null, node: null, gainNode: null, gain: 2 };
      this.hold = { band: 0.05, rms: 0.05, fluxAvg: 0 };
      this.lastOnset = 0;
      this.features = {
        active: false,
        rms: 0, level: 0, delta: 0,
        low: 0, mid: 0, high: 0,
        lowHz: 0, midHz: 0, highHz: 0,
        lowPk: 0, midPk: 0, highPk: 0, // band peak relative to the loudest peak
        dominantHz: 0, centroidHz: 0, centroidN: 0,
        flux: 0, onset: 0,
        mag: null, binHz: 0,
      };
    }

    init() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return;
      }
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) throw new Error('Web Audio is not supported in this browser');
      const ctx = (this.ctx = new AC());
      this.input = ctx.createGain();
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0.5;
      this.analyser.minDecibels = -110;
      this.analyser.maxDecibels = -10;
      this.input.connect(this.analyser);

      const bins = this.analyser.frequencyBinCount;
      this.db = new Float32Array(bins);
      this.mag = new Float32Array(bins);
      this.prev = new Float32Array(bins);
      this.wave = new Float32Array(FFT_SIZE);
      this.binHz = ctx.sampleRate / FFT_SIZE;
      this.features.mag = this.mag;
      this.features.binHz = this.binHz;
    }

    stopAll(except) {
      if (except !== 'tone') this.stopTone();
      if (except !== 'file') this.pauseFile();
      if (except !== 'mic') this.stopMic();
    }

    // ---------------------------------------------------------------- tone
    startTone() {
      this.init();
      this.stopAll('tone');
      const ctx = this.ctx;
      const t = ctx.currentTime;
      if (!this.toneEnv) {
        this.toneEnv = ctx.createGain();
        this.toneEnv.gain.value = 0;
        this.toneMon = ctx.createGain();
        this.toneMon.gain.value = this.tone.monitor ? 1 : 0;
        this.toneEnv.connect(this.input);
        this.toneEnv.connect(this.toneMon);
        this.toneMon.connect(ctx.destination);
      }
      const osc = (this.osc = ctx.createOscillator());
      osc.type = this.tone.type;
      osc.frequency.value = this.tone.freq;
      osc.connect(this.toneEnv);
      osc.start();
      const g = this.toneEnv.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(this.tone.amp, t + 0.08);
      this.tone.running = true;
      this.source = 'tone';
    }

    stopTone() {
      if (!this.osc) return;
      const t = this.ctx.currentTime;
      const g = this.toneEnv.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + 0.08);
      this.osc.stop(t + 0.1);
      this.osc = null;
      this.tone.running = false;
      if (this.source === 'tone') this.source = null;
    }

    setToneFreq(f) {
      this.tone.freq = f;
      if (this.osc) this.osc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.02);
    }

    setToneType(type) {
      this.tone.type = type;
      if (this.osc) this.osc.type = type;
    }

    setToneAmp(a) {
      this.tone.amp = a;
      if (this.osc) this.toneEnv.gain.setTargetAtTime(a, this.ctx.currentTime, 0.03);
    }

    setToneMonitor(on) {
      this.tone.monitor = on;
      if (this.toneMon) this.toneMon.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
    }

    // ---------------------------------------------------------------- file
    loadFile(file) {
      this.init();
      this.stopAll('file');
      const f = this.file;
      if (!f.el) {
        f.el = new Audio();
        f.el.loop = true;
        f.el.preload = 'auto';
        f.node = this.ctx.createMediaElementSource(f.el);
        f.mon = this.ctx.createGain();
        f.mon.gain.value = f.volume;
        f.node.connect(this.input);
        f.node.connect(f.mon);
        f.mon.connect(this.ctx.destination);
      }
      if (f.url) URL.revokeObjectURL(f.url);
      f.url = URL.createObjectURL(file);
      f.name = file.name;
      f.el.src = f.url;
      this.source = 'file';
      return f.el.play();
    }

    playFile() {
      if (!this.file.el || !this.file.url) return;
      this.init();
      this.stopAll('file');
      this.source = 'file';
      return this.file.el.play();
    }

    pauseFile() {
      if (this.file.el && !this.file.el.paused) this.file.el.pause();
    }

    setFileVolume(v) {
      this.file.volume = v;
      if (this.file.mon) this.file.mon.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    }

    // ----------------------------------------------------------------- mic
    async startMic() {
      this.init();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('microphone access needs a secure (https or localhost) page');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.stopAll('mic');
      const m = this.mic;
      m.stream = stream;
      m.node = this.ctx.createMediaStreamSource(stream);
      m.gainNode = this.ctx.createGain();
      m.gainNode.gain.value = m.gain;
      m.node.connect(m.gainNode);
      m.gainNode.connect(this.input); // never to the speakers — no feedback
      this.source = 'mic';
    }

    stopMic() {
      const m = this.mic;
      if (!m.stream) return;
      m.stream.getTracks().forEach((t) => t.stop());
      m.node.disconnect();
      m.gainNode.disconnect();
      m.stream = m.node = m.gainNode = null;
      if (this.source === 'mic') this.source = null;
    }

    setMicGain(g) {
      this.mic.gain = g;
      if (this.mic.gainNode) this.mic.gainNode.gain.setTargetAtTime(g, this.ctx.currentTime, 0.03);
    }

    // ------------------------------------------------------------ analysis
    analyze(dt) {
      const F = this.features;
      F.onset = 0;
      if (!this.ctx || !this.source) {
        F.active = false;
        F.level = F.low = F.mid = F.high = 0;
        return F;
      }
      F.active = true;

      const an = this.analyser;
      const db = this.db, mag = this.mag, prev = this.prev, wave = this.wave;
      an.getFloatFrequencyData(db);
      an.getFloatTimeDomainData(wave);

      let s = 0;
      for (let i = 0; i < wave.length; i++) s += wave[i] * wave[i];
      const rms = Math.sqrt(s / wave.length);

      const binHz = this.binHz;
      const maxBin = Math.min(mag.length - 2, Math.floor(16000 / binHz));
      let eL = 0, eM = 0, eH = 0;
      let pL = 0, iL = 0, pM = 0, iM = 0, pH = 0, iH = 0, pk = 0, ipk = 0;
      let cn = 0, cd = 0, flux = 0;

      for (let i = 1; i <= maxBin; i++) {
        const f = i * binHz;
        const m = Math.pow(10, db[i] / 20); // -Infinity dB → 0
        mag[i] = m;
        const d = m - prev[i];
        if (d > 0) flux += d;
        prev[i] = m;
        if (f < 30) continue;
        const e = m * m;
        if (f < 250) {
          eL += e;
          if (m > pL) { pL = m; iL = i; }
        } else if (f < 2000) {
          eM += e;
          if (m > pM) { pM = m; iM = i; }
        } else {
          eH += e;
          if (m > pH) { pH = m; iH = i; }
        }
        if (f < 12000) { cn += f * m; cd += m; }
        if (f < 8000 && m > pk) { pk = m; ipk = i; }
      }

      const silent = rms < 0.0015;

      // band levels share one slow automatic gain so their proportions survive
      const bL = Math.sqrt(eL), bM = Math.sqrt(eM) * 1.4, bH = Math.sqrt(eH) * 2.6;
      const top = Math.max(bL, bM, bH);
      this.hold.band = Math.max(top, this.hold.band * Math.pow(0.5, dt / 6));
      const bandNorm = Math.max(this.hold.band, 0.02);
      const kb = 1 - Math.exp(-dt * 14);
      F.low += ((silent ? 0 : clamp(bL / bandNorm, 0, 1)) - F.low) * kb;
      F.mid += ((silent ? 0 : clamp(bM / bandNorm, 0, 1)) - F.mid) * kb;
      F.high += ((silent ? 0 : clamp(bH / bandNorm, 0, 1)) - F.high) * kb;

      // loudness
      this.hold.rms = Math.max(rms, this.hold.rms * Math.pow(0.5, dt / 8));
      const level = silent ? 0 : Math.pow(clamp(rms / Math.max(this.hold.rms, 0.03), 0, 1), 0.8);
      F.delta = level - F.level;
      F.rms = rms;
      F.level = level;

      // pitch-like features
      const interp = (i) => {
        if (i <= 1) return i * binHz;
        const a = db[i - 1], b = db[i], c = db[i + 1];
        const den = a - 2 * b + c;
        const p = den !== 0 ? (0.5 * (a - c)) / den : 0;
        return Number.isFinite(p) ? (i + clamp(p, -0.5, 0.5)) * binHz : i * binHz;
      };
      if (!silent) {
        F.dominantHz = ipk ? interp(ipk) : 0;
        F.lowHz = iL ? interp(iL) : 0;
        F.midHz = iM ? interp(iM) : 0;
        F.highHz = iH ? interp(iH) : 0;
        F.lowPk = pk ? clamp(pL / pk, 0, 1) : 0;
        F.midPk = pk ? clamp(pM / pk, 0, 1) : 0;
        F.highPk = pk ? clamp(pH / pk, 0, 1) : 0;
        if (cd > 0) {
          F.centroidHz = cn / cd;
          F.centroidN = clamp(Math.log(F.centroidHz / 100) / Math.log(80), 0, 1);
        }
      } else {
        F.dominantHz = 0;
      }

      // transients: spectral flux against its own running average
      const now = this.ctx.currentTime;
      const avg = this.hold.fluxAvg;
      F.flux = flux;
      if (!silent && avg > 0 && flux > avg * 1.7 && flux > 0.02 && level > 0.08 && now - this.lastOnset > 0.14) {
        F.onset = clamp((flux / avg - 1.7) / 2.5 + 0.25, 0, 1);
        this.lastOnset = now;
      }
      this.hold.fluxAvg = avg * 0.92 + flux * 0.08;

      return F;
    }
  }

  global.Cymatics = global.Cymatics || {};
  global.Cymatics.AudioEngine = AudioEngine;
})(window);
