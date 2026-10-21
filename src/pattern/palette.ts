/**
 * Colour that follows the sound. Palettes sit in hue order from warm to cool;
 * the pitch you hear picks a position along them (low notes warm, high notes
 * cool), and the colours glide there. With no sound, the plate's figure picks
 * instead. Blending happens in OKLab so fades stay vivid instead of muddy.
 *
 * Every palette pairs a vivid background, deep enough for contrast, with light
 * sand at 4.5:1 or more against it. Keeping all sand light means a fade never dips into low contrast.
 */

type RGB = [number, number, number];

export interface Palette {
  name: string;
  background: RGB;
  sand: RGB;
}

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const pal = (name: string, background: string, sand: string): Palette => ({ name, background: hex(background), sand: hex(sand) });

/** warm → cool, so neighbours always blend well. Sand-to-background contrast noted. */
export const PALETTES: Palette[] = [
  pal('Amber', '#C2410C', '#FFF2D2'), // 4.7 : 1
  pal('Ember', '#C92E17', '#FFF3C4'), // 4.6 : 1
  pal('Rose', '#D11F62', '#FFF7B8'), // 4.7 : 1
  pal('Orchid', '#B81FD0', '#FFF6A6'), // 4.6 : 1
  pal('Violet', '#6D35E8', '#C9FFEC'), // 5.7 : 1
  pal('Cobalt', '#1F5FE0', '#FFF3A3'), // 4.9 : 1
  pal('Lagoon', '#08807B', '#FFFBCF'), // 4.6 : 1
  pal('Forest', '#1F7D37', '#F2FFB0'), // 4.9 : 1
];

const MONO: Palette = pal('Black and white', '#000000', '#FFFFFF');

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

const LAB = PALETTES.map((p) => ({ background: toLab(p.background), sand: toLab(p.sand) }));
const MONO_LAB = { background: toLab(MONO.background), sand: toLab(MONO.sand) };

// ---------------------------------------------------------------- drift
/** where on the warm → cool scale a pitch sits: 40 Hz is the warmest, 2 kHz the coolest */
const LOW_HZ = 40;
const HIGH_HZ = 2000;

export class ColorDrift {
  /** fractional position along PALETTES */
  pos = 2;
  /** 0 = full colour, 1 = black and white */
  mono = 0;
  /** background rgb, sand rgb (sRGB 0..1), ready for the shader */
  readonly rgb = new Float32Array(6);
  private time = Math.random() * 100;

  /** jump straight to the colours for this figure (no fade), e.g. on load */
  snap(meanLambda: number, colour: boolean) {
    this.pos = this.fromFigure(meanLambda);
    this.mono = colour ? 0 : 1;
    this.compute();
  }

  private scale(t: number) {
    const last = PALETTES.length - 1;
    return Math.min(last, Math.max(0, t * last));
  }

  /** the pitch picks the colour: every change of frequency shows */
  private fromPitch(hz: number) {
    return this.scale(Math.log(Math.max(hz, LOW_HZ) / LOW_HZ) / Math.log(HIGH_HZ / LOW_HZ));
  }

  /** no sound: the figure picks it (λ 2 broad and simple → warm, λ 300 fine lace → cool), with a slow sway */
  private fromFigure(meanLambda: number) {
    const t = Math.log(Math.max(meanLambda, 2) / 2) / Math.log(150);
    return this.scale(t + 0.05 * Math.sin(this.time * 0.16));
  }

  /**
   * @param pitchHz the dominant frequency while sound is playing; null when silent
   * @param holding sound source is on but momentarily quiet: keep the current colour
   */
  update(dt: number, pitchHz: number | null, holding: boolean, meanLambda: number, colour: boolean, reducedMotion: boolean) {
    this.time += dt;
    if (pitchHz || !holding) {
      const target = pitchHz ? this.fromPitch(pitchHz) : this.fromFigure(meanLambda);
      // following a pitch is quick (about a second); the idle drift is slow
      const rate = (pitchHz ? 1.6 : 0.35) * (reducedMotion ? 0.35 : 1);
      this.pos += (target - this.pos) * (1 - Math.exp(-dt * rate));
    }
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
    const keys = ['background', 'sand'] as const;
    keys.forEach((k, n) => {
      const c = fromLab(mixLab(mixLab(A[k], B[k], t), MONO_LAB[k], m));
      this.rgb[n * 3] = c[0];
      this.rgb[n * 3 + 1] = c[1];
      this.rgb[n * 3 + 2] = c[2];
    });
  }
}
