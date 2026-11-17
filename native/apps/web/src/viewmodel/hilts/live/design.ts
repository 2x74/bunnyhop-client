// The shape of a living hilt design (live/designs/*.ts) and the per-frame helpers it drives its pieces with.

import * as THREE from "three";
import type { V3 } from "../../../player/bunny/rig";
import { vmRig } from "../../rig";
import type { KnifeDef } from "../../knives/types";
import type { HiltAnchors } from "./anchors";
import type { LiveKit } from "./kit";
import type { LiveUniforms } from "./material";
import type { PlaySignals } from "./state";

/** The camera as seen from the knife (knife-local): its position, and its right and up directions. */
export interface CameraInKnife {
  pos: V3;
  right: V3;
  up: V3;
}

export interface LiveDesign {
  /** The hilt item id (progression.ts). */
  id: string;
  /** Emits the design's pieces on this knife (knife-local, through the kit), at its anchors. */
  build(kit: LiveKit, a: HiltAnchors, knife: KnifeDef): void;
  /** Per frame (after the play signals update): pieces, morphs, light. With s.still, the still lit pose. */
  animate(s: PlaySignals, c: PieceCtx, dt: number): void;
  /** Just before drawing: where the camera is from the knife (the eye looks at you). */
  look?(cam: CameraInKnife, c: PieceCtx): void;
  /** The bone the design's look() is measured on (default Knife_Handle). */
  lookBone?: (knife: KnifeDef) => string | undefined;
}

const R = new THREE.Matrix4(), T = new THREE.Matrix4(), S = new THREE.Matrix4(), A = new THREE.Vector3();

/** Per-frame helpers over a design's uniforms (knife-local in, bind space out). */
export class PieceCtx {
  readonly K = new THREE.Matrix4();
  readonly Kinv = new THREE.Matrix4();
  /** Design-private state per viewmodel (springs, phases). */
  readonly mem: Record<string, number> = {};
  constructor(
    readonly u: LiveUniforms,
    public a: HiltAnchors,
    public knife: KnifeDef,
    local = false,
  ) {
    const r = vmRig(), kb = r.bone("Knife_Handle"), B = r.bind;
    const o = kb * 12;
    if (!local) this.K.set(B[o], B[o + 1], B[o + 2], B[o + 3], B[o + 4], B[o + 5], B[o + 6], B[o + 7], B[o + 8], B[o + 9], B[o + 10], B[o + 11], 0, 0, 0, 1);
    this.Kinv.copy(this.K).invert();
  }

  /** Piece i: turned by `angle` (radians) about the knife-local axis through `pivot`, scaled by s about it, then moved by `move`. */
  piece(i: number, pivot: V3, axis: V3, angle: number, s = 1, move: V3 = [0, 0, 0]): void {
    A.set(axis[0], axis[1], axis[2]).normalize();
    R.makeRotationAxis(A, angle);
    if (s !== 1) R.multiply(S.makeScale(s, s, s));
    T.makeTranslation(pivot[0] + move[0], pivot[1] + move[1], pivot[2] + move[2]);
    const m = this.u.uPiece.value[i];
    m.copy(this.K).multiply(T).multiply(R).multiply(T.makeTranslation(-pivot[0], -pivot[1], -pivot[2])).multiply(this.Kinv);
  }
  /** Piece i: turned about axis1 by a1, then about axis2 by a2 (both through `pivot`, knife-local). */
  piece2(i: number, pivot: V3, axis1: V3, a1: number, axis2: V3, a2: number): void {
    A.set(axis2[0], axis2[1], axis2[2]).normalize();
    R.makeRotationAxis(A, a2);
    A.set(axis1[0], axis1[1], axis1[2]).normalize();
    R.multiply(S.makeRotationAxis(A, a1));
    T.makeTranslation(pivot[0], pivot[1], pivot[2]);
    const m = this.u.uPiece.value[i];
    m.copy(this.K).multiply(T).multiply(R).multiply(T.makeTranslation(-pivot[0], -pivot[1], -pivot[2])).multiply(this.Kinv);
  }
  /** Piece i back at rest. */
  rest(i: number): void {
    this.u.uPiece.value[i].identity();
  }
  morph(i: number, w: number): void {
    this.u.uMorph.value[i] = w;
  }
  /** Channel i's light: a colour (hex, or rgb 0..1+) and intensity. */
  chan(i: number, color: number | [number, number, number], k: number): void {
    const v = this.u.uChan.value[i];
    if (typeof color === "number") v.set(((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255, k);
    else v.set(color[0], color[1], color[2], k);
  }
  live(i: number, x: number, y: number, z: number, w: number): void {
    this.u.uLive.value[i].set(x, y, z, w);
  }
}

/** Critically damped approach of a value toward a target (exact per dt). */
export const approach = (v: number, target: number, rate: number, dt: number) => v + (target - v) * (1 - Math.exp(-rate * dt));

/** A damped spring (x, v) stepped in fixed 1/240 s steps, so any frame rate gives the same motion. */
export function spring(m: Record<string, number>, key: string, target: number, hz: number, zeta: number, dt: number): number {
  let x = m[key] ?? target, v = m[key + "v"] ?? 0, acc = (m[key + "a"] ?? 0) + dt;
  const h = 1 / 240, w = 2 * Math.PI * hz;
  while (acc >= h) {
    v += (w * w * (target - x) - 2 * zeta * w * v) * h;
    x += v * h;
    acc -= h;
  }
  m[key] = x;
  m[key + "v"] = v;
  m[key + "a"] = acc;
  return x;
}
/** Kick a spring's velocity. */
export function kick(m: Record<string, number>, key: string, dv: number): void {
  m[key + "v"] = (m[key + "v"] ?? 0) + dv;
}
