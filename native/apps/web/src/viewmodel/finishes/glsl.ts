// GLSL helpers for the procedural blade finishes (shader.ts, compiled into the player solid material only when a finish
// is equipped): hash, 2D gradient noise and fbm. Deterministic, no textures. FINISH_LOD (phones) uses 3 octaves.

export const NOISE_GLSL = /* glsl */ `
vec2 fh22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}
float fh21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dot(fh22(i), f), dot(fh22(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
             mix(dot(fh22(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), dot(fh22(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x), u.y);
}
#ifdef FINISH_LOD
#define FBM_OCTAVES 3
#else
#define FBM_OCTAVES 5
#endif
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < FBM_OCTAVES; i++) { s += a * gnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= 0.5; }
  return s; // ~[-0.6, 0.6]
}
/** 3 octaves: low-frequency masks (glove grime, broad finish tints). */
float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * gnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= 0.5; }
  return s;
}
`;
