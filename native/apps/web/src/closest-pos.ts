// Closest position: where on a ghost's route the player is right now, for the time and speed difference against it.
// Display only: it reads recorded frames and the player's position, and nothing here reaches the sim, the replay file
// or the anticheat. DOM-free, so the search is tested under bun (apps/web/test/closest-pos.test.ts).
//
// shavit's timer does this with rtldg/sm_closestpos: a k-d tree over the whole replay, asked for the nearest frame in
// 3D, 10 times a second. That answer is often the wrong one: a route that loops, or a level straight above another,
// has a nearer frame somewhere else on the route, and the delta jumps. Here the search stays near the last match:
//
//   cost(t) = d²(player, frame t) + (PENALTY * route distance outside the window around the last match)²
//
// A frame further along the route has to be closer by that much to win, so a later pass over the same spot doesn't, and
// a player who really is somewhere else still gets there: when the near route is further than LOST (NEAR after a
// teleport), the search runs again with no penalty. Inside the window (WINDOW_BEHIND..WINDOW_AHEAD) there is no penalty
// either, so following the route has no lag. Route distance, not time: a ghost that stood still for 10 s went nowhere.
// Height counts Z_WEIGHT times: a level above isn't the same place as a spot that far along the floor.
//
// The index is a binary tree of bounding boxes over runs of consecutive ticks (leaf = LEAF ticks), plus the route
// distance at each tick. It's flat typed arrays, a pass over the frames to build (build(n) does n frames at a time, so a
// long replay costs no frame), and a search visits few boxes because a route is local in time and space. find()
// allocates nothing. Until the index is built, find() scans the route around the last match, the old way.

import { EVENT_TELEPORTED } from "./core";
import { FRAME_STRIDE } from "./sim";

/** Ticks per leaf box. */
const LEAF = 32;
/** A level above or below counts this many times its height. */
const Z_WEIGHT = 2;
/** Route (units) around the last match that costs nothing. Enough for a player much faster than the ghost. */
const WINDOW_AHEAD = 600;
const WINDOW_BEHIND = 150;
/** Units of distance one unit of route outside the window has to win back. */
const PENALTY = 1 / 6;
/** Per tick from the last match. Only so that the nearer tick wins a tie, as where a ghost stood still. */
const TIE = 1e-3;
/** Further from the route than this (units, height weighted) there is no match. */
export const LOST = 512;
/** The player moved this far since the last search: a teleport. */
const TELEPORT = 512;
/** After a teleport, a match further than this isn't where the ghost's own teleport landed: the search goes far. */
const NEAR = 128;
/** A frame-to-frame move over this (|dx| + |dy| + |dz|) is a teleport in the ghost's route (ghost.ts teleportBetween). */
const ROUTE_TELEPORT = 200;
/** How much route find() scans around the last match until the index is built (ticks). */
const SCAN_BEHIND = 300;
const SCAN_AHEAD = 600;

export class ClosestPos {
  /** Route tick of the match, with the fraction along the path (valid after find() returned true). */
  tick = 0;
  /** Height-weighted distance from the player to the match (units). */
  dist = 0;
  /** The ghost's horizontal speed at the match (u/s); NaN when its route teleports there. */
  speed = NaN;

  private readonly first: number;
  private readonly last: number;
  /** Frame events when the ghost has them (exact teleports). */
  private readonly events: Uint8Array | null;
  /** Boxes: [minX, minY, minZ, maxX, maxY, maxZ] per node. Node 1 is the root; leaves are cap..cap + leaves - 1. */
  private readonly boxes: Float32Array;
  /** Route distance at each tick from `first` (teleports add nothing). */
  private readonly arc: Float32Array;
  private readonly cap: number;
  private readonly leaves: number;
  private readonly height: number;
  private readonly nodes = new Int32Array(64);
  private readonly bounds = new Float64Array(64);
  /** Frames built so far (build()), then the next inner node to fill going down from cap - 1. */
  private built = 0;
  private up: number;
  /** The last match (whole tick). */
  private at = 0;
  private px = 0;
  private py = 0;
  private pz = 0;
  /** No position to compare the next one with (the route just started over). */
  private fresh = true;
  /** The last search found nothing: the next may go far, wherever the player has got to. */
  private lost = false;

  constructor(
    private readonly frames: Float32Array,
    startTick: number,
    endTick: number,
    private readonly tickInterval: number,
    events?: Uint8Array,
  ) {
    this.events = events && events.length * FRAME_STRIDE >= frames.length ? events : null;
    const n = Math.floor(frames.length / FRAME_STRIDE);
    this.first = Math.max(0, Math.min(n - 1, startTick));
    this.last = Math.max(this.first, Math.min(n - 1, endTick));
    this.arc = new Float32Array(this.last - this.first + 1);
    this.leaves = Math.ceil((this.last - this.first + 1) / LEAF);
    let cap = 1;
    let height = 0;
    while (cap < this.leaves) (cap *= 2), height++;
    this.cap = cap;
    this.height = height;
    const boxes = (this.boxes = new Float32Array(cap * 2 * 6));
    for (let k = this.leaves; k < cap; k++) {
      const i = (cap + k) * 6;
      boxes[i] = boxes[i + 1] = boxes[i + 2] = Infinity;
      boxes[i + 3] = boxes[i + 4] = boxes[i + 5] = -Infinity;
    }
    this.up = cap - 1;
    this.reset();
  }

  get ready(): boolean {
    return this.up < 1 && this.built > this.last - this.first;
  }

  /** The route starts over (restart, a new run, a load): the next search starts from its first tick. */
  reset(): void {
    this.at = this.first;
    this.fresh = true;
    this.lost = false;
    this.speed = NaN;
  }

  /** Builds the index, up to `maxFrames` more route frames' worth. Returns whether it's done. */
  build(maxFrames = Infinity): boolean {
    const f = this.frames;
    const b = this.boxes;
    const arc = this.arc;
    const first = this.first;
    const S = FRAME_STRIDE;
    let budget = maxFrames;
    const count = this.last - first + 1;
    while (this.built < count && budget > 0) {
      const k = Math.floor(this.built / LEAF);
      const from = first + k * LEAF;
      const to = Math.min(this.last, from + LEAF - 1);
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let t = from; t <= to; t++) {
        const o = t * S;
        const x = f[o], y = f[o + 1], z = f[o + 2];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
        if (t > first) {
          const dx = x - f[o - S], dy = y - f[o - S + 1], dz = z - f[o - S + 2];
          arc[t - first] = arc[t - first - 1] + (this.jumpBetween(t - 1, t) ? 0 : Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
      }
      const i = (this.cap + k) * 6;
      b[i] = x0; b[i + 1] = y0; b[i + 2] = z0; b[i + 3] = x1; b[i + 4] = y1; b[i + 5] = z1;
      this.built += to - from + 1;
      budget -= LEAF;
    }
    if (this.built < count) return false;
    // Inner nodes, children first. Missing leaves are empty boxes (constructor), so a merge needs no special case.
    while (this.up >= 1 && budget > 0) {
      const i = this.up-- * 6;
      const l = i * 2;
      const r = l + 6;
      for (let a = 0; a < 3; a++) {
        b[i + a] = Math.min(b[l + a], b[r + a]);
        b[i + 3 + a] = Math.max(b[l + 3 + a], b[r + 3 + a]);
      }
      budget -= 2;
    }
    return this.ready;
  }

  /**
   * The route point nearest (x, y, z) that continues from the last match. True: `tick`, `dist` and `speed` are set, and
   * the next search continues from here. False: no route within LOST; the next search may go anywhere.
   */
  find(x: number, y: number, z: number): boolean {
    const dx = x - this.px, dy = y - this.py, dz = z - this.pz;
    const far = this.lost || (!this.fresh && dx * dx + dy * dy + dz * dz > TELEPORT * TELEPORT);
    this.px = x;
    this.py = y;
    this.pz = z;
    this.fresh = false;
    const from = this.at;
    let best = this.search(x, y, z, PENALTY);
    const reach = far ? NEAR : LOST;
    if (this.distTo(best, x, y, z) > reach * reach) best = this.search(x, y, z, 0);
    else if (this.ready && this.outside(best)) {
      // It left the window: the penalty pulled the answer back a little. From there, it's the plain nearest.
      this.at = best;
      best = this.search(x, y, z, PENALTY);
    }
    const d2 = this.distTo(best, x, y, z);
    this.lost = d2 > LOST * LOST;
    if (this.lost) {
      this.at = from;
      return false;
    }
    this.at = best;
    this.dist = Math.sqrt(d2);
    this.tick = best + this.subTick(best, x, y, z);
    this.speed = this.speedAt(best);
    return true;
  }

  private outside(t: number): boolean {
    const ds = this.arc[t - this.first] - this.arc[this.at - this.first];
    return ds > WINDOW_AHEAD || ds < -WINDOW_BEHIND;
  }

  /** Height-weighted squared distance to a frame. */
  private distTo(t: number, x: number, y: number, z: number): number {
    const f = this.frames;
    const o = t * FRAME_STRIDE;
    const dx = f[o] - x, dy = f[o + 1] - y, dz = (f[o + 2] - z) * Z_WEIGHT;
    return dx * dx + dy * dy + dz * dz;
  }

  private search(x: number, y: number, z: number, penalty: number): number {
    if (!this.ready) return this.scan(x, y, z);
    const b = this.boxes;
    const f = this.frames;
    const arc = this.arc;
    const S = FRAME_STRIDE;
    const at = this.at, first = this.first, last = this.last, leaves = this.leaves;
    const here = arc[at - first];
    const cap = this.cap, height = this.height;
    let bestT = at;
    let best = this.distTo(at, x, y, z);
    const nodes = this.nodes;
    const bounds = this.bounds;
    let sp = 0;
    nodes[sp] = 1;
    bounds[sp++] = 0;
    while (sp > 0) {
      sp--;
      if (bounds[sp] >= best) continue;
      const node = nodes[sp];
      if (node >= cap) {
        const from = first + (node - cap) * LEAF;
        const to = Math.min(last, from + LEAF - 1);
        for (let t = from; t <= to; t++) {
          const o = t * S;
          const ax = f[o] - x, ay = f[o + 1] - y, az = (f[o + 2] - z) * Z_WEIGHT;
          const d2 = ax * ax + ay * ay + az * az;
          if (d2 >= best) continue;
          const ds = arc[t - first] - here;
          const out = ds > WINDOW_AHEAD ? ds - WINDOW_AHEAD : ds < -WINDOW_BEHIND ? -ds - WINDOW_BEHIND : 0;
          const p = penalty * out;
          const cost = d2 + p * p + TIE * Math.abs(t - at);
          if (cost < best) (best = cost), (bestT = t);
        }
        continue;
      }
      // The children's ticks: a node at depth d spans 2^(height - d) leaves.
      const down = height - (31 - Math.clz32(node)) - 1;
      const left = node * 2;
      let lbL = Infinity;
      let lbR = Infinity;
      for (let side = 0; side < 2; side++) {
        const child = left + side;
        const leaf0 = (child << down) - cap;
        if (leaf0 >= leaves) continue;
        const t0 = first + leaf0 * LEAF;
        const t1 = Math.min(last, t0 + (LEAF << down) - 1);
        const i = child * 6;
        const qx = x < b[i] ? b[i] - x : x > b[i + 3] ? x - b[i + 3] : 0;
        const qy = y < b[i + 1] ? b[i + 1] - y : y > b[i + 4] ? y - b[i + 4] : 0;
        const qz = (z < b[i + 2] ? b[i + 2] - z : z > b[i + 5] ? z - b[i + 5] : 0) * Z_WEIGHT;
        const ahead = arc[t0 - first] - here - WINDOW_AHEAD;
        const behind = here - arc[t1 - first] - WINDOW_BEHIND;
        const p = penalty * (ahead > 0 ? ahead : behind > 0 ? behind : 0);
        const lb = qx * qx + qy * qy + qz * qz + p * p + TIE * (at < t0 ? t0 - at : at > t1 ? at - t1 : 0);
        if (side === 0) lbL = lb;
        else lbR = lb;
      }
      // The nearer child first: it tightens `best` for the other. (Far child pushed first, popped second.)
      const lFirst = lbL <= lbR;
      const farLb = lFirst ? lbR : lbL;
      const nearLb = lFirst ? lbL : lbR;
      if (farLb < best) (nodes[sp] = lFirst ? left + 1 : left), (bounds[sp++] = farLb);
      if (nearLb < best) (nodes[sp] = lFirst ? left : left + 1), (bounds[sp++] = nearLb);
    }
    return bestT;
  }

  /** The search while the index isn't built yet: the nearest frame of the route around the last match. */
  private scan(x: number, y: number, z: number): number {
    const at = this.at;
    const to = Math.min(this.last, at + SCAN_AHEAD);
    let bestT = at;
    let best = Infinity;
    for (let t = Math.max(this.first, at - SCAN_BEHIND); t <= to; t++) {
      const d2 = this.distTo(t, x, y, z);
      if (d2 < best) (best = d2), (bestT = t);
    }
    return bestT;
  }

  /** The route teleports between neighbouring ticks i and j. */
  private jumpBetween(i: number, j: number): boolean {
    if (this.events && this.events[Math.max(i, j)] & EVENT_TELEPORTED) return true;
    const f = this.frames;
    const S = FRAME_STRIDE;
    return Math.abs(f[j * S] - f[i * S]) + Math.abs(f[j * S + 1] - f[i * S + 1]) + Math.abs(f[j * S + 2] - f[i * S + 2]) > ROUTE_TELEPORT;
  }

  /** Projects the player on the segment toward the better neighbour, for progress between ticks. Never across a teleport. */
  private subTick(t: number, x: number, y: number, z: number): number {
    if (t < this.last && !this.jumpBetween(t, t + 1)) {
      const u = this.along(t, t + 1, x, y, z);
      if (u > 0) return Math.min(1, u);
    }
    if (t > this.first && !this.jumpBetween(t, t - 1)) {
      const u = this.along(t, t - 1, x, y, z);
      if (u > 0) return -Math.min(1, u);
    }
    return 0;
  }

  private along(a: number, b: number, x: number, y: number, z: number): number {
    const f = this.frames;
    const S = FRAME_STRIDE;
    const ax = f[a * S], ay = f[a * S + 1], az = f[a * S + 2];
    const sx = f[b * S] - ax, sy = f[b * S + 1] - ay, sz = f[b * S + 2] - az;
    const l2 = sx * sx + sy * sy + sz * sz;
    return l2 > 1e-6 ? ((x - ax) * sx + (y - ay) * sy + (z - az) * sz) / l2 : 0;
  }

  /**
   * Horizontal speed from the move into tick t (the frames hold no velocity; shavit reads it off replay frames the same
   * way). A teleport takes the next move instead; both sides teleporting has no speed.
   */
  private speedAt(t: number): number {
    const f = this.frames;
    const S = FRAME_STRIDE;
    let a = t - 1;
    let b = t;
    if (a < 0 || this.jumpBetween(a, b)) {
      a = t;
      b = t + 1;
      if (b * S + 2 >= f.length || this.jumpBetween(a, b)) return NaN;
    }
    const dx = f[b * S] - f[a * S];
    const dy = f[b * S + 1] - f[a * S + 1];
    return Math.sqrt(dx * dx + dy * dy) / this.tickInterval;
  }
}

/** "+42" / "-17" / "+0": a speed difference as the HUD shows it (shavit's "(+42)"). */
export function formatSpeedDiff(v: number): string {
  const r = Math.round(v);
  return r < 0 ? String(r) : `+${r === 0 ? 0 : r}`;
}
