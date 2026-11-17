// The charm on a first-person weapon (v0.0.43): its mesh (meshes.ts) on a little skeleton of its own, posed every frame
// from the chain (physics.ts) and the ring's place on the weapon (anchors.ts for the knives). One SkinnedMesh, one draw
// call, drawn in the weapon's own material (setMaterial), so it is lit and shaded exactly like the knife's hardware.
//
// The owner (viewmodel.ts) calls, per frame:
//   update(dt, input, pose, clock)   pose: the ring's bone in the eye's frame (3x4, row-major), the ring's point on it,
//                                    the colliders in the eye's frame; clock: the viewmodel's (idle life)
//   draw(eyeToWorld)                 the eye's frame -> world (camera * conv), before the scene renders
// and reset() when the view jumps without moving (a replay seek, an export's start).

import * as THREE from "three";
import type { CosmeticLoadout } from "../../loadout";
import { CHARM_LENGTH, CHARM_SIZE, CHARM_SWING } from "../../progression";
import { BOTTOM_RISE, TOP_DROP, mountKey } from "./hardware";
import { CB, CHARM_BONES, CHARM_SCALE, CORD_LENGTH, charmDef, charmGeometry, charmMetrics, type CharmDef, type CharmLife, type MountSpec } from "./meshes";
import { CharmChain, tuneOf, type CloudInput, type Collider, type V3 } from "./physics";

class DirectSkeleton extends THREE.Skeleton {
  constructor(n: number) {
    super(Array.from({ length: n }, () => new THREE.Bone()), Array.from({ length: n }, () => new THREE.Matrix4()));
  }
  override update(): void {
    if (this.boneTexture) this.boneTexture.needsUpdate = true;
  }
}

export { CHARM_SCALE, CORD_LENGTH };

/**
 * The cord's length (units, knot to the charm's loop) for the Cord option (50 .. 200%): CORD_LENGTH at 100%, growing a
 * little slower than the number, so the longest still hangs in view on every knife.
 */
export const cordOf = (percent: number): number => CORD_LENGTH * Math.pow(percent / 100, 0.8);

/** What a charm needs from its owner each frame. */
export interface CharmPose {
  /** The mount's bone in the eye's frame (3x4 row-major), and the pin (the mount's eye) in that bone's frame. */
  bone: ArrayLike<number>;
  at: V3;
  colliders: readonly Collider[];
  clouds?: readonly CloudInput[];
}

export interface CharmInput {
  velocity: ArrayLike<number>;
  yaw: number;
  pitch: number;
}

/** A charm's options with their defaults filled in (CosmeticLoadout.charm*). */
export function charmOptions(l: CosmeticLoadout | null | undefined): { length: number; size: number; swing: number; pommel: boolean } {
  return { length: l?.charmLength ?? CHARM_LENGTH.default, size: l?.charmSize ?? CHARM_SIZE.default, swing: l?.charmSwing ?? CHARM_SWING.default, pommel: !!l?.charmPommel };
}

export class CharmRig {
  readonly chain = new CharmChain();
  readonly root = new THREE.Group();
  private mesh: THREE.SkinnedMesh | null = null;
  private skeleton = new DirectSkeleton(CHARM_BONES);
  private def: CharmDef | null = null;
  private size = 1;
  /** The pommel instead of the guard (CosmeticLoadout.charmPommel). */
  pommel = false;
  private mount: MountSpec | null = null;
  /**
   * The least swing limit (rad): tied to a knife, a charm at rest leans on the fist, and the limit must not hold it
   * inside the hand (knife.ts sets it; 0 for a charm on its own).
   */
  minCone = 0;
  /** The part's lag (life "lag"): a lagged down vector and its rate (eye space). */
  private lag = new Float64Array(6);
  private lagOn = false;
  /** Bone matrices (eye space, column-major 4x4) of the last update. */
  private bm = new Float32Array(CHARM_BONES * 16);

  constructor(parent: THREE.Object3D) {
    this.root.matrixAutoUpdate = false;
    this.root.visible = false;
    parent.add(this.root);
  }

  get worn(): CharmDef | null {
    return this.def;
  }

  /** The loadout's charm and options; null / no charm hides it. */
  set(l: CosmeticLoadout | null | undefined): void {
    const def = charmDef(l?.charm);
    const o = charmOptions(l);
    if (def !== this.def) {
      this.def = def;
      this.chain.clear();
      this.lagOn = false;
    }
    if (!def) {
      this.mesh?.removeFromParent();
      this.mesh = null;
      return (this.root.visible = false), undefined;
    }
    const size = (o.size / 100) * CHARM_SCALE;
    const mt = charmMetrics(def);
    const shape = { cord: cordOf(o.length), link: mt.link * size, radius: mt.radius * size, balls: mt.balls.map((b) => ({ t: b.d / mt.link, r: b.r * size })) };
    if (shape.cord !== this.chain.shape.cord || shape.link !== this.chain.shape.link || o.pommel !== this.pommel) this.chain.clear();
    this.chain.shape = shape;
    this.chain.tune = tuneOf(o.swing);
    if (this.chain.tune.cone < this.minCone) this.chain.tune.cone = this.minCone;
    this.size = size;
    this.pommel = o.pommel;
    this.refresh();
  }

  /** How it is tied to the weapon (anchors.ts; null: no wrap drawn, the charm on its own). */
  setMount(m: MountSpec | null): void {
    if (mountKey(m) === mountKey(this.mount)) return;
    this.mount = m;
    this.refresh();
  }

  /** The mesh for the charm, mount and chain length in hand (meshes.ts caches the geometry). */
  private refresh(): void {
    const def = this.def;
    if (!def) return;
    const g = charmGeometry(def, { mount: this.mount });
    if (this.mesh?.geometry === g) return;
    if (this.mesh) {
      this.mesh.geometry = g;
      return;
    }
    const m = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
    m.bindMode = THREE.DetachedBindMode;
    m.bind(this.skeleton, new THREE.Matrix4());
    m.frustumCulled = false;
    m.name = "charm";
    this.root.add(m);
    this.mesh = m;
  }

  /** The weapon's material (the knife's: same lighting and hardware shading). */
  setMaterial(m: THREE.Material): void {
    if (this.mesh && this.mesh.material !== m) this.mesh.material = m;
  }

  /** Back to hanging still at the next update (a seek, an export's start, a knife switch). */
  reset(): void {
    this.chain.clear();
    this.lagOn = false;
  }

  update(dt: number, s: CharmInput, pose: CharmPose, clock: number): void {
    const def = this.def;
    if (!def) return;
    const B = pose.bone, at = pose.at;
    const anchor: V3 = [B[0] * at[0] + B[1] * at[1] + B[2] * at[2] + B[3], B[4] * at[0] + B[5] * at[1] + B[6] * at[2] + B[7], B[8] * at[0] + B[9] * at[1] + B[10] * at[2] + B[11]];
    this.chain.update({ dt, anchor, yaw: s.yaw, pitch: s.pitch, velocity: s.velocity, colliders: pose.colliders, clouds: pose.clouds });
    const o = this.chain.out;
    const p = (i: number): V3 => [o[i * 3], o[i * 3 + 1], o[i * 3 + 2]];
    const bm = this.bm;
    // The wrap: the bone's axes at the pin.
    const bx: V3 = [B[0], B[4], B[8]], by: V3 = [B[1], B[5], B[9]], bz: V3 = [B[2], B[6], B[10]];
    write(bm, CB.mount, bx, by, bz, anchor);
    // The cord: from under the crimp to the charm's ring, by length along knot -> middle -> loop; its two halves
    // stretched along what is left.
    const p0 = p(0), p1 = p(1), p2 = p(2);
    const l1 = dist(p0, p1), l2 = dist(p1, p2), total = l1 + l2;
    const along = (d: number): V3 => (d <= l1 ? lerp(p0, p1, l1 > 1e-6 ? d / l1 : 0) : lerp(p1, p2, l2 > 1e-6 ? Math.min(1, (d - l1) / l2) : 1));
    const d0 = Math.min(total, TOP_DROP), d2 = Math.max(d0, total - BOTTOM_RISE * this.size);
    const q0 = along(d0), qm = along((d0 + d2) / 2), q2 = along(d2);
    for (const [bone, a, b] of [[CB.cord1, q0, qm], [CB.cord2, qm, q2]] as const) {
      let z = sub(b, a);
      if (dot(z, z) < 1e-8) z = scale(norm(sub(p2, p0)) ?? [0, 0, -1], 1e-3);
      const [x, y] = perp(z);
      write(bm, bone, x, y, z, a);
    }
    // The crimp at the knot: turning with the cord's first stretch.
    {
      const up = norm(sub(p0, q0)) ?? norm(sub(p0, p2)) ?? [0, 0, 1];
      const [lx, ly] = perp(up);
      write(bm, CB.link, lx, ly, up, anchor);
    }
    // The charm at its loop: up along its link, its face toward the eye, turned by the twist.
    const loop = p(2), c = p(3);
    let zc = norm(sub(loop, c));
    if (!zc) zc = [0, 0, 1];
    const toEye = norm([-c[0], -c[1], -c[2]]) ?? [-1, 0, 0];
    let yc = norm(sub(scale(zc, dot(toEye, zc)), toEye)) ?? [1, 0, 0];
    const tw = this.chain.twistOut + this.spinAngle(def.life, clock);
    yc = rotate(yc, zc, tw);
    const xc = cross(yc, zc);
    const k = this.size;
    write(bm, CB.body, scale(xc, k), scale(yc, k), scale(zc, k), loop);
    // Its moving part.
    this.life(def.life, dt, clock, xc, yc, zc);
    const dst = this.skeleton.boneMatrices!;
    dst.set(bm);
    this.skeleton.update();
  }

  /** The eye's frame -> world, and whether it shows this frame. */
  draw(eyeToWorld: THREE.Matrix4, visible: boolean): void {
    this.root.visible = visible && !!this.mesh;
    if (!this.root.visible) return;
    this.root.matrix.copy(eyeToWorld);
    this.root.matrixWorldNeedsUpdate = true;
  }

  /** The charm's centre in the eye's frame (framing in the Loadout, tests). */
  get centre(): V3 {
    const o = this.chain.out;
    return [o[9], o[10], o[11]];
  }

  dispose(): void {
    this.mesh?.removeFromParent();
    this.root.removeFromParent();
    this.skeleton.dispose();
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * A turning charm: it faces you, then once every `rate` seconds turns a full turn over `amount` seconds (always facing
   * you between: edge on, a flat charm is a sliver). From the viewmodel's clock, so a replay or an export shows the same.
   */
  private spinAngle(life: CharmLife | undefined, clock: number): number {
    if (life?.kind !== "spin") return 0;
    const u = (clock % life.rate) - (life.rate - life.amount);
    if (u <= 0) return 0;
    const f = u / life.amount;
    return 2 * Math.PI * f * f * (3 - 2 * f);
  }

  private life(life: CharmLife | undefined, dt: number, clock: number, xc: V3, yc: V3, zc: V3): void {
    const bm = this.bm, o = CB.part * 16, b = CB.body * 16;
    // Default: the part rides on the body.
    for (let i = 0; i < 16; i++) bm[o + i] = bm[b + i];
    if (!life || life.kind === "spin") return;
    let axis: V3 = life.axis, ang = 0, sc: V3 = [1, 1, 1];
    const t = clock;
    switch (life.kind) {
      case "lag": {
        // A lagged copy of the charm's down vector (a spring at `rate` Hz): the part swings behind the body, a hanging
        // part (axis pointing down from its pivot) toward where the body was, a standing one (pointing up) the other way.
        const L = this.lag, down = scale(zc, -1);
        if (!this.lagOn || !(dt > 0)) {
          L.set([down[0], down[1], down[2], 0, 0, 0]);
          this.lagOn = true;
        } else {
          const w = 2 * Math.PI * life.rate, n = Math.max(1, Math.ceil(dt / (1 / 240))), h = dt / n;
          for (let s = 0; s < n; s++)
            for (let a = 0; a < 3; a++) {
              L[3 + a] += (w * w * (down[a] - L[a]) - 2 * 0.3 * w * L[3 + a]) * h;
              L[a] += L[3 + a] * h;
            }
        }
        const c = cross(down, [L[0], L[1], L[2]]);
        const m = Math.hypot(c[0], c[1], c[2]);
        if (m < 1e-6) return;
        axis = [dot(c, xc) / m, dot(c, yc) / m, dot(c, zc) / m];
        ang = Math.min(life.amount, 2 * m) * (life.axis[2] > 0 ? -1 : 1);
        break;
      }
      case "flick": {
        const u = (t % life.rate) / 0.4;
        ang = u < 1 ? life.amount * Math.sin(Math.PI * u) * Math.sin(2 * Math.PI * u) : 0;
        break;
      }
      case "beat": {
        const u = t % life.rate;
        const pulse = (c: number, w: number) => Math.exp(-((u - c) * (u - c)) / (w * w));
        const f = 1 + life.amount * (pulse(0.12, 0.06) + 0.6 * pulse(0.34, 0.06));
        sc = [f, f, f];
        break;
      }
      case "blink": {
        const u = t % life.rate;
        const f = u < 0.14 ? Math.max(life.amount, Math.abs(Math.cos((Math.PI * u) / 0.14))) : 1;
        sc = [1, 1, f];
        break;
      }
      case "bob":
      case "rock":
        ang = life.amount * Math.sin(2 * Math.PI * life.rate * t);
        break;
    }
    // part = body * T(at) * R(axis, ang) * S(sc) * T(-at), in charm-local units.
    const M = mul3(rotMat(axis, ang), [sc[0], 0, 0, 0, sc[1], 0, 0, 0, sc[2]]);
    const at: V3 = [life.at[0], life.at[1], life.at[2] + charmMetrics(this.def!).lift];
    const tl: V3 = sub(at, apply3(M, at));
    const BX: V3 = [bm[b], bm[b + 1], bm[b + 2]], BY: V3 = [bm[b + 4], bm[b + 5], bm[b + 6]], BZ: V3 = [bm[b + 8], bm[b + 9], bm[b + 10]], BT: V3 = [bm[b + 12], bm[b + 13], bm[b + 14]];
    const col = (j: number): V3 => add(scale(BX, M[j]), add(scale(BY, M[3 + j]), scale(BZ, M[6 + j])));
    const T = add(BT, add(scale(BX, tl[0]), add(scale(BY, tl[1]), scale(BZ, tl[2]))));
    write(bm, CB.part, col(0), col(1), col(2), T);
  }
}

// ---------------------------------------------------------------------------------------------

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const norm = (a: V3): V3 | null => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};
/** Two unit vectors across `z` (any length). */
function perp(z: V3): [V3, V3] {
  const u = norm(z) ?? [0, 0, 1];
  const ref: V3 = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = norm(cross(ref, u))!;
  return [x, cross(u, x)];
}
/** `v` turned about the unit axis `a` by `t` radians. */
function rotate(v: V3, a: V3, t: number): V3 {
  const c = Math.cos(t), s = Math.sin(t), d = dot(v, a), x = cross(a, v);
  return [v[0] * c + x[0] * s + a[0] * d * (1 - c), v[1] * c + x[1] * s + a[1] * d * (1 - c), v[2] * c + x[2] * s + a[2] * d * (1 - c)];
}
/** Row-major 3x3 rotation about a (charm-local) axis. */
function rotMat(axis: V3, t: number): number[] {
  const a = norm(axis) ?? [0, 0, 1];
  const c = Math.cos(t), s = Math.sin(t), C = 1 - c, [x, y, z] = a;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}
const mul3 = (A: number[], B: number[]): number[] => {
  const o = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return o;
};
const apply3 = (M: number[], v: V3): V3 => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
/** Bone i's column-major 4x4: columns x, y, z and the translation t. */
function write(bm: Float32Array, i: number, x: V3, y: V3, z: V3, t: V3): void {
  const o = i * 16;
  bm[o] = x[0], bm[o + 1] = x[1], bm[o + 2] = x[2], bm[o + 3] = 0;
  bm[o + 4] = y[0], bm[o + 5] = y[1], bm[o + 6] = y[2], bm[o + 7] = 0;
  bm[o + 8] = z[0], bm[o + 9] = z[1], bm[o + 10] = z[2], bm[o + 11] = 0;
  bm[o + 12] = t[0], bm[o + 13] = t[1], bm[o + 14] = t[2], bm[o + 15] = 1;
}
