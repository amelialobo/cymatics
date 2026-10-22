/**
 * Fallback for browsers without WebGL2 float render targets: the same field
 * and sand physics on the CPU, drawn to a 2D canvas. Fewer grains, same look.
 */
import { TUNE, plateLayout, type FrameInput, type PlateRenderer } from './types';
import { sampleTitle, type TitleMask } from './title';

const N = 150; // field grid resolution

let seed = (Date.now() ^ 0x9e3779b9) >>> 0 || 1;
function rnd() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
}

export class CpuRenderer implements PlateRenderer {
  readonly kind = 'cpu' as const;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img: ImageData | null = null;
  private buf: Uint32Array | null = null;
  private acc = new Float32Array(0);
  private G = new Float32Array(N * N);
  private px = new Float32Array(0);
  private py = new Float32Array(0);
  private pm = new Float32Array(0);
  private pb = new Uint8Array(0);
  private count = 0;
  private W = 1;
  private H = 1;
  private S = 1;
  /** plate centre, canvas px from the top */
  private cy = 0.5;
  private bx = 1;
  private by = 1;
  private cssW = 1;
  private cssH = 1;
  private overhang = 0;
  private overhangSand = true;
  /** lowest visible y: below -by while the canvas overhangs the stage */
  private floor = -1;
  private title: TitleMask | null = null;
  private readonly ts = { f: 0, dx: 0, dy: 0 };

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'block w-full h-full';
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D unavailable');
    this.ctx = ctx;
    container.appendChild(this.canvas);
  }

  get particleCount() {
    return this.count;
  }

  resize(cssW: number, cssH: number) {
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    let rs = Math.min(window.devicePixelRatio || 1, 1.5);
    if (cssW * cssH * rs * rs > 2.2e6) rs = Math.sqrt(2.2e6 / (cssW * cssH));
    this.W = Math.max(1, Math.round(this.cssW * rs));
    this.H = Math.max(1, Math.round((this.cssH + this.overhang) * rs));
    this.cy = (this.cssH / 2) * rs;
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.img = this.ctx.createImageData(this.W, this.H);
    this.buf = new Uint32Array(this.img.data.buffer);
    this.acc = new Float32Array(this.W * this.H);
    const { side, bx, by } = plateLayout(this.cssW, this.cssH);
    this.S = (side * rs) / 2;
    this.bx = bx;
    this.by = by;
    this.floor = -by - (this.overhangSand ? (2 * this.overhang) / side : 0);
    this.canvas.style.height = this.overhang ? `calc(100% + ${this.overhang}px)` : '';
  }

  setOverhang(px: number, sand = true) {
    px = Math.max(0, Math.round(px));
    if (px === this.overhang && sand === this.overhangSand) return;
    this.overhang = px;
    this.overhangSand = sand;
    this.resize(this.cssW, this.cssH);
  }

  setParticleBudget(n: number) {
    n = Math.max(8000, Math.min(90000, Math.round(n * 0.5)));
    const old = this.count;
    const px = new Float32Array(n), py = new Float32Array(n), pm = new Float32Array(n), pb = new Uint8Array(n);
    const keep = Math.min(old, n);
    px.set(this.px.subarray(0, keep));
    py.set(this.py.subarray(0, keep));
    pm.set(this.pm.subarray(0, keep));
    pb.set(this.pb.subarray(0, keep));
    for (let k = keep; k < n; k++) {
      px[k] = (rnd() * 2 - 1) * this.bx;
      py[k] = this.floor + rnd() * (this.by - this.floor);
      const dust = rnd() < 0.06;
      pm[k] = dust ? 0.12 + rnd() * 0.3 : 0.7 + rnd() * 0.3;
      pb[k] = dust ? 50 + rnd() * 80 : 90 + rnd() * rnd() * 165;
    }
    Object.assign(this, { px, py, pm, pb, count: n });
    return n;
  }

  scatter() {
    for (let k = 0; k < this.count; k++) {
      this.px[k] = (rnd() * 2 - 1) * this.bx;
      this.py[k] = this.floor + rnd() * (this.by - this.floor);
    }
  }

  setTitle(mask: TitleMask | null) {
    this.title = mask;
  }

  qualityUp() {
    return false;
  }

  qualityDown() {
    if (this.count <= 12000) return false;
    this.setParticleBudget(this.count * 2 * 0.75);
    return true;
  }

  private computeField(inp: FrameInput) {
    const { bank, symmetry } = inp;
    const G = this.G, norm = bank.norm;
    for (let j = 0; j < N; j++) {
      const y = -1 + (2 * j) / (N - 1);
      for (let i = 0; i < N; i++) {
        const x = -1 + (2 * i) / (N - 1);
        G[j * N + i] = bank.evalRaw(symmetry, x, y) * norm;
      }
    }
  }

  private step(inp: FrameInput) {
    const f60 = Math.min(inp.dt * 60, 3);
    const V = inp.V;
    const G = this.G, half = (N - 1) * 0.5, n2 = N - 2;
    const { px, py, pm, count, bx, by, floor } = this;
    const jitA = V * TUNE.jitter * f60;
    const jit0 = V * TUNE.diffuse * f60 * (1 - 0.45 * inp.stability);
    const pull = Math.min(0.6, V * TUNE.pull * inp.response * f60);
    const maxStep = TUNE.maxStep * f60, ms2 = maxStep * maxStep;
    const kk = inp.kick * TUNE.kick * f60;
    const imps = inp.impulses;
    const title = inp.titleMix > 0 || inp.titleHold > 0 ? this.title : null, ts = this.ts;
    // the plate shakes hardest in the middle, so the middle holds on longer
    const tm0 = inp.titleMix, tmHold = Math.max(tm0, inp.titleHold), tHalf = this.title?.right ?? 1;
    // as the stamp lifts, the sand on it goes with it
    const stamp = this.title && inp.titleMix >= 1 && inp.titleGain > 0 ? this.title : null;
    const L = stamp?.size ?? 1;
    for (let k = 0; k < count; k++) {
      let x = px[k], y = py[k];
      const gx = (x + 1) * half, gy = (y + 1) * half;
      let i = gx | 0, j = gy | 0;
      if (i < 0) i = 0; else if (i > n2) i = n2;
      if (j < 0) j = 0; else if (j > n2) j = n2;
      const fx = gx - i, fy = gy - j, c = j * N + i;
      const g00 = G[c], g10 = G[c + 1], g01 = G[c + N], g11 = G[c + N + 1];
      const a0 = g00 + (g10 - g00) * fx, a1 = g01 + (g11 - g01) * fx;
      let f = a0 + (a1 - a0) * fy;
      let dx = ((g10 - g00) * (1 - fy) + (g11 - g01) * fy) * half;
      let dy = (a1 - a0) * half;
      if (title) {
        sampleTitle(title, x, y, ts);
        const e = Math.min(1, Math.abs(x) / tHalf), tm = tm0 + (tmHold - tm0) * (1 - e * e * (3 - 2 * e));
        const w = inp.titleGain * inp.titleShake;
        f += (ts.f * w - f) * tm;
        dx += (ts.dx * w - dx) * tm;
        dy += (ts.dy * w - dy) * tm;
      }
      const af = f < 0 ? -f : f;
      let amp = jitA * af * af + jit0 * (0.35 + af) + kk * (0.12 + af);
      for (const im of imps) {
        const ex = x - im.x, ey = y - im.y, d2 = ex * ex + ey * ey;
        if (d2 < im.r * im.r) amp += im.s * f60 * (1 - Math.sqrt(d2) / im.r);
      }
      const pk = (pull * pm[k] * f) / (dx * dx + dy * dy + 1e-4);
      let sx = -dx * pk, sy = -dy * pk;
      const sl = sx * sx + sy * sy;
      if (sl > ms2) {
        const q = maxStep / Math.sqrt(sl);
        sx *= q;
        sy *= q;
      }
      x += sx + (rnd() - 0.5) * amp;
      y += sy + (rnd() - 0.5) * amp;
      const lifted = stamp !== null && rnd() < inp.titleGain &&
        stamp.data[Math.min(L - 1, Math.max(0, ((y + 1) * 0.5 * L) | 0)) * L + Math.min(L - 1, Math.max(0, ((x + 1) * 0.5 * L) | 0))] > 127;
      if (lifted || x < -bx || x > bx || y < floor || y > by) {
        x = (rnd() * 2 - 1) * bx;
        y = floor + rnd() * (by - floor);
      }
      px[k] = x;
      py[k] = y;
    }
  }

  private draw(colors: Float32Array, titleMix: number, titleGain: number) {
    const buf = this.buf!, acc = this.acc, W = this.W, H = this.H, S = this.S;
    const br = colors[0] * 255, bgG = colors[1] * 255, bb = colors[2] * 255;
    const sr = colors[3] * 255 - br, sg = colors[4] * 255 - bgG, sb = colors[5] * 255 - bb;
    buf.fill((0xff000000 | (bb << 16) | (bgG << 8) | br) >>> 0);
    acc.fill(0);
    const cx = W * 0.5, cy = this.cy;
    const { px, py, pb, count } = this;
    // opening title: a scattered handful rather than an even layer
    const tm = this.title ? titleMix : 0, dens = this.title?.density, D = this.title?.densitySize ?? 1;
    const letters = this.title?.data, L = this.title?.size ?? 1, bare = tm * titleGain;
    for (let k = 0; k < count; k++) {
      const sx = (cx + px[k] * S) | 0, sy = (cy - py[k] * S) | 0;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      if (tm > 0 && dens) {
        const di = Math.min(D - 1, ((px[k] + 1) * 0.5 * D) | 0), dj = Math.min(D - 1, ((py[k] + 1) * 0.5 * D) | 0);
        const h = (Math.imul(k, 2654435761) >>> 0) / 4294967296;
        if (h > 1 + (dens[dj * D + di] / 255 - 1) * tm) continue;
        // and none inside the letters
        const li = Math.min(L - 1, ((px[k] + 1) * 0.5 * L) | 0), lj = Math.min(L - 1, ((py[k] + 1) * 0.5 * L) | 0);
        if (letters![lj * L + li] > 127 && ((Math.imul(k, 1597334677) >>> 0) / 4294967296) < bare) continue;
      }
      const idx = sy * W + sx;
      const a = (acc[idx] += pb[k] / 255);
      const t = 1 - Math.exp(-2.2 * a);
      buf[idx] = 0xff000000 | (((bb + sb * t) | 0) << 16) | (((bgG + sg * t) | 0) << 8) | ((br + sr * t) | 0);
    }
    this.ctx.putImageData(this.img!, 0, 0);
  }


  frame(inp: FrameInput) {
    this.computeField(inp);
    if (!inp.paused) this.step(inp);
    this.draw(inp.colors, inp.titleMix, inp.titleGain);
  }

  presettle(inp: FrameInput, steps: number) {
    this.computeField(inp);
    for (let i = 0; i < steps; i++) this.step(inp);
    this.draw(inp.colors, inp.titleMix, inp.titleGain);
  }

  exportPNG(): Promise<Blob> {
    return new Promise((resolve, reject) =>
      this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Export failed'))), 'image/png')
    );
  }

  dispose() {
    this.canvas.remove();
  }
}
