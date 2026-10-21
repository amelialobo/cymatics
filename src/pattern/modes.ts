/**
 * Mathematical pattern generation.
 *
 * The plate's displacement is a weighted sum of standing-wave eigenmodes plus a
 * concentric term around the drive bolt. Sand collects where the sum is zero
 * (the nodal lines). Every formula here is mirrored in the GLSL field shader
 * (render/shaders.ts), so the CPU can normalise the field and drive the
 * fallback renderer.
 */

export type Symmetry = 'square' | 'mirror' | 'fixed' | 'radial';

export const SYMMETRIES: { id: Symmetry; label: string; hint: string }[] = [
  { id: 'square', label: 'Classic', hint: 'Four-way symmetry with diagonals, like a free steel plate.' },
  { id: 'mirror', label: 'Mirror', hint: 'Mirrored left to right and top to bottom, with looser diagonals.' },
  { id: 'fixed', label: 'Chladni', hint: 'The original Chladni plate equation, with crisp crossing lines.' },
  { id: 'radial', label: 'Rings', hint: 'Rounded rings and petals spreading from the centre.' },
];

export const SYM_INDEX: Record<Symmetry, number> = { square: 0, mirror: 1, fixed: 2, radial: 3 };

export interface Mode {
  n: number;
  m: number;
  /** sign joining the mode with its swapped partner */
  s: number;
  /** eigenvalue (≈ n² + m²); vibration frequency rises with it */
  lam: number;
}

export const MAX_ACTIVE = 24;
const MAXN = 22;
const PI = Math.PI;

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

export interface RadialTerm { w: number; k: number; p: number }

export class ModeBank {
  readonly modes: Mode[];
  readonly lams: Float32Array;
  readonly maxLam: number;
  readonly w: Float32Array;
  readonly target: Float32Array;
  readonly radial = { w: 0, k: 3, p: 2.6, tw: 0, tk: 3, tp: 2.6 };
  /** normalisation factor so the field spans -1..1 */
  norm = 1;
  /** the active modes packed for the shader: n, m, s, w */
  readonly packed = new Float32Array(MAX_ACTIVE * 4);
  activeCount = 0;

  constructor() {
    const modes: Mode[] = [];
    for (let n = 1; n <= MAXN; n++) {
      for (let m = 0; m <= n; m++) {
        // a real plate is never perfect: nudge λ so degenerate modes split apart
        const split = (((n * 13 + m * 7) % 5) - 2) * 0.16;
        if (n === m) modes.push({ n, m, s: 0, lam: 2 * n * n + split });
        else modes.push({ n, m, s: (n * 7 + m * 11) % 3 === 0 ? -1 : 1, lam: n * n + m * m + split });
      }
    }
    modes.sort((a, b) => a.lam - b.lam || a.n - b.n);
    this.modes = modes;
    this.lams = Float32Array.from(modes.map((m) => m.lam));
    this.maxLam = modes[modes.length - 1].lam;
    this.w = new Float32Array(modes.length);
    this.target = new Float32Array(modes.length);
  }

  clearTargets() {
    this.target.fill(0);
  }

  /**
   * Drive the plate at eigenvalue `lamT`. Modes near it respond along a
   * resonance curve, so a sweep snaps from figure to figure. Returns how close
   * the drive is to an exact resonance (0..1).
   */
  excite(lamT: number, strength: number): number {
    if (!(strength > 0.001) || !(lamT > 0)) return 0;
    lamT = Math.min(Math.max(lamT, 1), this.maxLam);
    const { lams } = this;
    const L = lams.length;
    let lo = 0, hi = L - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lams[mid] < lamT) lo = mid + 1;
      else hi = mid;
    }
    const width = 0.32 + 0.012 * lamT;
    const picks: number[] = [];
    for (let i = lo; i < L && (i === lo || lams[i] - lamT < 3 * width); i++) picks.push(i);
    for (let i = lo - 1; i >= 0 && (i === lo - 1 || lamT - lams[i] < 3 * width); i--) picks.push(i);
    let best = 0;
    const scored = picks
      .map((i) => {
        const d = (lams[i] - lamT) / width;
        const r = 1 / (1 + d * d);
        if (r > best) best = r;
        return [i, r] as const;
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    for (const [i, r] of scored) this.target[i] += strength * r * r * r;
    return best;
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
    const k = 1 - Math.exp(-dt * 3.2 * response);
    const { w, target } = this;
    for (let i = 0; i < w.length; i++) {
      const d = target[i] - w[i];
      if (d !== 0) {
        w[i] += d * k;
        if (target[i] === 0 && w[i] < 0.0005) w[i] = 0;
      }
    }
    const r = this.radial;
    const kr = 1 - Math.exp(-dt * 1.5 * response);
    r.w += (r.tw - r.w) * kr;
    r.k += (r.tk - r.k) * kr;
    r.p += (r.tp - r.p) * kr;
  }

  /** pack the strongest modes for the shader */
  pack() {
    const idx: number[] = [];
    for (let i = 0; i < this.w.length; i++) if (this.w[i] > 0.002) idx.push(i);
    idx.sort((a, b) => this.w[b] - this.w[a]);
    const n = Math.min(idx.length, MAX_ACTIVE);
    for (let q = 0; q < n; q++) {
      const md = this.modes[idx[q]];
      this.packed[q * 4] = md.n;
      this.packed[q * 4 + 1] = md.m;
      this.packed[q * 4 + 2] = md.s;
      this.packed[q * 4 + 3] = this.w[idx[q]];
    }
    this.activeCount = n;
  }

  totalWeight() {
    let t = 0;
    for (let q = 0; q < this.activeCount; q++) t += this.packed[q * 4 + 3];
    return t;
  }

  /** radial weight as fed to the shader (scaled with the mode energy) */
  radialWeight() {
    return this.radial.w * Math.max(this.totalWeight(), 0.5);
  }

  dominant(): Mode | null {
    if (!this.activeCount) return null;
    const n = this.packed[0], m = this.packed[1];
    return this.modes.find((md) => md.n === n && md.m === m) ?? null;
  }

  /** weighted mean eigenvalue of what is sounding: a measure of intricacy */
  meanLambda() {
    let s = 0, t = 0;
    for (let q = 0; q < this.activeCount; q++) {
      const n = this.packed[q * 4], m = this.packed[q * 4 + 1], w = this.packed[q * 4 + 3];
      s += (n * n + m * m) * w;
      t += w;
    }
    return t > 0 ? s / t : 0;
  }

  /**
   * Estimate max |f| on a coarse grid so the shader can normalise the field.
   * Call after pack().
   */
  normalise(sym: Symmetry, res = 36) {
    let mx = 0;
    for (let j = 0; j < res; j++) {
      const y = -1 + (2 * (j + 0.5)) / res;
      for (let i = 0; i < res; i++) {
        const x = -1 + (2 * (i + 0.5)) / res;
        const v = Math.abs(this.evalRaw(sym, x, y));
        if (v > mx) mx = v;
      }
    }
    // the coarse grid misses the true peak slightly: aim a little high
    const target = mx > 1e-6 ? 0.94 / mx : 1;
    this.norm += (target - this.norm) * 0.5;
  }

  /** un-normalised field value at plate coords (x, y) ∈ [-1, 1]². Mirrors fieldFrag. */
  evalRaw(sym: Symmetry, x0: number, y0: number): number {
    const x = x0 + WARP * (Math.sin(4.7 * y0 + 1.3) + 0.5 * Math.sin(9.1 * y0 + 2 * x0));
    const y = y0 + WARP * (Math.sin(4.1 * x0 + 0.4) + 0.5 * Math.sin(8.3 * x0 - 1.7 * y0));
    const P = this.packed;
    let f = 0, total = 0;
    const symI = SYM_INDEX[sym];
    let rr = -1, th = 0;
    for (let q = 0; q < this.activeCount; q++) {
      const n = P[q * 4], m = P[q * 4 + 1], s = P[q * 4 + 2], w = P[q * 4 + 3];
      total += w;
      if (symI === 0) {
        f += w * (Math.cos(n * PI * x) * Math.cos(m * PI * y) + s * Math.cos(m * PI * x) * Math.cos(n * PI * y));
      } else if (symI === 1) {
        f += w * (Math.cos(n * PI * x) * Math.cos(m * PI * y) + s * 0.55 * Math.cos(m * PI * x) * Math.cos(n * PI * y));
      } else if (symI === 2) {
        const u = x * 0.5 + 0.5, v = y * 0.5 + 0.5, a = n + 1, b = m + 1;
        const sg = a === b ? 1 : -1;
        f += w * (Math.sin(a * PI * u) * Math.sin(b * PI * v) + sg * Math.sin(b * PI * u) * Math.sin(a * PI * v));
      } else {
        if (rr < 0) {
          rr = superR(x, y, this.radial.p);
          th = Math.atan2(y, x);
        }
        f += w * Math.cos(n * PI * rr * 0.75) * Math.cos(2 * m * th);
      }
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
