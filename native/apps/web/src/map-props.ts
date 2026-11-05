// Animated map props: prop_dynamic(_override) playing a sequence, as CS:S draws them (bhop_ceaseless's butterflies,
// bhop_crash_egypt's wumpa fruit, bhop_retrowave's blocks). The core lists them and what the map's I/O asked them to play
// (crates/core/src/game/prop_anims.rs: DefaultAnim, SetAnimation, SetDefaultAnimation, SetPlaybackRate, TurnOn/Off,
// Enable/Disable, Kill) and bakes each into its own prop group (the frozen pose every client drew before). This replaces
// that group with the model skinned to its bones, posed by the player studio code (player/studio/: BoneSetup) at the
// sequence's own frame rate.
//
// Source (CDynamicProp, game/server/props.cpp): Spawn plays DefaultAnim from cycle 0 at playback rate 1, so every prop
// starts with the map and props on the same sequence run in step; a non-looping sequence holds its last frame, or plays
// DefaultAnim again when it ends; a name that isn't a sequence is tried as an activity (LookupSequence), and a prop with
// neither shows sequence 0, still. Time is the world's visual time (the run's tick, as texture-scroll.ts), so replays
// and exports pose the same frame every time.
//
// Render only: collision stays the prop's static model (no bone followers), as in CS:S.
//
// Cost: a prop's pose is computed in its skeleton's update, which three.js calls only for meshes in view, once per
// frame. Props of one model on the same sequence and cycle share the computation (one BoneSetup per model, the
// matrices copied). Far props step their animation at a lower rate, sequences without motion are posed once, and
// nothing is allocated per frame.

import * as THREE from "three";
import type { PropAnimState } from "./core";
import type { StudioData } from "./player/studio/data";
import { VERTEX_FLOATS } from "./player/studio/data";
import { BoneSetup, concat34To44 } from "./player/studio/pose";

/** Distances (Source units) past which a prop's animation steps at a lower rate, and those steps (seconds). */
const NEAR = 1536;
const FAR = 4096;
const NEAR_STEP = 1 / 20;
const FAR_STEP = 1 / 6;

/** Prop lighting (render.ts PROP_LIGHT): a constant ambient plus a fixed directional term in vertex colours. */
const PROP_LIGHT = new THREE.Vector3(0.35, 0.45, 0.82).normalize();

/** What the client knows about a prop without the core's states (`update` without them): its keyvalues. */
export interface AnimatedPropEntity {
  entity: number;
  model: string;
  skin: number;
  defaultAnim: string;
  startDisabled: boolean;
}

/** The animated props the map's entity lump asks for (what the core tracks, minus the I/O-only ones). */
export function animatedPropEntities(entities: Record<string, string>[]): AnimatedPropEntity[] {
  const out: AnimatedPropEntity[] = [];
  entities.forEach((e, entity) => {
    const kv = (k: string) => {
      const key = Object.keys(e).find((x) => x.toLowerCase() === k);
      return key === undefined ? undefined : e[key];
    };
    const cls = (kv("classname") ?? "").toLowerCase();
    const model = (kv("model") ?? "").replaceAll("\\", "/").toLowerCase();
    if (!cls.startsWith("prop_dynamic") || !model.endsWith(".mdl")) return;
    out.push({ entity, model, skin: parseInt(kv("skin") ?? "0", 10) || 0, defaultAnim: (kv("defaultanim") ?? "").trim(), startDisabled: (parseInt(kv("startdisabled") ?? "0", 10) || 0) !== 0 });
  });
  return out;
}

/** A model's sequences as `sequenceAt` needs them. */
export interface SequenceSource {
  /** `LookupSequence` (name, else activity), -1 if neither. */
  lookup(name: string, entity: number): number;
  /** Cycles per second. */
  cps(seq: number): number;
  looping(seq: number): boolean;
}

/**
 * The sequence and cycle an animated prop shows at visual time `t` (CDynamicProp + StudioFrameAdvance): `st` plays from
 * cycle 0 at `since` (sequence seconds `base + (t - since) * rate`); a looping sequence wraps, a non-looping one plays
 * `defaultAnim` again from where it ended (AnimThink), or holds its last frame without one; a name that is neither a
 * sequence nor an activity shows sequence 0, still (PropSetAnim's SetSequence(0)). Writes [sequence, cycle] to `out`.
 */
export function sequenceAt(
  st: { anim: string; defaultAnim: string; base: number; since: number; rate: number },
  t: number,
  entity: number,
  m: SequenceSource,
  out: [number, number],
): void {
  let secs = st.base + (t - st.since) * st.rate;
  let seq = st.anim ? m.lookup(st.anim, entity) : -1;
  if (seq < 0) {
    out[0] = 0;
    out[1] = 0;
    return;
  }
  let rate = m.cps(seq);
  let cycle = secs * rate;
  if (m.looping(seq)) cycle -= Math.floor(cycle);
  else if (cycle >= 1) {
    const d = st.defaultAnim ? m.lookup(st.defaultAnim, entity) : -1;
    if (d >= 0) {
      secs -= rate > 0 ? 1 / rate : 0;
      seq = d;
      rate = m.cps(seq);
      cycle = secs * rate;
      cycle -= Math.floor(cycle);
    } else cycle = 1;
  } else if (cycle < 0) cycle = 0;
  out[0] = seq;
  out[1] = Number.isFinite(cycle) ? cycle : 0;
}

/** Skinning matrices written straight into the bone texture (no Bone objects); the pose is computed on demand. */
class PropSkeleton extends THREE.Skeleton {
  compute: (() => boolean) | null = null;
  constructor(n: number) {
    super(Array.from({ length: n }, () => new THREE.Bone()), Array.from({ length: n }, () => new THREE.Matrix4()));
  }
  override update(): void {
    // Called by three.js for skinned meshes in view, once per frame (WebGLObjects.update).
    if (this.compute?.() && this.boneTexture) this.boneTexture.needsUpdate = true;
  }
}

interface Model {
  data: StudioData;
  setup: BoneSetup;
  /** Per skin family: geometry with its material groups (null: no drawable group). */
  geos: Map<number, THREE.BufferGeometry | null>;
  /** Bind-pose mesh radius around the model origin. */
  meshRadius: number;
  /** Per sequence: cycles per second (NaN until asked), and the farthest bone origin over the sequence. */
  cps: Float64Array;
  reach: Float64Array;
  /** Sequences whose animations all have one frame (posed once). */
  still: Uint8Array;
  /** Name (lower case) -> sequence candidates (a sequence, or every sequence of that activity with its weight). */
  lookups: Map<string, { seq: number; weight: number }[]>;
  /** The last pose computed this frame, for props on the same sequence and cycle. */
  last: { stamp: number; seq: number; cycle: number; m: Float32Array };
}

interface Instance {
  entity: number;
  model: Model;
  mesh: THREE.SkinnedMesh;
  skeleton: PropSkeleton;
  /** The core's frozen group for this prop (placed by world.update), hidden while this one draws. */
  fallback: THREE.Mesh;
  info: AnimatedPropEntity;
  state: PropAnimState | null;
  stamp: number;
  /** Still sequence posed already: [seq, cycle]. */
  stillAt: [number, number] | null;
  seq: number;
  /** Sequence the bounding sphere was sized for. */
  sizedFor: number;
}

export interface AnimatedProps {
  readonly count: number;
  readonly models: number;
  /** Sequence time base: world visual seconds (the run's tick), and the core's states (or null: keyvalues only). */
  update(visualTime: number, states: readonly PropAnimState[] | null | undefined): void;
  /** Camera position (Source space) for the distance steps; from world.cull. */
  setViewer(position: THREE.Vector3): void;
  /** Potato: the frozen groups instead (no posing at all). */
  setEnabled(on: boolean): void;
  dispose(): void;
  /** Poses computed since the last call (perf counter). */
  takePoseCount(): number;
}

export interface AnimatedPropsInput {
  /** Map core: loads the props' models through its VFS (core.studioLoad). */
  core: {
    hasStudioApi(): boolean;
    studioLoad(path: string): number;
    studioUnloadAll(): void;
    lastError(): string;
  };
  makeStudio: (handle: number) => StudioData;
  entities: AnimatedPropEntity[];
  /** The core's moving prop meshes by entity (render.ts propsMesh). */
  fallbacks: Map<number, THREE.Mesh>;
  /** Prop materials and their names (parallel). */
  materials: THREE.Material[];
  materialNames: string[];
  parent: THREE.Object3D;
}

const tmpVec = new THREE.Vector3();

function buildGeometry(d: StudioData, skin: number, matIndex: Map<string, number>, materials: THREE.Material[]): THREE.BufferGeometry | null {
  const v = d.vertices;
  const n = v.length / VERTEX_FLOATS;
  if (!n || !d.indices.length) return null;
  const buf = new THREE.InterleavedBuffer(v, VERTEX_FLOATS);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.InterleavedBufferAttribute(buf, 3, 0));
  geo.setAttribute("normal", new THREE.InterleavedBufferAttribute(buf, 3, 3));
  geo.setAttribute("uv", new THREE.InterleavedBufferAttribute(buf, 2, 6));
  const idx = new Uint16Array(n * 4);
  const w = new Float32Array(n * 4);
  const colors = new Float32Array(n * 3);
  const shade = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * VERTEX_FLOATS;
    for (let k = 0; k < 3; k++) {
      w[i * 4 + k] = v[o + 12 + k];
      idx[i * 4 + k] = v[o + 15 + k];
    }
    const s = 0.5 + 0.5 * Math.max(0, v[o + 3] * PROP_LIGHT.x + v[o + 4] * PROP_LIGHT.y + v[o + 5] * PROP_LIGHT.z);
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = shade[i] = s;
  }
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(idx, 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(w, 4));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("fullbrightShade", new THREE.BufferAttribute(shade, 1));
  geo.setIndex(new THREE.BufferAttribute(d.indices, 1));
  // Mesh groups are by skin family 0's texture; this prop's skin swaps each skin reference's texture.
  const skins = (d.info as { skins?: number[][] }).skins ?? [];
  const fam0 = skins[0];
  const fam = skins[skin] ?? fam0;
  for (const [tex, first, count] of d.info.groups) {
    let t = tex;
    if (fam && fam0 && fam !== fam0) {
      const ref = fam0.indexOf(tex);
      if (ref >= 0 && fam[ref] !== undefined) t = fam[ref];
    }
    const name = d.info.materials[t]?.name ?? "";
    const k = matIndex.get(name) ?? matIndex.get(name.toLowerCase());
    if (k === undefined || !materials[k]) continue;
    geo.addGroup(first, count, k);
  }
  return geo.groups.length ? geo : null;
}

export function animatedProps(o: AnimatedPropsInput): AnimatedProps | null {
  if (!o.entities.length || !o.core.hasStudioApi()) return null;
  const t0 = performance.now();
  // Models are cached per wasm instance by path; a pakfile may ship a different model under a path an earlier map used.
  o.core.studioUnloadAll();
  const matIndex = new Map<string, number>();
  o.materialNames.forEach((name, k) => {
    if (!matIndex.has(name)) matIndex.set(name, k);
    if (!matIndex.has(name.toLowerCase())) matIndex.set(name.toLowerCase(), k);
  });
  const models = new Map<string, Model | null>();
  const failed: string[] = [];
  const loadModel = (path: string): Model | null => {
    if (models.has(path)) return models.get(path)!;
    let m: Model | null = null;
    const h = o.core.studioLoad(path);
    if (h) {
      try {
        const data = o.makeStudio(h);
        if (data.bones && data.seqs.length) {
          let meshRadius = 0;
          const v = data.vertices;
          for (let i = 0; i < v.length; i += VERTEX_FLOATS) meshRadius = Math.max(meshRadius, Math.sqrt(v[i] * v[i] + v[i + 1] * v[i + 1] + v[i + 2] * v[i + 2]));
          const ns = data.seqs.length;
          const still = new Uint8Array(ns);
          data.seqs.forEach((s, i) => (still[i] = s.anims.every((a) => (data.info.anims[a]?.frames ?? 1) <= 1) && !s.layers.length ? 1 : 0));
          m = {
            data,
            setup: new BoneSetup(data),
            geos: new Map(),
            meshRadius,
            cps: new Float64Array(ns).fill(NaN),
            reach: new Float64Array(ns).fill(NaN),
            still,
            lookups: new Map(),
            last: { stamp: NaN, seq: -1, cycle: NaN, m: new Float32Array(data.bones * 16) },
          };
        }
      } catch (e) {
        failed.push(`${path} (${(e as Error).message})`);
      }
    } else failed.push(`${path} (${o.core.lastError()})`);
    models.set(path, m);
    return m;
  };

  const instances: Instance[] = [];
  /** Animated props drawn frozen (model not loadable here): they still hide and show as the map says. */
  const frozen: { entity: number; fallback: THREE.Mesh; info: AnimatedPropEntity; state: PropAnimState | null }[] = [];
  for (const info of o.entities) {
    const fallback = o.fallbacks.get(info.entity);
    if (!fallback) continue; // not an animated prop to the core (or in the 3D skybox, or its model is missing)
    const model = loadModel(info.model);
    if (!model) {
      frozen.push({ entity: info.entity, fallback, info, state: null });
      continue;
    }
    let geo = model.geos.get(info.skin);
    if (geo === undefined) model.geos.set(info.skin, (geo = buildGeometry(model.data, info.skin, matIndex, o.materials)));
    if (!geo) {
      frozen.push({ entity: info.entity, fallback, info, state: null });
      continue;
    }
    const skeleton = new PropSkeleton(model.data.bones);
    const mesh = new THREE.SkinnedMesh(geo, o.materials);
    mesh.bindMode = THREE.DetachedBindMode;
    mesh.bind(skeleton, new THREE.Matrix4());
    mesh.name = `anim-prop-${info.entity}`;
    // Sized for its sequence on its first pose; until then the bind mesh.
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Math.max(model.meshRadius, 1));
    mesh.frustumCulled = true;
    // Raycasts (paint, surface probes) hit the frozen group instead: no CPU skinning per vertex.
    mesh.raycast = () => {};
    mesh.position.copy(fallback.position);
    mesh.rotation.copy(fallback.rotation);
    const inst: Instance = { entity: info.entity, model, mesh, skeleton, fallback, info, state: null, stamp: NaN, stillAt: null, seq: -1, sizedFor: -2 };
    skeleton.compute = () => pose(inst);
    instances.push(inst);
    fallback.visible = false;
    o.parent.add(mesh);
  }
  const loaded = [...models.values()].filter(Boolean).length;
  if (failed.length) console.warn(`map props: ${failed.length} animated model(s) stay frozen: ${failed.slice(0, 4).join(", ")}`);
  if (!instances.length && !frozen.length) return null;
  console.info(`map props: ${instances.length} animated props, ${loaded} models${frozen.length ? `, ${frozen.length} frozen` : ""}, built in ${(performance.now() - t0).toFixed(0)} ms`);

  let time = 0;
  let enabled = true;
  let poses = 0;
  const viewer = new THREE.Vector3(Infinity, Infinity, Infinity);
  const byEntity = new Map<number, { state: PropAnimState | null }>([...instances, ...frozen].map((i) => [i.entity, i]));

  /** `LookupSequence`: a sequence name, else an activity (its sequences by weight; one picked from the entity index). */
  const lookup = (m: Model, name: string, entity: number): number => {
    const key = name.toLowerCase();
    let c = m.lookups.get(key);
    if (!c) {
      const s = m.data.seq(name);
      c = s >= 0 ? [{ seq: s, weight: 1 }] : m.data.seqs.filter((q) => q.activity.toLowerCase() === key && q.actWeight > 0).map((q) => ({ seq: q.index, weight: q.actWeight }));
      m.lookups.set(key, c);
    }
    if (!c.length) return -1;
    if (c.length === 1) return c[0].seq;
    // SelectWeightedSequence picks at random; a fixed pick per prop keeps replays and exports the same.
    const total = c.reduce((n, x) => n + x.weight, 0);
    let r = ((Math.imul(entity + 1, 0x9e3779b1) >>> 0) / 2 ** 32) * total;
    for (const x of c) if ((r -= x.weight) < 0) return x.seq;
    return c[c.length - 1].seq;
  };

  const cps = (m: Model, seq: number): number => {
    let r = m.cps[seq];
    if (Number.isNaN(r)) m.cps[seq] = r = m.setup.cycleRate(seq);
    return r;
  };

  /** Largest bone distance from the model origin over the sequence (8 samples): sizes the culling sphere. */
  const reach = (m: Model, seq: number): number => {
    let r = m.reach[seq];
    if (Number.isNaN(r)) {
      r = 0;
      for (let k = 0; k < 8; k++) {
        m.setup.initPose();
        m.setup.accumulate(seq, k / 8, 1);
        const W = m.setup.buildMatrices();
        for (let b = 0; b < m.data.bones; b++) r = Math.max(r, Math.sqrt(W[b * 12 + 3] ** 2 + W[b * 12 + 7] ** 2 + W[b * 12 + 11] ** 2));
      }
      m.reach[seq] = r;
      m.last.stamp = NaN;
    }
    return r;
  };

  /** The model `at` is asking about (one source object, no closure per call). */
  let cur: Model | null = null;
  const seqs: SequenceSource = {
    lookup: (name, entity) => lookup(cur!, name, entity),
    cps: (seq) => cps(cur!, seq),
    looping: (seq) => cur!.data.seqs[seq].looping,
  };
  /** Sequence and cycle of a prop at visual time `t`. */
  const at = (inst: Instance, t: number, out: [number, number]): void => {
    cur = inst.model;
    const st = inst.state ?? { anim: inst.info.defaultAnim, defaultAnim: inst.info.defaultAnim, base: 0, since: 0, rate: 1 };
    sequenceAt(st, t, inst.entity, seqs, out);
  };

  const sc: [number, number] = [0, 0];
  /** Poses `inst` for this frame; false when its matrices didn't change. */
  const pose = (inst: Instance): boolean => {
    if (inst.stamp === time) return false;
    inst.stamp = time;
    const m = inst.model;
    // Far props step at a lower rate (deterministic steps of visual time, the same in every replay of the frame).
    const d = tmpVec.setFromMatrixPosition(inst.mesh.matrixWorld).distanceTo(viewer);
    const step = d > FAR ? FAR_STEP : d > NEAR ? NEAR_STEP : 0;
    at(inst, step ? Math.floor(time / step) * step : time, sc);
    const [seq, cycle] = sc;
    if (m.still[seq] && inst.stillAt && inst.stillAt[0] === seq) return false;
    if (inst.stillAt && !m.still[seq]) inst.stillAt = null;
    const bm = inst.skeleton.boneMatrices!;
    const n = m.data.bones;
    const last = m.last;
    if (last.stamp === time && last.seq === seq && last.cycle === cycle) bm.set(last.m);
    else {
      m.setup.initPose();
      m.setup.accumulate(seq, cycle, 1);
      const W = m.setup.buildMatrices();
      const P = m.data.poseToBone;
      for (let b = 0; b < n; b++) concat34To44(W, b * 12, P, b * 12, bm, b * 16);
      last.m.set(bm.subarray(0, n * 16));
      last.stamp = time;
      last.seq = seq;
      last.cycle = cycle;
      poses++;
    }
    if (m.still[seq]) inst.stillAt = [seq, cycle];
    return true;
  };

  const applyVisibility = () => {
    for (const inst of instances) {
      const hidden = inst.state ? inst.state.hidden || inst.state.removed : inst.info.startDisabled;
      inst.mesh.visible = enabled && !hidden;
      inst.fallback.visible = !enabled && !hidden;
    }
    for (const f of frozen) f.fallback.visible = !(f.state ? f.state.hidden || f.state.removed : f.info.startDisabled);
  };
  applyVisibility();

  return {
    count: instances.length,
    models: loaded,
    update(visualTime, states) {
      time = visualTime;
      if (states) for (const s of states) {
        const inst = byEntity.get(s.entity);
        if (inst) inst.state = s;
      }
      applyVisibility();
      for (const inst of instances) {
        // Parented props move with their parent (world.update placed the frozen group).
        inst.mesh.position.copy(inst.fallback.position);
        inst.mesh.rotation.copy(inst.fallback.rotation);
        // The culling sphere covers the whole sequence (a butterfly's flight path), so a prop flying into view is posed.
        if (!inst.mesh.visible) continue;
        at(inst, time, sc);
        if (inst.sizedFor !== sc[0]) {
          inst.sizedFor = sc[0];
          inst.mesh.boundingSphere!.radius = Math.max(1, inst.model.meshRadius + reach(inst.model, sc[0]));
        }
      }
    },
    setViewer(position) {
      viewer.copy(position);
    },
    setEnabled(on) {
      enabled = on;
      applyVisibility();
    },
    dispose() {
      for (const inst of instances) {
        inst.mesh.removeFromParent();
        inst.skeleton.dispose();
      }
      for (const m of models.values()) for (const g of m?.geos.values() ?? []) g?.dispose();
    },
    takePoseCount() {
      const n = poses;
      poses = 0;
      return n;
    },
  };
}
