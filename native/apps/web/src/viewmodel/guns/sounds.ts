// Gun sounds (our own clips, tools/audio/prompts.ts gunSfx; levels in audio/catalog.ts): each gun's shot, the reload
// and handling cues the animations call at their moments (guns/anim.ts cuesFor: magazine out / in, slide, bolt, pump,
// shell), dry fire, the burst-mode click and the pickup. Your own are flat (like the knife's); another player's (or a
// replay's) are positional at their position, so a room hears who is shooting where.
//
//   gunSound(def, "fire")                  your shot
//   gunSound(def, "fire", { at: [x, y, z] })  someone else's (Source units, their feet; lifted to the hands)

import { engine } from "../../audio";
import type { SfxId } from "../../audio/catalog";
import type { Cue } from "./anim";
import type { GunDef } from "./types";

/** "silenced": the shot through the silencer (GunSounds.silenced; the plain shot for a gun without one). */
export type GunSoundKind = Cue | "fire" | "silenced" | "pickup";

const FALLBACK: Record<string, SfxId> = {
  draw: "gun_draw",
  dry: "gun_dry",
  mode: "gun_mode",
  pickup: "gun_pickup",
  magOut: "gun_mag_out",
  magIn: "gun_mag_in",
  slide: "gun_slide",
  pump: "gun_pump",
  shell: "gun_shell_in",
  silTwist: "gun_silencer_twist",
  silSeat: "gun_silencer_seat",
  silCrack: "gun_silencer_crack",
  silOff: "gun_silencer_off",
};

/** The clip id for a gun's sound kind (its own when it has one, else the shared cue), or null. */
export function gunSfxId(def: GunDef | null, kind: GunSoundKind): SfxId | null {
  if (kind === "fire") return (def?.sounds.fire as SfxId | undefined) ?? "shot_pistol";
  if (kind === "silenced") return ((def?.sounds.silenced ?? def?.sounds.fire) as SfxId | undefined) ?? "shot_pistol";
  const own = def?.sounds[kind as keyof GunDef["sounds"]] as SfxId | undefined;
  return own ?? FALLBACK[kind] ?? null;
}

/** Plays a gun sound: flat (yours) or at a world position (another player / a replay). */
export function gunSound(def: GunDef | null, kind: GunSoundKind, o: { gain?: number; rate?: number; at?: ArrayLike<number> } = {}): void {
  const id = gunSfxId(def, kind);
  if (!id || !engine.unlocked) return;
  const g = o.gain ?? 1;
  const rate = o.rate ?? (kind === "fire" ? def?.sounds.fireRate : undefined) ?? 1;
  if (o.at) engine.playAt(id, o.at[0], o.at[1], o.at[2] + 46, g, rate);
  else engine.play(id, g, rate);
}
