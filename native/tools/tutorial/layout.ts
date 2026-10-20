// The "Learn to bhop" course (bhop_lol_tutorial): four lesson rooms, one skill each, connected by exit portals
// (trigger_teleport to the next room's start). Every number the client's tutorial needs (room bounds, starts, gates,
// gaps, corner checkpoints) is exported from here into maps/<map>.tutorial.json by build.ts, so the map and the
// lesson logic can't drift apart.
//
// Units are Source units. Floors are at z = 0, the sky is at z = 512, walls are 64 thick, pits are 384 deep with a
// trigger_teleport on their floor that returns you to the lesson's start. Stock materials only (HL2 dev textures,
// CS:S concrete, the HL2 sky), listed in MATERIALS with their texture sizes (read from the CS:S VPKs).

import { CONTENTS_SOLID, SURF_NOLIGHT, SURF_NODRAW, SURF_SKY, SURF_TRIGGER, type Box, type BrushEntity, type FaceTex, type Lighting, type Material, type Vec3 } from "./bsp";

export const MAP = "bhop_lol_tutorial";

export const MATERIALS: Record<string, Material> = {
  "dev/graygrid": { width: 512, height: 512, reflectivity: [0.45, 0.45, 0.45] },
  "dev/dev_measurewall01a": { width: 512, height: 512, reflectivity: [0.55, 0.55, 0.53] },
  "dev/dev_measurewall01c": { width: 512, height: 512, reflectivity: [0.5, 0.5, 0.5] },
  "dev/dev_measurewall01d": { width: 512, height: 512, reflectivity: [0.35, 0.32, 0.3] },
  "dev/dev_measuregeneric01": { width: 128, height: 128, reflectivity: [0.6, 0.45, 0.25], scale: 0.5 },
  "dev/dev_measuregeneric01b": { width: 128, height: 128, reflectivity: [0.4, 0.4, 0.4], scale: 0.5 },
  "concrete/concretefloor011a": { width: 512, height: 512, reflectivity: [0.42, 0.41, 0.39] },
  "concrete/concretewall008a": { width: 512, height: 512, reflectivity: [0.5, 0.49, 0.47] },
  "tools/toolsskybox": { width: 128, height: 128, reflectivity: [0.5, 0.5, 0.5], flags: SURF_SKY | SURF_NOLIGHT },
  "tools/toolstrigger": { width: 64, height: 64, reflectivity: [0.5, 0.3, 0.1], flags: SURF_TRIGGER | SURF_NOLIGHT },
  "tools/toolsnodraw": { width: 64, height: 64, reflectivity: [0.5, 0.5, 0.5], flags: SURF_NODRAW | SURF_NOLIGHT },
};

const T = {
  floor: "dev/graygrid",
  wall: "dev/dev_measuregeneric01b",
  wall2: "dev/dev_measurewall01c",
  exitWall: "dev/dev_measurewall01a",
  pit: "dev/dev_measurewall01d",
  accent: "dev/dev_measuregeneric01",
  dark: "dev/dev_measurewall01d",
  concrete: "concrete/concretefloor011a",
  concreteWall: "concrete/concretewall008a",
  sky: "tools/toolsskybox",
  trigger: "tools/toolstrigger",
};

export const SKY = "sky_day01_01";
export const HEIGHT = 512;
const WALL = 64;
export const PIT = 384;

export const LIGHTING: Lighting = {
  sunDir: norm([-0.35, 0.25, -0.9]),
  sun: [1.3, 1.18, 1.0],
  sky: [0.34, 0.4, 0.5],
  bounce: [0.13, 0.13, 0.14],
  luxel: 16,
  skyRays: 24,
};

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
}

// --------------------------------------------------------------------------------------------- building blocks

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const rect = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x0, y0, x1, y1 });
const shift = (o: [number, number], r: Rect): Rect => rect(o[0] + r.x0, o[1] + r.y0, o[0] + r.x1, o[1] + r.y1);
const inRect = (r: Rect, x: number, y: number) => x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1;

export interface Spot {
  position: Vec3;
  yaw: number;
}

interface RoomSpec {
  origin: [number, number];
  size: [number, number];
  /** Floor holes (pits), local. */
  pits?: Rect[];
  /** Floor inside pits again (stepping stones), local. */
  islands?: Rect[];
  /** Floor top materials by area (later wins), local. */
  paint?: { r: Rect; tex: string }[];
  floorTex?: string;
  wallTex?: string;
  /** Inner face material of the walls by side. */
  wallSide?: { n?: string; s?: string; e?: string; w?: string };
}

/** A lesson room: floor (with pits), four walls and a sky ceiling, all as boxes. Returns world-space boxes. */
function room(o: RoomSpec): Box[] {
  const [ox, oy] = o.origin;
  const [w, d] = o.size;
  const pits = o.pits ?? [];
  const zb = pits.length ? -PIT - 64 : -64;
  const wallTex = o.wallTex ?? T.wall;
  const ws = o.wallSide ?? {};
  const out: Box[] = [];
  const box = (min: Vec3, max: Vec3, tex: FaceTex) => out.push({ min, max, tex, contents: CONTENTS_SOLID });
  // Walls (full height, down to the pit floor) and the sky slab over everything.
  box([ox - WALL, oy - WALL, zb], [ox, oy + d + WALL, HEIGHT], { all: wallTex, px: ws.w ?? wallTex });
  box([ox + w, oy - WALL, zb], [ox + w + WALL, oy + d + WALL, HEIGHT], { all: wallTex, nx: ws.e ?? wallTex });
  box([ox, oy - WALL, zb], [ox + w, oy, HEIGHT], { all: wallTex, py: ws.s ?? wallTex });
  box([ox, oy + d, zb], [ox + w, oy + d + WALL, HEIGHT], { all: wallTex, ny: ws.n ?? wallTex });
  box([ox - WALL, oy - WALL, HEIGHT], [ox + w + WALL, oy + d + WALL, HEIGHT + 64], T.sky);
  // Floor: a grid over every pit / island / paint edge; each cell is floor (solid to z 0) or pit (solid to -PIT).
  const xs = new Set([0, w]);
  const ys = new Set([0, d]);
  for (const r of [...pits, ...(o.islands ?? []), ...(o.paint ?? []).map((p) => p.r)]) {
    for (const x of [r.x0, r.x1]) if (x > 0 && x < w) xs.add(x);
    for (const y of [r.y0, r.y1]) if (y > 0 && y < d) ys.add(y);
  }
  const X = [...xs].sort((a, b) => a - b);
  const Y = [...ys].sort((a, b) => a - b);
  const cells: string[][] = [];
  for (let i = 0; i < X.length - 1; i++) {
    cells.push([]);
    for (let j = 0; j < Y.length - 1; j++) {
      const cx = (X[i] + X[i + 1]) / 2;
      const cy = (Y[j] + Y[j + 1]) / 2;
      const pit = pits.some((r) => inRect(r, cx, cy)) && !(o.islands ?? []).some((r) => inRect(r, cx, cy));
      let tex = o.floorTex ?? T.floor;
      for (const p of o.paint ?? []) if (inRect(p.r, cx, cy)) tex = p.tex;
      cells[i].push(pit ? "pit" : tex);
    }
  }
  // Merge runs along y, then identical columns along x.
  const used = cells.map((c) => c.map(() => false));
  for (let i = 0; i < cells.length; i++) {
    for (let j = 0; j < cells[i].length; j++) {
      if (used[i][j]) continue;
      const k = cells[i][j];
      let j1 = j + 1;
      while (j1 < cells[i].length && cells[i][j1] === k && !used[i][j1]) j1++;
      let i1 = i + 1;
      while (i1 < cells.length && cells[i1].slice(j, j1).every((c, n) => c === k && !used[i1][j + n])) i1++;
      for (let a = i; a < i1; a++) for (let b = j; b < j1; b++) used[a][b] = true;
      const x0 = ox + X[i];
      const x1 = ox + X[i1];
      const y0 = oy + Y[j];
      const y1 = oy + Y[j1];
      if (k === "pit") box([x0, y0, zb], [x1, y1, -PIT], { all: T.pit });
      else box([x0, y0, zb], [x1, y1, 0], { all: pits.length ? T.pit : k, top: k });
    }
  }
  return out;
}

/**
 * The strafe line: a slalom along +x from x0 to x1 around y, `amp` either side, one strafe per half wave. The wave
 * lengthens from wl0 to wl1 (hops get longer as you speed up). Each point carries the key that bends the path there:
 * left (-1) where it curves left (+y), right (1) where it curves right.
 */
function slalom(x0: number, x1: number, y: number, amp: number, wl0: number, wl1: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  let phase = Math.PI; // starts out to the right, so the first bend is a left one (left strafe first)
  for (let x = x0; x <= x1; x += 16) {
    out.push([x, Math.round(y + amp * Math.sin(phase)), Math.sin(phase) < 0 ? -1 : 1]);
    phase += (2 * Math.PI * 16) / (wl0 + ((wl1 - wl0) * (x - x0)) / (x1 - x0));
  }
  return out;
}

const trigger = (keys: Record<string, string>, min: Vec3, max: Vec3): BrushEntity => ({ keys, boxes: [{ min, max, tex: T.trigger }] });

// --------------------------------------------------------------------------------------------- the course

export interface LessonGeometry {
  id: string;
  /** Interior bounds of the room (world). */
  room: { min: Vec3; max: Vec3 };
  start: Spot;
  /** Exit portal volume (world). */
  exit: { min: Vec3; max: Vec3 } | null;
  /** Speed gates (lesson 3): x position and target speed. */
  gates?: { x: number; speed: number }[];
  /** Hurdles (lesson 1) and gaps (lesson 4) along the travel axis. */
  gaps?: { axis: 0 | 1; from: number; to: number; width: number }[];
  /** The finish of the final course. */
  checkpoints?: { min: Vec3; max: Vec3 }[];
  /** Floor holes (world rects) and the stepping stones inside them. */
  pits?: Rect[];
  islands?: Rect[];
  /** Waypoints the demo bot follows from the start (world x, y). */
  route: [number, number][];
  /** The strafe line painted on the floor (lessons 2, 3): [x, y, key], key -1 = left strafe, 1 = right. */
  lane?: [number, number, number][];
}

export interface Course {
  boxes: Box[];
  entities: BrushEntity[];
  points: Record<string, string>[];
  lessons: LessonGeometry[];
  zones: { kind: "start" | "end" | "stage"; track?: number; index?: number; mins: Vec3; maxs: Vec3 }[];
  seeds: Vec3[];
  /** Bonus 1 (final course on its own) restart point. */
  bonusStart: Spot;
}

export function course(): Course {
  const boxes: Box[] = [];
  const entities: BrushEntity[] = [];
  const points: Record<string, string>[] = [];
  const lessons: LessonGeometry[] = [];
  const seeds: Vec3[] = [];
  const W = (o: [number, number], x: number, y: number, z = 0): Vec3 => [o[0] + x, o[1] + y, z];
  const dest = (name: string, s: Spot) => points.push({ classname: "info_teleport_destination", targetname: name, origin: s.position.join(" "), angles: `0 ${s.yaw} 0` });
  const teleport = (target: string, min: Vec3, max: Vec3) => entities.push(trigger({ classname: "trigger_teleport", target, spawnflags: "1", StartDisabled: "0" }, min, max));
  const pitTeleports = (o: [number, number], pits: Rect[], target: string) => {
    for (const p of pits) teleport(target, W(o, p.x0, p.y0, -PIT), W(o, p.x1, p.y1, -PIT + 64));
  };
  /** Exit portal: a trigger at the end of the room into the next lesson. */
  const exitPortal = (o: [number, number], r: Rect, next: string) => {
    const min = W(o, r.x0, r.y0, 0);
    const max = W(o, r.x1, r.y1, 256);
    teleport(next, min, max);
    return { min, max };
  };
  const spot = (o: [number, number], x: number, y: number, yaw: number): Spot => ({ position: W(o, x, y, 1), yaw });

  // ---- 1. Jumping: hold jump (autohop) / scroll on landing (Legit Scroll). Hurdles you can only hop over.
  {
    const o: [number, number] = [-14336, -14336];
    const size: [number, number] = [2048, 768];
    const hurdles = [640, 960, 1280, 1600];
    boxes.push(
      ...room({ origin: o, size, paint: [{ r: rect(1920, 0, 2048, 768), tex: T.accent }, { r: rect(64, 256, 320, 512), tex: T.dark }], wallSide: { e: T.exitWall } }),
    );
    for (const x of hurdles) boxes.push({ min: W(o, x, 0, 0), max: W(o, x + 32, 768, 24), tex: { all: T.accent, top: T.accent } });
    const start = spot(o, 192, 384, 0);
    dest("l1_start", start);
    const exit = exitPortal(o, rect(1920, 0, 2048, 768), "l2_start");
    lessons.push({ id: "jump", room: { min: W(o, 0, 0, 0), max: W(o, size[0], size[1], HEIGHT) }, start, exit, gaps: hurdles.map((x) => ({ axis: 0, from: o[0] + x, to: o[0] + x + 32, width: 32 })), route: [[o[0] + 2040, o[1] + 384]] });
    seeds.push([start.position[0], start.position[1], 32]);
    // Spawns (CS:S needs both teams' spawns on a server); the core uses the first CT spawn.
    for (const [i, cls] of ["info_player_counterterrorist", "info_player_terrorist"].entries()) {
      for (let k = 0; k < 4; k++) points.push({ classname: cls, origin: W(o, i === 0 && k === 0 ? 192 : 96 + 64 * k, i === 0 ? (k === 0 ? 384 : 320) : 448, 1).join(" "), angles: "0 0 0" });
    }
  }
  // ---- 2. Air strafing: a big open floor.
  {
    const o: [number, number] = [-11264, -14336];
    const size: [number, number] = [2560, 2560];
    boxes.push(...room({ origin: o, size, paint: [{ r: rect(2432, 1024, 2560, 1536), tex: T.accent }, { r: rect(128, 1152, 384, 1408), tex: T.dark }], wallSide: { e: T.wall2 } }));
    // A portal frame on the east wall so the exit reads from across the room.
    boxes.push({ min: W(o, 2496, 960, 0), max: W(o, 2560, 1024, 320), tex: T.accent }, { min: W(o, 2496, 1536, 0), max: W(o, 2560, 1600, 320), tex: T.accent }, { min: W(o, 2496, 960, 320), max: W(o, 2560, 1600, 384), tex: T.accent });
    const start = spot(o, 256, 1280, 0);
    const lane2 = slalom(o[0] + 480, o[0] + 2300, o[1] + 1280, 72, 560, 640);
    dest("l2_start", start);
    const exit = exitPortal(o, rect(2432, 1024, 2496, 1536), "l3_start");
    lessons.push({
      id: "strafe",
      room: { min: W(o, 0, 0, 0), max: W(o, size[0], size[1], HEIGHT) },
      start,
      exit,
      route: [[o[0] + 2520, o[1] + 1280]],
      lane: lane2,
    });
    seeds.push([start.position[0], start.position[1], 32]);
  }
  // ---- 3. Speed: a long straight with gates at 300 / 400 / 500.
  {
    const o: [number, number] = [-14336, -10752];
    const size: [number, number] = [7168, 768];
    const gates = [
      { x: 1792, speed: 300 },
      { x: 3584, speed: 400 },
      { x: 5376, speed: 500 },
    ];
    const paint = [{ r: rect(7040, 0, 7168, 768), tex: T.accent }, { r: rect(64, 256, 320, 512), tex: T.dark }, ...gates.map((g) => ({ r: rect(g.x, 0, g.x + 64, 768), tex: T.accent }))];
    boxes.push(...room({ origin: o, size, paint, wallSide: { e: T.exitWall } }));
    for (const g of gates) {
      boxes.push({ min: W(o, g.x, 0, 0), max: W(o, g.x + 64, 64, 384), tex: T.accent }, { min: W(o, g.x, 704, 0), max: W(o, g.x + 64, 768, 384), tex: T.accent });
    }
    const start = spot(o, 192, 384, 0);
    dest("l3_start", start);
    const exit = exitPortal(o, rect(7040, 0, 7168, 768), "l4_start");
    lessons.push({ id: "speed", room: { min: W(o, 0, 0, 0), max: W(o, size[0], size[1], HEIGHT) }, start, exit, gates: gates.map((g) => ({ x: o[0] + g.x + 32, speed: g.speed })), route: [[o[0] + 7160, o[1] + 384]], lane: slalom(o[0] + 420, o[0] + 6900, o[1] + 384, 96, 520, 960) });
    seeds.push([start.position[0], start.position[1], 32]);
  }
  // ---- 4. Put it together (the final course): a run-up, two gaps, a corner, stepping stones, the finish.
  let bonusStart: Spot;
  {
    const o: [number, number] = [-4096, -14336];
    const size: [number, number] = [4096, 3072];
    const gapA = rect(1536, 0, 1728, 768);
    const gapB = rect(2368, 0, 2592, 768);
    const bigPit = rect(3072, 1280, 4096, 2400);
    const stones = [rect(3264, 1440, 3904, 1760), rect(3264, 1920, 3904, 2240)];
    const paint = [
      { r: rect(0, 0, 256, 768), tex: T.dark },
      { r: rect(gapA.x0 - 32, 0, gapA.x0, 768), tex: T.accent },
      { r: rect(gapA.x1, 0, gapA.x1 + 32, 768), tex: T.accent },
      { r: rect(gapB.x0 - 32, 0, gapB.x0, 768), tex: T.accent },
      { r: rect(gapB.x1, 0, gapB.x1 + 32, 768), tex: T.accent },
      { r: rect(3072, 1248, 4096, 1280), tex: T.accent },
      { r: rect(3072, 2400, 4096, 2432), tex: T.accent },
      { r: rect(3072, 2816, 4096, 3072), tex: T.accent },
      ...stones.map((s) => ({ r: s, tex: T.dark })),
    ];
    boxes.push(...room({ origin: o, size, pits: [gapA, gapB, bigPit], islands: stones, paint, floorTex: T.concrete, wallTex: T.concreteWall }));
    // The unused corner of the L.
    boxes.push({ min: W(o, 0, 768, -PIT - 64), max: W(o, 3072, 3072, HEIGHT), tex: T.concreteWall });
    const start = spot(o, 416, 384, 0);
    bonusStart = spot(o, 128, 384, 0);
    dest("l4_start", start);
    pitTeleports(o, [gapA, gapB, bigPit], "l4_start");
    lessons.push({
      id: "final",
      room: { min: W(o, 0, 0, -PIT), max: W(o, size[0], size[1], HEIGHT) },
      start,
      exit: null,
      gaps: [
        { axis: 0, from: o[0] + gapA.x0, to: o[0] + gapA.x1, width: gapA.x1 - gapA.x0 },
        { axis: 0, from: o[0] + gapB.x0, to: o[0] + gapB.x1, width: gapB.x1 - gapB.x0 },
      ],
      checkpoints: [{ min: W(o, 3072, 2816, 0), max: W(o, 4096, 3072, 128) }],
      pits: [gapA, gapB, bigPit].map((p) => shift(o, p)),
      islands: stones.map((p) => shift(o, p)),
      route: [[o[0] + 3500, o[1] + 384], [o[0] + 3584, o[1] + 1100], [o[0] + 3584, o[1] + 3000]],
    });
    seeds.push([start.position[0], start.position[1], 32]);
  }

  // ---- zones: main track = the whole tutorial (start in lesson 1, a stage per lesson, end of the final course);
  // bonus 1 = the final course on its own (its own start pad behind the lesson-4 arrival point).
  const zbox = (c: Vec3, half: number): { mins: Vec3; maxs: Vec3 } => ({ mins: [c[0] - half, c[1] - half, 0], maxs: [c[0] + half, c[1] + half, 128] });
  const l = (id: string) => lessons.find((x) => x.id === id)!;
  const fin = l("final");
  const end = { mins: fin.checkpoints![0].min, maxs: fin.checkpoints![0].max };
  const zones: Course["zones"] = [
    { kind: "start", ...zbox(l("jump").start.position, 128) },
    ...["strafe", "speed", "final"].map((id, i) => ({ kind: "stage" as const, index: i + 2, ...zbox(l(id).start.position, 128) })),
    { kind: "end", ...end },
    { kind: "start", track: 1, mins: [fin.room.min[0], fin.room.min[1], 0], maxs: [fin.room.min[0] + 256, fin.room.min[1] + 768, 128] },
    { kind: "end", track: 1, ...end },
  ];
  return { boxes, entities, points, lessons, zones, seeds, bonusStart: bonusStart! };
}
