// Materials of the living hilts' pieces (live/kit.ts): LIT, shaded like the hands and knife (player/materials.ts solid:
// the same studio key and ambient, the map's light on top, the detail tiers and, on Enhanced / Cinematic, the scene in
// polished metal via finishes/detail.ts), plus self-lit parts that keep their light on a dark map; and GLOW, additive
// soft sprites and segments (the viewmodel is drawn after the post chain, so this is its glow: no bloom pass exists
// there, and none is added).
//
// Per frame a design writes LiveUniforms: uPiece (knife-local... bind-space transforms of its moving pieces), uMorph
// (how far each piece is toward its second shape), uChan (per piece: emission tint + intensity, read by the glowing
// materials and by the glow sprites on that channel), uLive (design parameters: the eye's gaze, the runes' levels).

import * as THREE from "three";
import type { PlayerUniforms } from "../../../player/materials";
import { NOISE_GLSL } from "../../finishes/glsl";
import { DETAIL_PARS } from "../../finishes/detail";
import { CHANNELS, PIECES } from "./kit";

export interface LiveUniforms {
  uPiece: THREE.IUniform<THREE.Matrix4[]>;
  uMorph: THREE.IUniform<number[]>;
  uChan: THREE.IUniform<THREE.Vector4[]>;
  uLive: THREE.IUniform<THREE.Vector4[]>;
  /** Left-handed view (the root is mirrored): lettering flips back so it reads. */
  uMirror: THREE.IUniform<number>;
}

export function liveUniforms(): LiveUniforms {
  return {
    uPiece: { value: Array.from({ length: PIECES }, () => new THREE.Matrix4()) },
    uMorph: { value: new Array(PIECES).fill(0) },
    uChan: { value: Array.from({ length: CHANNELS }, () => new THREE.Vector4(1, 1, 1, 0)) },
    uLive: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
    uMirror: { value: 0 },
  };
}

const LIT_VERTEX = /* glsl */ `
attribute vec3 position2;
attribute vec3 normal2;
attribute vec3 partColor;
attribute float accent;
attribute vec4 finishUV;
uniform mat4 uPiece[${PIECES}];
uniform float uMorph[${PIECES}];
varying vec3 vAlb;
varying vec4 vLv;
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying float vPiece;
#include <common>
#include <skinning_pars_vertex>
void main() {
  int pi = int(accent + 0.5);
  float mw = uMorph[pi];
  mat4 M = uPiece[pi];
  vec3 objectNormal = mat3(M) * normalize(mix(normal, normal2, clamp(mw, -0.5, 1.5)) + 1e-6);
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  vec3 transformed = (M * vec4(mix(position, position2, mw), 1.0)).xyz;
  #include <skinning_vertex>
  #include <project_vertex>
  vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vNormalW = normalize(mat3(modelMatrix) * objectNormal);
  vAlb = partColor;
  vLv = finishUV;
  vPiece = accent;
}`;

const LIT_FRAGMENT = /* glsl */ `
uniform float uCosTier;
uniform vec3 uMapLight;
uniform vec4 uChan[${CHANNELS}];
uniform vec4 uLive[8];
uniform float uMirror;
varying vec3 vAlb;
varying vec4 vLv;
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying float vPiece;
${NOISE_GLSL}
${DETAIL_PARS}

// Distance to segment ab.
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
// Elder Futhark letters as straight strokes in a unit box (x right, y up): 0 hagalaz, 1 laguz, 2 ansuz, 3 uruz,
// 4 perthro, 5 raidho. Distance to the nearest stroke.
float runeD(int r, vec2 p) {
  float d = 1e3;
  if (r == 0) {
    d = min(sdSeg(p, vec2(0.22, 0.0), vec2(0.22, 1.0)), sdSeg(p, vec2(0.78, 0.0), vec2(0.78, 1.0)));
    d = min(d, sdSeg(p, vec2(0.22, 0.64), vec2(0.78, 0.36)));
  } else if (r == 1) {
    d = min(sdSeg(p, vec2(0.32, 0.0), vec2(0.32, 1.0)), sdSeg(p, vec2(0.32, 1.0), vec2(0.76, 0.66)));
  } else if (r == 2) {
    d = min(sdSeg(p, vec2(0.3, 0.0), vec2(0.3, 1.0)), sdSeg(p, vec2(0.3, 1.0), vec2(0.76, 0.7)));
    d = min(d, sdSeg(p, vec2(0.3, 0.7), vec2(0.76, 0.4)));
  } else if (r == 3) {
    d = min(sdSeg(p, vec2(0.22, 0.0), vec2(0.22, 1.0)), sdSeg(p, vec2(0.22, 1.0), vec2(0.78, 0.6)));
    d = min(d, sdSeg(p, vec2(0.78, 0.6), vec2(0.78, 0.0)));
  } else if (r == 4) {
    d = min(sdSeg(p, vec2(0.24, 0.0), vec2(0.24, 1.0)), sdSeg(p, vec2(0.24, 1.0), vec2(0.54, 0.76)));
    d = min(d, sdSeg(p, vec2(0.54, 0.76), vec2(0.8, 0.98)));
    d = min(d, sdSeg(p, vec2(0.24, 0.0), vec2(0.54, 0.24)));
    d = min(d, sdSeg(p, vec2(0.54, 0.24), vec2(0.8, 0.02)));
  } else {
    d = min(sdSeg(p, vec2(0.26, 0.0), vec2(0.26, 1.0)), sdSeg(p, vec2(0.26, 1.0), vec2(0.72, 0.8)));
    d = min(d, sdSeg(p, vec2(0.72, 0.8), vec2(0.26, 0.56)));
    d = min(d, sdSeg(p, vec2(0.26, 0.56), vec2(0.76, 0.0)));
  }
  return d;
}

// Worn iron: dark, pitted, a little lighter where it's been handled.
vec3 ironAlb(vec3 base, vec2 q) {
  float n = fbm(q * 3.0 + 7.0);
  float pit = smoothstep(0.25, 0.45, gnoise(q * 17.0 + 3.0));
  return base * (0.85 + 0.5 * n) * (1.0 - 0.35 * pit);
}

// Albedo, emission and surface response of a fragment by material code (live/kit.ts MAT).
vec3 litAlbedo(float code, vec3 ln, out vec3 emit, out float spec, out float pw, out float metal, out float coat, out float sheen) {
  vec3 alb = vAlb;
  emit = vec3(0.0); spec = 0.15; pw = 20.0; metal = 0.0; coat = 0.0; sheen = 0.0;
  int pi = int(vPiece + 0.5);
  vec4 ch = uChan[pi];
  if (code < 0.5) return alb;
  if (code < 1.5) { metal = 1.0; return alb; }
  if (code < 2.5) { metal = 0.5; return alb; }
  if (code < 3.5) { spec = 0.9; pw = 90.0; coat = 0.55; return alb; }
  if (code < 4.5) {
    // EYE: vLv.yzw is the point's direction from the eye's centre (knife-local). uLive[0] = gaze (xyz) + pupil radius
    // (radians), uLive[1] = iris colour + its self-light, uLive[2].x = iris radius (radians).
    vec3 n = normalize(ln);
    vec3 g = normalize(uLive[0].xyz);
    float ang = acos(clamp(dot(n, g), -1.0, 1.0));
    vec3 t1 = normalize(abs(g.z) < 0.95 ? cross(g, vec3(0.0, 0.0, 1.0)) : cross(g, vec3(0.0, 1.0, 0.0)));
    vec3 t2 = cross(g, t1);
    float th = atan(dot(n, t2), dot(n, t1));
    float irisR = uLive[2].x, pupil = uLive[0].w;
    vec3 irisC = uLive[1].rgb;
    // Sclera: wet ivory, warmer and veined away from the iris, shaded toward the lids.
    vec3 scl = vec3(0.80, 0.74, 0.62);
    float far = smoothstep(irisR + 0.15, 1.6, ang);
    float vein = 1.0 - smoothstep(0.0, 0.045, abs(gnoise(vec2(th * 2.2, ang * 3.0) + 4.0) + 0.25 * gnoise(vec2(th * 7.0, ang * 9.0))));
    scl = mix(scl, vec3(0.62, 0.16, 0.20), vein * far * 0.75);
    scl = mix(scl, vec3(0.55, 0.36, 0.40), far * 0.35);
    // Iris: radial fibres, a bright collarette near the pupil, a dark limbal ring.
    float r01 = clamp((ang - pupil) / max(irisR - pupil, 1e-3), 0.0, 1.0);
    float fib = 0.75 + 0.35 * gnoise(vec2(th * 6.0, r01 * 3.0)) + 0.25 * gnoise(vec2(th * 19.0, r01 * 2.0 + 5.0));
    vec3 ir = irisC * fib;
    ir = mix(ir * 1.5 + 0.05, ir, smoothstep(0.05, 0.35, r01));
    ir = mix(ir, irisC * 0.18, smoothstep(0.62, 1.0, r01));
    float inIris = 1.0 - smoothstep(irisR - 0.02, irisR + 0.02, ang);
    float inPupil = 1.0 - smoothstep(pupil - 0.025, pupil + 0.015, ang);
    alb = mix(scl, ir, inIris);
    alb = mix(alb, vec3(0.008, 0.006, 0.01), inPupil);
    emit = ir * uLive[1].w * inIris * (1.0 - inPupil);
    spec = 1.4; pw = 140.0; coat = 0.8;
    return alb;
  }
  if (code < 5.5) {
    // RUNES cut through worn iron. vLv.y is the letter coordinate (cell c spans c..c+1, read left to right by a viewer
    // facing that face; < 0 = no letter here), vLv.z up the letter 0..1, vLv.w the face (|w| > 0.5: lettered).
    // uLive[2].xyzw / uLive[3].xy: each cell's light 0..1 (cells 0..5); uLive[3].w the first word's length (the
    // mirrored view reverses it); uChan[piece] the light's colour. Letters: live/material.ts runeD.
    alb = ironAlb(vAlb, vec2(vLv.y * 0.6, vLv.z) + ln.xy);
    metal = 0.5; spec = 0.3; pw = 30.0;
    // Silver wire inlaid along the lettered band's top and bottom edges.
    if (abs(vLv.w) > 0.5) {
      float e = min(abs(vLv.z - 0.0), abs(vLv.z - 1.0));
      float wire = 1.0 - smoothstep(0.025, 0.045, e);
      alb = mix(alb, vec3(0.78, 0.8, 0.84), wire);
      metal = mix(metal, 1.0, wire);
    }
    if (abs(vLv.w) > 0.5 && vLv.y >= 0.0) {
      float W = uLive[3].w;
      float x = vLv.y;
      if (uMirror > 0.5) x = x < W ? W - x : 2.0 * W + 1.0 - x;
      float cell = floor(x);
      vec2 gp = (vec2(fract(x), vLv.z) - vec2(0.17, 0.17)) / vec2(0.66, 0.66);
      int ci = int(cell);
      float d = runeD(ci, gp) * 0.66;
      float lvl = ci == 0 ? uLive[2].x : ci == 1 ? uLive[2].y : ci == 2 ? uLive[2].z : ci == 3 ? uLive[2].w : ci == 4 ? uLive[3].x : uLive[3].y;
      float aa = fwidth(d) + 1e-4;
      float stroke = 1.0 - smoothstep(0.05 - aa, 0.05 + aa, d);
      float bleed = exp(-d * d * 300.0);
      float inside = step(-0.1, gp.x) * step(gp.x, 1.1) * step(-0.1, gp.y) * step(gp.y, 1.1) * step(0.0, cell) * step(cell, 5.5);
      // The cut: dark when asleep, its floor lit from within as the letter wakes, frost-white at full.
      alb = mix(alb, vec3(0.012, 0.016, 0.022), stroke * inside);
      // Rime: the iron round a waking letter frosts over, pale and cold.
      alb = mix(alb, vec3(0.62, 0.74, 0.82), (1.0 - stroke) * exp(-d * d * 60.0) * 0.55 * lvl * inside);
      vec3 hot = mix(ch.rgb, vec3(0.9, 0.97, 1.0), smoothstep(0.7, 1.0, lvl));
      emit = (hot * stroke * (0.12 + 1.9 * lvl) + ch.rgb * bleed * 0.45 * lvl) * inside * ch.a;
      metal = mix(metal, 0.0, stroke * inside);
    }
    return alb;
  }
  if (code < 6.5) {
    // Self-lit: the colour times its channel.
    emit = alb * ch.rgb * ch.a;
    return alb * 0.25;
  }
  if (code < 8.5 && code > 7.5) {
    // FLESH (lids): vLv.y round the lid 0..1, vLv.z from its root (0) to its rim (1). Leathery folds that follow the
    // rim, fine bumps, a wet darker-pink inner edge.
    float t = vLv.z, a = vLv.y;
    float fold = 0.5 + 0.5 * sin(t * 26.0 + gnoise(vec2(a * 9.0, t * 2.0)) * 3.0);
    float bump = gnoise(vec2(a * 40.0, t * 14.0));
    alb = vAlb * (0.78 + 0.3 * fold + 0.12 * bump);
    float rim = smoothstep(0.86, 0.97, t);
    alb = mix(alb, vec3(0.24, 0.05, 0.09), rim);
    spec = mix(0.28, 1.0, rim); pw = mix(18.0, 90.0, rim); sheen = 0.25; coat = rim * 0.5;
    return alb;
  }
  if (code > 8.5 && code < 9.5) {
    // BRASS: polished, with a fine circular graining (perlage) round vLv.yz and engraved rings at vLv.w.
    vec2 q = vLv.yz * 9.0;
    vec2 cell = floor(q);
    float rr = length(fract(q) - 0.5 + 0.18 * fh22(cell));
    float perl = 0.5 + 0.5 * sin(rr * 40.0);
    alb = vAlb * (0.9 + 0.12 * perl);
    metal = 1.0;
    return alb;
  }
  if (code > 9.5 && code < 10.5) {
    // JEWEL: deep colour, a hot inner point, a glassy coat.
    float f = pow(max(dot(normalize(ln), vec3(0.0, 0.0, 1.0)), 0.0), 2.0);
    emit = alb * (0.15 + 0.25 * f) + alb * ch.rgb * ch.a;
    spec = 1.6; pw = 160.0; coat = 0.9;
    return alb * 0.6;
  }
  if (code > 10.5 && code < 11.5) {
    // LEAF: vLv.y along the leaf 0..1, vLv.z across -1..1. A pale midrib, side veins, waxy.
    float u = vLv.y, v = vLv.z;
    float mid = 1.0 - smoothstep(0.02, 0.07, abs(v));
    float side = 1.0 - smoothstep(0.03, 0.09, abs(fract(u * 7.0 - abs(v) * 1.6) - 0.5) * 2.0 * 0.5);
    alb = vAlb * (0.85 + 0.25 * gnoise(vec2(u * 12.0, v * 5.0)));
    alb = mix(alb, vAlb * 1.6 + 0.05, max(mid, side * 0.45 * smoothstep(0.1, 0.4, abs(v))));
    alb = mix(alb, vAlb * 0.55, smoothstep(0.75, 1.0, abs(v)));
    spec = 0.45; pw = 40.0; sheen = 0.3;
    return alb;
  }
  if (code > 11.5 && code < 12.5) {
    // CRACKS: blackened steel split by veins of banked heat. vLv.yzw a surface point; uLive[0].x the heat (0..1+),
    // uLive[0].y a slow drift of the heat along the cracks.
    vec3 P = vLv.yzw;
    vec2 q = vec2(P.z * 2.2 + P.x * 1.3, P.y * 2.6 - P.x * 0.9);
    float n = fbm(q * 0.85 + 3.0);
    float crack = 1.0 - smoothstep(0.0, 0.032, abs(n));
    float crack2 = (1.0 - smoothstep(0.0, 0.018, abs(gnoise(q * 2.4 + 11.0)))) * 0.45;
    float c = max(crack, crack2);
    float heat = uLive[0].x * (0.75 + 0.5 * gnoise(q * 0.8 + vec2(uLive[0].y, 0.0)));
    vec3 ramp = mix(vec3(0.45, 0.04, 0.0), vec3(1.0, 0.32, 0.04), smoothstep(0.15, 0.6, heat));
    ramp = mix(ramp, vec3(1.0, 0.82, 0.45), smoothstep(0.75, 1.15, heat));
    alb = vAlb * (0.8 + 0.4 * gnoise(q * 6.0));
    alb = mix(alb, vec3(0.02, 0.012, 0.01), c);
    emit = ramp * c * heat * 2.4 + ramp * exp(-abs(n) * 26.0) * heat * 0.25;
    metal = 0.5; spec = 0.2;
    return alb;
  }
  if (code > 12.5 && code < 13.5) {
    // SCALES with light spots: vLv.y along 0..1, vLv.z across -1..1. Overlapping scales, an oily sheen, a row of
    // spots that light in a travelling wave (uLive[0]: x phase, y brightness, z spot spacing).
    vec2 q = vec2(vLv.y * 9.0, vLv.z * 4.0);
    q.x += 0.5 * mod(floor(q.y), 2.0);
    vec2 f = fract(q) - vec2(0.5, 0.2);
    float sc = smoothstep(0.55, 0.35, length(f * vec2(1.0, 1.4)));
    alb = vAlb * (0.7 + 0.45 * sc);
    sheen = 0.6; spec = 0.6; pw = 50.0; coat = 0.3;
    float sp = uLive[0].z;
    float k = floor(vLv.y * sp + 0.5);
    vec2 sd = vec2((vLv.y * sp - k) / sp * 6.0, abs(vLv.z) - 0.55);
    float spot = exp(-dot(sd, sd) * 90.0);
    float wave = 0.5 + 0.5 * sin(uLive[0].x - k * 0.9);
    emit = ch.rgb * spot * (0.25 + wave * wave * 1.6) * uLive[0].y;
    return alb;
  }
  if (code > 14.5) {
    // PETAL: vLv.y from the base 0..1, vLv.z across -1..1: a soft gradient to a paler edge, fine veins, a warm self-lit
    // throat.
    float u = vLv.y, v = vLv.z;
    alb = mix(vAlb * 0.75, mix(vAlb, vec3(1.0, 0.88, 0.82), 0.35), smoothstep(0.1, 0.9, u));
    alb *= 0.92 + 0.1 * sin(v * 26.0 + u * 3.0);
    emit = vec3(1.0, 0.7, 0.3) * (1.0 - smoothstep(0.0, 0.35, u)) * ch.a * 0.6;
    spec = 0.25; pw = 20.0; sheen = 0.45;
    return alb;
  }
  if (code > 13.5 && code < 14.5) {
    // IRON: worn, pitted.
    alb = ironAlb(vAlb, vLv.yz * vec2(2.0, 4.0) + ln.xy);
    metal = 0.5;
    return alb;
  }
  return alb;
}

// Light on the toon base, as hilts/glsl.ts hiltShade does for the knife's own hilt.
vec3 liveShade(vec3 col, vec3 alb, float lv, vec3 n, vec3 V, vec3 L, vec3 ambient, float key, float spec, float pw, float sheen, float metal, float coat) {
  vec3 H = normalize(L + V);
  float nh = max(dot(n, H), 0.0);
  float nv = max(dot(n, V), 0.0);
  float fc = pow(1.0 - nv, 5.0);
  vec3 R = reflect(-V, n);
  if (metal > 0.75) {
    if (lv < 0.5) return col + mix(vec3(1.0), alb, 0.3) * pow(nh, 60.0) * 0.8 * key;
    vec3 F = alb + (1.0 - alb) * fc;
    vec3 c = cosReflect(R, 0.06, lv) * F * 0.92 + alb * (ambient * 0.12 + key * 0.12);
    return c + mix(vec3(1.0), alb, 0.3) * (pow(nh, 220.0) * 2.2 + pow(nh, 30.0) * 0.25) * (0.3 + 0.7 * key);
  }
  if (metal > 0.25) {
    if (lv < 0.5) return col + vec3(pow(nh, 24.0) * 0.3 * key);
    vec3 F = alb + (1.0 - alb) * fc;
    vec3 c = alb * (ambient + key * vec3(0.78, 0.74, 0.68)) * 0.55 + cosReflect(R, 0.45, lv) * F * 0.55;
    return c + vec3(pow(nh, 24.0) * 0.35 * (0.3 + 0.7 * key));
  }
  float s = pow(nh, pw) * spec * (0.35 + 0.65 * key);
  vec3 c = col + vec3(s) + sheen * pow(1.0 - nv, 2.0) * (alb * 0.7 + 0.03) * (0.55 + 0.45 * key);
  if (coat > 0.0) c += cosReflect(R, 0.03, max(lv, 1.0)) * coat * (0.04 + 0.96 * fc) * 0.5;
  return c;
}

void main() {
  vec3 n = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorldPos);
  if (dot(n, V) < 0.0) n = -n;
  vec3 L = normalize(vec3(0.42, 0.78, 0.46));
  float lv = cosLevel();
  vec3 emit; float spec, pw, metal, coat, sheen;
  vec3 albedo = litAlbedo(floor(vLv.x + 0.5), vLv.yzw, emit, spec, pw, metal, coat, sheen);
  float ndl = dot(n, L);
  float key = smoothstep(-0.05, 0.55, ndl);
  vec3 sky = vec3(0.70, 0.76, 0.88), ground = vec3(0.30, 0.27, 0.26);
  vec3 ambient = mix(ground, sky, n.y * 0.5 + 0.5) * 0.62;
  vec3 col = albedo * (ambient + key * vec3(0.78, 0.74, 0.68));
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  col += rim * 0.22 * vec3(1.0);
  col = liveShade(col, albedo, lv, n, V, L, ambient, key, spec, pw, sheen, metal, coat);
  col *= vec3(1.0) + uMapLight;
  col += emit;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const GLOW_VERTEX = /* glsl */ `
attribute vec3 pb;
attribute vec2 gc;
attribute vec3 gk;
attribute vec4 gcol;
uniform mat4 uPiece[${PIECES}];
uniform vec4 uChan[${CHANNELS}];
varying vec2 vC;
varying vec3 vCol;
varying float vKind;
varying float vEnd;
#include <common>
#include <skinning_pars_vertex>
void main() {
  int c = int(gk.x + 0.5);
  vec4 ch = uChan[c];
  mat4 M = uPiece[c];
  vec4 a = vec4((M * vec4(position, 1.0)).xyz, 1.0), b = vec4((M * vec4(pb, 1.0)).xyz, 1.0);
#ifdef USE_SKINNING
  mat4 bm = getBoneMatrix(skinIndex.x);
  a = bindMatrixInverse * (bm * (bindMatrix * a));
  b = bindMatrixInverse * (bm * (bindMatrix * b));
#endif
  vec4 va = modelViewMatrix * a, vb = modelViewMatrix * b;
  float size = gcol.w;
  vec4 mv = va;
  vEnd = 0.0;
  if (gk.y < 0.5) {
    mv.xy += gc * size;
  } else {
    vec2 d = vb.xy - va.xy;
    float l = length(d);
    vec2 dir = l > 1e-5 ? d / l : vec2(1.0, 0.0);
    vec2 nr = vec2(-dir.y, dir.x);
    float f = gc.x * 0.5 + 0.5;
    mv = mix(va, vb, f);
    mv.xy += dir * gc.x * size + nr * gc.y * size;
    // Distance past either end, in sizes (the capsule's round ends).
    float s = f * (l + 2.0 * size) - size;
    vEnd = max(0.0, max(-s, s - l)) / size;
  }
  gl_Position = projectionMatrix * mv;
  vC = gc;
  vCol = gcol.rgb * ch.rgb * ch.a * gk.z;
  vKind = gk.y;
}`;

const GLOW_FRAGMENT = /* glsl */ `
varying vec2 vC;
varying vec3 vCol;
varying float vKind;
varying float vEnd;
void main() {
  float d = vKind < 0.5 ? length(vC) : length(vec2(vEnd, vC.y));
  if (d >= 1.0 || dot(vCol, vCol) < 1e-8) discard;
  // A hot core and a wide soft skirt, to zero at the quad's edge.
  float f = (exp(-d * d * 9.0) * 0.65 + exp(-d * d * 2.6) * 0.35) * (1.0 - smoothstep(0.65, 1.0, d));
  gl_FragColor = vec4(vCol * f, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

type Shared = Pick<PlayerUniforms, "uMapLight" | "uCosTier" | "uCosEnv" | "uCosEnvOn">;

/** The lit pieces' material (one per living hilt; shares the viewmodel's map light and detail uniforms). */
export function litMaterial(vm: Shared, u: LiveUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uMapLight: vm.uMapLight, uCosTier: vm.uCosTier, uCosEnv: vm.uCosEnv, uCosEnvOn: vm.uCosEnvOn, ...u },
    vertexShader: LIT_VERTEX,
    fragmentShader: LIT_FRAGMENT,
    defines: { VM_DETAIL: 1 },
    side: THREE.DoubleSide,
  });
}

/** The glow sprites' material (additive, no depth write; the hands still hide what is behind them). */
export function glowMaterial(u: LiveUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...u },
    vertexShader: GLOW_VERTEX,
    fragmentShader: GLOW_FRAGMENT,
    transparent: true,
    depthWrite: false,
    // Light added to the colour only: the canvas's alpha is left alone (the Loadout's stage draws on a clear canvas).
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    side: THREE.DoubleSide,
  });
}
