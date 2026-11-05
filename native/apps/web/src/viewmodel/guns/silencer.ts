// A silencer going on and off: the Cottontail's (physics v7: +attack2 on the USP, a 3.08 s lock-out) and, as a rifle,
// the M4A1's (physics v25, the Furrow's suppressor variant, a 2.0 s lock-out; RIFLE below). The gun viewmodel's
// "silencer" clip (guns/anim.ts), choreographed beat for beat on CS:S's v_pist_usp add_silencer / detach_silencer
// (measured from the model as a reference only; research/WEAPONS.md "Silencer animation beat sheet"), with our own
// model, hands and keys. Times are in the CS:S sequence's seconds (SIL_T = 114 / 37) and scale to the core's lock-out.
//
// Screw on:  the support hand lets go and drops out of view while the gun cants; the gun swings its muzzle in toward
//            the middle of the screen; the hand comes back up from below with the can, lines it up a little ahead of
//            the muzzle, slides it back onto the thread; four twists (a wrist roll each, the fingers open a little and
//            the wrist rolls back between them; the can winds in along the thread as it turns; the gun gives a little
//            against each twist); the last one seats it with a jolt; the hand lets go and returns to the grip as the
//            gun swings back and settles, the settle landing as the lock-out ends.
// Screw off: the reverse: the hand goes to the can, a hard first turn that cracks it loose, three more twists, a
//            little pull off the thread, down and away out of view, back to the grip.
//
// Pose channels (guns/anim.ts GunPose): sil (the can shown), silX / silSpin (travel out along the bore, turn about it),
// silPitch / silYaw / silOff (the can's tilt and offset while it's carried), handRoll / handLift (the hand on the can:
// its roll about the bore, lifted off it in a re-grip), leftOpen (fingers opened on top of the grip), and the usual
// gun offset / angles and left-hand target ("sil") weight.

import { bump, E, track, type Key } from "../inspects/kit";
import type { Cue, GunPose } from "./anim";
import type { GunDef } from "./types";

/** CS:S add_silencer / detach_silencer: 115 frames at 37 fps (the USP). */
export const SIL_T = 114 / 37;

const k = (keys: Key[]) => track(keys);

/**
 * One silencer's choreography, in its own seconds (`T`, CS:S's sequence length; stretched to the core's lock-out):
 * the gun's moves, the hand's trip, the twists and every beat the clip and its sound cues key on.
 */
interface Beats {
  T: number;
  /** The twists: start, end, the can's turn (deg); screwing on, off. */
  twistsOn: [number, number, number][];
  twistsOff: [number, number, number][];
  /** Where the can is when the hand brings it (gun-local offset from its seat), carried ahead by AHEAD, tipped up. */
  pocket: [number, number, number];
  ahead: number;
  tipUp: number;
  /** View-space offset of the work (back, in, down) and the yaw's share at reduced motion. */
  work: [number, number, number];
  on: { pitch: (s: number) => number; yaw: (s: number) => number; roll: (s: number) => number; work: (s: number) => number; leftW: (s: number) => number; rise: (s: number) => number; push: (s: number) => number; carryRoll: (s: number) => number; open: (s: number) => number };
  off: { pitch: (s: number) => number; yaw: (s: number) => number; roll: (s: number) => number; work: (s: number) => number; leftW: (s: number) => number; pull: (s: number) => number; drop: (s: number) => number; carryRoll: (s: number) => number; open: (s: number) => number };
  /** Screwing on: shown from; carried until (it lines up); on the thread from (the bite) to; the seating jolt; let go. */
  shown: number;
  lineUp: number;
  bite: [number, number];
  seat: [number, number];
  letGo: [number, number];
  letGoRoll: number;
  /** The hand's return under the gun (on: from, length; off: from, length). */
  backOn: [number, number];
  backOff: [number, number];
  /** Screwing off: the reach lift ends; free of the thread; twisting ends; the crack; the pull jolt; hidden after. */
  reachLift: [number, number];
  free: [number, number];
  twistEnd: number;
  crack: [number, number];
  pullBump: [number, number];
  hidden: number;
  /** The support arm uses its working elbow the whole time the hand is on the can (not only carrying it): a rifle's
   *  muzzle is far out, so the forearm has to drop from there to the bottom of the screen. */
  armOnCan: boolean;
  /** Sound cues (own seconds): on: the bite, the seat; off: the crack, the pull off. */
  cueBite: number;
  cueSeat: number;
  cueCrack: number;
  cueOff: number;
}

/** The hand's roll at the start of a turn (screwing on: it rolls by the can's turn from here). */
const ROLL0 = -45;

// --- The Cottontail (CS:S seconds, 114 / 37).
const USP: Beats = {
  T: SIL_T,
  twistsOn: [
    [1.19, 1.41, 95],
    [1.57, 1.72, 95],
    [1.89, 2.05, 95],
    [2.22, 2.38, 75],
  ],
  twistsOff: [
    [0.65, 0.82, 75],
    [0.98, 1.14, 95],
    [1.3, 1.46, 95],
    [1.62, 1.84, 95],
  ],
  pocket: [-9, 6.5, -10],
  ahead: 2.6,
  tipUp: 14,
  work: [3.0, 4.0, 1.8],
  // The gun: cants and lifts its muzzle as the hand lets go, swings in (muzzle left, toward the middle), works, swings
  // back and settles. Angles: pitch (+ muzzle down), yaw (+ muzzle left), roll (+ top to the right).
  on: {
    pitch: k([[0, 0], [0.17, -6, E.io], [0.5, 4.5, E.io], [0.9, 3.5, E.io], [1.1, 0, E.io], [2.42, -4, E.io], [2.62, 2.5, E.io], [2.97, 6, E.io], [3.0811, 0, E.io]]),
    yaw: k([[0, 0], [0.12, -1.5, E.io], [0.6, 42, E.io], [1.05, 38, E.io], [2.3, 36, E.io], [2.58, 42, E.io], [2.97, -1.5, E.io], [3.0811, 0, E.io]]),
    roll: k([
      [0, 0], [0.2, -20, E.io], [0.6, -2, E.io],
      // Against each twist (the twisting hand drags the top over), back between them.
      [1.13, -1.5, E.io], [1.25, 4, E.io], [1.41, -16, E.io], [1.57, 3, E.io], [1.71, -18, E.io], [1.89, 3, E.io], [2.04, -20, E.io], [2.22, -2, E.io], [2.38, -24, E.io],
      [2.6, -14, E.io], [2.95, 9, E.io], [3.0811, 0, E.io],
    ]),
    // View-space offset (forward, left, up): in toward the middle and down a little while it works.
    work: k([[0.12, 0], [0.62, 1, E.io], [2.5, 1], [2.97, 0, E.io]]),
    // The support hand: off the grip and down out of view (0.04-0.3), on the can from then until it lets go (2.42),
    // back on the grip by 2.95.
    leftW: k([[0.04, 0], [0.3, 1, E.io], [2.55, 1], [2.95, 0, E.io]]),
    // The can, carried: from the pocket up to the line of the bore (0.3-0.865), back onto the thread (0.865-1.03).
    rise: k([[0.3, 1], [0.865, 0, E.io]]),
    push: k([[0.865, 0], [1.03, 1, E.io]]),
    // The wrist turns into the grip as it comes up.
    carryRoll: k([[0.3, -110], [0.865, ROLL0, E.io]]),
    // Fingers: open as the hand leaves the grip, closed on the can from the pocket; let go at 2.42.
    open: k([[0.02, 0], [0.2, 1, E.io], [0.3, 0, E.io], [2.42, 0], [2.58, 1, E.io], [2.9, 0.4, E.io], [3.0, 0, E.io]]),
  },
  // Screw off: the same beats run the other way, with its own crack and pull.
  off: {
    pitch: k([[0, 0], [0.11, 5, E.io], [0.42, 1.5, E.io], [0.62, -4, E.io], [1.98, -1, E.io], [2.2, 3.5, E.io], [2.6, 4.5, E.io], [2.92, -6, E.io], [3.0811, 0, E.io]]),
    yaw: k([[0, 0], [0.5, 42, E.io], [0.78, 36, E.io], [2.0, 38, E.io], [2.55, 42, E.io], [2.97, -1.5, E.io], [3.0811, 0, E.io]]),
    roll: k([
      [0, 0], [0.12, 8, E.io], [0.5, -14, E.io], [0.65, -22, E.io],
      // The crack: the gun gives with the hard first turn, then against each twist (the other way now).
      [0.71, -27, E.io], [0.82, -6, E.io], [0.98, -18, E.io], [1.14, 2, E.io], [1.3, -17, E.io], [1.46, 3, E.io], [1.62, -16, E.io], [1.84, 2, E.io],
      [2.1, -1.5, E.io], [2.55, -2, E.io], [2.86, -18, E.io], [3.0811, 0, E.io],
    ]),
    work: k([[0.1, 0], [0.55, 1, E.io], [2.55, 1], [3.0, 0, E.io]]),
    // The hand: from the grip to the can (0.13-0.55), on it through the pull, down out of view with it (2.22-2.7),
    // back on the grip by 3.04.
    leftW: k([[0.13, 0], [0.55, 1, E.io], [2.75, 1], [3.04, 0, E.io]]),
    pull: k([[2.0, 0], [2.22, 1, E.out]]),
    drop: k([[2.22, 0], [2.7, 1, E.in2]]),
    carryRoll: k([[2.22, ROLL0], [2.7, -110, E.io]]),
    open: k([[0.13, 0], [0.3, 1, E.io], [0.52, 0.6, E.io], [0.66, 0, E.io], [2.72, 0], [2.85, 0.8, E.io], [3.0, 0, E.io]]),
  },
  shown: 0.3,
  lineUp: 0.865,
  bite: [1.03, 1.13],
  seat: [2.36, 2.56],
  letGo: [2.42, 2.62],
  letGoRoll: 2.7,
  backOn: [2.55, 0.4],
  backOff: [0.13, 0.42],
  reachLift: [0.3, 0.62],
  free: [1.78, 1.9],
  twistEnd: 2.0,
  crack: [0.69, 0.86],
  pullBump: [2.0, 2.3],
  hidden: 2.7,
  armOnCan: false,
  cueBite: 1.0,
  cueSeat: 2.19,
  cueCrack: 0.63,
  cueOff: 1.9,
};

// --- A rifle's suppressor (the M4A1's, physics v25; own seconds: v_rif_m4a1.mdl's 61 frames at 30 fps, 2.0 s, its
// attach sound at 0.93 s, the detach at 0.70 s). Original motion: the long gun only cants a little and turns its
// muzzle a few degrees in (a pistol's swing would bring the stock across the camera); the support hand leaves the
// handguard, comes up from below with the can, lines it up ahead of the muzzle, three twists and a seat, back.
const RIFLE: Beats = {
  T: 2.0,
  twistsOn: [
    [0.62, 0.76, 110],
    [0.83, 0.96, 110],
    [1.03, 1.17, 110],
  ],
  twistsOff: [
    [0.4, 0.52, 100],
    [0.6, 0.72, 110],
    [0.8, 0.93, 110],
  ],
  pocket: [-10, 5.5, -9],
  ahead: 3.2,
  tipUp: 10,
  work: [5.5, 2.6, 0.4],
  on: {
    pitch: k([[0, 0], [0.12, -3, E.io], [0.36, 2.5, E.io], [0.6, 1, E.io], [1.2, 0.5], [1.32, -2.5, E.io], [1.5, 2, E.io], [1.84, 1.5, E.io], [2.0, 0, E.io]]),
    yaw: k([[0, 0], [0.4, 14, E.io], [1.25, 12, E.io], [1.6, 14, E.io], [1.92, -0.6, E.io], [2.0, 0, E.io]]),
    roll: k([
      [0, 0], [0.14, -12, E.io], [0.42, -5, E.io],
      [0.56, -4, E.io], [0.62, -2, E.io], [0.76, -9, E.io], [0.83, -2, E.io], [0.96, -9, E.io], [1.03, -2, E.io], [1.17, -11, E.io],
      [1.38, -7, E.io], [1.8, 3, E.io], [2.0, 0, E.io],
    ]),
    work: k([[0.08, 0], [0.42, 1, E.io], [1.6, 1], [1.92, 0, E.io]]),
    leftW: k([[0.03, 0], [0.22, 1, E.io], [1.38, 1], [1.7, 0, E.io]]),
    rise: k([[0.22, 1], [0.5, 0, E.io]]),
    push: k([[0.5, 0], [0.6, 1, E.io]]),
    carryRoll: k([[0.22, -110], [0.5, ROLL0, E.io]]),
    open: k([[0.02, 0], [0.13, 1, E.io], [0.22, 0, E.io], [1.26, 0], [1.38, 1, E.io], [1.6, 0.4, E.io], [1.72, 0, E.io]]),
  },
  off: {
    pitch: k([[0, 0], [0.1, 2.5, E.io], [0.3, 0.8, E.io], [0.4, -2, E.io], [1.0, -0.5, E.io], [1.14, 2, E.io], [1.4, 2.5, E.io], [1.82, -2, E.io], [2.0, 0, E.io]]),
    yaw: k([[0, 0], [0.34, 14, E.io], [0.6, 12, E.io], [1.05, 13, E.io], [1.5, 14, E.io], [1.9, -0.6, E.io], [2.0, 0, E.io]]),
    roll: k([
      [0, 0], [0.1, 4, E.io], [0.32, -7, E.io], [0.4, -10, E.io],
      [0.44, -13, E.io], [0.52, -3, E.io], [0.6, -9, E.io], [0.72, 1, E.io], [0.8, -8, E.io], [0.93, 1, E.io],
      [1.1, -1, E.io], [1.5, -1.5, E.io], [1.78, -9, E.io], [2.0, 0, E.io],
    ]),
    work: k([[0.06, 0], [0.36, 1, E.io], [1.6, 1], [1.92, 0, E.io]]),
    leftW: k([[0.08, 0], [0.34, 1, E.io], [1.64, 1], [1.92, 0, E.io]]),
    pull: k([[1.0, 0], [1.14, 1, E.out]]),
    drop: k([[1.14, 0], [1.5, 1, E.in2]]),
    carryRoll: k([[1.14, ROLL0], [1.5, -110, E.io]]),
    open: k([[0.08, 0], [0.18, 1, E.io], [0.32, 0.6, E.io], [0.4, 0, E.io], [1.62, 0], [1.72, 0.8, E.io], [1.86, 0, E.io]]),
  },
  shown: 0.22,
  lineUp: 0.5,
  bite: [0.6, 0.66],
  seat: [1.15, 1.3],
  letGo: [1.26, 1.4],
  letGoRoll: 1.46,
  backOn: [1.38, 0.3],
  backOff: [0.08, 0.26],
  reachLift: [0.22, 0.4],
  free: [0.92, 1.0],
  twistEnd: 1.0,
  crack: [0.43, 0.54],
  pullBump: [1.0, 1.2],
  hidden: 1.5,
  armOnCan: true,
  cueBite: 0.58,
  cueSeat: 0.93,
  cueCrack: 0.38,
  cueOff: 1.02,
};

/** The beats for a gun's silencer (its spec's `style`; the Cottontail's by default). */
const beatsOf = (def: GunDef): Beats => (def.silencer?.style === "rifle" ? RIFLE : USP);

/** The can's travel on the thread while it's turning: in proportion to the turn, all of it over the full 360. */
function threadX(def: GunDef, spin: number): number {
  const engaged = def.silencer!.thread * 0.72;
  return engaged * Math.min(1, Math.max(0, -spin / 360));
}

/** Within a run of twists: the hand's roll, the can's turn, the fingers' opening and the hand's lift at time s. */
function twisting(tw: [number, number, number][], s: number, dir: 1 | -1, out: { roll: number; spin: number; open: number; lift: number }): void {
  // The can's turn so far (screwing on: from -360 up to 0; off: from 0 down to -360).
  let spin = dir > 0 ? -360 : 0;
  let roll = dir > 0 ? ROLL0 : ROLL0 + tw[0][2];
  let open = 0, lift = 0;
  for (let i = 0; i < tw.length; i++) {
    const [a, b, deg] = tw[i];
    const from = dir > 0 ? ROLL0 : ROLL0 + deg;
    if (s < a) {
      // Re-grip before this twist (after the previous one): fingers ease open, the wrist rolls back, closes again.
      if (i > 0) {
        const pb = tw[i - 1][1];
        const prevEnd = dir > 0 ? ROLL0 + tw[i - 1][2] : ROLL0;
        const u = (s - pb) / (a - pb);
        roll = prevEnd + (from - prevEnd) * E.io((u - 0.12) / 0.76);
        open = 0.55 * Math.sin(Math.PI * Math.min(1, Math.max(0, u)));
        lift = 0.12 * Math.sin(Math.PI * Math.min(1, Math.max(0, u)));
      } else roll = from;
      break;
    }
    // A twist: the wrist rolls through the can's turn. The first turn off is a crack: it holds against the thread for
    // a beat, then breaks loose fast.
    const u = Math.min(1, (s - a) / (b - a));
    const crack = dir < 0 && i === 0;
    const e = crack ? (u < 0.28 ? 0.06 * E.io(u / 0.28) : 0.06 + 0.94 * E.out((u - 0.28) / 0.72)) : E.io(u);
    roll = from + dir * deg * e;
    spin += dir * deg * e;
    if (u < 1) break;
    roll = dir > 0 ? ROLL0 + deg : ROLL0;
  }
  out.roll = roll;
  out.spin = spin;
  out.open = open;
  out.lift = lift;
}

const tw = { roll: 0, spin: 0, open: 0, lift: 0 };
/** A sine bump over [a, a + len] (the hand's path under the gun). */
const under = (s: number, a: number, len: number) => Math.sin(Math.PI * Math.min(1, Math.max(0, (s - a) / len)));

/**
 * Samples the clip at `t` seconds of `dur` (the core's lock-out) into `p` (reset to rest first): `on` screws the can on,
 * else off. `m` scales the flourishes (reduced motion); the hand and the can still do every beat.
 */
export function silencerClip(def: GunDef, p: GunPose, t: number, dur: number, on: boolean, m: number): void {
  const sil = def.silencer;
  if (!sil) return;
  const B = beatsOf(def);
  const s = (t / Math.max(0.05, dur)) * B.T;
  const C = on ? B.on : B.off;
  // --- The gun.
  p.a[0] += C.pitch(s) * m;
  p.a[1] += C.yaw(s) * (0.6 + 0.4 * m);
  p.a[2] += C.roll(s) * m;
  const w = C.work(s);
  p.o[0] -= B.work[0] * w;
  p.o[1] += B.work[1] * w;
  p.o[2] -= B.work[2] * w;
  p.indexOff = Math.min(1, w * 1.5);
  // --- The hand and the can.
  p.leftW = C.leftW(s);
  p.leftT = "sil";
  p.leftCurl = "sil";
  p.leftCurlW = 1;
  p.leftOpen = C.open(s);
  const P = B.pocket;
  if (on) {
    const rise = B.on.rise(s), push = B.on.push(s);
    p.sil = s >= B.shown ? 1 : 0;
    if (s < B.bite[0]) {
      // Carried: from the pocket, up to the bore line ahead of the thread, then back onto it.
      p.silOff[0] = P[0] * rise;
      p.silOff[1] = P[1] * rise;
      p.silOff[2] = P[2] * rise;
      p.silX = sil.thread + B.ahead * (1 - push);
      p.silPitch = B.tipUp * (1 - push) + 6 * rise;
      p.silYaw = -8 * rise;
      p.handRoll = s < B.lineUp ? B.on.carryRoll(s) : ROLL0;
      p.silSpin = p.handRoll - ROLL0 - 360;
    } else {
      twisting(B.twistsOn, s, 1, tw);
      p.silSpin = tw.spin;
      p.handRoll = tw.roll;
      p.leftOpen = Math.max(p.leftOpen, tw.open);
      p.handLift = tw.lift;
      // On the thread: it bites (a small push in), then winds in with the turn.
      const bite = E.out((s - B.bite[0]) / (B.bite[1] - B.bite[0]));
      p.silX = sil.thread - (sil.thread - threadX(def, p.silSpin)) * bite;
      p.silPitch = 4 * (1 - bite);
      // Seated: the gun jolts with the last turn.
      p.a[0] += bump(s, B.seat[0], B.seat[1]) * 2.2 * m;
      p.o[0] -= bump(s, B.seat[0], B.seat[1]) * 0.25;
      if (s > B.letGo[0]) {
        // Letting go: the hand lifts off the can as the fingers open.
        p.handLift = Math.max(p.handLift, 0.35 * E.io((s - B.letGo[0]) / (B.letGo[1] - B.letGo[0])));
        p.handRoll = tw.roll + 10 * E.io((s - B.letGo[0]) / (B.letGoRoll - B.letGo[0]));
      }
    }
    // The hand drops under the gun on its way back to the grip (not through it).
    p.leftOff[2] -= 2.5 * under(s, B.backOn[0], B.backOn[1]);
    p.leftOff[1] += 1.2 * under(s, B.backOn[0], B.backOn[1]);
    // Below the screen with the can (down from the grip, carried up): the wrist free to bend toward its elbow.
    p.leftArm = B.armOnCan ? p.leftW : p.leftW * rise;
  } else {
    p.sil = s < B.hidden ? 1 : 0;
    if (s < B.twistEnd) {
      twisting(B.twistsOff, s, -1, tw);
      p.silSpin = tw.spin;
      p.handRoll = tw.roll;
      p.leftOpen = Math.max(p.leftOpen, tw.open);
      p.handLift = Math.max(tw.lift, 0.35 * (1 - E.io((s - B.reachLift[0]) / (B.reachLift[1] - B.reachLift[0]))));
      p.silX = threadX(def, p.silSpin);
      // Free of the thread once the last turn ends: it eases out to the thread's end.
      p.silX += (sil.thread - threadX(def, -360)) * E.io((s - B.free[0]) / (B.free[1] - B.free[0]));
      // The crack: a jolt through the gun as it breaks loose.
      p.a[2] -= bump(s, B.crack[0], B.crack[1]) * 5 * m;
      p.a[0] -= bump(s, B.crack[0], B.crack[1]) * 1.5 * m;
    } else {
      const pull = B.off.pull(s), drop = B.off.drop(s);
      p.silSpin = -360 + (B.off.carryRoll(s) - ROLL0);
      p.handRoll = B.off.carryRoll(s);
      p.silX = sil.thread + B.ahead * pull;
      p.silPitch = B.tipUp * pull * (1 - drop) + 6 * drop;
      p.silYaw = -8 * drop;
      p.silOff[0] = P[0] * drop;
      p.silOff[1] = P[1] * drop;
      p.silOff[2] = P[2] * drop;
      // The little pull: the gun leans after it as the can comes free.
      p.o[0] += bump(s, B.pullBump[0], B.pullBump[1]) * 0.35;
    }
    // From the grip to the can: under the gun, not through it.
    p.leftOff[2] -= 2.5 * under(s, B.backOff[0], B.backOff[1]);
    p.leftOff[1] += 1.2 * under(s, B.backOff[0], B.backOff[1]);
    // Down out of view with the can, and back up to the grip: the wrist free to bend toward its elbow.
    p.leftArm = B.armOnCan ? p.leftW : p.leftW * Math.max(B.off.drop(s), 0.5 * B.off.pull(s));
  }
}

/** Moments (own seconds) the support hand holds the can: after it bites, mid twist, at the seat (the grip audit). */
export function silencerHoldTimes(def: GunDef): number[] {
  return beatsOf(def) === RIFLE ? [0.68, 0.9, 1.14] : [1.16, 1.3, 2.36];
}

/** The clip's natural length (s): CS:S's sequence for this gun's silencer (the lock-out is the core's). */
export function silencerLength(def: GunDef): number {
  return beatsOf(def).T;
}

/**
 * Sound cues (own seconds -> the clip's): the bite, a thread scrape per twist, the seat (its scrape runs through the
 * last turn, the clunk lands as it seats); the crack, the twists, the pull off. Each is started its clip's onset early
 * (tools/audio/picks.json onsetMs) so the hit lands on the frame. `def`: whose silencer (default the Cottontail's).
 */
export function silencerCues(dur: number, on: boolean, def?: GunDef): [number, Cue, number][] {
  const B = def ? beatsOf(def) : USP;
  const at = (s: number) => (s / B.T) * dur;
  if (on) {
    const c: [number, Cue, number][] = [[at(B.cueBite), "silTwist", 0.45]];
    for (const [a] of B.twistsOn.slice(0, -1)) c.push([at(a - 0.01), "silTwist", 0.9]);
    c.push([at(B.cueSeat), "silSeat", 1]);
    return c;
  }
  const c: [number, Cue, number][] = [[at(B.cueCrack), "silCrack", 1]];
  for (const [a] of B.twistsOff.slice(1)) c.push([at(a - 0.01), "silTwist", 0.9]);
  c.push([at(B.cueOff), "silOff", 1]);
  return c;
}
