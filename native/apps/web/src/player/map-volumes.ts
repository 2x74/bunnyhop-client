// The loaded map's water and ladder volumes, for presentation only: the bunny's swim and climb modes (player/bunny/
// legs.ts) for every player path that doesn't carry them in its own data (replays and head to head get the ladder
// from the replay's F_LADDER, ghosts from their frames' FRAME_LADDER; water comes from here for all of them, and both
// for other players in a room, whose wire carries neither). Registered when the game's map is built (main.ts); the
// menu background (attract.ts) gives its ghost its own map's (Ghost.volumes). Nothing here reaches the simulation.
//
//   water    what the simulation calls water (crates/core game.rs point_contents): the contents of the world BSP's
//            leaf at a point (CONTENTS_WATER / SLIME), plus func_water_analog brush models at their compiled place.
//            Not the render water (core.waterVolumes): that also has water brushes the movement never sees. Source's
//            water level from the hull: 0 dry, 1 feet, 2 waist (the hull's centre: swimming), 3 eyes.
//   ladders  the BSP's brushes with CONTENTS_LADDER (CS:S ladders are ladder-content brushes; func_ladder is merged
//            into them by the compiler), as boxes from their axial sides. For other players (LadderGuess) climbing is
//            what the movement does (movement.rs update_ladder): off the ground, the hull within LADDER_NEAR of a
//            ladder (LADDER_HOLD once on it), and no gravity on the vertical speed (the ladder sets the velocity;
//            strafing past a ladder falls at sv_gravity, a push lift has no ladder brush near it).

/** movement CONTENTS_* (crates/vendor/movement). */
const CONTENTS_WATER = 0x20, CONTENTS_SLIME = 0x10, CONTENTS_LADDER = 0x20000000;
const WATER = CONTENTS_WATER | CONTENTS_SLIME;

export interface MapVolumes {
  /** Whether a point (Source units) is in the simulation's water; null = a map without any. */
  water: ((x: number, y: number, z: number) => boolean) | null;
  /** Ladder boxes [minx, miny, minz, maxx, maxy, maxz]. */
  ladders: number[][];
}

const NONE: MapVolumes = { water: null, ladders: [] };
let current: MapVolumes = NONE;

/** The map now loaded (null: none). */
export function setMapVolumes(v: MapVolumes | null): void {
  current = v ?? NONE;
}

export function mapVolumes(): MapVolumes {
  return current;
}

/** The volumes of a map from its BSP bytes (unreadable: none). */
export function volumesOf(bsp: Uint8Array | null): MapVolumes {
  if (!bsp) return NONE;
  let water: MapVolumes["water"] = null, ladders: number[][] = [];
  try {
    water = waterTest(bsp);
  } catch {
    water = null;
  }
  try {
    ladders = ladderBoxes(bsp);
  } catch {
    ladders = [];
  }
  return { water, ladders };
}

/** Water from boxes (tests, synthetic maps): [minx, miny, minz, maxx, maxy, maxz], each optionally cut by planes n.p <= d. */
export function waterFromBoxes(boxes: number[][], planes: number[][][] = []): MapVolumes["water"] {
  if (!boxes.length) return null;
  return (x, y, z) => {
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (x < b[0] || x > b[3] || y < b[1] || y > b[4] || z < b[2] || z > b[5]) continue;
      const q = planes[i];
      if (!q || q.every((c) => c[0] * x + c[1] * y + c[2] * z <= c[3] + 0.01)) return true;
    }
    return false;
  };
}

/**
 * Source's water level at feet origin `p` (Source units): 3 eyes under (origin + viewZ), 2 the hull's centre (36
 * standing, 18 ducked: swimming), 1 the feet, else 0 (movement.rs: the same three points).
 */
export function waterLevelAt(p: ArrayLike<number>, viewZ = 64, crouched = false, v: MapVolumes = current): number {
  const w = v.water;
  if (!w) return 0;
  const x = p[0], y = p[1], z = p[2];
  if (!w(x, y, z + 1)) return 0;
  if (!w(x, y, z + (crouched ? 18 : 36))) return 1;
  return w(x, y, z + viewZ) ? 3 : 2;
}

/**
 * A recorded frame's climb and swim (ghosts, ghost.ts): climbing from the frame's own ladder bit (`ladder`: sim.ts
 * FRAME_LADDER, exact), the water level from the map at its standing (64) or ducked (46) view height.
 */
export function recordedModes(ladder: boolean, p: ArrayLike<number>, crouched: boolean, v: MapVolumes = current): { ladder: boolean; water: number } {
  return { ladder, water: waterLevelAt(p, crouched ? 46 : 64, crouched, v) };
}

/** Ladder attach distances (movement.rs: CCSGameMovement::LadderDistance, 2 off a ladder, 10 on it), units. */
export const LADDER_NEAR = 2, LADDER_HOLD = 10;
/** sv_gravity, and how far (u/s²) the measured vertical acceleration may be from it and still be a fall. */
const GRAVITY = 800, GRAVITY_TOL = 40;

/** Horizontal gap (units) from the hull at feet origin `p` to the nearest ladder box overlapping it in height. */
export function ladderGap(p: ArrayLike<number>, crouched: boolean, v: MapVolumes = current): number {
  let best = Infinity;
  const z0 = p[2], z1 = p[2] + (crouched ? 54 : 72);
  for (const b of v.ladders) {
    if (z0 > b[5] || z1 < b[2]) continue;
    const gx = Math.max(0, b[0] - (p[0] + 16), p[0] - 16 - b[3]), gy = Math.max(0, b[1] - (p[1] + 16), p[1] - 16 - b[4]);
    best = Math.min(best, Math.hypot(gx, gy));
  }
  return best;
}

/**
 * Climbing, for another player in a room (their wire carries no movement mode): off the ground and out of deep water,
 * the hull within LADDER_NEAR of a ladder brush (LADDER_HOLD while already climbing), and a vertical acceleration that
 * isn't gravity, measured from their interpolated velocity over at least ACC_WINDOW. Nothing is assumed before the
 * first measurement. One per player; `time` in seconds.
 */
export class LadderGuess {
  private vz = NaN;
  private t = 0;
  private falling = true;
  private on = false;

  reset(): void {
    this.vz = NaN;
    this.falling = true;
    this.on = false;
  }

  update(p: ArrayLike<number>, vel: ArrayLike<number>, crouched: boolean, grounded: boolean, time: number, v: MapVolumes = current): boolean {
    if (Number.isNaN(this.vz) || time < this.t || time - this.t > 0.5) (this.vz = vel[2]), (this.t = time), (this.falling = true);
    else if (time - this.t >= ACC_WINDOW) {
      const az = (vel[2] - this.vz) / (time - this.t);
      this.falling = Math.abs(az + GRAVITY) <= GRAVITY_TOL;
      (this.vz = vel[2]), (this.t = time);
    }
    if (grounded || !v.ladders.length || waterLevelAt(p, crouched ? 46 : 64, crouched, v) >= 2) return (this.on = false);
    return (this.on = !this.falling && ladderGap(p, crouched, v) <= (this.on ? LADDER_HOLD : LADDER_NEAR));
  }
}
const ACC_WINDOW = 0.009;

/** A player at feet origin `p` (16-unit half-width hull, 72 / 54 tall) touches a ladder brush, not standing on the ground. */
export function onLadderAt(p: ArrayLike<number>, crouched: boolean, grounded: boolean, v: MapVolumes = current): boolean {
  if (grounded || !v.ladders.length) return false;
  const x0 = p[0] - 17, x1 = p[0] + 17, y0 = p[1] - 17, y1 = p[1] + 17, z0 = p[2], z1 = p[2] + (crouched ? 54 : 72);
  for (const b of v.ladders) if (x0 <= b[3] && x1 >= b[0] && y0 <= b[4] && y1 >= b[1] && z0 <= b[5] && z1 >= b[2]) return true;
  return false;
}

/**
 * Ladder brushes of a Source BSP (v19-v21): brushes (lump 18) with CONTENTS_LADDER, each bounded by its axial sides
 * (lump 19 -> planes, lump 1; compilers add axial bevels to every brush, so the box is there for any shape).
 */
export function ladderBoxes(bsp: Uint8Array): number[][] {
  const dv = new DataView(bsp.buffer, bsp.byteOffset, bsp.byteLength);
  if (bsp.length < 1036 || dv.getUint32(0, true) !== 0x50534256) return []; // "VBSP"
  const version = dv.getInt32(4, true);
  const lump = (i: number) => ({ ofs: dv.getInt32(8 + i * 16, true), len: dv.getInt32(8 + i * 16 + 4, true) });
  const planes = lump(1), brushes = lump(18), sides = lump(19);
  const SIDE = 8;
  const out: number[][] = [];
  for (let b = 0; b < brushes.len / 12; b++) {
    const o = brushes.ofs + b * 12;
    const first = dv.getInt32(o, true), n = dv.getInt32(o + 4, true), contents = dv.getInt32(o + 8, true);
    if (!(contents & CONTENTS_LADDER) || n <= 0) continue;
    const box = [-Infinity, -Infinity, -Infinity, Infinity, Infinity, Infinity];
    for (let s = 0; s < n; s++) {
      const so = sides.ofs + (first + s) * SIDE;
      if (so + SIDE > sides.ofs + sides.len) break;
      const pn = dv.getUint16(so, true);
      const po = planes.ofs + pn * 20;
      if (po + 20 > planes.ofs + planes.len) continue;
      const nx = dv.getFloat32(po, true), ny = dv.getFloat32(po + 4, true), nz = dv.getFloat32(po + 8, true), d = dv.getFloat32(po + 12, true);
      // Axial planes only: +axis bounds the max, -axis the min.
      if (nx > 0.999) box[3] = Math.min(box[3], d);
      else if (nx < -0.999) box[0] = Math.max(box[0], -d);
      else if (ny > 0.999) box[4] = Math.min(box[4], d);
      else if (ny < -0.999) box[1] = Math.max(box[1], -d);
      else if (nz > 0.999) box[5] = Math.min(box[5], d);
      else if (nz < -0.999) box[2] = Math.max(box[2], -d);
    }
    if (box.every(Number.isFinite) && box[0] < box[3] && box[1] < box[4] && box[2] < box[5]) out.push(box.map((x) => x + 0)); // (no -0)
  }
  void version;
  return out;
}

/**
 * The simulation's water test for a Source BSP (v19-v21): the world model's node tree down to a leaf, its contents
 * (planes lump 1, nodes 5, leafs 10, models 14), plus the func_water_analog brush models (entities lump 0), each
 * through its own tree at its origin. null when the map has no water leaf.
 */
export function waterTest(bsp: Uint8Array): MapVolumes["water"] {
  const dv = new DataView(bsp.buffer, bsp.byteOffset, bsp.byteLength);
  if (bsp.length < 1036 || dv.getUint32(0, true) !== 0x50534256) return null;
  const version = dv.getInt32(4, true);
  const lump = (i: number) => ({ ofs: dv.getInt32(8 + i * 16, true), len: dv.getInt32(8 + i * 16 + 4, true) });
  const planes = lump(1), nodes = lump(5), leafs = lump(10), models = lump(14);
  const LEAF = version <= 19 ? 56 : 32;
  const leafCount = Math.floor(leafs.len / LEAF), nodeCount = Math.floor(nodes.len / 32), planeCount = Math.floor(planes.len / 20);
  let anyWater = false;
  for (let i = 0; i < leafCount; i++) if (dv.getInt32(leafs.ofs + i * LEAF, true) & WATER) anyWater = true;
  if (!anyWater) return null;
  const contents = (head: number, x: number, y: number, z: number): number => {
    let n = head;
    for (let guard = 0; n >= 0 && guard < 4096; guard++) {
      if (n >= nodeCount) return 0;
      const o = nodes.ofs + n * 32;
      const pi = dv.getInt32(o, true);
      if (pi < 0 || pi >= planeCount) return 0;
      const po = planes.ofs + pi * 20;
      const d = dv.getFloat32(po, true) * x + dv.getFloat32(po + 4, true) * y + dv.getFloat32(po + 8, true) * z - dv.getFloat32(po + 12, true);
      n = dv.getInt32(o + (d >= 0 ? 4 : 8), true);
    }
    const leaf = -1 - n;
    return leaf >= 0 && leaf < leafCount ? dv.getInt32(leafs.ofs + leaf * LEAF, true) : 0;
  };
  const model = (i: number) => {
    const o = models.ofs + i * 48;
    return { mins: [0, 4, 8].map((k) => dv.getFloat32(o + k, true)), maxs: [12, 16, 20].map((k) => dv.getFloat32(o + k, true)), head: dv.getInt32(o + 36, true) };
  };
  const world = model(0).head;
  // func_water_analog brush models (where the map places them; their movement isn't followed).
  const analog: { head: number; ox: number; oy: number; oz: number; mins: number[]; maxs: number[] }[] = [];
  const ents = lump(0);
  if (ents.len > 0) {
    const text = new TextDecoder("latin1").decode(bsp.subarray(ents.ofs, ents.ofs + ents.len));
    for (const m of text.matchAll(/\{[^{}]*\}/g)) {
      const e = m[0];
      if (!/"classname"\s+"func_water_analog"/.test(e)) continue;
      const mi = /"model"\s+"\*(\d+)"/.exec(e);
      if (!mi) continue;
      const idx = Number(mi[1]);
      if (idx <= 0 || idx >= models.len / 48) continue;
      const org = /"origin"\s+"([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)"/.exec(e);
      const md = model(idx);
      analog.push({ head: md.head, ox: org ? +org[1] : 0, oy: org ? +org[2] : 0, oz: org ? +org[3] : 0, mins: md.mins, maxs: md.maxs });
    }
  }
  return (x, y, z) => {
    if (contents(world, x, y, z) & WATER) return true;
    for (const a of analog) {
      const lx = x - a.ox, ly = y - a.oy, lz = z - a.oz;
      if (lx < a.mins[0] - 1 || ly < a.mins[1] - 1 || lz < a.mins[2] - 1 || lx > a.maxs[0] + 1 || ly > a.maxs[1] + 1 || lz > a.maxs[2] + 1) continue;
      if (contents(a.head, lx, ly, lz) & WATER) return true;
    }
    return false;
  };
}
