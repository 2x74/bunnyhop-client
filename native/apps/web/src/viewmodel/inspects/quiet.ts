// The quiet inspect (Settings -> Viewmodel -> Inspect: Quiet): a restrained blade check that starts the chain instead of
// the knife's own first trick. The fist comes up a little (about half the presented pose), the wrist turns the flat of
// the blade toward you and looks along the edge, turns it over to the other face, and settles back. No tosses, no
// spins, no sound cues. A re-press during it carries on into the knife's own tricks (they take over at their presented
// pose), so the showier ones stay a deliberate second press away.
//
// Yours only: it plays in your own first person. Rooms, replays and your third-person bunny never see it: the chain's
// network / replay signals start with the knife's own first trick (inspects/runtime.ts), so everyone else sees exactly
// the tricks they would have.

import { openFinger, PRESENT, presented } from "./common";
import { E, track } from "./kit";
import { inspectSet, type InspectClip, type InspectSet } from "./types";

const Q = { len: 2.45, enter: 0.42, exit: 1.95, open: 0.55 };
/** How far toward the presented pose the fist comes up (the knife's own tricks start from all of it). */
const RAISE = 0.55;

// Beats (s): the edge look (a slow wrist deviation, the tip toward you), the turn over (the forearm, unhurried), a
// small settle in the wrist after it, the index easing off the grip and back during the look (a hand, not a clamp).
const look = track([[0.5, 0], [0.95, 1, E.io], [1.15, 1], [1.4, 0, E.io]]);
const over = track([[1.2, 0], [1.62, 1, E.io], [1.95, 1], [2.3, 0, E.io]]);
const settle = track([[1.58, 0], [1.7, 1, E.out], [1.92, 0, E.io]]);
const ease = track([[0.6, 0], [0.85, 1, E.io], [1.05, 1], [1.3, 0, E.io]]);

export const quietCheck: InspectClip = {
  id: "quiet-check",
  name: "Quiet Check",
  len: Q.len,
  enter: Q.enter,
  exit: Q.exit,
  open: Q.open,
  apply(W, t, ctx) {
    const p = presented(t, Q.enter, Q.exit, Q.len) * RAISE;
    const l = look(t), o = over(t), s = settle(t);
    const sh = PRESENT.shift;
    ctx.arm.arm(W, PRESENT.roll * p - 105 * o, PRESENT.pitch * 0.7 * p + 2 * l, PRESENT.yaw * p + 4 * l, [sh[0] * p, sh[1] * p, sh[2] * 0.6 * p]);
    // The look along the edge: the wrist turns the tip toward you and down a touch; a small give as the turn lands.
    ctx.arm.wrist(W, 6 * l - 4 * s, -16 * l);
    const k = 0.22 * ease(t);
    if (k > 0) openFinger(ctx, W, ctx.arm.frame(W), "index", k, undefined, undefined, 0, t > 1.05);
  },
};

const quiet = new Map<InspectSet, InspectSet>();

/** The knife's set with the quiet check in front (cached: the same object each time). */
export function quietSet(base: InspectSet): InspectSet {
  let s = quiet.get(base);
  if (!s) quiet.set(base, (s = inspectSet(`${base.id}-quiet`, [quietCheck, ...base.clips], base.spec.maxLoops)));
  return s;
}

/** The set starts with the quiet check (its signals are offset by one: inspects/runtime.ts). */
export const isQuietSet = (s: InspectSet): boolean => s.clips[0] === quietCheck;
