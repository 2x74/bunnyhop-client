// The tutorial map's lesson geometry (maps/bhop_lol_tutorial.tutorial.json, written by tools/tutorial/build.ts from
// tools/tutorial/layout.ts) and the per-lesson demo replays. DOM-free: the build tools import it too.

export const TUTORIAL_MAP = "bhop_lol_tutorial";

export type Vec3 = [number, number, number];
export interface Box3 {
  min: Vec3;
  max: Vec3;
}
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface Spot {
  position: Vec3;
  yaw: number;
}

export type LessonId = "jump" | "strafe" | "speed" | "final";
export const LESSON_IDS: LessonId[] = ["jump", "strafe", "speed", "final"];

export interface LessonGeometry {
  id: LessonId;
  /** Interior of the lesson's room (pits included). */
  room: Box3;
  start: Spot;
  /** Exit portal into the next lesson (null on the final course). */
  exit: Box3 | null;
  /** Lesson 3: speed gates (x of the gate's centre line) and their target speeds. */
  gates?: { x: number; speed: number }[];
  /** Lesson 1: hurdles; the final course: gaps (along the travel axis). */
  gaps?: { axis: 0 | 1; from: number; to: number; width: number }[];
  /** The final course: the finish. */
  checkpoints?: Box3[];
  pits?: Rect[];
  islands?: Rect[];
  /** Demo bot route (world x, y). */
  route: [number, number][];
  /** Demo replay (.bhr, base64) recorded by tools/tutorial/demos.ts, Normal style. */
  demo: string | null;
  /** Lesson 1 only: the same demo in Legit Scroll (a jump press on every landing). */
  demoLegit?: string | null;
  /** Demo's time from the lesson start to its goal (seconds). */
  demoSeconds?: number;
  /**
   * Lessons 2 and 3: the demo's ground track, painted on the floor as the strafe line: [x, y, key] where key is the
   * strafe key held from this point (-1 = left, 1 = right, 0 = none). Written by demos.ts.
   */
  lane?: [number, number, number][];
}

export interface TutorialData {
  map: string;
  bspSha256: string;
  /** Bonus 1 (the final course on its own) start point. */
  bonusStart: Spot;
  lessons: LessonGeometry[];
}

export function inBox(p: readonly number[], b: Box3, pad = 0): boolean {
  return p[0] >= b.min[0] - pad && p[0] <= b.max[0] + pad && p[1] >= b.min[1] - pad && p[1] <= b.max[1] + pad && p[2] >= b.min[2] - pad && p[2] <= b.max[2] + pad;
}

/** Index of the lesson whose room holds `p` (pits included), or -1. */
export function lessonAt(data: TutorialData, p: readonly number[]): number {
  return data.lessons.findIndex((l) => inBox(p, { min: [l.room.min[0], l.room.min[1], l.room.min[2] - 64], max: l.room.max }, 2));
}

let cached: Promise<TutorialData> | null = null;

/** The lesson geometry + demos, served next to the map (maps/ in dev, the site build in production). */
export function loadTutorialData(): Promise<TutorialData> {
  cached ??= fetch(`/${TUTORIAL_MAP}.tutorial.json`).then(async (r) => {
    if (!r.ok) throw new Error(`tutorial data: HTTP ${r.status}`);
    return (await r.json()) as TutorialData;
  });
  cached.catch(() => (cached = null));
  return cached;
}

export function base64Bytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
