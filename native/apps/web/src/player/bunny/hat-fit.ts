import type { BunnyLook } from "./look";
import type { V3 } from "./rig";

export interface HatFit { scale: V3; offset: V3 }
const IDENTITY: HatFit = { scale: [1, 1, 1], offset: [0, 0, 0] };

/** Applied after bind-space hat animation, before head skinning: animation pivots stay canonical. */
export function hatFit(look: BunnyLook, hat?: string | null): HatFit {
  if (look !== "plush" && look !== "bune") return IDENTITY;
  const plush = look === "plush";
  if (["hat-halo", "hat-gem-orbit", "hat-lucky-coins", "hat-aurora"].includes(hat ?? "")) {
    return { scale: [1, 1, 1], offset: [0, 0, plush ? 5.5 : 3] };
  }
  // Perched objects retain their proportions; their feet/brim meet the new crown of the head.
  if (hat === "hat-capybara" || hat === "hat-maxwell") return { scale: [1, 1, 1], offset: [0, .15, plush ? .65 : .55] };
  if (hat === "hat-tophat") return { scale: [1, 1, 1], offset: [0, 0, plush ? .7 : .6] };
  // Bands and caps follow the new hood/helmet ellipsoid, rather than the faceplate or ear cups.
  const scale: V3 = plush ? [6 / 5.55, 6.1 / 6.05, 6.5 / 6] : [6.48 / 5.55, 5.85 / 6.05, 7.02 / 6];
  const center: V3 = plush ? [0, -.1, 70.2] : [0, .01, 69.58];
  return { scale, offset: [0, center[1] - .55 * scale[1], center[2] - 69.35 * scale[2]] };
}
