// Inspect clip / set types. A knife's inspect set is a combo chain (combo.ts): trick 0 is the base inspect (a tap of F),
// each next one is what a re-press during the trick escalates into.

import type { KnifeDef, KnifeState } from "../knives/types";
import type { ComboSpec, TrickSpec } from "./combo";
import type { Arm } from "./kit";

export interface InspectCtx {
  arm: Arm;
  /** The knife in hand (null = the carrot). */
  knife: KnifeDef | null;
  /** Its hold state (extra-bone angles etc.; null for the carrot). Clips may write `angles`. */
  state: KnifeState | null;
}

export interface InspectClip extends TrickSpec {
  /** Display name (dev HUD / docs). */
  name: string;
  /** Poses the trick at t (s, full weight) on top of W (the base pose, knife hold already applied). */
  apply(W: Float32Array, t: number, ctx: InspectCtx): void;
  /** Intervals where the knife leaves the fist: clearance checks (clearance.ts) include the grip there. */
  free?: [number, number][];
  /**
   * How far (0..1) the knife's hold should be in its "show" pose at t (KnifeState.show; e.g. the Karrotbit ends its
   * tricks turned to face you). Read before the hold layer poses the frame, so the trick plays on top of it.
   */
  show?(t: number): number;
}

export interface InspectSet {
  /** Knife registry id this set is for ("carrot", "karrotbit", ...). */
  id: string;
  clips: InspectClip[];
  spec: ComboSpec;
}

export function inspectSet(id: string, clips: InspectClip[], maxLoops?: number): InspectSet {
  return { id, clips, spec: { tricks: clips, maxLoops } };
}
