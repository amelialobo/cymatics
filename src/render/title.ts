/**
 * The opening title: a word left bare in the sand, as if a stamp had been
 * pressed onto the plate, sand sprinkled over it, and the stamp lifted away.
 * The plate holds still and the letters simply stay clear, with clean edges.
 */

export interface TitleMask {
  /** size × size, row 0 at plate y = -1; 0 sand, 255 inside a letter */
  data: Uint8Array;
  size: number;
  /** horizontal extent of the word, in plate units */
  left: number;
  right: number;
  /**
   * densitySize² share of the sand that shows while the title holds, 0..255:
   * thick around the word, thinning and patchy towards the edges
   */
  density: Uint8Array;
  densitySize: number;
}

export const TITLE_FONT = '800 100px "Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif';

/** wait briefly for the display font, so the word isn't drawn in a fallback */
export async function loadTitleFont(timeoutMs = 1500) {
  try {
    await Promise.race([document.fonts.load(TITLE_FONT, 'Cymatics'), new Promise((r) => setTimeout(r, timeoutMs))]);
  } catch {
    /* the fallback face is fine */
  }
}

function hash(i: number, j: number, s: number) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** smooth value noise, -0.5..0.5 */
function noise(x: number, y: number, s: number) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(i, j, s), b = hash(i + 1, j, s), c = hash(i, j + 1, s), d = hash(i + 1, j + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v - 0.5;
}

/** box blur, in place */
function blur(src: Uint8Array, size: number, r: number) {
  const tmp = new Uint8Array(src.length);
  const span = 2 * r + 1;
  for (let pass = 0; pass < 2; pass++) {
    const from = pass ? tmp : src, to = pass ? src : tmp;
    for (let a = 0; a < size; a++) {
      let sum = 0;
      for (let b = -r; b <= r; b++) {
        const k = Math.min(size - 1, Math.max(0, b));
        sum += pass ? from[k * size + a] : from[a * size + k];
      }
      for (let b = 0; b < size; b++) {
        if (pass) to[b * size + a] = sum / span;
        else to[a * size + b] = sum / span;
        const add = Math.min(size - 1, b + r + 1), drop = Math.max(0, b - r);
        sum += pass ? from[add * size + a] - from[drop * size + a] : from[a * size + add] - from[a * size + drop];
      }
    }
  }
}

/** draw `text` centred on the visible part of the plate (bx, by) */
export function buildTitleMask(text: string, bx: number, by: number, size = 1024): TitleMask {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.font = TITLE_FONT;
  const m = ctx.measureText(text);
  const asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;

  // as wide as the screen allows (a little wider on narrow portrait screens),
  // but never taller than about half of it
  const half = size / 2;
  const fill = bx < 0.8 ? 0.9 : 0.8;
  const scale = Math.min((fill * bx * half * 2) / m.width, (0.5 * by * half * 2) / (asc + desc));
  const px = 100 * scale;
  ctx.font = TITLE_FONT.replace('100px', `${px.toFixed(1)}px`);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  const baseline = half + ((asc - desc) * scale) / 2;
  ctx.fillText(text, half, baseline);

  const rgba = ctx.getImageData(0, 0, size, size).data;
  const data = new Uint8Array(size * size);
  for (let row = 0; row < size; row++) {
    const dst = (size - 1 - row) * size, src = row * size;
    for (let col = 0; col < size; col++) data[dst + col] = rgba[(src + col) * 4];
  }
  // the stamp's edge is left as the font draws it: no wobble, no soft slope

  const w = (m.width * scale) / half;
  const D = 256;
  return {
    data, size, left: -w / 2, right: w / 2,
    density: scatterDensity(data, size, D, px, bx, by), densitySize: D,
  };
}

/**
 * Where the sand lies thick and where it thins out, as when a handful is
 * spread around a word: a soft halo round the letters, uneven clumps, and
 * a light dusting further away. On a squarish or tall screen the word is a
 * thin band, so the sand reaches top to bottom instead.
 */
function scatterDensity(mask: Uint8Array, size: number, D: number, em: number, bx: number, by: number) {
  const f = size / D;
  const near = new Uint8Array(D * D);
  for (let j = 0; j < D; j++)
    for (let i = 0; i < D; i++) {
      let mx = 0;
      for (let y = 0; y < f; y++)
        for (let x = 0; x < f; x++) mx = Math.max(mx, mask[(j * f + y) * size + i * f + x]);
      near[j * D + i] = mx;
    }
  const r = Math.max(2, Math.round((em / f) * 0.45));
  blur(near, D, r);
  blur(near, D, r);
  let peak = 1;
  for (let k = 0; k < near.length; k++) peak = Math.max(peak, near[k]);
  const s = (Math.random() * 1e6) | 0;
  // 0 on a wide screen, 1 once the screen is square or taller
  const tall = Math.min(1, Math.max(0, (by / bx - 0.8) / 0.2));
  const out = new Uint8Array(D * D);
  for (let j = 0; j < D; j++)
    for (let i = 0; i < D; i++) {
      // a light sprinkle near the word, fading to bare plate further out
      const n = Math.pow(near[j * D + i] / peak, 1.3);
      const clump = 0.4 + 1.2 * (noise(i / 9, j / 9, s) + 0.5) * (0.7 + 0.6 * (noise(i / 2.5, j / 2.5, s + 5) + 0.5));
      // tall screens: an even dusting edge to edge, a little lighter at the top and bottom
      const ey = Math.min(1, Math.abs((j + 0.5) / D * 2 - 1) / by);
      const dust = 0.13 * tall * (1 - 0.35 * ey * ey);
      const d = 0.3 * Math.max(n, dust) * clump - 0.004;
      out[j * D + i] = Math.round(255 * Math.min(1, Math.max(0, d)));
    }
  return out;
}

/** bilinear sample of the mask at plate (x, y), 0..1, with its gradient */
export function sampleTitle(t: TitleMask, x: number, y: number, out: { f: number; dx: number; dy: number }) {
  const n = t.size, d = t.data, half = (n - 1) * 0.5;
  const gx = (x + 1) * half, gy = (y + 1) * half;
  let i = gx | 0, j = gy | 0;
  if (i < 0) i = 0; else if (i > n - 2) i = n - 2;
  if (j < 0) j = 0; else if (j > n - 2) j = n - 2;
  const fx = gx - i, fy = gy - j, c = j * n + i;
  const g00 = d[c] / 255, g10 = d[c + 1] / 255, g01 = d[c + n] / 255, g11 = d[c + n + 1] / 255;
  const a0 = g00 + (g10 - g00) * fx, a1 = g01 + (g11 - g01) * fx;
  out.f = a0 + (a1 - a0) * fy;
  out.dx = ((g10 - g00) * (1 - fy) + (g11 - g01) * fy) * half;
  out.dy = (a1 - a0) * half;
}
