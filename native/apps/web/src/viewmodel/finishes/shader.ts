// Production blade finishes and glove styles, folded into the player solid material (player/materials.ts) behind
// `#define FINISH n` / `#define GLOVE`: one program variant per equipped finish (compiled when you equip it, ~10 ms),
// still one material and one draw call for the viewmodel and for each third-person bunny, no textures.
//
// Inputs: the `finishUV` vertex attribute every knife writes through the Builder (player/bunny/builder.ts; layout in
// viewmodel/knives/types.ts): x along the blade 0 (guard) .. 1 (tip), y across it -1..1, z part id (PART: 1 blade,
// 4 glove), w edge weight (glove wear). Meshes built before the knife registry get the same attribute from layout.ts.
// Glove styles (`#define GLOVE`, viewmodel/gloves/glsl.ts) read their colour slot + material from the accent code and
// seam distance / wear from finishUV. Pattern space is the carrot blade's side projection (Knife_Handle z, y), so a
// finish looks the same on every knife and in first and third person.
//
// Each finish is ONE fixed design (owner call, v0.0.6): its placement, scale and colours are constants in its recipe
// below, the same for every player. No per-player seed, no wear. The lineup (progression.ts): Sunset (sky gradient
// with cloud streaks), Ember Glaze (kiln heat field + crackle), Tiger Lily (petal orange, dark freckles), Nebula
// (gas clouds + twinkling stars), Dewdrop Web (silver web and dew on dawn blue), Frost (ice + frost ferns), Heartbeet
// (beetroot rings), Four-Leaf (emerald with scattered clovers, a few gold), Founder's Gold (the owner's: molten gold
// with a sweeping shimmer), and the Supporter's three, all animated: Geode (a split geode: stone rim, agate bands,
// crystal facets that a shine crosses), Rift (angular cracks of light in a dark plum blade, a pulse running up them)
// and Spectrum (a halftone hex grid with broad colour bands drifting through it); High Roller's Gold Leaf (torn gold
// leaf on black lacquer, a crossing sheen) and Borealis's Aurora (rippling curtains of light over faint stars). Wide blades (the Clover Cleaver)
// stretch every pattern across, since pattern space is the carrot's. Self-lit parts
// come back in `emit` and skip the lighting. Potato mode holds the clock still (setCosmeticsStill). A future
// player tint (loadout.ts CosmeticLoadout.tint) would arrive as one more uniform set in setFinishUniforms and read by
// the recipes that opt in; nothing reads it yet.

import * as THREE from "three";
import type { PlayerUniforms } from "../../player/materials";
import { finishStyle, gloveStyle, type CosmeticLoadout, type FinishKind, type GloveStyle } from "../../loadout";
import { NOISE_GLSL } from "./glsl";
import { GLOVE_FRAGMENT_PARS, GLOVE_VERTEX_MAIN, GLOVE_VERTEX_PARS } from "../gloves/glsl";
export { GLOVE_FRAGMENT_ALBEDO, GLOVE_FRAGMENT_LIGHT } from "../gloves/glsl";

/** `#define FINISH n` per design (0 = no finish code at all). */
export const FINISH_CODE: Record<FinishKind, number> = { none: 0, sunset: 1, ember: 2, tigerlily: 3, nebula: 4, dewweb: 5, frost: 6, heartbeet: 7, fourleaf: 8, founder: 9, geode: 10, rift: 11, spectrum: 12, goldleaf: 13, aurora: 14 };

/** One finished item, as the shader sees it: which design. */
export interface FinishSpec {
  kind: FinishKind;
}

export function specOf(l: Pick<CosmeticLoadout, "finish">): FinishSpec {
  return { kind: finishStyle(l.finish).kind };
}

/** Program variant of a look: the FINISH code, whether glove zones are recoloured, the low-detail noise. */
export interface MaterialLook {
  finish: number;
  glove: boolean;
}

export const NO_LOOK: MaterialLook = Object.freeze({ finish: 0, glove: false });

export const lookOf = (spec: FinishSpec | null, glove: GloveStyle | null): MaterialLook => ({ finish: spec ? FINISH_CODE[spec.kind] : 0, glove: !!glove && glove.style !== "knit" });

export const sameLook = (a: MaterialLook, b: MaterialLook) => a.finish === b.finish && a.glove === b.glove;

/** Phones / tablets: 3 noise octaves instead of 5 and no glitter (plan §4.4 FINISH_LOD). */
export const FINISH_LOD = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export function lookDefines(l: MaterialLook): Record<string, number> {
  const d: Record<string, number> = {};
  if (l.finish > 0) d.FINISH = l.finish;
  if (l.glove) d.GLOVE = 1;
  if (l.finish > 0 && (FINISH_LOD || still)) d.FINISH_LOD = 1;
  return d;
}

// ---------------------------------------------------------------------------------------------
// Uniforms (added to every PlayerUniforms by playerUniforms(); unused ones cost nothing)

export interface FinishUniforms {
  uFinTime: THREE.IUniform<number>;
  /** Glove colour slots (gloves/paint.ts SLOT_G: base, fingers, tips, strap, detail; linear colours). */
  uGlove: THREE.IUniform<THREE.Color[]>;
}

/**
 * Potato mode (Settings -> Graphics): animated cosmetics hold still (the clock stops on STILL_T, a good-looking moment of
 * every animated finish and hat) and new finish programs compile with the cheaper FINISH_LOD path. Set by main.ts with
 * the world's potato switch; ?still=1 on the dev pages.
 */
let still = typeof location !== "undefined" && new URLSearchParams(location.search).get("still") === "1";
const STILL_T = 2.15;
export function setCosmeticsStill(on: boolean): void {
  still = on;
}
/** Shared animation preference, including cosmetics driven by each player's movement. */
export function cosmeticsStill(): boolean {
  return still;
}

/** One clock for every finish (twinkle, glitter, the Founder's shimmer) and hat, read by three.js at upload time. */
const FIN_TIME: THREE.IUniform<number> = {
  get value() {
    return still ? STILL_T : (performance.now() / 1000) % 3600;
  },
  set value(_: number) {
    /* read-only */
  },
};

export function finishUniforms(): FinishUniforms {
  return {
    uFinTime: FIN_TIME,
    uGlove: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()] },
  };
}

/**
 * Per-item finish uniforms. Nothing today: every design is baked into its recipe (the FINISH define picks it). This is
 * where a future player tint (CosmeticLoadout.tint) would be uploaded.
 */
export function setFinishUniforms(_u: PlayerUniforms, _spec: FinishSpec | null): void {}

export function setGloveUniforms(u: PlayerUniforms, g: GloveStyle | null): void {
  if (!g || g.style === "knit") return;
  const cs = [g.base, g.fingers, g.tips, g.strap, g.detail];
  u.uGlove.value.forEach((c, i) => c.setHex(cs[i]));
}

/** Finish + glove of a loadout onto a uniform block; returns the program variant the material needs. */
export function applyLoadoutUniforms(u: PlayerUniforms, l: CosmeticLoadout | null, override?: FinishSpec | null): MaterialLook {
  const spec = override !== undefined ? override : l ? specOf(l) : null;
  const glove = l ? gloveStyle(l.glove) : null;
  setFinishUniforms(u, spec);
  setGloveUniforms(u, glove);
  return lookOf(spec && spec.kind !== "none" ? spec : null, glove);
}

// ---------------------------------------------------------------------------------------------
// GLSL

/** Vertex: declarations (before main). */
export const VERTEX_PARS = /* glsl */ `
#if defined(FINISH) || defined(GLOVE)
attribute vec4 finishUV;
#endif
#ifdef FINISH
varying vec4 vFin;
#endif
${GLOVE_VERTEX_PARS}`;

/** Vertex: after vColor is set. Glove faces (accent code >= 16, gloves/paint.ts): colour slot + material. */
export const VERTEX_MAIN = /* glsl */ `
#ifdef FINISH
  vFin = finishUV;
#endif
${GLOVE_VERTEX_MAIN}`;

/** Fragment: declarations + the finish recipes (FINISH 1..14) + the glove materials (GLOVE). */
export const FRAGMENT_PARS = /* glsl */ `
#if defined(FINISH) || defined(GLOVE)
${NOISE_GLSL}
#endif
${GLOVE_FRAGMENT_PARS}
#ifdef FINISH
varying vec4 vFin;
uniform float uFinTime;
vec2 finRot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
// The carrot blade's half width along it (viewmodel/knives carrot): turns across -1..1 back into pattern units.
float finRad(float u) { return 0.8 * pow(max(1.0 - u, 0.0), 0.85) + 0.04; }

// Every recipe: (u along 0..1, v across -1..1, P = pattern units: x 2.3 .. 11.2 along, y about -0.84 .. 0.84 across)
// -> linear albedo, plus how metallic it is and any sparkle. All placements are fixed constants.
vec3 finishAlbedo(float u, float v, vec2 P, out float metal, out float sparkle, out vec3 emit) {
  metal = 0.85; sparkle = 0.0; emit = vec3(0.0);
#if FINISH == 1
  // SUNSET: a warm sky from gold at the guard through coral and rose to violet and dusk blue at the tip, slightly
  // tilted, with soft pale cloud streaks drifting along the middle of the blade.
  float s = (u - 0.5) * 0.993 + v * 0.022 + 0.53 + 0.03 * gnoise(P * 1.5);
  vec3 c0 = vec3(0.99, 0.84, 0.30), c1 = vec3(0.99, 0.52, 0.32), c2 = vec3(0.94, 0.30, 0.50), c3 = vec3(0.58, 0.26, 0.78), c4 = vec3(0.24, 0.28, 0.72);
  vec3 c = mix(c0, c1, smoothstep(0.05, 0.32, s));
  c = mix(c, c2, smoothstep(0.30, 0.55, s));
  c = mix(c, c3, smoothstep(0.55, 0.80, s));
  c = mix(c, c4, smoothstep(0.82, 1.05, s));
  float cloud = smoothstep(0.05, 0.38, fbm(vec2(P.x * 0.32, P.y * 3.6) + vec2(3.1, 7.4))) * smoothstep(0.95, 0.35, abs(v));
  c = mix(c, vec3(1.0, 0.86, 0.80), cloud * 0.4 * smoothstep(0.1, 0.45, s) * smoothstep(1.0, 0.7, s));
  metal = 0.7;
  return c * c;
#elif FINISH == 2
  // EMBER GLAZE: a kiln-fired glaze. A broad heat field runs from charcoal through ember red and orange to gold, with a
  // fine dark crackle over it.
  vec2 q = finRot(P * 0.2, 0.6) + vec2(41.0, 17.0);
  float n = (fbm(q) + 0.35 * fbm(q * 3.1 + 11.0)) * 1.25 + 0.5;
  vec3 coal = vec3(0.05, 0.03, 0.03), red = vec3(0.42, 0.04, 0.02), orange = vec3(0.92, 0.30, 0.04), gold = vec3(1.0, 0.70, 0.22);
  vec3 c = mix(coal, red, smoothstep(0.22, 0.40, n));
  c = mix(c, orange, smoothstep(0.44, 0.58, n));
  c = mix(c, gold, smoothstep(0.64, 0.82, n));
  float cr = abs(gnoise(P * vec2(2.2, 3.4) + 5.0)) + 0.5 * abs(gnoise(P * vec2(4.6, 6.8) + 9.0));
  c = mix(c, coal, (1.0 - smoothstep(0.0, 0.03, cr)) * 0.75);
  metal = 0.7;
  return c;
#elif FINISH == 3
  // TIGER LILY: petal orange, paler toward the guard, faint veins along the blade and dark maroon freckles, thickest
  // near the guard like the throat of the flower.
  vec3 c = mix(vec3(1.0, 0.66, 0.24), vec3(0.98, 0.40, 0.07), smoothstep(0.0, 0.6, u));
  float vein = smoothstep(0.7, 1.0, sin(v * 13.0 + 1.6 * gnoise(P * vec2(0.6, 1.5) + 2.0)));
  c = mix(c, vec3(1.0, 0.85, 0.55), vein * 0.25);
  vec2 g = P * vec2(1.5, 3.2);
  vec2 gi = floor(g), gf = fract(g);
  float spot = 0.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 cell = gi + vec2(float(i), float(j));
      float h = fh21(cell + 3.7);
      vec2 pt = vec2(float(i), float(j)) + 0.5 + 0.32 * fh22(cell + 1.9);
      float r = 0.13 + 0.1 * fh21(cell + 8.1);
      float d = length((gf - pt) * vec2(0.75, 1.0));
      spot = max(spot, step(mix(0.3, 0.85, u), h) * (1.0 - smoothstep(r * 0.7, r, d)));
    }
  c = mix(c, vec3(0.42, 0.06, 0.04), spot);
  metal = 0.75;
  return c * c;
#elif FINISH == 4
  // NEBULA: deep space with violet, blue and magenta gas clouds and a field of small stars that twinkle.
  vec2 q = finRot(P * vec2(0.45, 0.8), 0.4) + vec2(12.0, 30.0);
  vec2 w = vec2(fbm(q * 0.8), fbm(q * 0.8 + 5.2));
  float n = fbm(q + 2.0 * w);
  float n2 = fbm(q * 1.7 + 3.0 * w + 7.7);
  vec3 c = vec3(0.012, 0.006, 0.03);
  c = mix(c, vec3(0.26, 0.07, 0.50), smoothstep(-0.12, 0.32, n));
  c = mix(c, vec3(0.08, 0.20, 0.80), smoothstep(0.05, 0.42, n2) * 0.6);
  c = mix(c, vec3(0.90, 0.20, 0.58), smoothstep(0.22, 0.52, n) * 0.75);
  vec2 sg = P * 20.0;
  vec2 sf = fract(sg) - 0.5;
  float sh = fh21(floor(sg));
  float star = step(0.93, sh) * (1.0 - smoothstep(0.0, 0.16 + 0.14 * fract(sh * 37.0), length(sf)));
  c += vec3(1.0, 0.94, 0.88) * star * (0.65 + 0.35 * sin(uFinTime * 2.0 + sh * 50.0)) * 1.4;
#ifndef FINISH_LOD
  sparkle = step(0.985, sh) * star * max(0.0, sin(uFinTime * 1.7 + sh * 90.0)) * 1.2;
#endif
  metal = 0.55;
  return c;
#elif FINISH == 5
  // DEWDROP WEB: a dawn-blue blade (navy at the guard, dusk violet at the tip) under a fine silver spider web, with
  // dew beads glinting where the threads cross.
  vec3 c = mix(vec3(0.025, 0.04, 0.13), vec3(0.14, 0.13, 0.34), smoothstep(0.0, 1.0, u));
  c *= 0.85 + 0.3 * fbm3(P * 0.9 + 4.0);
  vec2 d = vec2(u, v * 0.35) - vec2(0.56, 0.04);
  float r = length(d) * 13.0, a = atan(d.y, d.x) + 0.35;
  float spokes = abs(sin(a * 4.0)) * (0.3 + r);
  float rings = abs(fract(r * (1.0 + 0.1 * abs(sin(a * 4.0)))) - 0.5);
  float thread = (1.0 - smoothstep(0.03, 0.11, spokes)) + (1.0 - smoothstep(0.012, 0.05, rings));
  c = mix(c, vec3(0.72, 0.78, 0.88), clamp(thread, 0.0, 1.0) * 0.85);
  float cell = fh21(vec2(floor(a * 4.0 / 3.14159 + 0.5), floor(r)));
  float dew = (1.0 - smoothstep(0.07, 0.15, length(vec2(spokes, rings * 1.3)))) * step(0.3, cell);
  c = mix(c, vec3(0.92, 0.97, 1.05), dew);
#ifndef FINISH_LOD
  sparkle = dew * max(0.0, sin(uFinTime * 2.2 + cell * 40.0)) * 0.9;
#endif
  metal = 0.6;
  return c;
#elif FINISH == 6
  // FROST: frosted ice. Pale glacier blue with deeper blue hollows, white frost ferns feathering across it, and a
  // fine sparkle.
  vec3 c = mix(vec3(0.18, 0.42, 0.72), vec3(0.62, 0.80, 0.95), smoothstep(-0.35, 0.35, fbm(P * 0.55 + vec2(8.0, 2.0))));
  vec2 q = P * 1.5 + vec2(4.0, 9.0);
  q += vec2(fbm(q * 0.5), fbm(q * 0.5 + 3.3)) * 1.6;
  float fern = 0.0, amp = 0.65;
  for (int i = 0; i < 4; i++) {
    fern += amp * pow(1.0 - min(1.0, abs(gnoise(q) * 2.2)), 7.0);
    q = mat2(1.7, 1.1, -1.1, 1.7) * q;
    amp *= 0.6;
  }
  c = mix(c, vec3(0.96, 0.98, 1.0), clamp(fern, 0.0, 1.0) * 0.85);
#ifndef FINISH_LOD
  float g = fh21(floor(P * 80.0));
  sparkle = step(0.992, g) * max(0.0, sin(uFinTime * 2.8 + g * 40.0)) * 1.3;
#endif
  metal = 0.8;
  return c;
#elif FINISH == 7
  // HEARTBEET: a sliced beetroot. Glossy crimson with darker and pinker rings around a heart in the middle of the
  // blade, a little uneven, like the real thing.
  vec2 d = (P - vec2(6.4, 0.05)) * vec2(0.5, 1.0);
  float r = length(d) + 0.13 * fbm(P * 1.2 + 2.0);
  float ring = 0.5 + 0.5 * sin(r * 12.0);
  vec3 c = mix(vec3(0.20, 0.0, 0.05), vec3(0.62, 0.02, 0.16), smoothstep(0.1, 0.6, ring));
  c = mix(c, vec3(0.95, 0.36, 0.60), smoothstep(0.78, 0.98, ring) * (0.4 + 0.6 * smoothstep(3.0, 0.3, r)));
  c *= 0.88 + 0.24 * gnoise(P * 6.0 + 3.0);
  metal = 0.8;
  return c;
#elif FINISH == 8
  // FOUR-LEAF: an emerald meadow with little four-leaf clovers scattered over it; about one in eight is gold.
  vec3 c = mix(vec3(0.01, 0.16, 0.06), vec3(0.05, 0.48, 0.18), smoothstep(-0.3, 0.4, fbm(P * 0.7 + vec2(21.0, 5.0))));
  vec2 g = P * vec2(1.25, 1.5);
  vec2 gi = floor(g);
  float h = fh21(gi + 7.0);
  float leaf = 0.0, vein = 0.0;
  if (h > 0.35) {
    vec2 p = fract(g) - 0.5 - 0.1 * fh22(gi + 2.0);
    p = finRot(p, h * 40.0) / (0.3 + 0.08 * fract(h * 13.0));
    float dm = 1e3;
    for (int k = 0; k < 4; k++) {
      float an = float(k) * 1.5708 + 0.7854;
      vec2 dir = vec2(cos(an), sin(an)), side = vec2(-dir.y, dir.x);
      // Each leaf: two lobes (a heart pointing at the middle).
      dm = min(dm, length(p - dir * 0.5 - side * 0.17) - 0.27);
      dm = min(dm, length(p - dir * 0.5 + side * 0.17) - 0.27);
      dm = min(dm, length(p - dir * 0.2) - 0.18);
    }
    vec2 sp = p - vec2(0.1, -0.7);
    dm = min(dm, max(abs(sp.x + sp.y * 0.3) - 0.05, abs(sp.y) - 0.38));
    leaf = 1.0 - smoothstep(-0.03, 0.05, dm);
    // Pale veins: the leaf diagonals.
    vein = leaf * (1.0 - smoothstep(0.02, 0.06, min(abs(p.x - p.y), abs(p.x + p.y)) / 1.41)) * step(length(p), 0.8);
  }
  float lucky = step(0.93, h);
  c = mix(c, mix(vec3(0.24, 0.72, 0.30), vec3(1.0, 0.72, 0.18), lucky), leaf);
  c = mix(c, mix(vec3(0.62, 0.95, 0.60), vec3(1.0, 0.92, 0.6), lucky), vein * 0.5);
#ifndef FINISH_LOD
  sparkle = leaf * lucky * max(0.0, sin(uFinTime * 2.4 + h * 60.0)) * 0.9;
#endif
  metal = mix(0.7, 0.95, leaf * lucky);
  return c;
#elif FINISH == 9
  // FOUNDER'S GOLD (the owner's): polished gold over slow molten ripples (carrot-orange in the troughs, pale gold on
  // the crests), a bright shimmer band sweeping guard -> tip every ~3.5 s, and fine glitter.
  vec2 q = finRot(P * vec2(0.5, 0.9), 1.1) + vec2(17.0, 41.0);
  float n = fbm(q * 0.8 + vec2(uFinTime * 0.06, -uFinTime * 0.02));
  vec3 deep = vec3(0.50, 0.15, 0.01), gold = vec3(0.95, 0.58, 0.10), pale = vec3(1.0, 0.86, 0.45);
  vec3 c = mix(deep, gold, smoothstep(-0.42, 0.05, n));
  c = mix(c, pale, smoothstep(0.22, 0.6, n) * 0.45);
  float band = fract(uFinTime / 3.5) * 1.9 - 0.45;
  float d = u + v * 0.22 - band;
  float sh = exp(-d * d * 140.0);
  c = mix(c, pale * 1.3, sh * 0.7);
#ifndef FINISH_LOD
  float g = fh21(floor(P * 72.0));
  sparkle = step(0.988, g) * max(0.0, sin(uFinTime * 3.2 + g * 40.0)) * 1.4 + sh * 0.35;
#else
  sparkle = sh * 0.35;
#endif
  metal = 0.97;
  return c;
#elif FINISH == 10
  // GEODE (the Supporter's): a split geode. A dark stone rim at the edges with two agate bands inside it (their widths
  // wander along the blade); the middle is a bed of big crystal facets, each a little pyramid in three close flat tones
  // of muted teal through violet toward the tip, a few pale. Every 4.5 s one shine crosses the blade guard -> tip in
  // ~0.8 s and lights the facets it passes, then nothing (a long hold, one quick glint); the crystal glows faintly.
  float edge = abs(v);
  vec2 g = P * vec2(0.8, 1.55);
  vec2 gi = floor(g), gf = fract(g);
  float d1 = 9.0, d2 = 9.0;
  vec2 c1 = vec2(0.0), o1 = vec2(0.0);
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 cell = gi + vec2(float(i), float(j));
      vec2 o = vec2(float(i), float(j)) + 0.5 + 0.32 * fh22(cell + 4.1);
      float d = length((gf - o) * vec2(1.0, 0.85));
      if (d < d1) { d2 = d1; d1 = d; c1 = cell; o1 = o; } else if (d < d2) d2 = d;
    }
  float h = fh21(c1 + 2.3);
  // Facet tone: the side of the little pyramid the point is on, lit from the upper left; 3 close flat values.
  vec2 dir = normalize(gf - o1 + 1e-4);
  float side = dot(dir, normalize(vec2(-0.6, 0.8)));
  float tone = side > 0.3 ? 1.0 : side > -0.3 ? 0.8 : 0.62;
  vec3 teal = vec3(0.02, 0.42, 0.42), viol = vec3(0.20, 0.10, 0.62), pale = vec3(0.55, 0.92, 0.86);
  vec3 cc = mix(teal, viol, clamp(u * 1.05 + (h - 0.5) * 0.45, 0.0, 1.0));
  cc = mix(cc, pale * 0.87, step(0.93, h) * 0.6);
  vec3 c = cc * tone;
  float seam = 1.0 - smoothstep(0.01, 0.035, d2 - d1);
  c = mix(c, cc * 0.35, seam * 0.8);
  // The shine: crosses the blade in ~0.8 s every 4.5 s, lighting whole facets (by their centres).
  float cyc = 4.5;
  float sw = fract(uFinTime / cyc) * cyc / 0.8 * 1.4 - 0.2;
  float cu = (c1.x + o1.x) / 0.8;
  float fu = (cu - 2.3) / 8.9 + (c1.y + o1.y) / 1.55 * 0.12;
  float lit = exp(-(fu - sw) * (fu - sw) * 90.0);
  c = mix(c, mix(cc, pale, 0.6) * 1.15, lit * (0.25 + 0.35 * tone));
  emit = cc * 0.1 * (0.85 + 0.15 * sin(uFinTime * 1.7 + h * 6.0)) + pale * lit * 0.22 * tone;
  // Stone rim and two agate bands, uneven: their widths wander along the blade.
  float e = edge + 0.025 * gnoise(vec2(P.x * 0.9, 1.7));
  // Each band's width wanders about ±35% along the blade.
  float w1 = 0.04 * (1.0 + 0.7 * gnoise(vec2(P.x * 0.7, 4.1)));
  float w2 = 0.03 * (1.0 + 0.7 * gnoise(vec2(P.x * 0.8, 9.3)));
  float band1 = smoothstep(0.73 - w1, 0.74 - w1, e) * (1.0 - smoothstep(0.77, 0.78, e));
  float band2 = smoothstep(0.81 - w2, 0.82 - w2, e) * (1.0 - smoothstep(0.85, 0.86, e));
  c = mix(c, vec3(0.50, 0.48, 0.66), band1 * 0.8);
  c = mix(c, vec3(0.22, 0.16, 0.42), band2 * 0.8);
  float shell = smoothstep(0.895, 0.915, e);
  vec3 stone = vec3(0.05, 0.045, 0.055) * (0.75 + 0.5 * fbm3(P * 6.0 + 3.0));
  c = mix(c, stone, shell);
  emit *= 1.0 - max(max(band1, band2), shell);
  sparkle = lit * 0.45 * tone;
  metal = mix(0.15, 0.3, shell);
  return c;
#elif FINISH == 11
  // RIFT (the Supporter's): a dark plum blade cracked through by a few angular fractures of lavender light (straight
  // runs that break off and start again), with a rare aqua spark where cracks meet. Every 3.8 s a pulse runs up the
  // cracks guard -> tip in ~1.2 s, then they settle to a low glow.
  float t = uFinTime;
  vec3 c = mix(vec3(0.035, 0.012, 0.045), vec3(0.085, 0.03, 0.10), smoothstep(-0.4, 0.5, fbm3(P * vec2(0.5, 1.2) + 7.0)));
  vec2 g = finRot(P, 0.5) * vec2(0.75, 1.5);
  vec2 gi = floor(g), gf = fract(g);
  float d1 = 9.0, d2 = 9.0;
  vec2 c1 = vec2(0.0), c2 = vec2(0.0);
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 cell = gi + vec2(float(i), float(j));
      vec2 o = vec2(float(i), float(j)) + 0.5 + 0.42 * fh22(cell + 1.3);
      float d = length(gf - o);
      if (d < d1) { d2 = d1; c2 = c1; d1 = d; c1 = cell; } else if (d < d2) { d2 = d; c2 = cell; }
    }
  // Only some cell borders are cracks, and those break along their length.
  float pairH = fh21(c1 + c2 + 0.37 * (c1 * c2) + 5.0);
  float on = step(0.45, pairH) * step(0.28, fract(dot(gf, vec2(2.3, 1.1)) * 1.6 + pairH * 7.0));
  float dEdge = d2 - d1;
  float crack = (1.0 - smoothstep(0.024, 0.052, dEdge)) * on;
  float core = (1.0 - smoothstep(0.004, 0.014, dEdge)) * on;
  float glowW = exp(-dEdge * 24.0) * on;
  // A junction: close to a third cell too (the cell corner), rarely.
  float junction = (1.0 - smoothstep(0.0, 0.07, dEdge + abs(d1 - 0.5 * (d1 + d2)))) * step(0.82, fh21(c1 + 9.0));
  float pulse = fract(t / 3.8) * 3.8 / 1.2 * 1.5 - 0.25;
  float pu = exp(-(u - pulse) * (u - pulse) * 40.0);
  float level = 0.85 + 0.9 * pu;
  vec3 lav = vec3(0.62, 0.48, 1.0), hot = vec3(0.92, 0.88, 1.0);
  emit = (lav * crack * 0.85 + lav * glowW * 0.35 + hot * core * (0.35 + 0.6 * pu)) * level;
  emit += vec3(0.3, 1.0, 0.9) * junction * on * (0.6 + 0.8 * pu);
  c = mix(c, lav * 0.2, glowW * 0.25);
  sparkle = crack * pu * 0.3;
  metal = 0.12;
  return c;
#elif FINISH == 12
  // SPECTRUM (the Supporter's): a black blade printed with a halftone grid of little hexagons (each a little different
  // in size and place, a few missing); one or two broad bands of colour (aqua, azure, amethyst) drift guard -> tip
  // through it over ~6 s, the hexagons swelling slightly where a band is bright.
  float t = uFinTime;
  vec2 Pg = P;
  // Hex grid (pattern units), rotated a little; hexagonal dots (hex distance).
  vec2 hp = finRot(Pg, 0.35) * 2.4;
  vec2 r = vec2(1.0, 1.7320508);
  vec2 ha = mod(hp, r) - r * 0.5, hb = mod(hp - r * 0.5, r) - r * 0.5;
  bool inA = dot(ha, ha) < dot(hb, hb);
  vec2 hc = inA ? ha : hb;
  // Each dot is its own: a stable size (±12%), a nudge (±8%), and about one in eight left out.
  vec2 hid = floor(inA ? hp / r : (hp - r * 0.5) / r) + (inA ? vec2(0.0) : vec2(0.5));
  float hh = fh21(hid + 3.1);
  hc -= 0.08 * fh22(hid + 7.7);
  vec2 ah = abs(hc);
  float hd = max(ah.x * 0.866 + ah.y * 0.5, ah.y);
  // The drifting colour field: ~1.3 colour cycles across the blade, one cycle passing every ~6 s.
  float f = (Pg.x - 2.3) / 8.9 * 1.3 - t / 6.0 + 0.04 * Pg.y;
  vec3 c0 = vec3(0.05, 0.85, 0.75), c1 = vec3(0.08, 0.38, 1.0), c2 = vec3(0.48, 0.16, 0.95);
  float x = fract(f) * 3.0;
  vec3 col = x < 1.0 ? mix(c0, c1, smoothstep(0.0, 1.0, x)) : x < 2.0 ? mix(c1, c2, smoothstep(1.0, 2.0, x)) : mix(c2, c0, smoothstep(2.0, 3.0, x));
  float bright = 0.5 + 0.5 * sin(fract(f) * 6.28318);
  float rad = 0.30 * (0.88 + 0.24 * hh) * (1.0 + 0.06 * bright);
  float dotM = (1.0 - smoothstep(rad - 0.035, rad, hd)) * step(0.12, fract(hh * 13.7));
  vec3 c = vec3(0.01, 0.01, 0.016);
  emit = col * dotM * (0.4 + 0.3 * bright);
  c = mix(c, col * 0.25, dotM);
  sparkle = 0.0;
  metal = 0.3;
  return c;
#elif FINISH == 13
  // GOLD LEAF (the Supporter's High Roller): torn sheets of gold leaf laid on black lacquer, fine cracks through the
  // leaf, a soft sheen crossing guard -> tip every 5 s and a few glints on the gold.
  float t = uFinTime;
  float leafN = fbm(P * vec2(0.55, 1.3) + vec2(9.0, 4.0)) + 0.25 * gnoise(P * 3.2 + 1.7);
  float leaf = smoothstep(-0.02, 0.03, leafN);
  vec3 lacquer = vec3(0.012, 0.010, 0.012) + vec3(0.02, 0.012, 0.004) * smoothstep(0.0, 0.25, leafN + 0.1);
  vec3 gold = mix(vec3(0.62, 0.34, 0.05), vec3(1.0, 0.74, 0.26), smoothstep(-0.2, 0.4, gnoise(P * 1.8 + 6.0)));
  float crack = 1.0 - smoothstep(0.0, 0.035, abs(gnoise(P * vec2(2.6, 4.2) + 11.0)));
  gold = mix(gold, gold * 0.35, crack * 0.8);
  // The leaf's torn edge catches a little light.
  float rim = smoothstep(-0.02, 0.0, leafN) * (1.0 - smoothstep(0.0, 0.03, leafN));
  vec3 c = mix(lacquer, gold, leaf);
  c = mix(c, vec3(1.0, 0.86, 0.5), rim * 0.6);
  float band = fract(t / 5.0) * 1.8 - 0.4;
  float d = u + v * 0.18 - band;
  float sh = exp(-d * d * 120.0) * leaf;
  c = mix(c, vec3(1.0, 0.9, 0.62), sh * 0.6);
  emit = vec3(1.0, 0.78, 0.35) * sh * 0.25;
#ifndef FINISH_LOD
  float g = fh21(floor(P * 60.0));
  sparkle = step(0.985, g) * leaf * max(0.0, sin(t * 3.0 + g * 50.0)) * 1.3 + sh * 0.3;
#else
  sparkle = sh * 0.3;
#endif
  metal = mix(0.25, 0.97, leaf);
  return c;
#elif FINISH == 14
  // AURORA (the Supporter's Borealis): a night-blue blade under curtains of aurora light that ripple along it, green at
  // the cutting edge's side rising into violet, fine vertical rays through them, and a few faint stars behind.
  float t = uFinTime;
  vec3 c = mix(vec3(0.004, 0.008, 0.03), vec3(0.01, 0.02, 0.06), smoothstep(-0.8, 0.8, v));
  float sway = fbm3(vec2(P.x * 0.35 + t * 0.06, 2.0)) * 3.0;
  float curtain = 0.5 + 0.5 * sin(P.x * 1.6 + sway + t * 0.5);
  curtain = smoothstep(0.35, 1.0, curtain);
  float rays = 0.65 + 0.35 * sin(P.x * 34.0 + gnoise(vec2(P.x * 3.0, t * 0.3)) * 3.0);
  // Height in the curtain: bright low (v near -1), fading upward; the lower edge ripples.
  float base = -0.75 + 0.18 * sin(P.x * 2.3 + t * 0.7);
  float hgt = clamp((v - base) / 1.5, 0.0, 1.0);
  float body = smoothstep(0.0, 0.08, v - base) * (1.0 - hgt) * (1.0 - hgt * 0.4);
  vec3 col = mix(vec3(0.15, 1.0, 0.55), vec3(0.55, 0.25, 1.0), smoothstep(0.15, 0.85, hgt));
  float a = curtain * rays * body;
  emit = col * a * 0.95;
  c += col * a * 0.12;
#ifndef FINISH_LOD
  vec2 sg = P * 16.0;
  float shh = fh21(floor(sg));
  float star = step(0.96, shh) * (1.0 - smoothstep(0.0, 0.16, length(fract(sg) - 0.5)));
  emit += vec3(0.85, 0.9, 1.0) * star * (0.35 + 0.25 * sin(t * 1.7 + shh * 40.0)) * (1.0 - a);
#endif
  metal = 0.35;
  return c;
#else
  return vColor;
#endif
}

// The finished blade's shaded colour (n: front-facing normal, V: to the eye, L: key light, ambient, key).
vec3 finishShade(vec3 n, vec3 V, vec3 L, vec3 ambient, float key) {
  float u = clamp(vFin.x, 0.0, 1.0), v = clamp(vFin.y, -1.0, 1.0);
  vec2 P = vec2(2.3 + u * 8.9, v * finRad(u));
  float metal, sparkle;
  vec3 emit;
  vec3 alb = finishAlbedo(u, v, P, metal, sparkle, emit);
  // Keep the carrot's growth rings as faint grooves under the paint.
  alb *= mix(0.86, 1.0, step(0.15, vColor.g));
  // The player material's toon key + ambient, plus a stylised metal reflection (sky / ground, sharp highlight).
  vec3 R = reflect(-V, n);
  float envT = smoothstep(-0.25, 0.75, R.y);
  vec3 env = mix(vec3(0.12, 0.11, 0.13), vec3(1.05, 1.08, 1.15), envT);
  float spec = pow(max(dot(R, L), 0.0), 48.0);
  vec3 diffuse = alb * (ambient + key * vec3(0.78, 0.74, 0.68));
  vec3 metallic = alb * (env * 0.75 + key * 0.45);
  vec3 col = mix(diffuse, metallic, metal);
  col += spec * mix(vec3(1.0), alb * 2.0, 0.3) * (0.35 + 0.65 * metal);
  col += sparkle * vec3(1.0) * (0.4 + 0.6 * pow(max(dot(n, V), 0.0), 2.0));
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  col += rim * 0.18 * mix(vec3(1.0), alb, 0.5);
  // Self-lit parts (the Supporter finishes' veins, dots and glints): not shaded, so they glow in any light.
  col += emit;
  return col;
}
#endif`;

/** True for fragments of the finished blade (PART.blade). */
export const FRAGMENT_IS_BLADE = /* glsl */ `abs(vFin.z - 1.0) < 0.5`;
