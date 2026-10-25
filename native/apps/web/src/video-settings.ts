/** Local display adjustments. Neutral values avoid a compositor filter entirely. */
export interface VideoGrade { brightness: number; gamma: number; vibrance: number }
export const VIDEO_LIMITS = { brightness: [0.5, 2], gamma: [0.5, 2.5], vibrance: [0, 2] } as const;
export const NEUTRAL_VIDEO: VideoGrade = { brightness: 1, gamma: 1, vibrance: 1 };

export function videoGrade(raw: Partial<VideoGrade> | null | undefined): VideoGrade {
  const result = { ...NEUTRAL_VIDEO };
  for (const k of Object.keys(VIDEO_LIMITS) as (keyof VideoGrade)[]) {
    const n = raw?.[k];
    if (typeof n === "number" && Number.isFinite(n)) result[k] = Math.max(VIDEO_LIMITS[k][0], Math.min(VIDEO_LIMITS[k][1], n));
  }
  return result;
}

export function neutralVideo(v: VideoGrade): boolean {
  return v.brightness === 1 && v.gamma === 1 && v.vibrance === 1;
}

/** SVG component-transfer parameters, in display sRGB: gamma lifts midtones; brightness multiplies the result. */
export function videoTransfer(v: VideoGrade): { amplitude: number; exponent: number; saturation: number } {
  const g = videoGrade(v);
  return { amplitude: g.brightness, exponent: 1 / g.gamma, saturation: g.vibrance };
}
