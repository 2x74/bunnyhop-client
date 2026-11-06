// The landing spot's look (landing/index.ts decides when it shows): a little translucent half circle (a low dome) on the
// spot where the path ends, with a soft ring where it meets the ground, and optionally the path there as a faint dotted
// arc. A path that ends in a teleport or reset volume shows in the palette's loss colour with a cross on the ground.
// The flat variant ("flat": a ring and a faint disc on the ground, no dome) is kept for comparison (dev hook
// __landing.setShape).
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
/** The spot's radius, units: a touch inside the hull's footprint (28 across). */
export const SPOT_RADIUS = 14;
/** The dome's height, units: a squashed half circle, low enough not to hide the surface. */
export const DOME_HEIGHT = 9;
/** Dome alpha at its rim and at its top (a soft bubble: the edge reads, the middle shows the surface through it). */
const DOME_RIM_ALPHA = 0.42;
const DOME_TOP_ALPHA = 0.08;
/** The flat variant's disc. */
const DISC_ALPHA = 0.16;
/** Segments around the circle. */
const SEGMENTS = 48;

export type LandingShape = "dome" | "flat";

/**
 * A squashed hemisphere of `radius` and `height` on z = 0, as triangles (x, y, z per vertex) with an alpha per vertex
 * fading from `rimAlpha` at the ground to `topAlpha` at the top. `rings` bands up, `segments` around.
 */
export function domeGeometry(radius: number, height: number, rings = 6, segments = SEGMENTS, rimAlpha = DOME_RIM_ALPHA, topAlpha = DOME_TOP_ALPHA): { positions: Float32Array; alpha: Float32Array } {
  const pos: number[] = [];
  const alpha: number[] = [];
  const at = (ring: number, seg: number) => {
    const phi = (ring / rings) * (Math.PI / 2);
    const theta = (seg / segments) * Math.PI * 2;
    const r = radius * Math.cos(phi);
    return { x: r * Math.cos(theta), y: r * Math.sin(theta), z: height * Math.sin(phi), a: rimAlpha + (topAlpha - rimAlpha) * Math.sin(phi) };
  };
  for (let ring = 0; ring < rings; ring++) {
    for (let seg = 0; seg < segments; seg++) {
      const q = [at(ring, seg), at(ring, seg + 1), at(ring + 1, seg + 1), at(ring + 1, seg)];
      for (const v of [q[0], q[1], q[2], q[0], q[2], q[3]]) {
        pos.push(v.x, v.y, v.z);
        alpha.push(v.a);
      }
    }
  }
  return { positions: new Float32Array(pos), alpha: new Float32Array(alpha) };
}

/** A circle of `radius` at height `z` as line segment pairs (x, y, z, x, y, z per segment). */
export function ringSegments(radius: number, z: number, segments = SEGMENTS): number[] {
  const out: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const b = ((i + 1) / segments) * Math.PI * 2;
    out.push(radius * Math.cos(a), radius * Math.sin(a), z, radius * Math.cos(b), radius * Math.sin(b), z);
  }
  return out;
}

/** The spot is never drawn smaller than this on screen, CSS px across (far landings stay readable). */
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
 * How much to scale the marker so the spot stays at least `MIN_PX` across: 1 when it's that big already.
 * `pxPerUnit`: CSS px per unit at distance 1 (viewport height / (2 tan(fov / 2))).
 */
export function minSizeScale(distance: number, pxPerUnit: number): number {
  const px = (2 * SPOT_RADIUS * pxPerUnit) / Math.max(1, distance);
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
  private readonly dome: THREE.Mesh;
  private readonly disc: THREE.Mesh;
  private readonly ring: LineSegments2;
  private readonly cross: LineSegments2;
  private readonly dots: THREE.Points;
  private readonly dotPositions = new Float32Array(ARC_DOTS * 3);
  private readonly colors = { spot: new THREE.Color(), fail: new THREE.Color() };
  private readonly up = new THREE.Vector3(0, 0, 1);
  private readonly normal = new THREE.Vector3();
  private shape: LandingShape = "dome";

  constructor() {
    this.root.name = "landing-spot";
    this.root.rotation.x = -Math.PI / 2;
    this.root.visible = false;
    const r = SPOT_RADIUS;
    // Dome: RGBA vertex colours (white, alpha fading up) times the material colour; front faces only, so the far side
    // doesn't double up through the near one.
    const d = domeGeometry(r, DOME_HEIGHT);
    const rgba = new Float32Array((d.alpha.length) * 4);
    d.alpha.forEach((a, i) => rgba.set([1, 1, 1, a], i * 4));
    const domeGeo = new THREE.BufferGeometry();
    domeGeo.setAttribute("position", new THREE.BufferAttribute(d.positions, 3));
    domeGeo.setAttribute("color", new THREE.BufferAttribute(rgba, 4));
    this.dome = this.add(this.spot, new THREE.Mesh(domeGeo, this.basic({ vertexColors: true, side: THREE.FrontSide })));
    this.disc = this.add(this.spot, new THREE.Mesh(new THREE.CircleGeometry(r, SEGMENTS), this.basic({ opacity: DISC_ALPHA })));
    this.disc.position.z = 0.25;
    this.ring = this.add(this.spot, this.lines(ringSegments(r, 0.5), 2, 0.75));
    const x = r * 0.55;
    this.cross = this.add(this.spot, this.lines([-x, -x, 0.6, x, x, 0.6, -x, x, 0.6, x, -x, 0.6], 2, 0.95));
    const dotGeo = new THREE.BufferGeometry();
    dotGeo.setAttribute("position", new THREE.BufferAttribute(this.dotPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.dots = this.add(
      this.root,
      new THREE.Points(dotGeo, new THREE.PointsMaterial({ size: 3, sizeAttenuation: true, map: dotTexture(), alphaTest: 0.5, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false, fog: false })),
    );
    this.root.add(this.spot);
  }

  /** The half circle (default) or the flat ring and disc. */
  setShape(shape: LandingShape): void {
    this.shape = shape;
  }

  private basic(o: THREE.MeshBasicMaterialParameters): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, fog: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, ...o });
  }

  private lines(positions: number[], width: number, opacity: number): LineSegments2 {
    const m = new LineMaterial({ linewidth: width, transparent: true, opacity, depthWrite: false, toneMapped: false });
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
   * Shows the spot at feet origin `at` on a surface with normal `normal` (`fail`: the path enters a teleport there; the
   * cross on the ground), `scale` times its size, and the arc's first `dots` points from `arc` (null: no arc).
   */
  show(at: ArrayLike<number>, normal: ArrayLike<number>, fail: boolean, scale: number, arc: Float32Array | null, dots: number): void {
    this.root.visible = true;
    const color = fail ? this.colors.fail : this.colors.spot;
    for (const o of [this.dome, this.disc]) (o.material as THREE.MeshBasicMaterial).color.copy(color);
    for (const o of [this.ring, this.cross]) o.material.color.copy(color);
    (this.dots.material as THREE.PointsMaterial).color.copy(color);
    this.dome.visible = this.shape === "dome";
    this.disc.visible = this.shape === "flat";
    this.cross.visible = fail;
    // On a ramp the hull touches with its uphill edge: the spot lies on the surface under its centre.
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
