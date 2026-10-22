/**
 * The plate's displacement: a weighted sum of its eigenmodes (see plates.ts for
 * the physics), plus an optional concentric term around the drive bolt. Sand
 * collects where the sum is zero (the nodal lines). Every formula here is
 * mirrored in the GLSL field shader (render/shaders.ts), so the CPU can
 * normalise the field and drive the fallback renderer.
 */
import { getPlate, shape, type Mode, type Plate } from './plates';

export type { Mode } from './plates';

export type Symmetry = 'square' | 'mirror' | 'fixed' | 'radial';

export const SYMMETRIES: { id: Symmetry; label: string; hint: string }[] = [
  { id: 'square', label: 'Classic', hint: 'A square steel plate, free at its edges and shaken from the centre: the classic Chladni demonstration.' },
  { id: 'mirror', label: 'Mirror', hint: 'A square of wood, stiffer along its grain, so the figures mirror left to right and top to bottom but lose their diagonals.' },
  { id: 'fixed', label: 'Chladni', hint: 'A square plate pinned along its edges: the textbook plate equation, solved exactly.' },
  { id: 'radial', label: 'Rings', hint: 'A round plate shaken from its centre. Only rings can form, spaced as Chladni’s law predicts.' },
];

export const SYM_INDEX: Record<Symmetry, number> = { square: 0, mirror: 1, fixed: 2, radial: 3 };

export const MAX_ACTIVE = 24;
const PI = Math.PI;
/** damping ratio of the plate: sets how sharply it resonates */
const DAMPING = 0.025;

/** Fixed, smooth irregularities of a physical plate (shared with the shader). */
export const NOISE_WAVES: [number, number, number, number][] = (() => {
  let seed = 1234567;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const w: [number, number, number, number][] = [];
  for (let i = 0; i < 8; i++) w.push([(r() * 2 - 1) * 5, (r() * 2 - 1) * 5, r() * PI * 2, 0.4 + r() * 0.6]);
  const total = w.reduce((a, x) => a + x[3], 0);
  return w.map(([ax, ay, ph, a]) => [ax, ay, ph, a / total] as [number, number, number, number]);
})();

export const WARP = 0.007;
export const NOISE_AMT = 0.05;

/** relative amplitudes of a tone's harmonics (index 0 is the fundamental) */
export const PURE = [1] as const;

export class ModeBank {
  plate!: Plate;
  /** current and target weight of each mode's unit-norm shape (signed: phase matters) */
  w = new Float32Array(0);
  target = new Float32Array(0);
  readonly radial = { w: 0, k: 3, p: 2.6, tw: 0, tk: 3, tp: 2.6 };
  /** normalisation factor so the field spans -1..1 */
  norm = 1;
  /** the active modes packed for the shader: n, m, s, w */
  readonly packed = new Float32Array(MAX_ACTIVE * 4);
  activeCount = 0;
  /** which mode fills each packed slot */
  private readonly slot = new Int32Array(MAX_ACTIVE);
  /** what is driving the plate, replayed if the plate is swapped */
  private drives: [number, number, readonly number[]][] = [];

  constructor(sym: Symmetry = 'square') {
    this.setPlate(sym);
  }

  get modes(): Mode[] {
    return this.plate.modes;
  }

  get maxLam() {
    const md = this.plate.modes;
    return md[md.length - 1].lam;
  }

  /** swap to another plate: the same drive now shakes it into its own figure */
  setPlate(sym: Symmetry) {
    if (this.plate?.sym === sym) return;
    this.plate = getPlate(sym);
    const L = this.plate.modes.length;
    this.w = new Float32Array(L);
    this.target = new Float32Array(L);
    const drives = this.drives;
    this.drives = [];
    for (const [lam, strength, harm] of drives) this.excite(lam, strength, harm);
    this.w.set(this.target);
    this.activeCount = 0;
  }

  clearTargets() {
    this.target.fill(0);
    this.drives.length = 0;
  }

  /**
   * Drive the plate from its centre at frequency κ = `lamT`. Every mode
   * responds by its forced-response amplitude ψ(0) / (κᵢ² − κ² + 2iζκᵢκ); the
   * figure is that sum, seen at the phase where the plate moves most.
   *
   * `harmonics` are the tone's overtones: the one the plate answers most
   * strongly sets the figure (a square wave's third harmonic can take over
   * between resonances, as on a real plate).
   *
   * Returns how close the drive is to an exact resonance (0..1).
   */
  excite(lamT: number, strength: number, harmonics: readonly number[] = PURE): number {
    if (!(strength > 0.001) || !(lamT > 0)) return 0;
    this.drives.push([lamT, strength, harmonics]);
    const { modes } = this.plate;
    const top = this.maxLam;
    let bestAmp = 0, bestLam = 0, bestI = -1, bestRe = 0, bestIm = 0;
    for (let h = 0; h < harmonics.length; h++) {
      const a = harmonics[h];
      const lam = Math.min(lamT * (h + 1), top);
      if (!(a > 0) || (h > 0 && lamT * (h + 1) > top)) continue;
      for (let i = 0; i < modes.length; i++) {
        const md = modes[i];
        const re = md.lam * md.lam - lam * lam, im = 2 * DAMPING * md.lam * lam;
        const amp = (a * Math.abs(md.c)) / Math.hypot(re, im);
        if (amp > bestAmp) {
          bestAmp = amp;
          bestLam = lam;
          bestI = i;
          bestRe = re;
          bestIm = im;
        }
      }
    }
    if (bestI < 0) return 0;
    // coefficient of the strongest mode, and its phase
    const d = modes[bestI], dd = bestRe * bestRe + bestIm * bestIm;
    const dr = (d.c * bestRe) / dd, di = (-d.c * bestIm) / dd;
    const dm = Math.hypot(dr, di);
    const lam = bestLam;
    for (let i = 0; i < modes.length; i++) {
      const md = modes[i];
      const re = md.lam * md.lam - lam * lam, im = 2 * DAMPING * md.lam * lam;
      const q = re * re + im * im;
      const ar = (md.c * re) / q, ai = (-md.c * im) / q;
      // project onto the dominant phase: the snapshot when the plate is most deflected
      this.target[i] += (strength * (ar * dr + ai * di)) / (dm * dm);
    }
    return bestIm / Math.sqrt(dd);
  }

  setRadial(w: number, k: number, p: number) {
    this.radial.tw = w;
    this.radial.tk = k;
    this.radial.tp = p;
  }

  /** jump straight to the targets (used to pre-settle on load) */
  snap() {
    this.w.set(this.target);
    const r = this.radial;
    r.w = r.tw;
    r.k = r.tk;
    r.p = r.tp;
  }

  /** ease the mode weights toward their targets: lines dissolve and re-form */
  update(dt: number, response: number) {
    const k = 1 - Math.exp(-dt * 12 * response);
    const { w, target } = this;
    for (let i = 0; i < w.length; i++) {
      const d = target[i] - w[i];
      if (d !== 0) {
        w[i] += d * k;
        if (target[i] === 0 && Math.abs(w[i]) < 0.0005) w[i] = 0;
      }
    }
    const r = this.radial;
    const kr = 1 - Math.exp(-dt * 7 * response);
    r.w += (r.tw - r.w) * kr;
    r.k += (r.tk - r.k) * kr;
    r.p += (r.tp - r.p) * kr;
  }

  /** pack the strongest modes for the shader */
  pack() {
    const { w } = this;
    const idx: number[] = [];
    for (let i = 0; i < w.length; i++) if (Math.abs(w[i]) > 0.002) idx.push(i);
    idx.sort((a, b) => Math.abs(w[b]) - Math.abs(w[a]));
    const n = Math.min(idx.length, MAX_ACTIVE);
    for (let q = 0; q < n; q++) {
      const md = this.modes[idx[q]];
      this.slot[q] = idx[q];
      this.packed[q * 4] = md.n;
      this.packed[q * 4 + 1] = md.m;
      this.packed[q * 4 + 2] = md.s;
      this.packed[q * 4 + 3] = w[idx[q]] * md.scale;
    }
    this.activeCount = n;
  }

  totalWeight() {
    let t = 0;
    for (let q = 0; q < this.activeCount; q++) t += Math.abs(this.packed[q * 4 + 3]);
    return t;
  }

  /** radial weight as fed to the shader (scaled with the mode energy) */
  radialWeight() {
    return this.radial.w * Math.max(this.totalWeight(), 0.5);
  }

  dominant(): Mode | null {
    return this.activeCount ? this.modes[this.slot[0]] : null;
  }

  /**
   * weighted mean κ of what is sounding, a measure of intricacy, in the units
   * of the old cosine modes (n² + m²): about 2 broad and simple … 300 fine lace
   */
  meanLambda() {
    let s = 0, t = 0;
    for (let q = 0; q < this.activeCount; q++) {
      const a = Math.abs(this.w[this.slot[q]]);
      s += this.modes[this.slot[q]].lam * a;
      t += a;
    }
    return t > 0 ? s / t / (PI * PI) : 0;
  }

  /**
   * Estimate max |f| on a coarse grid so the shader can normalise the field.
   * Call after pack().
   */
  normalise(res = 36) {
    let mx = 0;
    for (let j = 0; j < res; j++) {
      const y = -1 + (2 * (j + 0.5)) / res;
      for (let i = 0; i < res; i++) {
        const x = -1 + (2 * (i + 0.5)) / res;
        const v = Math.abs(this.evalRaw(x, y));
        if (v > mx) mx = v;
      }
    }
    // the coarse grid misses the true peak slightly: aim a little high
    const target = mx > 1e-6 ? 0.94 / mx : 1;
    this.norm += (target - this.norm) * 0.5;
  }

  /** un-normalised field value at plate coords (x, y) ∈ [-1, 1]². Mirrors fieldFrag. */
  evalRaw(x0: number, y0: number): number {
    const x = x0 + WARP * (Math.sin(4.7 * y0 + 1.3) + 0.5 * Math.sin(9.1 * y0 + 2 * x0));
    const y = y0 + WARP * (Math.sin(4.1 * x0 + 0.4) + 0.5 * Math.sin(8.3 * x0 - 1.7 * y0));
    const P = this.packed, plate = this.plate;
    let f = 0, total = 0;
    for (let q = 0; q < this.activeCount; q++) {
      const w = P[q * 4 + 3];
      total += Math.abs(w);
      f += w * shape(plate, P[q * 4], P[q * 4 + 1], P[q * 4 + 2], x, y);
    }
    const rw = this.radial.w * Math.max(total, 0.5);
    if (rw > 0.002) {
      const r = superR(x, y, this.radial.p);
      f += rw * Math.exp(-1.6 * r) * Math.cos(this.radial.k * PI * r);
      total += rw;
    }
    let nz = 0;
    for (const [ax, ay, ph, a] of NOISE_WAVES) nz += a * Math.sin(ax * x + ay * y + ph);
    f += NOISE_AMT * Math.max(total, 1e-3) * nz;
    return f;
  }
}

/** superellipse radius: p = 2 is a circle, larger p tends to a rounded square */
export function superR(x: number, y: number, p: number) {
  return Math.pow(Math.pow(Math.abs(x), p) + Math.pow(Math.abs(y), p), 1 / p);
}
