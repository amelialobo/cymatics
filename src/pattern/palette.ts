/**
 * Colour that follows the sound. The pitch you hear picks a position along the
 * palettes (low notes first, high notes last) and the colours glide there.
 * With no sound the colours hold still; on load the plate's figure picks them. Blending happens in OKLab
 * so fades stay vivid instead of muddy.
 *
 * The low palettes are deep backgrounds with light sand, the high ones light
 * backgrounds with dark sand, ordered so neighbours share a hue. Where the two
 * groups meet the lightness flips at the midpoint, a contrast floor keeps the
 * sand readable during fades, and the colours on screen ease toward their
 * target so no change ever lands in a single frame.
 */

type RGB = [number, number, number];

export interface Palette {
  name: string;
  background: RGB;
  sand: RGB;
}

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const pal = (name: string, background: string, sand: string): Palette => ({ name, background: hex(background), sand: hex(sand) });

/**
 * low pitch → high pitch. Neighbours share a hue family so each fade is a
 * small step around the colour wheel: the deep palettes first, then one
 * swap of light and dark (between two pinks), then the light palettes.
 * Sand-to-background contrast noted.
 */
export const PALETTES: Palette[] = [
  pal('Black & white', '#000000', '#FFFFFF'), // dark, 21 : 1 (the plate opens on this)
  pal('Midnight & Coral', '#14213D', '#FF8C69'), // dark, 7.0 : 1
  pal('Teal & Sand', '#0F4C5C', '#F6D8AE'), // dark, 7.0 : 1
  pal('Forest & Lime', '#12372A', '#D4F27A'), // dark, 10.5 : 1
  pal('Charcoal & Gold', '#1F1F24', '#F2C14E'), // dark, 9.8 : 1
  pal('Burgundy & Blush', '#4A0E1F', '#FFC2D1'), // dark, 10.1 : 1
  pal('Blush & Burgundy', '#FFC2D1', '#4A0E1F'), // light, 10.1 : 1
  pal('Peach & Plum', '#FFD3B6', '#4A1942'), // light, 10.1 : 1
  pal('Butter & Cobalt', '#FFE7A3', '#1E3A8A'), // light, 8.5 : 1
  pal('Neon & Black', '#39FF14', '#0A0A0A'), // light, 14.6 : 1
  pal('Mint & Forest', '#CDEFD9', '#0E3B2E'), // light, 10.1 : 1
  pal('Sky & Navy', '#CFE8FF', '#0B2545'), // light, 12.2 : 1
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
  /** pairing the resting plate is fading toward; null follows the sound */
  private idleTarget: number | null = null;
  private idleDir = 1;
  /** background rgb, sand rgb (sRGB 0..1), ready for the shader */
  readonly rgb = new Float32Array(6);
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

  /** jump straight to the colours (no fade): a pairing's index, or the figure's on load */
  snap(meanLambda: number, index?: number) {
    this.pos = index ?? this.fromFigure(meanLambda);
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
    const g = Math.min(1, Math.max(0, (f - 0.15) / 0.7));
    return i + g * g * (3 - 2 * g);
  }

  /** the pitch picks the colour: every change of frequency shows */
  private fromPitch(hz: number) {
    return this.scale(Math.log(Math.max(hz, LOW_HZ) / LOW_HZ) / Math.log(HIGH_HZ / LOW_HZ));
  }

  /** on load the figure picks it (λ 2 broad and simple … λ 300 fine lace) */
  private fromFigure(meanLambda: number) {
    const t = Math.log(Math.max(meanLambda, 2) / 2) / Math.log(150);
    return this.scale(t);
  }

  /**
   * @param pitchHz the dominant frequency while sound is playing; null when silent,
   *   which keeps the current colours (they only change with sound)
   */
  /** while the plate rests: the next pairing along, bouncing at the ends */
  advance() {
    const last = PALETTES.length - 1;
    let next = Math.round(this.idleTarget ?? this.pos) + this.idleDir;
    if (next < 0 || next > last) {
      this.idleDir = -this.idleDir;
      next += 2 * this.idleDir;
    }
    this.idleTarget = next;
  }

  /** a stopped tone's new pitch: head for its colours, then carry on resting from there */
  aimAt(hz: number) {
    this.idleTarget = this.fromPitch(hz);
  }

  update(dt: number, pitchHz: number | null, reducedMotion: boolean) {
    if (pitchHz) this.idleTarget = null;
    else if (this.idleTarget !== null) {
      this.pos += (this.idleTarget - this.pos) * (1 - Math.exp(-dt * 1.1 * (reducedMotion ? 0.35 : 1)));
    }
    if (pitchHz) {
      const target = this.fromPitch(pitchHz);
      // following a pitch takes about a second
      const rate = 1.1 * (reducedMotion ? 0.35 : 1);
      this.pos += (target - this.pos) * (1 - Math.exp(-dt * rate));
    }
    const k = 1 - Math.exp(-dt * 10);
    this.weight.background += ((this.fixed.background ? 1 : 0) - this.weight.background) * k;
    this.weight.sand += ((this.fixed.sand ? 1 : 0) - this.weight.sand) * k;
    // the colours on screen trail the target, so even the light/dark flip fades
    this.compute(1 - Math.exp(-dt * (reducedMotion ? 1.5 : 3)));
  }

  get name() {
    if (this.fixed.background && this.fixed.sand) return 'Custom';
    return PALETTES[Math.round(this.pos)].name;
  }

  /** shown background and sand (OKLab), eased toward the target */
  private shown: [RGB, RGB] | null = null;

  /** @param ease 0..1 share of the way to move toward the target this frame (1 = jump) */
  private compute(ease = 1) {
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
    if (!this.shown || ease >= 1) this.shown = [bg, sand];
    else this.shown = [mixLab(this.shown[0], bg, ease), mixLab(this.shown[1], sand, ease)];
    const out = this.shown.map(fromLab);
    for (let n = 0; n < 2; n++) {
      this.rgb[n * 3] = out[n][0];
      this.rgb[n * 3 + 1] = out[n][1];
      this.rgb[n * 3 + 2] = out[n][2];
    }
  }
}
