// Hilt skins in the player solid material (`#define HILT`, viewmodel/finishes/shader.ts wires it in; loadout.ts
// HILT_SKIN holds the recipes). A knife's hilt parts carry their role in finishUV (knives/types.ts HiltMap: x = role
// code + 0.25 on the second tone, y = knife-local z, w = how far round the part 0..1); a skin is three layers, one per
// role (grip, guard, pommel), each a material kind and two colours, uploaded as uniforms:
//   uHiltA[r], uHiltB[r]  the layer's main and second colour (linear)
//   uHiltM[r]             its material kind (HILT_KIND_CODE; 0 = keep the knife's own look for that role)
// One program for every skin (the define only says "a skin is on"), the same GLSL in first and third person and in the
// native renderer (it runs the website's GLSL as is). Without the define nothing here exists, so the knife's own hilt
// (the default) draws exactly as before.
//
// Patterns run in (along, round): knife-local units along the knife and the turn round the part. Anything periodic in
// `round` uses whole turns (or the cylinder mapping hCyl), so the seam where a part's sections close never shows.
// Per detail level (finishes/detail.ts cosLevel): 0 colour patterns and a simple highlight, 1 + relief (wraps, cord,
// nodes, flutes), reflections and clear coats, 2 (first person, Enhanced / Cinematic) + fine grain and the scene in
// the metal.

/** Material kinds (uHiltM). Stable numbers: the native renderer reads them from the exported metadata. */
export const HILT_KIND_CODE = {
  keep: 0,
  enamel: 1,
  polished: 2,
  satin: 3,
  wood: 4,
  leather: 5,
  cord: 6,
  rubber: 7,
  bone: 8,
  carved: 9,
  antler: 10,
  cork: 11,
  stone: 12,
  twine: 13,
  bamboo: 14,
  glass: 15,
  marble: 16,
} as const;
export type HiltKind = keyof typeof HILT_KIND_CODE;

export const HILT_VERTEX_PARS = /* glsl */ `
#ifdef HILT
varying vec4 vHl;
#endif`;

export const HILT_VERTEX_MAIN = /* glsl */ `
#ifdef HILT
  vHl = finishUV;
#endif`;

/** Fragment declarations (after NOISE_GLSL and finishes/detail.ts DETAIL_PARS). */
export const HILT_FRAGMENT_PARS = /* glsl */ `
#ifdef HILT
uniform vec3 uHiltA[3];
uniform vec3 uHiltB[3];
uniform vec3 uHiltM;
varying vec4 vHl;
// Role of this fragment: 1 grip, 2 guard, 3 pommel; 0 = not a hilt part, or a role the skin keeps.
float hiltRole() {
  float p = floor(vHl.z + 0.02);
  if (p < 1.5 || p > 3.5) return 0.0;
  float r = floor(vHl.x + 0.02);
  if (r < 0.5 || r > 3.5) return 0.0;
  float m = r < 1.5 ? uHiltM.x : r < 2.5 ? uHiltM.y : uHiltM.z;
  return m > 0.5 ? r : 0.0;
}
// Pattern-space resolution (units of along / turns round the part per pixel), taken in uniform control flow.
vec2 hFw;
// 1 while a pattern of f cycles per unit is resolved along (or round the part, k = 1), fading out before it would alias.
float hRes(float f, float k) { return 1.0 - smoothstep(0.2, 0.45, (k > 0.5 ? hFw.y : hFw.x) * f); }
// The cylinder mapping: (along, round) -> a plane point that repeats every turn, for noise without a seam.
vec2 hCyl(float along, float rt, float r) {
  float a = rt * 6.2831853;
  return vec2(along + cos(a) * r, sin(a) * r);
}
// Albedo of a hilt fragment (role r, its layer's colours), plus its highlight strength / power, sheen, relief height
// h (units), how metallic it is (1 polished, 0.5 satin) and its clear coat.
vec3 hiltAlbedo(float r, float lv, out float spec, out float pw, out float sheen, out float h, out float metal, out float coat) {
  int i = int(r - 0.5);
  vec3 A = uHiltA[i], B = uHiltB[i];
  float kind = r < 1.5 ? uHiltM.x : r < 2.5 ? uHiltM.y : uHiltM.z;
  float tone = fract(vHl.x + 0.02) > 0.15 ? 1.0 : 0.0;
  float along = vHl.y, rt = vHl.w;
  float relief = lv > 0.5 ? 1.0 : 0.0, fine = lv > 1.5 ? 1.0 : 0.0;
  spec = 0.1; pw = 16.0; sheen = 0.0; h = 0.0; metal = 0.0; coat = 0.0;
  vec3 alb = A;
  if (kind < 3.5) {
    // Enamel / polished / satin metal: one colour per tone (the knife's second tone takes B).
    alb = mix(A, B, tone);
    if (kind < 1.5) { spec = 0.9; pw = 90.0; coat = 0.55; }
    else if (kind < 2.5) { metal = 1.0; }
    else { metal = 0.5; }
    return alb;
  }
  // Patterned materials carry their own two tones; the knife's second tone (ridges, cord diamonds) only darkens a
  // little, so its geometry still reads.
  float dim = 1.0 - 0.12 * tone;
  if (kind < 4.5) {
    // WOOD: straight grain along the handle, gently wavering, darker latewood lines, fine pores.
    vec2 q = hCyl(along * 0.55, rt, 0.42);
    float warp = fbm(q * 1.6 + 3.0);
    float g = 0.5 + 0.5 * sin(rt * 6.2831853 * 9.0 + warp * 5.0 + along * 0.4);
    float late = smoothstep(0.55, 0.95, g) * hRes(9.0, 1.0);
    float pore = gnoise(hCyl(along * 9.0, rt, 2.6) * vec2(1.0, 4.0)) * hRes(9.0, 0.0);
    alb = mix(A, B, late * 0.8 + 0.12 * warp);
    alb *= 0.95 + 0.07 * pore;
    h = fine * 0.0015 * (late - pore * 0.5);
    spec = 0.3; pw = 34.0; coat = 0.12;
  } else if (kind < 5.5) {
    // LEATHER WRAP: a strip wound rt the handle, each turn's edge lapping the next (a shadowed step, B showing in
    // the gap), a pebbled grain.
    float t = fract(along * 1.5 + rt);
    float lap = smoothstep(0.0, 0.1, t);
    float edge = 1.0 - smoothstep(0.0, 0.035, t);
    float pb = gnoise(hCyl(along * 11.0, rt, 1.8)) * hRes(11.0, 0.0);
    alb = mix(B, A, smoothstep(0.0, 0.05, t)) * (0.78 + 0.22 * lap) * (0.95 + 0.08 * pb);
    alb = mix(alb, B, edge * 0.6);
    h = relief * 0.014 * lap * (1.0 - 0.45 * t) + fine * 0.0015 * pb;
    spec = 0.38; pw = 30.0; sheen = 0.08;
  } else if (kind < 6.5) {
    // CORD WRAP: two cords crossing in diamonds (the tsuka's ito), the under-layer B showing in the windows, a fine
    // twist along each cord.
    float a = fract(along * 1.7 + rt * 3.0), b = fract(along * 1.7 - rt * 3.0);
    float ca = smoothstep(0.42, 0.3, abs(a - 0.5)), cb = smoothstep(0.42, 0.3, abs(b - 0.5));
    float cord = max(ca, cb);
    float tw = sin((a + b) * 6.2831853 * 6.0) * hRes(10.0, 0.0);
    alb = mix(B, A, cord) * (0.92 + 0.06 * tw * cord);
    h = relief * 0.012 * cord + fine * 0.0015 * tw * cord;
    spec = 0.07; pw = 10.0; sheen = 0.22;
  } else if (kind < 7.5) {
    // RUBBER GRIP: matte stipple, narrow grooves rt the grip in B.
    vec2 c = vec2(along * 7.0, rt * 28.0);
    c.x += 0.5 * mod(floor(c.y), 2.0);
    float st = smoothstep(0.38, 0.12, length(fract(c) - 0.5)) * hRes(7.0, 0.0);
    float gr = smoothstep(0.42, 0.46, abs(fract(along * 1.1) - 0.5));
    alb = mix(A * (0.95 + 0.07 * st), B, gr * 0.9);
    h = relief * (0.004 * st - 0.01 * gr);
    spec = 0.12; pw = 14.0; sheen = 0.04;
  } else if (kind < 9.5) {
    // BONE (and CARVED BONE): creamy with faint streaks along it and a few dark pores; carved adds spiral flutes.
    float s = gnoise(hCyl(along * 0.6, rt, 1.3) * vec2(1.0, 3.0));
    float pore = step(0.94, fh21(floor(hCyl(along * 16.0, rt, 4.5)))) * hRes(16.0, 0.0);
    alb = mix(A, B, smoothstep(0.0, 0.6, s) * 0.35);
    alb = mix(alb, B * 0.7, pore * 0.5);
    spec = 0.45; pw = 44.0; coat = 0.2;
    if (kind > 8.5) {
      float f = fract(along * 1.8 + rt * 2.0);
      float groove = smoothstep(0.32, 0.5, abs(f - 0.5));
      alb = mix(alb, B * 0.85, groove * 0.65);
      h = -relief * 0.012 * groove;
    }
  } else if (kind < 10.5) {
    // ANTLER: pale and worn smooth on top, ridges and furrows running along it with B down in the furrows, a few
    // small pearl knobs.
    float fur = gnoise(hCyl(along * 0.35, rt, 1.1) * vec2(1.0, 4.0) + 3.0) + 0.4 * gnoise(hCyl(along * 0.9, rt, 2.4) * vec2(1.0, 3.0));
    float knob = smoothstep(0.78, 0.95, fh21(floor(hCyl(along * 5.0, rt, 1.5)))) * hRes(5.0, 0.0);
    float top = smoothstep(-0.35, 0.25, fur);
    alb = mix(B, A, 0.25 + 0.75 * top);
    alb = mix(alb, A * 1.08, knob * 0.5);
    h = relief * (0.009 * fur + 0.004 * knob);
    spec = 0.2; pw = 22.0;
  } else if (kind < 11.5) {
    // CORK: stacked discs (a dark line between each), dense granules in B.
    float d = abs(fract(along * 2.6) - 0.5);
    float line = smoothstep(0.47, 0.5, d);
    vec2 g = hCyl(along * 26.0, rt, 7.5);
    float gr = fh21(floor(g));
    float sp = smoothstep(0.55, 0.85, gr) * hRes(26.0, 0.0);
    alb = mix(A, B, sp * 0.55 + 0.06 * gnoise(g * 0.2));
    alb = mix(alb, B * 0.6, line * hRes(2.6, 0.0));
    h = fine * 0.003 * (sp - 0.5) - relief * 0.006 * line;
    spec = 0.03; pw = 8.0; sheen = 0.06;
  } else if (kind < 12.5) {
    // STONE: banded agate, polished: broad A and B bands that wander round the part, a thin pale line between them,
    // a deep gloss.
    vec2 q = hCyl(along * 0.3, rt, 0.45);
    float s = along * 0.45 + fbm(q * 1.4 + 5.0) * 1.6 + 0.5 * fbm(q * 3.1 + 9.0);
    float band = 0.5 + 0.5 * sin(s * 3.2);
    float seam = 1.0 - smoothstep(0.0, 0.07, abs(band - 0.5));
    alb = mix(A, B, smoothstep(0.35, 0.65, band));
    alb = mix(alb, vec3(0.9, 0.93, 0.95), seam * 0.5 * hRes(3.0, 0.0));
    spec = 1.0; pw = 100.0; coat = 0.6;
  } else if (kind < 13.5) {
    // GARDEN TWINE: a thin cord wound tight, B in the grooves between the turns, loose fibres.
    float t = fract(along * 4.4 + rt);
    float turn = sin(t * 3.14159);
    float fb = gnoise(hCyl(along * 22.0, rt, 3.0) * vec2(3.0, 1.0)) * hRes(22.0, 0.0);
    alb = mix(B, A, smoothstep(0.0, 0.55, turn)) * (0.93 + 0.1 * fb);
    h = relief * 0.007 * turn * hRes(4.4, 0.0) + fine * 0.0015 * fb;
    spec = 0.02; pw = 6.0; sheen = 0.32;
  } else if (kind < 14.5) {
    // BAMBOO: a node every 1.3 units (a raised ring in B), fine streaks between, a waxy sheen.
    float d = abs(fract(along / 1.3 + 0.5) - 0.5) * 1.3;
    float node = 1.0 - smoothstep(0.03, 0.08, d);
    float st = gnoise(hCyl(along * 0.8, rt, 2.2) * vec2(1.0, 6.0)) * hRes(8.0, 1.0);
    alb = mix(A * (0.95 + 0.08 * st), B, node * 0.85);
    alb *= 1.0 - 0.1 * smoothstep(0.08, 0.3, d) * (1.0 - smoothstep(0.3, 0.6, d));
    h = relief * 0.012 * node;
    spec = 0.42; pw = 36.0; coat = 0.15;
  } else if (kind > 15.5) {
    // MARBLE: A with soft clouding and thin wandering B veins, polished.
    vec2 q = hCyl(along * 0.4, rt, 0.5);
    float w = fbm(q * 1.2 + 2.0) * 2.2 + 0.6 * fbm(q * 3.4 + 7.0);
    float vein = 1.0 - smoothstep(0.0, 0.16, abs(sin(along * 0.9 + w * 2.4)));
    float vein2 = (1.0 - smoothstep(0.0, 0.08, abs(sin(along * 1.7 - w * 3.1 + 1.0)))) * 0.6;
    alb = A * (0.96 + 0.06 * fbm(q * 2.0));
    alb = mix(alb, B, max(vein, vein2) * 0.85 * hRes(1.0, 0.0));
    spec = 1.0; pw = 110.0; coat = 0.6;
  } else {
    // SEA GLASS: frosted, cloudy, lighter toward its edges (the light inside it), a soft broad shine.
    float c = fbm(hCyl(along * 0.8, rt, 0.7) * 1.7 + 2.0);
    alb = mix(A, B, smoothstep(-0.3, 0.45, c) * 0.6);
    float fr = gnoise(hCyl(along * 30.0, rt, 8.0)) * hRes(30.0, 0.0);
    h = fine * 0.0012 * fr;
    spec = 0.55; pw = 22.0; sheen = 0.35; coat = 0.25;
  }
  return alb * dim;
}
// Light on top of the toon shade (n front-facing, V to the eye, L key light): metal replaces the shade with its
// reflection (like knives' polished / satin hardware, finishes/detail.ts knifeShade), the rest add a highlight, a sheen
// and their clear coat.
vec3 hiltShade(vec3 col, vec3 alb, float lv, vec3 n, vec3 V, vec3 L, vec3 ambient, float key, float spec, float pw, float sheen, float metal, float coat) {
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
  if (coat > 0.0 && lv > 0.5) c += cosReflect(R, 0.03, lv) * coat * (0.04 + 0.96 * fc) * 0.5;
  return c;
}
#endif`;

/** Fragment: albedo hook, after the glove one (`albedo` starts as vColor; relief re-lights n / key / ambient). */
export const HILT_FRAGMENT_ALBEDO = /* glsl */ `
#ifdef HILT
  float hR = hiltRole();
  float hLv = cosLevel();
  float hSpec = 0.0, hPow = 16.0, hSheen = 0.0, hH = 0.0, hMetal = 0.0, hCoat = 0.0;
  hFw = fwidth(vHl.yw);
  if (hR > 0.5) albedo = hiltAlbedo(hR, hLv, hSpec, hPow, hSheen, hH, hMetal, hCoat);
  if (hLv > 0.5) {
    vec3 hn = cosBump(n, hH);
    if (hR > 0.5 && hH != 0.0) {
      n = hn;
      ndl = dot(n, L);
      key = smoothstep(-0.05, 0.55, ndl);
      ambient = mix(ground, sky, n.y * 0.5 + 0.5) * 0.62;
    }
  }
#endif`;

/** Fragment: lighting hook (after the glove one). */
export const HILT_FRAGMENT_LIGHT = /* glsl */ `
#ifdef HILT
  if (hR > 0.5) col = hiltShade(col, albedo, hLv, n, V, L, ambient, key, hSpec, hPow, hSheen, hMetal, hCoat);
#endif`;
