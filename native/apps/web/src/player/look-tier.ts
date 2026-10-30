// How much material detail the player materials draw (player/fabric.ts), from the graphics look: one shared uniform
// read by every player material at upload time (like the finishes' clock), so switching the look never recompiles a
// program and costs nothing per frame.
//   0  Potato / Plain: the plain shading plus the baked occlusion and a cheap highlight; every detail branch skipped.
//   1  Source: + stitching, rib knit, soft fabric sheen, heathered fleece, leather / rubber / glass highlights, a
//      sky-and-ground reflection on the visor and the glossy bits.
//   2  Enhanced / Cinematic: + finer knit and leather grain, and the visor reflecting the real scene through the metal
//      knives' cube capture (viewmodel/finishes/environment.ts) whenever that is running anyway; never started for it.
// main.ts sets it with the graphics settings; pages without a game (player.html, the avatar editor) keep the default.

import type * as THREE from "three";
import { graphicsPreset, type GraphicsOptions } from "../graphics/presets";
import { peekFinishEnvironment } from "../viewmodel/finishes/environment";

/** -1: "off", the plain shading exactly as before the garment materials (for A/B perf checks in the dev harnesses). */
export type PlayerLookTier = -1 | 0 | 1 | 2;

let tier: PlayerLookTier = 2;

/** A tier by name (dev pages, harnesses) or number. */
export function setPlayerLookTier(t: PlayerLookTier | "off" | "potato" | "plain" | "source" | "enhanced"): void {
  tier = typeof t === "number" ? t : t === "enhanced" ? 2 : t === "source" ? 1 : t === "off" ? -1 : 0;
}

export function playerLookTier(): PlayerLookTier {
  return tier;
}

/** The tier for a graphics setup: Potato and Plain (classic) 0, Source 1, Enhanced / Cinematic 2. */
export function lookTierOf(g: Pick<GraphicsOptions, "preset" | "potato">): 0 | 1 | 2 {
  if (g.potato) return 0;
  const p = graphicsPreset(g.preset);
  return p === "classic" ? 0 : p === "source" ? 1 : 2;
}

const readOnly = <T>(get: () => T): THREE.IUniform<T> =>
  ({
    get value() {
      return get();
    },
    set value(_: T) {
      /* read-only */
    },
  }) as THREE.IUniform<T>;

export interface PlayerLookUniforms {
  uPlayerLook: THREE.IUniform<number>;
  uPlayerEnv: THREE.IUniform<THREE.Texture | null>;
  uPlayerEnvOn: THREE.IUniform<number>;
}

/** Shared by every player material (materials.ts playerUniforms). */
export const PLAYER_LOOK_UNIFORMS: PlayerLookUniforms = {
  uPlayerLook: readOnly(() => tier),
  uPlayerEnv: readOnly(() => (tier >= 2 ? peekFinishEnvironment() : null)),
  uPlayerEnvOn: readOnly(() => (tier >= 2 && peekFinishEnvironment() ? 1 : 0)),
};

// Dev hook for the capture / perf harnesses (research/player-look/): the page's own instance of this module.
if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV && "window" in globalThis) Object.assign(globalThis, { __playerLook: { set: setPlayerLookTier, get: playerLookTier } });
