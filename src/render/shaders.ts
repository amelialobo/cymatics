/**
 * Shader rendering. Plate coordinates are (x, y) ∈ [-1, 1]², y up.
 *
 * Passes per frame:
 *  1. fieldFrag    standing-wave field → half-float texture (normalised to -1..1)
 *  2. simFrag      sand simulation: ping-pong float texture of grain positions
 *  3. pointsVert   grains accumulated as additive points into a coverage buffer
 *  4. displayFrag  colour: gradient background, faint nodal-intensity lines, sand on top
 */
import { MAX_ACTIVE } from '../pattern/modes';

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
varying vec2 vUv;
uniform vec4 uModes[MAXM];   // n, m, s, weight
uniform int uCount;
uniform int uSym;            // 0 free plate, 1 mirror, 2 clamped, 3 radial
uniform vec4 uRadial;        // weight, ring frequency k, superellipse exponent p
uniform vec4 uNoise[8];      // ax, ay, phase, amplitude
uniform float uNoiseAmt;
uniform float uWarp;
uniform float uNorm;

float superR(vec2 p, float e) {
  vec2 a = pow(abs(p) + 1e-6, vec2(e));
  return pow(a.x + a.y, 1.0 / e);
}

void main() {
  vec2 p0 = vUv * 2.0 - 1.0;
  // a hair of warp: the plate is real metal, not a perfect equation
  vec2 p = p0 + uWarp * vec2(
    sin(4.7 * p0.y + 1.3) + 0.5 * sin(9.1 * p0.y + 2.0 * p0.x),
    sin(4.1 * p0.x + 0.4) + 0.5 * sin(8.3 * p0.x - 1.7 * p0.y));

  float rr = superR(p, uRadial.z);
  float th = atan(p.y, p.x);
  float f = 0.0;
  float total = 0.0;

  for (int q = 0; q < MAXM; q++) {
    if (q >= uCount) break;
    vec4 M = uModes[q];
    float n = M.x, m = M.y, s = M.z, w = M.w;
    total += w;
    float v;
    if (uSym == 0) {
      v = cos(n * PI * p.x) * cos(m * PI * p.y) + s * cos(m * PI * p.x) * cos(n * PI * p.y);
    } else if (uSym == 1) {
      v = cos(n * PI * p.x) * cos(m * PI * p.y) + s * 0.55 * cos(m * PI * p.x) * cos(n * PI * p.y);
    } else if (uSym == 2) {
      vec2 u = p * 0.5 + 0.5;
      float a = n + 1.0, b = m + 1.0;
      float sg = a == b ? 1.0 : -1.0;
      v = sin(a * PI * u.x) * sin(b * PI * u.y) + sg * sin(b * PI * u.x) * sin(a * PI * u.y);
    } else {
      v = cos(n * PI * rr * 0.75) * cos(2.0 * m * th);
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
uniform float uV;            // vibration
uniform float uKick;         // transient bounce
uniform float uJitter;       // bounce at antinodes, scaled by |f|²
uniform float uDiffuse;      // small constant bounce: gives lines their width
uniform float uPull;         // Newton step toward the nodal line
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
  float f = texture2D(uField, uv).r;
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
  vec2 s = -g * (uPull * P.z * f / (dot(g, g) + 1e-4));
  float sl = length(s);
  if (sl > uMaxStep) s *= uMaxStep / sl;

  vec2 seed = vUv * 4096.0 + vec2(uFrame * 0.6180339, uFrame * 0.4142135);
  vec2 r = vec2(hash12(seed), hash12(seed + 17.13)) - 0.5;
  p += s + r * amp;

  // the letters stay bare: grains that land on them are sprinkled elsewhere
  bool lifted = uTitleMix >= 1.0 && texture2D(uTitle, p * 0.5 + 0.5).r > 0.5 && hash12(seed + 5.9) < uTitleGain;

  // grains that fall off the edge are sprinkled back on
  if (lifted || abs(p.x) > uBounds.x || p.y > uBounds.y || p.y < uFloor) {
    p = vec2((hash12(seed + 3.7) * 2.0 - 1.0) * uBounds.x, mix(uFloor, uBounds.y, hash12(seed + 9.1)));
  }
  gl_FragColor = vec4(p, P.zw);
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
uniform float uLettersGain;  // 0..1: how far the stamp has lifted
varying float vB;
${hash}
void main() {
  vec4 P = texture2D(uPos, position.xy);
  gl_Position = vec4(P.xy * uScale + uOffset, 0.0, 1.0);
  // while the canvas overhangs the stage, sand below the plate stays visible
  float edge = max(abs(P.x), uOffset.y > 0.0 ? P.y : abs(P.y));
  vB = P.w * uBright * smoothstep(1.0, 0.99, edge);
  gl_PointSize = uPointSize;
  if (uDensityMix > 0.0) {
    // a scattered handful rather than an even layer
    float d = texture2D(uDensity, P.xy * 0.5 + 0.5).r;  // sparse near the word, none far away
    vec2 uv = P.xy * 0.5 + 0.5;
    float inLetter = step(0.5, texture2D(uLetters, uv).r) * step(hash12(position.xy * 4096.0 + 2.9), uLettersGain);
    if (inLetter > 0.0 || hash12(position.xy * 4096.0 + 5.3) > mix(1.0, d, uDensityMix)) {
      gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
      return;
    }
    // the odd grain catches the light, like glitter
    if (hash12(position.xy * 4096.0 + 11.7) < 0.015 * uDensityMix) {
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
