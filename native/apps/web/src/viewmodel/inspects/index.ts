// Inspect sets per knife (knives/ registry ids): each is a combo chain (combo.ts), trick 0 on a tap of F, the next ones
// on re-presses during a trick.
//
//   carrot, golden   Hop Flip -> Double Flip -> Toss & Catch                              (carrot.ts)
//   karrotbit        Ring Spin (1 turn) -> Double Ring Spin -> Triple + reverse catch      (karrotbit.ts; hold F loops)
//   bunnyfly         Flick Open -> Fan Flips -> Aerial                                    (bunnyfly.ts, Bfly_* bones)
//   daikon           Twirl -> Blade Check -> Reverse Sheath                               (daikon.ts)
//   thornback        Thorn Toss -> Double Toss                                            (bayonets.ts)
//   thistle          Pinwheel -> Backspin                                                 (bayonets.ts; hold F spins)
//   whirligig        Flick -> Pinwheel -> Backspin, the spinner racing                     (whirligig.ts; hold F spins)
//   anything else    Classic (v0.0.4's wrist roll) -> Hop Flip                            (classic.ts + carrot.ts)
//
// Dev: ?vminspect=<set id | clip id> forces a set (finishes/dev.ts): flip / carrot, classic, karrotbit, bunnyfly, daikon.

import type { KnifeDef } from "../knives/types";
import { THISTLE_INSPECTS, THORNBACK_INSPECTS } from "./bayonets";
import { BUNNYFLY_INSPECTS } from "./bunnyfly";
import { CARROT_INSPECTS, hopFlip } from "./carrot";
import { classic } from "./classic";
import { DAIKON_INSPECTS } from "./daikon";
import { KARROTBIT_INSPECTS } from "./karrotbit";
import { WHIRLIGIG_INSPECTS } from "./whirligig";
import { inspectSet, type InspectSet } from "./types";

export const DEFAULT_INSPECTS = inspectSet("default", [classic, hopFlip]);
export const CLASSIC_INSPECTS = inspectSet("classic", [classic]);

export const INSPECT_SETS: readonly InspectSet[] = [CARROT_INSPECTS, KARROTBIT_INSPECTS, BUNNYFLY_INSPECTS, DAIKON_INSPECTS, THORNBACK_INSPECTS, THISTLE_INSPECTS, WHIRLIGIG_INSPECTS, DEFAULT_INSPECTS, CLASSIC_INSPECTS];

/** The inspect set for a knife (null = the carrot). */
export function inspectSetFor(knife: Pick<KnifeDef, "id"> | null | undefined): InspectSet {
  switch (knife?.id ?? "carrot") {
    case "carrot":
    case "golden":
      return CARROT_INSPECTS;
    case "karrotbit":
      return KARROTBIT_INSPECTS;
    case "bunnyfly":
      return BUNNYFLY_INSPECTS;
    case "daikon":
      return DAIKON_INSPECTS;
    case "thornback":
      return THORNBACK_INSPECTS;
    case "thistle":
      return THISTLE_INSPECTS;
    case "whirligig":
      return WHIRLIGIG_INSPECTS;
    default:
      return DEFAULT_INSPECTS;
  }
}

/** Dev flag lookup: a set id, or a clip id (a one-trick set). */
export function inspectSetById(id: string): InspectSet | null {
  if (id === "flip") return CARROT_INSPECTS;
  const s = INSPECT_SETS.find((x) => x.id === id);
  if (s) return s;
  for (const set of INSPECT_SETS) {
    const c = set.clips.find((x) => x.id === id);
    if (c) return inspectSet(c.id, [c]);
  }
  return null;
}

export type { InspectClip, InspectSet } from "./types";
