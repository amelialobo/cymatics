/**
 * Colour that follows the sand. Palettes sit in hue order around the wheel;
 * the plate's current figure picks a position along them (simple, low figures
 * are warm, intricate high ones cool), and the colours glide there slowly.
 * Blending happens in OKLab so fades stay vivid instead of turning muddy.
 */

type RGB = [number, number, number];

export interface Palette {
  name: string;
  /** background at the centre of the plate */
  inner: RGB;
  /** background toward the edges */
  outer: RGB;
  sand: RGB;
}

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const pal = (name: string, inner: string, outer: string, sand: string): Palette => ({ name, inner: hex(inner), outer: hex(outer), sand: hex(sand) });

/** in hue order, so neighbours always blend well */
export const PALETTES: Palette[] = [
  pal('Citrus', '#FFD23F', '#FF8A1F', '#2A1478'),
  pal('Sunset', '#FF9A3C', '#E2365B', '#FFF4D2'),
  pal('Flamingo', '#FF7AA2', '#C2187A', '#FFF0B8'),
  pal('Magenta', '#FF3D9A', '#7B2CBF', '#FFE14D'),
  pal('Ultraviolet', '#8A4DFF', '#3B1BB8', '#5CFFD0'),
  pal('Sky', '#5CD3FF', '#3A63E8', '#FFFFFF'),
  pal('Lagoon', '#19C3B0', '#0B5FD6', '#FFE873'),
  pal('Lime', '#B5F23D', '#1FAF6A', '#1E1670'),
];

const MONO: Palette = pal('Black and white', '#000000', '#000000', '#FFFFFF');

// ---------------------------------------------------------------- OKLab
const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function toLab([r0, g0, b0]: RGB): RGB {
  const r = toLin(r0), g = toLin(g0), b = toLin(b0);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromLab([L, a, b]: RGB): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const c = (v: number) => Math.min(1, Math.max(0, toSrgb(v)));
  return [
    c(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    c(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    c(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const mixLab = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const LAB = PALETTES.map((p) => ({ inner: toLab(p.inner), outer: toLab(p.outer), sand: toLab(p.sand) }));
const MONO_LAB = { inner: toLab(MONO.inner), outer: toLab(MONO.outer), sand: toLab(MONO.sand) };

// ---------------------------------------------------------------- drift
export class ColorDrift {
  /** fractional position along PALETTES */
  pos = 2;
  /** 0 = full colour, 1 = black and white */
  mono = 0;
  /** inner rgb, outer rgb, sand rgb (sRGB 0..1), ready for the shader */
  readonly rgb = new Float32Array(9);
  private time = Math.random() * 100;

  /** jump straight to the colours for this figure (no fade), e.g. on load */
  snap(meanLambda: number, colour: boolean) {
    this.pos = this.targetFor(meanLambda);
    this.mono = colour ? 0 : 1;
    this.compute();
  }

  private targetFor(meanLambda: number) {
    const last = PALETTES.length - 1;
    // the figure picks the colour: λ 2 (broad, simple) → warm … λ 300 (fine lace) → cool
    const t = Math.min(1, Math.max(0, Math.log(Math.max(meanLambda, 2) / 2) / Math.log(150)));
    // a slow sway keeps a held figure gently alive
    const sway = 0.35 * Math.sin(this.time * 0.16);
    return Math.min(last, Math.max(0, t * last + sway));
  }

  update(dt: number, meanLambda: number, colour: boolean, reducedMotion: boolean) {
    this.time += dt;
    const target = this.targetFor(meanLambda);
    // a few seconds to fade from one palette into the next
    const rate = reducedMotion ? 0.12 : 0.35;
    this.pos += (target - this.pos) * (1 - Math.exp(-dt * rate));
    this.mono += ((colour ? 0 : 1) - this.mono) * (1 - Math.exp(-dt * 2.5));
    this.compute();
  }

  get name() {
    if (this.mono > 0.5) return MONO.name;
    return PALETTES[Math.round(this.pos)].name;
  }

  private compute() {
    const i = Math.floor(this.pos);
    const j = Math.min(PALETTES.length - 1, i + 1);
    const f = this.pos - i;
    const t = f * f * (3 - 2 * f); // ease between neighbours
    const A = LAB[i], B = LAB[j], m = this.mono;
    const keys = ['inner', 'outer', 'sand'] as const;
    keys.forEach((k, n) => {
      const c = fromLab(mixLab(mixLab(A[k], B[k], t), MONO_LAB[k], m));
      this.rgb[n * 3] = c[0];
      this.rgb[n * 3 + 1] = c[1];
      this.rgb[n * 3 + 2] = c[2];
    });
  }
}
