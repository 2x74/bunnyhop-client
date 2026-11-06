// Gun camo shading (camo.ts holds the designs): a procedural pattern in the gun's own space, painted over the parts a
// gun model tags for it (guns/camo-zones.ts, the Builder's gunCamo attribute). No textures, no UVs: the pattern reads the
// bind-pose position (gun-local Source units, the same frame on every gun) and, for the flat prints (stamps, checks,
// carbon, grids, facets, argyle), projects along the face's main axis, so it lands the same on every gun and the moving
// parts carry it with them.
//
// Patched into the gun material (guns/material.ts gunMaterial) only while a camo is worn: without one the program is
// exactly what it was (no define, no code), so the guns draw pixel for pixel as before. With one: one extra program per
// camo kind, and on the gun's pixels a few value-noise lookups (blobs, stripes, ribbons, veins: three to six; stamps,
// checks, carbon, grids: a handful of ALU) — Potato included, since the camo is the item. The colour it gives keeps the
// gun's own baked light: the chamfers' bright edges (gunCamo.x's fraction), the paint's shade (y) and the AO (z).
//
// Third person (other players, your chase camera) uses the bunny's own material, so the camo goes in as flat colours
// per zone there instead (camoTpGeometry): its main colours, read from far away.

import * as THREE from "three";
import { CAMO_KIND_CODE, CAMO_STAMP_CODE, type CamoStyle } from "../../camo";

const SHEEN_CODE = { coat: 0, metal: 1, gloss: 2 } as const;

const VERT_PARS = /* glsl */ `
#ifdef GUN_CAMO
attribute vec3 gunCamo;
varying vec3 vCamo;
varying vec3 vCamoP;
varying vec3 vCamoN;
#endif
`;

const VERT_MAIN = /* glsl */ `
#ifdef GUN_CAMO
  vCamo = gunCamo;
  vCamoP = position;
  vCamoN = normal;
#endif
`;

const FRAG_PARS = /* glsl */ `
#ifdef GUN_CAMO
uniform vec3 uCamoC[4];
uniform vec4 uCamoP;
uniform float uCamoScale;
varying vec3 vCamo;
varying vec3 vCamoP;
varying vec3 vCamoN;
float camoHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float camoHash2(vec2 p) { return camoHash(vec3(p, 7.31)); }
float camoNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(camoHash(i), camoHash(i + vec3(1, 0, 0)), f.x), mix(camoHash(i + vec3(0, 1, 0)), camoHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(camoHash(i + vec3(0, 0, 1)), camoHash(i + vec3(1, 0, 1)), f.x), mix(camoHash(i + vec3(0, 1, 1)), camoHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float camoFbm(vec3 p) { return 0.56 * camoNoise(p) + 0.29 * camoNoise(p * 2.03 + 11.7) + 0.15 * camoNoise(p * 4.07 + 23.1); }
// A hard edge with a pixel of antialiasing (w: the value's screen derivative).
float camoStep(float t, float v, float w) { return smoothstep(t - w, t + w, v); }
// The face's flat coordinates: the gun-local plane across its main axis (flanks: x, z; top: x, y; ends: y, z).
vec2 camoFlat(vec3 p, vec3 n) {
  vec3 a = abs(n);
  return a.y >= a.x && a.y >= a.z ? p.xz : a.z >= a.x ? p.xy : p.yz;
}
#if GUN_CAMO == 5
float camoSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
// Stamp in a cell's local frame (-0.5..0.5): 0 none, 1 the stamp, 2 its second colour; ss = antialias width.
vec2 camoStampOf(vec2 q, float h, float ss) {
#if CAMO_STAMP == 0
  // Carrot: a tapered root pointing down-right, three leaves out of its top.
  float c = cos(-0.75 + h * 0.5), s = sin(-0.75 + h * 0.5);
  q = mat2(c, s, -s, c) * q;
  float t = clamp((q.x + 0.2) / 0.46, 0.0, 1.0);
  float body = abs(q.y) - mix(0.1, 0.012, t) + max(0.0, max(-0.2 - q.x, q.x - 0.26));
  float leaf = min(min(length((q - vec2(-0.3, 0.0)) * vec2(1.0, 2.6)) - 0.1, length((q - vec2(-0.28, 0.08)) * vec2(1.4, 2.4)) - 0.09), length((q - vec2(-0.28, -0.08)) * vec2(1.4, 2.4)) - 0.09);
  float bodyM = 1.0 - smoothstep(-ss, ss, body);
  float leafM = (1.0 - smoothstep(-ss, ss, leaf)) * (1.0 - bodyM);
  return vec2(bodyM, leafM);
#elif CAMO_STAMP == 1
  // Paw print: a pad and four toes, turned a little.
  float c = cos(h * 1.2 - 0.6), s = sin(h * 1.2 - 0.6);
  q = mat2(c, s, -s, c) * q;
  float pad = length((q - vec2(0.0, -0.07)) * vec2(1.0, 1.2)) - 0.14;
  float toes = min(min(length(q - vec2(-0.16, 0.08)), length(q - vec2(-0.055, 0.165))), min(length(q - vec2(0.055, 0.165)), length(q - vec2(0.16, 0.08)))) - 0.058;
  float m = 1.0 - smoothstep(-ss, ss, min(pad, toes));
  return h > 0.5 ? vec2(m, 0.0) : vec2(0.0, m);
#elif CAMO_STAMP == 2
  // Daisy: six petals round a yellow middle.
  float a = atan(q.y, q.x) + h * 3.0;
  float r = length(q);
  float petals = r - 0.2 * (0.72 + 0.28 * abs(cos(a * 3.0)));
  float mid = r - 0.065;
  float midM = 1.0 - smoothstep(-ss, ss, mid);
  float pet = (1.0 - smoothstep(-ss, ss, petals)) * (1.0 - midM);
  return vec2(pet, midM);
#else
  // Sprinkle: a short rounded bar at any angle.
  float an = h * 6.2831;
  vec2 d = vec2(cos(an), sin(an)) * 0.11;
  float m = 1.0 - smoothstep(-ss, ss, camoSeg(q, -d, d) - 0.045);
  return vec2(m, 0.0);
#endif
}
#endif
#if GUN_CAMO == 11
// Voronoi on the flat coordinates: (nearest distance, second nearest, the nearest cell's hash).
vec3 camoCells(vec2 uv) {
  vec2 i = floor(uv), f = fract(uv);
  float d1 = 9.0, d2 = 9.0, id = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      float h = camoHash2(i + g);
      vec2 o = g + vec2(h, camoHash2(i + g + 19.7)) * 0.8 + 0.1 - f;
      float d = dot(o, o);
      if (d < d1) { d2 = d1; d1 = d; id = h; } else if (d < d2) d2 = d;
    }
  return vec3(sqrt(d1), sqrt(d2), id);
}
#endif
// The camo's colour here (linear), before the gun's baked light.
vec3 gunCamoColor() {
  vec3 P = vCamoP / uCamoScale;
  vec3 c0 = uCamoC[0], c1 = uCamoC[1], c2 = uCamoC[2], c3 = uCamoC[3];
#if GUN_CAMO == 0
  // Solid: upper, lower, magazine.
  float z = floor(vCamo.x + 0.5);
  return z < 1.5 ? c0 : z < 2.5 ? c1 : c2;
#elif GUN_CAMO == 1 || GUN_CAMO == 2
  // Blobs (woodland, desert) and digital (square pixels of uCamoP.w units): three layers of noise over the base.
#if GUN_CAMO == 2
  vec3 q = (floor(vCamoP / uCamoP.w) + 0.5) * uCamoP.w / uCamoScale;
#else
  vec3 q = P;
#endif
  q.x *= 0.72;
  float n1 = camoFbm(q), n2 = camoFbm(q * 1.55 + 31.0), n3 = camoFbm(q * 2.4 + 57.0);
#if GUN_CAMO == 2
  float w1 = 0.0, w2 = 0.0, w3 = 0.0;
#else
  float w1 = fwidth(n1), w2 = fwidth(n2), w3 = fwidth(n3);
#endif
  vec3 c = mix(c0, c1, camoStep(uCamoP.x, n1, w1));
  c = mix(c, c2, camoStep(uCamoP.y, n2, w2));
  return mix(c, c3, camoStep(uCamoP.z, n3, w3));
#elif GUN_CAMO == 3
  // Stripes: bands across the gun (or lines along it), warped and of uneven width; a thin second colour in between.
  float warp = (camoFbm(P * 0.6) - 0.5) * uCamoP.x;
  float s = mix(P.x + P.z * uCamoP.y, P.z, uCamoP.w) + warp;
  float t = abs(fract(s) - 0.5);
  float wd = uCamoP.z * (uCamoP.x > 0.0 ? 0.55 + 0.9 * camoNoise(P * 1.7 + 5.0) : 1.0);
  float aw = fwidth(s);
  float st = 1.0 - camoStep(wd, t, aw);
  float t2 = abs(fract(s + 0.5) - 0.5);
  float st2 = (1.0 - camoStep(wd * 0.35, t2, aw)) * (1.0 - st);
  return mix(mix(c0, c2, st2), c1, st);
#elif GUN_CAMO == 4
  // Paint splat: two layers of round splats with ragged rims, a colour each.
  vec3 c = c0;
  for (int l = 0; l < 2; l++) {
    vec3 q = l == 0 ? P : P * 1.9 + 13.1;
    vec3 i = floor(q);
    float h = camoHash(i);
    vec3 ctr = i + 0.37 + 0.26 * vec3(camoHash(i + 3.1), camoHash(i + 7.7), camoHash(i + 1.9));
    float r = (0.22 + 0.08 * camoHash(i + 5.3)) * (1.0 + 0.3 * (camoNoise(q * 6.0) - 0.5));
    float d = length(q - ctr) - r;
    float m = (1.0 - smoothstep(-fwidth(d), fwidth(d), d)) * step(0.28, camoHash(i + 9.9));
    vec3 pc = h < 0.34 ? c1 : h < 0.67 ? c2 : c3;
    c = mix(c, pc, m);
  }
  return c;
#elif GUN_CAMO == 5
  // Stamps: carrots, paw prints, daisies, sprinkles on the faces, in offset rows; uCamoP.x how many cells hold one.
  vec2 uv = camoFlat(vCamoP, vCamoN) / uCamoScale;
  uv.x += 0.5 * mod(floor(uv.y), 2.0);
  vec2 cell = floor(uv);
  float h = camoHash2(cell);
  vec2 q = fract(uv) - 0.5 - (vec2(camoHash2(cell + 4.0), camoHash2(cell + 9.0)) - 0.5) * 0.18;
  float ss = max(fwidth(uv.x), fwidth(uv.y)) * 0.8;
  vec2 m = camoStampOf(q, h, ss) * step(1.0 - uCamoP.x, camoHash2(cell + 2.5));
#if CAMO_STAMP == 3
  // Sprinkles: a second one in each cell, the colours mixed.
  vec2 q2 = fract(uv + 0.5) - 0.5;
  float h2 = camoHash2(cell + 31.0);
  float m2 = camoStampOf(q2, h2, ss).x;
  vec3 k1 = h < 0.33 ? c1 : h < 0.66 ? c2 : c3, k2 = h2 < 0.33 ? c2 : h2 < 0.66 ? c3 : c1;
  return mix(mix(c0, k2, m2), k1, m.x);
#else
  // A little texture in the ground (soil, grass, felt): the accent colour in soft patches.
  vec3 ground = mix(c0, c3, smoothstep(0.45, 0.75, camoFbm(P * 2.2)) * uCamoP.y);
  return mix(mix(ground, c1, m.x), c2, m.y);
#endif
#elif GUN_CAMO == 6
  // Veins: marble (uCamoP.w 0: thin veins along a warped wave, a soft halo) or caustic light (1: ridges of noise).
  float v, aw;
  if (uCamoP.w > 0.5) {
    float n = camoFbm(P * 0.9 + vec3(0.0, 0.0, P.x * 0.15));
    v = abs(n - 0.5) * 2.0 / uCamoP.y;
  } else {
    float s = (P.x * 0.35 + P.z * 0.8 + camoFbm(P * 0.8) * uCamoP.x) * uCamoP.y;
    v = abs(sin(s * 3.14159));
  }
  aw = fwidth(v);
  float vein = 1.0 - smoothstep(uCamoP.z - aw, uCamoP.z + aw, v);
  float halo = 1.0 - smoothstep(0.0, uCamoP.z * 5.0, v);
  vec3 base = c0 * (0.9 + 0.2 * camoNoise(P * 3.0));
  return mix(mix(base, c2, halo * 0.55), c1, vein);
#elif GUN_CAMO == 7
  // Carbon weave: a diagonal twill of two tows, each with a sheen across its width; fades to the average far away.
  vec2 uv = camoFlat(vCamoP, vCamoN) / uCamoScale;
  uv = vec2(uv.x + uv.y, uv.x - uv.y) * 0.7071;
  vec2 f = fract(uv);
  float par = mod(floor(uv.x) + floor(uv.y), 2.0);
  float across = par > 0.5 ? f.y : f.x;
  float g = sin(across * 3.14159);
  vec3 tow = mix(c0, c1, par > 0.5 ? 0.25 + 0.5 * g : 0.55 + 0.45 * g);
  tow = mix(tow, c2, pow(g, 6.0) * 0.35);
  float far = smoothstep(0.25, 0.6, max(fwidth(uv.x), fwidth(uv.y)));
  return mix(tow, mix(c0, c1, 0.5), far);
#elif GUN_CAMO == 8
  // Checks: gingham (light, mid where one band crosses, dark where both do) or a checkerboard (uCamoP.x 1).
  vec2 uv = camoFlat(vCamoP, vCamoN) / uCamoScale;
  vec2 aw = fwidth(uv);
  vec2 b = vec2(camoStep(0.5, fract(uv.x), aw.x) * (1.0 - camoStep(0.98, fract(uv.x), aw.x)), camoStep(0.5, fract(uv.y), aw.y) * (1.0 - camoStep(0.98, fract(uv.y), aw.y)));
  if (uCamoP.x > 0.5) return mix(c0, c2, abs(b.x - b.y));
  return b.x * b.y > 0.5 ? c2 : mix(c0, c1, max(b.x, b.y));
#elif GUN_CAMO == 9
  // Grid: minor lines, a major line every uCamoP.x, a few filled squares.
  vec2 uv = camoFlat(vCamoP, vCamoN) / uCamoScale;
  vec2 aw = fwidth(uv);
  vec2 d = abs(fract(uv + 0.5) - 0.5);
  float minor = 1.0 - min(camoStep(uCamoP.w, d.x, aw.x), camoStep(uCamoP.w, d.y, aw.y));
  vec2 um = uv / uCamoP.x;
  vec2 dm = abs(fract(um + 0.5) - 0.5) * uCamoP.x;
  float major = 1.0 - min(camoStep(uCamoP.w * 1.8, dm.x, aw.x), camoStep(uCamoP.w * 1.8, dm.y, aw.y));
  float sq = step(1.0 - uCamoP.z, camoHash2(floor(uv)));
  vec3 c = mix(c0, c3, sq * 0.85);
  c = mix(c, c1, minor * uCamoP.y);
  return mix(c, c2, major);
#elif GUN_CAMO == 10
  // Ribbons: two soft bands of light flowing along the gun over the base, and a few sparkles.
  float y = P.z + (camoFbm(P * 0.55 + vec3(P.x * 0.08)) - 0.5) * uCamoP.x;
  float b1 = exp(-pow((fract(y * uCamoP.y) - 0.5) / uCamoP.z, 2.0));
  float b2 = exp(-pow((fract(y * uCamoP.y * 1.37 + 0.31) - 0.5) / (uCamoP.z * 0.8), 2.0));
  vec3 c = c0 + c1 * b1 * 0.85 + c2 * b2 * 0.7;
  vec3 g = floor(vCamoP * 2.5);
  float sp = step(1.0 - uCamoP.w, camoHash(g)) * (1.0 - smoothstep(0.08, 0.2, length(fract(vCamoP * 2.5) - 0.5)));
  return mix(c, c3, sp);
#elif GUN_CAMO == 11
  // Facets: crystal faces in three tones, a bright line where two meet.
  vec3 v = camoCells(camoFlat(vCamoP, vCamoN) / uCamoScale);
  vec3 c = v.z < 0.45 ? mix(c0, c1, v.z / 0.45) : v.z < 0.8 ? mix(c1, c2, (v.z - 0.45) / 0.35) : c2;
  c *= 0.85 + 0.3 * v.x;
  float e = v.y - v.x;
  float aw = fwidth(e);
  return mix(c, c3, 1.0 - smoothstep(0.04 - aw, 0.04 + aw, e));
#else
  // Argyle: diamonds in two colours, thin crossing lines through their middles.
  vec2 uv = camoFlat(vCamoP, vCamoN) / uCamoScale;
  vec2 d = vec2(uv.x * 0.6 + uv.y, uv.x * 0.6 - uv.y);
  float par = mod(floor(d.x) + floor(d.y), 2.0);
  vec3 c = par > 0.5 ? c1 : c0;
  vec2 l = abs(fract(d) - 0.5);
  float aw = max(fwidth(d.x), fwidth(d.y));
  float line = 1.0 - min(camoStep(0.03, l.x, aw), camoStep(0.03, l.y, aw));
  return mix(c, c2, line);
#endif
}
// The coated colour with the gun's baked light kept: the paint's shade, the chamfer, the AO.
vec3 gunCamoAlbedo() {
  vec3 c = gunCamoColor() * vCamo.y;
  float edge = clamp(vCamo.x - floor(vCamo.x + 0.5), 0.0, 0.5);
  c = c + (1.0 - c) * edge * 0.35 + c * edge * 0.25;
  return c * vCamo.z;
}
#endif
`;

/** Inserts `add` after (or before) the first `anchor` in `src`; null when the anchor isn't there. */
function insert(src: string, anchor: string, add: string, before = false): string | null {
  const i = src.indexOf(anchor);
  if (i < 0) return null;
  const at = before ? i : i + anchor.length;
  return src.slice(0, at) + add + src.slice(at);
}

/** The camo uniforms (added to the viewmodel's uniforms object once; values per camo). */
export function camoUniforms(u: Record<string, THREE.IUniform>, style: CamoStyle): void {
  u.uCamoC ??= { value: [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()] };
  u.uCamoP ??= { value: new THREE.Vector4() };
  u.uCamoScale ??= { value: 1 };
  (u.uCamoC.value as THREE.Color[]).forEach((c, i) => c.setHex(style.colors[i] ?? 0));
  const p = style.p ?? [0, 0, 0, 0];
  (u.uCamoP.value as THREE.Vector4).set(p[0], p[1], p[2], p[3]);
  u.uCamoScale.value = style.scale;
}

let warned = false;

/**
 * Patches a gun material (guns/material.ts, before its own gun shading is added: the anchors are the solid material's)
 * with `style`'s camo: the camo albedo on tagged vertices. Returns false (material untouched) if the anchors moved.
 */
export function patchCamo(m: THREE.ShaderMaterial, style: CamoStyle): boolean {
  let vs: string | null = m.vertexShader;
  vs = insert(vs, "#include <common>", VERT_PARS, true);
  vs = vs && insert(vs, "vNormalW = normalize(mat3(modelMatrix) * objectNormal);", VERT_MAIN);
  let fs: string | null = m.fragmentShader;
  fs = insert(fs, "void main() {", FRAG_PARS, true);
  fs = fs && insert(fs, "  vec3 albedo = vColor;", "\n  vec3 camoAlb = gunCamoAlbedo();\n  if (vCamo.x > 0.5) albedo = camoAlb;");
  if (!vs || !fs) {
    if (!warned) console.warn("gun camo: shader anchors not found, no camo");
    warned = true;
    return false;
  }
  m.vertexShader = vs;
  m.fragmentShader = fs;
  m.defines = { ...m.defines, GUN_CAMO: CAMO_KIND_CODE[style.kind], CAMO_STAMP: CAMO_STAMP_CODE[style.stamp ?? "carrot"], CAMO_SHEEN: SHEEN_CODE[style.sheen] };
  (m.defaultAttributeValues as Record<string, number[]>).gunCamo = [0, 1, 1];
  return true;
}

// ---------------------------------------------------------------------------------------------
// Third person: flat colours per zone in a copy of the bunny's gun geometry.

/** The colour a zone shows from afar (sRGB): solids their zone's, patterns a mix weighted toward the base. */
export function camoZoneColor(style: CamoStyle, zone: number): number {
  const c = style.colors;
  if (style.kind === "solid") return c[Math.min(2, Math.max(0, zone - 1))];
  const mix = (a: number, b: number, t: number) => {
    let out = 0;
    for (const sh of [16, 8, 0]) out |= Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t) << sh;
    return out;
  };
  // Patterns: the base, a little of the first pattern colour on the lower parts so the two read apart.
  return zone === 2 ? mix(c[0], c[1], 0.35) : c[0];
}

const tpCache = new WeakMap<THREE.BufferGeometry, Map<string, THREE.BufferGeometry>>();

/**
 * `g` (a third-person gun from guns/meshes.ts, which carries gunCamo) with its tagged vertices recoloured in `id`'s
 * camo (flat per zone, keeping each vertex's shade, chamfer and the colour's light); `g` itself when there's nothing to
 * paint. Cached per geometry and camo.
 */
export function camoTpGeometry(g: THREE.BufferGeometry, id: string | null | undefined, style: CamoStyle | null): THREE.BufferGeometry {
  const Z = g.getAttribute("gunCamo");
  if (!id || !style || !Z) return g;
  let byId = tpCache.get(g);
  if (!byId) tpCache.set(g, (byId = new Map()));
  let out = byId.get(id);
  if (out) return out;
  out = g.clone();
  const C = out.getAttribute("partColor") as THREE.BufferAttribute;
  const col = new THREE.Color();
  for (let i = 0; i < Z.count; i++) {
    const x = Z.getX(i);
    const zone = Math.floor(x + 0.5);
    if (zone < 1) continue;
    const edge = Math.min(0.5, Math.max(0, x - zone));
    col.setHex(camoZoneColor(style, zone));
    const sh = Z.getY(i) * Z.getZ(i);
    const ch = (v: number) => Math.min(1, (v + (1 - v) * edge * 0.35 + v * edge * 0.25) * sh);
    C.setXYZ(i, ch(col.r), ch(col.g), ch(col.b));
  }
  C.needsUpdate = true;
  byId.set(id, out);
  return out;
}
