// Gun presentation adapter: the core's weapon reports in (research/WEAPONS.md: weaponReport every tick, attackReport on
// EVENT_ATTACK), the gun viewmodel, its sounds, the world impacts and the third-person gun out. Presentation only:
// nothing here reaches a command; the simulation decides every shot, reload and switch, this only shows them.
//
// Hook-up (main.ts / viewmodel/weapons.ts):
//   const guns = new GunPresenter({ core, scene, onGun: (id) => thirdPerson.setGun(id) });
//   per sim tick:   guns.tick(weaponReport(core), events & EVENT_ATTACK ? attackReport(core) : null)
//                   (a knife attack report is ignored here; WeaponPresenter keeps the knife)
//   per frame:      guns.frame(dt, vm.feelMatrix, brushOrigins, input)  (animation, fx, impacts; input: the knife
//                   viewmodel's ViewmodelInput, for the gun's own movement feel, guns/motion.ts)
//                   guns.setVisible(firstPerson && viewmodel shown && !spectating); guns.render(renderer, camera)
//   inspect key:    guns.inspect() when guns.active
//   restart:        guns.reset(weaponReport(core))               (no draw animation replay, impacts cleared)
// The USP's silencer (physics v7): WEAPON_EVENT_SILENCER starts the screw on / off over the core's lock-out
// (WeaponReport.silencerTicks), a silenced shot (attack mode 2) is quiet with a small puff at the can's tip, and
// onSilencer tells the third-person bunny (PlayerModel.setGunSilencer). A restart / seek inside the lock-out jumps into
// the animation where the core is; a draw shows it on or off as the report says. All from the reports, so a replay
// re-simulating them shows exactly the same. A gun restored after a restart (physics v10, WEAPON_EVENT_RESTORED) is
// simply in hand: no draw, no pickup sound, the silencer as the report says.
// Floor guns: guns.floor (world.ts FloorGuns, in the scene) shows the map's weapon items where they lie, from the core's
// floor report whenever the weapon report says it changed (pickups, drops, template respawns; core.ts floorWeapons).
// Remote players (net/players.ts): the room relays their weapon in hand and shots; remoteShot() plays a shot at them.
//
// Weapon ids without a model of their own borrow the closest (guns/index.ts GUN_STAND_IN); unknown ids show nothing.

import type * as THREE from "three";
import type { CosmeticLoadout } from "../../loadout";
import { floorWeapons, USP_SILENCER_TIME, WEAPON_EVENT_DRY_FIRE, WEAPON_EVENT_MODE, WEAPON_EVENT_PICKED_UP, WEAPON_EVENT_RELOAD_FINISHED, WEAPON_EVENT_RELOAD_STARTED, WEAPON_EVENT_RESTORED, WEAPON_EVENT_SILENCER, WEAPON_IDS, type AttackReport, type BrushTransform, type Core, type WeaponReport } from "../../core";
import { impactSurface, modelOfEntity, playImpact } from "../../audio/impacts";
import { gunById } from "./index";
import { GunImpacts } from "./impacts";
import { gunSound } from "./sounds";
import type { GunDef } from "./types";
import { GunViewmodel } from "./viewmodel";
import type { GunMotionInput } from "./motion";
import { FloorGuns } from "./world";

/** Sim tick length (s): the core's reload ticks become animation seconds with it. */
const TICK = 0.01;

/** The model for a core weapon id (core.ts WEAPON_IDS index); undefined for none / the knife / unknown. */
export function gunForWeapon(weapon: number): GunDef | undefined {
  return weapon >= 2 ? gunById(WEAPON_IDS[weapon]) : undefined;
}

export interface GunPresenterHost {
  core: Core;
  /** The world scene: impacts are added to it (Source-space root). */
  scene: THREE.Scene;
  /** The gun in hand changed (third person: the bunny holds it); null = the knife / nothing. */
  onGun?: (id: string | null) => void;
  /**
   * The gun in hand's silencer is on / off (third person: PlayerModel.setGunSilencer). Called when it changes: as an
   * attach / detach starts (the state flips then, like CS:S), on a switch to or from a silenced USP, after a reset.
   */
  onSilencer?: (on: boolean) => void;
  /** Sim tick length (s), default 0.01. */
  tick?: number;
  /**
   * The replay viewer's: these hands (gloves, colourway via vm.setOutfit) instead of your equipped ones, no sounds, and
   * the floor guns left to the viewer (it keeps its own, viewer.ts).
   */
  replay?: { loadout: CosmeticLoadout };
}

export class GunPresenter {
  readonly vm: GunViewmodel;
  readonly impacts = new GunImpacts();
  /** The weapon items lying in the world. */
  readonly floor = new FloorGuns();
  /** The gun out (null: the knife, nothing, or a weapon without a model). */
  active: GunDef | null = null;
  private weapon = 0;
  private clip = -1;
  private clipSize = 0;
  private reloadTicks = 0;
  private ammoOut = { clip: 0, size: 0, reloading: false };
  /** The silencer state last told to onSilencer (null: not yet). */
  private silenced: boolean | null = null;
  private shells = false;
  /** Seconds until the shotgun's start motion hands over to the first shell. */
  private startLeft = 0;
  private firstShell = 0;
  private buttons: Set<number> | null = null;
  private transforms: Map<number, BrushTransform> | undefined;
  private tickS: number;

  constructor(private h: GunPresenterHost) {
    this.tickS = h.tick ?? TICK;
    this.vm = new GunViewmodel(h.replay ? { loadout: h.replay.loadout } : {});
    h.scene.add(this.impacts.root);
    if (!h.replay) h.scene.add(this.floor.root);
    this.vm.onSound = (kind, gain, rate) => this.sound(this.active, kind, gain, rate);
  }

  private sound(def: GunDef | null, kind: Parameters<typeof gunSound>[1], gain?: number, rate?: number): void {
    if (!this.h.replay) gunSound(def, kind, gain === undefined && rate === undefined ? undefined : { gain, rate });
  }

  /** Removes the impacts (and floor guns) from the scene and frees the viewmodel (the replay viewer's presenter). */
  dispose(): void {
    this.impacts.clear();
    this.impacts.root.removeFromParent();
    this.floor.root.removeFromParent();
    this.vm.dispose();
  }

  /** Restart / respawn: straight to the core's state (the gun is drawn like a fresh spawn), impacts cleared. */
  reset(r: WeaponReport | null): void {
    this.impacts.clear();
    this.weapon = -1;
    this.shells = false;
    this.startLeft = 0;
    if (!this.h.replay) this.floor.update(floorWeapons(this.h.core));
    this.silenced = null;
    if (r) {
      this.tick({ ...r, floorChanged: false, flags: r.flags & ~WEAPON_EVENT_SILENCER }, null);
      // Inside the silencer's lock-out: straight into the animation where the core is (no sounds before that point).
      const def = this.active;
      if (def?.silencer && r.silencerTicks > 0) {
        const total = this.silencerTotal();
        this.vm.silencer(r.silencer, total, Math.max(0.001, total - (r.silencerTicks + 1) * this.tickS));
      }
    } else this.equip(0);
  }

  /** The silencer's lock-out (s): the core's tick count for USP_SILENCER_TIME. */
  private silencerTotal(): number {
    return Math.round(USP_SILENCER_TIME / this.tickS) * this.tickS;
  }

  /** The gun in hand changed; `draw`: it comes out with the draw animation (not for a gun restored in hand, v10). */
  private equip(weapon: number, silenced = false, draw = true): void {
    this.weapon = weapon;
    const def = gunForWeapon(weapon) ?? null;
    // A USP comes out with its silencer on or off as the core has it (the switch cancelled any attach / detach).
    this.vm.setSilenced(silenced);
    if (def === this.active && def) {
      if (draw) this.vm.draw();
      return;
    }
    this.active = def;
    this.vm.setGun(def);
    this.vm.setSilenced(silenced);
    if (def && draw) this.vm.draw();
    this.shells = false;
    this.h.onGun?.(def ? def.id : null);
  }

  /** One sim tick: inventory events (switch, pickup, reloads, dry fire, mode) and this tick's shot. */
  tick(r: WeaponReport | null, attack: AttackReport | null): void {
    if (!r) return;
    if (r.floorChanged && !this.h.replay) this.floor.update(floorWeapons(this.h.core));
    const f = r.flags;
    if (r.active !== this.weapon) this.equip(r.active, r.silencer, !(f & WEAPON_EVENT_RESTORED));
    const def = this.active;
    if (r.silencer !== this.silenced) {
      this.silenced = r.silencer;
      this.h.onSilencer?.(r.silencer);
    }
    if (f & WEAPON_EVENT_PICKED_UP) this.sound(def ?? gunForWeapon(r.primary || r.secondary) ?? null, "pickup");
    if (def) {
      if (f & WEAPON_EVENT_MODE) {
        this.vm.anim.modeToggle();
        this.sound(def, "mode");
      }
      if (f & WEAPON_EVENT_DRY_FIRE) this.vm.dryFire();
      // The silencer going on / off: over the lock-out from this tick (the report has the ticks left after it).
      if (f & WEAPON_EVENT_SILENCER) this.vm.silencer(r.silencer, r.silencerTicks > 0 ? (r.silencerTicks + 1) * this.tickS : this.silencerTotal());
      if (f & WEAPON_EVENT_RELOAD_STARTED) this.reloadStarted(def, r);
      else if (this.shells && r.clip > this.clip && r.reloadTicks > 0) this.vm.anim.shellInsert(r.reloadTicks * this.tickS);
      if (f & WEAPON_EVENT_RELOAD_FINISHED && this.shells) {
        this.shells = false;
        this.startLeft = 0;
        this.vm.anim.shellEnd();
      }
      if (attack && attack.weapon === r.active && attack.weapon >= 2) this.shot(def, attack);
      // A shot interrupts a shotgun reload (the core cancels it when a shell is in).
      if (this.shells && r.reloadTicks === 0 && !(f & WEAPON_EVENT_RELOAD_FINISHED)) this.shells = false;
      this.vm.anim.empty = r.clip === 0 && r.clipSize > 0;
    }
    this.clip = r.clip;
    this.clipSize = r.clipSize;
    this.reloadTicks = r.reloadTicks;
  }

  private reloadStarted(def: GunDef, r: WeaponReport): void {
    const total = Math.max(0.2, r.reloadTicks * this.tickS);
    if (def.timing.shells) {
      // The start turns the gun and brings the hand to the port; the first shell takes the rest of its time.
      this.shells = true;
      const start = Math.min(def.timing.shells.start, total * 0.45);
      this.vm.anim.shellStart(start);
      this.startLeft = start;
      this.firstShell = total - start;
    } else this.vm.reload(total, r.clip === 0);
  }

  private shot(def: GunDef, a: AttackReport): void {
    // Mode 2 from a gun: a silenced USP shot (CS:S Secondary_Mode).
    const silenced = a.mode === 2 && !!def.silencer;
    this.vm.fire(silenced);
    const fwd = norm([a.end[0] - a.start[0], a.end[1] - a.start[1], a.end[2] - a.start[2]]);
    const right = norm([fwd[1], -fwd[0], 0]);
    const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    // The tracer leaves from about where the muzzle is (right of and below the eye).
    // (From the silencer's tip when it's on: about a can's length further out.)
    const out = silenced ? 21 : 16;
    const from = [0, 1, 2].map((k) => a.start[k] + fwd[k] * out + right[k] * 4.5 - up[k] * 4);
    if (!a.hit) {
      this.impacts.hit(a.end, [0, 0, 0], "concrete", { from });
      return;
    }
    const transforms = this.transforms ?? this.h.core.brushOrigins();
    const surface = impactSurface(this.h.core, a, transforms);
    if (!this.h.replay) playImpact(surface, "bullet", a.end);
    this.impacts.hit(a.end, a.normal, surface, { model: modelOfEntity(a.entity), transforms, from, button: this.isButton(a.entity), heavy: def.cls === "shotgun" });
  }

  private isButton(entity: number): boolean {
    if (entity < 0) return false;
    if (!this.buttons) {
      this.buttons = new Set();
      try {
        this.h.core.entities().forEach((e, i) => {
          if (/^func_(rot_)?button$/.test(e.classname ?? "")) this.buttons!.add(i);
        });
      } catch {
        /* older core: no entity lump */
      }
    }
    return this.buttons.has(entity);
  }

  /** Per rendered frame: the shotgun's start hands over to its first shell, animation, fx, impacts. */
  frame(dt: number, feel: ArrayLike<number> | null, transforms?: Map<number, BrushTransform>, motion: GunMotionInput | null = null): void {
    this.transforms = transforms;
    if (this.startLeft > 0 && (this.startLeft -= dt) <= 0 && this.shells) this.vm.anim.shellInsert(Math.max(0.1, this.firstShell));
    if (this.active) this.vm.update(dt, feel, motion);
    this.impacts.update(dt, transforms);
  }

  setVisible(v: boolean): void {
    this.vm.setVisible(v);
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    if (this.active) {
      this.impacts.setViewportHeight(renderer.domElement.height);
      this.vm.render(renderer, camera);
    }
  }

  inspect(): void {
    if (this.active) this.vm.inspect();
  }

  /**
   * The HUD's ammo readout for the gun out (hud.ts setAmmo): rounds in the clip, the clip size, reloading (null: the
   * knife, nothing, or a weapon without a clip). The same object every call, updated in place (no allocation per tick).
   */
  ammo(): { clip: number; size: number; reloading: boolean } | null {
    if (!this.active || this.clipSize <= 0) return null;
    const a = this.ammoOut;
    a.clip = Math.max(0, this.clip);
    a.size = this.clipSize;
    a.reloading = this.reloadTicks > 0;
    return a;
  }

  /** Another player's / a replay's shot (positional); `silenced`: through a silencer (attack mode 2), the quiet shot. */
  static remoteShot(weapon: number, feet: ArrayLike<number>, silenced = false): void {
    const def = gunForWeapon(weapon) ?? null;
    gunSound(def, silenced && def?.silencer ? "silenced" : "fire", { at: feet });
  }
}

function norm(v: number[]): number[] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
