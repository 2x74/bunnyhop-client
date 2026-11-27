// func_precipitation (research/PRECIPITATION.md): falling snow and rain inside the map's precipitation volumes, the
// way CS:S's client draws them (SDK 2013 c_effects.cpp), as a render-only effect.
//
// CS:S simulates its particles frame by frame around the local player. Here every particle is a pure function of time
// (and the camera, which only picks which copy of it to draw): a field of particles that repeats every `2 * half`
// units in each axis, anchored to the world and falling through it, evaluated in the vertex shader. So a replay seek,
// a scrub, a spectated player and a video export all show the same snow as playing to that moment, nothing is kept
// from frame to frame, and the CPU does no per-particle work at all. One instanced draw per kind of precipitation.
//
// Where particles may be: inside a volume's box and between the first solid below the volume's top and that top
// ("columns", traced once through the core when the effect is first switched on). That keeps snow off roofed and
// indoor areas under a volume, and stops it at the ground, at the column map's resolution (16–64 units).
//
// Kinds (CPrecipitation::Spawn turns an out-of-range type into rain):
//   preciptype 3 Snowfall: drifting flakes (CSnowFallManager / SnowFallEffect).
//   preciptype 0 Rain:     thin streaks, 600 u/s, 0.1 s long (CClient_Precipitation, particle/rain).
//   preciptype 1 Snow:     the same streaks, 0.03 s long, half of them circling (RenderParticle's snow spiral).
//   preciptype 2 Ash, 4:   not drawn.

import * as THREE from "three";
import { particleRandom, value, type EffectEntity } from "./smoke";
import { withDepthFog, type DepthFogUniforms } from "../depth-fog";

export type PrecipKind = "snowfall" | "rain" | "snow";
export const PRECIP_KINDS: readonly PrecipKind[] = ["snowfall", "rain", "snow"];

/** Every particle's motion repeats exactly after this many seconds, so time is wrapped to it without a jump. */
export const PRECIP_PERIOD = 600;
/** Volumes a particle is tested against (the nearest ones around the camera, chosen each frame; CS:S: MAX_SNOW_LIST). */
export const PRECIP_MAX_ACTIVE = 16;

/** Which kind a preciptype draws as, or null (not drawn). */
export function precipitationKind(type: number): PrecipKind | null {
  if (!Number.isFinite(type)) return "rain";
  const t = Math.trunc(type);
  if (t === 3) return "snowfall";
  if (t === 1) return "snow";
  if (t === 0) return "rain";
  // CPrecipitation::Spawn: `if (type < 0 || type > NUM_PRECIPITATION_TYPES) type = RAIN` (NUM = 4, so 4 itself slips
  // through and is undefined on the client). 2 is ash: not drawn here.
  if (t < 0 || t > 4) return "rain";
  return null;
}

export interface PrecipVolume {
  kind: PrecipKind;
  /** Entity index (the core's order). */
  entity: number;
  /** The brush model's bounds (Source units), dmodel padding removed. */
  min: [number, number, number];
  max: [number, number, number];
  /** renderamt (CS:S: rain and streak-snow density, 255 = r_raindensity 0.001); snowfall ignores it, as CS:S does. */
  amount: number;
}

/** The map's precipitation volumes that draw, from its entities and brush model bounds (smoke.ts brushBounds). */
export function precipitationVolumes(entities: readonly EffectEntity[], bounds: Map<number, THREE.Box3>): PrecipVolume[] {
  const out: PrecipVolume[] = [];
  entities.forEach((e, entity) => {
    if (value(e, "classname")?.toLowerCase() !== "func_precipitation") return;
    const kind = precipitationKind(Number(value(e, "preciptype") ?? 0));
    const model = /^\*(\d+)$/.exec(value(e, "model") ?? "");
    const box = model ? bounds.get(Number(model[1])) : undefined;
    if (!kind || !box || box.isEmpty()) return;
    // vbsp pads model bounds by a unit on every side.
    const min: [number, number, number] = [box.min.x + 1, box.min.y + 1, box.min.z + 1];
    const max: [number, number, number] = [box.max.x - 1, box.max.y - 1, box.max.z - 1];
    if (max[0] - min[0] < 1 || max[1] - min[1] < 1 || max[2] - min[2] < 1) return;
    const amount = Number(value(e, "renderamt") ?? 255);
    out.push({ kind, entity, min, max, amount: Number.isFinite(amount) ? amount : 255 });
  });
  return out;
}

/** How one kind's particle field looks and moves. Speeds in units per second, sizes in units. */
export interface PrecipField {
  /** Half the field's repeat (and of the box around the camera it is drawn in). */
  half: [number, number, number];
  /** Particles per cubic unit at full density (snowfall), or per cubic unit per renderamt 255 (streaks). */
  density: number;
  /** Instance cap. */
  max: number;
  fall: [number, number];
  /** Horizontal drift, ± this. */
  drift: number;
  /** Circling about the fall line: share of the particles that circle, radius range, angular speed range (rad/s). */
  swirl: { share: number; radius: [number, number]; speed: [number, number] };
  /** Sprite radius (snowfall) or streak width (streaks), range. */
  size: [number, number];
  /** Streak length in seconds of its velocity; 0 draws round sprites. */
  length: number;
  /** sRGB 0..255. */
  color: [number, number, number];
  alpha: number;
  /** View depths over which particles fade in (CSimpleEmitter's near clip fade). */
  near: [number, number];
  /** Smallest size on screen in pixels (radius for sprites, width for streaks); smaller ones fade instead. */
  minPixels: number;
}

/**
 * The fields, from the SDK 2013 numbers (c_effects.cpp):
 * - snowfall: 25–35 u/s × r_SnowFallSpeed 1.5, ±5 u/s drift, start size 1 (shrinking to 0, alpha 25→255 over its fall),
 *   colour r_SnowColor 150 175 200, at most r_SnowParticles 500 alive, spawned within r_SnowInsideRadius 256 of a point
 *   ahead of the eye. Here: a steady 4.2e-6 flakes per cubic unit (CS:S's 500 in a 512-unit cube), size 0.75–1.25, a
 *   slow circling of 3–8 units (2–11 u/s sideways) in place of SnowFallEffect's per-frame random walk (which wanders
 *   about 6 u/s), and never under 2 pixels across: smaller ones fade instead of shimmering.
 * - rain: r_rainspeed 600, r_rainlength 0.1 s, r_rainwidth 0.5 (at least 1 px, fading below that), r_rainalpha 0.4 ^
 *   r_rainalphapow 0.8, density renderamt / 255 × 0.001 per square unit per second over r_RainRadius 1500 below
 *   player + 512 (so 1.67e-6 per cubic unit at 255). r_RainSideVel ±130 decays to the (zero) wind in a few frames:
 *   a slight lean here.
 * - snow (type 1): the rain tracer at r_rainspeed with the particle/snow material, ramp 0.3 (0.03 s long), and the
 *   particles with mass > 1 (half) circling 28 units at π(1 + mass / 10) rad/s.
 */
export const PRECIP_FIELDS: Record<PrecipKind, PrecipField> = {
  snowfall: {
    half: [640, 640, 384],
    density: 4.2e-6,
    max: 8192,
    fall: [37.5, 52.5],
    drift: 5,
    swirl: { share: 1, radius: [3, 8], speed: [0.5, 1.4] },
    size: [0.75, 1.25],
    length: 0,
    color: [150, 175, 200],
    alpha: 0.95,
    near: [16, 64],
    minPixels: 1,
  },
  rain: {
    half: [768, 768, 512],
    density: 0.001 / 600,
    max: 8192,
    fall: [600, 600],
    drift: 12,
    swirl: { share: 0, radius: [0, 0], speed: [0, 0] },
    size: [0.5, 0.5],
    length: 0.1,
    // particle/rain's texels (alpha-weighted) under the tracer's white: CS:S rain is grey, darker than a bright sky.
    color: [129, 128, 129],
    alpha: 0.4 ** 0.8,
    near: [8, 32],
    minPixels: 1,
  },
  snow: {
    half: [768, 768, 512],
    density: 0.001 / 600,
    max: 8192,
    fall: [600, 600],
    drift: 0,
    swirl: { share: 0.5, radius: [28, 28], speed: [Math.PI * 1.1, Math.PI * 1.15] },
    size: [0.5, 0.5],
    length: 0.03,
    color: [255, 255, 255],
    alpha: 0.4 ** 0.8,
    near: [8, 32],
    minPixels: 1,
  },
};

/** Instances of `kind` at full density, given its volumes' largest renderamt (streaks; snowfall ignores it). */
export function fieldCount(kind: PrecipKind, amount = 255): number {
  const f = PRECIP_FIELDS[kind];
  const volume = 8 * f.half[0] * f.half[1] * f.half[2];
  // CS:S clamps the rain density at 0.01 (renderamt 2550).
  const scale = kind === "snowfall" ? 1 : Math.min(10, Math.max(0, amount / 255));
  return Math.min(f.max, Math.round(f.density * volume * scale));
}

const TAU = Math.PI * 2;
/** A speed made a whole number of field repeats per PRECIP_PERIOD (so the field repeats exactly in time too). */
export const periodicSpeed = (speed: number, repeat: number) => (Math.round((speed * PRECIP_PERIOD) / repeat) * repeat) / PRECIP_PERIOD;
/** An angular speed made a whole number of turns per PRECIP_PERIOD. */
export const periodicTurn = (w: number) => (Math.round((w * PRECIP_PERIOD) / TAU) * TAU) / PRECIP_PERIOD;

/**
 * Per-instance data, 12 floats each: base position (x, y, z) and swirl phase; velocity (x, y, z) and swirl angular
 * speed; size, swirl radius, density draw (0..1: drawn where a volume's density share is above it) and alpha scale.
 * The same instance index always gets the same values, so a lower density draws a subset of a higher one.
 */
export function fieldInstances(kind: PrecipKind, count: number): Float32Array {
  const f = PRECIP_FIELDS[kind];
  const seed = (PRECIP_KINDS.indexOf(kind) + 1) * 0x9e37;
  const p = [f.half[0] * 2, f.half[1] * 2, f.half[2] * 2];
  const out = new Float32Array(count * 12);
  for (let i = 0; i < count; i++) {
    const r = (c: number) => particleRandom(i * 13 + seed, c);
    const o = i * 12;
    out[o] = r(0) * p[0];
    out[o + 1] = r(1) * p[1];
    out[o + 2] = r(2) * p[2];
    out[o + 3] = r(3) * TAU;
    out[o + 4] = periodicSpeed(f.drift * (2 * r(4) - 1), p[0]);
    out[o + 5] = periodicSpeed(f.drift * (2 * r(5) - 1), p[1]);
    out[o + 6] = -periodicSpeed(f.fall[0] + (f.fall[1] - f.fall[0]) * r(6), p[2]);
    const swirls = r(9) < f.swirl.share;
    out[o + 7] = swirls ? periodicTurn(f.swirl.speed[0] + (f.swirl.speed[1] - f.swirl.speed[0]) * r(7)) : 0;
    out[o + 8] = f.size[0] + (f.size[1] - f.size[0]) * r(8);
    out[o + 9] = swirls ? f.swirl.radius[0] + (f.swirl.radius[1] - f.swirl.radius[0]) * r(10) : 0;
    out[o + 10] = r(11);
    out[o + 11] = 0.7 + 0.3 * r(12);
  }
  return out;
}

const wrap = (v: number, period: number) => v - Math.floor(v / period) * period;

/**
 * Where instance `i` is drawn at `time` for a camera at `cam` (Source units): the copy of the particle nearest the
 * camera, as `rel` (from the camera, each axis within ±half) and `at` (world). The vertex shaders do exactly this.
 */
export function particleAt(kind: PrecipKind, data: Float32Array, i: number, time: number, cam: readonly number[], out: { rel: number[]; at: number[] }): void {
  const f = PRECIP_FIELDS[kind];
  const o = i * 12;
  const t = wrap(time, PRECIP_PERIOD);
  const a = data[o + 7] * t + data[o + 3];
  const swirl = [Math.cos(a) * data[o + 9], Math.sin(a) * data[o + 9], 0];
  for (let k = 0; k < 3; k++) {
    const p = f.half[k] * 2;
    const camMod = wrap(cam[k], p);
    const rel = wrap(data[o + k] + data[o + 4 + k] * t + swirl[k] - camMod + f.half[k], p) - f.half[k];
    out.rel[k] = rel;
    out.at[k] = cam[k] + rel;
  }
}

// ---- columns: where in each volume particles may be ----------------------------------------------------------------

/** The air column of each cell of each volume: [lowest z, highest z] (RG floats), packed into one texture. */
export interface PrecipColumns {
  /** RG float texels, `width` × `height`. An empty cell holds [+big, -big]. */
  data: Float32Array;
  width: number;
  height: number;
  /** Per volume (same order as given): atlas origin, cells, cell size. */
  layout: { x: number; y: number; cols: number; rows: number; cell: number }[];
  traces: number;
  /** True when the trace budget ran out (the remaining cells were left unclipped). */
  truncated: boolean;
}

/** Sweeps a line from start to end through the world (solid brushes and props); the fraction travelled before a hit, 0 when the start is inside a solid. */
export type PrecipTrace = (sx: number, sy: number, sz: number, ex: number, ey: number, ez: number) => number;

export const EMPTY_COLUMN = 1e9;

/**
 * For each cell (centre) of each volume, the first air below the volume's top and how far down it reaches: snow falls
 * from the top of the volume (or the underside of whatever solid the top is buried in, like a sky brush) to the first
 * solid below. A cell whose column is solid all the way down is empty. Cells are square, `cell` units, sized so all
 * volumes together take at most `maxCells` (at least 16 units, at most 64).
 */
export function buildColumns(volumes: readonly PrecipVolume[], trace: PrecipTrace, opts: { maxCells?: number; maxTraces?: number; atlasWidth?: number } = {}): PrecipColumns {
  const maxCells = opts.maxCells ?? 131072;
  const maxTraces = opts.maxTraces ?? 400000;
  const atlasWidth = opts.atlasWidth ?? 2048;
  const area = volumes.reduce((s, v) => s + (v.max[0] - v.min[0]) * (v.max[1] - v.min[1]), 0);
  const base = Math.min(64, Math.max(16, Math.ceil(Math.sqrt(area / maxCells))));
  const sizes = volumes.map((v) => {
    const cell = Math.max(base, Math.ceil(Math.max(v.max[0] - v.min[0], v.max[1] - v.min[1]) / atlasWidth));
    return { cell, cols: Math.max(1, Math.ceil((v.max[0] - v.min[0]) / cell)), rows: Math.max(1, Math.ceil((v.max[1] - v.min[1]) / cell)) };
  });
  // Shelf packing, tallest first.
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[b].rows - sizes[a].rows);
  const layout = sizes.map((s) => ({ x: 0, y: 0, ...s }));
  let x = 0, y = 0, shelf = 0, width = 1;
  for (const i of order) {
    const s = sizes[i];
    if (x + s.cols > atlasWidth) { x = 0; y += shelf; shelf = 0; }
    layout[i].x = x;
    layout[i].y = y;
    x += s.cols;
    shelf = Math.max(shelf, s.rows);
    width = Math.max(width, x);
  }
  const height = Math.max(1, y + shelf);
  const data = new Float32Array(width * height * 2);
  for (let i = 0; i < data.length; i += 2) { data[i] = EMPTY_COLUMN; data[i + 1] = -EMPTY_COLUMN; }
  let traces = 0;
  let truncated = false;
  const t = (sx: number, sy: number, sz: number, ex: number, ey: number, ez: number) => (traces++, trace(sx, sy, sz, ex, ey, ez));
  volumes.forEach((v, vi) => {
    const l = layout[vi];
    // Snowfall stays in the volume. A streak can fall below it (its emission follows the eye down; STREAK_FALL): its
    // column goes down to the first solid, however far.
    const top = v.max[2], bottom = v.kind === "snowfall" ? v.min[2] : Math.min(v.min[2], -16384);
    for (let r = 0; r < l.rows; r++) for (let c = 0; c < l.cols; c++) {
      const px = Math.min(v.max[0], v.min[0] + (c + 0.5) * l.cell), py = Math.min(v.max[1], v.min[1] + (r + 0.5) * l.cell);
      const o = ((l.y + r) * width + l.x + c) * 2;
      // Out of budget: the volume's own box, unclipped.
      if (traces >= maxTraces) { truncated = true; data[o] = v.min[2]; data[o + 1] = top; continue; }
      const start = top - 0.5;
      const f = t(px, py, start, px, py, bottom);
      if (f > 0) { data[o] = start + (bottom - start) * f; data[o + 1] = top; continue; }
      // The top is inside a solid (a sky or roof brush, the void above the map): step down to the first air, then find
      // that solid's underside. Snowfall looks only within the volume's height; a streak anywhere below (CS:S emits
      // rain wherever the space above the player is open, even under a volume buried in the sky), in at most 16 steps
      // (about 5,700 units). None found: the column is empty.
      const lowest = v.kind === "snowfall" ? v.min[2] : bottom;
      let above = start, step = 32, z = start - step, probes = 0;
      while (z > lowest && probes++ < 16 && traces < maxTraces) {
        const g = t(px, py, z, px, py, bottom);
        if (g > 0) {
          const up = t(px, py, z, px, py, above);
          data[o] = z + (bottom - z) * g;
          data[o + 1] = z + (above - z) * up;
          break;
        }
        above = z;
        if (start - z >= 128) step = Math.min(step * 2, 512);
        z -= step;
      }
    }
  });
  return { data, width, height, layout, traces, truncated };
}

/**
 * CS:S's rain (and streak snow) is not kept inside the volume's height: CClient_Precipitation emits over the volume's
 * footprint at min(volume top, player z + 512) (a column roofed below that emits under the roof's sky face instead), and
 * each drop dies after height / m_Speed seconds (m_Speed 425 rain, 80 snow) falling at r_rainspeed 600, or in a solid.
 * This is how far a drop falls per unit of volume height.
 */
export const STREAK_FALL: Record<Exclude<PrecipKind, "snowfall">, number> = { rain: 600 / 425, snow: 600 / 80 };
/** How far above the eye CS:S emits rain (ComputeEmissionArea). */
export const STREAK_EMIT_ABOVE = 512;

/**
 * Where a particle at (x, y, z) may be drawn (as the shaders test), or null: snowfall inside a volume's box and its
 * cell's air column; streaks over a volume's footprint, between the column's floor and min(its top, eye + 512), within
 * the drop's lifetime below that. `floor`: where it stops (a streak is cut there).
 */
export function precipitationSpan(kind: PrecipKind, volumes: readonly PrecipVolume[], columns: PrecipColumns, x: number, y: number, z: number, eyeZ: number): { floor: number; top: number } | null {
  for (let i = 0; i < volumes.length; i++) {
    const v = volumes[i];
    if (v.kind !== kind || x < v.min[0] || y < v.min[1] || x >= v.max[0] || y >= v.max[1]) continue;
    if (kind === "snowfall" && (z < v.min[2] || z >= v.max[2])) continue;
    const l = columns.layout[i];
    const c = Math.min(l.cols - 1, Math.max(0, Math.floor((x - v.min[0]) / l.cell)));
    const r = Math.min(l.rows - 1, Math.max(0, Math.floor((y - v.min[1]) / l.cell)));
    const o = ((l.y + r) * columns.width + l.x + c) * 2;
    let floor = columns.data[o], top = columns.data[o + 1];
    if (kind !== "snowfall") {
      top = Math.min(top, eyeZ + STREAK_EMIT_ABOVE);
      floor = Math.max(floor, top - (v.max[2] - v.min[2]) * STREAK_FALL[kind]);
    }
    if (z >= floor && z <= top) return { floor, top };
  }
  return null;
}

// ---- drawing --------------------------------------------------------------------------------------------------------

const MAXV = PRECIP_MAX_ACTIVE;

const vertexShader = /* glsl */ `
#define MAXV ${MAXV}
attribute vec2 corner;
attribute vec4 aBase;
attribute vec4 aMotion;
attribute vec4 aShape;
uniform float uTime;
uniform vec3 uCam;
uniform vec3 uCamMod;
uniform vec3 uHalf;
uniform float uProj;
uniform float uMinPx;
uniform float uLength;
uniform float uFall;
uniform vec2 uNear;
uniform int uVolCount;
uniform vec4 uVolMin[MAXV];
uniform vec4 uVolMax[MAXV];
uniform vec4 uVolGrid[MAXV];
uniform sampler2D uColumns;
varying vec2 vUv;
varying float vAlpha;

// Where the particle may be (precipitationSpan): x = floor (1e9: nowhere), y = how far above the end of a drop's life
// (streaks; fades the last units out).
vec2 columnSpan(vec3 w) {
  for (int k = 0; k < MAXV; k++) {
    if (k >= uVolCount) break;
    if (any(lessThan(w.xy, uVolMin[k].xy)) || any(greaterThanEqual(w.xy, uVolMax[k].xy))) continue;
#ifndef STREAK
    if (w.z < uVolMin[k].z || w.z >= uVolMax[k].z) continue;
#endif
    if (aShape.z >= uVolMax[k].w) continue;
    vec4 g = uVolGrid[k];
    ivec2 c = ivec2(clamp(floor((w.xy - uVolMin[k].xy) * uVolMin[k].w), vec2(0.0), g.zw - 1.0)) + ivec2(g.xy);
    vec2 col = texelFetch(uColumns, c, 0).rg;
#ifdef STREAK
    col.y = min(col.y, uCam.z + ${STREAK_EMIT_ABOVE.toFixed(1)});
    float life = col.y - (uVolMax[k].z - uVolMin[k].z) * uFall;
    col.x = max(col.x, life);
    if (w.z >= col.x && w.z <= col.y) return vec2(col.x, w.z - life);
#else
    if (w.z >= col.x && w.z <= col.y) return vec2(col.x, 1e9);
#endif
  }
  return vec2(1e9);
}

void main() {
  vec3 period = uHalf * 2.0;
  float a = aMotion.w * uTime + aBase.w;
  vec3 swirl = vec3(cos(a), sin(a), 0.0) * aShape.y;
  vec3 rel = mod(aBase.xyz + mod(aMotion.xyz * uTime, period) + swirl - uCamMod + uHalf, period) - uHalf;
  vec3 w = uCam + rel;
  vec2 span = columnSpan(w);
  float floorZ = span.x;
  // Fade towards the edges of the box around the camera, where a particle wraps to the far side, and over a drop's last
  // 32 units of life.
  float alpha = aShape.w * (1.0 - smoothstep(0.55 * uHalf.x, 0.95 * uHalf.x, length(rel.xy))) * (1.0 - smoothstep(0.75 * uHalf.z, 0.98 * uHalf.z, abs(rel.z))) * smoothstep(0.0, 32.0, span.y);
  if (floorZ > 1e8) alpha = 0.0;
  vec4 mv = modelViewMatrix * vec4(w, 1.0);
  float depth = -mv.z;
  alpha *= smoothstep(uNear.x, uNear.y, depth);
  if (alpha < 0.004 || depth < 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vUv = vec2(0.0); vAlpha = 0.0; return; }
#ifdef STREAK
  // A tracer from the particle along its velocity (c_tracer Tracer_Draw), stopped at the column's floor.
  vec3 vel = aMotion.xyz + vec3(-sin(a), cos(a), 0.0) * aShape.y * aMotion.w;
  vec3 delta = vel * uLength;
  if (w.z + delta.z < floorZ) delta *= (w.z - floorZ) / max(1e-3, -delta.z);
  vec3 tail = (modelViewMatrix * vec4(w + delta, 1.0)).xyz;
  float t = corner.y * 0.5 + 0.5;
  vec3 p = mix(mv.xyz, tail, t);
  vec3 side = cross(tail - mv.xyz, p);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
  float width = aShape.x;
  float px = width * uProj / max(1.0, -p.z);
  if (px < uMinPx) { alpha *= px / uMinPx; width = uMinPx * max(1.0, -p.z) / uProj; }
  p += side * corner.x * width * 0.5;
  gl_Position = projectionMatrix * vec4(p, 1.0);
#else
  float r = aShape.x;
  float px = r * uProj / depth;
  if (px < uMinPx) { alpha *= (px / uMinPx) * (px / uMinPx); r = uMinPx * depth / uProj; }
  mv.xy += corner * r;
  gl_Position = projectionMatrix * mv;
#endif
  vUv = corner;
  vAlpha = alpha;
}`;

const fragmentShader = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
varying vec2 vUv;
varying float vAlpha;
void main() {
#ifdef STREAK
  // particle/rain: soft across, fading at both ends.
  float a = (1.0 - abs(vUv.x)) * smoothstep(1.0, 0.6, abs(vUv.y));
#else
  // particle/snow: a soft round flake.
  float d = dot(vUv, vUv);
  float a = d < 1.0 ? pow(1.0 - d, 1.5) : 0.0;
#endif
  gl_FragColor = vec4(uColor, a * vAlpha * uAlpha);
  if (gl_FragColor.a < 0.003) discard;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

interface KindDraw {
  kind: PrecipKind;
  mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  /** Instances at full density. */
  full: number;
  /** Indices into the volume list of this kind's volumes, and their (fixed) uniforms. */
  volumes: number[];
  /** Per volume of this kind: the density share (its renderamt over the kind's largest). */
  share: number[];
  /** Scratch for picking the nearest volumes. */
  dist: Float32Array;
  picked: Int32Array;
}

export interface MapPrecipitation {
  root: THREE.Group;
  volumes: readonly PrecipVolume[];
  /** Instances drawn per kind at the current density. */
  counts(): Partial<Record<PrecipKind, number>>;
  /** Column map build stats (null until built). */
  stats(): { ms: number; traces: number; cells: number; truncated: boolean } | null;
  /** 0 = off (nothing built or drawn), 0.5 = light, 1 = full. Builds the columns the first time it is above 0. */
  setDensity(density: number): void;
  /** Hidden in Potato mode. */
  setPotato(on: boolean): void;
  /** Every frame: the visual time (seconds; the game's tick time, a replay's time). */
  update(time: number): void;
  /** Before each render of the world: which camera (water reflections and other non-perspective views draw none). */
  observe(camera: THREE.Camera, root: THREE.Object3D): void;
  dispose(): void;
}

/**
 * The map's precipitation, or null when it has none that draws. Nothing is built and nothing draws until
 * `setDensity` turns it on: the column map's traces and the instance buffers come then.
 */
export function mapPrecipitation(entities: readonly EffectEntity[], bounds: Map<number, THREE.Box3>, trace: PrecipTrace, fog: DepthFogUniforms | null): MapPrecipitation | null {
  const volumes = precipitationVolumes(entities, bounds);
  if (!volumes.length) return null;
  const root = new THREE.Group();
  root.name = "precipitation";
  // (For tools and debugging: which volumes the map has.)
  root.userData.volumes = volumes;
  let draws: KindDraw[] | null = null;
  let columns: THREE.DataTexture | null = null;
  let built: { ms: number; traces: number; cells: number; truncated: boolean } | null = null;
  let density = 0;
  let potato = false;
  let time = 0;
  const eye = new THREE.Vector3();
  const inverse = new THREE.Matrix4();
  const buffer = new THREE.Vector2();

  const build = () => {
    const t0 = performance.now();
    const cols = buildColumns(volumes, trace);
    root.userData.columns = cols;
    columns = new THREE.DataTexture(cols.data, cols.width, cols.height, THREE.RGFormat, THREE.FloatType);
    columns.minFilter = columns.magFilter = THREE.NearestFilter;
    columns.generateMipmaps = false;
    columns.needsUpdate = true;
    draws = [];
    for (const kind of PRECIP_KINDS) {
      const idx = volumes.flatMap((v, i) => (v.kind === kind ? [i] : []));
      if (!idx.length) continue;
      const f = PRECIP_FIELDS[kind];
      const amounts = idx.map((i) => Math.max(0, volumes[i].amount));
      const top = Math.max(...amounts);
      const full = fieldCount(kind, top);
      if (full <= 0) continue;
      const share = kind === "snowfall" ? idx.map(() => 1) : amounts.map((a) => (top > 0 ? a / top : 0));
      const data = fieldInstances(kind, full);
      const g = new THREE.InstancedBufferGeometry();
      // `position` stays all zeros: drawn with any other material (an override pass), every triangle is empty.
      g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(12), 3));
      g.setAttribute("corner", new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      const inter = new THREE.InstancedInterleavedBuffer(data, 12);
      g.setAttribute("aBase", new THREE.InterleavedBufferAttribute(inter, 4, 0));
      g.setAttribute("aMotion", new THREE.InterleavedBufferAttribute(inter, 4, 4));
      g.setAttribute("aShape", new THREE.InterleavedBufferAttribute(inter, 4, 8));
      g.instanceCount = 0;
      const vec4s = () => Array.from({ length: MAXV }, () => new THREE.Vector4());
      const streak = f.length > 0;
      const color = new THREE.Color().setRGB(f.color[0] / 255, f.color[1] / 255, f.color[2] / 255, THREE.SRGBColorSpace);
      const m = new THREE.ShaderMaterial({
        name: `precipitation-${kind}`,
        defines: streak ? { STREAK: "" } : {},
        uniforms: {
          uTime: { value: 0 },
          uCam: { value: new THREE.Vector3() },
          uCamMod: { value: new THREE.Vector3() },
          uHalf: { value: new THREE.Vector3(...f.half) },
          uProj: { value: 500 },
          uMinPx: { value: f.minPixels },
          uLength: { value: f.length },
          uFall: { value: kind === "snowfall" ? 0 : STREAK_FALL[kind] },
          uNear: { value: new THREE.Vector2(...f.near) },
          uVolCount: { value: 0 },
          uVolMin: { value: vec4s() },
          uVolMax: { value: vec4s() },
          uVolGrid: { value: vec4s() },
          uColumns: { value: columns },
          uColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
          uAlpha: { value: f.alpha },
        },
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      if (fog) withDepthFog(m, fog);
      // The column map is a uniform, so disposeWorldTree (world-resources.ts) frees it through this list (attract.ts
      // drops a tour map's world with it; once, however many kinds share it).
      m.userData.ownedTextures = [columns];
      const mesh = new THREE.Mesh(g, m);
      mesh.name = `precipitation-${kind}`;
      mesh.frustumCulled = false;
      mesh.renderOrder = 4;
      mesh.visible = false;
      mesh.onBeforeRender = (renderer, _scene, camera) => {
        const target = renderer.getRenderTarget();
        const h = target ? target.height : renderer.getDrawingBufferSize(buffer).y;
        m.uniforms.uProj.value = (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5] * h * 0.5;
        m.uniformsNeedUpdate = true;
      };
      root.add(mesh);
      // Per-volume uniforms that never change (the active set is picked from these each frame).
      const draw: KindDraw = { kind, mesh, full, volumes: idx, share, dist: new Float32Array(idx.length), picked: new Int32Array(MAXV) };
      draws.push(draw);
    }
    built = { ms: performance.now() - t0, traces: cols.traces, cells: cols.layout.reduce((n, l) => n + l.cols * l.rows, 0), truncated: cols.truncated };
    console.info(
      `precipitation: ${volumes.length} volumes (${draws.map((d) => `${d.kind} ${d.full}`).join(", ")}), columns ${cols.width}x${cols.height}` +
        ` (${built.cells} cells, ${built.traces} traces${built.truncated ? ", budget hit" : ""}) in ${built.ms.toFixed(0)} ms`,
    );
    return cols;
  };
  let layout: ReturnType<typeof buildColumns>["layout"] = [];

  const apply = () => {
    for (const d of draws ?? []) d.mesh.geometry.instanceCount = Math.round(d.full * Math.min(1, Math.max(0, density)));
  };

  const pick = (d: KindDraw, cam: THREE.Vector3) => {
    const f = PRECIP_FIELDS[d.kind];
    const u = d.mesh.material.uniforms;
    let n = 0;
    for (let k = 0; k < d.volumes.length; k++) {
      const v = volumes[d.volumes[k]];
      // Distance from the camera's box to the volume's (0 when they overlap); beyond the box nothing of it draws.
      let gap = 0;
      // (Streaks: the footprint only; they fall around the eye whatever the volume's height.)
      for (let a = 0; a < (d.kind === "snowfall" ? 3 : 2); a++) {
        const c = a === 0 ? cam.x : a === 1 ? cam.y : cam.z;
        gap = Math.max(gap, v.min[a] - (c + f.half[a]), c - f.half[a] - v.max[a]);
      }
      d.dist[k] = gap;
      if (gap <= 0) n++;
    }
    // The (up to MAXV) overlapping volumes, nearest first when there are more.
    let count = 0;
    for (let s = 0; s < Math.min(n, MAXV); s++) {
      let best = -1;
      for (let k = 0; k < d.volumes.length; k++) if (d.dist[k] <= 0 && (best < 0 || d.dist[k] < d.dist[best])) best = k;
      if (best < 0) break;
      d.dist[best] = 1;
      const vi = d.volumes[best];
      const v = volumes[vi];
      const l = layout[vi];
      u.uVolMin.value[count].set(v.min[0], v.min[1], v.min[2], 1 / l.cell);
      u.uVolMax.value[count].set(v.max[0], v.max[1], v.max[2], d.share[best]);
      u.uVolGrid.value[count].set(l.x, l.y, l.cols, l.rows);
      count++;
    }
    u.uVolCount.value = count;
    return count;
  };

  return {
    root,
    volumes,
    counts: () => Object.fromEntries((draws ?? []).map((d) => [d.kind, d.mesh.geometry.instanceCount])),
    stats: () => built,
    setDensity(d) {
      density = Number.isFinite(d) ? Math.max(0, d) : 0;
      if (density > 0 && !draws) layout = build().layout;
      apply();
      if (density <= 0) for (const k of draws ?? []) k.mesh.visible = false;
    },
    setPotato(on) {
      potato = on;
      if (on) for (const k of draws ?? []) k.mesh.visible = false;
    },
    update(t) {
      time = Number.isFinite(t) ? t : 0;
      const wrapped = wrap(time, PRECIP_PERIOD);
      for (const d of draws ?? []) d.mesh.material.uniforms.uTime.value = wrapped;
    },
    observe(camera, world) {
      if (!draws) return;
      const on = density > 0 && !potato && (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true && !camera.userData.mirror;
      if (!on) {
        for (const d of draws) d.mesh.visible = false;
        return;
      }
      // The eye in Source space (the world root's frame).
      inverse.copy(world.matrixWorld).invert();
      camera.getWorldPosition(eye).applyMatrix4(inverse);
      for (const d of draws) {
        const visible = d.mesh.geometry.instanceCount > 0 && pick(d, eye) > 0;
        d.mesh.visible = visible;
        if (!visible) continue;
        const u = d.mesh.material.uniforms;
        const f = PRECIP_FIELDS[d.kind];
        u.uCam.value.copy(eye);
        u.uCamMod.value.set(wrap(eye.x, f.half[0] * 2), wrap(eye.y, f.half[1] * 2), wrap(eye.z, f.half[2] * 2));
      }
    },
    dispose() {
      for (const d of draws ?? []) {
        d.mesh.geometry.dispose();
        d.mesh.material.dispose();
      }
      columns?.dispose();
    },
  };
}
