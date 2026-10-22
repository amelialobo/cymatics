/**
 * Shader rendering. Plate coordinates are (x, y) ∈ [-1, 1]², y up.
 *
 * Passes per frame:
 *  1. fieldFrag    the plate's mode sum → half-float texture (normalised to -1..1)
 *  2. simFrag      sand simulation: ping-pong float texture of grain positions
 *  3. pointsVert   grains accumulated as additive points into a coverage buffer
 *  4. displayFrag  colour: gradient background, faint nodal-intensity lines, sand on top
 */
import { MAX_ACTIVE } from '../pattern/modes';
import { DISC_R, TABLE_W } from '../pattern/plates';

export const quadVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

export const fieldFrag = /* glsl */ `
precision highp float;
#define MAXM ${MAX_ACTIVE}
#define PI 3.141592653589793
#define DISC_R ${DISC_R.toFixed(6)}
#define TABLE_W ${TABLE_W.toFixed(1)}
varying vec2 vUv;
uniform vec4 uModes[MAXM];   // n, m, s, weight
uniform int uCount;
uniform int uSym;            // 0 free steel, 1 wood, 2 pinned edges, 3 round
uniform sampler2D uTable;    // round plate: one radial profile per row
uniform float uTableRows;
uniform vec4 uRadial;        // weight, ring frequency k, superellipse exponent p
uniform vec4 uNoise[8];      // ax, ay, phase, amplitude
uniform float uNoiseAmt;
uniform float uWarp;
uniform float uNorm;

float superR(vec2 p, float e) {
  vec2 a = pow(abs(p) + 1e-6, vec2(e));
  return pow(a.x + a.y, 1.0 / e);
}

// free-free beam with j nodes (see beam() in plates.ts)
float beam(float j, float x) {
  if (j < 0.5) return 1.0;
  float k = j < 2.5 ? 2.365020372 : (j - 0.5) * PI * 0.5;
  return cos(k * x) + cos(k) * (exp(k * (x - 1.0)) + exp(-k * (x + 1.0))) / (1.0 + exp(-2.0 * k));
}

void main() {
  vec2 p0 = vUv * 2.0 - 1.0;
  // a hair of warp: the plate is real metal, not a perfect equation
  vec2 p = p0 + uWarp * vec2(
    sin(4.7 * p0.y + 1.3) + 0.5 * sin(9.1 * p0.y + 2.0 * p0.x),
    sin(4.1 * p0.x + 0.4) + 0.5 * sin(8.3 * p0.x - 1.7 * p0.y));

  float rr = superR(p, uRadial.z);
  float th = atan(p.y, p.x);
  float rho = min(length(p) / DISC_R, 1.0);
  float f = 0.0;
  float total = 0.0;

  for (int q = 0; q < MAXM; q++) {
    if (q >= uCount) break;
    vec4 M = uModes[q];
    float n = M.x, m = M.y, s = M.z, w = M.w;
    total += abs(w);
    float v;
    if (uSym <= 1) {
      v = beam(n, p.x) * beam(m, p.y);
      if (s > 0.5) v += beam(m, p.x) * beam(n, p.y);
    } else if (uSym == 2) {
      vec2 u = p * 0.5 + 0.5;
      v = sin(n * PI * u.x) * sin(m * PI * u.y) + s * sin(m * PI * u.x) * sin(n * PI * u.y);
    } else {
      float r = texture2D(uTable, vec2((rho * (TABLE_W - 1.0) + 0.5) / TABLE_W, (m + 0.5) / uTableRows)).r;
      v = n > 0.5 ? r * cos(n * th) : r;
    }
    f += w * v;
  }

  // concentric rounded squares around the drive bolt
  if (uRadial.x > 0.002) {
    f += uRadial.x * exp(-1.6 * rr) * cos(uRadial.y * PI * rr);
    total += uRadial.x;
  }

  float nz = 0.0;
  for (int i = 0; i < 8; i++) {
    vec4 W = uNoise[i];
    nz += W.w * sin(W.x * p.x + W.y * p.y + W.z);
  }
  f += uNoiseAmt * max(total, 1e-3) * nz;

  gl_FragColor = vec4(f * uNorm, 0.0, 0.0, 1.0);
}`;

/** the coverage buffer is 8-bit: grains are stored at 1/4 so dense lines don't clip */
const ACCUM = '#define ACCUM_SCALE 4.0';

const hash = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}`;

export const simFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uPos;      // xy position, z mobility, w brightness
uniform sampler2D uField;
uniform float uFieldTexel;   // 1 / field resolution
uniform vec2 uBounds;        // visible part of the plate
uniform float uFloor;        // lowest visible y: below -uBounds.y while the canvas overhangs
uniform float uRehome;       // per step, the chance a grain off the plate is put back on it
uniform float uRows;         // active rows of the particle texture
uniform float uSize;         // particle texture side
uniform float uV;            // vibration
uniform float uKick;         // transient bounce
uniform float uJitter;       // bounce at antinodes, scaled by |f|²
uniform float uDiffuse;      // small constant bounce: gives lines their width
uniform float uPull;         // Newton step toward the nodal line
uniform float uDriftLeft;    // s until sand at the title's ends reaches the figure; -1000: uPull instead
uniform float uDriftLag;     // the middle of the title arrives this much later
uniform float uF60;          // this step, in 60 Hz frames
uniform float uMaxStep;
uniform float uFrame;
uniform vec4 uImp[4];        // pointer impulses: x, y, radius, strength
uniform int uImpN;
uniform sampler2D uTitle;    // opening title: the stamp's letters
uniform float uTitleMix;
uniform float uTitleGain;    // 0..1: how far the stamp has lifted
uniform float uTitleShake;   // 0 still under the stamp, 1 letters shake as the plate takes over
uniform float uTitleHold;    // the middle of the word's mix, which lingers after the ends let go
uniform float uTitleHalf;    // half the word's width, plate units
${hash}

float field(vec2 p) {
  vec2 uv = p * 0.5 + 0.5;
  // below the plate (the strip under the dock during the intro) the figure
  // carries on as its mirror image, which meets the plate's edge seamlessly
  float f = texture2D(uField, vec2(uv.x, abs(uv.y))).r;
  if (uTitleMix <= 0.0 && uTitleHold <= 0.0) return f;
  // the plate shakes hardest in the middle, so the middle holds on longer
  float m = mix(uTitleMix, max(uTitleMix, uTitleHold), 1.0 - smoothstep(0.0, uTitleHalf, abs(p.x)));
  return mix(f, texture2D(uTitle, uv).r * uTitleGain * uTitleShake, m);
}

void main() {
  vec4 P = texture2D(uPos, vUv);
  vec2 p = P.xy;
  float h = 2.0 * uFieldTexel;
  float f = field(p);
  vec2 g = vec2(field(p + vec2(h, 0.0)) - field(p - vec2(h, 0.0)),
                field(p + vec2(0.0, h)) - field(p - vec2(0.0, h))) / (2.0 * h);
  float af = abs(f);

  // sand is thrown in proportion to how hard the plate moves beneath it
  float amp = uV * (uJitter * af * af + uDiffuse * (0.35 + af)) + uKick * (0.12 + af);
  for (int i = 0; i < 4; i++) {
    if (i >= uImpN) break;
    vec4 I = uImp[i];
    float d = length(p - I.xy);
    amp += I.w * max(0.0, 1.0 - d / I.z);
  }

  // and drifts toward the line where the plate stays still
  // while the title merges, each grain covers an even share of the way per
  // step, timed to arrive with its part of the word: the middle a little later
  float pull = uPull;
  if (uDriftLeft > -100.0) {
    float mid = 1.0 - smoothstep(0.0, uTitleHalf, abs(p.x));
    pull = min(0.6, uF60 / max(1.0, (uDriftLeft + uDriftLag * mid) * 60.0));
  }
  vec2 s = -g * (pull * P.z * f / (dot(g, g) + 1e-4));
  float sl = length(s);
  if (sl > uMaxStep) s *= uMaxStep / sl;

  vec2 seed = vUv * 4096.0 + vec2(uFrame * 0.6180339, uFrame * 0.4142135);
  vec2 r = vec2(hash12(seed), hash12(seed + 17.13)) - 0.5;
  p += s + r * amp;

  // the letters stay bare: grains that land on them are sprinkled elsewhere
  bool lifted = uTitleMix >= 1.0 && texture2D(uTitle, p * 0.5 + 0.5).r > 0.5 && hash12(seed + 5.9) < uTitleGain;

  bool off = abs(p.x) > uBounds.x || p.y > uBounds.y || p.y < uFloor;
  if (lifted || (off && uRehome >= 1.0)) {
    // grains that fall off the edge are sprinkled back on
    p = vec2((hash12(seed + 3.7) * 2.0 - 1.0) * uBounds.x, mix(uFloor, uBounds.y, hash12(seed + 9.1)));
  } else if (off) {
    // or, unhurried, wait where they are, then land beside a grain on the plate
    if (hash12(seed + 12.7) < uRehome) {
      vec2 src = vec2(hash12(seed + 3.7), (floor(hash12(seed + 9.1) * uRows) + 0.5) / uSize);
      p = texture2D(uPos, src).xy + (vec2(hash12(seed + 13.3), hash12(seed + 15.1)) - 0.5) * 0.004;
    } else p = P.xy;
  }
  gl_FragColor = vec4(p, P.zw);
}`;

/**
 * Fresh sand sprinkled evenly over the visible plate, every grain at once on
 * the GPU: a few in sixteen are fine dust, slower and dimmer than the rest.
 */
export const seedFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uBounds;    // visible part of the plate
uniform float uFloor;    // lowest visible y
uniform float uSeed;     // a new sprinkling each time
${hash}
void main() {
  vec2 h = vUv * 4096.0 + uSeed;
  bool dust = hash12(h + 1.3) < 0.06;
  vec2 p = vec2((hash12(h + 2.1) * 2.0 - 1.0) * uBounds.x, mix(uFloor, uBounds.y, hash12(h + 3.7)));
  float a = hash12(h + 4.9), b = hash12(h + 6.1);
  float mobility = dust ? 0.12 + a * 0.3 : 0.7 + a * 0.3;
  float brightness = dust ? 0.2 + b * 0.3 : 0.35 + b * hash12(h + 7.9) * 0.65;
  gl_FragColor = vec4(p, mobility, brightness);
}`;

/**
 * More sand poured onto a plate that is already singing: each new grain
 * (rows from uOld up) starts right beside one already on the figure, so the
 * lines simply fill out instead of a fresh layer drifting in.
 */
export const pourFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uPos;
uniform float uOld;      // rows already active
uniform float uSize;     // particle texture side
uniform float uJitter;   // plate units
${hash}
void main() {
  vec4 P = texture2D(uPos, vUv);
  if (floor(vUv.y * uSize) >= uOld) {
    vec2 h = vUv * 4096.0;
    vec2 src = vec2(hash12(h + 4.1), (floor(hash12(h + 1.7) * uOld) + 0.5) / uSize);
    vec2 r = vec2(hash12(h + 8.3), hash12(h + 6.2)) - 0.5;
    P.xy = texture2D(uPos, src).xy + r * uJitter;
  }
  gl_FragColor = P;
}`;

export const displayFrag = /* glsl */ `
${ACCUM}
precision highp float;
uniform sampler2D uField;
uniform sampler2D uAccum;   // how much sand landed on each pixel
uniform float uFieldTexel;
uniform vec2 uRes;    // drawing buffer, device px
uniform vec2 uCentre; // plate centre in the drawing buffer, device px
uniform float uSide;  // plate side, device px
uniform float uLine;  // strength of the nodal-intensity lines
uniform float uHaze;  // antinode haze
uniform vec3 uBgIn;   // background
uniform vec3 uSand;

float field(vec2 uv) { return texture2D(uField, uv).r; }

void main() {
  vec2 p = (gl_FragCoord.xy - uCentre) / (0.5 * uSide);
  vec2 uv = clamp(p * 0.5 + 0.5, 0.0, 1.0);
  float h = uFieldTexel;
  float f = field(uv);
  vec2 g = vec2(field(uv + vec2(h, 0.0)) - field(uv - vec2(h, 0.0)),
                field(uv + vec2(0.0, h)) - field(uv - vec2(0.0, h))) / (4.0 * h);
  // distance to the nodal line, in plate units
  float d = abs(f) / max(length(g), 1e-3);
  float px = 2.0 / uSide;
  float line = exp(-pow(d / (px * 2.2), 2.0)) * uLine;
  float haze = pow(abs(f), 3.0) * uHaze;

  // one even background colour across the whole plate
  vec3 bg = uBgIn;
  // antinodes catch a little light; the nodal lines show faintly in the sand colour
  // nothing beyond the plate's edge, where the canvas overhangs it
  haze *= step(-1.0, p.y);
  line *= step(-1.0, p.y);
  bg = mix(bg, mix(uBgIn, vec3(1.0), 0.25), haze);
  bg = mix(bg, uSand, line);

  float a = texture2D(uAccum, gl_FragCoord.xy / uRes).r * ACCUM_SCALE;
  float cover = 1.0 - exp(-2.2 * a);
  gl_FragColor = vec4(mix(bg, uSand, cover), 1.0);
}`

export const pointsVert = /* glsl */ `
precision highp float;
uniform sampler2D uPos;
uniform vec2 uScale;     // plate units → clip space
uniform vec2 uOffset;    // the plate centre, clip space
uniform float uPointSize;
uniform float uBright;
uniform sampler2D uDensity;  // opening title: share of the sand that shows, by place
uniform float uDensityMix;
uniform sampler2D uLetters;  // the title's letters, kept bare of sand
uniform float uLettersGain;  // 0..1: how bare the letters are kept
uniform float uTitleHold;    // the middle of the word's mix, which lingers after the ends let go
uniform float uTitleHalf;    // half the word's width, plate units
varying float vB;
${hash}
void main() {
  vec4 P = texture2D(uPos, position.xy);
  gl_Position = vec4(P.xy * uScale + uOffset, 0.0, 1.0);
  // while the canvas overhangs the stage, sand below the plate stays visible
  float edge = max(abs(P.x), uOffset.y > 0.0 ? P.y : abs(P.y));
  vB = P.w * uBright * smoothstep(1.0, 0.99, edge);
  gl_PointSize = uPointSize;
  if (uDensityMix > 0.0 || uTitleHold > 0.0) {
    // the word lets go at its ends first, its middle a little later
    float m = mix(uDensityMix, max(uDensityMix, uTitleHold), 1.0 - smoothstep(0.0, uTitleHalf, abs(P.x)));
    // a scattered handful rather than an even layer
    float d = texture2D(uDensity, P.xy * 0.5 + 0.5).r;  // sparse near the word, none far away
    vec2 uv = P.xy * 0.5 + 0.5;
    float inLetter = step(0.5, texture2D(uLetters, uv).r) * step(hash12(position.xy * 4096.0 + 2.9), uLettersGain * m);
    if (inLetter > 0.0 || hash12(position.xy * 4096.0 + 5.3) > mix(1.0, d, m)) {
      gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
      return;
    }
    // the odd grain catches the light, like glitter
    if (hash12(position.xy * 4096.0 + 11.7) < 0.015 * m) {
      gl_PointSize = uPointSize * 2.0;
      vB *= 1.5;
    }
  }
}`;

export const pointsFrag = /* glsl */ `
${ACCUM}
precision highp float;
varying float vB;
void main() {
  gl_FragColor = vec4(vec3(vB / ACCUM_SCALE), 1.0);
}`
