// Garment materials for the player solid material (player/materials.ts): the bunny's hoodie fleece, rib-knit cuffs and
// hems, jersey joggers, sneaker leather and rubber, the visor's glass, the face's soft dark cloth, drawstring cord and
// aglets, the printed logo, Bun-E's glossy shell. No textures, no extra draw calls, no program variants: every surface
// says what it is through its `finishUV` (builder.ts), which garments fill per grid point (surface()'s `fin`):
//   x  units along the part from its seam (0 = where a rib cuff / hem is sewn on; < 0 the fleece, > 0 the rib), or a
//      distance to an edge (a patch), or a part-specific coordinate (the visor: across the band 0..1)
//   y  stitch units round the part (STITCH long each, counting on round the ring: an even whole number per turn, so rib
//      lines and dashes meet up), 0 at its long seam
//   z  8 + GARMENT id (below 8: knives and gloves, viewmodel/finishes/shader.ts; they ignore these)
//   w  baked occlusion 0..1 (creases, under the hood rim, the inside of a cuff, where a sleeve meets the glove)
// Coordinates far from 0 (NO_SEAM) mean "no seam here".
//
// How much is drawn depends on the graphics look (look-tier.ts uPlayerLook): Potato / Plain only the occlusion and the
// cheap highlights; Source the stitching, ribs, sheen and heathering; Enhanced / Cinematic finer grain and the real
// scene in the visor. Detail fades out by screen size (units per pixel) before it can shimmer, so a bunny across the
// map shades like a plain one.

import type { Fin } from "./bunny/builder";

export const GARMENT = {
  /** Hoodie sleeves, hood, ears: fleece with a long seam at y = 0 and a hem seam at x = 0. */
  fleece: 0,
  /** Hoodie body: fleece with a hem seam (no long seam). */
  body: 1,
  /** Rib knit (cuffs, hem, waistband, pants cuffs): ribs along y, a cover stitch just past x = 0. */
  rib: 2,
  /** Joggers: jersey, long seam + hem seam like fleece, a finer and flatter knit. */
  jersey: 3,
  /** Sneaker upper: smooth leather, a stitch line along the sole (from the bind position). */
  upper: 4,
  /** Sneaker sole: rubber with sidewall grooves (from the bind position). */
  rubber: 5,
  /** Visor: glass over the glow. x across the band 0 (lower lip) .. 1 (upper lip). */
  visor: 6,
  /** Face: soft dark cloth. */
  face: 7,
  /** Drawstrings, laces: twisted cord (x along, y round). */
  cord: 8,
  /** Aglets, the zip: glossy hard plastic. */
  aglet: 9,
  /** The hop-arc logo, the nose: printed / moulded, a soft gloss. */
  print: 10,
  /** Pocket patch: fleece, x = distance to the patch's edge, y = units along that edge (stitched 0.22 in). */
  patch: 11,
  /** Bun-E's shell plates: glossy hard plastic. */
  plate: 12,
} as const;

/** Length of one stitch unit (a dash + gap, one rib), in Source units. */
export const STITCH = 0.32;
/** A coordinate value that means "no seam near here". */
export const NO_SEAM = 999;

/** Stitch units round a ring of circumference c: an even whole number. */
export const around = (c: number): number => Math.max(2, 2 * Math.round(c / (2 * STITCH)));

/** finishUV for a garment point. */
export const gfin = (mat: number, x: number, y: number, ao = 0): Fin => [x, y, 8 + mat, ao];

/** A garment point with no seams. */
export const gplain = (mat: number, ao = 0): Fin => [NO_SEAM, NO_SEAM, 8 + mat, ao];

/** Vertex: declarations. finishUV is the finishes' attribute; declared here when no finish / glove look did. */
export const FABRIC_VERTEX_PARS = /* glsl */ `
#if !defined(FINISH) && !defined(GLOVE)
attribute vec4 finishUV;
#endif
varying vec4 vGarm;`;

export const FABRIC_VERTEX_MAIN = /* glsl */ `
  vGarm = finishUV;`;

/** Fragment: declarations + the garment recipes (needs vFabricPos, uFabric, vWorldPos declared before it). */
export const FABRIC_FRAGMENT_PARS = /* glsl */ `
uniform float uPlayerLook;
uniform samplerCube uPlayerEnv;
uniform float uPlayerEnvOn;
varying vec4 vGarm;
const float G_STITCH = ${STITCH.toFixed(2)};
struct Garment { vec3 n; vec3 alb; float aoA; float aoK; float sheen; float spec; float pw; float env; float glow; };
float gHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float gNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(gHash(i), gHash(i + vec3(1, 0, 0)), f.x), mix(gHash(i + vec3(0, 1, 0)), gHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(gHash(i + vec3(0, 0, 1)), gHash(i + vec3(1, 0, 1)), f.x), mix(gHash(i + vec3(0, 1, 1)), gHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// Bump from a height's screen derivatives (dhx, dhy) on the surface with position derivatives dpx, dpy (Mikkelsen).
vec3 gBump(vec3 n, vec3 dpx, vec3 dpy, float dhx, float dhy) {
  vec3 r1 = cross(dpy, n), r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * n - grad);
}
// A row of stitches: d across the line (units), a along it (stitch units). Dashes with gaps, a soft thread edge.
float gStitch(float d, float a) {
  float line = 1.0 - smoothstep(0.024, 0.05, abs(d));
  float f = fract(a);
  return line * smoothstep(0.08, 0.18, f) * (1.0 - smoothstep(0.6, 0.7, f));
}
// A seam's groove: darker right at the join.
float gGroove(float d) { return 1.0 - smoothstep(0.015, 0.07, abs(d)); }
// Sky over ground for the glossy bits when there's no scene capture: a cool sky, a bright horizon, dark ground, a soft
// light where the key comes from.
vec3 gSky(vec3 R) {
  vec3 top = vec3(0.50, 0.60, 0.80), hor = vec3(1.0, 0.98, 0.92), gnd = vec3(0.10, 0.095, 0.09);
  vec3 c = R.y > 0.0 ? mix(hor, top, smoothstep(0.0, 0.45, R.y)) : mix(hor * 0.35, gnd, smoothstep(0.0, -0.12, R.y));
  return c + vec3(0.9) * smoothstep(0.93, 0.99, dot(R, normalize(vec3(0.42, 0.78, 0.46))));
}

Garment garmentOf(vec3 n, vec3 alb, vec3 dpx, vec3 dpy, vec2 gx, vec2 gy) {
  Garment g = Garment(n, alb, 1.0, 1.0, 0.0, 0.0, 8.0, 0.0, 0.0);
  float m = vGarm.z - 8.0;
  if (m < -0.5 || uPlayerLook < -0.5) return g;
  float ao = clamp(vGarm.w, 0.0, 1.0);
  g.aoA = 1.0 - 0.6 * ao;
  g.aoK = 1.0 - 0.32 * ao;
  float x = vGarm.x, y = vGarm.y;
  vec3 P = vFabricPos;
  // Potato / Plain: occlusion and the cheap highlights only.
  if (uPlayerLook < 0.5) {
    if (m > 3.5 && m < 4.5) { g.spec = 0.16; g.pw = 20.0; }
    else if (m > 5.5 && m < 6.5) { g.spec = 0.7; g.pw = 70.0; }
    else if (m > 8.5 && m < 9.5 || m > 11.5) { g.spec = 0.4; g.pw = 50.0; }
    return g;
  }
  bool rich = uPlayerLook > 1.5;
  // Units per pixel: detail finer than a couple of pixels fades out (no shimmer on far bunnies).
  float upp = max(length(dpx), length(dpy));
  float near = 1.0 - smoothstep(0.04, 0.085, upp);
  float mid = 1.0 - smoothstep(0.07, 0.13, upp);
  if (mid <= 0.0) {
    // Far (a bunny across the map): no surface detail left to draw, only how each material takes the light.
    if (m < 1.5 || m > 10.5 && m < 11.5) g.sheen = uFabric > 0.5 ? 0.3 : 0.15;
    else if (m < 3.5) g.sheen = 0.12;
    else if (m < 4.5) { g.spec = 0.22; g.pw = 26.0; }
    else if (m < 5.5) { g.spec = 0.13; g.pw = 14.0; }
    else if (m < 6.5) { g.glow = 0.3 * sin(3.14159 * clamp((x - 0.333) * 3.0, 0.0, 1.0)); g.spec = 0.9; g.pw = 80.0; g.env = 0.55; }
    else if (m < 7.5) g.sheen = 0.16;
    else if (m < 8.5) g.sheen = 0.14;
    else if (m < 9.5 || m > 11.5) { g.spec = 0.45; g.pw = 56.0; g.env = 0.14; }
    else g.spec = 0.16;
    return g;
  }
  // Tonal thread, a touch lighter than the cloth. On dark cloth that lift is most of the contrast, so the stitches are
  // drawn ~40% softer there (a seam, not a dotted line); light colourways keep them at full strength.
  float lum = dot(alb, vec3(0.2126, 0.7152, 0.0722));
  vec3 thread = mix(alb, alb * 1.16 + 0.035, mix(0.6, 1.0, smoothstep(0.08, 0.35, lum)));
  if (m < 1.5 || m > 10.5 && m < 11.5 || m > 2.5 && m < 3.5) {
    // Fleece / jersey / the pocket patch: heathered (two fibre tones), soft sheen, seams.
    bool jersey = m > 2.5 && m < 3.5;
    if (mid > 0.0) {
      float h = gNoise(P * (jersey ? 2.6 : 1.7));
      if (rich) h = h * 0.6 + gNoise(P * 6.3) * 0.4;
      alb *= 1.0 + 0.045 * (h - 0.5) * mid;
      // Enhanced, up close: the brushed fibres (a fine speckle only a sleeve in front of the camera shows).
      if (rich && near > 0.0) alb *= 1.0 + 0.035 * (gNoise(P * 21.0) - 0.5) * near;
    }
    g.sheen = (jersey ? 0.1 : uFabric > 0.5 ? 0.3 : 0.15) * (rich ? 1.25 : 1.0);
    float groove = 0.0, st = 0.0;
    if (m > 10.5) {
      // Patch: a fold at its edge, a stitch line just inside.
      groove = gGroove(x * 0.6);
      st = gStitch(x - 0.22, y / G_STITCH);
    } else {
      // Hem seam (x = 0) with a row of stitches on the fleece side.
      groove = gGroove(x);
      st = gStitch(x + 0.16, y);
      if (m < 0.5 || jersey) {
        // Long seam (y = 0, counting one way round): a fold, stitches pressed to one side.
        float d = y * G_STITCH;
        groove = max(groove, gGroove(d));
        st = max(st, gStitch(d - 0.17, x / G_STITCH));
      }
    }
    alb *= 1.0 - 0.2 * groove * mid;
    alb = mix(alb, thread, st * near * 0.85);
  } else if (m < 2.5) {
    // Rib knit: raised ribs (1.5 per stitch unit, ~0.21 apart; y's turn count is even, so they meet up) with soft
    // valleys between them, a cover stitch near the seam.
    float ry = y * 1.5;
    float fy = 1.5 * max(abs(gx.y), abs(gy.y));
    float amp = (1.0 - smoothstep(0.2, 0.45, fy)) * mid;
    float c = cos(6.2831853 * ry), s = sin(6.2831853 * ry);
    alb *= 1.0 - 0.06 * amp * (0.5 - 0.5 * c);
    // Enhanced, up close: the knit's courses across the ribs.
    if (rich) alb *= 1.0 - 0.035 * (0.5 + 0.5 * cos(6.2831853 * x / 0.075)) * (1.0 - smoothstep(0.012, 0.03, upp));
    float A = 0.011 * amp * 6.2831853 * 1.5;
    g.n = gBump(n, dpx, dpy, -A * s * gx.y, -A * s * gy.y);
    alb = mix(alb, thread, gStitch(x - 0.15, y) * near * 0.75);
    g.sheen = 0.14;
  } else if (m < 4.5) {
    // Sneaker upper: smooth leather with a soft highlight; stitched round just above the sole and across the toe cap
    // (bind space: the shoes point down -y, the sole's top at z 1.24).
    if (rich && mid > 0.0) alb *= 1.0 + 0.05 * (gNoise(P * 9.0) - 0.5) * mid;
    g.spec = 0.22; g.pw = 26.0; g.sheen = 0.05;
    float a = (P.y - abs(P.x)) / G_STITCH;
    float st = gStitch((P.z - 1.62) * 0.7, a);
    st = max(st, gStitch((P.y + 5.3 + 0.18 * (P.z - 3.5)) * 0.7, abs(P.x) / G_STITCH) * step(2.2, P.z));
    alb *= 1.0 - 0.18 * gGroove((P.y + 5.15 + 0.18 * (P.z - 3.5)) * 0.8) * step(2.2, P.z) * mid;
    alb = mix(alb, thread * 0.94, st * near * 0.8);
  } else if (m < 5.5) {
    // Rubber sole: two sidewall grooves, a darker tread edge, a dull sheen.
    float gr = max(gGroove((P.z - 0.42) * 0.6), gGroove((P.z - 0.82) * 0.6)) * mid;
    alb *= (1.0 - 0.3 * gr) * mix(0.7, 1.0, smoothstep(0.06, 0.3, P.z));
    g.spec = 0.13; g.pw = 14.0;
  } else if (m < 6.5) {
    // Visor: glass over the glow. The band (x 1/3 .. 2/3; the lips either side) brighter through its middle, the lips
    // darker; a sun glint, and the sky (or the scene) reflected in it, its horizon running across the band.
    float tb = clamp((x - 0.333) * 3.0, 0.0, 1.0);
    g.glow = 0.3 * sin(3.14159 * tb);
    alb *= x < 0.333 || x > 0.667 ? 0.78 : 0.9;
    g.spec = 0.9; g.pw = 80.0; g.env = 0.55;
  } else if (m < 7.5) {
    // Face: soft dark cloth, a faint velvet edge; a soft gradient, lifting toward the chin (x: -1 chin .. 1 brow).
    if (x < 2.0) alb *= mix(1.6, 0.85, smoothstep(-1.0, 0.6, x));
    g.sheen = 0.16; g.spec = 0.04; g.pw = 6.0;
  } else if (m < 8.5) {
    // Cord: twisted strands.
    float fy = max(abs(gx.y), abs(gy.y));
    float tw = cos(6.2831853 * (y + x / 0.42));
    alb *= 1.0 - 0.12 * (0.5 - 0.5 * tw) * (1.0 - smoothstep(0.25, 0.5, fy));
    g.sheen = 0.14;
  } else if (m < 9.5 || m > 11.5) {
    // Aglets / Bun-E's shell: glossy plastic.
    g.spec = 0.45; g.pw = 56.0; g.env = 0.14;
  } else {
    // Print: a soft gloss.
    g.spec = 0.16; g.pw = 22.0; g.sheen = 0.04;
  }
  g.alb = alb;
  return g;
}

// The garment's own light on top of the material's diffuse: fabric sheen at grazing angles, highlights, reflections,
// the visor's inner glow.
vec3 garmentLight(Garment g, vec3 n, vec3 V, vec3 L, float key, vec3 ambient) {
  vec3 lc = vec3(0.78, 0.74, 0.68);
  vec3 c = vec3(0.0);
  float nv = max(dot(n, V), 0.0);
  if (g.sheen > 0.0) c += g.sheen * pow(1.0 - nv, 4.0) * (0.35 + 0.65 * key) * mix(g.alb, vec3(1.0), 0.35) * (ambient + lc) * g.aoA;
  if (g.spec > 0.0) {
    // A sharp highlight and a broad soft one under it (glossy things read as glossy from more angles).
    float nh = max(dot(n, normalize(L + V)), 0.0);
    c += g.spec * (pow(nh, g.pw) + 0.12 * pow(nh, g.pw * 0.15)) * lc * key * g.aoK;
  }
  if (g.env > 0.0) {
    vec3 R = reflect(-V, n);
    vec3 e = uPlayerEnvOn > 0.5 ? textureLod(uPlayerEnv, R, 2.0).rgb : gSky(R);
    c += g.env * e * (0.1 + 0.9 * pow(1.0 - nv, 5.0)) * g.aoA;
  }
  return c + g.alb * g.glow;
}`;
