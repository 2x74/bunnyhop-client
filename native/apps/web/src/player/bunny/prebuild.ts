// Prebuilds a remote player's bunny before it's drawn (net/players.ts), so a player joining a room doesn't freeze
// everyone else's game. Their look is new geometry (mesh.ts bunnyGeometry per knife / glove style / look / build,
// ~30k vertices: tens of ms on a fast PC, several times that on a slow one) and often new shader programs (their
// finish and glove style compile into the material). Both used to happen inside the first frame they were in view.
//
//   await prebuildBunny(outfit, loadout)   geometry built in a worker (prebuild-worker.ts) and seeded into the caches,
//                                          so the BunnyModel built afterwards finds it there (no-op when cached)
//   await compileModel(renderer, root, camera, scene)   its programs compiled (KHR_parallel_shader_compile where
//                                          available) before it's added to the scene, for the screen and the render
//                                          targets the look draws the scene into (graphics/warm-programs.ts)
//
// Any failure (no module workers, a worker error) resolves anyway: the model then builds on the main thread as before.

import * as THREE from "three";
import { hasShellGeometry, seedShellGeometry } from "../glow-geometry";
import { bunnyGeometry } from "./mesh";
import { hatGeometry } from "./hats";
import { crownGeometry } from "./crown";
import { dressedGunKey, hasDressedGun, seedDressedGun } from "../../viewmodel/guns/meshes";
import { gunById } from "../../viewmodel/guns";
import { seedGunHold, type GunHoldData } from "./gun-hold";
import { warmPrograms, drawHiddenPrograms } from "../../graphics/warm-programs";
import type { CosmeticLoadout } from "../../loadout";
import { hasCrownGeometry, seedCrownGeometry } from "./crown";
import { hasHatGeometry, seedHatGeometry } from "./hats";
import { hasBunnyGeometry, seedBunnyGeometry } from "./mesh";
import { bunnyParts } from "./prebuild-parts";
import { hasViewmodelGeometry, seedViewmodelGeometry } from "../../viewmodel/mesh";
import { markViewmodelLayout } from "../../viewmodel/finishes/layout";
import type { KnifeDef } from "../../viewmodel/knives/types";
import { hasKnifeCloud, seedKnifeCloud } from "../../viewmodel/knives/hold";
import type { GloveStyleId } from "../../loadout";

/** A BufferGeometry as plain transferable data. */
export interface PlainGeometry {
  attributes: Record<string, { array: Float32Array | Uint16Array | Uint32Array; itemSize: number; normalized: boolean }>;
  glowNormals?: Float32Array;
  box: number[] | null;
  sphere: number[] | null;
}

type VmReply = { id: number; vm: { knife: string; glove: GloveStyleId; geometry: PlainGeometry; tris: number | null }[]; clouds: { knife: string; p: Float32Array; grip: Uint8Array; n: number }[] };
type GunReply = { id: number; gunKey: string; gunId: string; gun: PlainGeometry; silencer: PlainGeometry | null; hold: Omit<GunHoldData, "def"> };
type Reply = GunReply | { id: number; key: string; body: PlainGeometry | null; hat: PlainGeometry | null; crown: PlainGeometry | null } | VmReply | { id: number; error: string };

function geometry(p: PlainGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(p.attributes)) g.setAttribute(name, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized));
  if (p.box) g.boundingBox = new THREE.Box3(new THREE.Vector3(p.box[0], p.box[1], p.box[2]), new THREE.Vector3(p.box[3], p.box[4], p.box[5]));
  if (p.sphere) g.boundingSphere = new THREE.Sphere(new THREE.Vector3(p.sphere[0], p.sphere[1], p.sphere[2]), p.sphere[3]);
  if (p.glowNormals) seedShellGeometry(g, p.glowNormals);
  return g;
}

let worker: Worker | null = null;
let broken = false;
let seq = 0;
const waiting = new Map<number, () => void>();
/** In-flight builds by body key + headwear, so several players with the same look share one. */
const inflight = new Map<string, Promise<void>>();

function ensureWorker(): Worker | null {
  if (worker || broken) return worker;
  try {
    const w = new Worker(new URL("./prebuild-worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<Reply>) => {
      const r = e.data;
      if (!waiting.has(r.id)) return;
      if ("error" in r) console.warn("bunny prebuild failed; building on the main thread", r.error);
      else if ("gunKey" in r) {
        seedDressedGun(r.gunKey, geometry(r.gun), r.silencer && geometry(r.silencer));
        const def = gunById(r.gunId);
        if (def) seedGunHold(def, r.hold);
      } else if ("vm" in r) {
        for (const v of r.vm) {
          const g = geometry(v.geometry);
          markViewmodelLayout(g); // laid out in the worker (finishUV is part of the geometry)
          seedViewmodelGeometry(v.knife, v.glove, g);
          const def = knifeOf.get(v.knife);
          if (def && v.tris !== null) def.tris ??= v.tris;
        }
        for (const c of r.clouds) seedKnifeCloud(c.knife, { p: c.p, grip: c.grip, n: c.n });
      } else {
        if (r.body) {
          const g = geometry(r.body);
          seedBunnyGeometry(r.key, g);
          const parts = partsOf.get(r.id);
          if (r.body.glowNormals && parts) seedShellGeometry(bunnyGeometry(parts.knife, parts.glove, parts.look, parts.body, parts.hood), r.body.glowNormals);
        }
        if (r.hat) {
          const key = hatOf.get(r.id)!;
          seedHatGeometry(key, geometry(r.hat));
          if (r.hat.glowNormals) seedShellGeometry(hatGeometry(key)!, r.hat.glowNormals);
        }
        if (r.crown) {
          const tier = crownOf.get(r.id)!;
          seedCrownGeometry(tier, geometry(r.crown));
          if (r.crown.glowNormals) seedShellGeometry(crownGeometry(tier), r.crown.glowNormals);
        }
      }
      partsOf.delete(r.id);
      hatOf.delete(r.id);
      crownOf.delete(r.id);
      waiting.get(r.id)?.();
      waiting.delete(r.id);
    };
    w.onerror = () => {
      // A worker that can't start (module workers unsupported, a blocked script): stop using it, release everyone.
      broken = true;
      worker = null;
      for (const done of waiting.values()) done();
      waiting.clear();
      partsOf.clear();
      hatOf.clear();
      crownOf.clear();
      w.terminate();
    };
    worker = w;
  } catch {
    broken = true;
  }
  return worker;
}

const partsOf = new Map<number, ReturnType<typeof bunnyParts>>();
const hatOf = new Map<number, string>();
const crownOf = new Map<number, 1 | 2 | 3>();

/** A build slower than this (a stuck worker) is waited for no longer: the model then builds on the main thread. */
const PREBUILD_TIMEOUT_MS = 5000;

/** Builds this look's geometry off the main thread unless it's cached already. Never rejects. */
export function prebuildBunny(outfit: string | null | undefined, loadout: CosmeticLoadout, glow = false): Promise<void> {
  let p: ReturnType<typeof bunnyParts>;
  try {
    p = bunnyParts(outfit, loadout);
  } catch {
    return Promise.resolve();
  }
  const needBody = !hasBunnyGeometry(p.key) || (glow && !hasShellGeometry(bunnyGeometry(p.knife, p.glove, p.look, p.body, p.hood)));
  const needHat = !!p.hat && (!hasHatGeometry(p.hat) || (glow && !hasShellGeometry(hatGeometry(p.hat)!)));
  const needCrown = !!p.crown && (!hasCrownGeometry(p.crown) || (glow && !hasShellGeometry(crownGeometry(p.crown))));
  if (!needBody && !needHat && !needCrown) return Promise.resolve();
  const flight = `${p.key}|${p.hat ?? ""}|${p.crown ?? ""}|${glow}`;
  const running = inflight.get(flight);
  if (running) return running;
  const w = ensureWorker();
  if (!w) return Promise.resolve();
  const id = ++seq;
  partsOf.set(id, p);
  if (p.hat) hatOf.set(id, p.hat);
  if (p.crown) crownOf.set(id, p.crown);
  const done = new Promise<void>((resolve) => {
    const timer = window.setTimeout(() => {
      waiting.delete(id);
      partsOf.delete(id);
      hatOf.delete(id);
      crownOf.delete(id);
      resolve();
    }, PREBUILD_TIMEOUT_MS);
    waiting.set(id, () => (clearTimeout(timer), resolve()));
  }).finally(() => inflight.delete(flight));
  inflight.set(flight, done);
  w.postMessage({ id, outfit: outfit ?? null, loadout, body: needBody, hat: needHat, crown: needCrown, glow });
  return done;
}

const knifeOf = new Map<string, KnifeDef>();

/**
 * What the Loadout's (and Support's) first frame needs, built in the worker: your bunny, the hands in the default
 * knife and gloves (the Viewmodel's first geometry) and in yours, and your knife's grip cloud. For the main menu once
 * it's idle, so a click to Support or a profile doesn't build them on the main thread; ui/loadout-stage.ts
 * prewarmLoadout builds the rest (every knife and glove) once one of those is open.
 */
export function prebuildLoadoutStart(outfit: string | null | undefined, loadout: CosmeticLoadout, knife: KnifeDef, glove: GloveStyleId, defaultKnife: KnifeDef): Promise<void> {
  return Promise.all([prebuildBunny(outfit, loadout), prebuildViewmodels([[defaultKnife, "knit"], [knife, glove]])]).then(() => {});
}

/**
 * Builds the first-person viewmodel geometry (hands in a glove style + a knife: viewmodel/mesh.ts) of these pairs in
 * the worker, for the ones not built yet; viewmodelGeometry then finds them cached. Never rejects; without the worker
 * they're built on the main thread when first used, as before.
 */
export function prebuildViewmodels(pairs: readonly [KnifeDef, GloveStyleId][]): Promise<void> {
  const need = pairs.filter(([k, g]) => !hasViewmodelGeometry(k.id, g));
  // And their knives' point clouds for the grip solver (knives/hold.ts knifeCloud: the knife's mesh again, deduped).
  const clouds = [...new Set(pairs.map(([k]) => k.id))].filter((id) => !hasKnifeCloud(id));
  const flight = need.map(([k, g]) => `${k.id}|${g}`).join(",") + `;${clouds.join(",")}`;
  if (!need.length && !clouds.length) return Promise.resolve();
  const running = inflight.get(`vm:${flight}`);
  if (running) return running;
  const w = ensureWorker();
  if (!w) return Promise.resolve();
  const id = ++seq;
  for (const [k] of need) knifeOf.set(k.id, k);
  const done = new Promise<void>((resolve) => {
    const timer = window.setTimeout(() => {
      waiting.delete(id);
      partsOf.delete(id);
      hatOf.delete(id);
      crownOf.delete(id);
      resolve();
    }, PREBUILD_TIMEOUT_MS);
    waiting.set(id, () => (clearTimeout(timer), resolve()));
  }).finally(() => inflight.delete(`vm:${flight}`));
  inflight.set(`vm:${flight}`, done);
  w.postMessage({ id, vm: need.map(([k, g]) => [k.id, g]), clouds });
  return done;
}

/**
 * Prepares a hidden model for every output the look draws `scene` to, with its fog / lights. No-KHR drivers also
 * draw its vertex layouts separately before attachment; KHR drivers keep parallel shader preparation. Resolves after
 * `timeoutMs` at the latest.
 */
export function compileModel(renderer: THREE.WebGLRenderer, root: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene, timeoutMs = 5000): Promise<void> {
  let timer = 0;
  return Promise.race([
    warmModelPrograms(renderer, root, camera, scene),
    new Promise<void>((resolve) => (timer = window.setTimeout(resolve, timeoutMs))),
  ])
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

/** Unbounded loading-screen preparation; the joining model's caller supplies its own fallback deadline. */
export function warmModelPrograms(renderer: THREE.WebGLRenderer, root: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
  return warmPrograms(renderer, root, camera, scene, false)
    .then(() => retainModelPrograms(renderer, root, camera, scene))
    .then(() => drawHiddenPrograms(renderer, root, camera, scene));
}

/** The gun, its camo and grip data share the remote bunny worker and five-second fallback. */
export function prebuildGun(gunId: string | null, camo?: string | null): Promise<void> {
  if (!gunId) return Promise.resolve();
  const key = dressedGunKey(gunId, camo);
  if (hasDressedGun(key)) return Promise.resolve();
  const flight = `gun:${key}`;
  const running = inflight.get(flight);
  if (running) return running;
  const w = ensureWorker();
  if (!w) return Promise.resolve();
  const id = ++seq;
  const done = new Promise<void>(resolve => {
    const timer = window.setTimeout(() => {
      waiting.delete(id);
      partsOf.delete(id);
      hatOf.delete(id);
      crownOf.delete(id);
      resolve();
    }, PREBUILD_TIMEOUT_MS);
    waiting.set(id, () => { clearTimeout(timer); resolve(); });
  }).finally(() => inflight.delete(flight));
  inflight.set(flight, done);
  w.postMessage({ id, gunId, camo });
  return done;
}

/** Upload one material texture per task while the remote player is still hidden, including bone and tag textures. */
export async function stageModelTextures(renderer: THREE.WebGLRenderer, root: THREE.Object3D): Promise<void> {
  const textures = new Set<THREE.Texture>();
  root.traverse(object => {
    const mesh = object as THREE.SkinnedMesh;
    if (mesh.skeleton) {
      if (!mesh.skeleton.boneTexture) mesh.skeleton.computeBoneTexture();
      if (mesh.skeleton.boneTexture) textures.add(mesh.skeleton.boneTexture);
    }
    const material = (object as THREE.Mesh).material;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) {
      for (const value of Object.values(m)) if (value instanceof THREE.Texture) textures.add(value);
      if (m instanceof THREE.ShaderMaterial) for (const u of Object.values(m.uniforms)) {
        if (u.value instanceof THREE.Texture) textures.add(u.value);
      }
    }
  });
  for (const texture of textures) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    renderer.initTexture(texture);
  }
}

// A leave used to dispose the last reference to shared glow / tag programs, so the next join compiled them again.
// Keep a bounded set of program-owning material clones per renderer. No model or GPU geometry buffers are kept.
const residentPrograms = new WeakMap<THREE.WebGLRenderer, Map<string, THREE.Material>>();
const MAX_RESIDENT_PROGRAMS = 32;
async function retainModelPrograms(renderer: THREE.WebGLRenderer, root: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
  let resident = residentPrograms.get(renderer);
  if (!resident) residentPrograms.set(renderer, (resident = new Map()));
  const copies = new THREE.Group();
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.material) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      // Use three's actual keys, which include fog, output, skinning, hilt, glove and finish defines.
      const properties = renderer.properties.get(material) as { programs?: Map<string, unknown> };
      const programs = properties.programs;
      if (!programs?.size) continue;
      const key = [...programs.keys()].sort().join("\n");
      const hit = resident!.get(key);
      if (hit) {
        resident!.delete(key);
        resident!.set(key, hit);
        continue;
      }
      const copy = mesh.clone(false);
      copy.material = material.clone();
      resident!.set(key, copy.material);
      copies.add(copy);
      while (resident!.size > MAX_RESIDENT_PROGRAMS) {
        const oldest = resident!.keys().next().value!;
        resident!.get(oldest)!.dispose();
        resident!.delete(oldest);
      }
    }
  });
  if (copies.children.length) await warmPrograms(renderer, copies, camera, scene, false);
}
