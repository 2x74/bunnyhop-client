// Weapon (carrot blade) events: a tiny bus for cosmetic hooks such as sounds. Nothing here touches the simulation;
// events fire when an animation starts. Local events are also forwarded to the audio module's own viewmodel bus
// (audio/events.ts: swing / stab / draw), which plays the carrot sounds; remote / replay events carry a position for
// positional sounds.
//
//   import { onWeaponEvent } from "../viewmodel/events";
//   const off = onWeaponEvent((e) => { if (e.type === "slash") play(e.variant === 1 ? "slash1" : "slash2", e); });
//
// Sources:
//   "local"   your own viewmodel (fires whether or not the viewmodel is shown, like r_drawviewmodel 0 in CS:S)
//   "remote"  another player's swing in a multiplayer room (position = their feet, Source units)
//   "replay"  the replay viewer's player (position = feet)
//
// Inspects (inspects/: a tap of F, re-presses chain tricks) fire "inspect" for every trick that starts (trick = its
// index in the knife's chain, 0 = the base inspect) and cue events inside the tricks: "flip" (the knife leaves the
// fingers: a flick, a toss), "spin" (mid-spin, once per turn of a hold-loop), "catch" (the regrip). Remote / replay
// players fire them too, from their third-person gesture. Local ones reuse the carrot sounds for now (light swing for
// flip / spin, the draw's leafy rustle for catch); dedicated clips would be better (audio team: carrot_flip,
// carrot_spin, carrot_catch).

import { viewmodelEvents } from "../audio/events";

export type WeaponEventType =
  /** Deploy (spawn, restart, viewmodel shown again). */
  | "draw"
  /** Primary attack (mouse1): a quick slash, alternating sides (variant 1 / 2, CS:S midslash1 / midslash2). */
  | "slash"
  /** Secondary attack (mouse2): the heavier stab. */
  | "stab"
  /** Inspect: a trick of the knife's inspect chain started (`trick`: 0 = the base inspect, 1+ = escalations). */
  | "inspect"
  /** Inspect cue: the knife leaves the fingers (thumb flick, toss). */
  | "flip"
  /** Inspect cue: mid-spin (also once per hold-loop turn). */
  | "spin"
  /** Inspect cue: the regrip / catch. */
  | "catch";

export interface WeaponEvent {
  type: WeaponEventType;
  source: "local" | "remote" | "replay";
  /** Slash side: 1 = midslash1 (right to left), 2 = midslash2 (left to right). */
  variant?: 1 | 2;
  /** Inspect events: index of the trick in the knife's chain (0 = base). */
  trick?: number;
  /** Inspect: the trick's id ("hop-flip", "ring-spin", ...), when known. */
  name?: string;
  /** World position (Source units, feet) for remote / replay events. */
  position?: readonly [number, number, number];
  /** Multiplayer slot for remote events. */
  slot?: number;
  /** performance.now() when emitted. */
  time: number;
}

type Listener = (e: WeaponEvent) => void;
const listeners = new Set<Listener>();

/** Subscribes; returns an unsubscribe function. */
export function onWeaponEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitWeaponEvent(e: Omit<WeaponEvent, "time">): void {
  // Your own carrot's sounds: audio/index.ts listens on its viewmodel bus (swing / stab / draw).
  if (e.source === "local") {
    if (e.type === "slash") viewmodelEvents.emit("swing");
    else if (e.type === "stab") viewmodelEvents.emit("stab");
    else if (e.type === "draw") viewmodelEvents.emit("draw");
    else if (e.type === "flip") viewmodelEvents.emit("swing", { strength: 0.42 });
    else if (e.type === "spin") viewmodelEvents.emit("swing", { strength: 0.2 });
    else if (e.type === "catch") viewmodelEvents.emit("draw", { strength: 0.45 });
  }
  if (!listeners.size) return;
  const ev: WeaponEvent = { ...e, time: performance.now() };
  for (const l of listeners) {
    try {
      l(ev);
    } catch (err) {
      console.warn("weapon event listener:", err);
    }
  }
}

/** Cosmetic attack kinds as recorded in replays (replay.ts cosmetic events) and sent to rooms (protocol SF_SLASH / SF_STAB). */
export const ATTACK_SLASH = 1;
export const ATTACK_STAB = 2;
