// Guns outside the viewmodel: the world / dropped models (weapon_* items on the floor, a dropped gun) and the bunny's
// third-person gun. Same builders as first person (guns/models/*) at the third-person detail (k.view "tp": fewer
// segments), one rigid geometry per gun, cached; the player materials (no lights in the scene, self-lit like the bunny).
//
//   world:  const floor = new FloorGuns(); scene.add(floor.root);
//           floor.update(floorWeapons(core)) when weaponReport(core).floorChanged (and after a restart / seek): the
//           core's items (core.ts FLOOR_STRIDE floats each) where they rest, no allocation per call (GunPresenter does
//           this for the live game, viewer.ts for replays);
//           or floor.sync([{ key, weapon, origin, yaw }]) / FloorGuns.fromEntities(core.entities()) without a core
//   bunny:  PlayerModel.setGun(id) (player/bunny/model.ts, guns/meshes.ts bunnyGunGeometry: rides the right hand, the
//           knife hides while a gun is out)

import * as THREE from "three";
import { playerUniforms, solidMaterial } from "../../player/materials";
import { FLOOR_PRESENT, FLOOR_STRIDE, WEAPON_IDS } from "../../core";
import { worldGunGeometry } from "./meshes";
import { gunById } from "./index";
import type { GunDef } from "./types";

let worldMat: THREE.Material | null = null;

/** The shared material of world guns (the solid player material; accent = carrot orange; no near fade). */
export function worldGunMaterial(): THREE.Material {
  if (worldMat) return worldMat;
  const u = playerUniforms();
  u.uAccent.value.set(0xff7a1a);
  u.uNearFade.value.set(0, 0);
  return (worldMat = solidMaterial(u));
}

/**
 * Lays a world gun mesh on its side on the floor at `origin` (Source units), turned to `yaw` (degrees), the way a dropped
 * CS:S weapon settles: rotated a quarter turn about its barrel onto its right side, lifted by its half width so it rests on the floor.
 */
export function restOnFloor(m: THREE.Object3D, def: GunDef, origin: ArrayLike<number>, yaw: number): void {
  placeOnFloor(m, def, origin[0], origin[1], origin[2], yaw);
}

const lifts = new WeakMap<GunDef, number>();

function placeOnFloor(m: THREE.Object3D, def: GunDef, x: number, y: number, z: number, yaw: number): void {
  let lift = lifts.get(def);
  if (lift === undefined) {
    const g = worldGunGeometry(def);
    if (!g.boundingBox) g.computeBoundingBox();
    lifts.set(def, (lift = -(g.boundingBox?.min.y ?? -0.6)));
  }
  m.position.set(x, y, z + lift);
  // On its right side: the left flank (the side a right-handed player sees in first person) faces up.
  m.rotation.set(Math.PI / 2, 0, (yaw * Math.PI) / 180, "ZXY");
}

export interface FloorGun {
  /** Stable key (entity index, or anything unique per item). */
  key: number | string;
  /** Core weapon id string ("glock") or a stand-in id. */
  weapon: string;
  /** Source units (z up), the item's origin. */
  origin: ArrayLike<number>;
  /** Degrees. */
  yaw: number;
}

/**
 * Weapons lying in the world (Source space root, like render.ts / effects.ts). Items rest on their side the way CS:S
 * weapons settle, with a slow glint-free idle: nothing moves, so no per-frame cost beyond the draw. Meshes are pooled
 * per gun (a respawned item reuses its mesh).
 */
export class FloorGuns {
  readonly root = new THREE.Group();
  private live = new Map<number | string, THREE.Mesh>();
  private spare = new Map<string, THREE.Mesh[]>();
  /** update(): the mesh of each core item slot (null while the item isn't in the world). */
  private slots: (THREE.Mesh | null)[] = [];

  constructor() {
    this.root.name = "floor-guns";
    this.root.rotation.x = -Math.PI / 2;
  }

  /** The items on the floor now (adds the new ones, removes the gone ones). */
  sync(items: readonly FloorGun[]): void {
    const seen = new Set<number | string>();
    for (const it of items) {
      const def = gunById(it.weapon);
      if (!def) continue;
      seen.add(it.key);
      let m = this.live.get(it.key);
      if (!m || m.userData.gun !== def.id) {
        if (m) this.release(m);
        m = this.take(def);
        this.live.set(it.key, m);
      }
      restOnFloor(m, def, it.origin, it.yaw);
    }
    for (const [k, m] of this.live)
      if (!seen.has(k)) {
        this.release(m);
        this.live.delete(k);
      }
  }

  /**
   * The core's floor items (core.ts floorWeapons: FLOOR_STRIDE floats per item, a fixed count per map): shows the ones in
   * the world where they rest, hides the others. Call it when the weapon report says the floor changed, and after a
   * restart or seek (every item is placed again then). No allocation once each item's mesh exists.
   */
  update(v: ArrayLike<number>): void {
    const n = Math.floor(v.length / FLOOR_STRIDE);
    for (let k = n; k < this.slots.length; k++) this.free(k);
    for (let k = 0; k < n; k++) {
      const o = k * FLOOR_STRIDE;
      const def = v[o + 2] & FLOOR_PRESENT ? gunById(WEAPON_IDS[v[o + 1]]) : undefined;
      if (!def) {
        this.free(k);
        continue;
      }
      let m = this.slots[k] ?? null;
      if (m && m.userData.gun !== def.id) {
        this.release(m);
        m = null;
      }
      if (!m) this.slots[k] = m = this.take(def);
      placeOnFloor(m, def, v[o + 3], v[o + 4], v[o + 5], v[o + 7]);
    }
  }

  private free(k: number): void {
    const m = this.slots[k];
    if (m) {
      this.release(m);
      this.slots[k] = null;
    }
  }

  /** Weapon items of the map's entity lump that exist from the start (not point_template-owned). Best effort. */
  static fromEntities(ents: readonly Record<string, string>[]): FloorGun[] {
    const templated = new Set<string>();
    for (const e of ents) if (e.classname === "point_template") for (const [k, v] of Object.entries(e)) if (/^template\d+$/i.test(k)) templated.add(v.toLowerCase());
    const out: FloorGun[] = [];
    ents.forEach((e, i) => {
      const m = /^weapon_(\w+)$/.exec(e.classname ?? "");
      if (!m || m[1] === "knife") return;
      if (e.targetname && templated.has(e.targetname.toLowerCase())) return;
      const o = (e.origin ?? "0 0 0").split(/\s+/).map(Number);
      const yaw = Number((e.angles ?? "0 0 0").split(/\s+/)[1] ?? 0);
      out.push({ key: i, weapon: m[1], origin: o, yaw });
    });
    return out;
  }

  private take(def: GunDef): THREE.Mesh {
    const list = this.spare.get(def.id);
    const m = list?.pop() ?? new THREE.Mesh(worldGunGeometry(def), worldGunMaterial());
    m.userData.gun = def.id;
    this.root.add(m);
    return m;
  }

  private release(m: THREE.Mesh): void {
    m.removeFromParent();
    const id = m.userData.gun as string;
    let list = this.spare.get(id);
    if (!list) this.spare.set(id, (list = []));
    list.push(m);
  }

  clear(): void {
    for (const m of this.live.values()) this.release(m);
    this.live.clear();
    for (let k = 0; k < this.slots.length; k++) this.free(k);
  }
}

export { bunnyGunGeometry, worldGunGeometry } from "./meshes";
