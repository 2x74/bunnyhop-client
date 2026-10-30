// The bunny's gun effects in third person: a short muzzle flash at the gun's real muzzle (the silencer's tip when it's
// on) and spent cases thrown from the ejection port. The first-person flash texture / quads and casings, shared
// (viewmodel/guns/fx.ts gunFxAssets). Per bunny one flash mesh, hidden unless a shot is fresh. The cases of every bunny
// live in two shared instanced meshes (brass, shotgun hulls) in world space, one draw each however many players fire:
// a bunny owns three slots, writes its cases' matrices as it updates, and they fall with gravity where they were thrown
// (a bhopping shooter leaves them behind). Potato: the flash only.

import * as THREE from "three";
import { gunFxAssets } from "../../viewmodel/guns/fx";

const FLASH_LIFE = 0.06;
const SHELL_LIFE = 0.6;
const GRAVITY = 800;
/** Case slots in the shared pools (per pool); a bunny takes PER_BUNNY of them on its first shot. */
const SLOTS = 96;
const PER_BUNNY = 3;

let flashMat: THREE.MeshBasicMaterial | null = null;
const flashMaterial = () =>
  (flashMat ??= new THREE.MeshBasicMaterial({ map: gunFxAssets().tex, color: 0xffd9a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/** The shared case pools, in the scene the first shooter is in. */
class CasePool {
  readonly meshes: THREE.InstancedMesh[];
  private free: number[] = [];
  constructor() {
    const a = gunFxAssets();
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.meshes = [a.brass, a.shotgun].map((g) => {
      const m = new THREE.InstancedMesh(g, mat, SLOTS);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.name = "bunny-gun-cases";
      for (let i = 0; i < SLOTS; i++) m.setMatrixAt(i, ZERO);
      m.count = 0;
      return m;
    });
    for (let i = SLOTS - PER_BUNNY; i >= 0; i -= PER_BUNNY) this.free.push(i);
  }
  /** Adds the pools to `scene` (once; moved if the first scene went away). */
  attach(scene: THREE.Object3D): void {
    for (const m of this.meshes) if (m.parent !== scene) scene.add(m);
  }
  take(): number {
    return this.free.pop() ?? -1;
  }
  give(slot: number): void {
    for (const m of this.meshes) for (let k = 0; k < PER_BUNNY; k++) m.setMatrixAt(slot + k, ZERO);
    this.touch();
    this.free.push(slot);
  }
  set(pool: number, slot: number, m: THREE.Matrix4): void {
    const mesh = this.meshes[pool];
    mesh.setMatrixAt(slot, m);
    if (slot + 1 > mesh.count) mesh.count = slot + 1;
    mesh.instanceMatrix.needsUpdate = true;
  }
  clear(pool: number, slot: number): void {
    this.meshes[pool].setMatrixAt(slot, ZERO);
    this.meshes[pool].instanceMatrix.needsUpdate = true;
  }
  private touch(): void {
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
  }
}
let pool: CasePool | null = null;

interface Case {
  age: number;
  pool: number;
  p: THREE.Vector3;
  v: THREE.Vector3;
  w: THREE.Vector3;
  q: THREE.Quaternion;
}

const _m = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

export class BunnyGunFx {
  private flash: THREE.Mesh;
  private flashAge = Infinity;
  private flashSize = 1;
  private flashRoll = 0;
  private slot = -1;
  private cases: Case[] = Array.from({ length: PER_BUNNY }, () => ({ age: SHELL_LIFE, pool: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), w: new THREE.Vector3(), q: new THREE.Quaternion() }));
  private next = 0;

  /** `model`: Source model space (the bunny's yaw group), where the flash sits and the shots are given in. */
  constructor(private model: THREE.Object3D) {
    this.flash = new THREE.Mesh(gunFxAssets().flash, flashMaterial());
    this.flash.matrixAutoUpdate = false;
    this.flash.frustumCulled = false;
    this.flash.visible = false;
    this.flash.renderOrder = 60;
    model.add(this.flash);
  }

  /**
   * A shot: the flash at `muzzle` along `barrel` (model space), sized `size`; a case from `port` thrown along `dir`
   * (model space), unless `still`. `shotgun`: the red hull.
   */
  shot(muzzle: ArrayLike<number>, barrel: ArrayLike<number>, size: number, port: ArrayLike<number>, dir: ArrayLike<number>, shotgun: boolean, still: boolean): void {
    this.flashAge = 0;
    this.flashSize = size * (0.85 + Math.random() * 0.3);
    this.flashRoll = Math.random() * Math.PI * 2;
    this.placeFlash(muzzle, barrel, 1);
    if (still) return;
    // The scene this bunny is drawn in (the pools live there, in world space).
    let scene: THREE.Object3D = this.model;
    while (scene.parent) scene = scene.parent;
    if (!(scene as THREE.Scene).isScene) return;
    pool ??= new CasePool();
    pool.attach(scene);
    if (this.slot < 0 && (this.slot = pool.take()) < 0) return;
    const c = this.cases[this.next];
    if (c.age < SHELL_LIFE) pool.clear(c.pool, this.slot + this.next);
    c.pool = shotgun ? 1 : 0;
    this.model.updateWorldMatrix(true, false);
    const W = this.model.matrixWorld;
    c.p.set(port[0], port[1], port[2]).applyMatrix4(W);
    _x.set(dir[0], dir[1], dir[2]).transformDirection(W);
    c.v.copy(_x).multiplyScalar(110 * (0.85 + Math.random() * 0.3));
    c.v.y += 45 + Math.random() * 25;
    c.w.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, 18 + Math.random() * 14);
    c.q.setFromUnitVectors(_y.set(1, 0, 0), _x);
    c.age = 0;
    this.next = (this.next + 1) % PER_BUNNY;
  }

  /** Ages the flash (placed again at the muzzle while it shows) and flies this bunny's cases (world space, y up). */
  update(dt: number, muzzle: ArrayLike<number>, barrel: ArrayLike<number>): void {
    this.flashAge += dt;
    if (this.flashAge < FLASH_LIFE) this.placeFlash(muzzle, barrel, 1 - this.flashAge / FLASH_LIFE);
    else this.flash.visible = false;
    if (this.slot < 0 || !pool) return;
    for (let k = 0; k < PER_BUNNY; k++) {
      const c = this.cases[k];
      if (c.age >= SHELL_LIFE) continue;
      c.age += dt;
      if (c.age >= SHELL_LIFE) {
        pool.clear(c.pool, this.slot + k);
        continue;
      }
      c.v.y -= GRAVITY * dt;
      c.p.addScaledVector(c.v, dt);
      _e.set(c.w.x * dt, c.w.y * dt, c.w.z * dt);
      c.q.multiply(_q.setFromEuler(_e));
      const s = 1.6 * (c.age > SHELL_LIFE - 0.12 ? (SHELL_LIFE - c.age) / 0.12 : 1);
      pool.set(c.pool, this.slot + k, _m.compose(c.p, c.q, _z.setScalar(s)));
    }
  }

  private placeFlash(muzzle: ArrayLike<number>, barrel: ArrayLike<number>, k: number): void {
    _x.set(barrel[0], barrel[1], barrel[2]).normalize();
    _z.set(0, 0, 1);
    _y.crossVectors(_z, _x);
    if (_y.lengthSq() < 1e-6) _y.set(0, 1, 0);
    _y.normalize();
    _z.crossVectors(_x, _y);
    _m.makeBasis(_x, _y, _z).setPosition(muzzle[0], muzzle[1], muzzle[2]);
    const sz = this.flashSize * (0.75 + 0.45 * k);
    this.flash.matrix.copy(_m).multiply(_r.makeRotationX(this.flashRoll)).multiply(_r.makeScale(sz, sz, sz));
    this.flash.matrixWorldNeedsUpdate = true;
    this.flash.visible = true;
  }

  /** Hides the flash and this bunny's cases (gun put away, snaps). */
  clear(): void {
    this.flashAge = Infinity;
    this.flash.visible = false;
    for (let k = 0; k < PER_BUNNY; k++) {
      const c = this.cases[k];
      if (c.age < SHELL_LIFE && pool && this.slot >= 0) pool.clear(c.pool, this.slot + k);
      c.age = SHELL_LIFE;
    }
  }

  dispose(): void {
    this.clear();
    this.flash.removeFromParent();
    if (pool && this.slot >= 0) pool.give(this.slot);
    this.slot = -1;
  }
}
