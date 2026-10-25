/** Private surface markers. Sizes are diameters in Source units. */
export const PAINT_COLORS = [
  ["#ff4040", "Red"], ["#ff8c32", "Orange"], ["#ffd740", "Yellow"], ["#9aff40", "Lime"],
  ["#30ce60", "Green"], ["#30d5c8", "Teal"], ["#40dcff", "Cyan"], ["#4090ff", "Blue"],
  ["#7650ff", "Violet"], ["#bf50ff", "Purple"], ["#ff50c0", "Pink"], ["#ffffff", "White"],
  ["#999999", "Grey"], ["#202020", "Black"],
] as const;
export const PAINT_SIZES = { small: 16, medium: 32, large: 64 } as const;
export type PaintSize = keyof typeof PAINT_SIZES;
export interface PaintPrefs { color: string; size: PaintSize }
export const DEFAULT_PAINT: PaintPrefs = { color: "#ff4040", size: "medium" };
/** Also used at draw time: old or hand-edited localStorage can't produce invalid geometry. */
export function paintPrefs(p: PaintPrefs): PaintPrefs {
  return {
    color: PAINT_COLORS.some(([color]) => color === p?.color) ? p.color : DEFAULT_PAINT.color,
    size: Object.hasOwn(PAINT_SIZES, p?.size) ? p.size : DEFAULT_PAINT.size,
  };
}
