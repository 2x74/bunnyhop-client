// Authored Crash Egypt PCF subset, extracted from the exact packed BSP (tools/crash-egypt/particles.py).
// No particle simulation feeds back into the core. Each sprite is sampled from its entity's Start tick;
// seeks, live play and exports therefore use the same positions, colours and sprite-sheet frame.
import * as THREE from "three";
import definitions from "./crash-particles.json";
import { particleRandom, materialName } from "./smoke";
import {
  PROP_TRANSFORM_KEY,
  type BrushTransform,
  type PropAnimState,
} from "../core";

type Params = Record<string, string>;
interface Definition {
  material: string;
  additive?: boolean;
  initializers: Record<string, Params>;
  operators: Record<string, Params>;
  emitters: Record<string, Params>;
  renderers: Record<string, Params>;
  children: { child: string; delay: string }[];
  sheet?: Record<
    string,
    { duration: number; clamp: boolean; frames: number[][] }
  >;
}
const systems = definitions as unknown as Record<string, Definition>;
export const CRASH_BSP_SHA =
  "c2b3bc1e5a3f2507df4b7aa6ed71af7c2ac38edb12c41939547d25268ec9613e";
export const crashParticleMaterials = () => [
  ...new Set(
    Object.values(systems).map((s) =>
      materialName(s.material.replaceAll("\\", "/")),
    ),
  ),
];
const num = (p: Params | undefined, k: string, fallback = 0) =>
  Number.isFinite(Number(p?.[k])) ? Number(p![k]) : fallback;
const vec = (s: string | undefined, fallback = "0 0 0") =>
  (s ?? fallback).split(/\s+/).map(Number).slice(0, 3);
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const fraction = (t: number, a: number, b: number) =>
  a === b ? +(t >= b) : clamp((t - a) / (b - a));
const ease = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export interface ParticleSample {
  position: number[];
  velocity: number[];
  radius: number;
  alpha: number;
  color: number[];
  roll: number;
  uv: number[];
  trail: number;
}

/** A packed PCF leaf's finite emission schedule. All of this build's reachable emitters are finite. */
export function particleBirths(name: string): number[] {
  const s = systems[name];
  if (!s) return [];
  return Object.entries(s.emitters).flatMap(([kind, p]) => {
    const start = num(p, "emission_start_time");
    const rate = num(p, "emission_rate");
    const count =
      kind === "emit_instantaneously"
        ? num(p, "num_to_emit")
        : Math.floor(rate * num(p, "emission_duration") + 1e-5);
    return Array.from(
      { length: Math.min(512, Math.max(0, count)) },
      (_, i) => start + (kind === "emit_instantaneously" ? 0 : (i + 1) / rate),
    );
  });
}

export function sampleCrashParticle(
  name: string,
  index: number,
  age: number,
  seed: number,
  angles: readonly number[] = [0, 0, 0],
): ParticleSample | null {
  const s = systems[name];
  if (!s || age < 0) return null;
  const I = s.initializers,
    O = s.operators;
  const rand = (k: number) =>
    particleRandom(seed ^ Math.imul(index + 1, 0x9e3779b9), k);
  const range = (
    p: Params | undefined,
    a: string,
    b: string,
    k: number,
    fallback = 0,
    exponent = 1,
  ) => lerp(num(p, a, fallback), num(p, b, fallback), rand(k) ** exponent);
  const life = range(
    I["Lifetime Random"],
    "lifetime_min",
    "lifetime_max",
    0,
    1,
  );
  if (age >= life || life <= 0) return null;
  const t = age / life;
  const P = I["Position Within Sphere Random"],
    B = I["Position Within Box Random"];
  const z = rand(1) * 2 - 1,
    a = rand(2) * Math.PI * 2,
    xy = Math.sqrt(1 - z * z);
  const direction = [z, xy * Math.cos(a), xy * Math.sin(a)];
  const distance = range(P, "distance_min", "distance_max", 3);
  const bias = vec(P?.distance_bias, "1 1 1");
  const position = direction.map((v, i) => v * distance * bias[i]);
  const lo = vec(P?.speed_in_local_coordinate_system_min),
    hi = vec(P?.speed_in_local_coordinate_system_max);
  const speed = range(P, "speed_min", "speed_max", 4);
  const rotationMatrix = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(
      (angles[2] * Math.PI) / 180,
      (angles[0] * Math.PI) / 180,
      (angles[1] * Math.PI) / 180,
      "ZYX",
    ),
  );
  const localSpeed = new THREE.Vector3(
    ...(lo.map((v, i) => lerp(v, hi[i], rand(5 + i))) as [
      number,
      number,
      number,
    ]),
  ).applyMatrix4(rotationMatrix);
  const velocity = lo.map(
    (v, i) => localSpeed.getComponent(i) + direction[i] * speed,
  );
  if (B) {
    const min = vec(B.min),
      max = vec(B.max);
    for (let i = 0; i < 3; i++)
      position[i] += lerp(min[i], max[i], rand(8 + i));
  }
  const offset = I["Position Modify Offset Random"];
  if (offset) {
    const min = vec(offset["offset min"]),
      max = vec(offset["offset max"]);
    const off = new THREE.Vector3(
      ...(min.map((v, i) => lerp(v, max[i], rand(11 + i))) as [
        number,
        number,
        number,
      ]),
    );
    if (num(offset, "offset in local space 0/1"))
      off.applyMatrix4(rotationMatrix);
    for (let i = 0; i < 3; i++) position[i] += off.getComponent(i);
  }
  const move = O["Movement Basic"],
    gravity = vec(move?.gravity),
    drag = num(move, "drag");
  const travel = drag > 0 ? -Math.expm1(-drag * age) / drag : age;
  for (let i = 0; i < 3; i++)
    position[i] += velocity[i] * travel + (gravity[i] * age * age) / 2;
  const radius = range(I["Radius Random"], "radius_min", "radius_max", 14, 5);
  const scale = O["Radius Scale"];
  let rt = fraction(t, num(scale, "start_time"), num(scale, "end_time", 1));
  if (num(scale, "ease_in_and_out")) rt = ease(rt);
  else {
    const bias = num(scale, "scale_bias", 0.5);
    if (bias > 0 && bias < 1) rt = rt ** (Math.log(bias) / Math.log(0.5));
  }
  const r =
    radius *
    lerp(
      num(scale, "radius_start_scale", 1),
      num(scale, "radius_end_scale", 1),
      rt,
    );
  const A = O["Alpha Fade and Decay"];
  const fadeIn = fraction(
    t,
    num(A, "start_fade_in_time"),
    num(A, "end_fade_in_time"),
  );
  const fadeOut = fraction(
    t,
    num(A, "start_fade_out_time", 1),
    num(A, "end_fade_out_time", 1),
  );
  let alpha = range(I["Alpha Random"], "alpha_min", "alpha_max", 15, 255) / 255;
  alpha *=
    lerp(num(A, "start_alpha", 1), 1, fadeIn) *
    lerp(1, num(A, "end_alpha"), fadeOut);
  const C = I["Color Random"],
    c1 = vec(C?.color1, "255 255 255"),
    c2 = vec(C?.color2, "255 255 255");
  const color = c1.map((v, i) => lerp(v, c2[i], rand(16)) / 255);
  const fade = O["Color Fade"],
    target = vec(fade?.color_fade, "255 255 255");
  let ct = fraction(
    t,
    num(fade, "fade_start_time"),
    num(fade, "fade_end_time", 1),
  );
  if (num(fade, "ease_in_and_out")) ct = ease(ct);
  if (fade)
    for (let i = 0; i < 3; i++) color[i] = lerp(color[i], target[i] / 255, ct);
  const osc = O["Oscillate Scalar"];
  if (osc && num(osc, "oscillation field") === 4)
    alpha *= clamp(
      1 +
        range(osc, "oscillation rate min", "oscillation rate max", 17) *
          Math.sin(
            (t *
              num(osc, "oscillation frequency min") *
              num(osc, "oscillation multiplier", 2) +
              num(osc, "oscillation start phase")) *
              Math.PI,
          ),
    );
  const spin = I["Rotation Speed Random"],
    rotation = I["Rotation Random"];
  const roll =
    range(rotation, "rotation_offset_min", "rotation_offset_max", 18) +
    num(rotation, "rotation_initial") +
    age *
      (range(
        spin,
        "rotation_speed_random_min",
        "rotation_speed_random_max",
        19,
      ) +
        num(spin, "rotation_speed_constant") +
        num(O["Rotation Spin Roll"], "spin_rate_degrees"));
  let uv = [0, 0, 1, 1];
  const sequence = Math.floor(
    range(I["Sequence Random"], "sequence_min", "sequence_max", 20) + 0.5,
  );
  const sheet = s.sheet?.[String(sequence)];
  if (sheet?.frames.length) {
    const render = s.renderers.render_animated_sprites;
    const frame = num(render, "animation_fit_lifetime")
      ? Math.floor(t * sheet.frames.length)
      : Math.floor(age * num(render, "animation rate", 1));
    uv =
      sheet.frames[
        sheet.clamp
          ? Math.min(sheet.frames.length - 1, frame)
          : frame % sheet.frames.length
      ].slice(1);
  }
  return {
    position,
    velocity,
    radius: r,
    alpha: clamp(alpha),
    color,
    roll: (roll * Math.PI) / 180,
    uv,
    trail: range(I["Trail Length Random"], "length_min", "length_max", 21),
  };
}

const vertex = `
attribute vec3 center; attribute vec4 tint; attribute vec4 rect; attribute vec4 shape; attribute vec3 velocity;
varying vec2 vUv; varying vec4 vTint;
void main(){
 vec4 c=modelViewMatrix*vec4(center,1.); vec2 q=position.xy;
 float cs=cos(shape.y), sn=sin(shape.y); q=mat2(cs,-sn,sn,cs)*q;
 if(shape.z>0.){ vec2 d=(modelViewMatrix*vec4(velocity,0.)).xy; float len=length(d); d=len>0.?d/len:vec2(0.,1.); q=vec2(-d.y,d.x)*q.x+d*q.y*max(1.,shape.z/max(shape.x,.01)); }
 if(shape.w>0.) gl_Position=projectionMatrix*(modelViewMatrix*vec4(center+vec3(q*shape.x,0.),1.));
 else {c.xy+=q*shape.x;gl_Position=projectionMatrix*c;}
 vUv=mix(rect.xy,rect.zw,vec2(uv.x,1.-uv.y));vTint=tint;
}`;
const fragment = `uniform sampler2D map; varying vec2 vUv; varying vec4 vTint; void main(){vec4 p=texture2D(map,vUv)*vTint;if(p.a<.002)discard;gl_FragColor=p;
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`;

export function crashExplosions(
  entities: Record<string, string>[],
  texture: (material: string) => THREE.Texture | null,
) {
  const source = new Map<number, string>();
  entities.forEach((e, i) => {
    if (
      e.classname === "info_particle_system" &&
      ["Explosion_Tnt", "Explosion_Nitro"].includes(e.effect_name)
    )
      source.set(i, e.effect_name);
  });
  if (!source.size) return null;
  const root = new THREE.Group();
  root.name = "crash-authored-explosions";
  const leaves = (
    name: string,
    delay = 0,
  ): { name: string; delay: number }[] => [
    { name, delay },
    ...systems[name].children.flatMap((c) =>
      leaves(c.child, delay + Number(c.delay)),
    ),
  ];
  const events = new Map<
    number,
    {
      since: number;
      name: string;
      group: THREE.Group;
      batches: {
        name: string;
        delay: number;
        births: number[];
        geo: THREE.InstancedBufferGeometry;
      }[];
    }
  >();
  const make = (entity: number, since: number, name: string) => {
    const group = new THREE.Group();
    const batches: {
      name: string;
      delay: number;
      births: number[];
      geo: THREE.InstancedBufferGeometry;
    }[] = [];
    for (const leaf of leaves(name)) {
      const d = systems[leaf.name],
        births = particleBirths(leaf.name),
        map = texture(materialName(d.material.replaceAll("\\", "/")));
      if (!births.length || !map) continue; // no invented texture for unavailable/refractive materials
      const base = new THREE.PlaneGeometry(2, 2),
        geo = new THREE.InstancedBufferGeometry();
      geo.index = base.index;
      geo.attributes = base.attributes;
      for (const [key, size] of [
        ["center", 3],
        ["tint", 4],
        ["rect", 4],
        ["shape", 4],
        ["velocity", 3],
      ] as const)
        geo.setAttribute(
          key,
          new THREE.InstancedBufferAttribute(
            new Float32Array(births.length * size),
            size,
          ),
        );
      geo.instanceCount = births.length;
      const additive = d.additive === true;
      const mat = new THREE.ShaderMaterial({
        uniforms: { map: { value: map } },
        vertexShader: vertex,
        fragmentShader: fragment,
        transparent: true,
        depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.raycast = () => {};
      group.add(mesh);
      batches.push({ ...leaf, births, geo });
    }
    root.add(group);
    const event = { since, name, group, batches };
    events.set(entity, event);
    return event;
  };
  const remove = (entity: number) => {
    const e = events.get(entity)!;
    e.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
    e.group.removeFromParent();
    events.delete(entity);
  };
  return {
    root,
    update(
      transforms: Map<number, BrushTransform>,
      now: number,
      states?: readonly PropAnimState[] | null,
    ) {
      const alive = new Set<number>();
      for (const state of states ?? []) {
        const tr = transforms.get(PROP_TRANSFORM_KEY + state.entity);
        const original =
          tr?.[7] === undefined ? state.entity : tr[7] - PROP_TRANSFORM_KEY;
        const name = source.get(original);
        if (
          !name ||
          !state.set ||
          state.removed ||
          now < state.since ||
          now - state.since > 3
        )
          continue;
        alive.add(state.entity);
        let event = events.get(state.entity);
        if (event && (event.since !== state.since || event.name !== name)) {
          remove(state.entity);
          event = undefined;
        }
        event ??= make(state.entity, state.since, name);
        const origin = tr ?? vec(entities[original].origin),
          angles = tr?.slice(3, 6) ?? vec(entities[original].angles);
        event.group.position.set(origin[0], origin[1], origin[2]);
        // CP's local x axis is the map's particle direction (pitch -90 points it up).
        for (const batch of event.batches) {
          let count = 0;
          const attrs = batch.geo.attributes;
          batch.births.forEach((born, i) => {
            const p = sampleCrashParticle(
              batch.name,
              i,
              now - state.since - batch.delay - born,
              Math.imul(state.entity + 1, 31) ^ Math.round(state.since * 1000),
              angles,
            );
            if (!p) return;
            const pos = new THREE.Vector3(
                ...(p.position as [number, number, number]),
              ),
              vel = new THREE.Vector3(
                ...(p.velocity as [number, number, number]),
              );
            (attrs.center as THREE.InstancedBufferAttribute).setXYZ(
              count,
              pos.x,
              pos.y,
              pos.z,
            );
            (attrs.velocity as THREE.InstancedBufferAttribute).setXYZ(
              count,
              vel.x,
              vel.y,
              vel.z,
            );
            (attrs.tint as THREE.InstancedBufferAttribute).setXYZW(
              count,
              p.color[0],
              p.color[1],
              p.color[2],
              p.alpha,
            );
            (attrs.rect as THREE.InstancedBufferAttribute).setXYZW(
              count,
              p.uv[0],
              p.uv[1],
              p.uv[2],
              p.uv[3],
            );
            const R = systems[batch.name].renderers;
            const trail = R.render_sprite_trail
              ? Math.min(
                  num(R.render_sprite_trail, "max length", 512),
                  Math.max(
                    num(R.render_sprite_trail, "min length", 0),
                    Math.hypot(...p.velocity) * p.trail,
                  ),
                )
              : 0;
            (attrs.shape as THREE.InstancedBufferAttribute).setXYZW(
              count,
              p.radius,
              p.roll,
              trail,
              num(R.render_animated_sprites, "orientation_type") === 2 ? 1 : 0,
            );
            count++;
          });
          batch.geo.instanceCount = count;
          for (const a of Object.values(attrs))
            if (a instanceof THREE.InstancedBufferAttribute)
              a.needsUpdate = true;
        }
      }
      for (const id of events.keys()) if (!alive.has(id)) remove(id);
    },
  };
}
