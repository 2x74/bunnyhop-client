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
  radius?: string;
  color?: string;
  spriteCard?: boolean;
  addSelf?: number;
  overbright?: number;
  blendFrames?: boolean;
  startFadeSize?: number;
  endFadeSize?: number;
  maxSize?: number;
  normalMap?: string;
  refractAmount?: number;
  "Sort particles"?: string;
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
  uvNext: number[];
  frameBlend: number;
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
  const radius = range(
    I["Radius Random"],
    "radius_min",
    "radius_max",
    14,
    Number(s.radius ?? 5),
  );
  const scale = O["Radius Scale"];
  let rt = fraction(t, num(scale, "start_time"), num(scale, "end_time", 1));
  if (num(scale, "ease_in_and_out")) rt = ease(rt);
  else {
    const bias = num(scale, "scale_bias", 0.5);
    if (bias > 0 && bias < 1) rt = rt / ((1 / bias - 2) * (1 - rt) + 1);
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
  // Source fades are splines; the fade-out operator overwrites the fade-in result.
  if (t < num(A, "end_fade_in_time"))
    alpha *= lerp(num(A, "start_alpha", 1), 1, ease(fadeIn));
  else if (t >= num(A, "start_fade_out_time", 1))
    alpha *= lerp(1, num(A, "end_alpha"), ease(fadeOut));
  const C = I["Color Random"],
    c1 = vec(C?.color1, s.color ?? "255 255 255"),
    c2 = vec(C?.color2, s.color ?? "255 255 255");
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
  let uv = [0, 0, 1, 1],
    uvNext = uv,
    frameBlend = 0;
  const sequence = Math.floor(
    range(I["Sequence Random"], "sequence_min", "sequence_max", 20) + 0.5,
  );
  const sheet = s.sheet?.[String(sequence)];
  if (sheet?.frames.length) {
    const render = s.renderers.render_animated_sprites;
    let cycles = num(render, "animation_fit_lifetime")
      ? t
      : age * num(render, "animation rate", 1);
    if (
      !num(render, "animation_fit_lifetime") &&
      num(render, "use animation rate as FPS")
    )
      cycles /= sheet.duration;
    let at = (sheet.clamp ? clamp(cycles) : cycles % 1) * sheet.duration;
    let frame = 0;
    while (frame < sheet.frames.length - 1 && at >= sheet.frames[frame][0])
      at -= sheet.frames[frame++][0];
    uv = sheet.frames[frame].slice(1);
    const next = sheet.clamp
      ? Math.min(frame + 1, sheet.frames.length - 1)
      : (frame + 1) % sheet.frames.length;
    uvNext = sheet.frames[next].slice(1);
    frameBlend = s.blendFrames ? clamp(at / sheet.frames[frame][0]) : 0;
  }
  return {
    position,
    velocity,
    radius: r,
    alpha: clamp(alpha),
    color,
    roll: (roll * Math.PI) / 180,
    uv,
    uvNext,
    frameBlend,
    trail: range(I["Trail Length Random"], "length_min", "length_max", 21),
  };
}

/** Source sprite trails have a head at the particle and a single tail, not a centred card. */
export function crashTrailShape(name: string, p: ParticleSample, age: number) {
  const r = systems[name].renderers.render_sprite_trail;
  if (!r) return { length: 0, width: p.radius * 2 };
  const fade = num(r, "length fade in time");
  const raw =
    Math.hypot(...p.velocity) *
    p.trail *
    (fade > 0 ? Math.min(1, age / fade) : 1);
  const length =
    raw > 0
      ? Math.min(num(r, "max length", 512), Math.max(num(r, "min length"), raw))
      : 0;
  return { length, width: Math.min(p.radius, length) };
}
const vertex = `
attribute vec3 center; attribute vec4 tint; attribute vec4 rect; attribute vec4 rectNext; attribute float frameBlend; attribute vec4 shape; attribute vec3 velocity;
uniform vec3 sizeFade;
varying vec2 vUv; varying vec2 vUvNext; varying float vFrameBlend; varying vec4 vTint;
void main(){
 vec4 c=modelViewMatrix*vec4(center,1.); vec2 q=position.xy;
 // SpriteCard receives gamma-encoded particle tint; texture samples are linear.
 vTint=vec4(pow(max(tint.rgb,vec3(0.)),vec3(2.2)),tint.a);
 float radius=shape.x;
 float distanceToEye=length(c.xyz);
 float fade=1.-clamp((radius-sizeFade.x*distanceToEye)/max(.0001,(sizeFade.y-sizeFade.x)*distanceToEye),0.,1.);
 vTint*=fade;
 radius=min(radius,sizeFade.z*distanceToEye);
 if(shape.z>0.){
   vec2 d=(modelViewMatrix*vec4(velocity,0.)).xy; float len=length(d); d=len>0.?d/len:vec2(0.,1.);
   c.xy+=vec2(-d.y,d.x)*q.x*shape.x*.5+d*(q.y-1.)*.5*shape.z;
   gl_Position=projectionMatrix*c;
 } else {
   float cs=cos(shape.y), sn=sin(shape.y); q=mat2(cs,-sn,sn,cs)*q;
   if(shape.w>0.) gl_Position=projectionMatrix*(modelViewMatrix*vec4(center+vec3(q*radius,0.),1.));
   else {c.xy+=q*radius;gl_Position=projectionMatrix*c;}
 }
 vec2 tex=vec2(uv.x,1.-uv.y);
 vUv=mix(rect.xy,rect.zw,tex);vUvNext=mix(rectNext.xy,rectNext.zw,tex);vFrameBlend=frameBlend;
}`;
const fragment = `uniform sampler2D map; uniform float addSelf; uniform float overbright;
varying vec2 vUv; varying vec2 vUvNext; varying float vFrameBlend; varying vec4 vTint;
void main(){
 vec4 p=mix(texture2D(map,vUv),texture2D(map,vUvNext),vFrameBlend);
 p.rgb*=overbright;
 p.a*=vTint.a;
 if(addSelf>0.) p.rgb*=p.a*(1.+overbright*addSelf*vTint.a);
 p.rgb*=vTint.rgb;
 if(p.a<.002)discard;gl_FragColor=p;
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`;

// One shared GPU colour resolve per view, even when several crates explode together. Works with the multisampled HDR/export target too.
// This deliberately refracts the actual scene, with no invented magenta tint or extra scene render.
const warpFragment = `uniform sampler2D map; uniform sampler2D sceneMap; uniform vec2 sceneSize;
uniform float refractAmount; uniform bool sceneSrgb;
varying vec2 vUv; varying vec4 vTint;
void main(){
 vec4 normal=texture2D(map,vUv);
 vec2 coord=gl_FragCoord.xy/sceneSize;
 vec2 offset=(normal.rg*2.-1.)*normal.a*refractAmount*vTint.a;
 vec4 p=texture2D(sceneMap,clamp(coord+offset,vec2(0.),vec2(1.)));
 if(sceneSrgb) p=sRGBTransferEOTF(p);
 gl_FragColor=vec4(p.rgb,1.);
 #include <colorspace_fragment>
}`;
function sceneWarp() {
  let copy: THREE.WebGLRenderTarget | undefined;
  let users = 0,
    frame = -1;
  let lastRenderer: THREE.WebGLRenderer | undefined;
  let lastCamera: THREE.Camera | undefined;
  let lastTarget: THREE.WebGLRenderTarget | null | undefined;
  return (
    mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>,
  ) => {
    users++;
    mesh.material.addEventListener("dispose", () => {
      if (--users === 0) {
        copy?.dispose();
        copy = undefined;
        frame = -1;
      }
    });
    mesh.onBeforeRender = (renderer, _scene, camera) => {
      const target = renderer.getRenderTarget();
      const size = target
        ? new THREE.Vector2(target.width, target.height)
        : renderer.getDrawingBufferSize(new THREE.Vector2());
      const type = target?.texture.type ?? THREE.UnsignedByteType;
      if (
        !copy ||
        copy.width !== size.x ||
        copy.height !== size.y ||
        copy.texture.type !== type
      ) {
        copy?.dispose();
        frame = -1;
        copy = new THREE.WebGLRenderTarget(size.x, size.y, {
          type,
          depthBuffer: false,
          stencilBuffer: false,
        });
      }
      if (
        lastRenderer !== renderer ||
        frame !== renderer.info.render.frame ||
        lastCamera !== camera ||
        lastTarget !== target
      ) {
        const gl = renderer.getContext() as WebGL2RenderingContext,
          draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
          read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
        const face = renderer.getActiveCubeFace(),
          mip = renderer.getActiveMipmapLevel();
        renderer.setRenderTarget(copy);
        // FRAMEBUFFER binds change READ too; explicitly synchronize Three's separate READ cache.
        renderer.state.bindFramebuffer(
          gl.READ_FRAMEBUFFER,
          gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
        );
        renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, draw);
        gl.blitFramebuffer(
          0,
          0,
          size.x,
          size.y,
          0,
          0,
          size.x,
          size.y,
          gl.COLOR_BUFFER_BIT,
          gl.NEAREST,
        );
        renderer.setRenderTarget(target, face, mip);
        renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
        lastRenderer = renderer;
        frame = renderer.info.render.frame;
        lastCamera = camera;
        lastTarget = target;
      }
      mesh.material.uniforms.sceneMap.value = copy.texture;
      mesh.material.uniforms.sceneSize.value.copy(size);
      mesh.material.uniforms.sceneSrgb.value =
        !target && renderer.outputColorSpace === THREE.SRGBColorSpace;
    };
  };
}
// Sort only the PCF leaves that request it, separately for each render/export camera.
function sortParticles(
  mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>,
  camera: THREE.Camera,
) {
  const matrix = new THREE.Matrix4(),
    point = new THREE.Vector3();
  matrix.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
  const geo = mesh.geometry,
    centers = geo.attributes.center;
  const order = Array.from({ length: geo.instanceCount }, (_, i) => ({
    i,
    z: point.fromBufferAttribute(centers, i).applyMatrix4(matrix).z,
  }));
  order.sort((a, b) => a.z - b.z || a.i - b.i);
  for (const a of Object.values(geo.attributes))
    if (a instanceof THREE.InstancedBufferAttribute) {
      const original = a.array.slice();
      order.forEach(({ i }, j) => {
        for (let k = 0; k < a.itemSize; k++)
          a.array[j * a.itemSize + k] = original[i * a.itemSize + k];
      });
      a.needsUpdate = true;
    }
}

export function crashExplosions(
  entities: Record<string, string>[],
  texture: (material: string) => THREE.Texture | null,
  normalTexture?: (path: string) => THREE.Texture | null,
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
  const attachWarp = sceneWarp();
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
        map = d.normalMap
          ? normalTexture?.(d.normalMap)
          : texture(materialName(d.material.replaceAll("\\", "/")));
      if (!births.length || !map) continue; // no invented texture for unavailable materials
      const base = new THREE.PlaneGeometry(2, 2),
        geo = new THREE.InstancedBufferGeometry();
      geo.index = base.index;
      geo.attributes = base.attributes;
      for (const [key, size] of [
        ["center", 3],
        ["tint", 4],
        ["rect", 4],
        ["rectNext", 4],
        ["frameBlend", 1],
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
        uniforms: {
          map: { value: map },
          addSelf: { value: d.addSelf ?? 0 },
          overbright: { value: d.overbright ?? 1 },
          sizeFade: {
            value: new THREE.Vector3(
              d.startFadeSize ?? 10,
              d.endFadeSize ?? 20,
              d.maxSize ?? 20,
            ),
          },
          sceneMap: { value: null },
          sceneSize: { value: new THREE.Vector2() },
          sceneSrgb: { value: false },
          refractAmount: { value: d.refractAmount ?? 0 },
        },
        vertexShader: vertex,
        fragmentShader: d.normalMap ? warpFragment : fragment,
        toneMapped: !d.normalMap,
        transparent: true,
        depthWrite: false,
        blending: d.normalMap
          ? THREE.NoBlending
          : d.addSelf
            ? THREE.CustomBlending
            : additive
              ? THREE.AdditiveBlending
              : THREE.NormalBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = leaf.name;
      // Preserve the PCF child order across differing material blend modes.
      mesh.renderOrder = 10 + batches.length;
      mesh.frustumCulled = false;
      mesh.raycast = () => {};
      if (d.normalMap) {
        mat.userData.ownedTextures = [map];
        mat.addEventListener("dispose", () => map.dispose());
        attachWarp(mesh);
      }
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
    // Called by world.cull / scene.onBeforeRender, before Three uploads geometry buffers.
    sort(camera: THREE.Camera) {
      root.traverse((o) => {
        if (
          o instanceof THREE.Mesh &&
          systems[o.name]?.["Sort particles"] === "1"
        )
          sortParticles(o, camera);
      });
    },
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
            (attrs.rectNext as THREE.InstancedBufferAttribute).setXYZW(
              count,
              p.uvNext[0],
              p.uvNext[1],
              p.uvNext[2],
              p.uvNext[3],
            );
            (attrs.frameBlend as THREE.InstancedBufferAttribute).setX(
              count,
              p.frameBlend,
            );
            const R = systems[batch.name].renderers;
            const trail = crashTrailShape(
              batch.name,
              p,
              now - state.since - batch.delay - born,
            );
            (attrs.shape as THREE.InstancedBufferAttribute).setXYZW(
              count,
              R.render_sprite_trail ? trail.width : p.radius,
              p.roll,
              trail.length,
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
