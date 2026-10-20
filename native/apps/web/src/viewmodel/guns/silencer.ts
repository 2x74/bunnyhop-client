// The Cottontail's silencer going on and off (physics v7: +attack2 on the USP, a 3.08 s lock-out): the gun viewmodel's
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

/** CS:S add_silencer / detach_silencer: 115 frames at 37 fps. */
export const SIL_T = 114 / 37;

/** The four twists (CS:S seconds; the reference turns the can four times): start, end, the can's turn (deg). */
const TWISTS_ON: [number, number, number][] = [
  [1.19, 1.41, 95],
  [1.57, 1.72, 95],
  [1.89, 2.05, 95],
  [2.22, 2.38, 75],
];
const TWISTS_OFF: [number, number, number][] = [
  [0.65, 0.82, 75],
  [0.98, 1.14, 95],
  [1.3, 1.46, 95],
  [1.62, 1.84, 95],
];
/** The hand's roll at the start of a turn (screwing on: it rolls by the can's turn from here). */
const ROLL0 = -45;
/** Where the can is when the hand brings it (gun-local offset from its seat): behind, left and below, out of view. */
const POCKET: [number, number, number] = [-9, 6.5, -10];
/** Carried in: ahead of the thread by this much, nose tipped up this much (deg) as it arrives. */
const AHEAD = 2.6;
const TIP_UP = 14;

const k = (keys: Key[]) => track(keys);

// --- Screw on (CS:S seconds).
const ON = {
  // The gun: cants and lifts its muzzle as the hand lets go, swings in (muzzle left, toward the middle), works, swings
  // back and settles. Angles: pitch (+ muzzle down), yaw (+ muzzle left), roll (+ top to the right).
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
  // The support hand: off the grip and down out of view (0.04-0.3), on the can from then until it lets go (2.42), back
  // on the grip by 2.95.
  leftW: k([[0.04, 0], [0.3, 1, E.io], [2.55, 1], [2.95, 0, E.io]]),
  // The can, carried: from the pocket up to the line of the bore (0.3-0.865), back onto the thread (0.865-1.03).
  rise: k([[0.3, 1], [0.865, 0, E.io]]),
  push: k([[0.865, 0], [1.03, 1, E.io]]),
  // The wrist turns into the grip as it comes up.
  carryRoll: k([[0.3, -110], [0.865, ROLL0, E.io]]),
  // Fingers: open as the hand leaves the grip, closed on the can from the pocket; let go at 2.42.
  open: k([[0.02, 0], [0.2, 1, E.io], [0.3, 0, E.io], [2.42, 0], [2.58, 1, E.io], [2.9, 0.4, E.io], [3.0, 0, E.io]]),
};

// --- Screw off (CS:S seconds): the same beats run the other way, with its own crack and pull.
const OFF = {
  pitch: k([[0, 0], [0.11, 5, E.io], [0.42, 1.5, E.io], [0.62, -4, E.io], [1.98, -1, E.io], [2.2, 3.5, E.io], [2.6, 4.5, E.io], [2.92, -6, E.io], [3.0811, 0, E.io]]),
  yaw: k([[0, 0], [0.5, 42, E.io], [0.78, 36, E.io], [2.0, 38, E.io], [2.55, 42, E.io], [2.97, -1.5, E.io], [3.0811, 0, E.io]]),
  roll: k([
    [0, 0], [0.12, 8, E.io], [0.5, -14, E.io], [0.65, -22, E.io],
    // The crack: the gun gives with the hard first turn, then against each twist (the other way now).
    [0.71, -27, E.io], [0.82, -6, E.io], [0.98, -18, E.io], [1.14, 2, E.io], [1.3, -17, E.io], [1.46, 3, E.io], [1.62, -16, E.io], [1.84, 2, E.io],
    [2.1, -1.5, E.io], [2.55, -2, E.io], [2.86, -18, E.io], [3.0811, 0, E.io],
  ]),
  work: k([[0.1, 0], [0.55, 1, E.io], [2.55, 1], [3.0, 0, E.io]]),
  // The hand: from the grip to the can (0.13-0.55), on it through the pull, down out of view with it (2.22-2.7), back
  // on the grip by 3.04.
  leftW: k([[0.13, 0], [0.55, 1, E.io], [2.75, 1], [3.04, 0, E.io]]),
  pull: k([[2.0, 0], [2.22, 1, E.out]]),
  drop: k([[2.22, 0], [2.7, 1, E.in2]]),
  carryRoll: k([[2.22, ROLL0], [2.7, -110, E.io]]),
  open: k([[0.13, 0], [0.3, 1, E.io], [0.52, 0.6, E.io], [0.66, 0, E.io], [2.72, 0], [2.85, 0.8, E.io], [3.0, 0, E.io]]),
};

/** The can bites on the thread; the hand lets go of it; reaches for it; it comes free of the thread. */
const BITE = k([[1.03, 0], [1.13, 1, E.out]]);
const LET_GO = k([[2.42, 0], [2.62, 1, E.io]]);
const LET_GO_ROLL = k([[2.42, 0], [2.7, 1, E.io]]);
const REACH_LIFT = k([[0.3, 1], [0.62, 0, E.io]]);
const FREE = k([[1.78, 0], [1.9, 1, E.io]]);

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

/**
 * Samples the clip at `t` seconds of `dur` (the core's lock-out) into `p` (reset to rest first): `on` screws the can on,
 * else off. `m` scales the flourishes (reduced motion); the hand and the can still do every beat.
 */
export function silencerClip(def: GunDef, p: GunPose, t: number, dur: number, on: boolean, m: number): void {
  const sil = def.silencer;
  if (!sil) return;
  const s = (t / Math.max(0.05, dur)) * SIL_T;
  const C = on ? ON : OFF;
  // --- The gun.
  p.a[0] += C.pitch(s) * m;
  p.a[1] += C.yaw(s) * (0.6 + 0.4 * m);
  p.a[2] += C.roll(s) * m;
  const w = C.work(s);
  p.o[0] -= 3.0 * w;
  p.o[1] += 4.0 * w;
  p.o[2] -= 1.8 * w;
  p.indexOff = Math.min(1, w * 1.5);
  // --- The hand and the can.
  p.leftW = C.leftW(s);
  p.leftT = "sil";
  p.leftCurl = "sil";
  p.leftCurlW = 1;
  p.leftOpen = C.open(s);
  const tws = on ? TWISTS_ON : TWISTS_OFF;
  if (on) {
    const rise = ON.rise(s), push = ON.push(s);
    p.sil = s >= 0.3 ? 1 : 0;
    if (s < 1.03) {
      // Carried: from the pocket, up to the bore line ahead of the thread, then back onto it.
      p.silOff[0] = POCKET[0] * rise;
      p.silOff[1] = POCKET[1] * rise;
      p.silOff[2] = POCKET[2] * rise;
      p.silX = sil.thread + AHEAD * (1 - push);
      p.silPitch = TIP_UP * (1 - push) + 6 * rise;
      p.silYaw = -8 * rise;
      p.handRoll = s < 0.865 ? ON.carryRoll(s) : ROLL0;
      p.silSpin = p.handRoll - ROLL0 - 360;
    } else {
      twisting(tws, s, 1, tw);
      p.silSpin = tw.spin;
      p.handRoll = tw.roll;
      p.leftOpen = Math.max(p.leftOpen, tw.open);
      p.handLift = tw.lift;
      // On the thread: it bites (1.03-1.13, a small push in), then winds in with the turn.
      const bite = BITE(s);
      p.silX = sil.thread - (sil.thread - threadX(def, p.silSpin)) * bite;
      p.silPitch = 4 * (1 - bite);
      // Seated: the gun jolts with the last turn.
      p.a[0] += bump(s, 2.36, 2.56) * 2.2 * m;
      p.o[0] -= bump(s, 2.36, 2.56) * 0.25;
      if (s > 2.42) {
        // Letting go: the hand lifts off the can as the fingers open.
        p.handLift = Math.max(p.handLift, 0.35 * LET_GO(s));
        p.handRoll = tw.roll + 10 * LET_GO_ROLL(s);
      }
    }
    // The hand drops under the gun on its way back to the grip (not through it).
    p.leftOff[2] -= 2.5 * Math.sin(Math.PI * Math.min(1, Math.max(0, (s - 2.55) / 0.4)));
    p.leftOff[1] += 1.2 * Math.sin(Math.PI * Math.min(1, Math.max(0, (s - 2.55) / 0.4)));
  } else {
    p.sil = s < 2.7 ? 1 : 0;
    if (s < 2.0) {
      twisting(tws, s, -1, tw);
      p.silSpin = tw.spin;
      p.handRoll = tw.roll;
      p.leftOpen = Math.max(p.leftOpen, tw.open);
      p.handLift = Math.max(tw.lift, 0.35 * REACH_LIFT(s));
      p.silX = threadX(def, p.silSpin);
      // Free of the thread once the last turn ends: it eases out to the thread's end.
      p.silX += (sil.thread - threadX(def, -360)) * FREE(s);
      // The crack: a jolt through the gun as it breaks loose.
      p.a[2] -= bump(s, 0.69, 0.86) * 5 * m;
      p.a[0] -= bump(s, 0.69, 0.86) * 1.5 * m;
    } else {
      const pull = OFF.pull(s), drop = OFF.drop(s);
      p.silSpin = -360 + (OFF.carryRoll(s) - ROLL0);
      p.handRoll = OFF.carryRoll(s);
      p.silX = sil.thread + AHEAD * pull;
      p.silPitch = TIP_UP * pull * (1 - drop) + 6 * drop;
      p.silYaw = -8 * drop;
      p.silOff[0] = POCKET[0] * drop;
      p.silOff[1] = POCKET[1] * drop;
      p.silOff[2] = POCKET[2] * drop;
      // The little pull: the gun leans after it as the can comes free.
      p.o[0] += bump(s, 2.0, 2.3) * 0.35;
    }
    // From the grip to the can: under the gun, not through it.
    p.leftOff[2] -= 2.5 * Math.sin(Math.PI * Math.min(1, Math.max(0, (s - 0.13) / 0.42)));
    p.leftOff[1] += 1.2 * Math.sin(Math.PI * Math.min(1, Math.max(0, (s - 0.13) / 0.42)));
  }
}

/**
 * Sound cues (CS:S seconds -> the clip's): the bite, a thread scrape per twist, the seat (its scrape runs through the
 * last turn, the clunk lands as it seats); the crack, the twists, the pull off. Each is started its clip's onset early
 * (tools/audio/picks.json onsetMs) so the hit lands on the frame.
 */
export function silencerCues(dur: number, on: boolean): [number, Cue, number][] {
  const at = (s: number) => (s / SIL_T) * dur;
  if (on) {
    const c: [number, Cue, number][] = [[at(1.0), "silTwist", 0.45]];
    for (const [a] of TWISTS_ON.slice(0, -1)) c.push([at(a - 0.01), "silTwist", 0.9]);
    c.push([at(2.19), "silSeat", 1]);
    return c;
  }
  const c: [number, Cue, number][] = [[at(0.63), "silCrack", 1]];
  for (const [a] of TWISTS_OFF.slice(1)) c.push([at(a - 0.01), "silTwist", 0.9]);
  c.push([at(1.9), "silOff", 1]);
  return c;
}
