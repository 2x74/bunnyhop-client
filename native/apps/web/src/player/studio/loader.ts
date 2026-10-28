import { fetchBytes } from "../../content/fetch";
// Loads CS:S player models on demand from the hosted player content (content/player.ts): a dedicated, map-less core
// instance mounts the content group's file list as a listing, `core.studioLoad` asks for exactly the files a model
// needs (MDL, its $includemodel animation models, VVD, VTX, VMTs, base + bump VTFs) and the content resolve loop
// fetches them from content/<sha256> (immutable, HTTP-cached, hash-checked). One asset per model path per session,
// shared by every instance; animations are decoded lazily (data.ts).

import wasmUrl from "../../wasm/bunnyhop_core.wasm?url";
import { Core, type TexturePayload } from "../../core";
import { contentKey } from "../../content/manifest";
import { playerContent, type PlayerContent } from "../../content/player";
import { resolveContent, type ContentReader } from "../../content/resolve";
import { StudioData } from "./data";

/** Player models in the content (team -> skins), in the order Settings lists them. */
export const CT_SKINS = ["ct_urban", "ct_gsg9", "ct_sas", "ct_gign"] as const;
export const T_SKINS = ["t_phoenix", "t_leet", "t_arctic", "t_guerilla"] as const;
export type CsSkin = (typeof CT_SKINS)[number] | (typeof T_SKINS)[number];
export const SKIN_LABEL: Record<CsSkin, string> = {
  ct_urban: "SEAL Team 6",
  ct_gsg9: "GSG-9",
  ct_sas: "SAS",
  ct_gign: "GIGN",
  t_phoenix: "Phoenix Connexion",
  t_leet: "Elite Crew",
  t_arctic: "Arctic Avengers",
  t_guerilla: "Guerilla Warfare",
};

export const modelPath = (skin: string) => `models/player/${skin}.mdl`;
export const knifePath = (skin: string) => (skin.startsWith("t_") ? "models/weapons/w_knife_t.mdl" : "models/weapons/w_knife_ct.mdl");

export interface StudioTextures {
  /** Texture payloads by VTF path (uploaded by the model once it knows the renderer). */
  get(path: string, allowS3tc: boolean, needAlpha: boolean): TexturePayload | null;
}

export interface CsAsset {
  skin: string;
  data: StudioData;
  /** Bone-merged weapon (knife world model), if available. */
  weapon: StudioData | null;
  textures: StudioTextures;
  /** Load time (ms) and bytes fetched (first load of the shared files included). */
  ms: number;
  bytes: number;
}

let corePromise: Promise<Core> | null = null;
let coreFor: PlayerContent | null = null;
const assets = new Map<string, Promise<CsAsset>>();
const ready = new Map<string, CsAsset>();
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

/** True when hosted player content is known (a map manifest carried it) and has this skin. */
export function hasSkin(skin: string): boolean {
  const c = playerContent();
  return !!c && modelPath(skin) in c.group.files;
}

/** The CS:S player model `skin` (e.g. "ct_urban") with its knife. Cached per skin; rejects without content. */
export function loadCsAsset(skin: string): Promise<CsAsset> {
  const c = playerContent();
  if (!c) return Promise.reject(new Error("no player content"));
  let p = assets.get(skin);
  if (!p) {
    p = (async () => {
      const t0 = performance.now();
      const b0 = fetchedBytes;
      const core = await contentCore(c);
      const data = new StudioData(core, await loadModel(core, c, modelPath(skin)));
      let weapon: StudioData | null = null;
      const wp = knifePath(skin);
      if (wp in c.group.files) {
        try {
          weapon = new StudioData(core, await loadModel(core, c, wp));
        } catch (e) {
          console.warn("player model: knife unavailable", e);
        }
      }
      const cache = new Map<string, TexturePayload | null>();
      const textures: StudioTextures = {
        get: (path, s3tc, alpha) => {
          const k = `${path}|${s3tc}|${alpha}`;
          if (!cache.has(k)) cache.set(k, core.texturePath(path, s3tc, alpha));
          return cache.get(k) ?? null;
        },
      };
      const asset: CsAsset = { skin, data, weapon, textures, ms: performance.now() - t0, bytes: fetchedBytes - b0 };
      ready.set(skin, asset);
      console.info(`player model: ${skin} loaded in ${asset.ms.toFixed(0)} ms (${(fetchedBytes / 1e6).toFixed(1)} MB of player content fetched so far; ${data.info.bones.length} bones, ${data.info.seqs.length} sequences, ${data.info.vertexCount} vertices)`);
      return asset;
    })();
    p.catch(() => assets.delete(skin));
    assets.set(skin, p);
  }
  return p;
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

/** Already-loaded asset (synchronous), or null. */
export function readyAsset(skin: string): CsAsset | null {
  return ready.get(skin) ?? null;
}
