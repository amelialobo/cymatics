/**
 * Audio input and analysis.
 * Three sources (microphone, file, tone generator) feed a single AnalyserNode.
 * `analyze()` is called once per animation frame and turns the spectrum into
 * the features that drive the plate.
 */

export type SourceKind = 'live' | 'file' | 'tone';
export type Waveform = OscillatorType;

export interface AudioFeatures {
  active: boolean;
  rms: number;
  /** loudness, 0..1 after slow automatic gain */
  level: number;
  /** change in level since the previous frame */
  delta: number;
  low: number;
  mid: number;
  high: number;
  lowHz: number;
  midHz: number;
  highHz: number;
  /** each band's peak relative to the loudest peak: tells a real voice from leakage */
  lowPk: number;
  midPk: number;
  highPk: number;
  dominantHz: number;
  centroidHz: number;
  /** centroid on a 0..1 log scale between 100 Hz and 8 kHz */
  centroidN: number;
  /** positive spectral flux relative to its running average */
  fluxRatio: number;
  /** transient strength this frame (0 if none) */
  onset: number;
  mag: Float32Array | null;
  binHz: number;
}

export type MicStatus = 'off' | 'requesting' | 'on' | 'denied' | 'unavailable';

export interface AudioSnapshot {
  source: SourceKind | null;
  tone: { running: boolean; freq: number; wave: Waveform; amp: number; listen: boolean };
  mic: { status: MicStatus; message: string };
  file: { name: string; loaded: boolean; playing: boolean; duration: number; time: number };
}

const FFT_SIZE = 4096;
export const TONE_MIN = 20;
export const TONE_MAX = 2000;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private input!: GainNode;
  private analyser!: AnalyserNode;
  private db!: Float32Array<ArrayBuffer>;
  private mag!: Float32Array<ArrayBuffer>;
  private prev!: Float32Array<ArrayBuffer>;
  private wave!: Float32Array<ArrayBuffer>;
  private binHz = 0;

  private osc: OscillatorNode | null = null;
  private toneEnv: GainNode | null = null;
  private toneMon: GainNode | null = null;

  private fileEl: HTMLAudioElement | null = null;
  private fileNode: MediaElementAudioSourceNode | null = null;
  private fileMon: GainNode | null = null;
  private fileUrl: string | null = null;
  private fileVolume = 0.8;

  private micStream: MediaStream | null = null;
  private micNode: MediaStreamAudioSourceNode | null = null;
  private micGain: GainNode | null = null;
  private micGainValue = 2;

  private hold = { band: 0.05, rms: 0.05, fluxAvg: 0 };
  private lastOnset = 0;
  private listeners = new Set<() => void>();
  private fileTimer = 0;

  state: AudioSnapshot = {
    source: null,
    tone: { running: false, freq: 220, wave: 'sine', amp: 0.5, listen: true },
    mic: { status: 'off', message: '' },
    file: { name: '', loaded: false, playing: false, duration: 0, time: 0 },
  };

  features: AudioFeatures = {
    active: false,
    rms: 0, level: 0, delta: 0,
    low: 0, mid: 0, high: 0,
    lowHz: 0, midHz: 0, highHz: 0,
    lowPk: 0, midPk: 0, highPk: 0,
    dominantHz: 0, centroidHz: 0, centroidN: 0,
    fluxRatio: 1, onset: 0,
    mag: null, binHz: 0,
  };

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(patch?: Partial<AudioSnapshot>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  private init(): AudioContext {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) throw new Error('Web Audio is not supported in this browser.');
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
    return ctx;
  }

  private stopAll(except?: SourceKind) {
    if (except !== 'tone') this.stopTone();
    if (except !== 'file') this.pauseFile();
    if (except !== 'live') this.stopMic();
  }

  // ------------------------------------------------------------------ tone
  startTone() {
    const ctx = this.init();
    this.stopAll('tone');
    if (this.osc) return;
    const t = ctx.currentTime;
    if (!this.toneEnv) {
      this.toneEnv = ctx.createGain();
      this.toneEnv.gain.value = 0;
      this.toneMon = ctx.createGain();
      this.toneMon.gain.value = this.state.tone.listen ? 1 : 0;
      this.toneEnv.connect(this.input);
      this.toneEnv.connect(this.toneMon);
      this.toneMon.connect(ctx.destination);
    }
    const osc = (this.osc = ctx.createOscillator());
    osc.type = this.state.tone.wave;
    osc.frequency.value = this.state.tone.freq;
    osc.connect(this.toneEnv);
    osc.start();
    const g = this.toneEnv.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(this.state.tone.amp, t + 0.08);
    this.emit({ source: 'tone', tone: { ...this.state.tone, running: true } });
  }

  stopTone() {
    if (!this.osc || !this.ctx || !this.toneEnv) return;
    const t = this.ctx.currentTime;
    const g = this.toneEnv.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + 0.08);
    const osc = this.osc;
    osc.stop(t + 0.1);
    osc.onended = () => osc.disconnect();
    this.osc = null;
    this.emit({
      source: this.state.source === 'tone' ? null : this.state.source,
      tone: { ...this.state.tone, running: false },
    });
  }

  toggleTone() {
    if (this.state.tone.running) this.stopTone();
    else this.startTone();
  }

  setToneFreq(f: number) {
    const freq = clamp(f, TONE_MIN, TONE_MAX);
    if (this.osc && this.ctx) this.osc.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.02);
    this.emit({ tone: { ...this.state.tone, freq } });
  }

  setToneWave(wave: Waveform) {
    if (this.osc) this.osc.type = wave;
    this.emit({ tone: { ...this.state.tone, wave } });
  }

  setToneAmp(amp: number) {
    if (this.osc && this.ctx && this.toneEnv) this.toneEnv.gain.setTargetAtTime(amp, this.ctx.currentTime, 0.03);
    this.emit({ tone: { ...this.state.tone, amp } });
  }

  setToneListen(listen: boolean) {
    if (this.toneMon && this.ctx) this.toneMon.gain.setTargetAtTime(listen ? 1 : 0, this.ctx.currentTime, 0.02);
    this.emit({ tone: { ...this.state.tone, listen } });
  }

  // ------------------------------------------------------------------ file
  /** Loads a file without playing it: playback always starts from a user action. */
  loadFile(file: File) {
    const ctx = this.init();
    this.stopAll('file');
    if (!this.fileEl) {
      const el = (this.fileEl = new Audio());
      el.loop = true;
      el.preload = 'auto';
      this.fileNode = ctx.createMediaElementSource(el);
      this.fileMon = ctx.createGain();
      this.fileMon.gain.value = this.fileVolume;
      this.fileNode.connect(this.input);
      this.fileNode.connect(this.fileMon);
      this.fileMon.connect(ctx.destination);
      el.addEventListener('loadedmetadata', () => this.emit({ file: { ...this.state.file, duration: el.duration } }));
      el.addEventListener('play', () => this.emit({ source: 'file', file: { ...this.state.file, playing: true } }));
      el.addEventListener('pause', () =>
        this.emit({
          source: this.state.source === 'file' ? null : this.state.source,
          file: { ...this.state.file, playing: false },
        })
      );
      el.addEventListener('error', () =>
        this.emit({ file: { ...this.state.file, loaded: false, playing: false, name: 'This browser cannot decode that file.' } })
      );
      // ~4 Hz progress updates are plenty for the seek bar
      this.fileTimer = window.setInterval(() => {
        if (el && !el.paused) this.emit({ file: { ...this.state.file, time: el.currentTime } });
      }, 250);
    }
    if (this.fileUrl) URL.revokeObjectURL(this.fileUrl);
    this.fileUrl = URL.createObjectURL(file);
    this.fileEl.src = this.fileUrl;
    this.emit({ file: { name: file.name, loaded: true, playing: false, duration: 0, time: 0 } });
  }

  async playFile() {
    if (!this.fileEl || !this.fileUrl) return;
    this.init();
    this.stopAll('file');
    await this.fileEl.play();
  }

  pauseFile() {
    if (this.fileEl && !this.fileEl.paused) this.fileEl.pause();
  }

  toggleFile() {
    if (!this.fileEl || !this.state.file.loaded) return Promise.resolve();
    if (this.fileEl.paused) return this.playFile();
    this.pauseFile();
    return Promise.resolve();
  }

  seekFile(fraction: number) {
    const el = this.fileEl;
    if (!el || !Number.isFinite(el.duration)) return;
    el.currentTime = clamp(fraction, 0, 1) * el.duration;
    this.emit({ file: { ...this.state.file, time: el.currentTime } });
  }

  setFileVolume(v: number) {
    this.fileVolume = v;
    if (this.fileMon && this.ctx) this.fileMon.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  // ------------------------------------------------------------------- mic
  /** Only ever called from a click: the permission prompt follows a user action. */
  async startMic() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.emit({ mic: { status: 'unavailable', message: 'Microphone access needs a secure page (https or localhost).' } });
      return;
    }
    const ctx = this.init();
    this.emit({ mic: { status: 'requesting', message: 'Waiting for permission…' } });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.stopAll('live');
      this.micStream = stream;
      this.micNode = ctx.createMediaStreamSource(stream);
      this.micGain = ctx.createGain();
      this.micGain.gain.value = this.micGainValue;
      this.micNode.connect(this.micGain);
      this.micGain.connect(this.input); // never to the speakers: no feedback
      stream.getAudioTracks()[0]?.addEventListener('ended', () => this.stopMic());
      this.emit({ source: 'live', mic: { status: 'on', message: 'Listening. Nothing is recorded or sent.' } });
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        this.emit({ mic: { status: 'denied', message: 'Permission declined. Allow microphone access in the browser’s site settings, then try again.' } });
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        this.emit({ mic: { status: 'unavailable', message: 'No microphone was found.' } });
      } else if (name === 'NotReadableError') {
        this.emit({ mic: { status: 'unavailable', message: 'The microphone is in use by another application.' } });
      } else {
        this.emit({ mic: { status: 'unavailable', message: 'Microphone unavailable: ' + ((err as Error)?.message || name) } });
      }
    }
  }

  stopMic() {
    if (!this.micStream) return;
    this.micStream.getTracks().forEach((t) => t.stop());
    this.micNode?.disconnect();
    this.micGain?.disconnect();
    this.micStream = null;
    this.micNode = null;
    this.micGain = null;
    this.emit({
      source: this.state.source === 'live' ? null : this.state.source,
      mic: { status: 'off', message: '' },
    });
  }

  setMicGain(g: number) {
    this.micGainValue = g;
    if (this.micGain && this.ctx) this.micGain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.03);
  }

  // -------------------------------------------------------------- analysis
  analyze(dt: number): AudioFeatures {
    const F = this.features;
    F.onset = 0;
    if (!this.ctx || !this.state.source) {
      F.active = false;
      F.level = F.low = F.mid = F.high = F.delta = 0;
      return F;
    }
    F.active = true;

    const { db, mag, prev, wave, binHz } = this;
    this.analyser.getFloatFrequencyData(db);
    this.analyser.getFloatTimeDomainData(wave);

    let s = 0;
    for (let i = 0; i < wave.length; i++) s += wave[i] * wave[i];
    const rms = Math.sqrt(s / wave.length);

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

    // the bands share one slow automatic gain so their proportions survive
    const bL = Math.sqrt(eL), bM = Math.sqrt(eM) * 1.4, bH = Math.sqrt(eH) * 2.6;
    this.hold.band = Math.max(bL, bM, bH, this.hold.band * Math.pow(0.5, dt / 6));
    const bandNorm = Math.max(this.hold.band, 0.02);
    const kb = 1 - Math.exp(-dt * 14);
    F.low += ((silent ? 0 : clamp(bL / bandNorm, 0, 1)) - F.low) * kb;
    F.mid += ((silent ? 0 : clamp(bM / bandNorm, 0, 1)) - F.mid) * kb;
    F.high += ((silent ? 0 : clamp(bH / bandNorm, 0, 1)) - F.high) * kb;

    this.hold.rms = Math.max(rms, this.hold.rms * Math.pow(0.5, dt / 8));
    const level = silent ? 0 : Math.pow(clamp(rms / Math.max(this.hold.rms, 0.03), 0, 1), 0.8);
    F.delta = level - F.level;
    F.rms = rms;
    F.level = level;

    const interp = (i: number) => {
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
    F.fluxRatio = avg > 1e-6 ? flux / avg : 1;
    if (!silent && avg > 0 && flux > avg * 1.7 && flux > 0.02 && level > 0.08 && now - this.lastOnset > 0.14) {
      F.onset = clamp((flux / avg - 1.7) / 2.5 + 0.25, 0, 1);
      this.lastOnset = now;
    }
    this.hold.fluxAvg = avg * 0.92 + flux * 0.08;
    return F;
  }

  dispose() {
    this.stopTone();
    this.stopMic();
    window.clearInterval(this.fileTimer);
    if (this.fileEl) {
      this.fileEl.pause();
      this.fileEl.removeAttribute('src');
      this.fileEl.load();
    }
    if (this.fileUrl) URL.revokeObjectURL(this.fileUrl);
    this.fileNode?.disconnect();
    this.fileMon?.disconnect();
    this.toneEnv?.disconnect();
    this.toneMon?.disconnect();
    void this.ctx?.close();
    this.ctx = null;
    this.listeners.clear();
  }
}
