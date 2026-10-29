// Saved avatars follow the look (spec.ts AVATAR_RENDER_VERSION) without the player doing anything. When GET /me says
// theirs was drawn with an older look (User.bunnyAvatarStale), this re-renders it from the saved spec, offscreen, with
// the editor's own renderer and animations (AvatarStage, the CS:S rig from the player content), and saves it again
// through POST /me/avatar/bunny: the same ownership check and hourly limit as a save from the editor.
//
// Once per page and at most every few hours per browser, in the background: a while after load, when the page is idle,
// visible and not in play (the pointer isn't locked), so the hitch of a fresh WebGL context never lands in a run.
// Silent: any failure (no WebP encoder in this browser, an item no longer owned, offline, no player content) leaves the
// old picture until the next try or the deploy-time batch (tools/avatar/rerender-saved.ts). The avatar editor
// (avatar/main.ts) does the same with its own stage when it opens on a stale saved avatar.

import { api, type User } from "../api";
import { discoverPlayerContent } from "../content/index";
import { playerContent } from "../content/player";
import { loadAnimRig } from "../player/studio/loader";
import { AvatarStage, type MapShots } from "./stage";
import { AVATAR_PX, AVATAR_RENDER_VERSION, type AvatarSpec } from "./spec";

const blobOf = (c: HTMLCanvasElement, type: string, quality?: number) => new Promise<Blob | null>((res) => c.toBlob(res, type, quality));

/** The saved picture for `spec`: a 256 px WebP (base64), the smallest quality that fits the API's limit. */
export async function avatarWebpBase64(stage: AvatarStage, spec: AvatarSpec, maps: MapShots | null): Promise<string> {
  const c = await stage.render(spec, AVATAR_PX, maps);
  // Smallest WebP that fits (photos of maps are the big ones).
  for (const quality of [0.9, 0.8, 0.65, 0.5]) {
    const b = await blobOf(c, "image/webp", quality);
    if (!b || b.type !== "image/webp") throw new Error("This browser can't make WebP images.");
    if (b.size <= 90 * 1024) {
      const bytes = new Uint8Array(await b.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    }
  }
  throw new Error("That picture is too detailed to save. Try another backdrop.");
}

export interface MapEntry {
  name: string;
  hero?: string | null;
  sha256?: string;
}

/** The site's map list (backdrops' hero shots; the player content's manifest). Empty when it can't be read. */
export const mapIndex = (): Promise<MapEntry[]> =>
  fetch("/index.json")
    .then((r) => (r.ok ? r.json() : { maps: [] }))
    .then((j: { maps?: MapEntry[] }) => j.maps ?? [])
    .catch(() => []);

/** Registers the player content (the bunny's CS:S animations) from a map's manifest, unless a map already did. */
export async function playerAnims(list: MapEntry[]): Promise<boolean> {
  if (!playerContent()) {
    const sha = (list.find((m) => m.name === "bhop_eazy") ?? list.find((m) => m.sha256))?.sha256;
    if (!sha || !(await discoverPlayerContent(sha).catch(() => false))) return false;
  }
  return !!(await loadAnimRig().catch(() => null));
}

/** Poses a stage again until its bunny runs the CS:S animations (they switch in on its next update). */
export async function settleOnAnims(stage: AvatarStage, tries = 60): Promise<boolean> {
  for (let i = 0; i < tries && stage.animSource !== "cs"; i++) {
    stage.repose();
    await new Promise((r) => setTimeout(r, 50));
  }
  stage.repose();
  return stage.animSource === "cs";
}

const TRIED_KEY = "bunnyhop:avatar-refresh";
const RETRY_MS = 6 * 3600_000;
let started = false;

/** Whether this browser tried this player's refresh to this version lately (a browser that can't, stops asking). */
function triedLately(userId: string): boolean {
  try {
    const t = JSON.parse(localStorage.getItem(TRIED_KEY) ?? "null") as { u?: string; v?: number; at?: number } | null;
    return !!t && t.u === userId && t.v === AVATAR_RENDER_VERSION && Date.now() - (t.at ?? 0) < RETRY_MS;
  } catch {
    return false;
  }
}
function markTried(userId: string): void {
  try {
    localStorage.setItem(TRIED_KEY, JSON.stringify({ u: userId, v: AVATAR_RENDER_VERSION, at: Date.now() }));
  } catch {
    /* private mode */
  }
}

/**
 * Re-renders and re-saves the signed-in player's saved avatar when it's older than this build's look. Resolves true
 * when a new picture was saved; never throws.
 */
export async function refreshSavedAvatar(): Promise<boolean> {
  let stage: AvatarStage | null = null;
  try {
    const mine = await api.bunnyAvatar();
    if (!mine.custom || (mine.render ?? 1) >= AVATAR_RENDER_VERSION) return false;
    const list = await mapIndex();
    // The editor poses with the CS:S animations; without them the picture wouldn't match it, so wait for the next try.
    if (!(await playerAnims(list))) return false;
    const maps: MapShots = { hero: (name) => list.find((m) => m.name === name)?.hero ?? null };
    stage = new AvatarStage();
    stage.set(mine.spec);
    if (!(await settleOnAnims(stage))) return false;
    await api.saveBunnyAvatar(mine.spec, await avatarWebpBase64(stage, mine.spec, maps));
    console.info(`avatar: re-rendered your saved avatar for look ${AVATAR_RENDER_VERSION}`);
    return true;
  } catch {
    return false;
  } finally {
    stage?.dispose();
  }
}

/** When the page is idle, visible and out of play (no pointer lock): `fn`, once. */
function whenQuiet(fn: () => void, delayMs: number): void {
  const idle = (cb: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(cb, { timeout: 5000 }) : setTimeout(cb, 200));
  const check = () => {
    if (document.visibilityState !== "visible" || document.pointerLockElement) return void setTimeout(check, 5000);
    idle(fn);
  };
  setTimeout(check, delayMs);
}

/** For the signed-in player GET /me answered with: refresh their saved avatar in the background if it's stale. */
export function scheduleAvatarRefresh(user: User | null, delayMs = 12_000): void {
  if (started || !user?.bunnyAvatarStale || triedLately(user.id)) return;
  started = true;
  whenQuiet(() => {
    markTried(user.id);
    void refreshSavedAvatar();
  }, delayMs);
}
