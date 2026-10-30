// Live third person (CS:S `thirdperson`), a practice aid for watching your own strafes. Camera only: the commands
// fed to the sim are untouched (they come from input.ts as always). Runs finished with it on are practice runs
// (session.ts doesn't submit them or save them as PBs).

import type * as THREE from "three";
import { traceRay, WEAPON_EVENT_RELOAD_STARTED, type AttackReport, type Core, type PlayerState, type WeaponReport } from "../core";
import { PlayerModel } from "../player/model";
import { gunForWeapon } from "../viewmodel/guns/presenter";
import { SpectatorCamera, type SpectatorTarget } from "./cameras";

export class ThirdPerson {
  active = false;
  get shadowRoot(): THREE.Object3D { return this.model.root; }
  private pendingAttack = 0;
  private pendingInspect = 0;
  private pendingShot = false;
  private pendingReload: { seconds: number; shell?: boolean; empty?: boolean } | null = null;
  private lastActive = 0;
  private lastClip = 0;
  private inspectHeld = false;
  private spec: SpectatorCamera;
  private model = new PlayerModel({ style: "solid" });
  /** Posed at least once (its skin and animations load on the first update), and whether the pose is behind now. */
  private posed = false;
  private stale = false;
  private s: SpectatorTarget & { pos: number[]; vel: number[] } = { pos: [0, 0, 0], vel: [0, 0, 0], viewZ: 64, yaw: 0, pitch: 0, crouched: false, grounded: true };

  constructor(scene: THREE.Scene, core: Core) {
    // `thirdperson`: the shared spectator chase cam, a little further out and quicker to follow your own mouse.
    this.spec = new SpectatorCamera({ trace: (a, b, r) => traceRay(core, a, b, r), chase: { distance: 100, followRate: 14 } });
    this.model.root.visible = false;
    this.model.setNearFade(10, 34);
    scene.add(this.model.root);
  }

  toggle(): boolean {
    this.active = !this.active;
    this.model.root.visible = this.active;
    this.spec.snap();
    this.model.snap();
    return this.active;
  }

  set(on: boolean): void {
    if (on !== this.active) this.toggle();
  }

  /** Hidden while the replay viewer is open (the live model would otherwise stand in its scene). */
  setHidden(hidden: boolean): void {
    this.model.root.visible = this.active && !hidden;
  }

  /** A carrot swing (viewmodel attack kind) to show on the third-person model next frame. */
  /** The gun in the bunny's hand (a core weapon id, "glock"; viewmodel/guns), null = the knife. */
  setGun(id: string | null): void {
    this.model.setGun(id);
  }

  /** The gun's silencer (the USP's) on or off (GunPresenterHost.onSilencer). */
  setGunSilencer(on: boolean): void {
    this.model.setGunSilencer(on);
  }

  attack(kind: number): void {
    this.pendingAttack = kind;
  }

  /**
   * One sim tick of your weapons (core weaponReport / attackReport): a gun shot, a reload starting (its length from the
   * core) or a tube gun's shell going in, for the third-person bunny next frame. Returns true on a reload / shell, for
   * the room (mp.onGunReload).
   */
  weaponTick(r: WeaponReport | null, a: AttackReport | null, tickS: number): boolean {
    if (!r) return false;
    let reload = false;
    if (a && a.weapon >= 2 && a.weapon === r.active) this.pendingShot = true;
    if (r.active >= 2 && r.active === this.lastActive) {
      if (r.flags & WEAPON_EVENT_RELOAD_STARTED) {
        this.pendingReload = { seconds: Math.max(0.2, r.reloadTicks * tickS), empty: r.clip === 0 };
        reload = true;
      } else if (r.clip > this.lastClip && gunForWeapon(r.active)?.timing.shells) {
        this.pendingReload = { seconds: Math.max(0.2, r.reloadTicks * tickS), shell: true };
        reload = true;
      }
    }
    this.lastActive = r.active;
    this.lastClip = r.clip;
    return reload;
  }

  /** An inspect signal (viewmodel/inspects/combo.ts SIG_*) to play on the third-person model next frame. */
  inspect(sig: number): void {
    this.pendingInspect = sig;
  }

  setInspectHeld(h: boolean): void {
    this.inspectHeld = h;
  }

  /** After teleports / restarts. */
  snap(): void {
    this.spec.snap();
    this.model.snap();
  }

  /**
   * Places the camera behind the interpolated player (alpha between prev and curr ticks), looking along the live
   * view yaw. Returns false when inactive (main.ts places the first-person eye). `poseHidden`: animate the model even
   * in first person, where it isn't drawn: only the composer looks' shadow passes draw it then (player-shadow.ts), so
   * the Source / Classic / Potato looks skip the whole bone setup every frame.
   */
  frame(camera: THREE.PerspectiveCamera, prev: PlayerState, curr: PlayerState, alpha: number, yaw: number, pitch: number, cmd: { forward: number; side: number }, dt: number, visualTime?: number, poseHidden = true): boolean {
    if (!this.active && !poseHidden && this.posed) {
      this.pendingAttack = 0;
      this.pendingInspect = 0;
      this.pendingShot = false;
      this.pendingReload = null;
      this.stale = true;
      return false;
    }
    if (this.stale) {
      // Back in view after frames without a pose: start from here, not from where it was hidden.
      this.stale = false;
      this.model.snap();
    }
    this.posed = true;

    const s = this.s;
    for (let k = 0; k < 3; k++) {
      s.pos[k] = prev.position[k] + (curr.position[k] - prev.position[k]) * alpha;
      s.vel[k] = prev.velocity[k] + (curr.velocity[k] - prev.velocity[k]) * alpha;
    }
    s.viewZ = prev.viewOffsetZ + (curr.viewOffsetZ - prev.viewOffsetZ) * alpha;
    s.yaw = yaw;
    s.pitch = pitch;
    s.crouched = curr.crouched;
    s.grounded = curr.grounded || prev.grounded;
    if (this.active) this.spec.update(camera, s, dt, "chase");
    this.model.setState({ visualTime, position: s.pos, velocity: s.vel, yaw, pitch, crouched: s.crouched, grounded: s.grounded, forwardmove: cmd.forward, sidemove: cmd.side, attack: this.pendingAttack, inspect: this.pendingInspect, inspectHeld: this.inspectHeld, gunShot: this.pendingShot, gunReload: this.pendingReload });
    this.pendingAttack = 0;
    this.pendingInspect = 0;
    this.pendingShot = false;
    this.pendingReload = null;
    this.model.update(dt);
    return this.active;
  }
}
