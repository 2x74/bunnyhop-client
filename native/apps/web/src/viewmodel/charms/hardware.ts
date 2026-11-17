// The charms' hardware (v0.0.43), the same on every charm: from the knife down,
//
//   the wrap    two turns of waxed cord tied round a real part of the knife (its guard, a quillon, its finger ring, a
//               handle's end: anchors.ts says where and gives the loop), a knot where the tail leaves it; or a small
//               loop through the lanyard ring a hilt brings                                      (bone CB.mount)
//   a brass crimp where the tail leaves the knot, turning with the cord                          (bone CB.link)
//   the cord's tail, two halves that follow the swing                                            (bones CB.cord1/2)
//   a jump ring, and the bail: a little brass cap with a loop, set on the charm's top            (bone CB.body)
//
// Nothing stands off the knife: the cord is tied to it and the charm hangs from the knot (the owner, 11-17: no arm or
// post to hang it from). Sized to read at about 60 px a unit: the cord 5 px across at 1080p, the rings 12.

import { KMAT } from "../knives/types";
import { add, norm, scale, sub, cross, BRASS, BRASS_DARK, CB, P, type CharmCtx, type V3 } from "./kit";

/** Where the charm's top meets the bail's cap (charm-local z; the loop the cord ends at is the origin). */
export const BAIL_BOTTOM = -0.24;
/** The cord (its radius), the ring through the bail. */
export const CORD_R = 0.042;
export const LOOP = { R: 0.1, r: 0.026 } as const;
/** From the pin (the knot) down to where the tail's drawn length starts, and from the charm's loop up to where it ends (at size 1). */
export const TOP_DROP = 0.05;
export const BOTTOM_RISE = LOOP.R + LOOP.r - 0.01;

/** Waxed cord: a warm undyed tan (the grip material: a fine weave in relief), its knots a shade darker. */
export const CORD = P(0xc9ae7c, KMAT.grip), CORD_DARK = P(0xa98d5e, KMAT.grip);

/**
 * How the charm is tied to the knife (anchors.ts), the knot (the pin) at the origin:
 *   wrap   a loop of cord round a part of it (two turns)
 *   ring   a small loop of cord through a hilt's own lanyard ring
 *   hoop   a brass split ring through or round a part of the knife's hardware (the Bunnyfly's way), the cord tied on
 *          its far side with two turns round the wire: `loop` is the ring's centre line, the pin on it
 */
export interface MountSpec {
  kind: "wrap" | "ring" | "hoop";
  /** The loop round the knife: a closed line of points (the mount bone's frame: the knife's axes, the pin at the origin). */
  loop: V3[];
  /** Across the loop's plane (unit): the second turn lies beside the first along it. */
  normal: V3;
}
/** A hoop's wire (radius). */
export const HOOP_R = 0.032;
export const mountKey = (m: MountSpec | null): string => {
  if (!m) return "none";
  let h = 2166136261;
  for (const p of m.loop) for (const v of p) h = Math.imul(h ^ Math.round(v * 200), 16777619);
  return `${m.kind}:${m.loop.length}:${h >>> 0}:${m.normal.map((v) => v.toFixed(1))}`;
};

/** The bail on the charm's top and the ring through it (bone CB.body, charm-local: built at size 1). */
export function bail(c: CharmCtx): void {
  // The cap: a small dome with a collar, sitting on the charm.
  c.turned([[0.045, -0.128], [0.08, -0.142], [0.11, -0.172], [0.125, -0.207], [0.137, -0.215], [0.137, -0.245], [0.11, -0.255]], { paint: (p) => (p[2] < -0.21 ? BRASS_DARK : BRASS), seg: 10, sub: 1 });
  // Its loop, edge on to the viewer, and the ring through it, face on.
  c.torus([0, 0, -0.125], 0.07, 0.027, [1, 0, 0], BRASS, CB.body, 10, 5);
  c.torus([0, 0, 0], LOOP.R, LOOP.r, [0, 1, 0], BRASS, CB.body, 12, 5);
}

/** The crimp where the tail leaves the knot (bone CB.link: origin at the pin, z up the cord). */
export function link(c: CharmCtx): void {
  c.turned([[0.03, 0.02], [0.062, 0.0], [0.066, -0.035], [0.062, -0.07], [0.03, -0.09]], { paint: BRASS, bone: CB.link, seg: 8, sub: 1 });
}

/** The cord's two halves (bones CB.cord1 / cord2: a unit length along +z each, stretched from point to point by the rig). */
export function cord(c: CharmCtx): void {
  for (const bone of [CB.cord1, CB.cord2]) c.tube([[0, 0, 0], [0, 0, 1]], CORD_R, CORD, bone, 6, [1, 0, 0], false);
}

/** The wrap on the knife (bone CB.mount: the knife's axes, the pin at the origin). */
export function mount(c: CharmCtx, m: MountSpec | null): void {
  if (!m) return;
  const n = norm(m.normal);
  const L = m.loop;
  if (m.kind === "hoop" && L.length >= 3) {
    // The ring: a closed brass wire along the loop (its near side goes into the part it is through).
    c.tube([...L, L[0], L[1]], HOOP_R, BRASS, CB.mount, 6, n, false);
    // The cord tied on at the pin: two turns round the wire side by side, a small knot under them.
    const t = norm(sub(L[1], L[L.length - 1]));
    for (const off of [-CORD_R * 0.95, CORD_R * 0.95]) c.torus(scale(t, off), HOOP_R + CORD_R * 0.9, CORD_R, t, off < 0 ? CORD : CORD_DARK, CB.mount, 8, 4);
    // (Outward at the pin: away from the ring's centre; the loop starts at the pin.)
    const cen = scale(L.reduce((a, p) => add(a, p), [0, 0, 0] as V3), 1 / L.length);
    const out = norm(scale(cen, -1));
    c.ball(scale(out, HOOP_R * 0.6), [0.06, 0.06, 0.055], { paint: CORD_DARK, bone: CB.mount, seg: 6, rows: 3 });
    return;
  }
  if (L.length >= 3) {
    // Two turns side by side, each a closed tube along the loop.
    for (const off of [-CORD_R * 0.92, CORD_R * 0.92]) {
      const path = L.map((p) => add(p, scale(n, off)));
      // (Closed: the first two points again, so the seam's rings line up; no caps.)
      c.tube([...path, path[0], path[1]], CORD_R, off < 0 ? CORD : CORD_DARK, CB.mount, 4, n, false);
    }
  }
  // The knot at the pin: a fat bead of cord, a turn round it.
  c.ball([0, 0, 0], [0.085, 0.085, 0.075], { paint: CORD_DARK, bone: CB.mount, seg: 7, rows: 4 });
  const side = L.length >= 3 ? norm(cross(n, sub(L[1], L[0]))) : ([0, 0, 1] as V3);
  c.torus([0, 0, 0], 0.07, 0.03, side, CORD, CB.mount, 7, 4);
}
