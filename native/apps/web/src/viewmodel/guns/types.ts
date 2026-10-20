// Gun registry types: the map-given guns (physics v4, research/WEAPONS.md) as the client draws and hears them. Purely
// presentation: the simulation decides when a gun fires, reloads or switches; everything here only shows it.
//
// A gun is code like the knives (viewmodel/knives/): a mesh builder in the gun's own frame, the two-hand hold, the
// framing in view space, where the muzzle / ejection port / magazine are, and the timings its animations are sized to.
// The designs are ours (research/WEAPONS.md "the guns"): each reads as its archetype (compact / burst / heavy pistol,
// pump / auto shotgun, bullpup SMG) with the knives' hand-made, slightly playful low-poly look, no real-world markings.
//
// Gun-local frame (every gun; = the Gun bone's frame in first person): Source units, x forward along the barrel, y left,
// z up, like Source viewmodel space, so a gun at identity points at the crosshair. The origin is the top of the grip's
// backstrap (where the web of the right hand sits under the slide / receiver).

import type { V3 } from "../../player/bunny/rig";
import type { KnifeCtx } from "../knives/ctx";
import type { Curl } from "../knives/types";

/**
 * The core's weapon ids that have a model of their own (research/WEAPONS.md): the six map guns, plus the rifle and
 * sniper stand-ins (modelled as the ak47 / awp, borrowed by the other rifles / snipers: guns/index.ts GUN_STAND_IN).
 * The in-world names are GunDef.name.
 */
export type GunId = "glock" | "usp" | "fiveseven" | "m3" | "xm1014" | "p90" | "ak47" | "awp";
export const GUN_IDS: readonly GunId[] = ["glock", "usp", "fiveseven", "m3", "xm1014", "p90", "ak47", "awp"];

export type GunClass = "pistol" | "shotgun" | "smg" | "rifle" | "sniper";

/**
 * Moving parts (extra bones after the hands' rig, guns/rig.ts). Every part's bind is the identity at the gun origin.
 * Sil: a silencer (GunDef.silencer), built seated on the muzzle; hidden while it's off.
 */
export type GunPart = "Gun" | "Slide" | "Mag" | "Pump" | "Aux" | "Sil";

/**
 * A hand placement relative to the gun: the hand's "held object" frame (knives/hold.ts HandFrame.carrot: origin in the
 * fist, z out of the index / thumb side, x toward the knuckles) expressed in gun-local coordinates.
 *   o      where the middle of the fist's grip goes (gun-local)
 *   up     the held axis, out of the index side of the fist (a pistol grip's axis, up toward the slide)
 *   fwd    roughly where the knuckles point (orthonormalised against `up`)
 */
export interface HandPlace {
  o: V3;
  up: V3;
  fwd: V3;
}

/** One hand on the gun: placement, the finger curls (limits of the grip solver for the wrapped ones), what wraps. */
export interface HandGrip extends HandPlace {
  index: Curl;
  middle: Curl;
  ring: Curl;
  pinky: Curl;
  thumb: Curl;
  /** Fingers the grip solver closes onto the gun (knives/hold.ts wrapFingers); the others keep their curl. */
  wrap: ("Index" | "Middle" | "Ring" | "Pinky" | "Thumb")[];
  /** Seat the held part on the palm at this gap (units, < 0 = pressed in a little); omitted = placed as is. */
  seat?: number;
  /** The part this hand rides on (the shotgun's pump hand follows the Pump bone). Default Gun. */
  part?: GunPart;
  /**
   * Extra grip for the solver only (gun-local capsules, a, b, radius): the support hand of a pistol wraps the right
   * hand's fingers, which aren't part of the gun.
   */
  proxy?: [V3, V3, number][];
}

/** View-space framing of the gun at rest: origin (forward, left, up) and angles (pitch, yaw, roll; degrees). */
export interface Framing {
  o: V3;
  a: V3;
}

export interface GunTiming {
  /** Seconds between shots (semi: the fastest tap rate). */
  cycle: number;
  /** Magazine / tube size (the HUD and the reload's empty variants). */
  ammo: number;
  /** Full reload (magazine guns), seconds; the animation is sized to it. */
  reload?: number;
  /** Tube guns: start, per shell, end (seconds). */
  shells?: { start: number; each: number; end: number };
  /** Deploy, seconds (the next attack is ready then). */
  draw: number;
  /** Burst mode: rounds and the gap between them (the Glock's burst). */
  burst?: { n: number; gap: number };
  /** Pump-action: the pump starts this long after a shot and takes `dur`. */
  pump?: { at: number; dur: number };
}

export interface Recoil {
  /** Pitch kick (deg, muzzle up) and push back (units) per shot. */
  kick: number;
  back: number;
  /** Random roll / yaw per shot (deg). */
  roll: number;
  /** Spring stiffness of the settle (higher = snappier). */
  settle: number;
  /** Slide / bolt travel (units) and its cycle time (s); 0 = nothing visible moves. */
  slide: number;
  slideTime: number;
}

export interface GunSounds {
  fire: string;
  /** The silenced shot (a gun with a silencer, while it's on). */
  silenced?: string;
  /** Playback rate of the fire clip (a stand-in borrowing another gun's shot, deeper: < 1). Default 1. */
  fireRate?: number;
  /** Reload cue ids (guns/sounds.ts): played at times inside the reload. */
  magOut?: string;
  magIn?: string;
  slide?: string;
  pump?: string;
  shell?: string;
}

/**
 * A screw-on silencer (the Cottontail's; physics v7, research/WEAPONS.md "Silencer animation beat sheet"). Built in the
 * gun-local frame as it sits seated on the muzzle (first person: skinned to the Sil bone; third person: its own small
 * mesh, guns/meshes.ts bunnySilencerGeometry). The animation (guns/anim.ts silencer clip) carries it in the left hand,
 * lines it up on the bore, turns it on along the thread and seats it, or the reverse.
 */
export interface SilencerSpec {
  build(k: KnifeCtx): void;
  /** The bore axis (gun-local y, z) and where the can's rear face sits when seated (gun-local x). */
  axis: [number, number];
  seat: number;
  /** Thread length: how far out along the bore the can first bites (the twists turn it in by this much). */
  thread: number;
  /** The muzzle when it's on: the can's front face (gun-local). */
  tip: V3;
  /** The support hand around the can (gun-local, the can seated), solved onto it like a hold (guns/hold.ts). */
  grip: HandGrip;
}

export interface GunDef {
  id: GunId;
  /** In-world name ("Thumper"). */
  name: string;
  /** What it is, plainly ("Burst pistol"). */
  archetype: string;
  blurb: string;
  cls: GunClass;
  /**
   * Builds the gun in its local frame through `k` (first person: parts skinned to the Gun / Slide / Mag / Pump bones by
   * `bone`; third person and world: everything rigid, fewer segments, k.view === "tp"). Grips use PART.grip (the grip
   * solver wraps those), the main painted surfaces PART.blade with along / across coordinates (finish-ready; guns take
   * no finish yet).
   */
  build(k: KnifeCtx): void;
  /** The right hand (firing hand) and the left (support) hand. */
  right: HandGrip;
  left: HandGrip;
  /** Rest framing in view space (before the viewmodel offsets). */
  frame: Framing;
  /** Elbow anchors (view space) the forearms aim toward; default guns/viewmodel.ts ELBOW (the pistols'). */
  elbows?: { R: V3; L: V3 };
  /**
   * Left-hand targets on the gun (reloads, racks, inspects; guns/anim.ts leftT): "mag" (holding the magazine as it
   * sits seated), "rack" (pinching the slide / bolt / charging handle), "port" (a shotgun's loading port, the shell's
   * seated position is Aux's), "tail" (the Cottontail's tail).
   */
  places: Partial<Record<"mag" | "rack" | "port" | "tail", HandPlace>>;
  /** A screw-on silencer (the Cottontail): its model, thread, tip and the support hand's grip on it. */
  silencer?: SilencerSpec;
  /** Muzzle point and the ejection port + its throw direction (gun-local). */
  muzzle: V3;
  eject: { p: V3; dir: V3 };
  shell: "pistol" | "smg" | "shotgun";
  /** The magazine's pivot (gun-local): where it leaves / enters (bottom of the grip, top of the P90). */
  mag?: { p: V3; out: V3 };
  timing: GunTiming;
  recoil: Recoil;
  sounds: GunSounds;
  /** Third person: placement on the bunny's R_Hand (gun-local -> hand frame), like the knives' TpSpec. */
  tp: { o: V3; x: V3; z: V3; s: number };
  /** Rough triangle count of the first-person model (filled at build). */
  tris?: number;
}
