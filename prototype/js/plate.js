/* CYMATICS — the plate
 * A square, centre-driven plate. Its displacement field is a weighted sum of
 * standing-wave modes  cos(nπx)cos(mπy) ± cos(mπx)cos(nπy)  plus a radial term
 * around the drive bolt. Sand grains are thrown about in proportion to the local
 * vibration and settle on the nodal lines, where the plate stays still.
 */
(function (global) {
  'use strict';

  const N = 240;    // field grid resolution
  const MAXN = 22;  // highest modal index
  const PI = Math.PI;

  // Particle physics constants (plate units: the plate spans -1..1)
  const TUNE = {
    jitter: 0.018,    // bounce at antinodes, scaled by |f|²
    diffuse: 0.0085,  // small constant bounce — gives lines their width
    pull: 0.08,       // fraction of the distance to the nodal line moved per frame
    maxStep: 0.006,
    kick: 0.022,      // transient bounce
    noise: 0.05,      // strength of the plate's imperfections
  };

  let seed = (Date.now() ^ 0x9e3779b9) >>> 0 || 1;
  function rnd() {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  }

  class Plate {
    constructor() {
      this.N = N;
      this.G = new Float32Array(N * N);

      const xs = new Float32Array(N);
      for (let i = 0; i < N; i++) xs[i] = -1 + (2 * i) / (N - 1);
      this.xs = xs;

      this.cos = new Float32Array((MAXN + 1) * N);
      for (let n = 0; n <= MAXN; n++) {
        for (let i = 0; i < N; i++) this.cos[n * N + i] = Math.cos(n * PI * xs[i]);
      }

      // modes sorted by eigenvalue λ = n² + m² (frequency rises with λ)
      const modes = [];
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
      this.A = new Float32Array(N);
      this.B = new Float32Array(N);

      // concentric term around the bolt
      this.radial = { w: 0, k: 3, p: 2.6, tw: 0, tk: 3, tp: 2.6 };
      this.R = new Float32Array(N * N);
      this.E = new Float32Array(N * N);
      this._p = -1;

      // fixed, smooth irregularities of a real plate
      this.noise = new Float32Array(N * N);
      const waves = [];
      for (let q = 0; q < 8; q++) {
        waves.push({ ax: (rnd() * 2 - 1) * 5, ay: (rnd() * 2 - 1) * 5, ph: rnd() * 2 * PI, a: 0.4 + rnd() * 0.6 });
      }
      let mx = 0;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          let v = 0;
          for (const w of waves) v += w.a * Math.sin(w.ax * xs[i] + w.ay * xs[j] + w.ph);
          this.noise[j * N + i] = v;
          mx = Math.max(mx, Math.abs(v));
        }
      }
      for (let c = 0; c < N * N; c++) this.noise[c] /= mx;

      this.count = 0;
      this.bx = 1;
      this.by = 1;
    }

    // ------------------------------------------------------------- modes
    clearTargets() {
      this.target.fill(0);
    }

    /** Drive the plate at eigenvalue lamT. Nearby modes respond with a
     *  resonance curve. Returns how close to an exact resonance we are (0..1). */
    excite(lamT, strength) {
      if (!(strength > 0.001) || !(lamT > 0)) return 0;
      lamT = Math.min(Math.max(lamT, 1), this.maxLam);
      const lams = this.lams, L = lams.length;
      let lo = 0, hi = L - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (lams[mid] < lamT) lo = mid + 1;
        else hi = mid;
      }
      const width = 0.32 + 0.012 * lamT;
      const picks = [];
      for (let i = lo; i < L && (i === lo || lams[i] - lamT < 3 * width); i++) picks.push(i);
      for (let i = lo - 1; i >= 0 && (i === lo - 1 || lamT - lams[i] < 3 * width); i--) picks.push(i);
      let best = 0;
      const scored = picks
        .map((i) => {
          const d = (lams[i] - lamT) / width;
          const r = 1 / (1 + d * d);
          if (r > best) best = r;
          return [i, r];
        })
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      for (const [i, r] of scored) this.target[i] += strength * r * r * r;
      return best;
    }

    setRadial(w, k, p) {
      const r = this.radial;
      r.tw = w;
      r.tk = k;
      r.tp = p;
    }

    /** jump straight to the targets (used to pre-settle on load) */
    snap() {
      this.w.set(this.target);
      const r = this.radial;
      r.w = r.tw;
      r.k = r.tk;
      r.p = r.tp;
    }

    update(dt, response) {
      const k = 1 - Math.exp(-dt * 3.2 * response);
      const w = this.w, t = this.target;
      for (let i = 0; i < w.length; i++) {
        const d = t[i] - w[i];
        if (d !== 0) {
          w[i] += d * k;
          if (t[i] === 0 && w[i] < 0.0005) w[i] = 0;
        }
      }
      const r = this.radial;
      const kr = 1 - Math.exp(-dt * 1.5 * response);
      r.w += (r.tw - r.w) * kr;
      r.k += (r.tk - r.k) * kr;
      r.p += (r.tp - r.p) * kr;
    }

    dominantMode() {
      let bi = -1, bw = 0;
      for (let i = 0; i < this.w.length; i++) if (this.w[i] > bw) { bw = this.w[i]; bi = i; }
      return bi < 0 ? null : this.modes[bi];
    }

    _buildRadius(p) {
      const xs = this.xs, R = this.R, E = this.E;
      for (let j = 0; j < N; j++) {
        const ay = Math.pow(Math.abs(xs[j]), p);
        for (let i = 0; i < N; i++) {
          const r = Math.pow(Math.pow(Math.abs(xs[i]), p) + ay, 1 / p);
          R[j * N + i] = r;
          E[j * N + i] = Math.exp(-r * 1.6);
        }
      }
      this._p = p;
    }

    computeField() {
      const G = this.G, C = this.cos, w = this.w, modes = this.modes, A = this.A, B = this.B;
      const NN = N * N;
      G.fill(0);
      let total = 0;

      for (let q = 0; q < w.length; q++) {
        const wq = w[q];
        if (wq < 0.002) continue;
        total += wq;
        const md = modes[q], nO = md.n * N, mO = md.m * N, s = md.s;
        for (let i = 0; i < N; i++) {
          A[i] = wq * C[nO + i];
          B[i] = wq * s * C[mO + i];
        }
        for (let j = 0; j < N; j++) {
          const cyM = C[mO + j], cyN = C[nO + j], row = j * N;
          for (let i = 0; i < N; i++) G[row + i] += A[i] * cyM + B[i] * cyN;
        }
      }

      const r = this.radial;
      if (r.w > 0.002) {
        if (Math.abs(r.p - this._p) > 0.02) this._buildRadius(r.p);
        const R = this.R, E = this.E, kk = r.k * PI, rw = r.w * Math.max(total, 0.5);
        for (let c = 0; c < NN; c++) G[c] += rw * E[c] * Math.cos(kk * R[c]);
        total += rw;
      }

      const na = TUNE.noise * (total || 1), Z = this.noise;
      let mx = 0;
      for (let c = 0; c < NN; c++) {
        const v = (G[c] += na * Z[c]);
        const a = v < 0 ? -v : v;
        if (a > mx) mx = a;
      }
      const inv = mx > 1e-6 ? 1 / mx : 0;
      for (let c = 0; c < NN; c++) G[c] *= inv;
    }

    // --------------------------------------------------------- particles
    setViewport(W, H, S) {
      this.bx = Math.min(1, W / (2 * S));
      this.by = Math.min(1, H / (2 * S));
    }

    setCount(n) {
      n = Math.max(1000, n | 0);
      const old = this.count;
      const px = new Float32Array(n), py = new Float32Array(n);
      const pm = new Float32Array(n), pb = new Uint8Array(n);
      const keep = Math.min(old, n);
      if (keep) {
        px.set(this.px.subarray(0, keep));
        py.set(this.py.subarray(0, keep));
        pm.set(this.pm.subarray(0, keep));
        pb.set(this.pb.subarray(0, keep));
      }
      for (let k = keep; k < n; k++) {
        px[k] = (rnd() * 2 - 1) * this.bx;
        py[k] = (rnd() * 2 - 1) * this.by;
        const dust = rnd() < 0.14;
        pm[k] = dust ? 0.12 + rnd() * 0.3 : 0.7 + rnd() * 0.3;
        pb[k] = dust ? 50 + rnd() * 80 : 90 + rnd() * rnd() * 165;
      }
      this.px = px; this.py = py; this.pm = pm; this.pb = pb;
      this.count = n;
    }

    scatter() {
      for (let k = 0; k < this.count; k++) {
        this.px[k] = (rnd() * 2 - 1) * this.bx;
        this.py[k] = (rnd() * 2 - 1) * this.by;
      }
    }

    step(dt, V, kick, impulses, response) {
      const f60 = Math.min(dt * 60, 3);
      const G = this.G, half = (N - 1) * 0.5, n2 = N - 2;
      const px = this.px, py = this.py, pm = this.pm, cnt = this.count;
      const bx = this.bx, by = this.by;
      const jitA = V * TUNE.jitter * f60;
      const jit0 = V * TUNE.diffuse * f60;
      const pull = Math.min(0.6, V * TUNE.pull * response * f60);
      const maxStep = TUNE.maxStep * f60;
      const ms2 = maxStep * maxStep;
      const kk = kick * TUNE.kick * f60;
      const nImp = impulses.length;
      if (jitA === 0 && kk === 0 && nImp === 0) return; // silence: the sand rests

      for (let k = 0; k < cnt; k++) {
        let x = px[k], y = py[k];
        const gx = (x + 1) * half, gy = (y + 1) * half;
        let i = gx | 0, j = gy | 0;
        if (i < 0) i = 0; else if (i > n2) i = n2;
        if (j < 0) j = 0; else if (j > n2) j = n2;
        const fx = gx - i, fy = gy - j, c = j * N + i;
        const g00 = G[c], g10 = G[c + 1], g01 = G[c + N], g11 = G[c + N + 1];
        const a0 = g00 + (g10 - g00) * fx;
        const a1 = g01 + (g11 - g01) * fx;
        const f = a0 + (a1 - a0) * fy;
        const dx = ((g10 - g00) * (1 - fy) + (g11 - g01) * fy) * half;
        const dy = (a1 - a0) * half;
        const af = f < 0 ? -f : f;

        let amp = jitA * af * af + jit0 * (0.35 + af);
        if (kk > 0) amp += kk * (0.25 + af);
        for (let q = 0; q < nImp; q++) {
          const im = impulses[q];
          const ex = x - im.x, ey = y - im.y, d2 = ex * ex + ey * ey;
          if (d2 < im.r * im.r) amp += im.s * (1 - Math.sqrt(d2) / im.r);
        }

        // Newton step toward the nodal line f = 0
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
        if (x < -bx || x > bx || y < -by || y > by) {
          x = (rnd() * 2 - 1) * bx;
          y = (rnd() * 2 - 1) * by;
        }
        px[k] = x;
        py[k] = y;
      }
    }

    render(buf, W, H, S) {
      buf.fill(0xff000000);
      const cx = W * 0.5, cy = H * 0.5;
      const px = this.px, py = this.py, pb = this.pb, cnt = this.count;
      for (let k = 0; k < cnt; k++) {
        const sx = (cx + px[k] * S) | 0, sy = (cy + py[k] * S) | 0;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        const idx = sy * W + sx;
        let v = (buf[idx] & 255) + pb[k];
        if (v > 255) v = 255;
        buf[idx] = 0xff000000 | (v << 16) | (v << 8) | v;
      }
    }

    /** faint glow at the antinodes, like light catching the bare metal */
    renderHaze(imgData) {
      const d = imgData.data, G = this.G;
      for (let c = 0, o = 0; c < N * N; c++, o += 4) {
        const a = G[c] < 0 ? -G[c] : G[c];
        const v = a * a * a * 26;
        d[o] = d[o + 1] = d[o + 2] = v;
        d[o + 3] = 255;
      }
    }
  }

  global.Cymatics = global.Cymatics || {};
  global.Cymatics.Plate = Plate;
  global.Cymatics.TUNE = TUNE;
})(window);
