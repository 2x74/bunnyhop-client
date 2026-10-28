// The replay viewer's held weapon in first person (in-eye): the runner's hands, knife and the map-given guns as the
// live game draws them (viewmodel/), driven by the replay instead of your binds. Presentation only, silent (the viewer
// plays no weapon sounds), never your own loadout: the runner's look comes from setLook.
//
// What drives it (nothing is stored for it beyond the cosmetic trailers; replay.ts):
//   knife swings   the cosmetic trailer (BHCX: slash / stab), which every physics version has
//   inspects       the inspect trailer (BHCI: start / next trick, the key held)
//   guns           re-derived from the re-simulation: the core's weaponReport after every tick the viewer steps
//                  (switches, pickups, gives, drops, reloads, the silencer) and attackReport on EVENT_ATTACK (shots),
//                  exactly what the live game feeds GunPresenter (main.ts tick)
//
// viewer.ts per render:  step(core, tick, events) for each tick played through (ReplayPlayer.seek's onStep), or
//                        reset(core) after a jump; frame(...) once; render(renderer, camera) after the world.
// An export (viewer.ts drawViewmodel): ticks are fed by every render (each motion-blur sample), frame + render run
// once per output frame, after all its samples: the weapon is sharp, animated at the output frame rate.
// New programs (the runner's gloves / finish, the gun hands) are compiled ahead by warm() (graphics/warm-programs.ts);
// the viewer shows the arms once that's done.

import type * as THREE from "three";
import { attackReport, EVENT_ATTACK, WEAPON_EVENT_RESTORED, type BrushTransform, type Core, weaponReport } from "../core";
import { gpuIdle, warmPrograms } from "../graphics/warm-programs";
import type { PlayerGlow } from "../player/glow-config";
import { DEFAULT_LOADOUT, type CosmeticLoadout } from "../loadout";
import { knifeOf } from "../viewmodel/equip";
import { GunPresenter } from "../viewmodel/guns/presenter";
import { gunById } from "../viewmodel/guns/index";
import { Viewmodel, type ViewmodelInput } from "../viewmodel/viewmodel";

export interface ArmsLook {
  loadout: CosmeticLoadout;
  outfit: string;
  glow: PlayerGlow | null;
}

export class ReplayArms {
  readonly knife = new Viewmodel({ follow: false, silent: true });
  readonly guns: GunPresenter;
  /** Programs compiled (warm()): drawn from then on. */
  ready = false;
  /**
   * The knife deploys (draw) when it comes into view, as in the game. Exports turn this off: a cut to an in-eye shot
   * finds it in hand (a switch to the knife still deploys it).
   */
  deployOnShow = true;
  /** Weapon id in hand at the last tick fed (core.ts WEAPON_IDS: 1 = the knife, 0 = none). */
  private active = 1;
  /** The knife was the weapon in hand at the last frame. */
  private knifeOut = true;
  private shown = false;

  constructor(
    private core: Core,
    private scene: THREE.Scene,
  ) {
    this.guns = new GunPresenter({ core, scene, replay: { loadout: { ...DEFAULT_LOADOUT } } });
    // The swings come from the replay (step / swing), never from binds.
    this.knife.followSim = true;
  }

  /** The runner's look: knife, finish, gloves, colourway and their supporter glow (null = none). */
  setLook(l: ArmsLook): void {
    this.knife.setLoadout(l.loadout);
    this.knife.setKnife(knifeOf(l.loadout));
    this.knife.setOutfit(l.outfit);
    this.knife.glowOverride = l.glow;
    this.guns.vm.setLoadout(l.loadout);
    this.guns.vm.setOutfit(l.outfit);
  }

  /**
   * Compiles the arms' programs for where they're drawn (the hands with the runner's gloves and finish, a gun's hands,
   * the muzzle flash, the impacts in the world) before the first frame that draws them.
   */
  async warm(renderer: THREE.WebGLRenderer, camera: THREE.Camera): Promise<void> {
    const gunVm = this.guns.vm;
    const had = gunVm.def;
    void gunVm.fx;
    // Every gun shares the hands' material; one gun's geometry is enough for its program.
    if (!had) gunVm.setGun(gunById("usp") ?? null);
    try {
      await warmPrograms(renderer, this.knife.scene, this.knife.camera, this.knife.scene);
      await warmPrograms(renderer, gunVm.scene, gunVm.camera, gunVm.scene);
      await warmPrograms(renderer, this.guns.impacts.root, camera, this.scene);
    } finally {
      if (!had) gunVm.setGun(this.guns.active);
    }
    await gpuIdle(renderer, 1000);
    this.ready = true;
  }

  /** After a jump (seek, export start): straight to the core's weapon state, no draw, no effects. */
  reset(core: Core = this.core): void {
    const r = weaponReport(core);
    this.guns.reset(r ? { ...r, flags: WEAPON_EVENT_RESTORED } : null);
    this.active = r ? r.active : 1;
    this.knife.idle();
  }

  /** A tick played through (the core is "after tick" now): weapon switches, reloads, the shot. */
  step(core: Core, events: number): void {
    const r = weaponReport(core);
    if (!r) return;
    const attack = events & EVENT_ATTACK ? attackReport(core) : null;
    this.guns.tick(r, attack);
    this.active = r.active;
  }

  /** The knife swing of the cosmetic trailer (1 = slash, 2 = stab), when the knife is out. */
  swing(kind: number): void {
    if (this.active === 1 && (kind === 1 || kind === 2)) this.knife.simAttack(kind);
  }

  /** An inspect signal of the trailer (INSPECT_START / _NEXT; only the knife's inspects are recorded). */
  inspect(sig: number): void {
    if (this.active === 1) this.knife.inspectSignal(sig);
  }

  /** Per rendered frame: animation, bob / sway from the replay's movement, effects. `show`: drawn this frame. */
  frame(dt: number, input: ViewmodelInput, inspectHeld: boolean, show: boolean, transforms?: Map<number, BrushTransform>): void {
    show &&= this.ready;
    this.knife.setVisible(show && this.active === 1, this.deployOnShow || !this.knifeOut);
    this.knifeOut = this.active === 1;
    this.knife.update(dt, input, { primary: false, secondary: false, inspect: inspectHeld && this.active === 1 });
    this.guns.setVisible(show);
    this.guns.frame(dt, this.knife.feelMatrix, transforms);
    this.guns.impacts.root.visible = show;
    this.shown = show;
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    if (!this.shown) return;
    this.knife.render(renderer, camera);
    this.guns.render(renderer, camera);
  }

  dispose(): void {
    this.knife.dispose();
    this.guns.dispose();
  }
}
