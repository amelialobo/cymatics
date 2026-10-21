/**
 * Colour that follows the sound. The pitch you hear picks a position along the
 * palettes (low notes first, high notes last) and the colours glide there.
 * With no sound, the plate's figure picks instead. Blending happens in OKLab
 * so fades stay vivid instead of muddy.
 *
 * Half the palettes are light backgrounds with dark sand, half deep
 * backgrounds with light sand. Between two palettes of opposite polarity the
 * hues fade smoothly but the lightness flips quickly at the midpoint, and a
 * contrast floor keeps the sand clearly lighter or darker than the background
 * at every moment of a fade.
 */

type RGB = [number, number, number];

export interface Palette {
  name: string;
  background: RGB;
  sand: RGB;
}

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const pal = (name: string, background: string, sand: string): Palette => ({ name, background: hex(background), sand: hex(sand) });

/** low pitch → high pitch. Polarity alternates; sand-to-background contrast noted. */
export const PALETTES: Palette[] = [
  pal('Peach & Plum', '#FFD3B6', '#4A1942'), // light, 10.1 : 1
  pal('Burgundy & Blush', '#4A0E1F', '#FFC2D1'), // dark, 10.1 : 1
  pal('Butter & Cobalt', '#FFE7A3', '#1E3A8A'), // light, 8.5 : 1
  pal('Charcoal & Gold', '#1F1F24', '#F2C14E'), // dark, 9.8 : 1
  pal('Mint & Forest', '#CDEFD9', '#0E3B2E'), // light, 10.1 : 1
  pal('Forest & Lime', '#12372A', '#D4F27A'), // dark, 10.5 : 1
  pal('Teal & Sand', '#0F4C5C', '#F6D8AE'), // dark, 7.0 : 1
  pal('Sky & Navy', '#CFE8FF', '#0B2545'), // light, 12.2 : 1
  pal('Midnight & Coral', '#14213D', '#FF8C69'), // dark, 7.0 : 1
  pal('Lilac & Aubergine', '#E4D7FF', '#2E1244'), // light, 12.0 : 1
];

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

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const mixLab = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const LAB = PALETTES.map((p) => ({ background: toLab(p.background), sand: toLab(p.sand) }));
/** +1 when the sand is lighter than the background, -1 when darker */
const SIDE = LAB.map((p) => Math.sign(p.sand[0] - p.background[0]));
/** minimum OKLab lightness gap between sand and background during any fade (4.5 : 1 or more) */
const MIN_GAP = 0.52;

/** quick pairs offered in the colour picker, besides the changing palettes */
export const FIXED_PAIRS: Palette[] = [
  pal('Black & white', '#000000', '#FFFFFF'),
  pal('White & black', '#FFFFFF', '#111111'),
  ...PALETTES,
];

// ------------------------------------------------------------- helpers
export const toHex = (c: ArrayLike<number>, o = 0) =>
  '#' + [0, 1, 2].map((k) => Math.round(Math.min(1, Math.max(0, c[o + k])) * 255).toString(16).padStart(2, '0')).join('');

export const fromHex = hex;

function luminance([r, g, b]: RGB) {
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

/** WCAG contrast ratio between two colours */
export function contrast(a: RGB, b: RGB) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Adjust the lightness of `move` (OKLab, in place) until it reaches 4.6 : 1
 * against `fixed`, keeping it on its current side (lighter or darker) unless
 * there is no room there.
 */
function readable(fixed: RGB, move: RGB) {
  const TARGET = 4.6;
  const ref = fromLab(fixed);
  const ok = (L: number, chroma = 1) => contrast(ref, fromLab([L, move[1] * chroma, move[2] * chroma])) >= TARGET;
  if (ok(move[0])) return;
  const prefer = move[0] >= fixed[0] ? 1 : -1;
  // first keep the colour as vivid as it is; failing that, soften it toward
  // white or black just enough (very vivid colours can't get light or dark enough)
  for (const vivid of [true, false]) {
    for (const side of [prefer, -prefer]) {
      const end = side > 0 ? 1 : 0;
      if (vivid) {
        if (!ok(end)) continue;
        // the nearest lightness on this side that is readable
        let bad = side > 0 ? Math.max(move[0], fixed[0]) : Math.min(move[0], fixed[0]);
        let good = end;
        for (let k = 0; k < 16; k++) {
          const mid = (bad + good) / 2;
          if (ok(mid)) good = mid;
          else bad = mid;
        }
        move[0] = good;
        return;
      }
      if (!ok(end, 0)) continue;
      // at the far end, keep as much colour as still reads clearly
      let good = 0, bad = 1;
      for (let k = 0; k < 12; k++) {
        const mid = (good + bad) / 2;
        if (ok(end, mid)) good = mid;
        else bad = mid;
      }
      move[0] = end;
      move[1] *= good;
      move[2] *= good;
      return;
    }
  }
  move[0] = fixed[0] > 0.6 ? 0 : 1;
  move[1] = move[2] = 0;
}

// ---------------------------------------------------------------- drift
/** where on the low → high scale a pitch sits */
const LOW_HZ = 40;
const HIGH_HZ = 2000;

type Part = 'background' | 'sand';

export class ColorDrift {
  /** fractional position along PALETTES */
  pos = 2;
  /** background rgb, sand rgb (sRGB 0..1), ready for the shader */
  readonly rgb = new Float32Array(6);
  private time = Math.random() * 100;
  /** colours the person picked (OKLab), or null while that part keeps changing */
  private fixed: Record<Part, RGB | null> = { background: null, sand: null };
  private fixedHex: Record<Part, string | null> = { background: null, sand: null };
  /** last picked colour, kept so releasing it fades back smoothly */
  private held: Record<Part, RGB> = { background: [0, 0, 0], sand: [1, 0, 0] };
  /** 0 = changing, 1 = the picked colour; eased so switches fade */
  private weight: Record<Part, number> = { background: 0, sand: 0 };

  /** a hex colour fixes that part; null lets it follow the sound again */
  setFixed(background: string | null, sand: string | null) {
    const parts: [Part, string | null][] = [['background', background], ['sand', sand]];
    for (const [k, v] of parts) {
      if (v === this.fixedHex[k]) continue;
      this.fixedHex[k] = v;
      this.fixed[k] = v ? toLab(hex(v)) : null;
      if (this.fixed[k]) this.held[k] = this.fixed[k]!;
    }
  }

  /** jump straight to the colours (no fade), e.g. on load */
  snap(meanLambda: number) {
    this.pos = this.fromFigure(meanLambda);
    this.weight.background = this.fixed.background ? 1 : 0;
    this.weight.sand = this.fixed.sand ? 1 : 0;
    this.compute();
  }

  private scale(t: number) {
    const last = PALETTES.length - 1;
    const x = Math.min(last, Math.max(0, t * last));
    // pull toward the nearest palette so a held note settles on one pairing,
    // not halfway between two; moving the pitch still glides across
    const i = Math.floor(x), f = x - i;
    const g = Math.min(1, Math.max(0, (f - 0.3) / 0.4));
    return i + g * g * (3 - 2 * g);
  }

  /** the pitch picks the colour: every change of frequency shows */
  private fromPitch(hz: number) {
    return this.scale(Math.log(Math.max(hz, LOW_HZ) / LOW_HZ) / Math.log(HIGH_HZ / LOW_HZ));
  }

  /** no sound: the figure picks it (λ 2 broad and simple … λ 300 fine lace), with a slow sway */
  private fromFigure(meanLambda: number) {
    const t = Math.log(Math.max(meanLambda, 2) / 2) / Math.log(150);
    return this.scale(t + 0.05 * Math.sin(this.time * 0.16));
  }

  /**
   * @param pitchHz the dominant frequency while sound is playing; null when silent
   * @param holding sound source is on but momentarily quiet: keep the current colour
   */
  update(dt: number, pitchHz: number | null, holding: boolean, meanLambda: number, reducedMotion: boolean) {
    this.time += dt;
    if (pitchHz || !holding) {
      const target = pitchHz ? this.fromPitch(pitchHz) : this.fromFigure(meanLambda);
      // following a pitch is quick (about a third of a second); the idle drift is slow
      const rate = (pitchHz ? 3.2 : 0.5) * (reducedMotion ? 0.35 : 1);
      this.pos += (target - this.pos) * (1 - Math.exp(-dt * rate));
    }
    const k = 1 - Math.exp(-dt * 10);
    this.weight.background += ((this.fixed.background ? 1 : 0) - this.weight.background) * k;
    this.weight.sand += ((this.fixed.sand ? 1 : 0) - this.weight.sand) * k;
    this.compute();
  }

  get name() {
    if (this.fixed.background && this.fixed.sand) return 'Custom';
    return PALETTES[Math.round(this.pos)].name;
  }

  private compute() {
    const i = Math.floor(this.pos);
    const j = Math.min(PALETTES.length - 1, i + 1);
    const f = this.pos - i;
    const t = f * f * (3 - 2 * f); // hue and colourfulness: a smooth glide
    const flip = SIDE[i] !== SIDE[j];
    // lightness: when sand and background swap roles, invert quickly mid-fade
    const tl = flip ? smooth(0.42, 0.58, f) : t;
    const A = LAB[i], B = LAB[j];
    const mix = (k: Part): RGB => {
      const c = mixLab(A[k], B[k], t);
      c[0] = A[k][0] + (B[k][0] - A[k][0]) * tl;
      // a picked colour replaces the changing one (with a short fade either way)
      return mixLab(c, this.held[k], this.weight[k]);
    };
    const bg = mix('background');
    const sand = mix('sand');

    const fixedBg = this.weight.background > 0.99, fixedSand = this.weight.sand > 0.99;
    if (fixedBg !== fixedSand) {
      // one part picked: move only the changing one until it reads clearly against it
      if (fixedBg) readable(bg, sand);
      else readable(sand, bg);
    } else if (!fixedBg) {
      // both changing: when the two get close, push them apart, the sand one way
      // and the background the other, so the sand always stays readable
      const side = Math.sign(sand[0] - bg[0]) || (f < 0.5 ? SIDE[i] : SIDE[j]);
      const need = MIN_GAP - Math.abs(sand[0] - bg[0]);
      if (need > 0) {
        const lo = 0.03, hi = 0.985;
        let s = sand[0] + side * need * 0.5;
        let b = bg[0] - side * need * 0.5;
        // if one hits the end of the scale, the other takes up the rest
        if (s > hi) { b -= s - hi; s = hi; }
        if (s < lo) { b += lo - s; s = lo; }
        if (b > hi) { s -= b - hi; b = hi; }
        if (b < lo) { s += lo - b; b = lo; }
        sand[0] = s;
        bg[0] = b;
      }
    }
    // both picked: shown exactly as chosen (the panel shows their contrast)
    const out = [fromLab(bg), fromLab(sand)];
    for (let n = 0; n < 2; n++) {
      this.rgb[n * 3] = out[n][0];
      this.rgb[n * 3 + 1] = out[n][1];
      this.rgb[n * 3 + 2] = out[n][2];
    }
  }
}
