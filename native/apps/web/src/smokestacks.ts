// env_smokestack (presentation only): the column of soft smoke puffs a map places as a marker or decoration. Some maps
// use them as the only visible part of something you must jump on: bhop_absolutebhop_v4's sky level (behind the
// rainbow pit at the end of level 3) is a toolsskybox room whose platforms are faceless func_door plates, each with a
// small env_smokestack on it, so in CS:S you hop from cloud to cloud. Without the smoke the level looks empty ("you
// appear outside the map", feedback 2026-10-14).
//
// CS:S (SDK 2013 C_SmokeStack): `Rate` particles a second leave a ring of radius `BaseSpread` around the origin, at
// `Speed` along the entity's up vector plus a random sideways `SpreadSpeed`, drift with the wind (`WindAngle`,
// `WindSpeed`) and live `JetLength / Speed` seconds, growing from `StartSize` to `EndSize` (half-widths) and fading in
// and out, tinted by rendercolor x renderamt. Here each stack has a fixed ring of particle slots whose state is a pure
// function of time (slot k is born every N / Rate seconds with fresh random numbers per cycle), so nothing is
// simulated or stored per frame and a paused or replayed view looks the same. Each stack draws with its SmokeMaterial
// when the map or hosted content has it, else the wispy mist map-effects/smoke.ts generates (round puffs read as
// bokeh, not smoke: bhop_arcane's waterfall). Stacks are on or off as the core says (`effect_states`: InitialState,
// then TurnOn / TurnOff / Toggle / Kill), so replays and seeks agree; a stack parented to a brush entity follows it,
// like sprite-trails.ts.
//
//   const smoke = smokeStacks(core.entities(), texture); if (smoke) root.add(smoke.root)   (Source space, Z-up)
//   smoke.update(transforms, visualSeconds, core.effectStates())                         every rendered frame

import * as THREE from "three";
import type { BrushTransform } from "./core";
import { wispySmokeTexture } from "./map-effects/smoke";

/** Particle slots per stack (CS:S has no hard cap; Rate 60 x 6 s = 360 is the biggest on the maps seen). */
const MAX_PER_STACK = 512;
const MAX_TOTAL = 8192;

interface Stack {
  /** Entity index (effect_states' key) and its spawn state. */
  entity: number;
  initial: boolean;
  /** Brush model the stack is parented to, or -1. */
  model: number;
  /** Origin (world, or in the parent's space when parented). */
  local: THREE.Vector3;
  /** Emission basis (world, or in the parent's space): ring axes and up. */
  right: THREE.Vector3;
  forward: THREE.Vector3;
  up: THREE.Vector3;
  spread: number;
  spreadSpeed: number;
  speed: number;
  life: number;
  rate: number;
  slots: number;
  startSize: number;
  endSize: number;
  roll: number;
  wind: THREE.Vector3;
  first: number;
}

export interface SmokeStacks {
  /** Under the world's Z-up root. */
  root: THREE.Object3D;
  count: number;
  /** `states`: entity index -> on (the core's effect_states); without it, stacks keep their spawn state. */
  update(transforms: Map<number, BrushTransform>, now: number, states?: Map<number, boolean>): void;
}

const key = (e: Record<string, string>, k: string): string | undefined => {
  if (k in e) return e[k];
  const lk = k.toLowerCase();
  for (const [kk, v] of Object.entries(e)) if (kk.toLowerCase() === lk) return v;
  return undefined;
};
const vec = (s: string | undefined): [number, number, number] => {
  const v = (s ?? "").trim().split(/\s+/).map(Number);
  return [v[0] || 0, v[1] || 0, v[2] || 0];
};
const num = (s: string | undefined, d: number) => {
  const v = Number(s);
  return Number.isFinite(v) ? v : d;
};

const D = Math.PI / 180;
/** Source AngleMatrix (pitch, yaw, roll), as render.ts places brush models. */
function rotation(pitch: number, yaw: number, roll: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  return out.makeRotationFromEuler(new THREE.Euler(roll * D, pitch * D, yaw * D, "ZYX"));
}

/** Three uniform numbers in [0, 1) for (stack, slot, cycle): a small integer hash, stable across frames. */
function rand3(a: number, b: number, c: number, out: number[]): number[] {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  for (let i = 0; i < 3; i++) {
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    h = Math.imul(h, 0x297a2d39);
    h ^= h >>> 15;
    out[i] = (h >>> 0) / 4294967296;
  }
  return out;
}

// View-space billboards: each particle is a quad around its centre, rotated by its roll.
const VERTEX = /* glsl */ `
attribute vec2 corner;
attribute vec3 params; // half-width, alpha, roll (radians)
attribute vec3 tint;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  float c = cos(params.z);
  float s = sin(params.z);
  p.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * params.x;
  vUv = corner * 0.5 + 0.5;
  vColor = vec4(tint, params.y);
  gl_Position = projectionMatrix * p;
}`;
const FRAGMENT = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 t = texture2D(map, vUv);
  float a = t.a * vColor.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * t.rgb, a);
  #include <colorspace_fragment>
}`;

/**
 * The map's env_smokestacks, or null if there are none. `texture` resolves a SmokeMaterial (render.ts' extra content
 * materials); null falls back to the generated wispy mist.
 */
export function smokeStacks(entities: Record<string, string>[], texture: (material: string) => THREE.Texture | null = () => null): SmokeStacks | null {
  const byName = new Map<string, Record<string, string>>();
  for (const e of entities) {
    const n = key(e, "targetname");
    if (n && !byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), e);
  }
  const stacks: Stack[] = [];
  const materials: string[] = [];
  const tints: THREE.Color[] = [];
  const alphas: number[] = [];
  let total = 0;
  const m = new THREE.Matrix4();
  const inv = new THREE.Matrix4();
  for (const [entity, e] of entities.entries()) {
    if (key(e, "classname")?.toLowerCase() !== "env_smokestack") continue;
    const speed = num(key(e, "Speed"), 30);
    const jet = num(key(e, "JetLength"), 180);
    const rate = num(key(e, "Rate"), 20);
    const life = speed > 0 ? jet / speed : 0;
    const amt = Math.min(1, Math.max(0, num(key(e, "renderamt"), 255) / 255));
    if (!(life > 0) || !(rate > 0) || amt <= 0) continue;
    const slots = Math.min(MAX_PER_STACK, Math.ceil(rate * life));
    if (total + slots > MAX_TOTAL) break;

    const o = vec(key(e, "origin"));
    const a = vec(key(e, "angles"));
    rotation(a[0], a[1], a[2], m);
    // A brush entity parent: keep origin and axes in its space (its spawn transform), like sprite-trails.ts.
    const parent = byName.get((key(e, "parentname") ?? "").split(",")[0].toLowerCase());
    const model = parent && /^\*\d+$/.test(key(parent, "model") ?? "") ? Number(key(parent, "model")!.slice(1)) : -1;
    const local = new THREE.Vector3(o[0], o[1], o[2]);
    if (model >= 0) {
      const po = vec(key(parent!, "origin"));
      const pa = vec(key(parent!, "angles"));
      inv.copy(rotation(pa[0], pa[1], pa[2])).transpose();
      local.set(o[0] - po[0], o[1] - po[1], o[2] - po[2]).applyMatrix4(inv);
      m.premultiply(inv);
    }
    const forward = new THREE.Vector3(1, 0, 0).transformDirection(m);
    const right = new THREE.Vector3(0, -1, 0).transformDirection(m);
    const up = new THREE.Vector3(0, 0, 1).transformDirection(m);
    const windYaw = num(key(e, "WindAngle"), 0) * D;
    const windSpeed = num(key(e, "WindSpeed"), 0);
    const c = vec(key(e, "rendercolor") ?? "255 255 255");
    stacks.push({
      entity,
      initial: num(key(e, "InitialState"), 0) !== 0,
      model,
      local,
      right,
      forward,
      up,
      spread: Math.max(0, num(key(e, "BaseSpread"), 20)),
      spreadSpeed: Math.max(0, num(key(e, "SpreadSpeed"), 15)),
      speed,
      life,
      rate,
      slots,
      startSize: Math.max(0, num(key(e, "StartSize"), 20)),
      endSize: Math.max(0, num(key(e, "EndSize"), 30)),
      roll: num(key(e, "roll"), 0),
      wind: new THREE.Vector3(Math.cos(windYaw) * windSpeed, Math.sin(windYaw) * windSpeed, 0),
      first: total,
    });
    materials.push(key(e, "SmokeMaterial") ?? "");
    tints.push(new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace));
    alphas.push(amt);
    total += slots;
  }
  if (!stacks.length) return null;

  // One geometry for every particle: four corners each.
  const verts = total * 4;
  const pos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const params = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const corner = new THREE.BufferAttribute(new Float32Array(verts * 2), 2);
  const tint = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
  const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];
  for (let p = 0; p < total; p++) for (let j = 0; j < 8; j++) corner.array[p * 8 + j] = CORNERS[j];
  stacks.forEach((s, k) => {
    for (let v = s.first * 4; v < (s.first + s.slots) * 4; v++) tints[k].toArray(tint.array, v * 3);
  });
  const index = new Uint32Array(total * 6);
  for (let p = 0; p < total; p++) index.set([p * 4, p * 4 + 1, p * 4 + 2, p * 4, p * 4 + 2, p * 4 + 3], p * 6);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", pos);
  geo.setAttribute("params", params);
  geo.setAttribute("corner", corner);
  geo.setAttribute("tint", tint);

  // One draw per smoke texture: each a group over its stacks' particles (stacks are contiguous slot ranges, so a
  // texture's stacks are sorted into one run of the index buffer).
  let wispy: THREE.Texture | null = null;
  const byTexture = new Map<THREE.Texture, number[]>();
  stacks.forEach((st, k) => {
    const t = (materials[k] && texture(materials[k])) || (wispy ??= wispySmokeTexture(2.5));
    byTexture.set(t, [...(byTexture.get(t) ?? []), k]);
  });
  const sorted = new Uint32Array(total * 6);
  const mats: THREE.ShaderMaterial[] = [];
  let at6 = 0;
  for (const [t, ks] of byTexture) {
    const start = at6;
    for (const k of ks) {
      const st = stacks[k];
      sorted.set(index.subarray(st.first * 6, (st.first + st.slots) * 6), at6);
      at6 += st.slots * 6;
    }
    geo.addGroup(start, at6 - start, mats.length);
    mats.push(new THREE.ShaderMaterial({ uniforms: { map: { value: t } }, vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  }
  geo.setIndex(new THREE.BufferAttribute(sorted, 1));
  const mesh = new THREE.Mesh(geo, mats);
  mesh.frustumCulled = false;
  mesh.name = "env_smokestack";
  mesh.renderOrder = 2;

  const tm = new THREE.Matrix4();
  const at = new THREE.Vector3();
  const r = new THREE.Vector3();
  const f = new THREE.Vector3();
  const u = new THREE.Vector3();
  const rnd = [0, 0, 0];
  const update = (transforms: Map<number, BrushTransform>, now: number, states?: Map<number, boolean>) => {
    const P = pos.array as Float32Array;
    const Q = params.array as Float32Array;
    for (let k = 0; k < stacks.length; k++) {
      const s = stacks[k];
      at.copy(s.local);
      r.copy(s.right);
      f.copy(s.forward);
      u.copy(s.up);
      let shown = states?.get(s.entity) ?? s.initial;
      if (shown && s.model >= 0) {
        const tf = transforms.get(s.model);
        // Hidden or killed parents take their smoke with them.
        if (!tf || (tf.length > 6 && tf[6] === 0)) shown = false;
        else {
          rotation(tf[3], tf[4], tf[5], tm);
          at.applyMatrix4(tm);
          at.x += tf[0];
          at.y += tf[1];
          at.z += tf[2];
          r.transformDirection(tm);
          f.transformDirection(tm);
          u.transformDirection(tm);
        }
      }
      const period = s.slots / s.rate;
      for (let i = 0; i < s.slots; i++) {
        const p = s.first + i;
        // Slot i is born at i / rate + n * period; age within the current cycle n.
        const since = now - i / s.rate;
        const cycle = Math.floor(since / period);
        const age = since - cycle * period;
        let alpha = 0;
        let size = 0;
        let x = 0;
        let y = 0;
        let z = 0;
        let roll = 0;
        if (shown && age >= 0 && age < s.life) {
          const t = age / s.life;
          rand3(k, i, cycle, rnd);
          const ring = rnd[0] * Math.PI * 2;
          const side = (rnd[1] * 2 - 1) * s.spreadSpeed;
          const fwd = (rnd[2] * 2 - 1) * s.spreadSpeed;
          const cr = Math.cos(ring) * s.spread + side * age;
          const cf = Math.sin(ring) * s.spread + fwd * age;
          const cu = s.speed * age;
          x = at.x + r.x * cr + f.x * cf + u.x * cu + s.wind.x * age;
          y = at.y + r.y * cr + f.y * cf + u.y * cu + s.wind.y * age;
          z = at.z + r.z * cr + f.z * cf + u.z * cu + s.wind.z * age;
          size = s.startSize + (s.endSize - s.startSize) * t;
          // Fade in over the first fifth, out over the rest.
          alpha = alphas[k] * Math.min(1, t / 0.2) * (1 - t) * 0.85;
          roll = (rnd[0] * 2 - 1) * Math.PI + s.roll * D * age * (rnd[1] * 2 - 1);
        }
        for (let c = 0; c < 4; c++) {
          const v = p * 4 + c;
          P[v * 3] = x;
          P[v * 3 + 1] = y;
          P[v * 3 + 2] = z;
          Q[v * 3] = size;
          Q[v * 3 + 1] = alpha;
          Q[v * 3 + 2] = roll;
        }
      }
    }
    pos.needsUpdate = params.needsUpdate = true;
  };
  update(new Map(), 0);
  return { root: mesh, count: stacks.length, update };
}
