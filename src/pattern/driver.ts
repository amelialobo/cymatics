/**
 * Sound → plate. Turns audio features into mode targets and vibration.
 *
 *  dominant pitch     → the plate's forced response at that frequency (see plates.ts)
 *  tone generator     → the same, from the oscillator's exact frequency and
 *                       overtones, so one pitch always makes one figure
 *  low / mid / high   → extra modes layered on top: broad cells, crossings, fine lattice
 *  loudness           → vibration: how hard the sand is thrown
 *  spectral centroid  → spacing and squareness of the rings around the bolt
 *  transients         → kicks that scatter sand off the lines
 *  steady pitch       → the sand settles into tighter lines
 */
import type { AudioFeatures, SourceKind, Waveform } from '../audio/AudioEngine';
import type { VisualParams } from '../core/store';
import { PURE, type ModeBank } from './modes';
import { resonances, type Plate } from './plates';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/**
 * the plate's κ that resonates at a frequency (before complexity scaling). Like
 * a steel plate about 66 cm across and 1 mm thick: frequency ∝ κ.
 */
const HZ_PER_LAM = 22 / (Math.PI * Math.PI);
export const lamFromHz = (hz: number) => hz / HZ_PER_LAM;
export const hzFromLam = (lam: number) => lam * HZ_PER_LAM;

/** complexity 0..100 → pitch multiplier (audio drive) */
export const complexityMult = (c: number) => Math.pow(2.8, (c - 50) / 50);
/** complexity 0..100 → κ (manual drive) */
export const manualLambda = (c: number) => 2 * Math.PI * Math.PI * Math.pow(160, c / 100);


/** Fourier series of each waveform: amplitude of harmonic k+1 relative to the fundamental */
const HARMONICS: Partial<Record<Waveform, readonly number[]>> = {
  sine: PURE,
  triangle: [1, 0, 1 / 9, 0, 1 / 25, 0, 1 / 49],
  square: [1, 0, 1 / 3, 0, 1 / 5, 0, 1 / 7, 0, 1 / 9],
  sawtooth: [1, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 7, 1 / 8],
};

export interface ToneState { running: boolean; freq: number; wave: Waveform }

export class PatternDriver {
  /** vibration amplitude */
  V = 0;
  /** transient kick, decays quickly */
  kick = 0;
  /** closeness to an exact resonance */
  res = 0;
  /** 0 → 1 after sound begins: complexity is introduced gradually */
  warm = 0;
  /** 0 → 1 while pitch holds steady: sand settles into tighter lines */
  stability = 0;

  private smooth = { dom: 0, low: 0, mid: 0, high: 0 };
  /** the plate the resting figure was set for (cleared while sound has it) */
  private ambient = { plate: null as Plate | null, holdUntil: 0, shown: false };
  /** true while no sound has the plate: it holds its resting figure */
  idle = true;
  /** true while the stopped tone's slider sets the figure (no sound) */
  silentTone = false;
  private silentFor = 99;
  private prevDom = 0;
  /** set once the tone has been played or its pitch moved: from then on the stopped tone still shapes the plate */
  private toneTouched = false;
  private lastToneFreq = NaN;

  constructor(private bank: ModeBank, private reducedMotion: boolean) {}

  private follow(key: keyof PatternDriver['smooth'], hz: number, dt: number, rate: number) {
    if (!(hz > 20)) return this.smooth[key];
    const cur = this.smooth[key];
    if (!cur) return (this.smooth[key] = hz);
    const k = 1 - Math.exp(-dt * rate);
    return (this.smooth[key] = Math.exp(Math.log(cur) + (Math.log(hz) - Math.log(cur)) * k));
  }

  update(dt: number, t: number, F: AudioFeatures, p: VisualParams, source: SourceKind | null, tone: ToneState, toneTab = false) {
    const sounding = F.active && F.level > 0.02 && F.dominantHz > 20;
    if (sounding) {
      // after a pause, start again from a simple formation
      if (this.silentFor > 2.5) this.warm = 0;
      this.silentFor = 0;
    } else this.silentFor += dt;
    this.warm = Math.min(1, this.warm + dt / (source === 'tone' ? 0.35 : 1.5));

    if (tone.running || (this.lastToneFreq === this.lastToneFreq && tone.freq !== this.lastToneFreq)) this.toneTouched = true;
    this.lastToneFreq = tone.freq;
    // on the tone panel with nothing playing, the pitch slider still sets the figure, silently
    const silentTone = (this.silentTone = toneTab && this.toneTouched && !tone.running && !F.active);

    if (p.drive === 'manual') this.driveManual(dt, F, p);
    else if (source === 'tone' && tone.running) this.driveTone(dt, t, F, p, tone);
    else if (F.active) this.driveAudio(dt, t, F, p, source, sounding);
    else if (silentTone) this.driveSilentTone(dt, t, p, tone);
    else this.driveAmbient(dt, t);
    this.idle = p.drive !== 'manual' && !(source === 'tone' && tone.running) && !silentTone && !F.active && t > this.ambient.holdUntil;

    if (this.reducedMotion) {
      this.V = Math.min(this.V, 0.45);
      this.kick = Math.min(this.kick, 0.1);
    }
  }

  private approachV(Vt: number, dt: number) {
    // rise quickly; when sound fades, let the plate come to rest gradually
    const rate = Vt > this.V ? 10 : 1.8;
    this.V += (Vt - this.V) * (1 - Math.exp(-dt * rate));
  }

  private driveAudio(dt: number, t: number, F: AudioFeatures, p: VisualParams, source: SourceKind | null, sounding: boolean) {
    const bank = this.bank;
    if (sounding) {
      const mult = complexityMult(p.complexity);
      const dom = this.follow('dom', F.dominantHz, dt, source === 'tone' ? 40 : 12);
      const low = this.follow('low', F.lowHz, dt, 10);
      const mid = this.follow('mid', F.midHz, dt, 10);
      const high = this.follow('high', F.highHz, dt, 10);

      // begin simple, then let the true pitch through
      const lamDom = lamFromHz(dom) * mult;
      const lamUsed = Math.min(lamDom, 5) + (lamDom - Math.min(lamDom, 5)) * this.warm;

      bank.clearTargets();
      this.res = bank.excite(lamUsed, 1);
      // a band layers its own modes only when it has a peak of its own (not leakage)
      const own = (pk: number) => clamp(pk * 4 - 0.15, 0, 1);
      const w = this.warm;
      bank.excite(lamFromHz(low) * mult, F.low * own(F.lowPk) * 0.55 * w);
      bank.excite(lamFromHz(mid) * mult, F.mid * own(F.midPk) * 0.4 * w);
      bank.excite(lamFromHz(high) * mult, F.high * own(F.highPk) * 0.45 * w);
      bank.setRadial(0.12 + 0.35 * F.low, 1.4 + F.centroidN * 9, 2.1 + F.centroidN * 2.2);

      // a held pitch lets the sand settle
      const change = this.prevDom ? Math.abs(Math.log(dom / this.prevDom)) / Math.max(dt, 1e-3) : 1;
      this.prevDom = dom;
      const steady = change < 0.15 && F.fluxRatio < 1.6 ? 1 : 0;
      this.stability += (steady - this.stability) * (1 - Math.exp(-dt * (steady ? 1.2 : 5)));
    }
    const Vt = clamp(F.level, 0, 1.4) * (0.45 + 0.55 * this.res) + Math.max(0, F.delta) * 2;
    this.approachV(Vt, dt);
    this.kick = Math.max(this.kick * Math.exp(-dt * 9), F.onset);
    this.ambient.holdUntil = t + 3;
    this.ambient.plate = null;
  }

  /**
   * The tone generator: its frequency is known exactly, so the figure is the
   * plate's response to that frequency alone, the same every time.
   */
  private driveTone(dt: number, t: number, F: AudioFeatures, p: VisualParams, tone: ToneState) {
    this.toneFigure(dt, p, tone);
    const Vt = clamp(F.level, 0, 1.4) * (0.45 + 0.55 * this.res) + Math.max(0, F.delta) * 2;
    this.approachV(Vt, dt);
    this.kick = Math.max(this.kick * Math.exp(-dt * 9), F.onset);
    this.ambient.holdUntil = t + 3;
    this.ambient.plate = null;
  }

  /** the stopped tone: the same figure for the slider's pitch, shaken gently as if at rest */
  private driveSilentTone(dt: number, t: number, p: VisualParams, tone: ToneState) {
    this.toneFigure(dt, p, tone);
    const Vt = this.reducedMotion ? 0.25 : 0.38 + 0.08 * Math.sin(t * 0.37);
    this.V += (Vt - this.V) * (1 - Math.exp(-dt * 1.5));
    this.kick *= Math.exp(-dt * 6);
    this.ambient.holdUntil = t + 3;
    this.ambient.plate = null;
  }

  private toneFigure(dt: number, p: VisualParams, tone: ToneState) {
    const bank = this.bank;
    bank.clearTargets();
    this.res = bank.excite(lamFromHz(tone.freq) * complexityMult(p.complexity), 1, HARMONICS[tone.wave] ?? PURE);
    bank.setRadial(0, 3, 2.6);
    this.warm = 1;

    // a held pitch lets the sand settle
    const hz = tone.freq;
    const change = this.prevDom ? Math.abs(Math.log(hz / this.prevDom)) / Math.max(dt, 1e-3) : 1;
    this.prevDom = hz;
    const steady = change < 0.15 ? 1 : 0;
    this.stability += (steady - this.stability) * (1 - Math.exp(-dt * (steady ? 1.2 : 5)));
  }

  private driveManual(dt: number, F: AudioFeatures, p: VisualParams) {
    const bank = this.bank;
    bank.clearTargets();
    this.res = bank.excite(manualLambda(p.complexity), 1);
    bank.setRadial(0.22, 1.5 + p.complexity * 0.07, 2.7);
    // sound still shakes the plate, but no longer chooses the figure
    const Vt = F.active ? 0.2 + 0.8 * F.level : 0.5;
    this.approachV(Vt, dt);
    this.kick = Math.max(this.kick * Math.exp(-dt * 9), F.active ? F.onset * 0.6 : 0);
    this.stability += (1 - this.stability) * (1 - Math.exp(-dt * 0.5));
  }

  /** no source yet: the plate rests in one of its own resonant figures */
  private driveAmbient(dt: number, t: number) {
    const a = this.ambient;
    const bank = this.bank;
    if (t > a.holdUntil && a.plate !== bank.plate) {
      a.plate = bank.plate;
      // a resonance near 330 Hz: neither too plain nor too fine
      const lam = resonances(bank.plate, lamFromHz(250), lamFromHz(450), 1)[0] ?? lamFromHz(330);
      bank.clearTargets();
      this.res = bank.excite(lam, 1);
      bank.setRadial(0, 3, 2.6);
      if (a.shown) this.kick = Math.max(this.kick, 0.25);
      a.shown = true;
    }
    const Vt = this.reducedMotion ? 0.25 : 0.38 + 0.08 * Math.sin(t * 0.37);
    this.V += (Vt - this.V) * (1 - Math.exp(-dt * 1.5));
    this.kick *= Math.exp(-dt * 6);
    this.stability += (0.6 - this.stability) * (1 - Math.exp(-dt));
  }
}
