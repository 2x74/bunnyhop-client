// Glove materials in the player solid material (`#define GLOVE`, viewmodel/finishes/shader.ts wires it in): glove faces
// carry accent code 16 + slot + 8 * material (paint.ts), so the vertex shader picks the colourway slot and the
// fragment shader a small surface recipe per material: knit ribs, leather grain + sheen, punched perforations, cloth
// wrap overlaps + weave, rubber pebble, fuzz, glossy hard plates, canvas weave + dirt, velcro speckle, metal snaps,
// plus stitched seams (finishUV.x = distance to a seam) and worn edges (finishUV.w). Patterns live in bind space
// (the `position` attribute: they stick to the skin while it animates), projected on the dominant normal axis.
// Cost: glove pixels only, a handful of gradient-noise taps; no textures.

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
    vColor = slot > 4.5 ? uPalette[6] : uGlove[int(slot + 0.5)];
  }
  vGl = finishUV;
  vGP = position;
  vGN = normal;
#endif`;

/** Fragment declarations + recipes (needs NOISE_GLSL before it). */
export const GLOVE_FRAGMENT_PARS = /* glsl */ `
#ifdef GLOVE
uniform vec3 uGlove[5];
varying float vGMat;
varying vec4 vGl;
varying vec3 vGP;
varying vec3 vGN;
vec2 gProj(vec3 p, vec3 n) {
  vec3 a = abs(n);
  return a.x > a.y && a.x > a.z ? p.yz : a.y > a.z ? p.xz : p.xy;
}
// Albedo of a glove fragment, plus its specular strength / power and sheen (rim) for gloveLight().
vec3 gloveAlbedo(vec3 alb, out float spec, out float pw, out float sheen) {
  float m = vGMat;
  vec2 q = gProj(vGP, normalize(vGN));
  float seam = vGl.x, along = vGl.y;
  float g = gnoise(q * 9.0);
  spec = 0.06; pw = 10.0; sheen = 0.0;
  if (m < 0.5) {
    // Neoprene / knit: fine ribs across the part.
    alb *= 0.95 + 0.05 * sin(along * 34.0) + 0.04 * g;
    spec = 0.12; pw = 14.0; sheen = 0.12;
  } else if (m < 2.5) {
    // Leather: two scales of grain, a soft sheen.
    float gr = gnoise(q * 15.0) * 0.6 + gnoise(q * 41.0) * 0.4;
    alb *= 0.92 + 0.14 * gr;
    spec = 0.32 + 0.1 * gr; pw = 26.0; sheen = 0.18;
    if (m > 1.5) {
      // Punched perforations on a staggered grid.
      vec2 c = q * 5.2;
      c.x += 0.5 * mod(floor(c.y), 2.0);
      float hole = smoothstep(0.2, 0.12, length(fract(c) - 0.5));
      alb *= 1.0 - 0.72 * hole;
      spec *= 1.0 - hole;
    }
  } else if (m < 3.5) {
    // Cloth wrap: overlapping turns (a shadowed edge every turn) and a fine weave.
    float turn = fract(along * 1.6 + 0.3 * (q.x + q.y));
    alb *= 0.68 + 0.32 * smoothstep(0.0, 0.14, turn) + 0.08 * (1.0 - smoothstep(0.86, 1.0, turn));
    alb *= 0.94 + 0.06 * sin(q.x * 95.0) * sin(q.y * 95.0) + 0.04 * g;
    spec = 0.04; pw = 8.0; sheen = 0.1;
  } else if (m < 4.5) {
    // Rubber / padding: matte pebble.
    alb *= 0.93 + 0.07 * gnoise(q * 24.0);
    spec = 0.16; pw = 12.0;
  } else if (m < 5.5) {
    // Fuzz: clumpy, lighter tufts, a soft rim.
    float f = gnoise(q * 15.0) * 0.55 + gnoise(q * 43.0) * 0.45;
    alb *= 0.86 + 0.3 * f;
    spec = 0.0; sheen = 0.55;
  } else if (m < 6.5) {
    // Hard plate: glossy clear coat.
    alb *= 0.97 + 0.03 * g;
    spec = 0.95; pw = 64.0; sheen = 0.22;
  } else if (m < 7.5) {
    // Canvas: coarse weave and garden dirt.
    alb *= 0.9 + 0.08 * sin(q.x * 70.0) * sin(q.y * 70.0) + 0.06 * g;
    float d = smoothstep(0.08, 0.42, fbm3(q * 1.1 + 7.0));
    alb = mix(alb, alb * vec3(0.7, 0.6, 0.48), d * 0.45);
    spec = 0.02; pw = 8.0;
  } else if (m < 8.5) {
    // Velcro: dense hook speckle.
    alb *= 0.72 + 0.38 * step(0.5, fh21(floor(q * 55.0)));
    spec = 0.03;
  } else {
    // Metal snap / rivet.
    alb *= 1.15;
    spec = 1.3; pw = 90.0; sheen = 0.4;
  }
  // Seams: a pressed groove with a dashed stitch line beside it (detail colour); not on fuzz or metal.
  if (seam < 0.3 && m < 8.5 && abs(m - 5.0) > 0.5) {
    alb *= 0.78 + 0.22 * smoothstep(0.0, 0.05, seam);
    float st = smoothstep(0.026, 0.01, abs(seam - 0.1)) * step(0.45, fract(dot(vGP, vec3(6.1, 6.3, 6.7))));
    alb = mix(alb, uGlove[4], st * 0.9);
  }
  // Worn edges: lighter, scuffed.
  float wn = smoothstep(0.4, 0.95, vGl.w * (0.75 + 0.7 * gnoise(q * 6.0)));
  alb = mix(alb, alb * 1.2 + 0.025, wn * 0.55);
  return alb;
}
// Specular + sheen on top of the toon shade (n front-facing, V to the eye, L key light).
vec3 gloveLight(vec3 alb, vec3 n, vec3 V, vec3 L, float key, float spec, float pw, float sheen) {
  vec3 H = normalize(L + V);
  float s = pow(max(dot(n, H), 0.0), pw) * spec * (0.35 + 0.65 * key);
  float rim = pow(1.0 - max(dot(n, V), 0.0), 2.0);
  return vec3(s) + sheen * rim * (alb * 0.6 + 0.08);
}
#endif`;

/** Fragment: albedo hook (before the toon shade; `albedo` starts as vColor). */
export const GLOVE_FRAGMENT_ALBEDO = /* glsl */ `
#ifdef GLOVE
  float gSpec = 0.0, gPow = 8.0, gSheen = 0.0;
  if (vGMat > -0.5) albedo = gloveAlbedo(albedo, gSpec, gPow, gSheen);
#endif`;

/** Fragment: lighting hook (after the toon shade + rim). */
export const GLOVE_FRAGMENT_LIGHT = /* glsl */ `
#ifdef GLOVE
  if (vGMat > -0.5) col += gloveLight(albedo, n, V, L, key, gSpec, gPow, gSheen) * back;
#endif`;
