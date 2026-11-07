// The Loadout's Gun camo stage (ui/loadout-stage.ts hands it the canvas): one of the guns in the camo shown, two ways.
//
//   First person  The real gun viewmodel (viewmodel/guns/viewmodel.ts): your hands in your gloves and colourway holding
//                 the gun, idling as in game, cropped to the gun. Inspect plays the gun's own inspect.
//   Side          The gun alone (first-person detail) on a slow turntable; drag to turn it.
//
// The gun shown steps through the guns maps hand out (prev / next on the stage); which one is remembered for the page.
// Built on first use of the tab only (the knife stage never pays for it).

import * as THREE from "three";
import { camoStyle } from "../camo";
import type { CosmeticLoadout } from "../loadout";
import { playerUniforms } from "../player/materials";
import { NO_LOOK } from "../viewmodel/finishes/shader";
import { GUNS } from "../viewmodel/guns/index";
import { gunMaterial } from "../viewmodel/guns/material";
import { gunModelGeometry } from "../viewmodel/guns/meshes";
import type { GunDef } from "../viewmodel/guns/types";
import { GunViewmodel } from "../viewmodel/guns/viewmodel";
import { warmIfNew } from "../graphics/warm-programs";
import { prefs } from "./settings";

/** The guns the stage steps through: one per model (the M4A1 borrows the Furrow's). */
export const STAGE_GUNS: readonly GunDef[] = GUNS.filter((g) => g.id !== "m4a1");
let lastGun = Math.max(0, STAGE_GUNS.findIndex((g) => g.id === "ak47"));

export class CamoStage {
  private vm: GunViewmodel;
  private world = new THREE.PerspectiveCamera(73.74, 16 / 9, 1, 4000);
  private side = new THREE.Scene();
  private sideCam = new THREE.PerspectiveCamera(22, 1, 1, 2000);
  private turn = new THREE.Group();
  private sideMesh: THREE.Mesh;
  private sideMat: THREE.ShaderMaterial | null = null;
  private camo: string | null | undefined = undefined;
  private gunIdx = lastGun;
  private t = 0;
  /** Side view turntable angle and its fling. */
  spin = 0.5;
  spinV = 0;

  constructor(l: CosmeticLoadout) {
    this.vm = new GunViewmodel({ loadout: l });
    this.vm.setVisible(true);
    const holder = new THREE.Group();
    holder.rotation.x = -Math.PI / 2; // gun-local z up -> y up
    this.sideMesh = new THREE.Mesh(new THREE.BufferGeometry());
    this.sideMesh.frustumCulled = false;
    holder.add(this.sideMesh);
    this.turn.add(holder);
    this.side.add(this.turn);
    this.setLoadout(l);
    this.showGun();
  }

  get gun(): GunDef {
    return STAGE_GUNS[this.gunIdx];
  }

  /** The next / previous gun. */
  step(by: number): GunDef {
    this.gunIdx = lastGun = (this.gunIdx + by + STAGE_GUNS.length) % STAGE_GUNS.length;
    this.showGun();
    return this.gun;
  }

  private showGun(): void {
    const def = this.gun;
    this.vm.setGun(def);
    this.vm.draw();
    const g = gunModelGeometry(def);
    this.sideMesh.geometry = g;
    const c = g.boundingBox!.getCenter(new THREE.Vector3());
    this.sideMesh.position.copy(c).multiplyScalar(-1);
  }

  /** What the programs drawn depend on (warm). */
  private look = "";
  private warmKey = "";
  private warming = false;

  /**
   * Whether the view can draw now: its programs (a new camo's or gun's, the gloves') are compiled first, outside a frame
   * (graphics/warm-programs.ts), and until they're ready the stage stays clear, as the knife's hero does on first open.
   * Linked in the frame they first drew in, each new camo froze the stage (0.1-0.4 s on Metal, ~1.5 s on SwiftShader).
   */
  ready(r: THREE.WebGLRenderer, side: boolean): boolean {
    const key = `${side ? 1 : 0}|${this.camo}|${this.gunIdx}|${this.look}|${prefs.get().graphics.potato}`;
    if (key !== this.warmKey) {
      this.warmKey = key;
      const scene = side ? this.side : this.vm.scene;
      const wait = warmIfNew(r, scene, side ? this.sideCam : this.vm.camera, scene);
      this.warming = !!wait;
      void wait?.catch(() => {}).finally(() => this.warmKey === key && (this.warming = false));
    }
    return !this.warming;
  }

  /** Gloves, colourway accents and the camo shown. */
  setLoadout(l: CosmeticLoadout, outfit?: string | null): void {
    this.look = `${l.glove}|${l.outfit ?? ""}|${outfit ?? ""}`;
    this.vm.setLoadout(l);
    if (outfit !== undefined) this.vm.setOutfit(outfit);
    const camo = camoStyle(l.camo) ? l.camo! : null;
    if (camo === this.camo) return;
    this.camo = camo;
    this.sideMat?.dispose();
    this.sideMat = gunMaterial(playerUniforms(), NO_LOOK, { camo: camoStyle(camo), noEnv: true });
    this.sideMesh.material = this.sideMat;
  }

  inspect(): void {
    this.vm.inspect();
  }

  /** First person: the viewmodel over a clear background, the virtual 16:9 screen cropped to the gun. */
  drawFirstPerson(r: THREE.WebGLRenderer, dt: number, w: number, h: number, reduced: boolean): void {
    this.t += dt;
    this.vm.update(dt);
    const W0 = 1600, H0 = 900;
    // The gun sits low and right of the screen's middle (about 0.74, 0.76 of it): a crop around it with the canvas'
    // aspect, closer in on a tall stage (small widths) so the gun still fills it, kept inside the screen.
    const aspect = w / h;
    let ch = H0 * 0.82 * Math.min(1, Math.max(0.55, aspect)), cw = ch * aspect;
    if (cw > W0) (cw = W0), (ch = cw / aspect);
    const cx = Math.min(W0 - cw / 2, Math.max(cw / 2, W0 * 0.74)), cy = Math.min(H0 - ch / 2, Math.max(ch / 2, H0 * 0.74));
    const world = this.world;
    world.aspect = 16 / 9;
    world.position.set(0, 0, 0);
    // A slow look around (not with reduced motion): the gun sways in the hands like in game.
    world.rotation.set(reduced ? 0 : Math.sin(this.t * 0.33) * 0.02, reduced ? 0 : Math.sin(this.t * 0.5) * 0.04, 0, "YXZ");
    world.setViewOffset(W0, H0, cx - cw / 2, cy - ch / 2, cw, ch);
    world.updateProjectionMatrix();
    this.vm.camera.setViewOffset(W0, H0, cx - cw / 2, cy - ch / 2, cw, ch);
    r.clear();
    if (this.ready(r, false)) this.vm.render(r, world);
  }

  /** Side: the gun alone turning slowly, framed to its length. */
  drawSide(r: THREE.WebGLRenderer, dt: number, w: number, h: number, reduced: boolean, dragging: boolean): void {
    if (!dragging) {
      const damp = Math.exp(-dt * 2.2);
      this.spin += this.spinV * ((1 - damp) / 2.2) + (reduced ? 0 : 0.35) * dt;
      this.spinV *= damp;
    }
    // A gentle rock rather than a full turn: the flanks are what a camo shows.
    this.turn.rotation.set(0.18, Math.PI + Math.sin(this.spin) * 0.75, 0);
    const g = this.sideMesh.geometry;
    const size = g.boundingBox ? g.boundingBox.getSize(new THREE.Vector3()) : new THREE.Vector3(30, 4, 8);
    const cam = this.sideCam;
    cam.aspect = w / h;
    const tv = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const d = Math.max((size.x * 0.58) / (tv * cam.aspect), (size.z * 0.9) / tv) + size.y;
    cam.position.set(0, size.z * 0.08, d);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    r.clear();
    if (this.ready(r, true)) r.render(this.side, cam);
  }

  dispose(): void {
    this.vm.dispose();
    this.sideMat?.dispose();
  }
}
