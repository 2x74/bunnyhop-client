// Hop effects (v0.0.42; the Loadout's Hop effect, progression.ts "hop-*"): a small burst at the feet each time a player
// hops. This file is the recipes and the spawn maths, as plain data with no three.js or DOM, so tests and the native
// client can read it; player/hop-layer.ts draws the pieces (one instanced draw call per scene).
//
// They are effects, not pictures: light, sparks, mist and motes, built from a few procedural pieces (a glow, a shock
// ring, a noise-eroded puff, a streak along its motion, a fleck that glints as it turns, a bolt, a ray of light, a
// droplet). An effect is layers in time: a flash in the first frames, the burst, a short tail of lingering motes.
//
// A burst is a few groups of pieces (HopPart). Each piece is spawned once, with everything it will ever do (start,
// velocity, life, sizes, colours, spin), and from then on its place is a closed form of its age, worked out on the GPU:
//
//   v(t) = g / k + (v0 - g / k) e^(-k t)                 k = drag (1/s), g = (0, -gravity, 0)
//   p(t) = p0 + g t / k + (v0 - g / k) (1 - e^(-k t)) / k  (+ a sideways sway: flutter)
//   size(t) = mix(size0, size1, 1 - (1 - u)^ease) × pop(t) × exit       u = t / life
//   pop(t) = 1 - (1 - pop) e^(-zeta x) cos(pi x)          x = t / attack: there at once at `pop` of its size, past it
//                                                         by `over` at `attack` seconds, then settled
//   colour(t): white-hot by `white` at birth, cooled to `color` by `cool` of its life, then on to `color2`
//   exit: from `hold` of its life on it fades, shrinks away, or both
//
// so a hop costs one write of a few records and nothing per frame on the CPU. Every piece is at full strength on its
// first frame (at 1,500 u/s a fade-in is over after the bunny has gone). When: the moment a hop leaves the ground (the
// bunny's jump event, player/bunny/model.ts). A bhop's landing and its takeoff are the same tick, so this is both; a
// plain landing with no jump (the end of a run, a drop) makes nothing, which keeps standing around quiet. Every hop
// makes the same burst: the models have no authoritative perfect-hop signal (rooms carry poses only), so there is no
// accent for one.

export type HopShape = "glow" | "ring" | "puff" | "streak" | "fleck" | "glint" | "bolt" | "ray" | "drop" | "petal" | "chunk";
/** Shape codes for the fragment shader (player/hop-layer.ts), in this order. */
export const HOP_SHAPES: readonly HopShape[] = ["glow", "ring", "puff", "streak", "fleck", "glint", "bolt", "ray", "drop", "petal", "chunk"];

/**
 * face: a quad facing the camera, turned by its spin. floor: lying on the ground (tilted to its slope), turned by its
 * spin, cut off where its floor ends. streak: facing the camera, its long side along its motion on screen. flip: facing
 * the camera, a flat piece turning over about its length (its width goes with cos; it catches the light face on). up:
 * standing on the ground and turned to the camera about the vertical, growing from its base.
 */
export type HopOrient = "face" | "floor" | "streak" | "flip" | "up";
export const HOP_ORIENTS: readonly HopOrient[] = ["face", "floor", "streak", "flip", "up"];

/** How a piece goes at the end of its life (from `hold` on). */
export type HopExit = "fade" | "shrink" | "both";
export const HOP_EXITS: readonly HopExit[] = ["fade", "shrink", "both"];

/** A colour: "tint" / "tint2" are the trail's two colours (one-colour trails: both the same), else "#rrggbb". */
export type HopColor = "tint" | "tint2" | `#${string}`;

export interface HopPart {
  shape: HopShape;
  orient: HopOrient;
  /** Pieces in the burst. */
  n: number;
  /** Life in seconds, picked per piece from [min, max]. */
  life: readonly [number, number];
  /** Half size at birth and at death (units; up: half its width), each piece ±`jitter` of it (default 0.15). */
  size: readonly [number, number];
  jitter?: number;
  /** How fast the size gets from birth to death: 1 - (1 - u)^ease (default 2; higher: most of it at once). */
  ease?: number;
  /** Height over width (default 1). streak: length over width at rest. */
  aspect?: number;
  /** Horizontal speed outward from the feet, and vertical speed (u/s), picked per piece from [min, max]. */
  out?: readonly [number, number];
  up?: readonly [number, number];
  /** Horizontal speed round the feet (u/s): a ribbon curls. */
  swirl?: number;
  /** Spawned up to this far from the feet (units, horizontally), and up to this high above the floor (a lone piece: exactly this high). */
  ring?: number;
  lift?: number;
  /** Spawned exactly `ring` out and exactly a sector apart, in order (an even arc; their flutter runs along it as a wave). */
  rim?: boolean;
  /** floor: its long side points out from the feet (a bolt along the ground). */
  radial?: boolean;
  /**
   * The pieces go out in even sectors over `arc` degrees (default 360), each within ±`spread` of its sector's middle
   * (a share of the sector, default 0.3), so a burst is never a clump on one side. `aim`: the arc's middle, degrees
   * from the direction of travel (180 = thrown behind); absent: anywhere.
   */
  arc?: number;
  aim?: number;
  spread?: number;
  /** Share of the player's horizontal velocity the pieces keep (the kept speed is capped: HOP_INHERIT_CAP). */
  inherit?: number;
  /** Downward acceleration (u/s²; negative rises) and drag (1/s). */
  gravity?: number;
  drag?: number;
  /** Turned at birth by up to this either way (radians; default: any way round). */
  tilt?: number;
  /** Turn rate (rad/s), random sign per piece; flip: how fast it turns over. */
  spin?: number;
  /** flip: turn rate in the plane of the screen (rad/s). */
  turn?: number;
  /** A sideways sway as it falls: [units, rad/s]; `rock`: it tilts with the sway by this much (radians). */
  flutter?: readonly [number, number];
  rock?: number;
  /** up: pieces away from the middle lean outward by up to this (radians at `ring` units out). */
  lean?: number;
  color: HopColor;
  /** Colour at death (default: `color`). Some shapes use it across the shape instead (a ray's top, a standing shard's root). */
  color2?: HopColor;
  /** How white-hot it is at birth (0..1; the heat sits in its core) and the share of its life it has cooled by (default 0.3). */
  white?: number;
  cool?: number;
  /** glow: how soft its edge is (0 hard .. 1 all falloff; default 0.6). */
  soft?: number;
  /** How much its brightness flickers (0..0.9; embers). */
  flicker?: number;
  /** How much darker than its colour it has gone by its death (0..1, in tenths): it cools on past its colour. */
  char?: number;
  /** Peak opacity (default 1), and how additive it is (0 = plain blending, 1 = adds light; kept under HOP_GLOW_CAP). */
  alpha?: number;
  glow?: number;
  /** Share of the life before it starts to go (default 0.5), and how it goes (default "fade"). */
  hold?: number;
  exit?: HopExit;
  /** Size on the first frame as a share of full (default 0.6), how far past full it springs (default 0.12), and when (seconds, default 0.07). */
  pop?: number;
  over?: number;
  attack?: number;
  /** ring: thickness at birth (share of the radius); streak / drop: stretch (seconds of travel). */
  param?: number;
  /** The part starts `wait` seconds after the hop, and piece k another k × delay after that. */
  wait?: number;
  delay?: number;
}

/**
 * A still picture of an effect: the moment it is taken at (seconds into a burst), how far the picture reaches from its
 * middle (units), how high over the floor its middle is, how far from above it is seen (radians; pieces on the ground
 * from higher, standing ones from lower) and the way the hop was going (degrees: 0 to the right, 90 towards the eye).
 */
export interface HopStill {
  at: number;
  frame: number;
  rise: number;
  tilt: number;
  head: number;
}

export interface HopFxDef {
  id: string;
  parts: readonly HopPart[];
  /** A still picture of it (the Loadout's tiles, unlock cards). */
  still: HopStill;
}

/** At most this many bursts between two draws of a scene's layer, and one per player every HOP_GAP seconds. */
export const HOP_FRAME_CAP = 16;
export const HOP_GAP = 0.12;
/** The most speed a piece keeps from the player (u/s): at 1,500 u/s a burst still marks where the hop was. */
export const HOP_INHERIT_CAP = 140;
/** No piece adds more light than this share (the rest of it blends): sixteen players hopping don't bloom a dark map. */
export const HOP_GLOW_CAP = 0.7;

/** The recipes, by cosmetic id. Sizes are half sizes in units (the bunny is about 72 tall). */
export const HOP_FX: Readonly<Record<string, HopFxDef>> = {
  // A low rolling puff kicked out behind the feet with a few grains of grit; it billows, thins and is gone.
  "hop-dust": {
    id: "hop-dust",
    still: { at: 0.12, frame: 22, rise: 6, tilt: 0.5, head: 20 },
    parts: [
      { shape: "ring", orient: "floor", n: 1, life: [0.22, 0.22], size: [7, 22], ease: 3, jitter: 0, color: "#eadfc8", color2: "#b9aa8e", alpha: 0.6, param: 0.55, hold: 0.25, pop: 1 },
      { shape: "puff", orient: "face", n: 4, life: [0.4, 0.56], size: [5.5, 12.5], jitter: 0.25, ease: 2.6, out: [70, 130], up: [10, 34], aim: 180, arc: 200, ring: 3, lift: 5, inherit: 0.15, gravity: -22, drag: 4.5, spin: 0.6, color: "#dccdae", color2: "#a39375", alpha: 0.8, hold: 0.25, exit: "fade", pop: 0.6, over: 0.1 },
      { shape: "glow", orient: "face", n: 5, life: [0.24, 0.4], size: [1.2, 0.7], out: [90, 190], up: [50, 130], aim: 180, arc: 220, ring: 2, lift: 3, inherit: 0.15, gravity: 620, drag: 1.5, soft: 0.25, color: "#cdbb98", color2: "#9c8c70", alpha: 0.95, hold: 0.6, pop: 1 },
    ],
  },
  // A flash on the ground and one ring of light racing out of it, hot at its front, in the trail colour; a few motes lift off it.
  "hop-ring": {
    id: "hop-ring",
    still: { at: 0.09, frame: 30, rise: 2, tilt: 0.75, head: 0 },
    parts: [
      { shape: "glow", orient: "floor", n: 1, life: [0.16, 0.16], size: [10, 22], ease: 3, jitter: 0, color: "tint", white: 0.7, cool: 0.5, soft: 1, alpha: 0.75, glow: 0.55, hold: 0.1, pop: 1 },
      { shape: "ring", orient: "floor", n: 1, life: [0.36, 0.36], size: [9, 32], ease: 3.4, jitter: 0, color: "tint", color2: "tint2", white: 0.8, cool: 0.35, char: 0.3, alpha: 0.95, glow: 0.25, param: 0.5, hold: 0.45, pop: 1 },
      { shape: "glow", orient: "face", n: 5, life: [0.34, 0.5], wait: 0.05, size: [1.9, 0.8], out: [30, 60], up: [30, 70], ring: 12, lift: 2, gravity: -30, drag: 3, flutter: [2, 9], soft: 0.5, color: "tint", color2: "tint2", white: 0.5, alpha: 0.95, glow: 0.3, hold: 0.4, exit: "both", pop: 0.8 },
    ],
  },
  // A hot flash and a spray of sparks: white streaks along their flight that cool to the trail colour, arc over and die.
  "hop-sparks": {
    id: "hop-sparks",
    still: { at: 0.06, frame: 24, rise: 9, tilt: 0.45, head: 0 },
    parts: [
      { shape: "glow", orient: "face", n: 1, life: [0.1, 0.1], size: [10, 14], jitter: 0, lift: 4, color: "tint", white: 1, cool: 0.8, soft: 0.9, alpha: 0.9, glow: 0.6, hold: 0.15, pop: 1 },
      { shape: "glow", orient: "floor", n: 1, life: [0.18, 0.18], size: [9, 17], jitter: 0, color: "tint", white: 0.5, cool: 0.5, soft: 1, alpha: 0.55, glow: 0.6, hold: 0.1, pop: 1 },
      { shape: "streak", orient: "streak", n: 10, life: [0.24, 0.42], size: [2.2, 0.9], aspect: 1.6, out: [110, 260], up: [130, 330], ring: 2, lift: 3, inherit: 0.12, gravity: 760, drag: 2.4, color: "tint", color2: "tint2", white: 0.95, cool: 0.4, char: 0.4, alpha: 1, glow: 0.2, param: 0.036, hold: 0.55, exit: "both", pop: 1 },
    ],
  },
  // A burst of cold mist low on the ground, a pale ring of frost racing out under it, and ice motes that glint as they fall.
  "hop-frost": {
    id: "hop-frost",
    still: { at: 0.14, frame: 24, rise: 8, tilt: 0.5, head: 0 },
    parts: [
      { shape: "ring", orient: "floor", n: 1, life: [0.3, 0.3], size: [8, 23], ease: 3.2, jitter: 0, color: "#dff2ff", color2: "#8ec8ff", white: 0.5, cool: 0.4, alpha: 0.65, glow: 0.3, param: 0.4, hold: 0.35, pop: 1 },
      { shape: "puff", orient: "face", n: 4, life: [0.32, 0.46], size: [5, 11], aspect: 0.7, jitter: 0.2, ease: 2.6, out: [90, 150], up: [4, 18], ring: 3, lift: 4, inherit: 0.12, gravity: -8, drag: 5, spin: 0.4, color: "#dff3ff", color2: "#86bdf0", alpha: 0.5, glow: 0.2, hold: 0.15, pop: 0.6 },
      { shape: "fleck", orient: "flip", n: 7, life: [0.4, 0.68], size: [2.2, 1.4], aspect: 1.5, out: [40, 110], up: [70, 170], ring: 4, lift: 5, inherit: 0.12, gravity: 300, drag: 2.6, spin: 13, turn: 2, flutter: [3, 9], color: "#a9dcff", color2: "#5aa6f0", white: 0.3, cool: 0.4, alpha: 1, glow: 0.2, hold: 0.55, exit: "both", pop: 0.8 },
      { shape: "glint", orient: "face", n: 1, life: [0.16, 0.16], wait: 0.08, size: [5, 5], jitter: 0, lift: 14, color: "#ffffff", alpha: 0.9, glow: 0.7, hold: 0.3, exit: "shrink", pop: 0.3, over: 0.2, attack: 0.05 },
    ],
  },
  // A glow on the ground and embers lifting out of it: they flicker, sway and cool from white through the trail colour to nothing.
  "hop-embers": {
    id: "hop-embers",
    still: { at: 0.18, frame: 22, rise: 12, tilt: 0.45, head: 0 },
    parts: [
      { shape: "glow", orient: "floor", n: 1, life: [0.34, 0.34], size: [10, 17], jitter: 0, color: "tint", white: 0.6, cool: 0.3, soft: 1, alpha: 0.8, glow: 0.5, hold: 0.15, pop: 1 },
      { shape: "glow", orient: "face", n: 11, life: [0.45, 0.85], size: [2.9, 1], jitter: 0.35, out: [20, 80], up: [60, 175], ring: 6, lift: 3, inherit: 0.15, gravity: -70, drag: 2.2, flutter: [4, 8], soft: 0.5, flicker: 0.5, color: "tint", color2: "tint2", white: 0.85, cool: 0.25, char: 0.5, alpha: 1, glow: 0.2, hold: 0.5, exit: "both", pop: 0.8 },
      { shape: "streak", orient: "streak", n: 3, life: [0.2, 0.3], size: [1.3, 0.6], aspect: 1.5, out: [60, 140], up: [150, 260], ring: 3, lift: 3, gravity: 500, drag: 2.5, color: "tint", white: 0.9, cool: 0.5, char: 0.4, glow: 0.25, param: 0.025, hold: 0.5, exit: "both", pop: 1 },
    ],
  },
  // Petals in the trail colour tossed up on a breath of pollen: they turn over, catch the light and sway down.
  "hop-petals": {
    id: "hop-petals",
    still: { at: 0.18, frame: 22, rise: 14, tilt: 0.45, head: 0 },
    parts: [
      { shape: "glow", orient: "face", n: 1, life: [0.11, 0.11], size: [8, 12], jitter: 0, lift: 4, color: "tint", white: 0.7, cool: 0.8, soft: 0.9, alpha: 0.7, glow: 0.4, hold: 0.15, pop: 1 },
      { shape: "petal", orient: "flip", n: 7, life: [0.55, 0.82], size: [4.6, 3.8], jitter: 0.2, out: [45, 110], up: [95, 175], ring: 3, lift: 6, inherit: 0.15, gravity: 330, drag: 2.5, spin: 7, turn: 1.8, flutter: [5, 8], rock: 0.45, color: "tint", color2: "tint2", alpha: 1, hold: 0.6, exit: "both", pop: 0.6, over: 0.15 },
      { shape: "glow", orient: "face", n: 5, life: [0.35, 0.6], size: [1.4, 0.6], out: [20, 70], up: [60, 140], ring: 5, lift: 6, gravity: 40, drag: 3, flutter: [3, 10], soft: 0.5, color: "#fff3c4", white: 0.6, alpha: 0.9, glow: 0.6, hold: 0.4, exit: "both", pop: 0.8 },
    ],
  },
  // Chunks of carrot knocked up out of a puff of orange dust, tumbling in the light, with flecks of its green top.
  "hop-carrot": {
    id: "hop-carrot",
    still: { at: 0.15, frame: 22, rise: 14, tilt: 0.45, head: 0 },
    parts: [
      { shape: "glow", orient: "face", n: 1, life: [0.1, 0.1], size: [8, 12], jitter: 0, lift: 4, color: "#ff9a3c", white: 0.7, cool: 0.8, soft: 0.9, alpha: 0.7, glow: 0.4, hold: 0.15, pop: 1 },
      { shape: "puff", orient: "face", n: 2, life: [0.26, 0.34], size: [5, 10], ease: 2.6, out: [40, 80], up: [10, 30], ring: 3, lift: 5, inherit: 0.15, drag: 5, spin: 0.6, color: "#ffb469", color2: "#e88a3a", alpha: 0.4, glow: 0.15, hold: 0.1, pop: 0.6 },
      { shape: "chunk", orient: "face", n: 6, life: [0.42, 0.62], size: [3.3, 2.7], jitter: 0.25, out: [50, 120], up: [130, 230], ring: 3, lift: 5, inherit: 0.15, gravity: 820, drag: 1.1, spin: 9, color: "#ff8a2a", color2: "#f0761a", white: 0.3, cool: 0.2, alpha: 1, hold: 0.65, exit: "both", pop: 0.6, over: 0.15 },
      { shape: "petal", orient: "flip", n: 3, life: [0.45, 0.62], size: [3.2, 2.6], out: [50, 100], up: [110, 180], ring: 3, lift: 6, inherit: 0.15, gravity: 420, drag: 2.4, spin: 7, turn: 2, flutter: [4, 9], rock: 0.4, color: "#7bd84e", color2: "#4fae32", alpha: 1, hold: 0.6, exit: "both", pop: 0.6 },
    ],
  },
  // A kick of speed: a flash under the feet and a fan of light streaks fired out behind, low and fast.
  "hop-boost": {
    id: "hop-boost",
    still: { at: 0.06, frame: 26, rise: 6, tilt: 0.5, head: 0 },
    parts: [
      { shape: "glow", orient: "face", n: 1, life: [0.1, 0.1], size: [9, 13], jitter: 0, lift: 4, color: "tint", white: 1, cool: 0.8, soft: 0.9, alpha: 0.85, glow: 0.6, hold: 0.15, pop: 1 },
      { shape: "ring", orient: "floor", n: 1, life: [0.2, 0.2], size: [6, 22], ease: 3, jitter: 0, color: "tint", white: 0.7, cool: 0.5, alpha: 0.75, glow: 0.3, param: 0.3, hold: 0.3, pop: 1 },
      { shape: "streak", orient: "streak", n: 8, life: [0.16, 0.3], size: [1.6, 0.7], aspect: 2.4, out: [330, 560], up: [8, 70], aim: 180, arc: 64, spread: 0.45, ring: 3, lift: 3, gravity: 60, drag: 7, color: "tint", color2: "tint2", white: 0.9, cool: 0.5, char: 0.3, alpha: 1, glow: 0.25, param: 0.05, hold: 0.45, exit: "both", pop: 1 },
      { shape: "glow", orient: "face", n: 3, life: [0.3, 0.45], wait: 0.06, size: [1.7, 0.6], out: [40, 90], up: [20, 50], aim: 180, arc: 80, ring: 10, lift: 3, drag: 3, flutter: [2, 9], soft: 0.5, color: "tint", white: 0.5, alpha: 0.95, glow: 0.3, hold: 0.4, exit: "both", pop: 0.8 },
    ],
  },
  // A crackle of static: bolts jump out along the ground and up off it for a few frames, with a flash and a couple of sparks.
  "hop-static": {
    id: "hop-static",
    still: { at: 0.05, frame: 26, rise: 5, tilt: 0.65, head: 0 },
    parts: [
      { shape: "glow", orient: "face", n: 1, life: [0.09, 0.09], size: [9, 12], jitter: 0, lift: 4, color: "tint", white: 1, cool: 0.9, soft: 0.9, alpha: 0.85, glow: 0.6, hold: 0.15, pop: 1 },
      { shape: "bolt", orient: "floor", n: 5, radial: true, life: [0.14, 0.24], size: [11, 14], jitter: 0.25, aspect: 0.42, ring: 12, spread: 0.4, color: "tint", color2: "tint2", white: 0.9, cool: 0.7, alpha: 1, glow: 0.3, hold: 0.6, pop: 0.7, over: 0.05, attack: 0.04 },
      { shape: "bolt", orient: "up", n: 2, life: [0.12, 0.2], wait: 0.03, size: [4.5, 4.5], aspect: 2.2, ring: 7, lean: 0.5, color: "tint", white: 0.9, cool: 0.7, alpha: 1, glow: 0.3, hold: 0.6, pop: 0.6, attack: 0.04 },
      { shape: "streak", orient: "streak", n: 3, life: [0.16, 0.26], size: [1.3, 0.6], aspect: 1.5, out: [120, 220], up: [90, 190], ring: 4, lift: 3, gravity: 700, drag: 2.5, color: "tint", white: 0.95, cool: 0.5, char: 0.4, glow: 0.25, param: 0.025, hold: 0.5, exit: "both", pop: 1 },
    ],
  },
  // Supporter, Geode: slivers of crystal light spring from the ground, violet at the root and aqua at the tip, a gleam
  // running up them; they shatter into flecks that glint as they turn, over a violet glow.
  "hop-crystals": {
    id: "hop-crystals",
    still: { at: 0.14, frame: 23, rise: 13, tilt: 0.35, head: 0 },
    parts: [
      { shape: "glow", orient: "face", n: 1, life: [0.1, 0.1], size: [9, 13], jitter: 0, lift: 5, color: "#7df3e4", white: 0.9, cool: 0.8, soft: 0.9, alpha: 0.8, glow: 0.6, hold: 0.15, pop: 1 },
      { shape: "glow", orient: "floor", n: 1, life: [0.34, 0.34], size: [10, 17], jitter: 0, color: "#8f6bff", color2: "#5ff2df", white: 0.4, cool: 0.3, soft: 1, alpha: 0.7, glow: 0.45, hold: 0.2, pop: 1 },
      { shape: "fleck", orient: "up", n: 1, life: [0.34, 0.34], size: [5.4, 5.4], aspect: 3, jitter: 0, color: "#35dccb", color2: "#6a3fe6", white: 0.2, cool: 0.4, alpha: 0.97, glow: 0.15, hold: 0.7, exit: "shrink", pop: 0.35, over: 0.14, attack: 0.07 },
      { shape: "fleck", orient: "up", n: 3, life: [0.28, 0.34], wait: 0.015, delay: 0.012, size: [4.3, 4.3], aspect: 2.5, jitter: 0.2, ring: 8, lean: 0.6, spread: 0.25, color: "#35dccb", color2: "#6a3fe6", white: 0.2, cool: 0.4, alpha: 0.97, glow: 0.15, hold: 0.7, exit: "shrink", pop: 0.35, over: 0.16, attack: 0.07 },
      { shape: "fleck", orient: "flip", n: 6, life: [0.3, 0.5], wait: 0.2, size: [2.2, 1.2], aspect: 1.7, out: [50, 130], up: [90, 210], ring: 6, lift: 14, inherit: 0.15, gravity: 620, drag: 1.6, spin: 15, turn: 3, color: "#4fe6d6", color2: "#7a55f0", white: 0.3, cool: 0.4, alpha: 1, glow: 0.2, hold: 0.5, exit: "both", pop: 0.8 },
      { shape: "glint", orient: "face", n: 2, life: [0.16, 0.2], wait: 0.07, delay: 0.14, size: [6, 6], jitter: 0.15, ring: 5, lift: 24, color: "#ffffff", alpha: 0.9, glow: 0.7, hold: 0.3, exit: "shrink", pop: 0.3, over: 0.2, attack: 0.05 },
    ],
  },
  // Supporter, High Roller: a warm flash and a toss of gold flecks, flashing white each time they turn to the light,
  // with a glint or two among them.
  "hop-gold": {
    id: "hop-gold",
    still: { at: 0.15, frame: 24, rise: 18, tilt: 0.45, head: 0 },
    parts: [
      { shape: "glow", orient: "face", n: 1, life: [0.1, 0.1], size: [10, 14], jitter: 0, lift: 4, color: "#ffc93c", white: 0.9, cool: 0.8, soft: 0.9, alpha: 0.85, glow: 0.6, hold: 0.15, pop: 1 },
      { shape: "glow", orient: "floor", n: 1, life: [0.24, 0.24], size: [9, 16], jitter: 0, color: "#ffb82e", white: 0.4, soft: 1, alpha: 0.5, glow: 0.6, hold: 0.15, pop: 1 },
      { shape: "fleck", orient: "flip", n: 11, life: [0.48, 0.74], size: [3, 1.9], aspect: 1.2, jitter: 0.25, out: [30, 115], up: [150, 285], ring: 3, lift: 5, inherit: 0.15, gravity: 780, drag: 0.9, spin: 15, turn: 3, color: "#ffb812", color2: "#c97f08", white: 0.25, cool: 0.15, alpha: 1, glow: 0.15, hold: 0.65, exit: "both", pop: 0.7 },
      { shape: "glint", orient: "face", n: 2, life: [0.16, 0.2], wait: 0.1, delay: 0.12, size: [6, 6], jitter: 0.15, out: [10, 40], up: [80, 120], ring: 8, lift: 22, inherit: 0.15, drag: 1, color: "#fff6d6", alpha: 0.9, glow: 0.7, hold: 0.3, exit: "shrink", pop: 0.3, over: 0.2, attack: 0.05 },
    ],
  },
  // Supporter, Borealis: a ribbon of light unfurls in an arc behind the feet, ray by ray, green going to violet; it
  // curls round as it lifts and fades, a wave running along it, and leaves a few motes.
  "hop-aurora": {
    id: "hop-aurora",
    still: { at: 0.24, frame: 25, rise: 10, tilt: 0.42, head: 90 },
    parts: [
      { shape: "glow", orient: "floor", n: 1, life: [0.26, 0.26], size: [10, 20], ease: 3, jitter: 0, color: "#7dffc9", color2: "#16e493", white: 0.7, cool: 0.4, soft: 1, alpha: 0.75, glow: 0.45, hold: 0.1, pop: 1 },
      { shape: "ray", orient: "up", n: 11, rim: true, ring: 15, arc: 240, aim: 180, swirl: 34, up: [8, 8], drag: 2, life: [0.5, 0.62], delay: 0.01, size: [5.4, 6.4], aspect: 3.1, jitter: 0.08, flutter: [2.6, 8], color: "#16e493", color2: "#a05bff", white: 0.4, cool: 0.3, alpha: 0.9, glow: 0.3, hold: 0.45, exit: "fade", pop: 0.4, over: 0.14, attack: 0.08 },
      { shape: "glow", orient: "face", n: 4, life: [0.45, 0.7], wait: 0.12, size: [1.9, 0.6], out: [10, 40], up: [40, 90], ring: 14, lift: 8, gravity: -30, drag: 2.5, flutter: [3, 8], soft: 0.5, color: "#7dffc9", color2: "#b07bff", white: 0.5, alpha: 0.9, glow: 0.65, hold: 0.4, exit: "both", pop: 0.8 },
    ],
  },
  // Supporter, Tidepool: a crown of droplets thrown up in a ring with the light on them, two higher from the middle, a
  // ripple running out on the ground under a breath of spray.
  "hop-splash": {
    id: "hop-splash",
    still: { at: 0.11, frame: 24, rise: 10, tilt: 0.5, head: 0 },
    parts: [
      { shape: "ring", orient: "floor", n: 1, life: [0.4, 0.4], size: [8, 28], ease: 2.6, jitter: 0, color: "#dffbff", color2: "#63cfdc", white: 0.5, cool: 0.3, alpha: 0.8, glow: 0.35, param: 0.34, hold: 0.4, pop: 1 },
      { shape: "puff", orient: "face", n: 2, life: [0.22, 0.3], size: [4, 9], aspect: 0.7, ease: 2.6, out: [40, 70], up: [10, 30], ring: 3, lift: 4, drag: 4.5, spin: 0.5, color: "#c9f6fb", color2: "#7fd8e4", alpha: 0.3, glow: 0.25, hold: 0.1, pop: 0.6 },
      { shape: "drop", orient: "streak", n: 8, rim: true, ring: 5, spread: 0.2, life: [0.34, 0.46], size: [2.3, 1.5], aspect: 1.5, out: [48, 70], up: [150, 200], lift: 4, inherit: 0.15, gravity: 820, drag: 0.8, color: "#7fe3ec", color2: "#3fb4c8", alpha: 0.95, glow: 0.25, param: 0.012, hold: 0.6, exit: "both", pop: 0.7 },
      { shape: "drop", orient: "streak", n: 2, life: [0.4, 0.5], size: [2.6, 1.6], aspect: 1.5, out: [5, 20], up: [230, 265], ring: 2, lift: 5, inherit: 0.15, gravity: 820, drag: 0.8, color: "#9aeef4", color2: "#3fb4c8", alpha: 0.95, glow: 0.25, param: 0.014, hold: 0.6, exit: "both", pop: 0.7 },
      { shape: "glint", orient: "face", n: 2, life: [0.14, 0.18], wait: 0.07, delay: 0.1, size: [5, 5], jitter: 0.15, ring: 8, lift: 16, color: "#ffffff", alpha: 0.9, glow: 0.7, hold: 0.3, exit: "shrink", pop: 0.3, over: 0.2, attack: 0.05 },
    ],
  },
};

export const hopFxOf = (id: string | null | undefined): HopFxDef | null => (id ? (HOP_FX[id] ?? null) : null);

/** The most pieces one burst of `def` spawns (at full quality). */
export const burstSize = (def: HopFxDef): number => def.parts.reduce((n, p) => n + p.n, 0);

/** How long a burst of `def` lasts at most (seconds). */
export const burstLife = (def: HopFxDef): number => Math.max(...def.parts.map((p) => (p.wait ?? 0) + (p.delay ?? 0) * (p.n - 1) + p.life[1]));

// ---------------------------------------------------------------------------------------------
// Spawning

/** Floats per piece (player/hop-layer.ts reads them as thirteen vec4 instance attributes). */
export const HOP_RECORD = 52;
/** A floor reach that cuts nothing (no probe: flat everywhere). */
export const NO_CUT = 1e4;
//   0 x y z t0        position at birth (three.js space, y up) and the emitter clock at birth
//   4 vx vy vz life   velocity at birth (u/s) and life (s)
//   8 size0 size1 gravity drag
//  12 r g b alpha     its colour (linear) and peak opacity
//  16 r g b glow      colour at death (linear) and how additive
//  20 code rock rot0 spin          code = shape + 32 × orient + 256 × exit; rot0: the turn at birth (up: the lean per
//                                  unit out from the hop); spin: rad/s (flip: turning over; up: the direction
//                                  it sways in, an angle on the ground)
//  24 slot seed param hold         the emitter's clock slot, a 0..1 seed, the shape's param (face / flip: its height over
//                                  the floor at birth), hold
//  28 reach × 8                    floor: how far the floor goes from the hop in eight directions (HopSpawn.reach); -1: not cut
//  36 pop zeta attack ease         pop(t) = 1 - (1 - pop) e^(-zeta t / attack) cos(pi t / attack)
//  40 ox oz slopeX slopeZ          the hop (three.js x, z) and the ground's slope there (rise per unit x, per unit z)
//  44 white cool soft flicker      how white-hot at birth, the share of its life it has cooled by, a glow's softness,
//                                  flicker (0..0.9) + 100 × char (in tenths)
//  48 aspect turn flutter flutterRate

export interface HopSpawn {
  /** The feet on the ground at takeoff (three.js space, y up). */
  x: number;
  y: number;
  z: number;
  /** The player's horizontal velocity (three.js space, u/s). */
  vx: number;
  vz: number;
  /** The emitter's clock at the hop (seconds) and its slot in the layer. */
  t: number;
  slot: number;
  /** Piece count scale (Potato graphics: 0.5) and motion scale (reduced motion: 0.35). */
  quality: number;
  motion: number;
  /** The trail's two colours (linear RGB). */
  tint: readonly [number, number, number];
  tint2: readonly [number, number, number];
  /** Overall opacity (a ghost's). */
  alpha: number;
  /**
   * How far the floor reaches from the feet at the same height in eight directions (Source units; direction k is k × 45°
   * from Source +x towards +y), or null (unknown: flat everywhere). Pieces on the ground are cut off where it ends.
   */
  reach: ArrayLike<number> | null;
  /** The ground's slope at the feet: its rise per unit of three.js x and of z (null: level). */
  slope: ArrayLike<number> | null;
}

/** sRGB "#rrggbb" -> linear RGB (what three.js's Color holds under ColorManagement). */
export function linearRgb(hex: string, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  for (let i = 0; i < 3; i++) {
    const c = ((n >> (16 - 8 * i)) & 255) / 255;
    out[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return out;
}

const hexCache = new Map<string, [number, number, number]>();
const colorOf = (c: HopColor, s: HopSpawn): readonly [number, number, number] => {
  if (c === "tint") return s.tint;
  if (c === "tint2") return s.tint2;
  let v = hexCache.get(c);
  if (!v) hexCache.set(c, (v = linearRgb(c)));
  return v;
};

// A small seeded generator (mulberry32) in module state: a burst allocates nothing.
let rs = 1;
function rnd(): number {
  rs = (rs + 0x6d2b79f5) | 0;
  let x = Math.imul(rs ^ (rs >>> 15), 1 | rs);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}
const range = (r: readonly [number, number] | undefined) => (r ? r[0] + (r[1] - r[0]) * rnd() : 0);

/** A burst's seed from where and when it happened: the same replay tick makes the same burst (exports, re-watching). */
export function hopSeed(x: number, z: number, t: number): number {
  let h = Math.imul(Math.round(x) | 0, 0x9e3779b1) ^ Math.imul(Math.round(z) | 0, 0x85ebca6b) ^ Math.imul(Math.round(t * 100) | 0, 0xc2b2ae35);
  h ^= h >>> 15;
  return h | 0;
}

/** The floor's reach (units) towards the three.js offset (dx, dz) from the hop: between the two measured either side. */
export function reachToward(reach: ArrayLike<number>, dx: number, dz: number): number {
  const f = ((Math.atan2(-dz, dx) / (Math.PI / 4)) % 8 + 8) % 8;
  const k = Math.floor(f) % 8;
  return reach[k] + (reach[(k + 1) % 8] - reach[k]) * (f - Math.floor(f));
}

const rec = new Float32Array(HOP_RECORD);
const D2R = Math.PI / 180;

/**
 * Spawns one burst of `def` at `s`: calls `write` once per piece with its record (HOP_RECORD floats, the same array
 * every time: copy it out). Returns how many it wrote.
 */
export function spawnHop(def: HopFxDef, s: HopSpawn, seed: number, write: (r: Float32Array) => void): number {
  rs = seed | 0 || 1;
  let count = 0;
  const m = s.motion;
  const speed = Math.hypot(s.vx, s.vz);
  const heading = speed > 1 ? Math.atan2(s.vx, s.vz) : 0;
  for (const p of def.parts) {
    const n = p.n === 1 ? 1 : Math.max(1, Math.round(p.n * s.quality));
    const c1 = colorOf(p.color, s), c2 = colorOf(p.color2 ?? p.color, s);
    const shape = HOP_SHAPES.indexOf(p.shape), orient = HOP_ORIENTS.indexOf(p.orient), exit = HOP_EXITS.indexOf(p.exit ?? "fade");
    const floor = p.orient === "floor", grounded = floor || p.orient === "up";
    const jitter = p.jitter ?? 0.15;
    const arc = (p.arc ?? 360) * D2R;
    const start = p.aim === undefined ? rnd() * Math.PI * 2 : heading + p.aim * D2R - arc / 2;
    const spread = p.spread ?? (p.rim ? 0 : 0.3);
    const pop = p.pop ?? 0.6;
    const zeta = Math.max(0.2, Math.log(Math.max(Math.abs(1 - pop), 1e-3) / Math.max(p.over ?? 0.12, 1e-3)));
    // The share of the player's speed it keeps, the kept speed no more than the cap.
    const inherit = speed > 0 ? (Math.min((p.inherit ?? 0) * speed, HOP_INHERIT_CAP) / speed) * m : 0;
    for (let k = 0; k < n; k++) {
      const a = start + ((k + 0.5 + (rnd() * 2 - 1) * spread) * arc) / n;
      const dx = Math.sin(a), dz = Math.cos(a);
      let r = (p.ring ?? 0) * (p.rim || p.radial ? 1 : 0.45 + 0.55 * rnd());
      // On the ground: never past the edge of the floor it stands on.
      if (grounded && s.reach && r > 0) r = Math.max(0, Math.min(r, reachToward(s.reach, dx, dz) - 2));
      const out = range(p.out) * m, up = range(p.up) * m;
      const x = s.x + dx * r, z = s.z + dz * r;
      const sx = s.slope ? s.slope[0] : 0, sz = s.slope ? s.slope[1] : 0;
      const js = 1 + (rnd() * 2 - 1) * jitter;
      // A bolt along the ground points out from the feet (the quad's +u along its direction).
      const rot = p.radial ? Math.PI / 2 - a : p.orient === "up" ? (p.lean ?? 0) / Math.max(p.ring ?? 0, 1) : (rnd() * 2 - 1) * (p.tilt ?? Math.PI);
      const swirl = (p.swirl ?? 0) * m;
      rec[0] = x;
      // On the ground: a floor piece's corners take the slope in the shader; a standing one is planted where it is.
      const high = grounded ? 0 : (p.lift ?? 0) * (n === 1 ? 1 : 0.4 + 0.6 * rnd());
      rec[1] = s.y + (floor ? 0.6 : grounded ? 0.3 + (x - s.x) * sx + (z - s.z) * sz : high);
      rec[2] = z;
      rec[3] = s.t + (p.wait ?? 0) + k * (p.delay ?? 0);
      rec[4] = dx * out + dz * swirl + s.vx * inherit;
      rec[5] = up;
      rec[6] = dz * out - dx * swirl + s.vz * inherit;
      rec[7] = range(p.life);
      rec[8] = p.size[0] * js;
      rec[9] = p.size[1] * js;
      rec[10] = (p.gravity ?? 0) * m;
      rec[11] = p.drag ?? 0;
      rec[12] = c1[0];
      rec[13] = c1[1];
      rec[14] = c1[2];
      rec[15] = (p.alpha ?? 1) * s.alpha;
      rec[16] = c2[0];
      rec[17] = c2[1];
      rec[18] = c2[2];
      rec[19] = Math.min(p.glow ?? 0, HOP_GLOW_CAP);
      rec[20] = shape + 32 * orient + 256 * exit;
      rec[21] = p.rock ?? 0;
      rec[22] = rot;
      const sign = rnd() < 0.5 ? -1 : 1;
      const pieceSeed = rnd();
      // In order along an even arc: the flutter's phase runs along it and it sways in and out.
      rec[25] = p.rim ? (n > 1 ? k / (n - 1) : 0.5) : pieceSeed;
      rec[23] = p.orient === "up" ? (p.rim ? Math.PI / 2 - a : pieceSeed * 40) : (p.spin ?? 0) * m * sign;
      rec[24] = s.slot;
      // Pieces that face the camera: how high over the floor it is born (soft ones thin out into the ground).
      rec[26] = p.orient === "face" || p.orient === "flip" ? high : (p.param ?? 0);
      rec[27] = Math.min(p.hold ?? 0.5, 0.98);
      for (let i = 0; i < 8; i++) rec[28 + i] = floor ? (s.reach ? s.reach[i] : NO_CUT) : -1;
      rec[36] = pop;
      rec[37] = zeta;
      rec[38] = p.attack ?? 0.07;
      rec[39] = p.ease ?? 2;
      rec[40] = s.x;
      rec[41] = s.z;
      rec[42] = sx;
      rec[43] = sz;
      rec[44] = p.white ?? 0;
      rec[45] = p.cool ?? 0.3;
      rec[46] = p.soft ?? 0.6;
      rec[47] = Math.min(p.flicker ?? 0, 0.9) + 10 * Math.round((p.char ?? 0) * 10);
      rec[48] = p.aspect ?? 1;
      rec[49] = (p.turn ?? 0) * m * (rnd() < 0.5 ? -1 : 1);
      rec[50] = p.flutter ? p.flutter[0] : 0;
      rec[51] = p.flutter ? p.flutter[1] * m : 0;
      write(rec);
      count++;
    }
  }
  return count;
}
