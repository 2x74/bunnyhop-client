// The charms' meshes (v0.0.43; progression.ts "charm-*"): small code-made things in the knives' style, modelled with
// the kit (kit.ts) and hung on the shared hardware (hardware.ts), each in one geometry on a skeleton of its own (rig.ts):
//
//   bone 0  the cord's wrap on the knife (posed with the knife: anchors.ts), its knot at the bone's origin
//   bone 1  the cord's upper half, bone 2 its lower half: a unit length along +z, stretched from point to point
//   bone 3  the charm, at its own loop (charm-local: x the viewer's right, y away from the viewer, z up; it hangs
//           below its loop, along -z, its face toward -y), with its bail and the ring through it
//   bone 4  its moving part, if it has one (CharmDef.life), placed relative to bone 3
//   bone 5  the crimp where the cord leaves the knot, turning with the cord
//
// One geometry per charm and wrap (built once, ~1 ms, cached), drawn in the knife's own material
// (rig.ts). Sizes: about 1.5 to 1.8 units from the bail down and at most 1.4 wide (the glove's knuckle is ~1.4),
// 1,300 to 3,000 triangles each with the hardware.

import * as THREE from "three";
import { Builder } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import { BAIL_BOTTOM, bail, cord, link, mount, mountKey, type MountSpec } from "./hardware";
import { CB, CHARM_BONES, CharmCtx } from "./kit";
import { bell } from "./set/bell";
import { bun } from "./set/bun";
import { bune } from "./set/bune";
import { carrot } from "./set/carrot";
import { clover } from "./set/clover";
import { duck } from "./set/duck";
import { frog } from "./set/frog";
import { heart } from "./set/heart";
import { lantern } from "./set/lantern";
import { loaf } from "./set/loaf";
import { moon } from "./set/moon";
import { snail } from "./set/snail";
import { star } from "./set/star";
import { toadstool } from "./set/toadstool";

export { CB, CHARM_BONES, CharmCtx };
export type { MountSpec };

/** A charm's own motion on bone 4 (rig.ts charmLife): what moves, about where (charm-local), and how. */
export interface CharmLife {
  kind: "spin" | "lag" | "flick" | "beat" | "blink" | "bob" | "rock";
  /** Pivot (charm-local) and axis of the moving part. */
  at: V3;
  axis: V3;
  /**
   * Rate (seconds between turns / beats / blinks / flicks; Hz for lag / bob / rock) and size (rad, a scale, or for a
   * spin the seconds one turn takes).
   */
  rate: number;
  amount: number;
}

export interface CharmDef {
  id: string;
  /** The charm's top (charm-local z as built) where the bail's cap sits on it; default: measured (its highest point near x 0). */
  top?: number;
  life?: CharmLife;
  build(c: CharmCtx): void;
}

/** The set, in catalogue order (progression.ts). */
export const CHARMS: readonly CharmDef[] = [carrot, bun, snail, star, moon, heart, loaf, bell, lantern, duck, frog, toadstool, bune, clover];
const BY_ID = new Map(CHARMS.map((c) => [c.id, c]));
export const charmDef = (id: string | null | undefined): CharmDef | null => (id ? (BY_ID.get(id) ?? null) : null);

// ---------------------------------------------------------------------------------------------
// Geometry

/** The cord at 100% (units: the knot on the knife to the charm's loop), and every charm's size at 100% over its built size. */
export const CORD_LENGTH = 1.3;
export const CHARM_SCALE = 1.2;

function measureTop(def: CharmDef): number {
  const b = new Builder();
  def.build(new CharmCtx(b));
  const g = b.geometry();
  const Pt = g.getAttribute("position");
  let top = -Infinity;
  for (let i = 0; i < Pt.count; i++) if (Math.abs(Pt.getX(i)) < 0.12 && Math.abs(Pt.getY(i)) < 0.3) top = Math.max(top, Pt.getZ(i));
  g.dispose();
  return Number.isFinite(top) ? top : BAIL_BOTTOM;
}

/**
 * A charm's measures as built (units, at built size: times CHARM_SCALE and the Size option in the game): `link` from
 * its loop to its middle (the chain's last link, physics.ts ChainShape.link), `radius` round its middle (collisions),
 * `extent` its bounding radius (framing), `hw` how far it reaches toward the knife from its cord (+x: a charm hangs on
 * the knife's left for the right hand, mirrored for the left), `hd` its half depth (y), `top` / `bottom` how far below the loop
 * it starts and ends (ears stand above it: a negative top; the fit: anchors.ts).
 */
export interface CharmMetrics {
  /** How far the build was moved up (charm-local z) to meet the bail: life pivots (CharmLife.at) move with it. */
  lift: number;
  link: number;
  radius: number;
  extent: number;
  hw: number;
  hd: number;
  top: number;
  bottom: number;
  /** The charm as balls down its axis (physics.ts ChainShape.balls): `d` below the loop, `r` the radius (built units). */
  balls: { d: number; r: number }[];
}
const metrics = new Map<string, CharmMetrics>();
const lifts = new Map<string, number>();
export function charmMetrics(def: CharmDef): CharmMetrics {
  let m = metrics.get(def.id);
  if (m) return m;
  const g = charmGeometry(def);
  const Pt = g.getAttribute("position");
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  // (The charm's own vertices: the hardware is emitted first.)
  for (let i = (g.userData.bodyStart as number) ?? 0; i < Pt.count; i++) {
    const v = [Pt.getX(i), Pt.getY(i), Pt.getZ(i)];
    for (let a = 0; a < 3; a++) (lo[a] = Math.min(lo[a], v[a])), (hi[a] = Math.max(hi[a], v[a]));
  }
  const half = [0, 1, 2].map((a) => (hi[a] - lo[a]) / 2);
  // (The collision radius is a little under the charm's half size: a round charm may graze what it rests on.)
  // Balls down its axis: as many as cover its height at about its own width, each as wide as the charm is there.
  const H = hi[2] - lo[2], wide = Math.max(hi[0], -lo[0], hi[1], -lo[1]);
  const nb = Math.max(2, Math.min(4, Math.round(H / (1.3 * wide))));
  const balls: { d: number; r: number }[] = [];
  for (let j = 0; j < nb; j++) {
    const z1 = hi[2] - (H * j) / nb, z0 = hi[2] - (H * (j + 1)) / nb;
    let rr = 0;
    for (let i = (g.userData.bodyStart as number) ?? 0; i < Pt.count; i++) {
      const z = Pt.getZ(i);
      // (Toward the knife and front to back: what it has on its far side, a duck's bill, rests against nothing.)
      if (z <= z1 + 0.02 && z >= z0 - 0.02) rr = Math.max(rr, Pt.getX(i), Math.abs(Pt.getY(i)));
    }
    // (A little proud of the charm: its corners reach past a ball of its width.)
    balls.push({ d: -(z0 + z1) / 2, r: Math.max(rr, (H / nb) * 0.55) + 0.03 });
  }
  m = { balls, lift: lifts.get(def.id) ?? 0, link: -(lo[2] + hi[2]) / 2, radius: 0.7 * Math.max(half[0], half[2]), extent: Math.hypot(half[0], half[1], half[2]), hw: hi[0], hd: Math.max(-lo[1], hi[1]), top: -hi[2], bottom: -lo[2] };
  metrics.set(def.id, m);
  return m;
}

const cache = new Map<string, THREE.BufferGeometry>();
/**
 * A charm's geometry with its hardware (cached per charm and mount): `mount` how it is tied to the knife (null: no wrap
 * drawn, the tiles and the tests).
 */
export function charmGeometry(def: CharmDef, o: { mount?: MountSpec | null } = {}): THREE.BufferGeometry {
  const key = `${def.id}|${mountKey(o.mount ?? null)}`;
  let g = cache.get(key);
  if (g) return g;
  // The charm's top (its highest point near the middle) up to the bail's cap: a scratch build measures it.
  const top = def.top ?? measureTop(def);
  const b = new Builder();
  // (The hardware materials ride in finishUV.z: Builder adds Paint.mat / 16 only while `finish` is set.)
  b.finish = () => [0, 0, 0, 0];
  const c = new CharmCtx(b);
  mount(c, o.mount ?? null);
  link(c);
  cord(c);
  bail(c);
  c.o = [0, 0, BAIL_BOTTOM - top];
  lifts.set(def.id, BAIL_BOTTOM - top);
  const bodyStart = b.vertexCount;
  def.build(c);
  b.finish = null;
  g = b.geometry();
  g.userData.bodyStart = bodyStart;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 64);
  // (A handful at a time: the knife and options in hand, the Loadout's hover previews.)
  if (cache.size > 96) for (const k of cache.keys()) if (cache.size > 64 && !k.includes("|none|")) cache.get(k)!.dispose(), cache.delete(k);
  cache.set(key, g);
  return g;
}

/** Triangles of a charm with its hardware (no wrap; dev stats, tests). */
export const charmTris = (def: CharmDef): number => charmGeometry(def).getAttribute("position").count / 3;
