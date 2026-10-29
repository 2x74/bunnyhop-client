// Glove materials in the player solid material (`#define GLOVE`, viewmodel/finishes/shader.ts wires it in): glove faces
// carry accent code 16 + slot + 8 * material (paint.ts), so the vertex shader picks the colourway slot and the
// fragment shader a small surface recipe per material: knit ribs, leather grain + sheen, punched perforations, cloth
// wrap overlaps + weave, rubber pebble, fuzz, glossy hard plates, canvas weave + dirt, velcro speckle, metal snaps,
// plus seams (finishUV.x = distance to a panel edge), knuckle creases (finishUV.z = PART.glove + 0.45 * crease) and
// worn edges (finishUV.w). Patterns live in bind space (the `position` attribute: they stick to the skin while it
// animates), projected on the dominant normal axis. Cost: glove pixels only, a handful of gradient-noise taps; no
// textures.
//
// Per detail level (finishes/detail.ts cosLevel: the graphics look, first vs third person):
//   0 (Potato, Plain)       the colour recipes, seams as a darker groove with a thread line, a Blinn highlight.
//   1 (Source; third person on every look but Potato / Plain)
//                           + relief: every panel edge is a piped seam (a groove and a rolled lip either side) with
//                             a raised thread, knuckle creases on the fingers, wrap turns that step; fabric sheen
//                             (knit, fuzz, canvas), a two-lobe leather highlight, a glossy coat on plates.
//   2 (Enhanced / Cinematic, first person)
//                           + fine relief: leather grain, knit ribs, weave, rubber pebble, perforation rims; metal
//                             snaps and hard plates reflect the scene (environment.ts) instead of the studio.

/** Vertex declarations. */
export const GLOVE_VERTEX_PARS = /* glsl */ `
#ifdef GLOVE
uniform vec3 uGlove[5];
varying float vGMat;
varying vec4 vGl;
varying vec3 vGP;
varying vec3 vGN;
#endif`;

/** Vertex main (after vColor): colour slot + material from the accent code. */
export const GLOVE_VERTEX_MAIN = /* glsl */ `
#ifdef GLOVE
  vGMat = -1.0;
  if (accent > 15.5) {
    float g = floor(accent - 16.0 + 0.5);
    float slot = mod(g, 8.0);
    vGMat = floor(g / 8.0 + 0.01);
    // partColor carries the builders' soft occlusion on glove faces (white elsewhere: gloves/fp.ts fingerAO).
    vColor = (slot > 4.5 ? uPalette[6] : uGlove[int(slot + 0.5)]) * partColor.r;
  }
  vGl = finishUV;
  vGP = position;
  vGN = normal;
#endif`;

/** Fragment declarations + recipes (needs NOISE_GLSL and finishes/detail.ts DETAIL_PARS before it). */
export const GLOVE_FRAGMENT_PARS = /* glsl */ `
#ifdef GLOVE
uniform vec3 uGlove[5];
varying float vGMat;
varying vec4 vGl;
varying vec3 vGP;
varying vec3 vGN;
// Screen derivatives, taken once in uniform control flow (GLOVE_FRAGMENT_ALBEDO) for the recipes below.
float gPx;
vec3 gPdx, gPdy;
vec2 gSd;
vec2 gProj(vec3 p, vec3 n) {
  vec3 a = abs(n);
  return a.x > a.y && a.x > a.z ? p.yz : a.y > a.z ? p.xz : p.xy;
}
// 1 while a pattern of f radians per unit is resolved on screen, fading to 0 before it would alias.
float gRes(float f) { return 1.0 - smoothstep(0.12, 0.32, gPx * f / 6.2832); }
// Thread dashes beside a seam: of two world-anchored stripe sets, the one that changes faster along the seam (on
// screen), so the stitches always read as dashes whichever way the seam runs.
float gDash() {
  const vec3 d1 = vec3(6.1, 6.3, 6.7), d2 = vec3(-6.4, 6.6, -5.9);
  vec2 t = vec2(-gSd.y, gSd.x);
  float r1 = abs(dot(vec2(dot(gPdx, d1), dot(gPdy, d1)), t)), r2 = abs(dot(vec2(dot(gPdx, d2), dot(gPdy, d2)), t));
  float f = fract(r1 >= r2 ? dot(vGP, d1) : dot(vGP, d2));
  return smoothstep(0.08, 0.16, f) * (1.0 - smoothstep(0.62, 0.7, f));
}
// Albedo of a glove fragment, plus its specular strength / power, sheen (fabric rim), relief height h (units) and how
// much it reflects like metal (1 metal, ~0.4 a coated plate).
vec3 gloveAlbedo(vec3 alb, float lv, out float spec, out float pw, out float sheen, out float h, out float metal) {
  float m = vGMat;
  vec2 q = gProj(vGP, normalize(vGN));
  float seam = vGl.x, along = vGl.y;
  float crease = clamp((vGl.z - 4.0) / 0.45, 0.0, 1.0);
  float relief = lv > 0.5 ? 1.0 : 0.0, fine = lv > 1.5 ? 1.0 : 0.0;
  float g = gnoise(q * 9.0);
  spec = 0.06; pw = 10.0; sheen = 0.0; h = 0.0; metal = 0.0;
  if (m < 0.5) {
    // Knit / neoprene: a fine close-knit texture (faint courses across the part, a soft fleck), a fabric sheen.
    float rib = sin(along * 34.0) * gRes(34.0);
    float fl = gnoise(q * 52.0) * gRes(52.0);
    alb *= 0.96 + 0.025 * rib + 0.035 * g + 0.03 * fl;
    h = fine * (0.0012 * rib + 0.0016 * fl);
    spec = 0.04; pw = 7.0; sheen = 0.32;
  } else if (m < 2.5) {
    // Leather: two scales of grain, a tight highlight over a broad soft one, a little sheen.
    float g2 = gnoise(q * 41.0) * gRes(41.0);
    float gr = gnoise(q * 15.0) * 0.6 + g2 * 0.4;
    alb *= 0.92 + 0.14 * gr;
    h = fine * (0.0024 * gnoise(q * 15.0) + 0.0016 * g2);
    spec = 0.46 + 0.14 * gr; pw = 40.0; sheen = 0.1;
    if (m > 1.5) {
      // Punched perforations on a staggered grid (pressed in, a darker lining showing through).
      // (Faded out where the projection is oblique, the finger sides: no smeared holes.)
      vec3 an = abs(normalize(vGN));
      vec2 c = q * 5.2;
      c.x += 0.5 * mod(floor(c.y), 2.0);
      float r = length(fract(c) - 0.5);
      float hole = smoothstep(0.2, 0.12, r) * smoothstep(0.64, 0.8, max(an.x, max(an.y, an.z))) * gRes(5.2 * 6.28);
      alb *= 1.0 - 0.72 * hole;
      spec *= 1.0 - hole;
      h -= relief * 0.008 * hole;
    }
  } else if (m < 3.5) {
    // Cloth wrap: overlapping turns (each turn's edge lies on the next: a shadowed step) and a fine weave.
    float turn = fract(along * 1.6 + 0.3 * (q.x + q.y));
    alb *= 0.72 + 0.28 * smoothstep(0.0, 0.14, turn) + 0.08 * (1.0 - smoothstep(0.86, 1.0, turn));
    float wv = sin(q.x * 95.0) * sin(q.y * 95.0) * gRes(95.0);
    alb *= 0.95 + 0.05 * wv + 0.04 * g;
    h = relief * 0.016 * smoothstep(0.0, 0.1, turn) * (1.0 - 0.4 * turn) + fine * 0.002 * wv;
    spec = 0.04; pw = 8.0; sheen = 0.16;
  } else if (m < 4.5) {
    // Rubber / padding: matte pebble.
    float pb = gnoise(q * 24.0) * gRes(24.0);
    // (A little darker and flatter than the fabric and leather around it, so the materials part at a glance.)
    alb *= 0.86 + 0.07 * pb;
    h = fine * 0.005 * pb;
    spec = 0.11; pw = 12.0; sheen = 0.03;
  } else if (m < 5.5) {
    // Fuzz: clumpy, lighter tufts, a soft bright rim (light caught in the fibres).
    float f = gnoise(q * 15.0) * 0.55 + gnoise(q * 43.0) * 0.45 * gRes(43.0);
    alb *= 0.86 + 0.3 * f;
    h = relief * 0.008 * f;
    spec = 0.0; sheen = 0.6;
  } else if (m < 6.5) {
    // Hard plate: smooth under a glossy clear coat.
    alb *= 0.97 + 0.03 * g;
    spec = 0.95; pw = 70.0; sheen = 0.06; metal = 0.4;
  } else if (m < 7.5) {
    // Canvas: coarse weave and garden dirt.
    float wv = sin(q.x * 70.0) * sin(q.y * 70.0) * gRes(70.0);
    alb *= 0.9 + 0.08 * wv + 0.06 * g;
    float d = smoothstep(0.08, 0.42, fbm3(q * 1.1 + 7.0));
    alb = mix(alb, alb * vec3(0.7, 0.6, 0.48), d * 0.45);
    h = fine * 0.004 * wv;
    spec = 0.02; pw = 8.0; sheen = 0.2;
  } else if (m < 8.5) {
    // Velcro: dense hook speckle.
    float sp = step(0.5, fh21(floor(q * 55.0)));
    alb *= 0.72 + 0.38 * sp;
    h = fine * 0.003 * sp * gRes(55.0);
    spec = 0.03; sheen = 0.05;
  } else {
    // Metal snap / rivet / trim: the reflection does the work (gloveLight).
    alb *= 1.1;
    spec = 1.6; pw = 110.0; metal = 1.0;
  }
  // Seams (not on fuzz or metal): a pressed groove at the panel edge, a rolled lip either side, a row of thread.
  // Widths never drop under a pixel or two (gPx: units per pixel), so the seams still read at the default framing.
  if (seam < 0.4 && m < 8.5 && abs(m - 5.0) > 0.5) {
    float gw = max(0.035, 1.3 * gPx), lw = max(0.17, 4.0 * gPx);
    float groove = 1.0 - smoothstep(0.0, gw, seam);
    float lip = smoothstep(gw * 0.6, gw * 1.6, seam) * (1.0 - smoothstep(lw * 0.45, lw, seam));
    alb *= 1.0 - 0.34 * groove;
    // The rolled lip catches the light (a little: it's relief, not an outline).
    alb *= 1.0 + relief * 0.04 * lip;
    float tw = max(0.011, 0.45 * gPx);
    // Far away the dashes merge into a faint line rather than a solid outline.
    float st = smoothstep(tw * 1.7, tw * 0.6, abs(seam - max(0.105, gw + 2.0 * gPx))) * mix(0.45, gDash(), gRes(28.0));
    // Thread: the detail colour, a little toward the panel's so it sits in the material.
    alb = mix(alb, mix(uGlove[4], alb, 0.3), st * 0.75);
    h += relief * (-0.02 * groove + 0.014 * lip + 0.005 * st);
  }
  // Knuckle creases: a few soft wrinkles across the finger at each joint.
  if (crease > 0.0) {
    float wr = crease * crease * smoothstep(0.35, 1.0, 0.5 + 0.5 * sin(along * 19.0 + 1.3)) * gRes(19.0);
    alb *= 1.0 - 0.2 * wr;
    h -= relief * 0.014 * wr;
  }
  // Worn edges: lighter, scuffed.
  float wn = smoothstep(0.4, 0.95, vGl.w * (0.75 + 0.7 * gnoise(q * 6.0)));
  alb = mix(alb, alb * 1.2 + 0.025, wn * 0.55);
  return alb;
}
// Specular + sheen + reflection on top of the toon shade (n front-facing, V to the eye, L key light).
vec3 gloveLight(vec3 alb, vec3 n, vec3 V, vec3 L, float key, float lv, float spec, float pw, float sheen, float metal) {
  vec3 H = normalize(L + V);
  float nh = max(dot(n, H), 0.0);
  float nv = max(dot(n, V), 0.0);
  float s = pow(nh, pw) * spec * (0.35 + 0.65 * key);
  if (lv > 0.5) s += pow(nh, max(pw * 0.22, 3.0)) * spec * 0.12 * key;
  float rim = pow(1.0 - nv, 2.0);
  // Sheen: light caught at grazing angles, mostly the material's own colour (a fabric's fibres, not a plastic rim).
  vec3 c = vec3(s) + sheen * rim * (lv > 0.5 ? (alb * 0.7 + 0.03) * (0.55 + 0.45 * key) : alb * 0.6 + 0.08);
  if (metal > 0.0 && lv > 0.5) {
    // Metal tints its reflection; a plate's clear coat reflects untinted, mostly at grazing angles.
    vec3 R = reflect(-V, n);
    float fc = pow(1.0 - nv, 5.0);
    vec3 env = cosReflect(R, metal > 0.5 ? 0.1 : 0.05, lv);
    c += metal > 0.5 ? env * (alb + (1.0 - alb) * fc) * 0.75 - alb * 0.35 : env * (0.06 + 0.94 * fc) * 0.5;
  }
  return c;
}
#endif`;

/** Fragment: albedo hook (before the toon shade; `albedo` starts as vColor). Relief re-lights n / key / ambient. */
export const GLOVE_FRAGMENT_ALBEDO = /* glsl */ `
#ifdef GLOVE
  float gLv = cosLevel();
  float gSpec = 0.0, gPow = 8.0, gSheen = 0.0, gH = 0.0, gMetal = 0.0;
  gPdx = dFdx(vGP); gPdy = dFdy(vGP);
  gPx = length(abs(gPdx) + abs(gPdy));
  gSd = vec2(dFdx(vGl.x), dFdy(vGl.x));
  if (vGMat > -0.5) albedo = gloveAlbedo(albedo, gLv, gSpec, gPow, gSheen, gH, gMetal);
#ifdef VM_DETAIL
  float kM = vGMat > -0.5 ? 0.0 : kMat();
#ifdef FINISH
  // A finished blade is the finish's alone (finishShade, unbumped normal).
  if (abs(vFin.z - 1.0) < 0.5) kM = 0.0;
#endif
  if (kM > 0.5) gH = kHeight(kM, gLv);
#endif
  if (gLv > 0.5) {
    vec3 nb = cosBump(n, gH);
    if (gH != 0.0 || vGMat > -0.5) {
      n = nb;
      ndl = dot(n, L);
      key = smoothstep(-0.05, 0.55, ndl);
      ambient = mix(ground, sky, n.y * 0.5 + 0.5) * 0.62;
    }
  }
#endif`;

/** Fragment: lighting hook (after the toon shade + rim). */
export const GLOVE_FRAGMENT_LIGHT = /* glsl */ `
#ifdef GLOVE
  if (vGMat > -0.5) col += gloveLight(albedo, n, V, L, key, gLv, gSpec, gPow, gSheen, gMetal) * back;
#ifdef VM_DETAIL
  if (kM > 0.5) col = knifeShade(col, albedo, kM, gLv, n, V, L, ambient, key);
#endif
#endif`;
