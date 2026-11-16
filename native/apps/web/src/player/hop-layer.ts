// Draws hop effects (player/hop-fx.ts has the recipes): one HopLayer per scene, one instanced draw call for every burst
// in it. The particles live in a fixed ring of HOP_POOL records (the oldest is overwritten), written once when a burst
// spawns; the GPU works out where each one is from its age, so nothing is touched per frame but a small array of clocks.
//
// Clocks: each emitter (a PlayerModel with hop effects on: player/model.ts) has a slot in its scene's layer and writes
// its own clock there every update (the bunny's visual time). A replay paused, slowed or seeked holds, slows or jumps
// its bursts with it, and an export renders them on its own clock.
//
// The layer's mesh is in the scene only while something in it is alive: with nothing hopping it draws nothing.

import * as THREE from "three";
import type { GroundProbe } from "./bunny/legs";
import { HOP_FRAME_CAP, HOP_GAP, hopSeed, linearRgb, spawnHop, type HopFxDef, type HopSpawn } from "./hop-fx";

/** Particles per layer (a full server of 16 hopping at once needs about a third of it). */
export const HOP_POOL = 1024;
/** Emitters per layer (players, ghosts, your own bunny). */
export const HOP_SLOTS = 32;

const VERTEX = /* glsl */ `
uniform float uClock[${HOP_SLOTS}];
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
attribute vec4 iD;
attribute vec4 iE;
attribute vec4 iF;
attribute vec4 iG;
attribute vec4 iH;
attribute vec4 iI;
attribute vec4 iJ;
attribute vec4 iK;
attribute vec4 iL;
attribute vec4 iM;
// uv, and a flip / tumble's turn (cos, sin)
varying vec4 vUv;
// its colour + opacity; colour at death + glow; heat left, how far on to the second colour, softness, flicker
varying vec4 vC1;
varying vec4 vC2;
varying vec4 vK;
// shape, param, share of its life gone, how far into its exit
varying vec4 vS;
// height over width as drawn, seed, offset from the hop on the ground (x, z)
varying vec4 vQ;
varying vec4 vReachA;
varying vec4 vReachB;
// its age (s), and how high over the hop's floor this point of it is (in its half sizes; pieces that face the camera)
varying vec2 vAge;

mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

void main() {
  float age = uClock[int(iG.x + 0.5)] - iA.w;
  float life = iB.w;
  if (age < 0.0 || age >= life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float u = age / life;
  float seed = iG.y;
  float k = max(iC.w, 1e-3);
  vec3 g = vec3(0.0, -iC.z, 0.0);
  float e = exp(-k * age);
  vec3 vel = g / k + (iB.xyz - g / k) * e;
  vec3 p = iA.xyz + g * (age / k) + (iB.xyz - g / k) * ((1.0 - e) / k);
  // iF.x: shape + 32 × orient + 256 × exit.
  int code = int(iF.x + 0.5);
  int shape = code % 32, orient = (code / 32) % 8, ex = code / 256;
  // Flutter: a sway to one side and back (its own direction per piece; standing pieces carry theirs), growing in over
  // the first quarter.
  float ph = iM.w * age + seed * 6.2832;
  float sa = orient == 4 ? iF.w : seed * 40.0;
  p.xz += vec2(cos(sa), sin(sa)) * (iM.z * sin(ph) * smoothstep(0.0, 0.25, u));
  float size = mix(iC.x, iC.y, 1.0 - pow(1.0 - u, iJ.w));
  // There at once at iJ.x of its size, past full at iJ.z seconds, then settled.
  float x = age / iJ.z;
  float pop = 1.0 - (1.0 - iJ.x) * exp(-iJ.y * x) * cos(3.14159265 * x);
  float gone = smoothstep(iG.w, 1.0, u);
  float shrink = ex >= 1 ? 1.0 - gone * gone : 1.0;
  float a = iD.a * (ex == 1 ? 1.0 : 1.0 - gone);
  vec2 c = position.xy;
  // The layer's own space is the scene's, or an item preview's turned and scaled pivot: camera-facing offsets take its scale.
  float ms = length(modelViewMatrix[0].xyz);
  float aspect = iM.x;
  vec2 flip = vec2(1.0, 0.0);
  vec2 off = vec2(0.0);
  vec4 mv;
  vReachA = vec4(-1.0);
  vReachB = vec4(-1.0);
  float height = 100.0;
  if (orient == 1) {
    // On the ground, tilted to its slope; cut where the floor ends (the fragment shader, from its offset to the hop).
    vec2 o = rot2(iF.z + iF.w * age) * (c * vec2(1.0, aspect)) * (size * pop * shrink);
    vec3 w = p + vec3(o.x, 0.0, o.y);
    off = w.xz - iK.xy;
    w.y += dot(off, iK.zw);
    mv = modelViewMatrix * vec4(w, 1.0);
    vReachA = iH;
    vReachB = iI;
  } else if (orient == 4) {
    // Standing: turned to the camera about the vertical, growing from its base. Pieces to the side lean outward.
    vec3 upV = (modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
    vec3 right = normalize(cross(upV, vec3(0.0, 0.0, 1.0)) + vec3(1e-5, 0.0, 0.0)) * ms;
    float lean = clamp(iF.z * dot((modelViewMatrix * vec4(p.x - iK.x, 0.0, p.z - iK.y, 0.0)).xyz, right) / (ms * ms), -1.2, 1.2);
    float hs = pop * shrink;
    // A little squash and stretch: wider while it's short.
    float ws = 1.0 + 0.22 * clamp(1.0 - pop, -1.0, 1.0);
    vec2 l = rot2(-lean) * vec2(c.x * size * ws, (c.y + 1.0) * size * aspect * hs);
    mv = modelViewMatrix * vec4(p, 1.0);
    mv.xyz += right * l.x + upV * l.y;
    aspect *= hs / ws;
  } else {
    mv = modelViewMatrix * vec4(p, 1.0);
    float sz = size * pop * shrink * ms;
    float rock = iF.y * sin(ph);
    vec2 o;
    if (orient == 2) {
      // Along its motion on screen (+u is the way it's going), stretched by its speed.
      vec2 d = (modelViewMatrix * vec4(vel, 0.0)).xy / ms;
      float l = length(d);
      vec2 ax = l > 1e-3 ? d / l : vec2(0.0, 1.0);
      float len = sz * (aspect + l * iG.z);
      o = ax * c.x * len + vec2(-ax.y, ax.x) * c.y * sz;
      aspect = len / max(sz, 1e-4);
    } else if (orient == 3) {
      float fa = iF.w * age + seed * 6.2832;
      flip = vec2(cos(fa), sin(fa));
      float sq = max(abs(flip.x), 0.32);
      o = rot2(iF.z + iM.y * age + rock) * vec2(c.x * sz * sq, c.y * sz * aspect);
    } else {
      o = rot2(iF.z + iF.w * age + rock) * vec2(c.x * sz, c.y * sz * aspect);
    }
    mv.xy += o;
    // Facing the camera: iG.z is how high over the floor it was born (hop-fx.ts), so the floor is that far under its
    // birth, and this corner is so far over it. Soft pieces thin out there instead of being cut off by the ground.
    // (In its own half sizes.)
    if (orient != 2) height = (p.y - (iA.y - iG.z) + dot(vec3(o, 0.0), (modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz) / (ms * ms)) / max(sz / ms, 0.01);
  }
  gl_Position = projectionMatrix * mv;
  float dist = -mv.z;
  // Gone in the distance (sub-pixel specks shimmer) and right in front of the eye (it would cover the view).
  a *= (1.0 - smoothstep(1800.0, 2600.0, dist)) * smoothstep(6.0, 24.0, dist);
  vUv = vec4(c, flip);
  vC1 = vec4(iD.rgb, a);
  vC2 = iE;
  // White-hot at birth, cooled to its colour by iL.y of its life, then on to its second colour.
  vK = vec4(iL.x * (1.0 - smoothstep(0.0, iL.y, u)), smoothstep(iL.y, 1.0, u), iL.z, iL.w);
  vS = vec4(float(shape), iG.z, u, gone);
  vQ = vec4(aspect, seed, off);
  vAge = vec2(age, height);
}
`;

const FRAGMENT = /* glsl */ `
varying vec4 vUv;
varying vec4 vC1;
varying vec4 vC2;
varying vec4 vK;
varying vec4 vS;
varying vec4 vQ;
varying vec4 vReachA;
varying vec4 vReachB;
varying vec2 vAge;

const vec3 HOT = vec3(1.0, 0.96, 0.88);

mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float aa(float d) { float w = fwidth(d) * 0.75 + 1e-5; return 1.0 - smoothstep(-w, w, d); }
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Three octaves, each turned against the last (value noise alone gives square lumps along its grid).
float fbm(vec2 p) {
  const mat2 turn = mat2(0.8, 0.6, -0.6, 0.8);
  float n = 0.5 * vnoise(p);
  p = turn * p * 2.07 + 7.3;
  n += 0.31 * vnoise(p);
  p = turn * p * 2.11 + 1.7;
  return n + 0.19 * vnoise(p);
}
// A teardrop: the hull of a circle r1 at the origin and a circle r2 at (0, h) (Inigo Quilez's uneven capsule).
float sdDrop(vec2 p, float r1, float r2, float h) {
  p.x = abs(p.x);
  float b = (r1 - r2) / h;
  float a = sqrt(1.0 - b * b);
  float k = dot(p, vec2(-b, a));
  if (k < 0.0) return length(p) - r1;
  if (k > a * h) return length(p - vec2(0.0, h)) - r2;
  return dot(p, vec2(a, b)) - r1;
}
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

void main() {
  vec2 p = vUv.xy;
  int shape = int(vS.x + 0.5);
  float param = vS.y, u = vS.z, gone = vS.w;
  float asp = vQ.x, seed = vQ.y;
  float heat = vK.x, soft = vK.z;
  // Its colour, on to its second colour once it has cooled, and darker with that by its char (vK.w: flicker + 100 × char).
  float flicker = fract(vK.w), char = floor(vK.w) * 0.01;
  vec3 base = mix(vC1.rgb, vC2.rgb, vK.y) * (1.0 - char * vK.y);
  float r = length(p);
  // Coverage, where the heat sits (its core), brightness, and a white highlight of its own (a glint of light on it).
  float a = 0.0;
  float core = 0.0;
  float lum = 1.0;
  float spec = 0.0;
  // Soft pieces thin out into the ground they stand in.
  float ground = smoothstep(0.0, 0.6, vAge.y);
  if (shape == 0) {
    // glow: a disc of light, from hard-edged (a mote) to all falloff (a flash, which thins out into the ground); embers
    // flicker
    float e = max(soft, fwidth(r) * 1.5);
    a = smoothstep(1.0, 1.0 - e, r);
    a *= mix(1.0, a, soft);
    a *= 1.0 - flicker * (0.5 + 0.5 * sin(vAge.x * 43.0 + seed * 60.0));
    a *= mix(1.0, smoothstep(-0.25, 0.3, vAge.y), step(0.8, soft));
    core = 1.0 - smoothstep(0.0, 0.75, r);
  } else if (shape == 1) {
    // ring: a shock ring. A sharp front at its rim, hot there, falling off inward behind it; param thick at birth and
    // thinning as it opens, breaking up a little as it goes.
    float w = max(param * mix(1.0, 0.2, 1.0 - (1.0 - u) * (1.0 - u)), fwidth(r) * 1.4);
    float x = (0.97 - r) / w;
    a = smoothstep(0.0, max(0.14, fwidth(r) / w), x) * pow(1.0 - clamp(x, 0.0, 1.0), 1.5);
    a *= 0.72 + 0.28 * mix(1.0, vnoise(vec2(atan(p.y, p.x) * 3.2 + seed * 9.0, seed * 5.0)) * 1.6, u);
    core = 1.0 - smoothstep(0.0, 0.45, x);
  } else if (shape == 2) {
    // puff: a billow of dust or mist. Noise gives it its lumps and its light and shade; it goes by wearing away where
    // it is thinnest.
    vec2 q = rot2(seed * 6.2832) * p * 1.7 + seed * vec2(17.0, 9.0);
    q += 0.45 * vec2(vnoise(q * 1.3 + 3.1), vnoise(q * 1.3 + 9.7)) - vec2(0.0, vAge.x * 0.9);
    float n = fbm(q);
    float dens = (1.0 - r * r) * (0.36 + 1.1 * n);
    float th = mix(0.12, 0.8, gone);
    a = smoothstep(th, th + 0.24, dens) * smoothstep(1.0, 0.7, r) * ground;
    lum = 0.62 + 0.62 * n + 0.16 * p.y;
    core = 0.3;
  } else if (shape == 3) {
    // streak: a spark along its flight (+u ahead). Bright and full at the head, drawn out to nothing behind.
    float t = p.x * 0.5 + 0.5;
    float w = mix(0.22, 1.0, smoothstep(0.0, 0.85, t)) * sqrt(max(0.0, 1.0 - pow(max(0.0, (p.x - 0.6) / 0.4), 2.0)));
    float y = abs(p.y) / max(w, 0.02);
    a = (1.0 - smoothstep(0.4, 1.0, y)) * pow(t, 1.3);
    core = (1.0 - smoothstep(0.0, 0.7, y)) * smoothstep(0.3, 0.9, t);
  } else if (shape == 4) {
    // fleck: a sliver with four edges. Turning over (flip), it is lit by how squarely it faces you and flashes white
    // face on; standing (a crystal), it runs from its second colour at the root to its first at the tip, one side
    // lit, and a gleam travels up it once.
    float d = abs(p.x) / 0.56 + abs(p.y) / 0.97 - 1.0;
    a = aa(d * 0.5);
    if (vUv.w == 0.0 && vUv.z == 1.0) {
      float yn = p.y * 0.5 + 0.5;
      base = mix(vC2.rgb, vC1.rgb, smoothstep(0.05, 0.85, yn));
      lum = p.x < 0.06 ? 1.05 : 0.6;
      float g = p.y - (vAge.x * 9.0 - 1.4);
      spec = 0.8 * exp(-g * g * 9.0) + 0.4 * (1.0 - smoothstep(0.0, 0.08, abs(p.x - 0.06)));
      core = smoothstep(0.3, 1.0, yn);
    } else {
      float c = abs(vUv.z);
      lum = 0.36 + 0.7 * c + (p.x < 0.0 ? 0.1 : -0.08);
      spec = 0.7 * pow(c, 16.0);
      core = c * c;
    }
  } else if (shape == 5) {
    // glint: a four-point sparkle of light with a soft heart
    vec2 q = abs(p);
    q = vec2(max(q.x, q.y), min(q.x, q.y));
    vec2 ga = vec2(0.96, 0.0), gb = vec2(0.11, 0.11);
    float d = sdSeg(q, ga, gb) * -sign((gb.x - ga.x) * (q.y - ga.y) - (gb.y - ga.y) * (q.x - ga.x));
    a = max(aa(d), 0.55 * exp(-r * r * 9.0));
    core = 1.0;
    heat = max(heat, 0.6);
  } else if (shape == 6) {
    // bolt: a crackle of static along its length (u), re-drawn every few hundredths of a second, with a fork; a thin
    // white line in a glow
    float f = floor(vAge.x / 0.035) + seed * 37.0;
    float env = smoothstep(-1.0, -0.72, p.x) * (1.0 - smoothstep(0.7, 1.0, p.x));
    float y0 = ((vnoise(vec2(p.x * 3.1 + f * 13.7, f)) - 0.5) * 1.3 + (vnoise(vec2(p.x * 8.3 - f * 5.1, f + 3.0)) - 0.5) * 0.5) * env;
    float y1 = y0 + (vnoise(vec2(p.x * 4.7 + f * 7.9, f + 9.0)) - 0.35) * 1.1 * smoothstep(-0.1, 0.7, p.x);
    float d0 = abs(p.y - y0) * asp, d1 = abs(p.y - y1) * asp;
    float line = max(1.0 - smoothstep(0.02, 0.085, d0), 0.6 * (1.0 - smoothstep(0.015, 0.06, d1)) * step(0.0, p.x));
    float on = env * step(0.22, hash21(vec2(f, seed * 91.0)));
    a = max(line, 0.5 * exp(-d0 * d0 * 26.0)) * on;
    core = line;
    heat = max(heat, 0.5 * line);
  } else if (shape == 7) {
    // ray: one ray of an aurora, standing. Nearly white at the foot, its first colour above that, its second over the
    // top half as it thins out, each ray to its own height; soft at the sides, so a row of them melts into one ribbon
    // with its rays showing.
    float H = 2.0 * asp * (0.5 + 0.5 * fract(seed * 7.31 + 0.37));
    vec2 q = vec2(p.x, (p.y + 1.0) * asp);
    float yn = clamp(q.y / H, 0.0, 1.0);
    float across = pow(cos(min(abs(p.x), 1.0) * 1.5707963), 1.5);
    a = clamp((1.0 - smoothstep(0.3, 1.0, yn)) * across * 1.7, 0.0, 1.0) * smoothstep(0.0, 0.5, q.y + across * 0.5 - 0.25);
    a *= 0.82 + 0.18 * sin(yn * 9.0 - vAge.x * 11.0 + seed * 25.0);
    base = mix(vC1.rgb, vC2.rgb, smoothstep(0.2, 0.6, yn));
    core = 0.0;
    spec = 0.8 * (1.0 - smoothstep(0.0, 0.2, yn)) * across;
  } else if (shape == 8) {
    // drop: a droplet along its flight (+u ahead): a round head, a short tail, darker at its rim, the light on it
    vec2 q = vec2(p.x * asp, p.y);
    float h = max(2.0 * asp - 0.8, 0.1);
    float d = sdDrop(vec2(q.y, q.x + asp - 0.1), 0.06, 0.66, h);
    a = aa(d) * 0.9;
    lum = mix(0.62, 1.05, smoothstep(0.0, -0.4, d));
    spec = 0.95 * (1.0 - smoothstep(0.08, 0.26, length(q - vec2(asp - 0.86, 0.22))));
  } else if (shape == 9) {
    // petal: round, narrower at the base, a nick in its tip. Lit by how squarely it faces you; its back is paler.
    float d = sdDrop(p - vec2(0.0, -0.62), 0.26, 0.62, 0.9);
    d = max(d, -(length(p - vec2(0.0, 1.0)) - 0.17));
    a = aa(d);
    float c = abs(vUv.z);
    lum = 0.62 + 0.42 * c + 0.1 * p.y;
    spec = (vUv.z < 0.0 ? 0.16 : 0.0) + 0.2 * pow(c, 9.0);
    core = c;
  } else {
    // chunk: a rough-cut bit, lit from the upper left, darker underneath
    float d = length(max(abs(p) - vec2(0.44, 0.36), 0.0)) - 0.34 + (vnoise(p * 2.2 + seed * 23.0) - 0.5) * 0.2;
    a = aa(d);
    lum = 0.66 + 0.5 * smoothstep(0.7, -0.7, p.x - p.y);
    spec = 0.4 * (1.0 - smoothstep(0.0, 0.34, length(p - vec2(-0.24, 0.26))));
    core = 0.6;
  }
  if (vReachA.x >= 0.0) {
    // On the ground: gone past the edge of the floor the hop was on. The floor's outline is the polygon through its reach
    // in eight directions (Source angles; the three.js offset (x, z) is Source (x, -z)): a straight edge is cut straight.
    vec2 o = vec2(vQ.z, -vQ.w);
    float f = mod(atan(o.y, o.x) / 0.7853982 + 8.0, 8.0);
    int k = int(floor(f)) % 8;
    float rr[8] = float[8](vReachA.x, vReachA.y, vReachA.z, vReachA.w, vReachB.x, vReachB.y, vReachB.z, vReachB.w);
    float a0 = float(k) * 0.7853982, a1 = a0 + 0.7853982;
    vec2 p0 = rr[k] * vec2(cos(a0), sin(a0)), p1 = rr[(k + 1) % 8] * vec2(cos(a1), sin(a1));
    vec2 e = p1 - p0;
    float inside = (e.x * (o.y - p0.y) - e.y * (o.x - p0.x)) / max(length(e), 1e-4);
    a *= smoothstep(0.0, 0.9, inside);
  }
  a = clamp(a, 0.0, 1.0) * vC1.a;
  if (a < 0.003) discard;
  vec3 col = mix(base * lum, HOT, clamp(heat * (0.3 + 0.7 * core), 0.0, 1.0));
  col = mix(col, vec3(1.0), clamp(spec, 0.0, 1.0));
  #ifdef TONE_MAPPING
  col = toneMapping(col);
  #endif
  col = linearToOutputTexel(vec4(col, 1.0)).rgb;
  // Premultiplied: glow 1 adds light (alpha 0), glow 0 is a plain blend. Flat (a picture on a transparent backdrop, the
  // Loadout's tiles): plain blending only, so the light isn't lost with the backdrop.
  #ifdef HOP_FLAT
  gl_FragColor = vec4(col * a, a);
  #else
  gl_FragColor = vec4(col * a, a * (1.0 - vC2.a));
  #endif
}
`;

const ATTRS = ["iA", "iB", "iC", "iD", "iE", "iF", "iG", "iH", "iI", "iJ", "iK", "iL", "iM"] as const;

/** One scene's hop effects: the particle pool, its mesh and the emitters' clocks. */
export class HopLayer {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.InstancedBufferGeometry();
  private attrs: THREE.InstancedBufferAttribute[];
  private data: Float32Array[];
  private clocks = new Float32Array(HOP_SLOTS);
  private used = new Uint8Array(HOP_SLOTS);
  /** Per slot: the clock at which its last particle dies. */
  private until = new Float64Array(HOP_SLOTS).fill(-Infinity);
  private next = 0;
  /** Bursts spawned since the layer was last drawn (HOP_FRAME_CAP). */
  private frameBursts = 0;
  /** Particles written since the layer was made (tests and the perf probe). */
  written = 0;

  /** `host`: what the mesh goes under (a scene, or an item preview's pivot); `flat`: see HOP_FLAT in the shader. */
  constructor(host: THREE.Object3D | null = null, flat = false) {
    const quad = new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]);
    this.geo.setAttribute("position", new THREE.BufferAttribute(quad, 3));
    this.geo.setIndex([0, 1, 2, 2, 1, 3]);
    this.data = ATTRS.map(() => new Float32Array(HOP_POOL * 4));
    this.attrs = ATTRS.map((name, i) => {
      const a = new THREE.InstancedBufferAttribute(this.data[i], 4).setUsage(THREE.DynamicDrawUsage);
      this.geo.setAttribute(name, a);
      return a;
    });
    // Every record starts dead (life 0).
    this.geo.instanceCount = HOP_POOL;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uClock: { value: this.clocks } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
      // Pieces lying on the ground win against it at any distance.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      defines: flat ? { HOP_FLAT: 1 } : {},
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.name = "hop-fx";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 31;
    this.mesh.visible = false;
    this.mesh.onBeforeRender = () => this.drawn();
    host?.add(this.mesh);
  }

  /** A clock slot for an emitter (null: all taken). */
  claim(): number | null {
    const i = this.used.indexOf(0);
    if (i < 0) return null;
    this.used[i] = 1;
    this.until[i] = -Infinity;
    return i;
  }

  /** Gives a slot back; its particles die at once (the next owner's clock means nothing to them). */
  release(slot: number): void {
    if (!this.used[slot]) return;
    this.used[slot] = 0;
    this.until[slot] = -Infinity;
    const A = this.data[0], B = this.data[1], G = this.data[6];
    let lo = HOP_POOL, hi = -1;
    for (let i = 0; i < HOP_POOL; i++)
      if (B[i * 4 + 3] > 0 && G[i * 4] === slot) {
        B[i * 4 + 3] = 0;
        A[i * 4 + 3] = 0;
        lo = Math.min(lo, i);
        hi = Math.max(hi, i);
      }
    if (hi >= 0) for (const a of [this.attrs[0], this.attrs[1]]) this.mark(a, lo, hi - lo + 1);
    this.syncVisible();
  }

  /** An emitter's clock now (seconds; any origin, but steady for that emitter). */
  setClock(slot: number, t: number): void {
    this.clocks[slot] = t;
    if (this.until[slot] > -Infinity && t > this.until[slot]) this.until[slot] = -Infinity;
    this.syncVisible();
  }

  /**
   * The layer was drawn (the mesh's onBeforeRender): a frame went by, the next HOP_FRAME_CAP bursts may start. Counted in
   * real draws, not time: a scene that isn't being drawn stops taking bursts after HOP_FRAME_CAP of them.
   */
  drawn(): void {
    this.frameBursts = 0;
  }

  /** Spawns a burst of `def` (see HopSpawn); false when the frame's cap is reached. */
  burst(def: HopFxDef, s: HopSpawn): boolean {
    if (!this.used[s.slot] || this.frameBursts >= HOP_FRAME_CAP) return false;
    this.frameBursts++;
    const start = this.next;
    let last = s.t;
    const n = spawnHop(def, s, hopSeed(s.x, s.z, s.t), (r) => {
      const i = this.next;
      for (let a = 0; a < ATTRS.length; a++) {
        const d = this.data[a];
        for (let k = 0; k < 4; k++) d[i * 4 + k] = r[a * 4 + k];
      }
      last = Math.max(last, r[3] + r[7]);
      this.next = (i + 1) % HOP_POOL;
    });
    this.written += n;
    // The ring may wrap: upload the stretch written, in one or two ranges.
    const end = start + n;
    for (const a of this.attrs) {
      if (end <= HOP_POOL) this.mark(a, start, n);
      else {
        this.mark(a, start, HOP_POOL - start);
        this.mark(a, 0, end - HOP_POOL);
      }
    }
    this.until[s.slot] = Math.max(this.until[s.slot], last);
    this.syncVisible();
    return true;
  }

  private mark(a: THREE.InstancedBufferAttribute, from: number, count: number): void {
    // Ranges pile up while nothing draws the layer (a scene that isn't rendered): past a few, upload it all once.
    if (a.updateRanges.length >= 24) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, HOP_POOL * 4);
    } else if (!(a.updateRanges.length === 1 && a.updateRanges[0].count === HOP_POOL * 4)) a.addUpdateRange(from * 4, count * 4);
    a.needsUpdate = true;
  }

  private syncVisible(): void {
    let alive = false;
    for (let i = 0; i < HOP_SLOTS && !alive; i++) alive = this.until[i] > this.clocks[i];
    this.mesh.visible = alive;
  }

  /** Every burst gone (a map change, a seek). */
  clear(): void {
    this.data[1].fill(0);
    this.attrs[1].clearUpdateRanges();
    this.attrs[1].needsUpdate = true;
    this.until.fill(-Infinity);
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// One layer per scene, made the first time something in it hops.

const layers = new WeakMap<THREE.Object3D, HopLayer>();

/** The top of `o`'s tree when that's a scene (models not in one draw no bursts). */
function sceneOf(o: THREE.Object3D): THREE.Scene | null {
  let p = o;
  while (p.parent) p = p.parent;
  return (p as THREE.Scene).isScene ? (p as THREE.Scene) : null;
}

/** The scene's layer (made on first use). */
export function hopLayerFor(scene: THREE.Scene): HopLayer {
  let l = layers.get(scene);
  if (!l) layers.set(scene, (l = new HopLayer(scene)));
  return l;
}

const visibleChain = (o: THREE.Object3D): boolean => {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
};

/** Graphics: particle count scale (Potato halves it) and motion scale (reduced motion: a third). Set by main.ts. */
export const hopQuality = { count: 1, motion: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.35 : 1 };

/** What a PlayerModel's emitter needs from its bunny each update. */
export interface HopSource {
  /** The bunny's visual clock (seconds). */
  readonly clock: number;
  /** A jump happened on the last update. */
  readonly jumpedLast: boolean;
}

const _v = new THREE.Vector3();
/**
 * The floor round a hop is checked this far out in eight directions, a step at a time (nothing in hop-fx.ts lies further
 * from the feet than the last step), then the step where it ends is halved REACH_REFINE times: the edge to 1.5 units.
 */
export const REACH_STEP = 12;
export const REACH_STEPS = 4;
export const REACH_REFINE = 3;
/** A direction whose floor never ends reads as this far (the cut's outline joins it to its neighbours). */
export const REACH_FAR = 2 * REACH_STEP * REACH_STEPS;
/** A jump's vertical speed as it leaves the ground and gravity (u/s, u/s²), and the furthest back a hop is traced (s). */
const TAKEOFF_VZ = 298;
const GRAVITY = 800;
const HOP_BACK = 0.05;
/** The ground under the takeoff counts as its floor when it is within this of the takeoff's height (units). */
const TAKEOFF_TOL = 6;
/** A hop at a floor's edge is moved in until it has this much floor behind it (units; the hull overhangs by up to 16). */
const HOP_MARGIN = 12;
/** How far out the floor is looked for round a hop that isn't over it (units; the first is the reach already measured). */
const SETTLE_RADII = [REACH_STEP, 20, 28] as const;
/** The floor counts as the hop's while it is within this of where the slope puts it (units). */
const REACH_TOL = 4;
/** Slopes steeper than this (rise over run) aren't followed: the pieces lie level. */
const SLOPE_MAX = 1;

/**
 * One player's hop effect (owned by its PlayerModel): watches the poses for ground contact and the bunny for jumps, and
 * spawns bursts into its scene's layer at the feet.
 */
export class HopEmitter {
  private def: HopFxDef | null = null;
  private tint: [number, number, number] = [1, 1, 1];
  private tint2: [number, number, number] = [1, 1, 1];
  private layer: HopLayer | null = null;
  private slot = -1;
  private groundAt = -Infinity;
  private groundZ = 0;
  private lastBurst = -Infinity;
  /** The effect has pieces on the ground (the floor round the hop is probed for them). */
  private onGround = false;
  /** Overall opacity (a ghost's). */
  alpha = 1;
  /** The ground under a point (PlayerModel.setGroundProbe): how far a ring may spread. Null: flat everywhere. */
  probe: GroundProbe | null = null;

  /** The effect and the trail colours it takes ("#rrggbb"; null: off). */
  set(def: HopFxDef | null, tint: string, tint2: string): void {
    this.def = def;
    this.onGround = !!def?.parts.some((p) => p.orient === "floor" || p.orient === "up");
    linearRgb(tint, this.tint);
    linearRgb(tint2, this.tint2);
    if (!def) this.detach();
  }

  get on(): boolean {
    return !!this.def;
  }

  /**
   * After the bunny's update: `pose` is the pose it was given (Source units), `root` the model's root (its parent's space
   * is what the bursts are placed in), `allowed` whether bursts show now (settings, visibility).
   */
  update(src: HopSource, pose: { position: ArrayLike<number>; velocity?: ArrayLike<number>; grounded: boolean }, root: THREE.Object3D, allowed: boolean): void {
    const t = src.clock;
    if (pose.grounded) {
      this.groundAt = t;
      this.groundZ = pose.position[2];
    }
    if (this.layer) this.layer.setClock(this.slot, t);
    if (t < this.lastBurst) this.lastBurst = -Infinity;
    if (!src.jumpedLast || !this.def || !allowed || t - this.lastBurst < HOP_GAP || !visibleChain(root)) return;
    const scene = sceneOf(root);
    if (!scene) return;
    if (!this.attach(hopLayerFor(scene))) return;
    this.layer!.setClock(this.slot, t);
    // The jump is seen a frame after the feet left the ground, a few units up and (at speed) well past the spot. Back
    // along the path to the takeoff: how long ago from the vertical speed lost since a jump's (TAKEOFF_VZ), no more
    // than HOP_BACK; the burst is born then and there, so it's the same burst whichever frame saw it.
    const p = pose.position, v = pose.velocity;
    const back = v ? Math.min(HOP_BACK, Math.max(0, (TAKEOFF_VZ - v[2]) / GRAVITY)) : 0;
    let x = p[0] - (v ? v[0] * back : 0), y = p[1] - (v ? v[1] * back : 0);
    // The floor it left: where the feet last stood, if that was just now. Else (the one tick on the ground fell between
    // two frames) where the path says the takeoff was, or the ground under that spot when it is there too: under a hull
    // that hangs over a block's edge the ground is some other floor, further down.
    let z = this.groundZ;
    if (t - this.groundAt >= 0.15) {
      z = p[2] - (v ? v[2] * back + 0.5 * GRAVITY * back * back : 0);
      const under = this.probe ? this.probe(x, y, p[2] + 8) : null;
      if (under !== null && Math.abs(under - z) <= TAKEOFF_TOL) z = under;
    }
    // Pieces on the ground: the floor round the hop. A hop off a block's very edge (the hull hangs over it) is moved in
    // onto the block, or most of the effect would be cut off there.
    let reach = this.onGround ? this.reach(x, y, z) : null;
    if (reach && this.settle(reach, x, y, z)) {
      x = this.moved[0];
      y = this.moved[1];
      reach = this.reach(x, y, z);
    }
    _v.set(x, z, -y);
    if (root.parent) _v.applyMatrix4(root.parent.matrixWorld);
    const q = hopQuality;
    const ok = this.layer!.burst(this.def, {
      x: _v.x,
      y: _v.y,
      z: _v.z,
      vx: v ? v[0] : 0,
      vz: v ? -v[1] : 0,
      t: t - back,
      slot: this.slot,
      quality: q.count,
      motion: q.motion,
      tint: this.tint,
      tint2: this.tint2,
      alpha: this.alpha,
      reach,
      slope: reach ? this.slope : null,
    });
    if (ok) this.lastBurst = t;
  }

  /** The moment its bursts are drawn at (between two updates: PlayerModel.present); the next update moves it on. */
  show(t: number): void {
    this.layer?.setClock(this.slot, t);
  }

  /**
   * How far the ground round (x, y) goes on from height z in eight directions (Source units; REACH_FAR where it never
   * ends within REACH_STEP × REACH_STEPS): a piece on the ground at a block's edge stops there instead of hanging in the
   * air. Also sets `slope`: the ground's tilt at the feet when it is one even slope (three.js: rise per unit x and z).
   * Null: no probe.
   */
  private reach(x: number, y: number, z: number): Float32Array | null {
    const probe = this.probe;
    if (!probe) return null;
    const out = this.reachOut, slope = this.slope;
    // The slope from the ground a few units either side of the feet (level when any of the four is missing or far off).
    const e = 6;
    const xa = probe(x + e, y, z + 8), xb = probe(x - e, y, z + 8), ya = probe(x, y + e, z + 8), yb = probe(x, y - e, z + 8);
    let gx = 0, gy = 0;
    if (xa !== null && xb !== null && ya !== null && yb !== null) {
      gx = (xa - xb) / (2 * e);
      gy = (ya - yb) / (2 * e);
      // A step or an edge under the feet isn't a slope: both sides must agree with the middle.
      if (Math.abs(xa + xb - 2 * z) > 2 || Math.abs(ya + yb - 2 * z) > 2 || Math.abs(gx) > SLOPE_MAX || Math.abs(gy) > SLOPE_MAX) gx = gy = 0;
    }
    // Source (x, y) -> three.js (x, -z).
    slope[0] = gx;
    slope[1] = gy ? -gy : 0;
    const on = (cx: number, cy: number, r: number): boolean => {
      const g = probe(x + cx * r, y + cy * r, z + (gx * cx + gy * cy) * r + 8);
      return g !== null && Math.abs(g - z - (gx * cx + gy * cy) * r) <= REACH_TOL;
    };
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4, cx = Math.cos(a), cy = Math.sin(a);
      let good = 0, bad = 0;
      for (let i = 1; i <= REACH_STEPS && !bad; i++) {
        if (on(cx, cy, i * REACH_STEP)) good = i * REACH_STEP;
        else bad = i * REACH_STEP;
      }
      if (!bad) {
        out[k] = REACH_FAR;
        continue;
      }
      for (let i = 0; i < REACH_REFINE; i++) {
        const mid = (good + bad) / 2;
        if (on(cx, cy, mid)) good = mid;
        else bad = mid;
      }
      out[k] = good;
    }
    return out;
  }
  private reachOut = new Float32Array(8);
  private slope = new Float32Array(2);

  /**
   * A hop with the floor ending within a step of it on some side (`reach`, as measured there), or with none under it
   * at all (the hull hangs over a block's edge by up to 16): the nearest spot towards the floor that has HOP_MARGIN of
   * it behind too, into `moved` (or, on a floor too narrow for that, the nearest spot that is on it at all). False: it
   * stays (floor all round, none near, or as much one way as the other).
   */
  private settle(reach: ArrayLike<number>, x: number, y: number, z: number): boolean {
    const probe = this.probe!;
    const on = (px: number, py: number): boolean => {
      const g = probe(px, py, z + 8);
      return g !== null && Math.abs(g - z) <= REACH_TOL;
    };
    // Which way the floor is: the directions that have it a step out, else (none: the feet are off it) further out.
    let nx = 0, ny = 0, far = 0;
    for (const r of SETTLE_RADII) {
      let sx = 0, sy = 0, held = 0;
      for (let k = 0; k < 8; k++) {
        const cx = Math.cos((k * Math.PI) / 4), cy = Math.sin((k * Math.PI) / 4);
        if (r === REACH_STEP ? reach[k] >= r : on(x + cx * r, y + cy * r)) {
          sx += cx;
          sy += cy;
          held++;
        }
      }
      if (held === 8) return false;
      const l = Math.hypot(sx, sy);
      if (!held || l < 0.5) continue;
      nx = sx / l;
      ny = sy / l;
      far = r;
      break;
    }
    if (!far) return false;
    let first = 0;
    for (let s = 4; s <= far + HOP_MARGIN + 8; s += 4) {
      if (!on(x + nx * s, y + ny * s)) continue;
      first ||= s;
      if (s < HOP_MARGIN || !on(x + nx * (s - HOP_MARGIN), y + ny * (s - HOP_MARGIN))) continue;
      first = s;
      break;
    }
    if (!first) return false;
    this.moved[0] = x + nx * first;
    this.moved[1] = y + ny * first;
    return true;
  }
  private moved = new Float64Array(2);

  private attach(layer: HopLayer): boolean {
    if (this.layer === layer) return true;
    this.detach();
    const s = layer.claim();
    if (s === null) return false;
    this.layer = layer;
    this.slot = s;
    return true;
  }

  private detach(): void {
    this.layer?.release(this.slot);
    this.layer = null;
    this.slot = -1;
  }

  /** A seek or teleport: this player's bursts go. */
  reset(): void {
    this.lastBurst = -Infinity;
    this.groundAt = -Infinity;
    this.detach();
  }

  dispose(): void {
    this.detach();
    this.def = null;
  }
}
