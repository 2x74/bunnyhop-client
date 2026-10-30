// Knife registry types (research/COSMETICS-PLAN.md §2.1, §3.2, §4.2). A knife is code: a mesh builder in its own local
// frame, a first-person hold (where it sits in the fist + finger curls), optional per-action adjustments, and pivots the
// inspects spin about. Nothing here is wired into production yet: the carrot stays the default everywhere until the
// cosmetic slot (progression.ts, card editor) calls setKnife() (knives/equipped.ts).
//
// Knife-local frame (all knives, = the Knife_Handle bone's frame in first person): units are Source units, z runs
// along the blade toward the tip (the grip sits around the origin, in the fist), y across the blade's width, x through
// its thickness (the flat faces look along ±x). The finish shaders' side projection is (z, y).

import type { V3 } from "../../player/bunny/rig";
import type { Rarity } from "../../progression";
import type { VmAction } from "../procedural";
import type { KnifeCtx } from "./ctx";
import type { HandFrame } from "./hold";

/**
 * Rarity tiers (plan §2): 1 Garden, 2 Market, 3 Prize, 4 Heirloom, 5 Golden. Names and colours have ONE source,
 * progression.ts RARITY (the UI reads the catalogue's rarity); a knife's `rarity` must match its catalogue entry
 * (apps/api/test/loadout.test.ts checks it).
 */
export type { Rarity };

/** finishUV.z part ids (player/bunny/builder.ts): which surfaces a finish may paint. */
export const PART = { none: 0, blade: 1, guard: 2, grip: 3, glove: 4, cuff: 5 } as const;

/**
 * Knife hardware materials (Paint.mat, ctx.ts fixed(colour, mat)): how the first-person viewmodel shades a part on
 * Source and up (finishes/detail.ts). Stored as finishUV.z = part + mat / 16, so keep mat <= 6 (the part still rounds
 * the same). A finish still paints the blade over its material.
 */
export const KMAT = {
  none: 0,
  /** Polished bare metal (steel, silver, gold): a studio (or the scene, Enhanced) reflection tinted by the colour. */
  polished: 1,
  /** Satin / blackened metal (gunmetal guards): blurred reflection, broad highlight. */
  satin: 2,
  /** Lacquer / enamel / hard candy: the colour under a glossy clear coat. */
  lacquer: 3,
  /** Grip: cord wrap, rubber, ray skin: matte, a fine weave in relief. */
  grip: 4,
  /** Vegetable skin (carrot, daikon, leaves): a waxy sheen and fine growth lines. */
  veg: 5,
} as const;
export type KMat = (typeof KMAT)[keyof typeof KMAT];

/** Finger joint curls in degrees (proximal, middle, distal) + an optional spread about the palm normal at the root. */
export interface Curl {
  /** Curl per joint toward the palm (thumb: across the palm). */
  c: V3;
  /** Spread (deg) of the whole finger about the palm normal at its root; + toward the index side. */
  spread?: number;
}

/** First-person hold: where the knife sits in the right fist and how the fingers wrap it (bind space, hand-relative). */
export interface HoldSpec {
  index: Curl;
  middle: Curl;
  ring: Curl;
  pinky: Curl;
  thumb: Curl;
  /**
   * The knife frame (Knife_Handle, bind space) for this hold, given the hand frame with the fingers already curled
   * (HandFrame.joint / .seg give the posed finger joints). Default: the carrot's grip (HandFrame.carrot).
   */
  place?(h: HandFrame): Float32Array;
  /**
   * Grip solver (hold.ts wrapFingers): these fingers close joint by joint from `from` (deg per joint) toward their curl
   * above until each segment rests on the knife's grip (its first-person mesh, through the glove's skin), never sinking
   * into the knife, so they wrap whatever handle the knife has. `seat`: first move the knife along the palm normal so
   * its grip rests on the palm at that gap (units, < 0 = pressed in a little); omitted = where `place` puts it.
   * `pivot` (knife-local): seat by tilting the knife toward / away from the palm about that point instead (a karambit's ring,
   * which has to stay on the index finger). `gripZ`: only the grip within this knife-local z range is the handle the
   * fingers and palm rest on (a karambit's ring is grip too, but it's the index finger's). `rooted`: fingers whose root
   * stays at the hold's curl (a karambit's index, through the ring) and only close their two distal joints.
   */
  wrap?: {
    fingers: ("Index" | "Middle" | "Ring" | "Pinky" | "Thumb")[];
    from?: V3;
    seat?: number;
    pivot?: V3;
    gripZ?: [number, number];
    /** Wrapped fingers whose root joint stays at the hold's curl (only their two distal joints close). */
    rooted?: ("Index" | "Middle" | "Ring" | "Pinky")[];
  };
}

/** Per-frame knife state the hold layer applies (and inspects may overwrite before KnifeHold.solve). */
export interface KnifeState {
  /**
   * Whole right arm + knife, rigidly, like the inspect's present move: `a` = pitch / yaw (degrees, view space) about
   * the elbow, then roll about the forearm axis (pronation +); `o` = offset forward / left / up (units, view space).
   * E.g. the Karrotbit's idle turns the back of the fist to the camera so the ring and the hook show.
   */
  arm: { o: [number, number, number]; a: [number, number, number] };
  /** Wrist bend: pitch / yaw / roll (degrees, view space) of the hand + knife about the wrist; the forearm stays. */
  wrist: [number, number, number];
  /** Knife offset in its own local frame (units), e.g. re-centring a closed balisong in the fist. */
  offset: [number, number, number];
  /** Extra knife-local transform of Knife_Handle (3x4, after `offset`; null = none), e.g. bunnyflyHeldByBite(). */
  local: Float32Array | null;
  /** Joint angles (deg) of the knife's extra bones (KnifeDef.joints order). */
  angles: number[];
  /**
   * 0..1: how far the inspect playing wants the knife's "show" pose (InspectClip.show, weighted by the inspect's own
   * blend; set by inspects/runtime.ts before the hold layer runs, never reset by it). The knife's pose() decides what
   * that pose is (the Karrotbit: turned to face you).
   */
  show: number;
  /** 0..1: the fingers let go of the handle (KnifeHold: middle, ring and little finger open, the index a third), e.g. while a balisong's handle swings round in the draw. Reset every frame. */
  loosen: number;
}

export interface KnifeDef {
  /** Registry id ("karrotbit"); the cosmetic id is `knife-<id>` (plan §2.1). */
  id: string;
  cosmeticId: string;
  name: string;
  rarity: Rarity;
  /** One line for the card / Loadout. */
  blurb: string;
  /**
   * Builds the knife in its local frame through `k` (first person: skinned to Knife_Handle and the extra bones; third
   * person: rigidly on the bunny's right hand, k.view === "tp", lower detail). Blades must mark PART.blade with the
   * along / across coordinates (k.blade() does), so every finish applies.
   */
  build(k: KnifeCtx): void;
  /** Third person: the knife's placement in the bunny's R_Hand frame (default: the carrot's). */
  tp?: TpSpec;
  /** First-person hold (default: the carrot's fist). */
  hold?: HoldSpec;
  /** Extra bones (rig.ts EXTRA_BONES short names) driven by KnifeState.angles, each rotating by -angle about local x. */
  joints?: string[];
  /**
   * Per-action adjustments (idle / draw / slash / stab), written into `s` (pre-reset each frame). `src`: what drives the
   * arm underneath (v_knife_t's sequences with hosted content, or procedural.ts): their rest poses differ, so big
   * pose changes (the Karrotbit's reverse grip) are tuned per source.
   */
  pose?(action: VmAction, t: number, s: KnifeState, src: "cs" | "procedural"): void;
  /** Spin pivots for inspects, knife-local: e.g. karrotbit "ring" (centre + hole axis), cleaver "hole". */
  pivots?: Record<string, { p: V3; axis: V3 }>;
  /** Rough triangle count of the knife alone (first person), filled in by the registry at build time (dev stats). */
  tris?: number;
}

/** Third-person placement: knife-local -> bunny R_Hand bone frame (x along the fingers). */
export interface TpSpec {
  /** Grip origin in the hand frame. */
  o: V3;
  /** Knife +z (toward the tip) and +y (width) directions in the hand frame (orthonormalised). */
  z: V3;
  y: V3;
  /**
   * Scale of the knife-local model (first-person sized) on the bunny: ~1.6 for registry knives (the bunny's hand is
   * ~1.4x the viewmodel's, plus a little so the blade reads at normal viewing distance; v0.0.4's ~1.2 left them barely
   * visible); the carrot's own third-person recipe is already ~1.4x and uses 1.15.
   */
  s: number;
}
