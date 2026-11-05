import { fetchBytes } from "../../content/fetch";
// Loads the two CS:S animation sources the game uses, on demand, from the hosted player content (content/player.ts):
//   models/player/cs_player_shared.mdl   the player skeleton, pose parameters and sequences the bunny is animated by
//   models/weapons/v_knife_t.mdl         the knife viewmodel's skeleton and sequences (the first-person hands)
// No meshes or materials: the CS:S player models (models/player/{ct,t}_*) and the knife world models were dropped in
// v0.0.38 (owner: bunny player models only), so nothing here asks for them. A dedicated, map-less core instance mounts
// the content group's file list as a listing, `core.studioLoad` asks for exactly the files a model needs and the
// content resolve loop fetches them from content/<sha256> (immutable, HTTP-cached, hash-checked). Shared by every
// instance; animations are decoded lazily (data.ts).

import wasmUrl from "../../wasm/bunnyhop_core.wasm?url";
import { Core } from "../../core";
import { contentKey } from "../../content/manifest";
import { playerContent, type PlayerContent } from "../../content/player";
import { resolveContent, type ContentReader } from "../../content/resolve";
import { StudioData } from "./data";

let corePromise: Promise<Core> | null = null;
let coreFor: PlayerContent | null = null;
let fetchedBytes = 0;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function contentCore(c: PlayerContent): Promise<Core> {
  if (corePromise && coreFor === c) return corePromise;
  coreFor = c;
  corePromise = (async () => {
    const core = await Core.create(fetch(wasmUrl));
    core.contentMountListing("player", Object.keys(c.group.files));
    return core;
  })();
  return corePromise;
}

function reader(c: PlayerContent): ContentReader {
  return {
    readRange: () => Promise.reject(new Error("no VPKs mounted")),
    fetchListed: async (path) => {
      const f = c.group.files[path];
      if (!f) return null;
      const b = await fetchBytes(`${c.base}/${contentKey(f.sha256)}`, { cacheSha256: f.sha256, expectedSize: f.size });
      if ((await sha256Hex(b)) !== f.sha256) throw new Error(`${path}: hash mismatch`);
      fetchedBytes += b.length;
      return b;
    },
  };
}

/** Model loads share one core and its VFS's pending-request list, so they run one at a time. */
let lane: Promise<unknown> = Promise.resolve();
function loadModel(core: Core, c: PlayerContent, path: string): Promise<number> {
  const run = lane.then(() => loadModelNow(core, c, path));
  lane = run.catch(() => undefined);
  return run;
}

/** Loads one studio model through the content core; resolves to its handle. */
async function loadModelNow(core: Core, c: PlayerContent, path: string): Promise<number> {
  let h = 0;
  await resolveContent(core, reader(c), [], () => {
    if (!h) h = core.studioLoad(path);
  });
  if (!h) h = core.studioLoad(path);
  if (!h) throw new Error(`${path}: ${core.lastError()}`);
  return h;
}

/**
 * The CS:S animation model (models/player/cs_player_shared.mdl: the ValveBiped skeleton, pose parameters and every
 * player sequence; no mesh). The bunny (player/bunny/) runs the CS:S anim state on it and skins its own mesh to the
 * resulting bones. ~2 MB, fetched once; shared by every bunny.
 */
export const ANIM_MODEL = "models/player/cs_player_shared.mdl";
let animRig: Promise<StudioData> | null = null;
let animRigReady: StudioData | null = null;

/** True when hosted player content with the animation model is known. */
export function hasAnimRig(): boolean {
  const c = playerContent();
  return !!c && ANIM_MODEL in c.group.files;
}

export function loadAnimRig(): Promise<StudioData> {
  const c = playerContent();
  if (!c) return Promise.reject(new Error("no player content"));
  if (!animRig) {
    animRig = (async () => {
      const t0 = performance.now();
      const b0 = fetchedBytes;
      const core = await contentCore(c);
      const d = new StudioData(core, await loadModel(core, c, ANIM_MODEL));
      animRigReady = d;
      console.info(`player model: CS:S animations loaded in ${(performance.now() - t0).toFixed(0)} ms (${((fetchedBytes - b0) / 1e6).toFixed(1)} MB; ${d.info.bones.length} bones, ${d.info.seqs.length} sequences)`);
      return d;
    })();
    animRig.catch(() => (animRig = null));
  }
  return animRig;
}

export function readyAnimRig(): StudioData | null {
  return animRigReady;
}

/**
 * The CS:S knife viewmodel (models/weapons/v_knife_t.mdl): only its skeleton and sequences (idle, draw, midslash1/2,
 * stab, stab_miss) are used, to animate the first-person bunny hands + carrot blade (apps/web/src/viewmodel/), which
 * are our own mesh on the same bones. Fetched once, when the viewmodel is first shown (~1.3 MB with its files).
 */
export const VIEWMODEL_KNIFE = "models/weapons/v_knife_t.mdl";
let vmAnims: Promise<StudioData> | null = null;
let vmAnimsReady: StudioData | null = null;

/** True when hosted player content with the knife viewmodel is known. */
export function hasViewmodelAnims(): boolean {
  const c = playerContent();
  return !!c && VIEWMODEL_KNIFE in c.group.files;
}

export function loadViewmodelAnims(): Promise<StudioData> {
  const c = playerContent();
  if (!c) return Promise.reject(new Error("no player content"));
  if (!vmAnims) {
    vmAnims = (async () => {
      const t0 = performance.now();
      const b0 = fetchedBytes;
      const core = await contentCore(c);
      const d = new StudioData(core, await loadModel(core, c, VIEWMODEL_KNIFE));
      vmAnimsReady = d;
      console.info(`viewmodel: CS:S knife animations loaded in ${(performance.now() - t0).toFixed(0)} ms (${((fetchedBytes - b0) / 1e6).toFixed(1)} MB; ${d.info.bones.length} bones, ${d.info.seqs.length} sequences)`);
      return d;
    })();
    vmAnims.catch(() => (vmAnims = null));
  }
  return vmAnims;
}

export function readyViewmodelAnims(): StudioData | null {
  return vmAnimsReady;
}
