/**
 * Sound → plate. Turns audio features into mode targets and vibration.
 *
 *  dominant pitch     → main eigenmode (higher pitch, higher mode)
 *  low / mid / high   → extra modes layered on top: broad cells, crossings, fine lattice
 *  loudness           → vibration: how hard the sand is thrown
 *  spectral centroid  → spacing and squareness of the rings around the bolt
 *  transients         → kicks that scatter sand off the lines
 *  steady pitch       → the sand settles into tighter lines
 */
import type { AudioFeatures, SourceKind } from '../audio/AudioEngine';
import type { VisualParams } from '../core/store';
import type { ModeBank } from './modes';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** the plate eigenvalue that resonates at a frequency (before complexity scaling) */
export const lamFromHz = (hz: number) => hz / 22;
export const hzFromLam = (lam: number) => lam * 22;

/** complexity 0..100 → pitch multiplier (audio drive) */
export const complexityMult = (c: number) => Math.pow(2.8, (c - 50) / 50);
/** complexity 0..100 → eigenvalue (manual drive) */
export const manualLambda = (c: number) => 2 * Math.pow(160, c / 100);

const AMBIENT_LAMS = [5, 10, 13, 17, 20, 25, 29, 34, 41, 45, 52, 58, 65, 74, 85];

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
  private ambient = { lam: 0, next: 0, holdUntil: 0 };
  private silentFor = 99;
  private prevDom = 0;

  constructor(private bank: ModeBank, private reducedMotion: boolean) {}

  private follow(key: keyof PatternDriver['smooth'], hz: number, dt: number, rate: number) {
    if (!(hz > 20)) return this.smooth[key];
    const cur = this.smooth[key];
    if (!cur) return (this.smooth[key] = hz);
    const k = 1 - Math.exp(-dt * rate);
    return (this.smooth[key] = Math.exp(Math.log(cur) + (Math.log(hz) - Math.log(cur)) * k));
  }

  update(dt: number, t: number, F: AudioFeatures, p: VisualParams, source: SourceKind | null) {
    const sounding = F.active && F.level > 0.02 && F.dominantHz > 20;
    if (sounding) {
      // after a pause, start again from a simple formation
      if (this.silentFor > 2.5) this.warm = 0;
      this.silentFor = 0;
    } else this.silentFor += dt;
    this.warm = Math.min(1, this.warm + dt / (source === 'tone' ? 1.2 : 4));

    if (p.drive === 'manual') this.driveManual(dt, F, p);
    else if (F.active) this.driveAudio(dt, t, F, p, source, sounding);
    else this.driveAmbient(dt, t);

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
      const dom = this.follow('dom', F.dominantHz, dt, source === 'tone' ? 30 : 7);
      const low = this.follow('low', F.lowHz, dt, 6);
      const mid = this.follow('mid', F.midHz, dt, 6);
      const high = this.follow('high', F.highHz, dt, 6);

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
      this.stability += (steady - this.stability) * (1 - Math.exp(-dt * (steady ? 0.5 : 5)));
    }
    const Vt = clamp(F.level, 0, 1.4) * (0.45 + 0.55 * this.res) + Math.max(0, F.delta) * 2;
    this.approachV(Vt, dt);
    this.kick = Math.max(this.kick * Math.exp(-dt * 9), F.onset);
    this.ambient.holdUntil = t + 3;
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

  /** no source yet: a slow idle drive keeps the installation alive */
  private driveAmbient(dt: number, t: number) {
    const a = this.ambient;
    if (t > a.next && t > a.holdUntil) {
      let lam: number;
      do lam = AMBIENT_LAMS[(Math.random() * AMBIENT_LAMS.length) | 0];
      while (lam === a.lam);
      const first = a.lam === 0;
      a.lam = lam;
      a.next = t + 9 + Math.random() * 6;
      const bank = this.bank;
      bank.clearTargets();
      this.res = bank.excite(lam, 1);
      if (Math.random() < 0.45) bank.excite(lam * (1.8 + Math.random() * 0.8), 0.35);
      bank.setRadial(0.2 + Math.random() * 0.25, 2 + Math.random() * 5, 2.3 + Math.random() * 1.5);
      if (!first) this.kick = Math.max(this.kick, 0.25);
    }
    const Vt = this.reducedMotion ? 0.25 : 0.38 + 0.08 * Math.sin(t * 0.37);
    this.V += (Vt - this.V) * (1 - Math.exp(-dt * 1.5));
    this.kick *= Math.exp(-dt * 6);
    this.stability += (0.6 - this.stability) * (1 - Math.exp(-dt));
  }
}
