/**
 * The physics of the four plates.
 *
 * Every plate obeys thin-plate (Kirchhoff) theory, D∇⁴w = ρh ω² w. Its free
 * vibrations (eigenmodes) and their frequencies come from the classical
 * solutions:
 *
 *  Classic  a free square steel plate. Ritz's method: each mode is built from
 *           free-free beam functions, X_a(x)·X_b(y) + X_b(x)·X_a(y), with
 *           frequencies from Warburton's formula (Poisson's ratio 0.3).
 *  Mirror   the same square cut from wood, stiffer along its grain (Huber's
 *           orthotropic plate). The stiffness differs left-right and up-down,
 *           so the diagonal symmetry breaks and modes are single products.
 *  Chladni  a square plate pinned along its edges (simply supported). Navier's
 *           exact solution: sin(aπu)·sin(bπv), frequency ∝ a² + b².
 *  Rings    a free round plate: J₀(kr) + C·I₀(kr), with the free-edge
 *           conditions solved numerically for k.
 *
 * All four are driven by the bolt at their centre, so only the modes that move
 * there can respond, and a tone at ω makes the plate's forced response, the
 * sum over its modes (modal superposition):
 *
 *     w(x) = Σᵢ ψᵢ(0) ψᵢ(x) / (ωᵢ² − ω² + 2iζωᵢω)
 *
 * Each pitch therefore has exactly one figure on each plate.
 *
 * Units: plate coordinates span [-1, 1]². A mode's `lam` is κ = ω·√(ρh/D) in
 * those units (the squared wavenumber), so frequency is proportional to it.
 * Every formula here is mirrored in the GLSL field shader (render/shaders.ts).
 */
import type { Symmetry } from './modes';

const PI = Math.PI;
/** Poisson's ratio (steel; also used for the wood and the round plate) */
const NU = 0.3;
/** wood across the grain is this much less stiff than along it (D_y / D_x) */
export const WOOD_RATIO = 0.3;
/** the round plate's radius: just wide enough to fill every corner of the view */
export const DISC_R = Math.SQRT2;
/** samples per radial profile in the round plate's table */
export const TABLE_W = 512;
/** the highest κ any plate needs (2 kHz at the highest complexity, with margin) */
const LAM_MAX = 2700;

export interface Mode {
  /** shape indices for the shader (beam or sine orders; for the disc, nodal diameters) */
  n: number;
  /** second index; for the disc, the row of its radial profile in the table */
  m: number;
  /** 1 adds the swapped partner X_m(x)X_n(y) (a degenerate pair, driven together) */
  s: number;
  /** κ: vibration frequency is proportional to it */
  lam: number;
  /** the unit-norm shape's value at the drive point: how strongly the bolt moves it */
  c: number;
  /** shader shape → unit-norm shape */
  scale: number;
  /** plain description of the figure, for the readout */
  label: string;
}

export interface Plate {
  sym: Symmetry;
  modes: Mode[];
  /** the round plate's radial profiles, TABLE_W samples per mode over r ∈ [0, R] */
  table: Float32Array | null;
  tableRows: number;
}

// ------------------------------------------------------------ beam functions
/** root of the free-free beam equation for a mode with j nodal points */
export function beamK(j: number) {
  // j = 2 is the one root far from its asymptote (2.36502 vs 2.35619)
  return j === 2 ? 2.365020372 : (j - 0.5) * PI * 0.5;
}

/**
 * Free-free beam on [-1, 1] with j nodes (even j: symmetric about the centre).
 * cosh(kx)/cosh(k) is written with decaying exponentials so it never overflows.
 */
export function beam(j: number, x: number) {
  if (j < 0.5) return 1;
  const k = beamK(j);
  return Math.cos(k * x) + (Math.cos(k) * (Math.exp(k * (x - 1)) + Math.exp(-k * (x + 1)))) / (1 + Math.exp(-2 * k));
}

/** Warburton's (G, H, J) coefficients for a free-free edge pair, j nodal lines */
function warburton(j: number): [number, number, number] {
  if (j === 0) return [0, 0, 0];
  if (j === 1) return [0, 0, 12 / (PI * PI)];
  if (j === 2) return [1.506, 1.248, 5.017];
  const g = j - 0.5;
  return [g, g * g * (1 - 2 / (g * PI)), g * g * (1 + 6 / (g * PI))];
}

/**
 * Warburton's frequency for a free rectangular plate, with Huber's orthotropy
 * (ratio = D_y / D_x). Returns κ for a plate of side 2.
 */
function warburtonLam(a: number, b: number, ratio: number) {
  const [gx, hx, jx] = warburton(a), [gy, hy, jy] = warburton(b);
  const q = Math.sqrt(ratio);
  const l2 = gx ** 4 + ratio * gy ** 4 + 2 * q * (NU * hx * hy + (1 - NU) * jx * jy);
  // Ω = ωa²√(ρh/D) = π²√l2 for side a; our side is 2
  return (PI * PI * Math.sqrt(l2)) / 4;
}

function beamNorm(j: number) {
  if (j === 0) return Math.SQRT2;
  let s = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const x = -1 + (2 * (i + 0.5)) / N;
    s += beam(j, x) ** 2;
  }
  return Math.sqrt((s * 2) / N);
}

/** free plates: even beam orders (symmetric, so the centre bolt moves them) */
const MAX_J = 44;

function freeSquare(sym: 'square' | 'mirror'): Plate {
  const norms: number[] = [];
  for (let j = 0; j <= MAX_J; j += 2) norms[j] = beamNorm(j);
  const modes: Mode[] = [];
  for (let a = 0; a <= MAX_J; a += 2) {
    for (let b = 0; b <= MAX_J; b += 2) {
      if (a === 0 && b === 0) continue; // rigid: it only moves the plate up and down
      if (sym === 'square' && b < a) continue; // the swapped partner rides with (a, b)
      const s = sym === 'square' && a !== b ? 1 : 0;
      const lam = warburtonLam(a, b, sym === 'square' ? 1 : WOOD_RATIO);
      if (lam > LAM_MAX) continue;
      // the partner is orthogonal, so the pair's norm² is twice one product's
      const scale = 1 / (Math.sqrt(1 + s) * norms[a] * norms[b]);
      const c = scale * (1 + s) * beam(a, 0) * beam(b, 0);
      modes.push({ n: a, m: b, s, lam, c, scale, label: `${a}·${b}` });
    }
  }
  return finish(sym, modes, null, 0);
}

// ---------------------------------------------------- pinned (Navier) plate
function pinnedSquare(): Plate {
  const modes: Mode[] = [];
  // odd orders only: even ones have a node through the centre
  for (let a = 1; a < 60; a += 2) {
    for (let b = a; b < 60; b += 2) {
      const lam = (PI * PI * (a * a + b * b)) / 4;
      if (lam > LAM_MAX) continue;
      const s = a !== b ? 1 : 0;
      // ∫ sin²(aπu) over x ∈ [-1, 1] is 1
      const scale = 1 / Math.sqrt(1 + s);
      const c = scale * (1 + s) * Math.sin((a * PI) / 2) * Math.sin((b * PI) / 2);
      modes.push({ n: a, m: b, s, lam, c, scale, label: `${a}·${b}` });
    }
  }
  return finish('fixed', modes, null, 0);
}

// ------------------------------------------------------------ round plate
const QUAD = 160;
const QC = new Float64Array(QUAD), QS = new Float64Array(QUAD);
for (let i = 0; i < QUAD; i++) {
  QC[i] = Math.cos((2 * PI * i) / QUAD);
  QS[i] = Math.sin((2 * PI * i) / QUAD);
}
const QC2 = QC.map((_, i) => Math.cos((4 * PI * i) / QUAD));

/**
 * J₀, J₁, J₂ and e⁻ˣ·I₀, I₁, I₂ by the trapezoid rule over a full period of
 * their integral forms (exponentially accurate for x well below QUAD).
 */
function bessel012(x: number) {
  let j0 = 0, j1 = 0, j2 = 0, i0 = 0, i1 = 0, i2 = 0;
  for (let i = 0; i < QUAD; i++) {
    const ph = x * QS[i];
    const cp = Math.cos(ph), sp = Math.sin(ph);
    // J_n = mean of cos(nτ − x sin τ)
    j0 += cp;
    j1 += QC[i] * cp + QS[i] * sp;
    j2 += QC2[i] * cp + 2 * QS[i] * QC[i] * sp;
    const e = Math.exp(x * (QC[i] - 1));
    i0 += e;
    i1 += e * QC[i];
    i2 += e * QC2[i];
  }
  return [j0 / QUAD, j1 / QUAD, j2 / QUAD, i0 / QUAD, i1 / QUAD, i2 / QUAD];
}

/** just J₀ and e⁻ˣ·I₀, for drawing the profiles */
function bessel0(x: number) {
  let j0 = 0, i0 = 0;
  for (let i = 0; i < QUAD; i++) {
    j0 += Math.cos(x * QS[i]);
    i0 += Math.exp(x * (QC[i] - 1));
  }
  return [j0 / QUAD, i0 / QUAD];
}

/** free-edge conditions for an axisymmetric mode: bending moment and shear vanish */
function edge(k: number) {
  const [j0, j1, j2, i0, i1, i2] = bessel012(k);
  const jd = -j1, jdd = (j2 - j0) / 2;
  const id = i1, idd = (i0 + i2) / 2;
  const mJ = k * k * jdd + NU * k * jd, vJ = -k * k * k * jd;
  const mI = k * k * idd + NU * k * id, vI = k * k * k * id;
  return { det: mJ * vI - mI * vJ, mJ, mI };
}

function disc(): Plate {
  const R2 = DISC_R * DISC_R;
  const kMax = Math.sqrt(LAM_MAX * R2);
  const roots: number[] = [];
  let prevK = 0.5, prev = edge(prevK).det;
  for (let k = 0.7; k <= kMax; k += 0.2) {
    const d = edge(k).det;
    if (Math.sign(d) !== Math.sign(prev)) {
      let lo = prevK, hi = k, dlo = prev;
      for (let it = 0; it < 32; it++) {
        const mid = (lo + hi) / 2, dm = edge(mid).det;
        if (Math.sign(dm) === Math.sign(dlo)) { lo = mid; dlo = dm; }
        else hi = mid;
      }
      roots.push((lo + hi) / 2);
    }
    prevK = k;
    prev = d;
  }

  const W = TABLE_W;
  const table = new Float32Array(W * roots.length);
  const modes: Mode[] = roots.map((k, row) => {
    const { mJ, mI } = edge(k);
    const cI = -mJ / mI; // weight of e⁻ᵏ·I₀(k), so C·I₀(kρ) = cI·Iₛ(kρ)·e^{k(ρ−1)}
    let n2 = 0;
    for (let i = 0; i < W; i++) {
      const rho = i / (W - 1);
      const [j0, i0] = bessel0(k * rho);
      const v = j0 + cI * i0 * Math.exp(k * (rho - 1));
      table[row * W + i] = v;
      n2 += v * v * rho;
    }
    // ∫∫ T(r/R)² dA over the disc
    const norm2 = 2 * PI * R2 * (n2 / (W - 1));
    const scale = 1 / Math.sqrt(norm2);
    const rings = row + 1;
    return { n: 0, m: row, s: 0, lam: (k * k) / R2, c: scale * table[row * W], scale, label: `${rings} ${rings === 1 ? 'ring' : 'rings'}` };
  });
  return finish('radial', modes, table, roots.length);
}

function finish(sym: Symmetry, modes: Mode[], table: Float32Array | null, tableRows: number): Plate {
  modes.sort((a, b) => a.lam - b.lam || a.n - b.n);
  return { sym, modes, table, tableRows };
}

const cache = new Map<Symmetry, Plate>();
/** each plate is solved once, the first time it is needed */
export function getPlate(sym: Symmetry): Plate {
  let p = cache.get(sym);
  if (!p) {
    p = sym === 'square' || sym === 'mirror' ? freeSquare(sym) : sym === 'fixed' ? pinnedSquare() : disc();
    cache.set(sym, p);
  }
  return p;
}

/** un-normalised shape of one mode at plate coords (x, y). Mirrors the shader. */
export function shape(plate: Plate, n: number, m: number, s: number, x: number, y: number) {
  switch (plate.sym) {
    case 'square':
    case 'mirror':
      return beam(n, x) * beam(m, y) + (s ? beam(m, x) * beam(n, y) : 0);
    case 'fixed': {
      const u = x * 0.5 + 0.5, v = y * 0.5 + 0.5;
      return Math.sin(n * PI * u) * Math.sin(m * PI * v) + (s ? Math.sin(m * PI * u) * Math.sin(n * PI * v) : 0);
    }
    default: {
      const t = Math.min(Math.hypot(x, y) / DISC_R, 1) * (TABLE_W - 1);
      const i = Math.min(Math.floor(t), TABLE_W - 2), f = t - i;
      const row = plate.table!, o = m * TABLE_W + i;
      const r = row[o] + (row[o + 1] - row[o]) * f;
      return n ? r * Math.cos(n * Math.atan2(y, x)) : r;
    }
  }
}

/**
 * Pitches that land exactly on a mode the bolt drives well: the plate rings
 * clearly there. Returns κ values, spread across the range, low to high.
 */
export function resonances(plate: Plate, lamLo: number, lamHi: number, count: number): number[] {
  const inRange = plate.modes.filter((md) => md.lam >= lamLo && md.lam <= lamHi);
  if (!inRange.length) return [];
  const strong = inRange.map((md) => Math.abs(md.c)).sort((a, b) => a - b);
  const cut = strong[Math.floor(strong.length * 0.4)];
  const good = inRange.filter((md) => Math.abs(md.c) >= cut);
  const out: number[] = [];
  for (let q = 0; q < count; q++) {
    const want = lamLo * Math.pow(lamHi / lamLo, (q + 0.5) / count);
    let best = good[0];
    for (const md of good) if (Math.abs(Math.log(md.lam / want)) < Math.abs(Math.log(best.lam / want))) best = md;
    if (!out.includes(best.lam)) out.push(best.lam);
  }
  return out;
}
