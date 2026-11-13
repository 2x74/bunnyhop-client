// Fading ghost trail through recent path points (three.js space, oldest first). Rebuilt on the CPU every frame (a few
// hundred quads at most), one draw call whatever the shape. Two-tone trails (a trail cosmetic's color2, e.g. Geode:
// crystal aqua -> amethyst) shift from the main colour at the head to the second toward the tail.
//
// Shapes (v0.0.41; the Loadout's Trail shape, progression.ts "shape-*"): the colour and the shape are separate picks.
//   ribbon  the camera-facing ribbon it has always been
//   comet   a wide head that narrows at once into a long hairline
//   twin    two thin rails
//   dashes  the ribbon cut into dashes that stay where they were laid
//   seeds   small seeds scattered off the path, spreading and falling as they age
//   petals  petals shed to either side, tumbling down
//   clover  a thin stem strung with four-leaf clovers
// Everything but the ribbon and the comet is laid per path sample, so it stays put in the world while the bunny moves
// on (`phase` in set()).

import * as THREE from "three";

export const TRAIL_SHAPES = ["ribbon", "comet", "twin", "dashes", "seeds", "petals", "clover"] as const;
export type TrailShape = (typeof TRAIL_SHAPES)[number];

/** A trail shape from its cosmetic id ("shape-petals"); anything else is the ribbon. */
export function trailShapeOf(id: string | null | undefined): TrailShape {
  const s = id?.startsWith("shape-") ? id.slice(6) : id;
  return TRAIL_SHAPES.find((x) => x === s) ?? "ribbon";
}

/** The shapes made of marks (seeds, petals, clovers): sized by the trail's width like the rest, so a close-up view that
 * draws the ribbon wide (the Loadout's stage, the unlock card) passes these a narrower one. */
export const laidShape = (s: TrailShape): boolean => s === "seeds" || s === "petals" || s === "clover";

/** The most quads a shape draws per path point (twin: two rails; seeds: four; petals: two of two quads; clover: the stem, and four leaves of two quads every other point at most). */
const QUADS_PER_POINT: Record<TrailShape, number> = { ribbon: 1, comet: 1, twin: 2, dashes: 1, seeds: 4, petals: 4, clover: 5 };
/** Per-point scratch: side (3), along (3), age fraction, alpha, colour (3). */
const FRAME = 11;

/** A stable 0..1 hash of a sample number and a salt: what a mark looks like never changes while it's on screen. */
function hash(n: number, salt: number): number {
  let x = Math.imul(n ^ Math.imul(salt + 1, 0x9e3779b1), 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

type Profile = (f: number) => number;
const RIBBON_W: Profile = (f) => 0.15 + 0.85 * f;
const RIBBON_A: Profile = (f) => f * f;
const COMET_W: Profile = (f) => 0.22 + 2.4 * f ** 9;
const COMET_A: Profile = (f) => Math.min(1, 0.9 * f + 0.6 * f ** 8);
const TWIN_W: Profile = (f) => 0.36 * (0.3 + 0.7 * f);
const TWIN_A: Profile = (f) => f ** 1.2;
const DASH_W: Profile = (f) => 0.9 * (0.35 + 0.65 * f);
const SOFT_A: Profile = (f) => f ** 1.5;
const STEM_W: Profile = (f) => 0.3 * (0.4 + 0.6 * f);

export class Trail {
  readonly mesh: THREE.Mesh;
  private pos = new Float32Array(0);
  private col = new Float32Array(0);
  private frame: Float32Array;
  private color = new THREE.Color();
  /** Tail colour; null = one colour. */
  private color2: THREE.Color | null = null;
  private shape: TrailShape = "ribbon";
  private geo = new THREE.BufferGeometry();
  /** Quads written this frame, and the room for them. */
  private n = 0;
  private room = 0;

  constructor(
    color: THREE.ColorRepresentation,
    readonly max = 320,
    color2: THREE.ColorRepresentation | null = null,
    shape: TrailShape = "ribbon",
  ) {
    this.setColor(color, color2);
    this.frame = new Float32Array(max * FRAME);
    this.setShape(shape);
    this.mesh = new THREE.Mesh(
      this.geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
  }

  /** Head colour, and the tail colour of a two-tone trail (null / absent / the same colour = one colour). */
  setColor(color: THREE.ColorRepresentation, color2: THREE.ColorRepresentation | null = null): void {
    this.color.set(color);
    const c2 = color2 == null ? null : new THREE.Color(color2);
    this.color2 = c2 && !c2.equals(this.color) ? c2 : null;
  }

  setShape(shape: TrailShape): void {
    this.shape = shape;
    const room = this.max * QUADS_PER_POINT[shape];
    if (room <= this.room) return;
    // More room: new buffers (the old ones go with the geometry's next upload).
    this.room = room;
    this.pos = new Float32Array(room * 4 * 3);
    this.col = new Float32Array(room * 4 * 4);
    const idx = new Uint16Array(room * 6);
    for (let q = 0; q < room; q++) {
      const a = q * 4;
      idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], q * 6);
    }
    this.geo.dispose();
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
  }

  /**
   * points: xyz triples (three space), `count` of them, oldest first. Width and alpha fall off from the head to the tail
   * (how depends on the shape). `phase`: the sample number of points[0], for the shapes laid per sample: every point but
   * the last (the moving head) is a fixed sample of the path, one number apart, so a dash or a petal stays where it was
   * laid while the window slides over it.
   */
  set(points: Float32Array, count: number, camera: THREE.Vector3, opacity: number, width = 3, phase = 0): void {
    count = Math.min(count, this.max);
    if (count < 2) {
      this.geo.setDrawRange(0, 0);
      return;
    }
    const F = this.frame;
    const c2 = this.color2;
    // Marks start fading farther out than the ribbon: a petal right in front of the eye fills the view.
    const fade0 = laidShape(this.shape) ? 70 : 40, fadeBy = laidShape(this.shape) ? 260 : 160;
    for (let i = 0; i < count; i++) {
      const o = i * 3;
      const prev = Math.max(0, i - 1) * 3;
      const next = Math.min(count - 1, i + 1) * 3;
      const tx = points[next] - points[prev];
      const ty = points[next + 1] - points[prev + 1];
      const tz = points[next + 2] - points[prev + 2];
      const vx = camera.x - points[o];
      const vy = camera.y - points[o + 1];
      const vz = camera.z - points[o + 2];
      // side = normalize(t x v); along = normalize(v x side): both across the line of sight, along runs with the path.
      let sx = ty * vz - tz * vy;
      let sy = tz * vx - tx * vz;
      let sz = tx * vy - ty * vx;
      const l = Math.hypot(sx, sy, sz) || 1;
      sx /= l;
      sy /= l;
      sz /= l;
      const dc = Math.hypot(vx, vy, vz) || 1;
      const k = i * FRAME;
      F[k] = sx;
      F[k + 1] = sy;
      F[k + 2] = sz;
      F[k + 3] = (vy * sz - vz * sy) / dc;
      F[k + 4] = (vz * sx - vx * sz) / dc;
      F[k + 5] = (vx * sy - vy * sx) / dc;
      const f = i / (count - 1);
      F[k + 6] = f;
      // Fades near the camera (a trail passing under / through the eye reads as a smear).
      const near = Math.min(1, Math.max(0, (dc - fade0) / fadeBy));
      F[k + 7] = opacity * near * near;
      let { r, g, b } = this.color;
      if (c2) {
        // Two-tone: the head keeps the main colour for its brightest stretch, then shifts to the tail colour (fully by
        // the middle of the trail, while it's still bright enough to read).
        const m = Math.min(1, Math.max(0, (0.92 - f) * 2.4));
        const s = m * m * (3 - 2 * m);
        r += (c2.r - r) * s;
        g += (c2.g - g) * s;
        b += (c2.b - b) * s;
      }
      F[k + 8] = r;
      F[k + 9] = g;
      F[k + 10] = b;
    }

    this.n = 0;
    const base = Math.round(phase);
    switch (this.shape) {
      case "ribbon":
        this.strip(points, count, width, 0, RIBBON_W, RIBBON_A);
        break;
      case "comet":
        this.strip(points, count, width, 0, COMET_W, COMET_A);
        break;
      case "twin":
        this.strip(points, count, width, -1, TWIN_W, TWIN_A);
        this.strip(points, count, width, 1, TWIN_W, TWIN_A);
        break;
      case "dashes":
        this.strip(points, count, width, 0, DASH_W, SOFT_A, base);
        break;
      case "seeds":
        this.seeds(points, count, width, base);
        break;
      case "petals":
        this.petals(points, count, width, base);
        break;
      case "clover":
        this.strip(points, count, width, 0, STEM_W, SOFT_A);
        this.clovers(points, count, width, base);
        break;
    }

    const pa = this.geo.attributes.position as THREE.BufferAttribute;
    const ca = this.geo.attributes.color as THREE.BufferAttribute;
    pa.clearUpdateRanges();
    ca.clearUpdateRanges();
    pa.addUpdateRange(0, this.n * 12);
    ca.addUpdateRange(0, this.n * 16);
    pa.needsUpdate = ca.needsUpdate = true;
    this.geo.setDrawRange(0, this.n * 6);
  }

  private vert(v: number, x: number, y: number, z: number, r: number, g: number, b: number, a: number): void {
    const P = this.pos, C = this.col;
    P[v * 3] = x;
    P[v * 3 + 1] = y;
    P[v * 3 + 2] = z;
    C[v * 4] = r;
    C[v * 4 + 1] = g;
    C[v * 4 + 2] = b;
    C[v * 4 + 3] = a;
  }

  /**
   * A ribbon along the path, `off` widths to the side, its half width and alpha by age (`wf`, `af`). With `dash` (the
   * sample number of point 0) only three samples in every six are drawn.
   */
  private strip(points: Float32Array, count: number, width: number, off: number, wf: Profile, af: Profile, dash: number | null = null): void {
    const F = this.frame;
    for (let i = 0; i + 1 < count && this.n < this.room; i++) {
      if (dash !== null && (((dash + i) % 6) + 6) % 6 >= 3) continue;
      const v = this.n++ * 4;
      for (let e = 0; e < 2; e++) {
        const j = i + e, k = j * FRAME, o = j * 3;
        const f = F[k + 6];
        const c = off * width, w = wf(f) * width, a = F[k + 7] * af(f);
        const x = points[o] + F[k] * c, y = points[o + 1] + F[k + 1] * c, z = points[o + 2] + F[k + 2] * c;
        this.vert(v + e * 2, x + F[k] * w, y + F[k + 1] * w, z + F[k + 2] * w, F[k + 8], F[k + 9], F[k + 10], a);
        this.vert(v + e * 2 + 1, x - F[k] * w, y - F[k + 1] * w, z - F[k + 2] * w, F[k + 8], F[k + 9], F[k + 10], a);
      }
    }
  }

  /**
   * How many marks the stretch from fixed sample i to the next one carries, `spacing` units apart on average (at most
   * `cap`): by distance, so a trail is as full at 300 u/s as at 3,000, and from the sample's number alone, so the
   * marks stay put. `j` is the sample's number.
   */
  private marksOn(points: Float32Array, i: number, j: number, spacing: number, cap: number): number {
    const o = i * 3;
    const len = Math.hypot(points[o + 3] - points[o], points[o + 4] - points[o + 1], points[o + 5] - points[o + 2]);
    return Math.min(cap, Math.floor(len / spacing + hash(j, 0)));
  }

  /**
   * A mark facing the camera (one quad per four corners), `fr` of the way from point i to the next, moved (dx, dy) units across /
   * along the path and `drop` units down. Its corners are given in its own axes (turned by `turn`): (u, v) pairs, u
   * along its length. Each quad is drawn as the triangles (0, 1, 2) and (1, 3, 2), so a kite and a notched leaf both fit.
   */
  private mark(points: Float32Array, i: number, fr: number, dx: number, dy: number, drop: number, turn: number, corners: readonly number[], lu: number, lv: number, tint: number, alpha: number): void {
    const quads = corners.length >> 3;
    if (this.n + quads > this.room) return;
    const F = this.frame, k = i * FRAME, o = i * 3;
    const cx = points[o] + (points[o + 3] - points[o]) * fr + F[k] * dx + F[k + 3] * dy;
    const cy = points[o + 1] + (points[o + 4] - points[o + 1]) * fr + F[k + 1] * dx + F[k + 4] * dy - drop;
    const cz = points[o + 2] + (points[o + 5] - points[o + 2]) * fr + F[k + 2] * dx + F[k + 5] * dy;
    const c = Math.cos(turn), s = Math.sin(turn);
    // Length axis A = cos * along + sin * side; width axis B = cos * side - sin * along.
    const ax = (F[k + 3] * c + F[k] * s) * lu, ay = (F[k + 4] * c + F[k + 1] * s) * lu, az = (F[k + 5] * c + F[k + 2] * s) * lu;
    const bx = (F[k] * c - F[k + 3] * s) * lv, by = (F[k + 1] * c - F[k + 4] * s) * lv, bz = (F[k + 2] * c - F[k + 5] * s) * lv;
    const r = F[k + 8] + (1 - F[k + 8]) * tint, g = F[k + 9] + (1 - F[k + 9]) * tint, b = F[k + 10] + (1 - F[k + 10]) * tint;
    const a = Math.min(1, F[k + 7] * alpha);
    const v = this.n * 4;
    this.n += quads;
    for (let q = 0; q < quads * 4; q++) {
      const u = corners[q * 2], w = corners[q * 2 + 1];
      this.vert(v + q, cx + ax * u + bx * w, cy + ay * u + by * w, cz + az * u + bz * w, r, g, b, a);
    }
  }

  /** Seeds thrown a little off the path: they spread, sink and fade as they age. Newest first (as are the others). */
  private seeds(points: Float32Array, count: number, width: number, base: number): void {
    const F = this.frame;
    for (let i = count - 3; i >= 0; i--) {
      const f = F[i * FRAME + 6], age = 1 - f;
      const grow = Math.min(1, (count - 2 - i) / 2);
      const m = this.marksOn(points, i, base + i, width * 2.6, 4);
      for (let s = 0; s < m; s++) {
        const j = (base + i) * 4 + s;
        const h1 = hash(j, 1), h2 = hash(j, 2), h3 = hash(j, 3), h4 = hash(j, 4);
        const size = width * (1.5 + 1 * h3) * grow * (0.55 + 0.45 * f);
        this.mark(points, i, (s + h2) / m, (h1 * 2 - 1) * width * (0.8 + 4.5 * age), 0, width * 4 * age * age * (0.4 + h3), h4 * 6.283 + age * (h1 - 0.5) * 9, KITE, size, size * 0.3, 0.3 * h2, 1.4 * f ** 0.9 * (0.65 + 0.35 * h4));
      }
    }
  }

  /** Petals shed to one side or the other: they drift out, tumble and sink. */
  private petals(points: Float32Array, count: number, width: number, base: number): void {
    const F = this.frame;
    for (let i = count - 3; i >= 0; i--) {
      const f = F[i * FRAME + 6], age = 1 - f;
      const grow = Math.min(1, (count - 2 - i) / 3);
      const m = this.marksOn(points, i, base + i, width * 4, 2);
      for (let s = 0; s < m; s++) {
        const j = (base + i) * 4 + s;
        const h1 = hash(j, 11), h2 = hash(j, 12), h3 = hash(j, 13), h4 = hash(j, 14);
        const len = width * (2.7 + 1.5 * h4) * grow;
        // The tumble: the petal turns about its length, so its width opens and closes (never quite edge-on).
        const open = 0.25 + 0.75 * Math.abs(Math.cos(h2 * 6.283 + age * (5 + 7 * h3)));
        this.mark(points, i, (s + h2) / m, (h1 < 0.5 ? -1 : 1) * width * (0.6 + 5 * age * (0.35 + 0.65 * h2)), 0, width * 7 * age ** 1.5 * (0.35 + 0.65 * h3), h1 * 6.283 + age * (h4 - 0.5) * 7, PETAL, len, len * 0.3 * open, 0.45 * h3, 1.4 * Math.min(1, f * 2.2));
      }
    }
  }

  /** Four-leaf clovers along the stem, evenly spaced (every n-th sample, n from how far apart the samples are here). */
  private clovers(points: Float32Array, count: number, width: number, base: number): void {
    const F = this.frame;
    for (let i = count - 3; i >= 0; i--) {
      const j = base + i, o = i * 3;
      const len = Math.hypot(points[o + 3] - points[o], points[o + 4] - points[o + 1], points[o + 5] - points[o + 2]);
      const every = Math.max(2, Math.round((width * 22) / Math.max(len, 1e-3)));
      if (((j % every) + every) % every) continue;
      const f = F[i * FRAME + 6];
      const grow = Math.min(1, (count - 2 - i) / 3);
      const size = width * 2.9 * grow * (0.6 + 0.4 * f);
      const turn = hash(j, 21) * 1.571 + (1 - f) * 1.4;
      for (let leaf = 0; leaf < 4; leaf++) this.mark(points, i, 0, 0, 0, 0, turn + leaf * 1.5708, LEAF, size, size, 0, 1.4 * Math.min(1, f * 2.2));
    }
  }

  clear(): void {
    this.geo.setDrawRange(0, 0);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// Mark outlines as (u, v) corners, u along the length (see Trail.mark).
/** A seed: a slim diamond, half its length either way. */
const KITE = [-0.5, 0, 0, -1, 0, 1, 0.5, 0];
/** A petal, two quads: a point at the base, widest past the middle, a blunt tip. */
const PETAL = [-0.5, 0, 0.05, -0.9, 0.05, 0.9, 0.38, -0.62, 0.38, -0.62, 0.5, -0.08, 0.05, 0.9, 0.38, 0.62];
/** One heart-shaped clover leaf from the centre out, a quad a side: base, the lobe's shoulder, the notch, the lobe's top. */
const LEAF = [0, 0, 0.6, -0.48, 0.8, 0, 0.98, -0.36, 0, 0, 0.8, 0, 0.6, 0.48, 0.98, 0.36];
