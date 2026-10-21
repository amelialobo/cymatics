/**
 * Shader rendering. Plate coordinates are (x, y) ∈ [-1, 1]², y up.
 *
 * Passes per frame:
 *  1. fieldFrag    standing-wave field → half-float texture (normalised to -1..1)
 *  2. simFrag      sand simulation: ping-pong float texture of grain positions
 *  3. displayFrag  faint continuous nodal-intensity field beneath the sand
 *  4. pointsVert   grains drawn as additive points straight from the position texture
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
uniform float uV;            // vibration
uniform float uKick;         // transient bounce
uniform float uJitter;       // bounce at antinodes, scaled by |f|²
uniform float uDiffuse;      // small constant bounce: gives lines their width
uniform float uPull;         // Newton step toward the nodal line
uniform float uMaxStep;
uniform float uFrame;
uniform vec4 uImp[4];        // pointer impulses: x, y, radius, strength
uniform int uImpN;
${hash}

float field(vec2 p) { return texture2D(uField, p * 0.5 + 0.5).r; }

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

  // grains that fall off the edge are sprinkled back on
  if (abs(p.x) > uBounds.x || abs(p.y) > uBounds.y) {
    p = (vec2(hash12(seed + 3.7), hash12(seed + 9.1)) * 2.0 - 1.0) * uBounds;
  }
  gl_FragColor = vec4(p, P.zw);
}`;

export const displayFrag = /* glsl */ `
precision highp float;
uniform sampler2D uField;
uniform float uFieldTexel;
uniform vec2 uRes;    // drawing buffer, device px
uniform float uSide;  // plate side, device px
uniform float uLine;  // strength of the nodal-intensity lines
uniform float uHaze;  // antinode haze

float field(vec2 uv) { return texture2D(uField, uv).r; }

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * uSide);
  float edge = max(abs(p.x), abs(p.y));
  if (edge > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 uv = p * 0.5 + 0.5;
  float h = uFieldTexel;
  float f = field(uv);
  vec2 g = vec2(field(uv + vec2(h, 0.0)) - field(uv - vec2(h, 0.0)),
                field(uv + vec2(0.0, h)) - field(uv - vec2(0.0, h))) / (4.0 * h);
  // distance to the nodal line, in plate units
  float d = abs(f) / max(length(g), 1e-3);
  float px = 2.0 / uSide;
  float line = exp(-pow(d / (px * 2.2), 2.0)) * uLine;
  float haze = pow(abs(f), 3.0) * uHaze;
  float fade = smoothstep(1.0, 0.99, edge);
  gl_FragColor = vec4(vec3((line + haze) * fade), 1.0);
}`;

export const pointsVert = /* glsl */ `
precision highp float;
uniform sampler2D uPos;
uniform vec2 uScale;     // plate units → clip space
uniform float uPointSize;
uniform float uBright;
varying float vB;
void main() {
  vec4 P = texture2D(uPos, position.xy);
  gl_Position = vec4(P.xy * uScale, 0.0, 1.0);
  float edge = max(abs(P.x), abs(P.y));
  vB = P.w * uBright * smoothstep(1.0, 0.99, edge);
  gl_PointSize = uPointSize;
}`;

export const pointsFrag = /* glsl */ `
precision highp float;
varying float vB;
void main() {
  gl_FragColor = vec4(vec3(vB), 1.0);
}`;
