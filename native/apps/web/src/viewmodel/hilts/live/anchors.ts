// Where a living hilt's pieces sit on each knife (v0.0.43). Every knife tags its hilt surfaces by role (knives/types.ts
// HiltMap: grip, guard, pommel), so the anchors are measured from the knife itself rather than typed in per knife: the
// knife is built once in its own frame (identity transform) and the tagged vertices give the grip's span and girth,
// the top of the fittings (where the blade leaves the hilt), and the butt. A few knives hold their hilt in a way the
// measure can't know (the Karrotbit's finger ring is "pommel", the Bunnyfly's grip is two handles on two bones), so
// KNIFE_FIT nudges those by hand. Everything is knife-local (z toward the tip, y across the blade, x through it).

import { Builder } from "../../../player/bunny/builder";
import type { V3 } from "../../../player/bunny/rig";
import { KnifeCtx } from "../../knives/ctx";
import type { KnifeDef } from "../../knives/types";

export interface HiltAnchors {
  /** The grip's span along z (bottom = toward the butt) and its half extents across (y) and through (x). */
  grip: { z0: number; z1: number; hy: number; hx: number; cy: number };
  /** Top of the fittings: where the blade leaves the hilt (z), the fittings' half width (y) and half depth (x). */
  top: { z: number; hy: number; hx: number };
  /** The butt: lowest point of the hilt (z), its centre across (y). */
  butt: { z: number; cy: number };
  /** The blade's half width and half thickness just above the fittings (so a piece there clears it). */
  blade: { hy: number; hx: number; y0: number; y1: number };
  /** Bone (short name; undefined = Knife_Handle) the butt rides on (the Bunnyfly's latch end). */
  buttBone?: string;
  /** Where the eye / boss sits (knife-local), its scale (1 = the reference size) and which way its face looks (+x / -x both: 0). */
  boss: { p: V3; s: number };
  /** The lanyard / charm anchor under the butt (knife-local): see report "Needs from charms". */
  charm: V3;
}

/** Hand fixes per knife (added to the measured anchors), for the hilts the measure reads wrong. */
const KNIFE_FIT: Record<string, { boss?: V3; s?: number; butt?: number; charm?: V3 }> = {};

const cache = new Map<string, HiltAnchors>();

/** Measured anchors of a knife (cached per knife id). */
export function hiltAnchors(k: KnifeDef): HiltAnchors {
  let a = cache.get(k.id);
  if (!a) cache.set(k.id, (a = measure(k)));
  return a;
}

const BONES = ["", "Bfly_Blade", "Bfly_Bite", "Bfly_Latch", "Whirl_Spin"];

function measure(k: KnifeDef): HiltAnchors {
  const b = new Builder();
  // Identity: positions come out knife-local; the "weight" names the bone, as an index into BONES.
  const ctx = new KnifeCtx(b, "fp", (p) => [p[0], p[1], p[2]], (bone) => [[Math.max(0, BONES.indexOf(bone ?? "")), 1]]);
  k.build(ctx);
  const g = b.geometry();
  const P = g.getAttribute("position"), F = g.getAttribute("finishUV"), S = g.getAttribute("skinIndex");
  const role = (i: number) => {
    if (!F) return 0;
    const part = Math.floor(F.getZ(i) + 0.02);
    if (part < 2 || part > 3) return 0;
    return Math.floor(F.getX(i) + 0.02);
  };
  const box = () => ({ x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity, n: 0 });
  const grip = box(), guard = box(), pommel = box(), all = box(), blade = box();
  const bones = new Map<number, number>();
  const put = (bx: ReturnType<typeof box>, x: number, y: number, z: number) => {
    bx.x0 = Math.min(bx.x0, x), bx.x1 = Math.max(bx.x1, x), bx.y0 = Math.min(bx.y0, y), bx.y1 = Math.max(bx.y1, y), bx.z0 = Math.min(bx.z0, z), bx.z1 = Math.max(bx.z1, z), bx.n++;
  };
  const blades: [number, number, number][] = [];
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i), r = role(i);
    const part = F ? Math.floor(F.getZ(i) + 0.02) : 0;
    if (r === 1) put(grip, x, y, z);
    else if (r === 2) put(guard, x, y, z);
    else if (r === 3) put(pommel, x, y, z);
    if (r) {
      put(all, x, y, z);
      if (z < all.z0 + 0.6) bones.set(S.getX(i), (bones.get(S.getX(i)) ?? 0) + 1);
    }
    if (part === 1) blades.push([x, y, z]);
  }
  const fit = KNIFE_FIT[k.id] ?? {};
  const g0 = grip.n ? grip : all;
  const topZ = Math.max(guard.n ? guard.z1 : -Infinity, g0.z1);
  for (const [x, y, z] of blades) if (z > topZ && z < topZ + 0.6) put(blade, x, y, z);
  const hy = Math.max(Math.abs(g0.y0), Math.abs(g0.y1));
  const buttZ = all.z0 + (fit.butt ?? 0);
  const buttBone = [...bones.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? 0;
  const top = guard.n ? guard : g0;
  const bladeHy = blade.n ? Math.max(Math.abs(blade.y0), Math.abs(blade.y1)) : 0.3;
  const bladeHx = blade.n ? Math.max(Math.abs(blade.x0), Math.abs(blade.x1)) : 0.1;
  const s = fit.s ?? 1;
  const boss: V3 = fit.boss ?? [0, 0, topZ + 0.32 * s];
  return {
    grip: { z0: g0.z0, z1: g0.z1, hy, hx: Math.max(Math.abs(g0.x0), Math.abs(g0.x1)), cy: (g0.y0 + g0.y1) / 2 },
    top: { z: topZ, hy: Math.max(Math.abs(top.y0), Math.abs(top.y1)), hx: Math.max(Math.abs(top.x0), Math.abs(top.x1)) },
    butt: { z: buttZ, cy: (all.y0 + all.y1) / 2 },
    blade: { hy: bladeHy, hx: bladeHx, y0: blade.n ? blade.y0 : -0.3, y1: blade.n ? blade.y1 : 0.3 },
    buttBone: buttBone ? BONES[buttBone] : undefined,
    boss: { p: boss, s },
    charm: fit.charm ?? [0, (all.y0 + all.y1) / 2, buttZ - 0.25],
  };
}
