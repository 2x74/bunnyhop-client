// Weapon presentation (physics v4): what the player sees and hears of the simulated knife and the guns a map hands
// out (game_player_equip; crates/core game/weapons.rs). Purely presentation: the weapon state comes from the core
// every tick (PlayerState.weapons / activeWeapon; a restart re-equips from the map), and the only thing that reaches a
// command is the slot request of the weapon keys (input.ts IN_SLOT_*).
//
// main.ts per sim tick:   weapons.tick(state, events)    (EVENT_ATTACK -> attackReport: swing / shot, impact)
//         per frame:      weapons.frame(dt, transforms)   (effects, the sniper's zoom resume) and weapons.fov(base)
//         on keys:        weapons.secondary()             (Mouse2 with a gun: the sniper's zoom)
//                         weapons.slotFor(action)         (slot keys -> input.requestSlot)
//
// On older wasm builds (no `attack_report`) or physics v1-v3 the knife swings stay bind-driven (viewmodel.ts) and
// nothing here does anything beyond reporting "knife".

import { attackReport, EVENT_ATTACK, WEAPON_KNIFE, WEAPON_PISTOL, WEAPON_SNIPER, type AttackReport, type BrushTransform, type Core, type PlayerState } from "../core";
import { SLOT_KNIFE, SLOT_PISTOL, SLOT_PRIMARY } from "../input";
import type { WeaponAction } from "../binds";
import { engine, sfx } from "../audio";
import { impactSurface, modelOfEntity, playImpact, type ImpactKind } from "../audio/impacts";
import type { HitEffects } from "../effects";
import type { Viewmodel } from "./viewmodel";
import type { GunPresenter } from "./guns/presenter";

/** Sniper zoom levels (horizontal FOV at 4:3, like fov_desired): off, then these. */
const ZOOM_FOV = [40, 15];
/** After a sniper shot the scope drops and comes back this much later (just before the next shot is ready). */
const ZOOM_RESUME_S = 1.25;

const SLOT_OF: Record<number, number> = { [WEAPON_SNIPER]: SLOT_PRIMARY, [WEAPON_PISTOL]: SLOT_PISTOL, [WEAPON_KNIFE]: SLOT_KNIFE };

const isGun = (w: number) => w === WEAPON_PISTOL || w === WEAPON_SNIPER;

/** True if this wasm build reports attacks (EVENT_ATTACK + attack_report). */
export function reportsAttacks(core: Core): boolean {
  return typeof (core as unknown as { x: { attack_report?: unknown } }).x.attack_report === "function";
}

export interface WeaponHost {
  core: Core;
  vm: Viewmodel;
  effects: HitEffects;
  /** Physics version of the current attempt (swings follow the sim from v4). */
  physics: () => number;
  /**
   * The gun models (viewmodel/guns/presenter.ts, fed by main.ts with the core's weapon reports): with one, the guns'
   * shots and draws are theirs (their own sounds, muzzle flash, tracer and impacts; main.ts feeds the HUD's ammo
   * readout from it) and this keeps the knife, the slots and the zoom.
   */
  guns?: GunPresenter;
}

export class WeaponPresenter {
  /** Active weapon (WEAPON_* bit, 0 = none); the knife on builds without weapons. */
  active = WEAPON_KNIFE;
  held = WEAPON_KNIFE;
  /** The weapon active before the current one (the "last weapon" key). */
  private previous = 0;
  /** Sniper zoom level: 0 off, 1..ZOOM_FOV.length. */
  private zoom = 0;
  private resumeZoom = 0;
  private resumeIn = 0;
  private transforms: Map<number, BrushTransform> | undefined;
  private readonly supported: boolean;

  constructor(private h: WeaponHost) {
    this.supported = reportsAttacks(h.core);
  }

  /** Swings and shots follow the simulation (physics v4 on a build that reports attacks). */
  get followsSim(): boolean {
    return this.supported && this.h.physics() >= 4;
  }

  get gunActive(): boolean {
    return isGun(this.active);
  }

  /** The viewmodel (hands + knife) is drawn: the knife is out. */
  get knifeOut(): boolean {
    return this.active === WEAPON_KNIFE;
  }

  /** Restart / respawn: weapon state straight from the core, no zoom, no switch effects. */
  reset(s: PlayerState): void {
    this.h.vm.followSim = this.followsSim;
    this.active = s.activeWeapon ?? WEAPON_KNIFE;
    this.held = s.weapons ?? WEAPON_KNIFE;
    this.previous = 0;
    this.setZoom(0);
    this.resumeIn = 0;
  }

  /** One sim tick: weapon switches (the core's state) and this tick's attack. */
  tick(s: PlayerState, events: number): void {
    const active = s.activeWeapon ?? WEAPON_KNIFE;
    this.held = s.weapons ?? WEAPON_KNIFE;
    if (active !== this.active) this.switched(active);
    if (events & EVENT_ATTACK && this.followsSim) {
      const r = attackReport(this.h.core);
      if (r) this.attacked(r);
    }
  }

  private switched(to: number): void {
    if (this.active) this.previous = this.active;
    this.active = to;
    this.setZoom(0);
    this.resumeIn = 0;
    // Back to the knife: the viewmodel deploys (draw) as main.ts shows it again; a gun just clicks.
    if (isGun(to) && !this.h.guns) sfx("gun_draw");
  }

  private attacked(r: AttackReport): void {
    const fwd = dir(r.start, r.end);
    if (r.weapon === WEAPON_KNIFE) {
      this.h.vm.simAttack(r.mode);
      if (r.hit) this.impact(r, r.mode === 2 ? "stab" : "slash", fwd);
      return;
    }
    // r.weapon is a weapon id (core.ts WEAPON_IDS; research/WEAPONS.md): 2+ are guns.
    if (r.weapon < 2) return;
    // A gun with a model: the gun presenter plays the shot (sound, flash, tracer, impact); only the zoom stays here.
    if (this.h.guns?.active) {
      const sniper = r.weapon >= 21 && r.weapon <= 24;
      if (sniper && this.zoom) {
        this.resumeZoom = this.zoom;
        this.resumeIn = ZOOM_RESUME_S;
        this.setZoom(0);
      }
      return;
    }
    const sniper = r.weapon >= 21 && r.weapon <= 24;
    sfx(sniper ? "shot_sniper" : "shot_pistol");
    // Tracer from a little below / right of the eye (where the gun would be) to the hit / range end.
    const right = norm([fwd[1], -fwd[0], 0]);
    const up = cross(right, fwd);
    const muzzle = [0, 1, 2].map((k) => r.start[k] + fwd[k] * 14 + right[k] * 4 - up[k] * 4);
    this.h.effects.tracer(muzzle, r.end, sniper ? 0.16 : 0.09);
    if (r.hit) this.impact(r, "bullet", fwd);
    if (sniper && this.zoom) {
      // CS:S: the scope drops for the bolt and comes back.
      this.resumeZoom = this.zoom;
      this.resumeIn = ZOOM_RESUME_S;
      this.setZoom(0);
    }
  }

  private impact(r: AttackReport, kind: ImpactKind, fwd: number[]): void {
    const transforms = this.transforms ?? this.h.core.brushOrigins();
    const surface = impactSurface(this.h.core, r, transforms);
    playImpact(surface, kind, r.end);
    // A slash cuts across the view (its sweep), so the mark lies along the view's right.
    const along = kind === "slash" ? [fwd[1], -fwd[0], 0] : undefined;
    this.h.effects.impact(r.end, r.normal, surface, kind, { model: modelOfEntity(r.entity), transforms, along });
  }

  /** Per rendered frame: effects, the sniper scope coming back after a shot. */
  frame(dt: number, transforms: Map<number, BrushTransform>): void {
    this.transforms = transforms;
    this.h.effects.update(dt, transforms);
    if (this.resumeIn > 0 && (this.resumeIn -= dt) <= 0) {
      this.resumeIn = 0;
      if (this.active === WEAPON_SNIPER) this.setZoom(this.resumeZoom);
    }
  }

  /** Mouse2 pressed with a gun out: the sniper cycles its zoom (the sim ignores attack2 for guns). */
  secondary(): void {
    if (this.active !== WEAPON_SNIPER) return;
    this.resumeIn = 0;
    this.setZoom((this.zoom + 1) % (ZOOM_FOV.length + 1));
  }

  private setZoom(z: number): void {
    if (z !== this.zoom && engine.unlocked) sfx("ui_toggle", 0.5, 0.7);
    this.zoom = z;
  }

  /** Looking through the sniper's scope (CS:S hides the viewmodel then). */
  get scoped(): boolean {
    return this.zoom > 0;
  }

  /** Horizontal FOV for the camera (the zoom's, else `base`). */
  fov(base: number): number {
    return this.zoom ? ZOOM_FOV[this.zoom - 1] : base;
  }

  /** Whether slot 1..3 holds a weapon (input wiring for next / previous weapon). */
  holdsSlot(slot: number): boolean {
    const w = slot === SLOT_PRIMARY ? WEAPON_SNIPER : slot === SLOT_PISTOL ? WEAPON_PISTOL : WEAPON_KNIFE;
    return this.followsSim && (this.held & w) !== 0;
  }

  /** The active slot (1..3), 0 for none. */
  activeSlot(): number {
    return SLOT_OF[this.active] ?? 0;
  }

  /** Slot to request for a weapon key, or 0 (nothing to switch to). */
  slotFor(a: WeaponAction): number {
    if (!this.followsSim) return 0;
    if (a === "lastWeapon") {
      const w = this.previous && this.previous !== this.active && this.held & this.previous ? this.previous : 0;
      return w ? SLOT_OF[w] : 0;
    }
    const slot = a === "slot1" ? SLOT_PRIMARY : a === "slot2" ? SLOT_PISTOL : SLOT_KNIFE;
    const w = slot === SLOT_PRIMARY ? WEAPON_SNIPER : slot === SLOT_PISTOL ? WEAPON_PISTOL : WEAPON_KNIFE;
    return this.held & w && this.active !== w ? slot : 0;
  }
}

function dir(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  return norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
}

function norm(v: number[]): number[] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
