// The landing spot's look (landing/index.ts decides when it shows): the player hull's footprint where the path ends, a
// short column rising from it that fades out, and optionally the path there as a faint dotted arc. A path that ends in
// a teleport or reset volume shows the footprint with a cross instead, in the palette's loss colour, and no column.
//
// Built in Source units (z up) under a group turned into three's space (x, z, -y), like the trigger overlay. Drawn after
// the world's translucent faces, never writing depth, tested against it (a ledge in front hides it).

import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LANDING_PIECE } from "../core";

/** The player hull's half width (32 x 32 footprint). */
export const HULL_HALF = 16;
/** Column height, units (a third of a standing player). */
const COLUMN = 20;
const COLUMN_ALPHA = 0.32;
const FILL_ALPHA = 0.1;
/** The footprint is never drawn smaller than this on screen, CSS px across (far landings stay readable). */
export const MIN_PX = 14;
/** Most dots the arc draws, and their spacing along the path, units. */
export const ARC_DOTS = 96;
export const ARC_SPACING = 24;
/** No dots this close to the player's feet (they'd sit under the view and on top of the crosshair looking down). */
export const ARC_SKIP = 64;

/**
 * Points along `pieces` (core.ts LANDING_PIECE floats each: start, velocity, acceleration, seconds) every `spacing`
 * units of path, after the first `skip` units, into `out` (x, y, z triples). Returns how many. Each piece's arc is
 * start + v t + a t^2 / 2; the spacing walks it in small time steps.
 */
export function arcPoints(pieces: ArrayLike<number>, count: number, spacing: number, skip: number, out: Float32Array): number {
  const max = Math.floor(out.length / 3);
  let n = 0;
  let travelled = 0;
  let next = skip;
  for (let i = 0; i < count && n < max; i++) {
    const o = i * LANDING_PIECE;
    const px = pieces[o], py = pieces[o + 1], pz = pieces[o + 2];
    const vx = pieces[o + 3], vy = pieces[o + 4], vz = pieces[o + 5];
    const ax = pieces[o + 6], ay = pieces[o + 7], az = pieces[o + 8];
    const seconds = pieces[o + 9];
    const speed = Math.hypot(vx, vy, vz) + Math.hypot(ax, ay, az) * seconds;
    // Steps of a quarter spacing at most (fine enough that the dots look evenly spaced).
    const steps = Math.max(1, Math.min(256, Math.ceil((speed * seconds) / (spacing / 4))));
    const dt = seconds / steps;
    let lx = px, ly = py, lz = pz;
    for (let s = 1; s <= steps && n < max; s++) {
      const t = s * dt;
      const x = px + vx * t + 0.5 * ax * t * t;
      const y = py + vy * t + 0.5 * ay * t * t;
      const z = pz + vz * t + 0.5 * az * t * t;
      travelled += Math.hypot(x - lx, y - ly, z - lz);
      lx = x; ly = y; lz = z;
      if (travelled >= next) {
        out[n * 3] = x; out[n * 3 + 1] = y; out[n * 3 + 2] = z;
        n++;
        next += spacing;
      }
    }
  }
  return n;
}

/**
 * How much to scale the marker so its footprint stays at least `MIN_PX` across: 1 when it's that big already.
 * `pxPerUnit`: CSS px per unit at distance 1 (viewport height / (2 tan(fov / 2))).
 */
export function minSizeScale(distance: number, pxPerUnit: number): number {
  const px = (2 * HULL_HALF * pxPerUnit) / Math.max(1, distance);
  return px >= MIN_PX ? 1 : MIN_PX / px;
}

/** Height of the surface under the footprint's centre above the hull's lowest touching corner, for a landing on a plane with normal `n`. */
export function centreDrop(n: ArrayLike<number>): number {
  return n[2] > 0.01 ? (HULL_HALF * (Math.abs(n[0]) + Math.abs(n[1]))) / n[2] : 0;
}

function dotTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.beginPath();
  g.arc(16, 16, 13, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class LandingMarker {
  readonly root = new THREE.Group();
  private readonly spot = new THREE.Group();
  private readonly column: THREE.Mesh;
  private readonly fill: THREE.Mesh;
  private readonly outline: LineSegments2;
  private readonly cross: LineSegments2;
  private readonly dots: THREE.Points;
  private readonly dotPositions = new Float32Array(ARC_DOTS * 3);
  private readonly colors = { spot: new THREE.Color(), fail: new THREE.Color() };
  private readonly up = new THREE.Vector3(0, 0, 1);
  private readonly normal = new THREE.Vector3();

  constructor() {
    this.root.name = "landing-spot";
    this.root.rotation.x = -Math.PI / 2;
    this.root.visible = false;
    const h = HULL_HALF;
    // Column: four sides, opaque-ish at the floor, gone at the top (RGBA vertex colours times the material colour).
    const sides: number[] = [];
    const rgba: number[] = [];
    const corners = [[-h, -h], [h, -h], [h, h], [-h, h]];
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = corners[i];
      const [bx, by] = corners[(i + 1) % 4];
      sides.push(ax, ay, 0, bx, by, 0, bx, by, COLUMN, ax, ay, 0, bx, by, COLUMN, ax, ay, COLUMN);
      rgba.push(...[COLUMN_ALPHA, COLUMN_ALPHA, 0, COLUMN_ALPHA, 0, 0].flatMap((a) => [1, 1, 1, a]));
    }
    const columnGeo = new THREE.BufferGeometry();
    columnGeo.setAttribute("position", new THREE.Float32BufferAttribute(sides, 3));
    columnGeo.setAttribute("color", new THREE.Float32BufferAttribute(rgba, 4));
    this.column = this.add(this.spot, new THREE.Mesh(columnGeo, this.basic({ vertexColors: true, side: THREE.DoubleSide })));
    const fillGeo = new THREE.PlaneGeometry(2 * h, 2 * h);
    this.fill = this.add(this.spot, new THREE.Mesh(fillGeo, this.basic({ opacity: FILL_ALPHA })));
    this.fill.position.z = 0.25;
    const square = [-h, -h, h, -h, h, h, -h, h];
    const ring: number[] = [];
    for (let i = 0; i < 4; i++) ring.push(square[i * 2], square[i * 2 + 1], 0.5, square[((i + 1) % 4) * 2], square[((i + 1) % 4) * 2 + 1], 0.5);
    this.outline = this.add(this.spot, this.lines(ring, 2));
    const x = h * 0.7;
    this.cross = this.add(this.spot, this.lines([-x, -x, 0.5, x, x, 0.5, -x, x, 0.5, x, -x, 0.5], 2));
    const dotGeo = new THREE.BufferGeometry();
    dotGeo.setAttribute("position", new THREE.BufferAttribute(this.dotPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.dots = this.add(
      this.root,
      new THREE.Points(dotGeo, new THREE.PointsMaterial({ size: 3, sizeAttenuation: true, map: dotTexture(), alphaTest: 0.5, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false, fog: false })),
    );
    this.root.add(this.spot);
  }

  private basic(o: THREE.MeshBasicMaterialParameters): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, fog: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, ...o });
  }

  private lines(positions: number[], width: number): LineSegments2 {
    const m = new LineMaterial({ linewidth: width, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false });
    return new LineSegments2(new LineSegmentsGeometry().setPositions(positions), m);
  }

  private add<T extends THREE.Object3D>(parent: THREE.Object3D, o: T): T {
    o.frustumCulled = false;
    o.renderOrder = 3; // after the world's translucent faces (water, glass), like the trigger overlay
    o.raycast = () => {};
    parent.add(o);
    return o;
  }

  /** The spot's colour (Prefs.landing.color) and the teleport flag's (the palette's loss colour). */
  setColors(spot: string, fail: string): void {
    this.colors.spot.set(spot);
    this.colors.fail.set(fail);
  }

  hide(): void {
    this.root.visible = false;
  }

  /**
   * Shows the spot at feet origin `at` on a surface with normal `normal` (`fail`: the path enters a teleport there;
   * the cross, no column), `scale` times its size, and the arc's first `dots` points from `arc` (null: no arc).
   */
  show(at: ArrayLike<number>, normal: ArrayLike<number>, fail: boolean, scale: number, arc: Float32Array | null, dots: number): void {
    this.root.visible = true;
    const color = fail ? this.colors.fail : this.colors.spot;
    for (const o of [this.column, this.fill]) (o.material as THREE.MeshBasicMaterial).color.copy(color);
    for (const o of [this.outline, this.cross]) o.material.color.copy(color);
    (this.dots.material as THREE.PointsMaterial).color.copy(color);
    this.column.visible = !fail;
    this.fill.visible = !fail;
    this.cross.visible = fail;
    // On a ramp the hull touches with its uphill edge: the footprint lies on the surface under its centre.
    const flat = fail || !(normal[2] > 0.01);
    this.spot.position.set(at[0], at[1], at[2] - (flat ? 0 : centreDrop(normal)));
    if (flat) this.spot.quaternion.identity();
    else this.spot.quaternion.setFromUnitVectors(this.up, this.normal.set(normal[0], normal[1], normal[2]).normalize());
    this.spot.scale.setScalar(scale);
    const n = arc ? Math.min(dots, ARC_DOTS) : 0;
    if (arc && n > 0) this.dotPositions.set(arc.subarray(0, n * 3));
    const geo = this.dots.geometry;
    geo.setDrawRange(0, n);
    (geo.attributes.position as THREE.BufferAttribute).needsUpdate = n > 0;
    this.dots.visible = n > 0;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
  }
}
