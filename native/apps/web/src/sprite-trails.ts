// env_spritetrail (presentation only): the glowing ribbon a map hangs on a moving entity. CS:S draws one behind its
// attachment point whenever the parent moves: each point lives `lifetime` seconds, narrowing from `startwidth` to
// `endwidth` and fading as it ages. Maps use them as markers: bhop_2easy spins two blue laser trails around each
// stage-end teleport (a func_rotating with no faces), which is the only thing that shows where the teleport is.
//
// Trails follow their parent's brush transform (`brushOrigins()`, the same map world.update gets), so this needs no core
// support and works with any sim build. Trails on point entities (a weapon, a prop) never move here and draw nothing,
// as in CS:S on a still parent. The sprite material itself isn't loaded (hosted content has no sprites): the stock trail
// sprites are a white core in a soft glow, drawn additively, which a small generated profile reproduces. The glow takes
// its colour from the sprite's name (bluelaser1, purplelaser1, orangelight1, ...; white otherwise) and the whole trail
// is tinted by rendercolor, as Source does (bluelaser1 with rendercolor 255 0 0 is a thin red line).
//
//   const trails = spriteTrails(core.entities()); if (trails) root.add(trails.root)   (Source space, Z-up)
//   trails.update(transforms, performance.now() / 1000)                                  every rendered frame

import * as THREE from "three";
import { materialName } from "./map-effects/smoke";
import type { BrushTransform } from "./core";

/** Points kept per trail (CS:S keeps up to 64). */
const MAX_POINTS = 64;
/** A new point once the attachment moved this far (units) or this long passed (s) since the last one. */
const MIN_STEP = 2;
const MAX_GAP = 1 / 30;

interface Trail {
  model: number;
  entity: number;
  /** Attachment point in the parent's space (the trail's spawn origin, relative to the parent's spawn transform). */
  local: THREE.Vector3;
  life: number;
  startWidth: number;
  endWidth: number;
  /** rendercolor x renderamt (linear); fades with each point's age. */
  color: THREE.Color;
  /** The sprite's glow colour (linear). */
  glow: THREE.Color;
  /** Ring buffer of [x, y, z, time]. */
  points: Float32Array;
  head: number;
  count: number;
}

export interface SpriteTrails {
  /** Under the world's Z-up root. */
  root: THREE.Object3D;
  /** Trails that follow a brush entity. */
  count: number;
  maxLifetime: number;
  reset(): void;
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

/** Glow colour (sRGB) by sprite name; white for the plain lasers and beams. */
function glowColor(sprite: string): THREE.Color {
  const n = sprite.toLowerCase();
  const rgb = /blue/.test(n) ? [0.18, 0.55, 1] : /purple/.test(n) ? [0.62, 0.25, 1] : /orange|ember|fire/.test(n) ? [1, 0.55, 0.15] : [0.85, 0.85, 0.85];
  return new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
}

/** Across-the-ribbon profile of a sprite laser (linear): red = the white core, green = the glow around it. */
function laserTexture(): THREE.Texture {
  const w = 4;
  const h = 32;
  const data = new Uint8Array(w * h * 4);
  const lin = (v: number) => (v < 0.04045 ? v * 0.0773993808 : Math.pow(v * 0.9478672986 + 0.0521327014, 2.4)); // sRGB -> linear
  for (let y = 0; y < h; y++) {
    const d = Math.abs((y + 0.5) / h - 0.5) * 2; // 0 at the core, 1 at the edge
    const glow = lin(Math.max(0, 1 - d) ** 1.6);
    const core = lin(Math.max(0, 1 - d / 0.28) ** 2);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = core * 255;
      data[i + 1] = glow * 255;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

// View-space ribbon: each point is two vertices pushed apart across the trail's screen direction.
const VERTEX = /* glsl */ `
attribute vec3 neighbor;
attribute float side;
attribute float width;
attribute vec3 tint;
attribute vec3 glow;
varying vec3 vTint;
varying vec3 vGlow;
varying float vAcross;
void main() {
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  vec4 q = modelViewMatrix * vec4(neighbor, 1.0);
  vec3 along = q.xyz - p.xyz;
  // Perpendicular to the trail and to the line of sight.
  vec3 across = cross(along, p.xyz);
  float len = length(across);
  across = len > 1e-6 ? across / len : vec3(0.0, 1.0, 0.0);
  p.xyz += across * side * width * 0.5;
  vTint = tint;
  vGlow = glow;
  vAcross = side * 0.5 + 0.5;
  gl_Position = projectionMatrix * p;
}`;
const FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform bool authored;
varying vec3 vTint;
varying vec3 vGlow;
varying float vAcross;
void main() {
  vec4 sprite = texture2D(map, vec2(0.5, vAcross));
  if (authored) {
    gl_FragColor = vec4(sprite.rgb * vTint * sprite.a, 1.0);
    #include <colorspace_fragment>
    return;
  }
  vec2 profile = sprite.rg;
  vec3 c = (vec3(profile.r) + profile.g * vGlow) * vTint;
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

/** The map's env_spritetrails that hang on a brush entity, or null if there are none. */
export function spriteTrails(entities: Record<string, string>[], texture?: (name: string) => THREE.Texture | null): SpriteTrails | null {
  entities = entities.map((e, i) => ({ ...e, __effectEntityIndex: e.__effectEntityIndex ?? String(i) }));
  const names = [...new Set(entities.filter(e => key(e, "classname")?.toLowerCase() === "env_spritetrail").map(e => materialName(key(e, "spritename") ?? "")))];
  if (names.length > 1) {
    const groups = names.map(name => spriteTrails(entities.filter(e => key(e, "classname")?.toLowerCase() !== "env_spritetrail" || materialName(key(e, "spritename") ?? "") === name), texture)).filter((v): v is SpriteTrails => !!v);
    if (!groups.length) return null;
    const root = new THREE.Group(); groups.forEach(g => root.add(g.root));
    return { root, count: groups.reduce((n, g) => n + g.count, 0), maxLifetime: Math.max(...groups.map(g => g.maxLifetime)), reset() { groups.forEach(g => g.reset()); }, update(transforms, time, states) { groups.forEach(g => g.update(transforms, time, states)); } };
  }
  const byName = new Map<string, Record<string, string>>();
  for (const e of entities) {
    const n = key(e, "targetname");
    if (n && !byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), e);
  }
  const trails: Trail[] = [];
  const inv = new THREE.Matrix4();
  for (const e of entities) {
    if (key(e, "classname")?.toLowerCase() !== "env_spritetrail") continue;
    const parent = byName.get((key(e, "parentname") ?? "").split(",")[0].toLowerCase());
    const model = parent && /^\*\d+$/.test(key(parent, "model") ?? "") ? Number(key(parent, "model")!.slice(1)) : -1;
    if (model < 0) continue;
    const po = vec(key(parent!, "origin"));
    const pa = vec(key(parent!, "angles"));
    const o = vec(key(e, "origin"));
    inv.copy(rotation(pa[0], pa[1], pa[2])).transpose();
    const local = new THREE.Vector3(o[0] - po[0], o[1] - po[1], o[2] - po[2]).applyMatrix4(inv);
    const c = vec(key(e, "rendercolor") ?? "255 255 255");
    trails.push({
      model,
      entity: Number(e.__effectEntityIndex ?? entities.indexOf(e)),
      local,
      life: Math.max(0.05, num(key(e, "lifetime"), 1)),
      startWidth: num(key(e, "startwidth"), 8),
      endWidth: num(key(e, "endwidth"), 1),
      color: new THREE.Color()
        .setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace)
        .multiplyScalar(Math.min(1, Math.max(0, num(key(e, "renderamt"), 255) / 255))),
      glow: glowColor(key(e, "spritename") ?? ""),
      points: new Float32Array(MAX_POINTS * 4),
      head: 0,
      count: 0,
    });
  }
  if (!trails.length) return null;

  // One geometry for all trails: per point two vertices, per segment two triangles.
  const verts = trails.length * MAX_POINTS * 2;
  const pos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const nbr = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const width = new THREE.BufferAttribute(new Float32Array(verts), 1).setUsage(THREE.DynamicDrawUsage);
  const tint = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
  // Per trail, constant: written once.
  const glow = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
  trails.forEach((t, k) => {
    for (let v = k * MAX_POINTS * 2; v < (k + 1) * MAX_POINTS * 2; v++) t.glow.toArray(glow.array, v * 3);
  });
  const side = new THREE.BufferAttribute(new Float32Array(verts), 1);
  for (let v = 0; v < verts; v++) side.array[v] = v & 1 ? 1 : -1;
  const index = new Uint32Array(trails.length * (MAX_POINTS - 1) * 6);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", pos);
  geo.setAttribute("neighbor", nbr);
  geo.setAttribute("width", width);
  geo.setAttribute("tint", tint);
  geo.setAttribute("glow", glow);
  geo.setAttribute("side", side);
  geo.setIndex(new THREE.BufferAttribute(index, 1).setUsage(THREE.DynamicDrawUsage));

  const authored = texture?.(names[0] ?? "") ?? null;
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: authored ?? laserTexture() }, authored: { value: !!authored } },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  if (!authored) mat.addEventListener("dispose", () => mat.uniforms.map.value.dispose());
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = "env_spritetrail";
  mesh.renderOrder = 2;

  const m = new THREE.Matrix4();
  const at = new THREE.Vector3();
  return {
    root: mesh,
    count: trails.length,
    maxLifetime: Math.max(...trails.map(t => t.life)),
    reset() { for (const t of trails) { t.count = 0; t.head = 0; } },
    update(transforms, now, states) {
      let n = 0; // indices written
      for (let k = 0; k < trails.length; k++) {
        const t = trails[k];
        const tf = transforms.get(t.model);
        // Hidden or killed parents take their trail with them.
        if (tf && states?.get(t.entity) !== false && !(tf.length > 6 && tf[6] === 0)) {
          rotation(tf[3], tf[4], tf[5], m);
          at.copy(t.local).applyMatrix4(m);
          const x = at.x + tf[0];
          const y = at.y + tf[1];
          const z = at.z + tf[2];
          const last = t.count ? (t.head + MAX_POINTS - 1) % MAX_POINTS : -1;
          const P = t.points;
          const moved = last < 0 ? Infinity : Math.hypot(x - P[last * 4], y - P[last * 4 + 1], z - P[last * 4 + 2]);
          if (moved > 0.01) {
            // The newest point follows the attachment; it stays behind as a new point once it is MIN_STEP units or
            // MAX_GAP s past the one before it (whatever the frame rate).
            const anchor = t.count >= 2 ? (t.head + MAX_POINTS - 2) % MAX_POINTS : -1;
            const fresh =
              anchor < 0 ||
              Math.hypot(x - P[anchor * 4], y - P[anchor * 4 + 1], z - P[anchor * 4 + 2]) >= MIN_STEP ||
              now - P[anchor * 4 + 3] >= MAX_GAP;
            const i = fresh ? t.head : last;
            P[i * 4] = x;
            P[i * 4 + 1] = y;
            P[i * 4 + 2] = z;
            P[i * 4 + 3] = now;
            if (fresh) {
              t.head = (t.head + 1) % MAX_POINTS;
              t.count = Math.min(MAX_POINTS, t.count + 1);
            }
          }
        } else t.count = 0;
        // Drop expired points (oldest first).
        while (t.count && now - t.points[((t.head - t.count + MAX_POINTS) % MAX_POINTS) * 4 + 3] > t.life) t.count--;
        // Write the live points, newest first, then the segments between them.
        const base = k * MAX_POINTS;
        const P = t.points;
        for (let j = 0; j < t.count; j++) {
          const i = (t.head - 1 - j + MAX_POINTS * 2) % MAX_POINTS;
          const nb = j + 1 < t.count ? (t.head - 2 - j + MAX_POINTS * 2) % MAX_POINTS : (t.head + MAX_POINTS * 2 - j) % MAX_POINTS;
          const age = Math.min(1, Math.max(0, (now - P[i * 4 + 3]) / t.life));
          const w = t.startWidth + (t.endWidth - t.startWidth) * age;
          const f = 1 - age;
          for (const s of [0, 1]) {
            const v = (base + j) * 2 + s;
            pos.array[v * 3] = P[i * 4];
            pos.array[v * 3 + 1] = P[i * 4 + 1];
            pos.array[v * 3 + 2] = P[i * 4 + 2];
            // The neighbour gives the trail's direction here (the previous segment's for the tail point, mirrored).
            const sign = j + 1 < t.count ? 1 : -1;
            nbr.array[v * 3] = P[i * 4] + sign * (P[nb * 4] - P[i * 4]);
            nbr.array[v * 3 + 1] = P[i * 4 + 1] + sign * (P[nb * 4 + 1] - P[i * 4 + 1]);
            nbr.array[v * 3 + 2] = P[i * 4 + 2] + sign * (P[nb * 4 + 2] - P[i * 4 + 2]);
            width.array[v] = w;
            tint.array[v * 3] = t.color.r * f;
            tint.array[v * 3 + 1] = t.color.g * f;
            tint.array[v * 3 + 2] = t.color.b * f;
          }
          if (j + 1 < t.count) {
            const a = (base + j) * 2;
            const b = a + 2;
            index[n++] = a;
            index[n++] = a + 1;
            index[n++] = b;
            index[n++] = b;
            index[n++] = a + 1;
            index[n++] = b + 1;
          }
        }
      }
      geo.setDrawRange(0, n);
      pos.needsUpdate = nbr.needsUpdate = width.needsUpdate = tint.needsUpdate = true;
      geo.index!.needsUpdate = true;
      mesh.visible = n > 0;
    },
  };
}
