/** Experimental absolute map angles: signed degrees, then the playable pitch range. */
export function mapViewPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) throw new Error("Non-finite map pitch");
  let signed = pitch % 360;
  if (signed >= 180) signed -= 360;
  if (signed < -180) signed += 360;
  return Math.max(-89, Math.min(89, signed));
}
