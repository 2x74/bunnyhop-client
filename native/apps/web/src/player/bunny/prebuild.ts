// Prebuilds a remote player's bunny before it's drawn (net/players.ts), so a player joining a room doesn't freeze
// everyone else's game. Their look is new geometry (mesh.ts bunnyGeometry per knife / glove style / look / build,
// ~30k vertices: tens of ms on a fast PC, several times that on a slow one) and often new shader programs (their
// finish and glove style compile into the material). Both used to happen inside the first frame they were in view.
//
//   await prebuildBunny(outfit, loadout)   geometry built in a worker (prebuild-worker.ts) and seeded into the caches,
//                                          so the BunnyModel built afterwards finds it there (no-op when cached)
//   await compileModel(renderer, root, camera, scene)   its programs compiled (KHR_parallel_shader_compile where
//                                          available) before it's added to the scene
//
// Any failure (no module workers, a worker error) resolves anyway: the model then builds on the main thread as before.

import * as THREE from "three";
import type { CosmeticLoadout } from "../../loadout";
import { hasCrownGeometry, seedCrownGeometry } from "./crown";
import { hasHatGeometry, seedHatGeometry } from "./hats";
import { hasBunnyGeometry, seedBunnyGeometry } from "./mesh";
import { bunnyParts } from "./prebuild-parts";

/** A BufferGeometry as plain transferable data. */
export interface PlainGeometry {
  attributes: Record<string, { array: Float32Array | Uint16Array | Uint32Array; itemSize: number; normalized: boolean }>;
  box: number[] | null;
  sphere: number[] | null;
}

type Reply = { id: number; key: string; body: PlainGeometry | null; hat: PlainGeometry | null; crown: PlainGeometry | null } | { id: number; error: string };

function geometry(p: PlainGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(p.attributes)) g.setAttribute(name, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized));
  if (p.box) g.boundingBox = new THREE.Box3(new THREE.Vector3(p.box[0], p.box[1], p.box[2]), new THREE.Vector3(p.box[3], p.box[4], p.box[5]));
  if (p.sphere) g.boundingSphere = new THREE.Sphere(new THREE.Vector3(p.sphere[0], p.sphere[1], p.sphere[2]), p.sphere[3]);
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
      if ("error" in r) console.warn("bunny prebuild failed; building on the main thread", r.error);
      else {
        if (r.body) seedBunnyGeometry(r.key, geometry(r.body));
        if (r.hat) seedHatGeometry(hatOf.get(r.id)!, geometry(r.hat));
        if (r.crown) seedCrownGeometry(crownOf.get(r.id)!, geometry(r.crown));
      }
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

const hatOf = new Map<number, string>();
const crownOf = new Map<number, 1 | 2 | 3>();

/** A build slower than this (a stuck worker) is waited for no longer: the model then builds on the main thread. */
const PREBUILD_TIMEOUT_MS = 5000;

/** Builds this look's geometry off the main thread unless it's cached already. Never rejects. */
export function prebuildBunny(outfit: string | null | undefined, loadout: CosmeticLoadout): Promise<void> {
  let p: ReturnType<typeof bunnyParts>;
  try {
    p = bunnyParts(outfit, loadout);
  } catch {
    return Promise.resolve();
  }
  const needBody = !hasBunnyGeometry(p.key);
  const needHat = !!p.hat && !hasHatGeometry(p.hat);
  const needCrown = !!p.crown && !hasCrownGeometry(p.crown);
  if (!needBody && !needHat && !needCrown) return Promise.resolve();
  const flight = `${p.key}|${p.hat ?? ""}|${p.crown ?? ""}`;
  const running = inflight.get(flight);
  if (running) return running;
  const w = ensureWorker();
  if (!w) return Promise.resolve();
  const id = ++seq;
  if (p.hat) hatOf.set(id, p.hat);
  if (p.crown) crownOf.set(id, p.crown);
  const done = new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, PREBUILD_TIMEOUT_MS);
    waiting.set(id, () => (clearTimeout(timer), resolve()));
  }).finally(() => inflight.delete(flight));
  inflight.set(flight, done);
  w.postMessage({ id, outfit: outfit ?? null, loadout, body: needBody, hat: needHat, crown: needCrown });
  return done;
}

/**
 * Compiles the programs of a model that isn't in the scene yet (renderer.compileAsync, fog / lights from `scene`), so
 * its first frame doesn't wait on the driver. Resolves after `timeoutMs` at the latest.
 */
export function compileModel(renderer: THREE.WebGLRenderer, root: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene, timeoutMs = 4000): Promise<void> {
  let timer = 0;
  return Promise.race([
    renderer.compileAsync(root, camera, scene).then(() => {}),
    new Promise<void>((resolve) => (timer = window.setTimeout(resolve, timeoutMs))),
  ])
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}
