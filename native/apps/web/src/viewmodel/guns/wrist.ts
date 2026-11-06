// Natural wrist ranges for hands on guns, first person (guns/pose.ts) and third person (player/bunny/gun-hold.ts).
// Measured anatomically between the forearm's axis and the hand's knuckle line: extension (the back of the hand toward
// the forearm) / flexion (toward the palm), ulnar (toward the little finger) / radial (toward the thumb) deviation.
// Twist isn't the wrist's: the forearm takes the hand's roll. Anatomical maxima are about 70 / 80 / 35 / 20.

export interface WristRange {
  ext: number;
  flex: number;
  uln: number;
  rad: number;
}

/**
 * Grip: the firing hand on the grip, in line with its forearm (a pistol grip's slight ulnar set). Support: the other
 * hand on the gun. Work: a hand away from its grip (a magazine, the silencer, the pod; a bolt): still a real wrist's
 * range, the elbow brings the forearm the rest of the way. (v0.0.38 gun grips: the long guns' support wrists sat at
 * 42 deg of extension at rest and bent up to 150 deg on screen in the silencer and pod clips.)
 */
export const WRIST: Record<"grip" | "support" | "work", WristRange> = {
  grip: { ext: 25, flex: 15, uln: 22, rad: 10 },
  support: { ext: 28, flex: 20, uln: 25, rad: 12 },
  work: { ext: 40, flex: 40, uln: 28, rad: 18 },
};

/** `base` opened toward WRIST.work by w (0..1), into out. */
export function openRange(base: WristRange, w: number, out: WristRange): WristRange {
  const k = Math.max(0, Math.min(1, w));
  out.ext = base.ext + (Math.max(base.ext, WRIST.work.ext) - base.ext) * k;
  out.flex = base.flex + (Math.max(base.flex, WRIST.work.flex) - base.flex) * k;
  out.uln = base.uln + (Math.max(base.uln, WRIST.work.uln) - base.uln) * k;
  out.rad = base.rad + (Math.max(base.rad, WRIST.work.rad) - base.rad) * k;
  return out;
}

/** How far a wrist reading (flex + / ext -, dev + radial / - ulnar; deg) is into its range: <= 1 inside (an ellipse). */
export function wristExcess(flex: number, dev: number, rg: WristRange): number {
  return Math.hypot(flex / (flex >= 0 ? rg.flex : rg.ext), dev / (dev >= 0 ? rg.rad : rg.uln));
}
